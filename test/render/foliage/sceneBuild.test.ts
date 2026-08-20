import { describe, expect, it } from 'vitest'
import { buildFoliageScene, stemCullRadius } from '@render/foliage/sceneBuild'
import {
  INSTANCE_FLOATS,
  INSTANCE_OFF_CULL_RADIUS,
  INSTANCE_OFF_HEIGHT,
  INSTANCE_OFF_MESH_ID,
  INSTANCE_OFF_POS_X,
  MESH_ENTRY_U32S,
  MESH_OFF_BASE_VERTEX,
  MESH_OFF_FIRST_INDEX,
  MESH_OFF_INDEX_COUNT,
  MESH_OFF_LOD,
  MESH_OFF_MESH_ID,
  MESH_OFF_TRIANGLE_COUNT,
  VERTEX_FLOATS,
} from '@render/foliage/layout'
import { LOD_COUNT } from '@render/foliage/config'
import {
  STUB_MATERIALS,
  StubTreeMeshSet,
  StubVegetationSet,
  createCpuStubMaterialSystem,
} from '../../fixtures/world.ts'
import { DOMAIN_SIZE_M } from '@contracts/world'
import { m } from '@contracts/units'

const veg = new StubVegetationSet({ seed: 42, stemDensityPerHa: 200 })
const trees = new StubTreeMeshSet()
const materials = createCpuStubMaterialSystem()
const scene = buildFoliageScene(veg, trees, materials)

describe('stub vegetation set', () => {
  it('is deterministic for a seed', () => {
    const again = new StubVegetationSet({ seed: 42, stemDensityPerHa: 200 })
    expect(again.stems.length).toBe(veg.stems.length)
    expect(again.stems[100]!.x).toBe(veg.stems[100]!.x)
    expect(again.stems[100]!.heightM).toBe(veg.stems[100]!.heightM)
  })


  it('keeps every stem inside the domain', () => {
    for (const s of veg.stems) {
      expect(s.x as number).toBeGreaterThanOrEqual(0)
      expect(s.z as number).toBeGreaterThanOrEqual(0)
      expect(s.x as number).toBeLessThan(DOMAIN_SIZE_M)
      expect(s.z as number).toBeLessThan(DOMAIN_SIZE_M)
    }
  })

  it('answers AABB queries consistently with a brute-force scan', () => {
    const hits = veg.stemsInAabb(m(100), m(100), m(200), m(250))
    const brute = veg.stems.filter(
      (s) =>
        (s.x as number) >= 100 &&
        (s.x as number) <= 200 &&
        (s.z as number) >= 100 &&
        (s.z as number) <= 250,
    )
    expect(hits.length).toBe(brute.length)
  })
})

describe('stub tree meshes', () => {

  it('produces a coarser LOD chain', () => {
    const mesh = trees.get(veg.stems[0]!)
    for (let i = 1; i < mesh.lods.length; i++) {
      expect(mesh.lods[i]!.triangleCount).toBeLessThan(mesh.lods[i - 1]!.triangleCount)
    }
  })

  it('caches by quantised parameters rather than per stem', () => {
    expect(trees.uniqueMeshCount).toBeGreaterThan(0)
    expect(trees.uniqueMeshCount).toBeLessThan(veg.stems.length / 10)
  })
})

describe('scene packing', () => {
  it('emits LOD_COUNT buckets per mesh, in bucket-index order', () => {
    expect(scene.buckets.length).toBe(scene.meshCount * LOD_COUNT)
    scene.buckets.forEach((b, i) => {
      expect(b.meshId).toBe(Math.floor(i / LOD_COUNT))
      expect(b.lod).toBe(i % LOD_COUNT)
    })
  })

  it('drops no stems at this scene size', () => {
    expect(scene.droppedStems).toBe(0)
    expect(scene.instanceCount).toBe(veg.stems.length)
  })

  it('writes instances that match their stems', () => {
    const f = new Float32Array(scene.instanceData)
    const u = new Uint32Array(scene.instanceData)
    for (let i = 0; i < 50; i++) {
      const stem = veg.stems[i]!
      const o = i * INSTANCE_FLOATS
      expect(f[o + INSTANCE_OFF_POS_X]).toBeCloseTo(stem.x as number, 4)
      expect(f[o + INSTANCE_OFF_HEIGHT]).toBeCloseTo(stem.heightM as number, 4)
      expect(f[o + INSTANCE_OFF_CULL_RADIUS]).toBeCloseTo(stemCullRadius(stem), 4)
      expect(u[o + INSTANCE_OFF_MESH_ID]).toBeLessThan(scene.meshCount)
    }
  })

  it('gives every stem a bounding sphere that actually contains its crown', () => {
    for (const stem of veg.stems.slice(0, 200)) {
      const r = stemCullRadius(stem)
      // The crown's topmost outer point relative to the sphere centre at h/2.
      const dy = (stem.heightM as number) / 2
      expect(r).toBeGreaterThanOrEqual(Math.max(dy, stem.crownRadiusM as number) - 1e-6)
    }
  })

  it('produces index ranges that stay inside the shared vertex buffer', () => {
    const vertexCount = scene.vertexData.length / VERTEX_FLOATS
    for (const b of scene.buckets) {
      expect(b.firstIndex + b.indexCount).toBeLessThanOrEqual(scene.indexData.length)
      let maxIndex = 0
      for (let i = b.firstIndex; i < b.firstIndex + b.indexCount; i++) {
        maxIndex = Math.max(maxIndex, scene.indexData[i] ?? 0)
      }
      expect(b.baseVertex + maxIndex).toBeLessThan(vertexCount)
    }
  })

  it('packs a mesh table that matches the bucket list', () => {
    const t = scene.meshTable
    scene.buckets.forEach((b, i) => {
      const o = i * MESH_ENTRY_U32S
      expect(t[o + MESH_OFF_INDEX_COUNT]).toBe(b.indexCount)
      expect(t[o + MESH_OFF_FIRST_INDEX]).toBe(b.firstIndex)
      expect(t[o + MESH_OFF_BASE_VERTEX]).toBe(b.baseVertex)
      expect(t[o + MESH_OFF_TRIANGLE_COUNT]).toBe(b.triangleCount)
      expect(t[o + MESH_OFF_LOD]).toBe(b.lod)
      expect(t[o + MESH_OFF_MESH_ID]).toBe(b.meshId)
    })
  })

  it('assigns a material slot to every vertex', () => {
    const u = new Uint32Array(scene.vertexData.buffer)
    const vertexCount = scene.vertexData.length / VERTEX_FLOATS
    const slots = new Set<number>()
    for (let v = 0; v < vertexCount; v++) slots.add(u[v * VERTEX_FLOATS + 8] ?? -1)
    for (const slot of slots) {
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(STUB_MATERIALS.length)
    }
    // Trees carry bark and foliage, so both slots must actually appear.
    expect(slots.size).toBeGreaterThanOrEqual(2)
  })

  it('keeps the far LODs cheap', () => {
    // The point of the LOD chain: the coarsest bucket must be dramatically cheaper than L0,
    // because at 1 km almost every instance lands there.
    const l0 = scene.buckets.filter((b) => b.lod === 0).reduce((a, b) => a + b.triangleCount, 0)
    const l3 = scene.buckets
      .filter((b) => b.lod === LOD_COUNT - 1)
      .reduce((a, b) => a + b.triangleCount, 0)
    expect(l3).toBeLessThan(l0 / 4)
  })
})
