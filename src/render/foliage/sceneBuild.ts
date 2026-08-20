/**
 * Turning an `IVegetationSet` + `ITreeMeshSet` + `IMaterialSystem` into the four flat buffers
 * the GPU actually wants: one vertex buffer, one index buffer, one mesh table, one instance
 * table.
 *
 * All of it happens once, at build time. The per-frame path touches none of it — spec §7.4's
 * "zero per-object CPU work" is only true if the CPU never walks the stem list again, so the
 * only thing `cull()` uploads each frame is two small uniform blocks.
 */

import type { IMaterialSystem, MaterialDef } from '@contracts/render'
import type { ITreeMeshSet, IVegetationSet, Stem, TreeLod, TreeMesh } from '@contracts/world'
import { LOD_COUNT, MAX_BUCKETS } from './config.ts'
import {
  INSTANCE_FLOATS,
  INSTANCE_OFF_BURN_STATE,
  INSTANCE_OFF_CULL_RADIUS,
  INSTANCE_OFF_HEIGHT,
  INSTANCE_OFF_MESH_ID,
  INSTANCE_OFF_POS_X,
  INSTANCE_OFF_POS_Y,
  INSTANCE_OFF_POS_Z,
  INSTANCE_OFF_ROTATION_Y,
  MATERIAL_FLAG_ALPHA_TEST,
  MATERIAL_FLAG_BURNABLE,
  MATERIAL_FLAG_DOUBLE_SIDED,
  MATERIAL_PARAMS_STRIDE_BYTES,
  MESH_ENTRY_U32S,
  MESH_OFF_BASE_VERTEX,
  MESH_OFF_FIRST_INDEX,
  MESH_OFF_INDEX_COUNT,
  MESH_OFF_LOD,
  MESH_OFF_MESH_ID,
  MESH_OFF_REF_HEIGHT,
  MESH_OFF_TRIANGLE_COUNT,
  VERTEX_FLOATS,
} from './layout.ts'

/** One (mesh, LOD) bucket, in the CPU-readable form the oracle and the tests use. */
export interface BucketEntry {
  readonly indexCount: number
  readonly firstIndex: number
  readonly baseVertex: number
  readonly triangleCount: number
  readonly refHeightM: number
  readonly lod: number
  readonly meshId: number
}

export interface FoliageScene {
  /** Interleaved position/normal/uv/materialSlot, VERTEX_STRIDE_BYTES apart. */
  readonly vertexData: Float32Array
  readonly indexData: Uint32Array
  /** One entry per bucket, bucket index = meshId * LOD_COUNT + lod. */
  readonly buckets: readonly BucketEntry[]
  /** Packed mesh table, MESH_ENTRY_U32S per bucket. */
  readonly meshTable: Uint32Array
  /** Packed instances, INSTANCE_FLOATS per instance (mixed f32/u32, see layout.ts). */
  readonly instanceData: ArrayBuffer
  readonly instanceCount: number
  readonly meshCount: number
  /** Material parameter block, MATERIAL_PARAMS_STRIDE_BYTES per slot. */
  readonly materialParams: ArrayBuffer
  readonly materialSlots: ReadonlyMap<string, number>
  /**
   * Texture-array layer for the grass blade material, resolved here because the grass draw
   * has no vertex stream to carry a material slot. One resolution point: the renderer used to
   * look this up itself, against a literal `'grass'` that no biome has ever used, and every
   * miss fell back to layer 0 — conifer bark — which is why grass rendered blue-violet.
   */
  readonly grassLayer: number
  /**
   * Material ids that did not resolve, in the order they were asked for. A miss is silently
   * survivable (slot 0 is a real material) and has therefore shipped twice; it is reported so
   * the boot screen can say so rather than the picture quietly being wrong.
   */
  readonly unresolvedMaterialIds: readonly string[]
  /** Stems dropped because they exceeded MAX_BUCKETS worth of unique meshes. Reported, not hidden. */
  readonly droppedStems: number
  readonly totalTriangles: number
  readonly vertexBytes: number
  readonly indexBytes: number
}

/**
 * Material ids the tree geometry's submesh tags map to.
 *
 * `TreeLod.submeshes[].material` is one of 'bark' | 'foliage' | 'ribbon'. `IMaterialSystem`
 * is keyed by free-form string ids, and the contract does not say what WP 1.6 will call
 * them. So the mapping is a parameter with a documented default rather than a hardcoded
 * lookup that fails at integration.
 */
export interface MaterialIdMap {
  readonly bark: string
  readonly foliage: string
  readonly ribbon: string
  readonly grass: string
}

export const DEFAULT_MATERIAL_IDS: MaterialIdMap = {
  bark: 'bark',
  foliage: 'foliage',
  ribbon: 'ribbon',
  grass: 'grass',
}

function packMaterialParams(
  materials: IMaterialSystem,
): { buffer: ArrayBuffer; slots: Map<string, number> } {
  const defs: MaterialDef[] = [...materials.materials.values()]
  const slots = new Map<string, number>()
  const count = Math.max(defs.length, 1)
  const buffer = new ArrayBuffer(count * MATERIAL_PARAMS_STRIDE_BYTES)
  const f = new Float32Array(buffer)
  const u = new Uint32Array(buffer)
  const stride = MATERIAL_PARAMS_STRIDE_BYTES / 4
  defs.forEach((def, i) => {
    slots.set(def.id, i)
    const o = i * stride
    f[o + 0] = def.baseColorFactor[0]
    f[o + 1] = def.baseColorFactor[1]
    f[o + 2] = def.baseColorFactor[2]
    f[o + 3] = def.roughnessFactor
    u[o + 4] = def.layer >>> 0
    u[o + 5] =
      (def.alphaTest ? MATERIAL_FLAG_ALPHA_TEST : 0) |
      (def.doubleSided ? MATERIAL_FLAG_DOUBLE_SIDED : 0) |
      (def.burnable ? MATERIAL_FLAG_BURNABLE : 0)
    f[o + 6] = def.metallicFactor
    f[o + 7] = 0
  })
  if (defs.length === 0) {
    // A material system with no materials is a WP 1.6 problem, not a reason to fail here.
    // One neutral slot keeps the vertex stream's slot index in range.
    f[0] = 1
    f[1] = 1
    f[2] = 1
    f[3] = 1
  }
  return { buffer, slots }
}

/** Per-vertex material slots for one LOD, stamped from its submesh index ranges. */
function vertexSlots(lod: TreeLod, slotFor: (m: 'bark' | 'foliage' | 'ribbon') => number): Uint32Array {
  const vertexCount = lod.positions.length / 3
  const out = new Uint32Array(vertexCount)
  // Default to the bark slot so a vertex touched by no submesh is still shaded as something
  // opaque rather than as alpha-tested foliage with an undefined texture.
  out.fill(slotFor('bark'))
  for (const sm of lod.submeshes) {
    const slot = slotFor(sm.material)
    const end = Math.min(sm.start + sm.count, lod.indices.length)
    for (let i = sm.start; i < end; i++) {
      const v = lod.indices[i]
      if (v !== undefined && v < vertexCount) out[v] = slot
    }
  }
  return out
}

/**
 * Bounding sphere radius about `(x, y + h/2, z)`.
 *
 * The crown is wider than the trunk and sits at the top, so the tight sphere about the whole
 * plant is not the one about its height alone. `hypot` of the two half-extents is a cheap
 * conservative cover; being conservative here costs a handful of falsely-accepted instances
 * per frame, while being tight costs trees vanishing at the screen edge.
 */
export function stemCullRadius(stem: Stem): number {
  return Math.hypot((stem.heightM as number) * 0.5, stem.crownRadiusM as number)
}

export function buildFoliageScene(
  vegetation: IVegetationSet,
  trees: ITreeMeshSet,
  materials: IMaterialSystem,
  ids: MaterialIdMap = DEFAULT_MATERIAL_IDS,
): FoliageScene {
  const { buffer: materialParams, slots } = packMaterialParams(materials)
  const fallbackSlot = 0
  const unresolvedMaterialIds: string[] = []
  const slotOf = (id: string): number => {
    const slot = slots.get(id)
    if (slot === undefined) {
      if (!unresolvedMaterialIds.includes(id)) unresolvedMaterialIds.push(id)
      return fallbackSlot
    }
    return slot
  }
  const slotFor = (m: 'bark' | 'foliage' | 'ribbon'): number =>
    m === 'bark' ? slotOf(ids.bark) : m === 'foliage' ? slotOf(ids.foliage) : slotOf(ids.ribbon)
  // `materialParams` is MATERIAL_PARAMS_STRIDE_BYTES per slot; word 4 is the array layer.
  const grassLayer = new Uint32Array(materialParams)[slotOf(ids.grass) * 8 + 4] ?? 0

  const meshIds = new Map<TreeMesh, number>()
  const buckets: BucketEntry[] = []
  const vertexChunks: Float32Array[] = []
  const indexChunks: Uint32Array[] = []
  let vertexCount = 0
  let indexCount = 0
  let totalTriangles = 0
  let droppedStems = 0

  const maxMeshes = Math.floor(MAX_BUCKETS / LOD_COUNT)

  const addMesh = (mesh: TreeMesh): number | null => {
    const existing = meshIds.get(mesh)
    if (existing !== undefined) return existing
    if (meshIds.size >= maxMeshes) return null
    const meshId = meshIds.size
    meshIds.set(mesh, meshId)

    const lods = mesh.lods
    const refHeight = mesh.derived.heightM as number
    for (let lod = 0; lod < LOD_COUNT; lod++) {
      // Meshes with a short LOD chain repeat their coarsest LOD into the remaining buckets.
      // The alternative — a per-mesh LOD count the cull shader clamps against — buys nothing
      // and adds a table the shader has to read on every instance.
      const src = lods[Math.min(lod, lods.length - 1)]
      if (src === undefined || lods.length === 0) {
        buckets.push({
          indexCount: 0,
          firstIndex: 0,
          baseVertex: 0,
          triangleCount: 0,
          refHeightM: refHeight > 0 ? refHeight : 1,
          lod,
          meshId,
        })
        continue
      }
      const isFirstCopy = lod < lods.length
      if (isFirstCopy) {
        const vCount = src.positions.length / 3
        const interleaved = new Float32Array(vCount * VERTEX_FLOATS)
        const slotsForLod = vertexSlots(src, slotFor)
        const asU32 = new Uint32Array(interleaved.buffer)
        for (let v = 0; v < vCount; v++) {
          const o = v * VERTEX_FLOATS
          interleaved[o + 0] = src.positions[v * 3 + 0] ?? 0
          interleaved[o + 1] = src.positions[v * 3 + 1] ?? 0
          interleaved[o + 2] = src.positions[v * 3 + 2] ?? 0
          interleaved[o + 3] = src.normals[v * 3 + 0] ?? 0
          interleaved[o + 4] = src.normals[v * 3 + 1] ?? 1
          interleaved[o + 5] = src.normals[v * 3 + 2] ?? 0
          interleaved[o + 6] = src.uvs[v * 2 + 0] ?? 0
          interleaved[o + 7] = src.uvs[v * 2 + 1] ?? 0
          asU32[o + 8] = slotsForLod[v] ?? 0
        }
        vertexChunks.push(interleaved)
        indexChunks.push(src.indices)
        buckets.push({
          indexCount: src.indices.length,
          firstIndex: indexCount,
          baseVertex: vertexCount,
          triangleCount: src.triangleCount,
          refHeightM: refHeight > 0 ? refHeight : 1,
          lod,
          meshId,
        })
        vertexCount += vCount
        indexCount += src.indices.length
        totalTriangles += src.triangleCount
      } else {
        // Duplicate bucket: same geometry range, no extra vertices or indices.
        const prev = buckets[buckets.length - 1]!
        buckets.push({ ...prev, lod })
      }
    }
    return meshId
  }

  const stems = vegetation.stems
  const instanceBuffer = new ArrayBuffer(stems.length * INSTANCE_FLOATS * 4)
  const instF = new Float32Array(instanceBuffer)
  const instU = new Uint32Array(instanceBuffer)
  let instanceCount = 0

  for (const stem of stems) {
    const mesh = trees.get(stem)
    const meshId = addMesh(mesh)
    if (meshId === null) {
      droppedStems++
      continue
    }
    const o = instanceCount * INSTANCE_FLOATS
    instF[o + INSTANCE_OFF_POS_X] = stem.x as number
    instF[o + INSTANCE_OFF_POS_Y] = stem.groundY as number
    instF[o + INSTANCE_OFF_POS_Z] = stem.z as number
    instF[o + INSTANCE_OFF_HEIGHT] = stem.heightM as number
    instF[o + INSTANCE_OFF_ROTATION_Y] = stem.rotationY as number
    instF[o + INSTANCE_OFF_CULL_RADIUS] = stemCullRadius(stem)
    instU[o + INSTANCE_OFF_MESH_ID] = meshId >>> 0
    instU[o + INSTANCE_OFF_BURN_STATE] = 0
    instanceCount++
  }

  const vertexData = new Float32Array(vertexCount * VERTEX_FLOATS)
  {
    let off = 0
    for (const c of vertexChunks) {
      vertexData.set(c, off)
      off += c.length
    }
  }
  const indexData = new Uint32Array(indexCount)
  {
    let off = 0
    for (const c of indexChunks) {
      indexData.set(c, off)
      off += c.length
    }
  }

  const meshTable = new Uint32Array(buckets.length * MESH_ENTRY_U32S)
  const meshTableF = new Float32Array(meshTable.buffer)
  buckets.forEach((b, i) => {
    const o = i * MESH_ENTRY_U32S
    meshTable[o + MESH_OFF_INDEX_COUNT] = b.indexCount >>> 0
    meshTable[o + MESH_OFF_FIRST_INDEX] = b.firstIndex >>> 0
    meshTable[o + MESH_OFF_BASE_VERTEX] = b.baseVertex >>> 0
    meshTable[o + MESH_OFF_TRIANGLE_COUNT] = b.triangleCount >>> 0
    meshTableF[o + MESH_OFF_REF_HEIGHT] = b.refHeightM
    meshTable[o + MESH_OFF_LOD] = b.lod >>> 0
    meshTable[o + MESH_OFF_MESH_ID] = b.meshId >>> 0
  })

  return {
    vertexData,
    indexData,
    buckets,
    meshTable,
    instanceData: instanceBuffer.slice(0, instanceCount * INSTANCE_FLOATS * 4),
    instanceCount,
    meshCount: meshIds.size,
    materialParams,
    materialSlots: slots,
    grassLayer,
    unresolvedMaterialIds,
    droppedStems,
    totalTriangles,
    vertexBytes: vertexData.byteLength,
    indexBytes: indexData.byteLength,
  }
}
