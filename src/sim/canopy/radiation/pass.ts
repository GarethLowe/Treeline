/**
 * GPU resources and compute passes for canopy radiative transfer (WP 3.3).
 *
 * Four dispatches, run once every `RAD_UPDATE_INTERVAL_S` (7.5 Hz), not every substep:
 *
 *   extinction  once at world build (LAD is static, §7.2 pool B) — NOT in the per-step path
 *   scatter     emitter samples -> 16 m bins, u32 atomics
 *   compact     bins -> capped cluster list
 *   finalise    one thread: overflow catch-all + threshold retune
 *   gather      one workgroup per active brick: the actual transport solve
 *
 * ## What this package does NOT own
 *
 * The **emitter sample buffer** is appended to by whoever already iterates the active set —
 * the surface solver for flame panels, the canopy thermal pass for flaming voxels. That is
 * the right seam: those passes already have the state loaded, and an emitter record is 32
 * bytes. `emitters.ts` provides the CPU functions that produce the record contents and
 * `RAD_EMITTER_BYTES` fixes the layout.
 *
 * The **brick list** and the **LAD/clumping textures** come from WP 3.1. This code assumes
 * the §7.2 indirection grid is 64x64x8 in `i + j*64 + k*64*64` order with k vertical; if
 * WP 3.1 orders it differently, `BRICK_NI/NJ/NK` and the decode in `gather.wgsl` are the two
 * places to change and nothing else moves.
 */

import {
  CLUSTER_STATE_SLOTS,
  CLUSTER_WORKGROUP,
  EMIT_CLUSTER_CAP,
  EMIT_GRID_CELLS,
  EMIT_SLOTS,
  MIN_RAY_COUNT,
  RAD_NI,
  RAD_NJ,
  RAD_NK,
  RAD_TEXTURE_FORMAT,
} from './layout.ts'
import { DEFAULT_SHADER_OPTIONS, MAX_RAY_COUNT, buildRadiationShaders } from './shaders.ts'
import type { RadiationShaderOptions } from './shaders.ts'

/** Bytes per emitter sample: vec4(x, y, z, powerW) + vec4(radiusM, pad, pad, pad). */
export const RAD_EMITTER_BYTES = 32
/** Bytes per compacted cluster: vec4(x, y, z, powerW) + vec4(a2, pad, pad, pad). */
export const RAD_CLUSTER_BYTES = 32

/** Everything WP 3.3 needs from its neighbours. All GPU-side; nothing is read back. */
export interface RadiationInputs {
  /** `RAD_EMITTER_BYTES` per record, written by the surface and canopy passes. */
  readonly emitters: GPUBuffer
  /**
   * How many records in `emitters` are live. Ignored when `emitterCount` is supplied on the
   * GPU via {@link RadiationInputs.emitterCountBuffer}, which is the composed path.
   */
  readonly emitterCount: number
  /**
   * The count as the GPU wrote it, plus indirect dispatch args, from `SurfaceEmitterPass`.
   *
   * When present the scatter is dispatched indirectly and the count is copied device-side
   * into the cluster params, so the dispatch size and the buffer contents are guaranteed to
   * describe the same instant. Reading the count back to the CPU instead would put a
   * simulation step between them: too low silently drops fire, too high makes the scatter
   * re-read the previous step's records and invent energy that is no longer burning.
   */
  readonly emitterCountBuffer?: GPUBuffer
  /** Byte offset of the `dispatchWorkgroupsIndirect` args inside `emitterCountBuffer`. */
  readonly emitterArgsOffset?: number
  /** WP 3.1's compacted active-brick list (indirection-grid indices). */
  readonly brickList: GPUBuffer
  readonly brickCount: number
}

export interface ExtinctionSources {
  /** 512x512x64 r16float, LAD in m^2 m^-3. */
  readonly lad: GPUTexture
  /** 512x512x64 r8unorm, clumping index Omega_c in [0, 1]. */
  readonly clumping: GPUTexture
}

export class CanopyRadiation {
  /** kW m^-2, 4 m grid. Sample this and feed `absorbedSource()` from `optics.ts`. */
  readonly irradiance: GPUTexture
  /** m^-1, 4 m grid. Static after `buildExtinction`. */
  readonly extinction: GPUTexture

  private readonly shaderOptions: RadiationShaderOptions
  private readonly device: GPUDevice
  private clusterBindGroupLayout: GPUBindGroupLayout | null = null
  private readonly sampler: GPUSampler
  private readonly bins: GPUBuffer
  private readonly clusters: GPUBuffer
  private readonly state: GPUBuffer
  private readonly clusterParams: GPUBuffer
  private readonly gatherParams: GPUBuffer
  private pipelines: {
    extinction: GPUComputePipeline
    scatter: GPUComputePipeline
    compact: GPUComputePipeline
    finalise: GPUComputePipeline
    gather: GPUComputePipeline
  } | null = null

  constructor(device: GPUDevice, opts: Partial<RadiationShaderOptions> = {}) {
    this.device = device
    const o: RadiationShaderOptions = { ...DEFAULT_SHADER_OPTIONS, ...opts }
    this.shaderOptions = o

    const tex = (label: string): GPUTexture =>
      device.createTexture({
        label: `radiation.${label}`,
        dimension: '3d',
        size: { width: RAD_NI, height: RAD_NJ, depthOrArrayLayers: RAD_NK },
        format: RAD_TEXTURE_FORMAT,
        // COPY_DST for `uploadExtinction`, which writes the CPU-built field straight in;
        // COPY_SRC so the `?debug` probe can read the irradiance back and prove the gather
        // produced something. Both omitted originally because neither path existed.
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      })
    this.irradiance = tex('irradiance')
    this.extinction = tex('extinction')

    // Clamp-to-edge and linear: the transmittance march relies on both. Clamping above the
    // canopy is the same as returning zero because the top layer is air.
    this.sampler = device.createSampler({
      label: 'radiation.extinction',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    })

    const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    this.bins = device.createBuffer({
      label: 'radiation.bins',
      size: EMIT_GRID_CELLS * EMIT_SLOTS * 4,
      usage: STORAGE,
    })
    this.clusters = device.createBuffer({
      label: 'radiation.clusters',
      size: EMIT_CLUSTER_CAP * RAD_CLUSTER_BYTES,
      usage: STORAGE,
    })
    this.state = device.createBuffer({
      label: 'radiation.clusterState',
      size: CLUSTER_STATE_SLOTS * 4,
      usage: STORAGE,
    })
    const uniform = (label: string): GPUBuffer =>
      device.createBuffer({
        label: `radiation.${label}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
    this.clusterParams = uniform('clusterParams')
    this.gatherParams = uniform('gatherParams')
  }

  /**
   * Compile every pipeline up front. §6.8 pitfall 7: Dawn compiles lazily, so the first
   * ignition would otherwise stall for a couple of hundred milliseconds while the radiation
   * pipelines build.
   */
  async compile(): Promise<void> {
    const src = buildRadiationShaders(this.shaderOptions)
    const mod = (label: string, code: string): GPUShaderModule =>
      this.device.createShaderModule({ label: `radiation.${label}`, code })
    const extinction = mod('extinction', src.extinction)
    const clusters = mod('clusters', src.clusters)
    const gather = mod('gather', src.gather)

    // The three cluster entry points need an EXPLICIT layout, not `auto`. `auto` derives the
    // layout from the bindings each entry point actually uses, and these three use different
    // subsets — scatter never touches the cluster buffer, compact never touches the sample
    // buffer — so `auto` would give three incompatible layouts and one bind group could not
    // be shared across them.
    this.clusterBindGroupLayout = this.device.createBindGroupLayout({
      label: 'radiation.clusters',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    })
    const clusterLayout = this.device.createPipelineLayout({
      label: 'radiation.clusters',
      bindGroupLayouts: [this.clusterBindGroupLayout],
    })

    const make = (
      label: string,
      module: GPUShaderModule,
      entryPoint: string,
      layout: GPUPipelineLayout | 'auto',
    ) =>
      this.device.createComputePipelineAsync({
        label: `radiation.${label}`,
        layout,
        compute: { module, entryPoint },
      })
    const [e, s, c, f, g] = await Promise.all([
      make('extinction', extinction, 'main', 'auto'),
      make('scatter', clusters, 'scatter', clusterLayout),
      make('compact', clusters, 'compact', clusterLayout),
      make('finalise', clusters, 'finalise', clusterLayout),
      make('gather', gather, 'main', 'auto'),
    ])
    this.pipelines = { extinction: e, scatter: s, compact: c, finalise: f, gather: g }
  }

  /**
   * Write a precomputed extinction field straight into the texture.
   *
   * The alternative is {@link buildExtinction}, which needs dense 2 m LAD and clumping
   * textures — 48 MiB of 3D textures materialised purely to be read once. kappa is LINEAR in
   * LAD (see extinction.wgsl), so averaging on the CPU from `CanopyFields`, which already
   * holds LAD per voxel, is the identical field for 4 MiB and no pass. Use `buildExtinction`
   * when the canopy changes at runtime and the data is already on the device.
   *
   * `kappa` is `RAD_NI * RAD_NJ * RAD_NK` binary16 values, x fastest then y then z.
   */
  uploadExtinction(kappa: Uint16Array<ArrayBuffer>): void {
    const want = RAD_NI * RAD_NJ * RAD_NK
    if (kappa.length !== want) {
      throw new Error(`uploadExtinction: expected ${want} values, got ${kappa.length}`)
    }
    this.device.queue.writeTexture(
      { texture: this.extinction },
      kappa,
      { bytesPerRow: RAD_NI * 2, rowsPerImage: RAD_NJ },
      { width: RAD_NI, height: RAD_NJ, depthOrArrayLayers: RAD_NK },
    )
  }

  /** Run once at world build, and again only if consumption has changed LAD materially. */
  buildExtinction(encoder: GPUCommandEncoder, sources: ExtinctionSources): void {
    const p = this.requirePipelines()
    const bg = this.device.createBindGroup({
      layout: p.extinction.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sources.lad.createView() },
        { binding: 1, resource: sources.clumping.createView() },
        { binding: 2, resource: this.extinction.createView() },
      ],
    })
    const pass = encoder.beginComputePass({ label: 'radiation.extinction' })
    pass.setPipeline(p.extinction)
    pass.setBindGroup(0, bg)
    pass.dispatchWorkgroups(Math.ceil(RAD_NI / 4), Math.ceil(RAD_NJ / 4), Math.ceil(RAD_NK / 4))
    pass.end()
  }

  /**
   * One radiation solve. Call at `RAD_UPDATE_HZ`, not every substep — the field's physical
   * timescale is minutes (§7.5), so 133 ms of staleness costs 1.3% at 20 m.
   *
   * `minBinUnits` is fed back from the previous step's `finalise`; the caller does not have
   * to manage it, but it does have to not clear the state buffer's threshold slot, so the
   * clears below are per-slot rather than a whole-buffer wipe.
   */
  encode(encoder: GPUCommandEncoder, inputs: RadiationInputs, rayCount = MIN_RAY_COUNT): void {
    const p = this.requirePipelines()
    const rays = Math.max(MIN_RAY_COUNT, Math.min(MAX_RAY_COUNT, Math.trunc(rayCount)))

    encoder.clearBuffer(this.bins)
    // Slots 0-2 (count, overflowBins, overflowPower) reset; slot 3 (threshold) persists.
    // The cluster list itself needs no clear: the gather reads the live count out of slot 0
    // on the GPU, so stale entries past it are never touched and the CPU never has to know
    // how many clusters were produced.
    encoder.clearBuffer(this.state, 0, 12)

    if (inputs.emitterCountBuffer === undefined) {
      this.device.queue.writeBuffer(
        this.clusterParams,
        0,
        new Uint32Array([inputs.emitterCount, 0, 0, 0]),
      )
    } else {
      // Slot 0 only. `minBinUnits` at offset 4 is the threshold `finalise()` retunes and must
      // not be stomped.
      encoder.copyBufferToBuffer(inputs.emitterCountBuffer, 0, this.clusterParams, 0, 4)
    }
    this.device.queue.writeBuffer(
      this.gatherParams,
      0,
      new Uint32Array([rays, inputs.brickCount, 0, 0]),
    )

    const clusterBg = this.device.createBindGroup({
      layout: this.requireClusterLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.clusterParams } },
        { binding: 1, resource: { buffer: inputs.emitters } },
        { binding: 2, resource: { buffer: this.bins } },
        { binding: 3, resource: { buffer: this.clusters } },
        { binding: 4, resource: { buffer: this.state } },
      ],
    })

    // scatter -> compact -> finalise are true RAW hazards and need their own passes (§6.3).
    const dispatch = (
      label: string,
      pipeline: GPUComputePipeline,
      bg: GPUBindGroup,
      groups: number,
    ): void => {
      const pass = encoder.beginComputePass({ label: `radiation.${label}` })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bg)
      pass.dispatchWorkgroups(groups)
      pass.end()
    }
    if (inputs.emitterCountBuffer === undefined) {
      dispatch(
        'scatter',
        p.scatter,
        clusterBg,
        Math.max(1, Math.ceil(inputs.emitterCount / CLUSTER_WORKGROUP)),
      )
    } else {
      const pass = encoder.beginComputePass({ label: 'radiation.scatter' })
      pass.setPipeline(p.scatter)
      pass.setBindGroup(0, clusterBg)
      pass.dispatchWorkgroupsIndirect(inputs.emitterCountBuffer, inputs.emitterArgsOffset ?? 4)
      pass.end()
    }
    dispatch('compact', p.compact, clusterBg, Math.ceil(EMIT_GRID_CELLS / CLUSTER_WORKGROUP))
    dispatch('finalise', p.finalise, clusterBg, 1)

    const gatherBg = this.device.createBindGroup({
      layout: p.gather.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.gatherParams } },
        { binding: 1, resource: { buffer: this.clusters } },
        { binding: 2, resource: { buffer: inputs.brickList } },
        { binding: 3, resource: this.extinction.createView() },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: this.irradiance.createView() },
        { binding: 6, resource: { buffer: this.state } },
      ],
    })
    dispatch('gather', p.gather, gatherBg, Math.max(1, inputs.brickCount))
  }

  destroy(): void {
    this.irradiance.destroy()
    this.extinction.destroy()
    this.bins.destroy()
    this.clusters.destroy()
    this.state.destroy()
    this.clusterParams.destroy()
    this.gatherParams.destroy()
  }

  private requirePipelines(): NonNullable<CanopyRadiation['pipelines']> {
    if (this.pipelines === null) throw new Error('CanopyRadiation.compile() has not completed')
    return this.pipelines
  }

  private requireClusterLayout(): GPUBindGroupLayout {
    if (this.clusterBindGroupLayout === null) {
      throw new Error('CanopyRadiation.compile() has not completed')
    }
    return this.clusterBindGroupLayout
  }
}
