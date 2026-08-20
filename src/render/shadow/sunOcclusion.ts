/**
 * Sun occlusion — Phase 3 rung 1.
 *
 * Nothing in this scene occluded sunlight. Sunlit and canopy-shaded ground rendered
 * identically, which is most of what makes a forest read as three-dimensional; spec §7.9
 * budgets 2.20 ms for terrain plus shadow cascades and none of it existed.
 *
 * This is not cascades. It is a 1024² top-down visibility map over the domain — one texel per
 * metre — built from two things that are already GPU-resident: the tree instance buffer, and
 * the terrain height texture. Terrain, grass and tree shaders multiply their direct term by
 * it. See `shaders/render/shadow/sunOcclusion.wgsl` for what the approximation does and does
 * not cover, and for why canopy and terrain occlusion live in separate channels.
 *
 * The cost that matters is that it is **not per frame**. `update()` is a no-op until the sun
 * has moved further than {@link SUN_REBUILD_RADIANS}, so a static sun pays for this once.
 */

import sunOcclusionWgsl from '../../../shaders/render/shadow/sunOcclusion.wgsl?raw'
import commonWgsl from '../../../shaders/foliage/common.wgsl?raw'
import { foliagePrelude } from '@render/foliage/shaderPrelude.ts'
import { DOMAIN_SIZE_M } from '@contracts/world'

/** Texels per axis. One per metre over a 1024 m domain. */
export const OCCLUSION_TEXELS = 1024

/**
 * How far the sun must move before the map is rebuilt. 0.25° is about a minute of real time,
 * and at this resolution a quarter of a degree moves a 30 m tree's shadow by well under a
 * texel.
 */
export const SUN_REBUILD_RADIANS = (0.25 * Math.PI) / 180

/** Steps in the terrain ray-march. Geometric, so these reach much further than they suggest. */
const TERRAIN_MARCH_STEPS = 32
/** How far the march looks for a ridge. The domain's relief is ~140 m; at a low sun that
 *  casts a shadow a couple of hundred metres long, and nothing casts one further. */
const TERRAIN_MARCH_REACH_M = 260

/**
 * Opacity of a single crown at its centre. Authored — this is a rendering approximation, not
 * a physical model, so it carries no provenance and claims none. It stands in for the
 * Beer–Lambert extinction through a crown that WP 3.3 already computes properly for
 * radiation; wiring that in would mean sampling the canopy voxel store per texel, which is a
 * much larger job than this rung. 0.8 leaves a closed canopy floor at 20% of full sun, which
 * is the right order for a closed conifer stand.
 */
const CANOPY_OPACITY = 0.8

const UNIFORM_BYTES = 48

/**
 * The output texture, created separately from the pass.
 *
 * Everything that *samples* the map — terrain, grass, trees — must bind it when its own
 * pipeline is built, and the pass itself cannot be built until the foliage renderer exists
 * (it reads that renderer's instance buffer). So the texture comes first and is handed to
 * both sides.
 */
export function createOcclusionTexture(device: GPUDevice): GPUTexture {
  return device.createTexture({
    label: 'sun-occlusion',
    size: { width: OCCLUSION_TEXELS, height: OCCLUSION_TEXELS },
    // rgba8unorm rather than r8unorm: r8unorm as a storage format needs the optional
    // `texture-formats-tier1` feature, and the second channel is wanted anyway.
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  })
}

export interface SunOcclusionInit {
  readonly device: GPUDevice
  readonly texture: GPUTexture
  /** The foliage package's packed instance buffer. Read-only here. */
  readonly instances: GPUBuffer
  readonly instanceCount: number
  readonly heightTexture: GPUTexture
}

export class SunOcclusion {
  readonly texture: GPUTexture
  readonly view: GPUTextureView

  readonly #device: GPUDevice
  readonly #uniform: GPUBuffer
  readonly #accum: GPUBuffer
  readonly #bindGroup: GPUBindGroup
  readonly #discs: GPUComputePipeline
  readonly #resolve: GPUComputePipeline
  readonly #instanceCount: number
  readonly #scratch = new ArrayBuffer(UNIFORM_BYTES)

  /** Last sun vector the map was built for, or null if it has never been built. */
  #builtFor: readonly [number, number, number] | null = null
  #rebuilds = 0

  private constructor(parts: {
    device: GPUDevice
    texture: GPUTexture
    uniform: GPUBuffer
    accum: GPUBuffer
    bindGroup: GPUBindGroup
    discs: GPUComputePipeline
    resolve: GPUComputePipeline
    instanceCount: number
  }) {
    this.#device = parts.device
    this.texture = parts.texture
    this.view = parts.texture.createView()
    this.#uniform = parts.uniform
    this.#accum = parts.accum
    this.#bindGroup = parts.bindGroup
    this.#discs = parts.discs
    this.#resolve = parts.resolve
    this.#instanceCount = parts.instanceCount
  }

  static async create(init: SunOcclusionInit): Promise<SunOcclusion> {
    const { device } = init

    const texture = init.texture

    const uniform = device.createBuffer({
      label: 'sun-occlusion.uniform',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Storage textures cannot be atomically written in WebGPU, so the crown discs accumulate
    // into a plain buffer and `csResolve` copies the result into the texture.
    const accum = device.createBuffer({
      label: 'sun-occlusion.accum',
      size: OCCLUSION_TEXELS * OCCLUSION_TEXELS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    const bindGroupLayout = device.createBindGroupLayout({
      label: 'sun-occlusion.bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', minBindingSize: UNIFORM_BYTES },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          // textureLoad only, so `unfilterable-float` — the height texture is r32float and
          // this must not depend on the optional `float32-filterable` feature.
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
      ],
    })

    const bindGroup = device.createBindGroup({
      label: 'sun-occlusion.bg',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: init.instances } },
        { binding: 2, resource: { buffer: accum } },
        { binding: 3, resource: init.heightTexture.createView() },
        { binding: 4, resource: texture.createView() },
      ],
    })

    // `common.wgsl` supplies `TreeInstance` and `terrainHeightAt`. It declares no bindings —
    // the frame block lives in `frameBindings.wgsl` precisely so this pass can share the
    // struct without inheriting the foliage package's group 0.
    // The prelude comes along because `common.wgsl` is written against it — it is the
    // generated constant block, so taking it whole is how the struct layouts stay one
    // definition instead of two. The subgroup and dither flags are irrelevant here; nothing
    // this module compiles reads them.
    const code = [
      foliagePrelude({ useSubgroups: false, ditherAlpha: false }),
      commonWgsl,
      sunOcclusionWgsl,
    ].join('\n\n')
    const module = device.createShaderModule({ label: 'sunOcclusion', code })

    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })
    const [discs, resolve] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'sun-occlusion.discs',
        layout,
        compute: { module, entryPoint: 'csDiscs' },
      }),
      device.createComputePipelineAsync({
        label: 'sun-occlusion.resolve',
        layout,
        compute: { module, entryPoint: 'csResolve' },
      }),
    ])

    return new SunOcclusion({
      device,
      texture,
      uniform,
      accum,
      bindGroup,
      discs,
      resolve,
      instanceCount: init.instanceCount,
    })
  }

  /** Rebuilds so far. `?debug` reports it — a map that rebuilds every frame is a bug. */
  get rebuilds(): number {
    return this.#rebuilds
  }

  /**
   * Rebuild if the sun has moved far enough to matter.
   *
   * @param sunToward unit vector TOWARDS the sun, the same one the terrain uniform carries.
   * @returns whether work was encoded.
   */
  update(encoder: GPUCommandEncoder, sunToward: readonly [number, number, number]): boolean {
    if (!this.#needsRebuild(sunToward)) return false
    this.#builtFor = [sunToward[0], sunToward[1], sunToward[2]]
    this.#rebuilds++

    const f = new Float32Array(this.#scratch)
    const u = new Uint32Array(this.#scratch)
    f[0] = sunToward[0]
    f[1] = sunToward[1]
    f[2] = sunToward[2]
    f[3] = TERRAIN_MARCH_STEPS
    f[4] = DOMAIN_SIZE_M
    f[5] = OCCLUSION_TEXELS
    f[6] = CANOPY_OPACITY
    f[7] = TERRAIN_MARCH_REACH_M
    u[8] = this.#instanceCount
    this.#device.queue.writeBuffer(this.#uniform, 0, this.#scratch)

    // atomicMax against 0 means "no occluder", so a plain clear is the whole reset. Using the
    // encoder's own clear rather than a compute pass keeps this at two pipelines.
    encoder.clearBuffer(this.#accum)

    const discs = encoder.beginComputePass({ label: 'sun-occlusion.discs' })
    discs.setPipeline(this.#discs)
    discs.setBindGroup(0, this.#bindGroup)
    discs.dispatchWorkgroups(Math.ceil(this.#instanceCount / 64))
    discs.end()

    const resolve = encoder.beginComputePass({ label: 'sun-occlusion.resolve' })
    resolve.setPipeline(this.#resolve)
    resolve.setBindGroup(0, this.#bindGroup)
    const groups = Math.ceil(OCCLUSION_TEXELS / 8)
    resolve.dispatchWorkgroups(groups, groups)
    resolve.end()
    return true
  }

  #needsRebuild(sun: readonly [number, number, number]): boolean {
    const previous = this.#builtFor
    if (previous === null) return true
    // Both are unit vectors, so the dot product is the cosine of the angle between them.
    const cos = previous[0] * sun[0] + previous[1] * sun[1] + previous[2] * sun[2]
    return Math.acos(Math.min(1, Math.max(-1, cos))) > SUN_REBUILD_RADIANS
  }

  /**
   * Read the map back and describe it. `?debug` prints this, because "the ground looks a bit
   * dark" and "the canopy term is stuck at zero" are indistinguishable by eye and completely
   * different bugs. A map that is uniformly 1.0 means nothing occluded; uniformly 0.0 means
   * the dispatch never ran or the sun is below the horizon.
   */
  /**
   * Build on an encoder of this pass's own and submit it. Only for `?debug`: the frame path
   * folds the update into the frame's encoder so it costs no extra submit.
   */
  buildNow(sunToward: readonly [number, number, number]): void {
    const encoder = this.#device.createCommandEncoder({ label: 'sun-occlusion.buildNow' })
    this.#builtFor = null
    this.update(encoder, sunToward)
    this.#device.queue.submit([encoder.finish()])
  }

  async report(): Promise<string> {
    const bytesPerRow = OCCLUSION_TEXELS * 4
    const staging = this.#device.createBuffer({
      label: 'sun-occlusion.readback',
      size: bytesPerRow * OCCLUSION_TEXELS,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = this.#device.createCommandEncoder({ label: 'sun-occlusion.readback' })
    encoder.copyTextureToBuffer(
      { texture: this.texture },
      { buffer: staging, bytesPerRow, rowsPerImage: OCCLUSION_TEXELS },
      { width: OCCLUSION_TEXELS, height: OCCLUSION_TEXELS },
    )
    this.#device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const px = new Uint8Array(staging.getMappedRange().slice(0))
    staging.unmap()
    staging.destroy()

    const total = OCCLUSION_TEXELS * OCCLUSION_TEXELS
    let canopySum = 0
    let ridgeSum = 0
    let canopyShaded = 0
    let ridgeShaded = 0
    let minCanopy = 255
    for (let i = 0; i < total; i++) {
      const c = px[i * 4] as number
      const r = px[i * 4 + 1] as number
      canopySum += c
      ridgeSum += r
      if (c < 250) canopyShaded++
      if (r < 250) ridgeShaded++
      if (c < minCanopy) minCanopy = c
    }
    const pc = (n: number): string => `${((n / total) * 100).toFixed(1)} %`
    return [
      `rebuilds          ${this.#rebuilds} (rebuilds every frame would be a bug)`,
      `canopy mean       ${(canopySum / total / 255).toFixed(3)} visibility, min ${(minCanopy / 255).toFixed(3)}`,
      `canopy shaded     ${pc(canopyShaded)} of the domain under a crown`,
      `ridge mean        ${(ridgeSum / total / 255).toFixed(3)} visibility`,
      `ridge shaded      ${pc(ridgeShaded)} of the domain behind a ridge`,
      `instances         ${this.#instanceCount} crowns rasterised`,
    ].join(String.fromCharCode(10))
  }

  destroy(): void {
    this.texture.destroy()
    this.#uniform.destroy()
    this.#accum.destroy()
  }
}
