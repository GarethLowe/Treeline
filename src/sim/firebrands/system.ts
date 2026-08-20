/**
 * `IFirebrandSystem` on the GPU — WP 3.6.
 *
 * Two pipelines, two dispatches per solver step. Kept in a module of its own and imported by
 * nothing that runs under Vitest, so `brands.ts`, `albini.ts` and `layout.ts` stay testable on
 * the CLI without a device. This file is plumbing; the correctness lives next door.
 *
 * ## Update rate, and why it is not 60 Hz
 *
 * Brands step at the **solver rate**, once per sim step (~2-10 Hz on the 0.5 s CFL step of the
 * 0.5 m grid), not once per rendered frame. Inside one step the shader loops `subSteps`
 * substeps internally at <= 0.1 s each. That is the §0.5.1 amortisation lever applied where it
 * actually pays: the fluid field a brand samples changes on the plume's timescale, so the
 * substep is set by how far a brand moves between samples (0.1 s at 20 m/s is 2 m — one canopy
 * voxel), while the *dispatch* count, which is what this pass actually costs, drops by 6-30x
 * against a per-frame design. The exponential integrator is unconditionally stable, so nothing
 * about this is a stability compromise; the accepted error is the fluid field being frozen for
 * 2 m of travel.
 *
 * ## Cost
 *
 * REASONED, not measured — no WebGPU device was available in this work package's environment.
 * §4.4's own open question says the honest bound is per-dispatch and barrier overhead rather
 * than per-brand work, at roughly 7 us of command overhead per dispatch. Two dispatches at
 * ~2-10 Hz is 0.03-0.14 ms per SECOND of wall time, i.e. under 0.01% of the frame budget, and
 * the per-brand work (131k threads, one 3D fetch, ~150 ALU, one exp per substep) is the part
 * that will not show up. {@link FirebrandSystem.timestampQueries} exists so the claim can be
 * settled: run the pass at 10k / 100k / 131k brands and if the three land within noise of each
 * other, §4.4's table should be restated as a per-dispatch budget.
 */

import { rawBuffer } from '@gpu/raw.ts'
import type { IFireOutputs, FirebrandStats } from '@contracts/sim'
import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/sim'
import type { Seconds } from '@contracts/units'
import { m as metres } from '@contracts/units'
import WGSL from '../../../shaders/sim/firebrands/firebrands.wgsl?raw'
import { BRAND_CLASSES, DEFAULT_IGNITION_COEFFS } from './brands.ts'
import type { BrandClass, IgnitionCoeffs } from './brands.ts'
import {
  BRAND_POOL,
  BRAND_STRIDE_BYTES,
  CLASS_STRIDE_F32,
  EMITTER_STRIDE_F32,
  INTEGRATE_WORKGROUP,
  MAX_EMITTERS,
  packBrandClasses,
} from './layout.ts'
/**
 * One firebrand source. Positions are world metres; `massLossRate` is kg/s of fuel leaving the
 * solid, which is what sets the generation rate.
 */
export interface StubEmitter {
  readonly pos: readonly [number, number, number]
  readonly massLossRate: number
  /** Index into {@link FirebrandSystem.classes}. */
  readonly classIndex: number
  /** Per-emitter multiplier on the brand yield. */
  readonly yieldMul: number
}

export { WGSL as FIREBRANDS_WGSL }

/** `f32`/`u32` slots in `struct Params`; see the shader for the offsets. */
const PARAMS_SLOTS = 32
const PARAMS_BYTES = PARAMS_SLOTS * 4
/** `struct SimState` slots. */
const STATE_SLOTS = 10
const STATE_BYTES = STATE_SLOTS * 4

const S_CURSOR = 0
const S_HIGHWATER = 1
const S_WEIGHT = 2
const S_SPAWNED = 3
const S_AIRBORNE = 4
const S_AIRBORNE_WT = 5
const S_LANDED = 6
const S_IGNITIONS = 7
const S_MAX_SPOT_MM = 8
const S_EXITED = 9

export interface FirebrandSystemOptions {
  /** Domain origin, m. Defaults to (0,0,0). */
  readonly domainMin?: readonly [number, number, number]
  /** Domain extent, m. Defaults to the 1 km x 1 km x 128 m sim domain. */
  readonly domainSize?: readonly [number, number, number]
  /** Height covered by the plume velocity texture, m. */
  readonly windTop?: number
  /**
   * WP 3.4's downsampled canopy velocity field, rgba16float 3D. A 1x1x1 zero texture stands in
   * until it exists — the brands then fly on the analytic ambient profile alone, which is the
   * right degradation: no plume means no lofting, not a crash.
   */
  readonly windTexture?: GPUTexture
  readonly classes?: readonly BrandClass[]
  readonly ignition?: IgnitionCoeffs
  /** Substeps per solver step. dt/subSteps should stay at or below ~0.1 s. */
  readonly subSteps?: number
}

const DEFAULT_CLASSES: readonly BrandClass[] = Object.values(BRAND_CLASSES)

export class FirebrandSystem {
  readonly classes: readonly BrandClass[]

  stats: FirebrandStats = {
    airborne: 0,
    landed: 0,
    ignitionsCaused: 0,
    maxSpotDistanceM: metres(0),
  }

  /** Set true once the caller has a `timestamp-query` writeset attached; see the header. */
  timestampQueries = false

  private readonly device: GPUDevice
  private readonly params: GPUBuffer
  private readonly brands: GPUBuffer
  private readonly classBuffer: GPUBuffer
  private readonly emitterBuffer: GPUBuffer
  private readonly state: GPUBuffer
  private readonly indirect: GPUBuffer
  private readonly staging: GPUBuffer
  /** One bit per surface cell. WP 2.3 consumes it as new ignitions; 512 KB at 2048². */
  readonly ignitionMask: GPUBuffer
  private readonly bindGroup: GPUBindGroup
  private readonly indirectGroup: GPUBindGroup
  private readonly spawnPipeline: GPUComputePipeline
  private readonly integratePipeline: GPUComputePipeline
  private readonly ownedTexture: GPUTexture | undefined
  private readonly paramData = new Float32Array(PARAMS_SLOTS)
  private readonly paramU32 = new Uint32Array(rawBuffer(this.paramData))
  private readonly lastState = new Uint32Array(STATE_SLOTS)
  private emitterCount = 0
  private frameIndex = 0
  private reading = false

  constructor(device: GPUDevice, options: FirebrandSystemOptions = {}) {
    this.device = device
    this.classes = options.classes ?? DEFAULT_CLASSES

    const storage = GPUBufferUsage.STORAGE
    const mk = (size: number, usage: number, label: string): GPUBuffer =>
      device.createBuffer({ size, usage, label })

    this.params = mk(PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'brand-params')
    this.brands = mk(BRAND_POOL * BRAND_STRIDE_BYTES, storage | GPUBufferUsage.COPY_DST, 'brands')
    this.classBuffer = mk(
      Math.max(this.classes.length, 1) * CLASS_STRIDE_F32 * 4,
      storage | GPUBufferUsage.COPY_DST,
      'brand-classes',
    )
    this.emitterBuffer = mk(
      MAX_EMITTERS * EMITTER_STRIDE_F32 * 4,
      storage | GPUBufferUsage.COPY_DST,
      'brand-emitters',
    )
    this.state = mk(STATE_BYTES, storage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, 'brand-state')
    this.indirect = mk(12, storage | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, 'brand-indirect')
    this.ignitionMask = mk(
      ((SURFACE_CELLS * SURFACE_CELLS) / 8) | 0,
      storage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      'brand-ignitions',
    )
    this.staging = mk(STATE_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, 'brand-stats')

    device.queue.writeBuffer(this.classBuffer, 0, rawBuffer(packBrandClasses([...this.classes])))
    // weight starts at 1; everything else at zero. The first `integrate` runs over nothing.
    const s0 = new Uint32Array(STATE_SLOTS)
    s0[S_WEIGHT] = 1
    device.queue.writeBuffer(this.state, 0, rawBuffer(s0))
    device.queue.writeBuffer(this.indirect, 0, rawBuffer(new Uint32Array([0, 1, 1])))

    let texture = options.windTexture
    if (!texture) {
      texture = device.createTexture({
        size: [1, 1, 1],
        dimension: '3d',
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: 'brand-wind-placeholder',
      })
      this.ownedTexture = texture
      device.queue.writeTexture(
        { texture },
        new Uint16Array(4),
        { bytesPerRow: 8, rowsPerImage: 1 },
        [1, 1, 1],
      )
    } else {
      this.ownedTexture = undefined
    }

    // Explicit layouts, not `layout: 'auto'`: an auto layout is unique per pipeline, so a bind
    // group built for one is not usable with the other and the whole pass would fail validation
    // at the second setPipeline. The two layouts share group 0 by construction, and only
    // `spawn_step` gets group 1 (the indirect args it writes).
    const buf = (
      binding: number,
      type: GPUBufferBindingType,
    ): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    })
    const group0 = device.createBindGroupLayout({
      entries: [
        buf(0, 'uniform'),
        buf(1, 'storage'),
        buf(2, 'read-only-storage'),
        buf(3, 'read-only-storage'),
        buf(4, 'storage'),
        buf(6, 'storage'),
        {
          binding: 7,
          visibility: GPUShaderStage.COMPUTE,
          texture: { viewDimension: '3d', sampleType: 'float' },
        },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
      label: 'brand-group0',
    })
    const group1 = device.createBindGroupLayout({
      entries: [buf(0, 'storage')],
      label: 'brand-group1',
    })

    const module = device.createShaderModule({ code: WGSL, label: 'firebrands' })
    this.spawnPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [group0, group1] }),
      compute: { module, entryPoint: 'spawn_step' },
      label: 'brand-spawn',
    })
    this.integratePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [group0] }),
      compute: { module, entryPoint: 'integrate' },
      label: 'brand-integrate',
    })

    this.bindGroup = device.createBindGroup({
      layout: group0,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.brands } },
        { binding: 2, resource: { buffer: this.classBuffer } },
        { binding: 3, resource: { buffer: this.emitterBuffer } },
        { binding: 4, resource: { buffer: this.state } },
        { binding: 6, resource: { buffer: this.ignitionMask } },
        { binding: 7, resource: texture.createView({ dimension: '3d' }) },
        {
          binding: 8,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
          }),
        },
      ],
      label: 'brand-bindings',
    })
    this.indirectGroup = device.createBindGroup({
      layout: group1,
      entries: [{ binding: 0, resource: { buffer: this.indirect } }],
      label: 'brand-indirect-bindings',
    })

    this.writeParams(options)
  }

  private writeParams(o: FirebrandSystemOptions): void {
    const f = this.paramData
    const u = this.paramU32
    const [dx, dy, dz] = o.domainMin ?? [0, 0, 0]
    const [sx, sy, sz] = o.domainSize ?? [1000, 1000, 128]
    f[0] = dx
    f[1] = dy
    f[2] = dz
    f[3] = dz // groundZ — flat until terrain sampling lands
    f[4] = sx
    f[5] = sy
    f[6] = sz
    f[7] = o.windTop ?? 128
    f[8] = 0.5 // dt, overwritten every step
    u[9] = Math.max(1, Math.min(o.subSteps ?? 5, 32))
    u[10] = 0
    u[11] = 0
    // Ambient log profile and receptor bed: placeholders until M5 and the surface solver land.
    f[12] = 0.5 // uStar
    f[13] = 0.1 // z0
    f[14] = 0 // displacement
    f[15] = 1 // wind dir x
    f[16] = 0 // wind dir y
    f[17] = 8 // receptor moisture, % oven-dry
    f[18] = 30 // receptor bulk density, kg/m3
    f[19] = 1.5 // 0.1 m windspeed, m/s
    const c = o.ignition ?? DEFAULT_IGNITION_COEFFS
    f[20] = c.b0
    f[21] = c.b1
    f[22] = c.b2
    f[23] = c.b3
    f[24] = c.b4
    f[25] = c.b5
    f[26] = 0 // brand moisture — lofted brands are already pyrolysed
    u[27] = this.device.limits.maxComputeWorkgroupsPerDimension
    u[28] = BRAND_POOL
    u[29] = SURFACE_CELLS
    f[30] = SURFACE_CELL_M
    f[31] = 0
    this.device.queue.writeBuffer(this.params, 0, rawBuffer(f))
  }

  /**
   * Upload the brand-producing cells for this step. WP 2.4 supplies the surface mass-loss rates
   * and WP 3.1/3.5 the canopy ones; until then this takes the stub emitters.
   *
   * Capped at {@link MAX_EMITTERS} so the whole spawn stage stays inside one workgroup and one
   * dispatch. If a fire ever presents more than 4096 brand-producing cells at once, the right
   * fix is to aggregate them upstream at canopy-voxel granularity, not to add scan dispatches.
   */
  setEmitters(emitters: readonly StubEmitter[]): void {
    const n = Math.min(emitters.length, MAX_EMITTERS)
    const data = new Float32Array(n * EMITTER_STRIDE_F32)
    for (let i = 0; i < n; i++) {
      const e = emitters[i] as StubEmitter
      const b = i * EMITTER_STRIDE_F32
      data[b + 0] = e.pos[0]
      data[b + 1] = e.pos[1]
      data[b + 2] = e.pos[2]
      data[b + 3] = e.massLossRate
      data[b + 4] = e.classIndex
      data[b + 5] = e.yieldMul
    }
    if (n > 0) this.device.queue.writeBuffer(this.emitterBuffer, 0, rawBuffer(data))
    this.emitterCount = n
  }

  /** `surface` is accepted for the contract and for the ignition write-back; the mass-loss
   * field it will carry is not published by `IFireOutputs` yet, so emitters come from
   * {@link setEmitters}. */
  step(encoder: GPUCommandEncoder, dt: Seconds, _surface: IFireOutputs): void {
    this.paramData[8] = dt
    this.paramU32[10] = this.frameIndex++
    this.paramU32[11] = this.emitterCount
    this.device.queue.writeBuffer(this.params, 0, rawBuffer(this.paramData))

    const pass = encoder.beginComputePass({ label: 'firebrands' })
    pass.setPipeline(this.spawnPipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.setBindGroup(1, this.indirectGroup)
    pass.dispatchWorkgroups(1)
    pass.setPipeline(this.integratePipeline)
    pass.setBindGroup(0, this.bindGroup)
    // Indirect, written and clamped by `spawn_step`. The pool bound is also enforced in the
    // kernel, so a stale or corrupt args buffer cannot read past the brand array.
    pass.dispatchWorkgroupsIndirect(this.indirect, 0)
    pass.end()

    if (!this.reading) encoder.copyBufferToBuffer(this.state, 0, this.staging, 0, STATE_BYTES)
  }

  /**
   * Refresh {@link stats} from the last completed step. Async because a readback is; call it
   * from the HUD at whatever rate the HUD updates, not from the sim loop.
   */
  async pollStats(): Promise<FirebrandStats> {
    if (this.reading) return this.stats
    this.reading = true
    try {
      await this.staging.mapAsync(GPUMapMode.READ)
      this.lastState.set(new Uint32Array(this.staging.getMappedRange()))
      this.staging.unmap()
      const v = this.lastState
      this.stats = {
        airborne: v[S_AIRBORNE_WT] ?? 0,
        landed: v[S_LANDED] ?? 0,
        ignitionsCaused: v[S_IGNITIONS] ?? 0,
        maxSpotDistanceM: metres((v[S_MAX_SPOT_MM] ?? 0) / 1000),
      }
    } finally {
      this.reading = false
    }
    return this.stats
  }

  /** Diagnostics the HUD wants and the contract does not carry: pool pressure and the exit flux
   * that a 1 km domain cannot simulate but must still report (§5). */
  async pollDiagnostics(): Promise<{
    cursor: number
    highWater: number
    weight: number
    spawned: number
    liveSlots: number
    exited: number
    poolUtilisation: number
    integrateWorkgroups: number
  }> {
    await this.pollStats()
    const v = this.lastState
    return {
      cursor: v[S_CURSOR] ?? 0,
      highWater: v[S_HIGHWATER] ?? 0,
      weight: v[S_WEIGHT] ?? 1,
      spawned: v[S_SPAWNED] ?? 0,
      liveSlots: v[S_AIRBORNE] ?? 0,
      exited: v[S_EXITED] ?? 0,
      poolUtilisation: (v[S_AIRBORNE] ?? 0) / BRAND_POOL,
      integrateWorkgroups: Math.ceil((v[S_HIGHWATER] ?? 0) / INTEGRATE_WORKGROUP),
    }
  }

  destroy(): void {
    for (const b of [
      this.params,
      this.brands,
      this.classBuffer,
      this.emitterBuffer,
      this.state,
      this.indirect,
      this.ignitionMask,
      this.staging,
    ]) {
      b.destroy()
    }
    this.ownedTexture?.destroy()
  }
}
