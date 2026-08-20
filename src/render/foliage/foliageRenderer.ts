/**
 * `IFoliageRenderer` — GPU-driven tree culling and instancing, plus GPU-generated grass.
 *
 * Per frame the CPU does a fixed amount of work that does not depend on scene content: two
 * uniform writes, five compute dispatches, and one indirect draw per (mesh, LOD) bucket plus
 * one per grass band. Every instance count in every draw is authored on the GPU.
 *
 * PASS STRUCTURE
 *   cull(encoder):
 *     1. classify  — frustum + LOD per instance, append records, count per bucket
 *     2. scan      — one workgroup: prefix sum over buckets, write indirect draw args
 *     3. scatter   — write records into their bucket's run of the compacted list
 *     4. cullTiles — grass tiles into per-band lists, exact blade count
 *     5. writeArgs — per-band grass indirect draw args
 *   draw(pass):
 *     one drawIndexedIndirect per tree bucket, one drawIndirect per grass band.
 *
 * WHAT THIS IS NOT DOING, AND WHY
 *   - No Hi-Z occlusion cull. It needs the previous frame's depth pyramid, which does not
 *     exist until the depth prepass lands. It drops into `classify` as one extra test.
 *   - No impostor path. `TreeMesh.impostor` is optional in the contract and WP 1.4 may not
 *     bake one; the coarsest available LOD is repeated into the remaining buckets instead, so
 *     the far field is cheap real geometry rather than a missing draw.
 *   Both are marked here rather than stubbed to return zeros.
 */

import type { CameraState, FoliageStats, IFoliageRenderer, IMaterialSystem } from '@contracts/render'
import type { QualitySettings } from '@contracts/gpu'
import type { ITreeMeshSet, IVegetationSet } from '@contracts/world'
import { DOMAIN_SIZE_M } from '@contracts/world'
import { BURN_PEAK_SCALE } from './layout.ts'
import {
  CULL_WORKGROUP_SIZE,
  DEFAULT_FOLIAGE_CONFIG,
  DEFAULT_WIND,
  GRASS_CULL_WORKGROUP_SIZE,
  LOD_COUNT,
  MAX_BUCKETS,
  resolveAlphaStrategy,
  type FoliageConfig,
  type WindState,
} from './config.ts'
import {
  BUCKET_UNIFORM_STRIDE_BYTES,
  CONTROL_OFF_STATS,
  CULL_UNIFORM_BYTES,
  DRAW_ARGS_BYTES,
  DRAW_INDEXED_ARGS_BYTES,
  FRAME_UNIFORM_BYTES,
  GRASS_UNIFORM_BYTES,
  STATS_BYTES,
  STATS_CLAMP_EVENTS,
  STATS_GRASS_BLADES,
  STATS_GRASS_TILES,
  STATS_RECORDS_APPENDED,
  STATS_TREES_CULLED,
  STATS_TREES_VISIBLE,
  STATS_TRIANGLES,
  STATS_U32S,
  VERTEX_ATTRIBUTES,
  VERTEX_STRIDE_BYTES,
  clampDispatch,
  controlU32s,
} from './layout.ts'
import { extractFrustumPlanes, pixelsPerMetreAtUnitDepth, PLANE_FLOATS } from './cullMath.ts'
import {
  bandCount,
  domainTiles,
  tileCapacityPerBand,
  tileSpan,
  validateGrassParams,
} from './grassMath.ts'
import { buildFoliageScene, type FoliageScene, type MaterialIdMap } from './sceneBuild.ts'
import {
  COMPUTE_ENTRY_CLASSIFY,
  COMPUTE_ENTRY_SCAN,
  COMPUTE_ENTRY_SCATTER,
  GRASS_ENTRY_ARGS,
  GRASS_ENTRY_CULL,
  GRASS_FS,
  GRASS_VS,
  TREE_FS,
  TREE_VS,
  buildFoliageShaders,
} from './shaders.ts'

export interface FoliageRendererOptions {
  readonly device: GPUDevice
  readonly vegetation: IVegetationSet
  readonly trees: ITreeMeshSet
  readonly materials: IMaterialSystem
  readonly config?: Partial<FoliageConfig>
  /**
   * `ITerrainField.heightTexture`. Grass reads ground height from it directly, so the field
   * follows terrain with no CPU involvement. Omitted, grass sits on a flat plane at y = 0 and
   * `usesFlatGround` reports true — visibly wrong rather than subtly wrong.
   */
  readonly terrainHeightTexture?: GPUTexture
  /** Sun-occlusion map, `render/shadow/sunOcclusion.ts`. Sampled by both draw passes. */
  readonly occlusionTexture?: GPUTexture
  /** True when the device granted the `subgroups` feature. Selects the scan implementation. */
  readonly hasSubgroups?: boolean
  readonly materialIds?: MaterialIdMap
  /** Maximum workgroups per dispatch dimension, from device limits. */
  readonly maxComputeWorkgroupsPerDimension?: number
}

/** Everything `FoliageStats` has no room for, kept because the integrator needs it. */
export interface FoliageDiagnostics {
  readonly recordsAppended: number
  readonly grassTilesDrawn: number
  /** Non-zero means a count was clamped somewhere on the GPU. Never silent. */
  readonly clampEvents: number
  readonly bucketCount: number
  readonly instanceCount: number
  readonly meshCount: number
  readonly droppedStems: number
  readonly vertexBytes: number
  readonly indexBytes: number
  readonly usesFlatGround: boolean
  readonly usesSubgroupScan: boolean
  readonly alphaStrategy: 'dither' | 'alpha-to-coverage'
  /** Set when the stats readback has not completed a round trip yet. */
  readonly statsPending: boolean
}

const ZERO_STATS: FoliageStats = {
  treesVisible: 0,
  treesCulled: 0,
  drawCalls: 0,
  trianglesSubmitted: 0,
  grassBladesDrawn: 0,
}

function bufferOf(
  device: GPUDevice,
  label: string,
  data: ArrayBufferView | ArrayBuffer,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  // WebGPU requires a multiple of 4; geometry arrays are already aligned but a caller's
  // material block might not be.
  const size = Math.max(4, Math.ceil(bytes.byteLength / 4) * 4)
  const buf = device.createBuffer({ label, size, usage, mappedAtCreation: true })
  new Uint8Array(buf.getMappedRange()).set(bytes)
  buf.unmap()
  return buf
}

function emptyBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  return device.createBuffer({ label, size: Math.max(4, Math.ceil(size / 4) * 4), usage })
}

export class FoliageRenderer implements IFoliageRenderer {
  readonly scene: FoliageScene
  readonly config: FoliageConfig

  private readonly device: GPUDevice
  private readonly bucketCount: number
  private readonly compactedCapacity: number
  private readonly bands: number
  private readonly grassEnabled: boolean
  private readonly usesFlatGround: boolean
  private readonly usesSubgroupScan: boolean
  private readonly alphaStrategy: 'dither' | 'alpha-to-coverage'
  private readonly maxWorkgroups: number

  // Geometry and scene data
  private readonly vertexBuffer: GPUBuffer
  private readonly indexBuffer: GPUBuffer
  /** Packed tree instances. Read-only outside this class — the sun-occlusion pass
   *  rasterises crown discs straight from it rather than keeping a second copy. */
  readonly instanceBuffer: GPUBuffer
  private readonly meshTableBuffer: GPUBuffer
  private readonly materialParamsBuffer: GPUBuffer

  // Cull working set. `controlBuffer` carries the stats, the record counter and the
  // per-bucket counts/cursors/bases in one binding — see layout.ts for why.
  private readonly controlBuffer: GPUBuffer
  private readonly recordsBuffer: GPUBuffer
  private readonly compactedBuffer: GPUBuffer
  private readonly drawArgsBuffer: GPUBuffer
  private readonly bucketUniformBuffer: GPUBuffer

  // Grass
  private readonly grassUniformBuffer: GPUBuffer
  private readonly tileListsBuffer: GPUBuffer
  private readonly tileCountsBuffer: GPUBuffer
  private readonly grassDrawArgsBuffer: GPUBuffer
  private readonly bandUniformBuffer: GPUBuffer
  private readonly heightTexture: GPUTexture
  private readonly ownsHeightTexture: boolean
  private readonly occlusionTexture: GPUTexture
  private readonly ownsOcclusionTexture: boolean
  /** Peak fireline intensity each stem has ever stood in, fixed point. See burnState.wgsl. */
  private readonly burnPeakBuffer: GPUBuffer
  private readonly burnStateUniform: GPUBuffer
  private readonly burnStateLayout: GPUBindGroupLayout
  private readonly burnStatePipeline: GPUComputePipeline
  private burnStateBindGroup: GPUBindGroup
  private readonly treeLayout: GPUBindGroupLayout
  private readonly grassDrawLayout: GPUBindGroupLayout
  private readonly zeroTexture: GPUTexture
  private consumedTexture: GPUTexture
  private intensityTexture: GPUTexture

  private readonly frameUniformBuffer: GPUBuffer
  private readonly cullUniformBuffer: GPUBuffer

  private readonly frameBindGroup: GPUBindGroup
  private readonly cullBindGroup: GPUBindGroup
  private treeBindGroup: GPUBindGroup
  private readonly grassCullBindGroup: GPUBindGroup
  private grassDrawBindGroup: GPUBindGroup
  private readonly materialBindGroup: GPUBindGroup

  private readonly classifyPipeline: GPUComputePipeline
  private readonly scanPipeline: GPUComputePipeline
  private readonly scatterPipeline: GPUComputePipeline
  private readonly grassCullPipeline: GPUComputePipeline
  private readonly grassArgsPipeline: GPUComputePipeline
  private readonly treePipeline: GPURenderPipeline
  private readonly grassPipeline: GPURenderPipeline

  private readonly frameScratch = new ArrayBuffer(FRAME_UNIFORM_BYTES)
  private readonly cullScratch = new ArrayBuffer(CULL_UNIFORM_BYTES)
  private readonly grassScratch = new ArrayBuffer(GRASS_UNIFORM_BYTES)
  private readonly planes = new Float32Array(PLANE_FLOATS)

  private readonly readbackPool: { buffer: GPUBuffer; busy: boolean }[] = []
  private readonly pendingReadbacks: { index: number; frame: number }[] = []
  private latestStats = new Uint32Array(STATS_U32S)
  private statsResolved = false
  private frameIndex = 0
  private lastDrawCalls = 0

  private wind: WindState = DEFAULT_WIND
  private sunDir: readonly [number, number, number] = [-0.4, -0.75, -0.52]
  /** Direct normal and diffuse horizontal irradiance, W/m2. See setIrradiance(). */
  private sunIrradiance: [number, number, number] = [900, 900, 900]
  private skyIrradiance: [number, number, number] = [140, 140, 140]
  private timeSec = 0
  private timeIsExternal = false
  private readonly startedAt = typeof performance !== 'undefined' ? performance.now() : 0

  /** Problems detected at construction that the caller should see. Empty means all good. */
  readonly warnings: readonly string[]

  constructor(opts: FoliageRendererOptions) {
    const device = opts.device
    this.device = device
    const cfg: FoliageConfig = { ...DEFAULT_FOLIAGE_CONFIG, ...opts.config }
    this.config = cfg
    const warnings: string[] = []

    this.scene = buildFoliageScene(
      opts.vegetation,
      opts.trees,
      opts.materials,
      opts.materialIds ?? undefined,
    )
    if (this.scene.unresolvedMaterialIds.length > 0) {
      const msg =
        `foliage: material id(s) ${this.scene.unresolvedMaterialIds.map((i) => `'${i}'`).join(', ')} ` +
        `did not resolve and fell back to slot 0. Everything tagged with them is drawn with the ` +
        `wrong texture. Known ids: ${[...this.scene.materialSlots.keys()].join(', ')}`
      warnings.push(msg)
      console.warn(msg)
    }
    if (this.scene.droppedStems > 0) {
      warnings.push(
        `${this.scene.droppedStems} stems dropped: the mesh set produced more than ` +
          `${Math.floor(MAX_BUCKETS / LOD_COUNT)} unique meshes, which is the bucket-table limit.`,
      )
    }
    this.bucketCount = this.scene.buckets.length
    if (this.bucketCount > MAX_BUCKETS) {
      throw new Error(
        `foliage: ${this.bucketCount} buckets exceeds MAX_BUCKETS=${MAX_BUCKETS}; the ` +
          `single-workgroup scan cannot cover them.`,
      )
    }
    // Two records per instance is the worst case: every instance mid-cross-fade at once.
    this.compactedCapacity = Math.max(2 * this.scene.instanceCount, 1)
    this.maxWorkgroups = opts.maxComputeWorkgroupsPerDimension ?? 65535

    const grassProblems = validateGrassParams(cfg.grass)
    for (const p of grassProblems) warnings.push(`grass params: ${p}`)
    this.bands = bandCount(cfg.grass)
    this.grassEnabled = cfg.enableGrass && this.bands > 0 && grassProblems.length === 0

    this.usesSubgroupScan = (opts.hasSubgroups ?? false) && cfg.useSubgroups
    this.alphaStrategy = resolveAlphaStrategy(cfg.alphaStrategy, cfg.sampleCount)
    if (cfg.alphaStrategy === 'alpha-to-coverage' && this.alphaStrategy !== 'alpha-to-coverage') {
      warnings.push(
        'alpha-to-coverage requested on a single-sampled target; downgraded to dither ' +
          '(enabling it would be a WebGPU validation error, not a no-op).',
      )
    }

    // ---- buffers -------------------------------------------------------------------
    const S = GPUBufferUsage.STORAGE
    const CD = GPUBufferUsage.COPY_DST
    const CS = GPUBufferUsage.COPY_SRC

    this.vertexBuffer = bufferOf(device, 'foliage.vertices', this.scene.vertexData, GPUBufferUsage.VERTEX | CD)
    this.indexBuffer = bufferOf(device, 'foliage.indices', this.scene.indexData, GPUBufferUsage.INDEX | CD)
    this.instanceBuffer = bufferOf(device, 'foliage.instances', this.scene.instanceData, S | CD)
    this.meshTableBuffer = bufferOf(device, 'foliage.meshTable', this.scene.meshTable, S | CD)
    this.materialParamsBuffer = bufferOf(device, 'foliage.materialParams', this.scene.materialParams, S | CD)

    const nb = Math.max(this.bucketCount, 1)
    this.controlBuffer = emptyBuffer(device, 'foliage.control', controlU32s(nb) * 4, S | CD | CS)
    this.recordsBuffer = emptyBuffer(device, 'foliage.records', this.compactedCapacity * 8, S | CD)
    this.compactedBuffer = emptyBuffer(device, 'foliage.compacted', this.compactedCapacity * 4, S | CD)
    this.drawArgsBuffer = emptyBuffer(
      device,
      'foliage.drawArgs',
      nb * DRAW_INDEXED_ARGS_BYTES,
      S | CD | CS | GPUBufferUsage.INDIRECT,
    )

    // One dynamic-offset uniform slot per bucket, filled once. 256 B stride because that is
    // minUniformBufferOffsetAlignment on every known implementation.
    {
      const stride = BUCKET_UNIFORM_STRIDE_BYTES
      const data = new Uint32Array((nb * stride) / 4)
      for (let b = 0; b < nb; b++) {
        data[(b * stride) / 4] = b
        data[(b * stride) / 4 + 1] = this.bucketCount
      }
      this.bucketUniformBuffer = bufferOf(device, 'foliage.bucketUniform', data, GPUBufferUsage.UNIFORM | CD)
    }

    const nBands = Math.max(this.bands, 1)
    const capacity = tileCapacityPerBand(cfg.grass)
    this.grassUniformBuffer = emptyBuffer(device, 'foliage.grassUniform', GRASS_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | CD)
    this.tileListsBuffer = emptyBuffer(device, 'foliage.tileLists', nBands * capacity * 4, S | CD)
    this.tileCountsBuffer = emptyBuffer(device, 'foliage.tileCounts', nBands * 4, S | CD)
    this.grassDrawArgsBuffer = emptyBuffer(
      device,
      'foliage.grassDrawArgs',
      nBands * DRAW_ARGS_BYTES,
      S | CD | CS | GPUBufferUsage.INDIRECT,
    )
    {
      const stride = BUCKET_UNIFORM_STRIDE_BYTES
      const data = new Uint32Array((nBands * stride) / 4)
      for (let b = 0; b < nBands; b++) data[(b * stride) / 4] = b
      this.bandUniformBuffer = bufferOf(device, 'foliage.bandUniform', data, GPUBufferUsage.UNIFORM | CD)
    }

    this.frameUniformBuffer = emptyBuffer(device, 'foliage.frame', FRAME_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | CD)
    this.cullUniformBuffer = emptyBuffer(device, 'foliage.cullUniform', CULL_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | CD)

    if (opts.terrainHeightTexture !== undefined) {
      this.heightTexture = opts.terrainHeightTexture
      this.ownsHeightTexture = false
      this.usesFlatGround = false
    } else {
      this.heightTexture = device.createTexture({
        label: 'foliage.flatGround',
        size: { width: 1, height: 1 },
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture(
        { texture: this.heightTexture },
        new Float32Array([0]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      )
      this.ownsHeightTexture = true
      this.usesFlatGround = true
      warnings.push('no terrain height texture supplied: grass is drawn on a flat plane at y = 0.')
    }

    for (let i = 0; i < Math.max(2, cfg.statsLatencyFrames); i++) {
      this.readbackPool.push({
        buffer: emptyBuffer(device, `foliage.statsReadback${i}`, STATS_BYTES, GPUBufferUsage.MAP_READ | CD),
        busy: false,
      })
    }

    // ---- bind group layouts --------------------------------------------------------
    const frameLayout = device.createBindGroupLayout({
      label: 'foliage.frameLayout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    })
    const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    })
    // Six storage buffers, which is what core WebGPU's maxStorageBuffersPerShaderStage of 8
    // leaves room for. See layout.ts on the control buffer.
    const cullLayout = device.createBindGroupLayout({
      label: 'foliage.cullLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        storage(1, 'read-only-storage'),
        storage(2, 'read-only-storage'),
        storage(3, 'storage'),
        storage(4, 'storage'),
        storage(5, 'storage'),
        storage(6, 'storage'),
      ],
    })
    this.treeLayout = device.createBindGroupLayout({
      label: 'foliage.treeLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        // Sun occlusion. VERTEX, because visibility is resolved per vertex and interpolated
        // as `sunVis` — sampling it per fragment would cost a fetch per pixel to reproduce a
        // value that is constant over a whole stem.
        {
          binding: 6,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        // Burn state. VERTEX, because the burn coordinate varies up the stem and so is
        // computed per vertex and interpolated.
        { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        {
          binding: 8,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    const grassCullLayout = device.createBindGroupLayout({
      label: 'foliage.grassCullLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        storage(1, 'storage'),
        storage(2, 'storage'),
        storage(3, 'storage'),
        storage(4, 'storage'),
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          // textureLoad only, so unfilterable-float — no dependency on `float32-filterable`.
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    this.grassDrawLayout = device.createBindGroupLayout({
      label: 'foliage.grassDrawLayout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        // Sun occlusion. VERTEX: `sunVis` is computed at the blade root and interpolated flat.
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })

    // ---- bind groups ---------------------------------------------------------------
    this.frameBindGroup = device.createBindGroup({
      label: 'foliage.frame',
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameUniformBuffer } }],
    })
    this.cullBindGroup = device.createBindGroup({
      label: 'foliage.cull',
      layout: cullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cullUniformBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
        { binding: 2, resource: { buffer: this.meshTableBuffer } },
        { binding: 3, resource: { buffer: this.recordsBuffer } },
        { binding: 4, resource: { buffer: this.compactedBuffer } },
        { binding: 5, resource: { buffer: this.drawArgsBuffer } },
        { binding: 6, resource: { buffer: this.controlBuffer } },
      ],
    })
    // A 1x1 fully-visible stand-in when no map is supplied, so these pipelines never depend
    // on the occlusion pass existing. `sunOcclusionTexel` returns 1 for a 1x1 texture, so an
    // unwired build renders exactly as it did before this pass was written.
    this.occlusionTexture = opts.occlusionTexture ?? whiteTexel(device, 'foliage.noOcclusion')
    this.ownsOcclusionTexture = opts.occlusionTexture === undefined
    const occlusionView = this.occlusionTexture.createView()

    // The fire solver is built AFTER the renderer, so the burn bindings start on a 1x1 zero
    // texture and `attachFire` swaps in the real ones. Both `consumedAt` and `csBurnState`
    // return "nothing has burned" for a 1x1, so an unattached build renders green.
    this.zeroTexture = zeroTexel(device, 'foliage.noFire')
    this.consumedTexture = this.zeroTexture
    this.intensityTexture = this.zeroTexture
    this.burnPeakBuffer = emptyBuffer(
      device,
      'foliage.burnPeak',
      Math.max(4, this.scene.instanceCount * 4),
      GPUBufferUsage.STORAGE | CD | GPUBufferUsage.COPY_SRC,
    )
    this.burnStateUniform = emptyBuffer(device, 'foliage.burnStateU', 16, GPUBufferUsage.UNIFORM | CD)
    device.queue.writeBuffer(
      this.burnStateUniform,
      0,
      new Float32Array([DOMAIN_SIZE_M, this.scene.instanceCount, 0, 0]),
    )
    this.burnStateLayout = device.createBindGroupLayout({
      label: 'foliage.burnStateLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    this.treeBindGroup = device.createBindGroup({
      label: 'foliage.tree',
      layout: this.treeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.instanceBuffer } },
        { binding: 1, resource: { buffer: this.meshTableBuffer } },
        { binding: 2, resource: { buffer: this.compactedBuffer } },
        { binding: 3, resource: { buffer: this.controlBuffer } },
        { binding: 4, resource: { buffer: this.bucketUniformBuffer, size: 16 } },
        { binding: 5, resource: { buffer: this.materialParamsBuffer } },
        { binding: 6, resource: occlusionView },
        { binding: 7, resource: { buffer: this.burnPeakBuffer } },
        { binding: 8, resource: this.consumedTexture.createView() },
      ],
    })
    const heightView = this.heightTexture.createView()
    this.grassCullBindGroup = device.createBindGroup({
      label: 'foliage.grassCull',
      layout: grassCullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.grassUniformBuffer } },
        { binding: 1, resource: { buffer: this.tileListsBuffer } },
        { binding: 2, resource: { buffer: this.tileCountsBuffer } },
        { binding: 3, resource: { buffer: this.grassDrawArgsBuffer } },
        { binding: 4, resource: { buffer: this.controlBuffer } },
        { binding: 5, resource: heightView },
      ],
    })
    this.grassDrawBindGroup = device.createBindGroup({
      label: 'foliage.grassDraw',
      layout: this.grassDrawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.grassUniformBuffer } },
        { binding: 1, resource: { buffer: this.tileListsBuffer } },
        { binding: 2, resource: { buffer: this.bandUniformBuffer, size: 16 } },
        { binding: 3, resource: heightView },
        { binding: 4, resource: occlusionView },
        { binding: 5, resource: this.consumedTexture.createView() },
      ],
    })
    this.materialBindGroup = opts.materials.createBindGroup(device)

    // ---- pipelines -----------------------------------------------------------------
    const src = buildFoliageShaders({
      useSubgroups: this.usesSubgroupScan,
      ditherAlpha: this.alphaStrategy === 'dither',
    })
    const computeModule = device.createShaderModule({ label: 'foliage.compute', code: src.compute })
    const treeModule = device.createShaderModule({ label: 'foliage.treeDraw', code: src.treeDraw })
    const grassCullModule = device.createShaderModule({ label: 'foliage.grassCull', code: src.grassCull })
    const grassDrawModule = device.createShaderModule({ label: 'foliage.grassDraw', code: src.grassDraw })

    const cullPipelineLayout = device.createPipelineLayout({
      label: 'foliage.cullPipelineLayout',
      bindGroupLayouts: [frameLayout, cullLayout],
    })
    this.classifyPipeline = device.createComputePipeline({
      label: 'foliage.classify',
      layout: cullPipelineLayout,
      compute: { module: computeModule, entryPoint: COMPUTE_ENTRY_CLASSIFY },
    })
    this.scanPipeline = device.createComputePipeline({
      label: 'foliage.scan',
      layout: cullPipelineLayout,
      compute: { module: computeModule, entryPoint: COMPUTE_ENTRY_SCAN },
    })
    this.scatterPipeline = device.createComputePipeline({
      label: 'foliage.scatter',
      layout: cullPipelineLayout,
      compute: { module: computeModule, entryPoint: COMPUTE_ENTRY_SCATTER },
    })

    const grassCullPipelineLayout = device.createPipelineLayout({
      label: 'foliage.grassCullPipelineLayout',
      bindGroupLayouts: [frameLayout, grassCullLayout],
    })
    this.grassCullPipeline = device.createComputePipeline({
      label: 'foliage.grassTiles',
      layout: grassCullPipelineLayout,
      compute: { module: grassCullModule, entryPoint: GRASS_ENTRY_CULL },
    })
    this.burnStatePipeline = device.createComputePipeline({
      label: 'foliage.burnState',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.burnStateLayout] }),
      compute: {
        module: device.createShaderModule({ label: 'foliage.burnState', code: src.burnState }),
        entryPoint: 'csBurnState',
      },
    })
    this.burnStateBindGroup = this.makeBurnStateBindGroup(device)

    this.grassArgsPipeline = device.createComputePipeline({
      label: 'foliage.grassArgs',
      layout: grassCullPipelineLayout,
      compute: { module: grassCullModule, entryPoint: GRASS_ENTRY_ARGS },
    })

    const targets: GPUColorTargetState[] = cfg.colorFormats.map((format) => ({ format }))
    const multisample: GPUMultisampleState =
      this.alphaStrategy === 'alpha-to-coverage'
        ? { count: cfg.sampleCount, alphaToCoverageEnabled: true }
        : { count: cfg.sampleCount }
    const depthStencil: GPUDepthStencilState = {
      format: cfg.depthFormat,
      depthWriteEnabled: cfg.depthWriteEnabled,
      depthCompare: cfg.depthCompare,
    }

    this.treePipeline = device.createRenderPipeline({
      label: 'foliage.treePipeline',
      layout: device.createPipelineLayout({
        label: 'foliage.treePipelineLayout',
        bindGroupLayouts: [frameLayout, this.treeLayout, opts.materials.bindGroupLayout],
      }),
      vertex: {
        module: treeModule,
        entryPoint: TREE_VS,
        buffers: [
          {
            arrayStride: VERTEX_STRIDE_BYTES,
            stepMode: 'vertex',
            attributes: VERTEX_ATTRIBUTES,
          },
        ],
      },
      fragment: { module: treeModule, entryPoint: TREE_FS, targets },
      // Foliage cards are two-sided by construction; culling them would delete half of every
      // crown. Bark shares the draw, so it pays the same price.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
      multisample,
    })
    this.grassPipeline = device.createRenderPipeline({
      label: 'foliage.grassPipeline',
      layout: device.createPipelineLayout({
        label: 'foliage.grassPipelineLayout',
        bindGroupLayouts: [frameLayout, this.grassDrawLayout, opts.materials.bindGroupLayout],
      }),
      vertex: { module: grassDrawModule, entryPoint: GRASS_VS },
      fragment: { module: grassDrawModule, entryPoint: GRASS_FS, targets },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil,
      multisample,
    })

    this.warnings = warnings
  }

  // ---------------------------------------------------------------------------
  // Settable state — the M5 handover points
  // ---------------------------------------------------------------------------

  /**
   * Wind driving foliage animation. At M5 the terrain-modified wind field (WP 5.4) calls this
   * every frame with the field sampled at the camera; until then it is a synthetic constant.
   * It exists as a setter precisely so that handover does not reopen `IFoliageRenderer`.
   */
  /** Direction the wind blows TOWARDS, radians clockwise from north (+Z). */
  get windDirectionRad(): number {
    return this.wind.directionRad as number
  }

  get windSpeedMps(): number {
    return this.wind.speedMps
  }

  setWind(wind: WindState): void {
    this.wind = wind
  }

  /** Direction the sunlight travels (not the direction TO the sun). WP 1.7 drives this. */
  setSunDirection(dir: readonly [number, number, number]): void {
    this.sunDir = dir
  }

  /**
   * Direct normal and diffuse horizontal irradiance, W/m2, from WP 1.7's `SolarState`.
   *
   * This pass emits PHYSICAL RADIANCE so it composites with the terrain, the sky and the
   * tone mapper, all of which are physical. Without it the foliage shading peaked near 1.0
   * against a terrain emitting ~58 W/m2/sr, and every tree and blade of grass rendered as a
   * pure black silhouette at any exposure. Defaults are a clear mid-morning sun so an
   * un-driven renderer looks wrong-but-visible rather than invisible.
   */
  setIrradiance(
    directNormal: readonly [number, number, number],
    diffuseHorizontal: readonly [number, number, number],
  ): void {
    const clamp3 = (v: readonly [number, number, number]): [number, number, number] => [
      Math.max(0, v[0]),
      Math.max(0, v[1]),
      Math.max(0, v[2]),
    ]
    this.sunIrradiance = clamp3(directNormal)
    this.skyIrradiance = clamp3(diffuseHorizontal)
  }

  /**
   * Simulated clock seconds for the animation phase. Left unset, wall time is used — but the
   * spec is explicit that simulated time is tracked separately from wall time, so anything
   * that owns a clock should call this.
   */
  setTime(seconds: number): void {
    this.timeSec = seconds
    this.timeIsExternal = true
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  cull(encoder: GPUCommandEncoder, camera: CameraState, quality: QualitySettings): void {
    this.frameIndex++
    if (!this.timeIsExternal) {
      this.timeSec =
        (typeof performance !== 'undefined' ? performance.now() - this.startedAt : 0) / 1000
    }
    this.collectReadbacks()
    this.writeUniforms(camera, quality)

    // Zero everything the kernels accumulate into. clearBuffer is a queue-timeline operation
    // ordered with the dispatches that follow, so no host round trip is involved.
    encoder.clearBuffer(this.controlBuffer)
    if (this.grassEnabled) encoder.clearBuffer(this.tileCountsBuffer)

    const pass = encoder.beginComputePass({ label: 'foliage.cull' })
    pass.setBindGroup(0, this.frameBindGroup)
    pass.setBindGroup(1, this.cullBindGroup)

    const classify = this.dispatchFor(this.scene.instanceCount, CULL_WORKGROUP_SIZE)
    pass.setPipeline(this.classifyPipeline)
    pass.dispatchWorkgroups(classify.x, classify.y, classify.z)

    // One workgroup: SCAN_WORKGROUP_SIZE threads x BUCKETS_PER_SCAN_THREAD buckets covers
    // MAX_BUCKETS, and the constructor already refused a scene with more.
    pass.setPipeline(this.scanPipeline)
    pass.dispatchWorkgroups(1, 1, 1)

    const scatter = this.dispatchFor(this.compactedCapacity, CULL_WORKGROUP_SIZE)
    pass.setPipeline(this.scatterPipeline)
    pass.dispatchWorkgroups(scatter.x, scatter.y, scatter.z)

    if (this.grassEnabled) {
      const span = tileSpan(this.config.grass)
      const tiles = this.dispatchFor(span * span, GRASS_CULL_WORKGROUP_SIZE)
      pass.setBindGroup(1, this.grassCullBindGroup)
      pass.setPipeline(this.grassCullPipeline)
      pass.dispatchWorkgroups(tiles.x, tiles.y, tiles.z)
      pass.setPipeline(this.grassArgsPipeline)
      pass.dispatchWorkgroups(1, 1, 1)
    }
    pass.end()

    const slot = this.readbackPool.findIndex((r) => !r.busy)
    const entry = slot >= 0 ? this.readbackPool[slot] : undefined
    if (entry !== undefined) {
      entry.busy = true
      encoder.copyBufferToBuffer(this.controlBuffer, CONTROL_OFF_STATS * 4, entry.buffer, 0, STATS_BYTES)
      this.pendingReadbacks.push({ index: slot, frame: this.frameIndex })
    }
  }

  draw(pass: GPURenderPassEncoder, camera: CameraState, quality: QualitySettings): void {
    void camera
    void quality
    let draws = 0

    pass.setPipeline(this.treePipeline)
    pass.setBindGroup(0, this.frameBindGroup)
    pass.setBindGroup(2, this.materialBindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    if (this.scene.indexData.length > 0) {
      pass.setIndexBuffer(this.indexBuffer, 'uint32')
      for (let b = 0; b < this.bucketCount; b++) {
        // Buckets whose mesh has no geometry are skipped on the CPU. Their instance count is
        // GPU-authored and would be zero anyway, but a zero-work draw still costs a command.
        if ((this.scene.buckets[b]?.indexCount ?? 0) === 0) continue
        pass.setBindGroup(1, this.treeBindGroup, [b * BUCKET_UNIFORM_STRIDE_BYTES])
        pass.drawIndexedIndirect(this.drawArgsBuffer, b * DRAW_INDEXED_ARGS_BYTES)
        draws++
      }
    }

    if (this.grassEnabled) {
      pass.setPipeline(this.grassPipeline)
      pass.setBindGroup(0, this.frameBindGroup)
      pass.setBindGroup(2, this.materialBindGroup)
      for (let band = 0; band < this.bands; band++) {
        pass.setBindGroup(1, this.grassDrawBindGroup, [band * BUCKET_UNIFORM_STRIDE_BYTES])
        pass.drawIndirect(this.grassDrawArgsBuffer, band * DRAW_ARGS_BYTES)
        draws++
      }
    }

    this.lastDrawCalls = draws
  }

  get stats(): FoliageStats {
    if (!this.statsResolved) return { ...ZERO_STATS, drawCalls: this.lastDrawCalls }
    const s = this.latestStats
    return {
      treesVisible: s[STATS_TREES_VISIBLE] ?? 0,
      treesCulled: s[STATS_TREES_CULLED] ?? 0,
      drawCalls: this.lastDrawCalls,
      trianglesSubmitted: s[STATS_TRIANGLES] ?? 0,
      grassBladesDrawn: s[STATS_GRASS_BLADES] ?? 0,
    }
  }

  get diagnostics(): FoliageDiagnostics {
    const s = this.latestStats
    return {
      recordsAppended: s[STATS_RECORDS_APPENDED] ?? 0,
      grassTilesDrawn: s[STATS_GRASS_TILES] ?? 0,
      clampEvents: s[STATS_CLAMP_EVENTS] ?? 0,
      bucketCount: this.bucketCount,
      instanceCount: this.scene.instanceCount,
      meshCount: this.scene.meshCount,
      droppedStems: this.scene.droppedStems,
      vertexBytes: this.scene.vertexBytes,
      indexBytes: this.scene.indexBytes,
      usesFlatGround: this.usesFlatGround,
      usesSubgroupScan: this.usesSubgroupScan,
      alphaStrategy: this.alphaStrategy,
      statsPending: !this.statsResolved,
    }
  }

  /**
   * Copy the tree indirect draw arguments back to the host. Not a per-frame path — it
   * submits its own command buffer and waits. Exists so the acceptance test can compare the
   * GPU's draw arguments against `runCullOracle`, which is the only way to check culling
   * without eyeballing a picture.
   */
  async readIndirectArgs(): Promise<Uint32Array> {
    return this.readBackBuffer(this.drawArgsBuffer, this.bucketCount * DRAW_INDEXED_ARGS_BYTES)
  }

  /** Same, for the per-band grass draw arguments. */
  async readGrassIndirectArgs(): Promise<Uint32Array> {
    return this.readBackBuffer(this.grassDrawArgsBuffer, Math.max(this.bands, 1) * DRAW_ARGS_BYTES)
  }

  /** Same, for the raw stats block. Bypasses the latency ring. */
  async readStats(): Promise<Uint32Array> {
    const control = await this.readBackBuffer(this.controlBuffer, STATS_BYTES)
    return control.subarray(CONTROL_OFF_STATS, CONTROL_OFF_STATS + STATS_U32S)
  }

  destroy(): void {
    const buffers = [
      this.vertexBuffer,
      this.indexBuffer,
      this.instanceBuffer,
      this.meshTableBuffer,
      this.materialParamsBuffer,
      this.controlBuffer,
      this.recordsBuffer,
      this.compactedBuffer,
      this.drawArgsBuffer,
      this.bucketUniformBuffer,
      this.grassUniformBuffer,
      this.tileListsBuffer,
      this.tileCountsBuffer,
      this.grassDrawArgsBuffer,
      this.bandUniformBuffer,
      this.frameUniformBuffer,
      this.cullUniformBuffer,
      ...this.readbackPool.map((r) => r.buffer),
    ]
    for (const b of buffers) b.destroy()
    if (this.ownsHeightTexture) this.heightTexture.destroy()
    if (this.ownsOcclusionTexture) this.occlusionTexture.destroy()
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private dispatchFor(itemCount: number, workgroupSize: number): { x: number; y: number; z: number } {
    const groups = Math.ceil(Math.max(itemCount, 0) / workgroupSize)
    const c = clampDispatch(Math.max(groups, 1), 1, 1, this.maxWorkgroups)
    return { x: c.x, y: c.y, z: c.z }
  }

  private writeUniforms(camera: CameraState, quality: QualitySettings): void {
    const cfg = this.config
    const f = new Float32Array(this.frameScratch)

    // Frustum planes. `CameraState.frustumPlanes` is trusted only if the caller opts in: the
    // contract fixes neither the plane order nor the sign convention, and getting either
    // wrong culls the entire world silently. Deriving them from the view-projection uses a
    // convention that IS pinned (cullMath.ts).
    if (cfg.useCameraFrustumPlanes && camera.frustumPlanes.length >= PLANE_FLOATS) {
      this.planes.set(camera.frustumPlanes.subarray(0, PLANE_FLOATS))
    } else {
      extractFrustumPlanes(this.planes, camera.viewProjMatrix as never)
    }

    f.set(camera.viewProjMatrix.subarray(0, 16), 0)
    f[16] = camera.position[0] as number
    f[17] = camera.position[1] as number
    f[18] = camera.position[2] as number
    f[19] = this.timeSec
    // Direction the wind blows towards, radians clockwise from north (+Z).
    f[20] = Math.sin(this.wind.directionRad as number)
    f[21] = Math.cos(this.wind.directionRad as number)
    f[22] = this.wind.speedMps
    f[23] = this.wind.gustiness
    f.set(this.planes, 24)
    f[48] = this.sunDir[0]
    f[49] = this.sunDir[1]
    f[50] = this.sunDir[2]
    f[51] = cfg.alphaCutoff
    f[52] = this.sunIrradiance[0]
    f[53] = this.sunIrradiance[1]
    f[54] = this.sunIrradiance[2]
    f[56] = this.skyIrradiance[0]
    f[57] = this.skyIrradiance[1]
    f[58] = this.skyIrradiance[2]
    this.device.queue.writeBuffer(this.frameUniformBuffer, 0, this.frameScratch)

    const cu = new Uint32Array(this.cullScratch)
    const cf = new Float32Array(this.cullScratch)
    cu[0] = this.scene.instanceCount
    cu[1] = this.bucketCount
    cu[2] = LOD_COUNT
    cu[3] = this.compactedCapacity
    cf[4] = cfg.lodThresholdsPx[0]
    cf[5] = cfg.lodThresholdsPx[1]
    cf[6] = cfg.lodThresholdsPx[2]
    cf[7] = 0
    cf[8] = cfg.lodFadeFraction
    cf[9] = pixelsPerMetreAtUnitDepth(
      cfg.viewportHeightPx,
      quality.resolutionScale,
      camera.verticalFov as number,
    )
    cf[10] = 1
    cf[11] = 0
    this.device.queue.writeBuffer(this.cullUniformBuffer, 0, this.cullScratch)

    if (this.grassEnabled) {
      const g = cfg.grass
      const gf = new Float32Array(this.grassScratch)
      const gu = new Uint32Array(this.grassScratch)
      const gi = new Int32Array(this.grassScratch)
      const tileSize = g.tileSizeM as number
      gf[0] = tileSize
      gf[1] = g.densityPerM2
      gf[2] = g.falloffStartM as number
      gf[3] = g.falloffEndM as number
      gu[4] = this.bands
      gu[5] = tileSpan(g)
      gu[6] = tileCapacityPerBand(g)
      gu[7] = domainTiles(g)
      gf[8] = g.bladeHeightM[0] as number
      gf[9] = g.bladeHeightM[1] as number
      gf[10] = g.bladeWidthM as number
      gf[11] = g.widthCompensation
      gf[12] = g.outerFadeFraction
      gi[13] = Math.floor((camera.position[0] as number) / tileSize)
      gi[14] = Math.floor((camera.position[2] as number) / tileSize)
      // Vertical slack on the tile bounding sphere: relief inside one tile is unknown here.
      gf[15] = tileSize
      for (let k = 0; k < 4; k++) {
        const edge = g.bandEdgesM[Math.min(k + 1, g.bandEdgesM.length - 1)]
        gf[16 + k] = edge === undefined ? 0 : (edge as number)
      }
      gu[20] = this.scene.grassLayer
      gf[21] = cfg.alphaCutoff
      gf[22] = 0
      gf[23] = 0
      this.device.queue.writeBuffer(this.grassUniformBuffer, 0, this.grassScratch)
    }
  }

  private makeBurnStateBindGroup(device: GPUDevice): GPUBindGroup {
    return device.createBindGroup({
      label: 'foliage.burnState',
      layout: this.burnStateLayout,
      entries: [
        { binding: 0, resource: { buffer: this.burnStateUniform } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
        { binding: 2, resource: { buffer: this.burnPeakBuffer } },
        { binding: 3, resource: this.intensityTexture.createView() },
      ],
    })
  }

  /**
   * Point the burn bindings at the fire solver's output.
   *
   * Called after the solver is built, which is after this renderer. Rebuilding three bind
   * groups is the whole cost — they are not per-frame objects, and the alternative (deferring
   * pipeline creation until the solver exists) would put the foliage pass behind the fire
   * pass in the boot order for no reason.
   */
  attachFire(consumed: GPUTexture, intensity: GPUTexture): void {
    this.consumedTexture = consumed
    this.intensityTexture = intensity
    const device = this.device
    const occlusionView = this.occlusionTexture.createView()
    this.treeBindGroup = device.createBindGroup({
      label: 'foliage.tree',
      layout: this.treeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.instanceBuffer } },
        { binding: 1, resource: { buffer: this.meshTableBuffer } },
        { binding: 2, resource: { buffer: this.compactedBuffer } },
        { binding: 3, resource: { buffer: this.controlBuffer } },
        { binding: 4, resource: { buffer: this.bucketUniformBuffer, size: 16 } },
        { binding: 5, resource: { buffer: this.materialParamsBuffer } },
        { binding: 6, resource: occlusionView },
        { binding: 7, resource: { buffer: this.burnPeakBuffer } },
        { binding: 8, resource: consumed.createView() },
      ],
    })
    this.grassDrawBindGroup = device.createBindGroup({
      label: 'foliage.grassDraw',
      layout: this.grassDrawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.grassUniformBuffer } },
        { binding: 1, resource: { buffer: this.tileListsBuffer } },
        { binding: 2, resource: { buffer: this.bandUniformBuffer, size: 16 } },
        { binding: 3, resource: this.heightTexture.createView() },
        { binding: 4, resource: occlusionView },
        { binding: 5, resource: consumed.createView() },
      ],
    })
    this.burnStateBindGroup = this.makeBurnStateBindGroup(device)
  }

  /**
   * Fold each stem's current fireline intensity into its remembered peak. One thread per
   * stem, so this is 36,700 threads and a texture fetch each — cheap enough to run every
   * frame rather than reason about when it could be skipped.
   */
  updateBurnState(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ label: 'foliage.burnState' })
    pass.setPipeline(this.burnStatePipeline)
    pass.setBindGroup(0, this.burnStateBindGroup)
    pass.dispatchWorkgroups(Math.ceil(this.scene.instanceCount / 64))
    pass.end()
  }

  /**
   * Dispatch the burn-state fold on an encoder of this renderer's own and submit it.
   * `?debug` only: the canopy prime run steps the solver without ever rendering a frame, so
   * without this the probe below would read a buffer nothing had written.
   */
  updateBurnStateNow(): void {
    const encoder = this.device.createCommandEncoder({ label: 'foliage.burnState.now' })
    this.updateBurnState(encoder)
    this.device.queue.submit([encoder.finish()])
  }

  /**
   * Read the per-stem burn memory back and describe it.
   *
   * "The shaders compiled and validation is clean" and "the burn coordinate is stuck at zero"
   * are indistinguishable without this, and only one of them is working. Reports the count of
   * stems that have stood in fire, and what char height that implies.
   */
  async burnReport(): Promise<string> {
    const bytes = Math.max(4, this.scene.instanceCount * 4)
    const staging = this.device.createBuffer({
      label: 'foliage.burnPeak.readback',
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = this.device.createCommandEncoder({ label: 'foliage.burnPeak.readback' })
    encoder.copyBufferToBuffer(this.burnPeakBuffer, 0, staging, 0, bytes)
    this.device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const peaks = new Uint32Array(staging.getMappedRange().slice(0))
    staging.unmap()
    staging.destroy()

    let touched = 0
    let maxRaw = 0
    let sum = 0
    for (let i = 0; i < this.scene.instanceCount; i++) {
      const v = peaks[i] as number
      if (v > 0) {
        touched++
        sum += v
      }
      if (v > maxRaw) maxRaw = v
    }
    const kwm = (raw: number): number => raw / BURN_PEAK_SCALE
    // Byram (1959), the same relation burnShade.wgsl uses.
    const charM = (i: number): number => (i > 0 ? 0.0775 * Math.pow(i, 0.46) : 0)
    const meanKwm = touched > 0 ? kwm(sum / touched) : 0
    return [
      `stems             ${this.scene.instanceCount}`,
      `stood in fire     ${touched} (${((touched / Math.max(1, this.scene.instanceCount)) * 100).toFixed(2)} %)`,
      `peak intensity    max ${kwm(maxRaw).toFixed(1)} kW/m, mean of burnt ${meanKwm.toFixed(1)} kW/m`,
      `implied char      max ${charM(kwm(maxRaw)).toFixed(2)} m up the stem, mean ${charM(meanKwm).toFixed(2)} m`,
      touched === 0
        ? 'ZERO — nothing has burned yet, or the intensity texture is not reaching this pass.'
        : 'stems remember the fire they stood in; the draw derives char height from this.',
    ].join(String.fromCharCode(10))
  }

  private collectReadbacks(): void {
    for (let i = this.pendingReadbacks.length - 1; i >= 0; i--) {
      const pending = this.pendingReadbacks[i]
      if (pending === undefined) continue
      if (this.frameIndex - pending.frame < this.config.statsLatencyFrames) continue
      this.pendingReadbacks.splice(i, 1)
      const entry = this.readbackPool[pending.index]
      if (entry === undefined) continue
      // Deliberately not awaited: the stats are diagnostics, and blocking a frame on them
      // would be worse than showing numbers that are three frames old.
      void entry.buffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.latestStats = new Uint32Array(entry.buffer.getMappedRange().slice(0))
          entry.buffer.unmap()
          this.statsResolved = true
        })
        .catch(() => {
          // A lost device or a destroyed buffer. Stats stop updating; rendering does not care.
        })
        .finally(() => {
          entry.busy = false
        })
    }
  }

  private async readBackBuffer(src: GPUBuffer, size: number): Promise<Uint32Array> {
    const bytes = Math.max(4, Math.ceil(size / 4) * 4)
    const dst = emptyBuffer(this.device, 'foliage.readback', bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
    const encoder = this.device.createCommandEncoder({ label: 'foliage.readback' })
    encoder.copyBufferToBuffer(src, 0, dst, 0, bytes)
    this.device.queue.submit([encoder.finish()])
    await dst.mapAsync(GPUMapMode.READ)
    const out = new Uint32Array(dst.getMappedRange().slice(0))
    dst.unmap()
    dst.destroy()
    return out
  }
}

export function createFoliageRenderer(opts: FoliageRendererOptions): FoliageRenderer {
  return new FoliageRenderer(opts)
}

/** 1x1 r8unorm of zero. "Nothing has burned", for before the fire solver exists. */
function zeroTexel(device: GPUDevice, label: string): GPUTexture {
  const tex = device.createTexture({
    label,
    size: { width: 1, height: 1 },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture({ texture: tex }, new Uint8Array([0]), { bytesPerRow: 1 }, { width: 1, height: 1 })
  return tex
}

/** 1x1 rgba8unorm filled with 1.0. A stand-in for an optional map, so a pipeline that wants
 *  one is always bindable and reads "nothing is occluded" when nothing supplies it. */
function whiteTexel(device: GPUDevice, label: string): GPUTexture {
  const tex = device.createTexture({
    label,
    size: { width: 1, height: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture({ texture: tex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, { width: 1, height: 1 })
  return tex
}
