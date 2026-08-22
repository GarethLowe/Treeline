/**
 * `ISurfaceSolver` on WebGPU — work package 2.3.
 *
 * The scheme, the Hamiltonian and the active-set logic are all specified and unit-tested in
 * pure TypeScript next door (`levelset.ts`, `ellipse.ts`, `activeSet.ts`); this file is the
 * wiring — buffers, bind groups, pipelines and the pass order. The WGSL is a transliteration
 * of those modules and they are the oracle for it.
 *
 * **Honest scope.** Everything here has been type-checked and its pure counterparts tested
 * on the CLI; none of it has executed on a GPU, because Vitest has no WebGPU. The first
 * device run belongs to the integrator. What that run should check, in order:
 *
 * 1. The shader compiles (both the subgroup and the workgroup classify variants).
 * 2. `outputs.burntAreaM2` grows after `ignite()` + a few `step()`s.
 * 3. `activeCellCount` is a small fraction of 4.19 M and tracks the perimeter.
 * 4. `overflowed` is never set — it means a substep was silently dropped.
 *
 * ## Pass order per substep
 *
 * ```
 *   tick            reset per-substep counters, advance the sim clock
 *   classify        tile compaction into an indirect list          (spec §6.4)
 *   dispatchArgs    count -> clamped indirect args, then a 12-byte copy out
 *   advance[pred]   φ⁽¹⁾ = φⁿ + Δt·L(φⁿ)                    indirect
 *   advance[corr]   φⁿ⁺¹ = ½φⁿ + ½(φ⁽¹⁾ + Δt·L(φ⁽¹⁾))       indirect
 *   [every 32]      jfaSeed, 6 x jfaFlood, jfaResolve        indirect
 * ```
 *
 * Ignitions are queued by `ignite()` and stamped at the start of the next `step()`, because
 * the contract's `ignite()` takes no encoder.
 */

import type {
  IFireOutputs,
  IgnitionShape,
  SurfaceWeather,
} from '@contracts/sim'
import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/sim'
import type { KilowattsPerMetre, MetresPerSecond, Seconds } from '@contracts/units'
import { kWm, mps } from '@contracts/units'
import { REINIT_INTERVAL } from './levelset'
import { BAND_M, TILE_CELLS, tileGrid } from './activeSet'
import { substepPlan } from './timestep'
import { ENTRY, buildPropagationShader } from './shaders'
import { createStubRosCache, uploadRosCache } from './stub'

/** φ well outside the band. Deliberately finite — `0 · Infinity` in the blend is NaN. */
const FAR = 1e6
const UNIFORM_STRIDE = 256
const MAX_IGNITIONS_PER_STEP = 8
const CLASSIFY_WG = 64
/** Jump-flood octaves. 2 tiles of reach covers the dispatch set; more would be discarded. */
const JFA_JUMPS = [32, 16, 8, 4, 2, 1]

const IGNITION_KIND = { point: 0, line: 1, ring: 2 } as const

export interface SurfaceSolverOptions {
  readonly cells?: number
  readonly cellM?: number
  /**
   * WP 2.2's `(R_head, LB, headingX, headingY)` rgba16float cache. When absent a stub is
   * created and refilled each step from the weather — see `stub.ts`. Not physics.
   */
  readonly rosCache?: GPUTexture
  readonly useSubgroups?: boolean
}

export class SurfaceSolver {
  readonly cells: number
  readonly cellM: number

  private readonly device: GPUDevice
  private readonly tiles: ReturnType<typeof tileGrid>
  private readonly ownsRosCache: boolean

  private readonly uniform: GPUBuffer
  private readonly phi: GPUBuffer
  private readonly work: GPUBuffer
  private readonly tileMinAbs: GPUBuffer
  private readonly tileList: GPUBuffer
  private readonly control: GPUBuffer
  private readonly args: GPUBuffer
  private readonly sites: GPUBuffer
  private readonly staging: GPUBuffer[] = []
  private stagingCursor = 0
  /** Encoded-but-not-yet-submitted staging buffer; mapped on the next step. See readback(). */
  private pendingReadback: GPUBuffer | null = null

  private readonly rosCache: GPUTexture
  private readonly stateTexture: GPUTexture
  private readonly intensityTexture: GPUTexture
  private readonly arrivalTimeTexture: GPUTexture
  private readonly consumedTexture: GPUTexture
  /** Normal rate of spread at the moment the front arrived [m/s]. WP 2.4 reads it. */
  readonly rosArrivalTexture: GPUTexture

  private readonly bgPredictor: GPUBindGroup
  private readonly bgCorrector: GPUBindGroup
  private readonly pipelines: Record<string, GPUComputePipeline>
  private readonly jfaFlood: GPUComputePipeline[] = []

  private readonly pending: IgnitionShape[] = []
  private readonly uniformScratch = new ArrayBuffer(UNIFORM_STRIDE * (1 + MAX_IGNITIONS_PER_STEP))
  private substepsSinceReinit = 0

  private activeTiles = 0
  private burntCells = 0
  private frontCells = 0
  private overflowed = false
  private maxRateOverride: MetresPerSecond | null = null

  constructor(device: GPUDevice, options: SurfaceSolverOptions = {}) {
    const n = options.cells ?? SURFACE_CELLS
    if (n % TILE_CELLS !== 0) {
      throw new RangeError(`surface grid must be a multiple of ${TILE_CELLS} cells, got ${n}`)
    }
    this.device = device
    this.cells = n
    this.cellM = options.cellM ?? SURFACE_CELL_M
    this.tiles = tileGrid(n, n)

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const cells = n * n
    this.uniform = device.createBuffer({
      label: 'propagation.params',
      size: this.uniformScratch.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.phi = device.createBuffer({ label: 'propagation.phi', size: cells * 4, usage: storage })
    this.work = device.createBuffer({ label: 'propagation.work', size: cells * 4, usage: storage })
    this.tileMinAbs = device.createBuffer({
      label: 'propagation.tileMinAbs',
      size: this.tiles.count * 4,
      usage: storage,
    })
    this.tileList = device.createBuffer({
      label: 'propagation.tileList',
      size: this.tiles.count * 4,
      usage: storage,
    })
    this.control = device.createBuffer({
      label: 'propagation.control',
      size: 48,
      usage: storage,
    })
    // The indirect args live in their own buffer, and it is never bound to a shader.
    // WebGPU's usage-scope rule forbids a buffer being writable storage *and* the indirect
    // source of the same dispatch, and `control` has to be writable storage in `advance`
    // (it holds the burnt-cell counter). So `dispatchArgs` writes `control.args` and a
    // 12-byte copy moves it here between the two compute passes of each substep.
    this.args = device.createBuffer({
      label: 'propagation.indirectArgs',
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    })
    // ponytail: two vec2f halves = 16 B/cell = 64 MiB at 2048². Sized for clarity, not for
    // frugality — it is touched once every 32 substeps. Halve it by packing each site as one
    // u32 of 16-bit fixed point over the domain (15.6 mm, 1/32 of a cell) if the VRAM budget
    // gets tight; the level set never reads it, only the reinitialisation does.
    this.sites = device.createBuffer({
      label: 'propagation.jfaSites',
      size: cells * 2 * 8,
      usage: GPUBufferUsage.STORAGE,
    })
    for (let i = 0; i < 3; i++) {
      this.staging.push(
        device.createBuffer({
          label: `propagation.readback${i}`,
          size: 48,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      )
    }

    this.ownsRosCache = options.rosCache === undefined
    this.rosCache = options.rosCache ?? createStubRosCache(device, n)
    // COPY_SRC is not optional decoration: the `?debug` self-test reads these fields back to
    // prove the solver produced something, and a copy from a texture without it is a
    // validation error that invalidates the whole command buffer rather than failing locally.
    const texUsage =
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC
    this.stateTexture = device.createTexture({
      label: 'fire.state',
      size: [n, n],
      format: 'r8uint',
      usage: texUsage,
    })
    this.arrivalTimeTexture = device.createTexture({
      label: 'fire.arrivalTime',
      size: [n, n],
      format: 'r32float',
      usage: texUsage,
    })
    this.rosArrivalTexture = device.createTexture({
      label: 'fire.rosAtArrival',
      size: [n, n],
      format: 'r16float',
      usage: texUsage,
    })
    // Owned by WP 2.4 (consumption and intensity). Allocated here so `IFireOutputs` is
    // complete from this package alone, and so WP 2.4 can write straight into them rather
    // than duplicating 12 MB of 2048^2 fields. This solver never writes them.
    this.intensityTexture = device.createTexture({
      label: 'fire.intensity',
      size: [n, n],
      format: 'r16float',
      usage: texUsage,
    })
    this.consumedTexture = device.createTexture({
      label: 'fire.consumed',
      size: [n, n],
      format: 'r8unorm',
      usage: texUsage,
    })

    const useSubgroups = options.useSubgroups ?? device.features.has('subgroups')
    const module = device.createShaderModule({
      label: 'propagation.wgsl',
      code: buildPropagationShader(useSubgroups),
    })
    const layout = device.createBindGroupLayout({
      label: 'propagation.layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r8uint' } },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r16float' } },
      ],
    })
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const bind = (src: GPUBuffer, dst: GPUBuffer, label: string): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform, offset: 0, size: 64 } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: this.tileMinAbs } },
          { binding: 4, resource: { buffer: this.tileList } },
          { binding: 5, resource: { buffer: this.control } },
          { binding: 6, resource: { buffer: this.sites } },
          { binding: 7, resource: this.rosCache.createView() },
          { binding: 8, resource: this.arrivalTimeTexture.createView() },
          { binding: 9, resource: this.stateTexture.createView() },
          { binding: 10, resource: this.rosArrivalTexture.createView() },
        ],
      })
    // Two bind groups, created once, swapped by role. `dstPhi` is the real φ in the
    // corrector group, which is why every non-advance kernel uses that one.
    this.bgPredictor = bind(this.phi, this.work, 'propagation.bg.predictor')
    this.bgCorrector = bind(this.work, this.phi, 'propagation.bg.corrector')

    const make = (entryPoint: string, constants?: Record<string, number>): GPUComputePipeline =>
      device.createComputePipeline({
        label: `propagation.${entryPoint}`,
        layout: pipelineLayout,
        compute: constants ? { module, entryPoint, constants } : { module, entryPoint },
      })
    this.pipelines = {
      tick: make(ENTRY.tick),
      classify: make(useSubgroups ? ENTRY.classifySubgroup : ENTRY.classifyWorkgroup),
      args: make(ENTRY.dispatchArgs),
      predictor: make(ENTRY.advance, { BLEND: 0, RECORD: 0 }),
      corrector: make(ENTRY.advance, { BLEND: 0.5, RECORD: 1 }),
      igniteClear: make(ENTRY.igniteClear),
      ignite: make(ENTRY.ignite),
      jfaSeed: make(ENTRY.jfaSeed),
      jfaResolve: make(ENTRY.jfaResolve),
    }
    for (let i = 0; i < JFA_JUMPS.length; i++) {
      this.jfaFlood.push(
        make(ENTRY.jfaFlood, { JFA_JUMP: JFA_JUMPS[i] as number, JFA_SRC_HALF: i % 2 }),
      )
    }

    // `IFireOutputs` mixes textures with aggregates; the aggregates are getters over the
    // readback so consumers always see the freshest numbers without re-fetching the object.
    const self = this
    this.outputs = {
      get stateTexture() {
        return self.stateTexture
      },
      get intensityTexture() {
        return self.intensityTexture
      },
      get arrivalTimeTexture() {
        return self.arrivalTimeTexture
      },
      get consumedTexture() {
        return self.consumedTexture
      },
      get burntAreaM2() {
        return self.burntCells * self.cellM * self.cellM
      },
      /**
       * Cells straddling the front x cell size. Exact for an axis-aligned front and ~40 %
       * high for a diagonal one — a HUD number, not a measurement.
       */
      get perimeterM() {
        return self.frontCells * self.cellM
      },
      get maxFirelineIntensity(): KilowattsPerMetre {
        // Owned by WP 2.4, which writes the intensity field.
        return kWm(0)
      },
    }

    this.reset()
  }

  // -------------------------------------------------------------------------
  // ISurfaceSolver
  // -------------------------------------------------------------------------

  /** Cells the next dispatch will touch. Read back with one step of latency. */
  get activeCellCount(): number {
    return this.activeTiles * TILE_CELLS * TILE_CELLS
  }

  /** True when a dispatch had to be clamped and work was dropped. Belongs in the HUD. */
  get dispatchOverflowed(): boolean {
    return this.overflowed
  }

  readonly outputs: IFireOutputs

  /**
   * The raw field textures, for WP 2.4 to read (`arrivalTime`, `rosArrival`) and write
   * (`state`, `intensity`, `consumed`). Handing these over rather than letting `FireOutputs`
   * allocate its own is what stops the two packages maintaining parallel copies of the same
   * 2048^2 grid and disagreeing about which is current.
   */
  get fields(): {
    readonly state: GPUTexture
    readonly intensity: GPUTexture
    readonly arrivalTime: GPUTexture
    readonly consumed: GPUTexture
    readonly rosArrival: GPUTexture
  } {
    return {
      state: this.stateTexture,
      intensity: this.intensityTexture,
      arrivalTime: this.arrivalTimeTexture,
      consumed: this.consumedTexture,
      rosArrival: this.rosArrivalTexture,
    }
  }

  /**
   * Read-only handles for the `?debug` self-test. Not part of `ISurfaceSolver` and not for
   * production use — the front failing to advance is indistinguishable from the outside
   * whether phi was never seeded or was seeded and never advanced, and those have completely
   * different causes.
   */
  get debugBuffers(): { readonly phi: GPUBuffer; readonly control: GPUBuffer } {
    return { phi: this.phi, control: this.control }
  }

  ignite(shape: IgnitionShape): void {
    if (this.pending.length >= 4 * MAX_IGNITIONS_PER_STEP) {
      throw new Error('ignition queue full — call step() between bursts')
    }
    this.pending.push(shape)
  }

  reset(): void {
    const cells = this.cells * this.cells
    const far = new Float32Array(cells).fill(FAR)
    this.device.queue.writeBuffer(this.phi, 0, far)
    this.device.queue.writeBuffer(this.work, 0, far)
    // +Infinity as a float bit pattern: every tile starts "front is nowhere near".
    this.device.queue.writeBuffer(this.tileMinAbs, 0, new Uint32Array(this.tiles.count).fill(0x7f80_0000))
    this.device.queue.writeBuffer(this.control, 0, new Uint32Array(12))
    this.device.queue.writeBuffer(this.args, 0, new Uint32Array(4))
    this.device.queue.writeTexture(
      { texture: this.stateTexture },
      new Uint8Array(cells),
      { bytesPerRow: this.cells, rowsPerImage: this.cells },
      [this.cells, this.cells],
    )
    this.device.queue.writeTexture(
      { texture: this.arrivalTimeTexture },
      // f32 max, not Number.MAX_VALUE: the f64 constant is 1.8e308, which a Float32Array
      // silently coerces to +Infinity. The consumers survive an infinity, but the sentinel
      // they compare against (ARRIVAL_NEVER in burnout.wgsl) is a finite number, so writing
      // the finite one keeps the two ends of the convention identical.
      new Float32Array(cells).fill(3.4028234663852886e38),
      { bytesPerRow: 4 * this.cells, rowsPerImage: this.cells },
      [this.cells, this.cells],
    )
    this.device.queue.writeTexture(
      { texture: this.rosArrivalTexture },
      new Uint16Array(cells),
      { bytesPerRow: 2 * this.cells, rowsPerImage: this.cells },
      [this.cells, this.cells],
    )
    this.pending.length = 0
    this.activeTiles = 0
    this.burntCells = 0
    this.frontCells = 0
    this.overflowed = false
    this.substepsSinceReinit = 0
  }

  /**
   * WP 2.2's workgroup reduction over the band will give a tighter `R_max` than the
   * §4.5 rail bound this class falls back on. Feeding it here lets Δt grow.
   */
  setMaxRateOfSpread(rate: MetresPerSecond | null): void {
    this.maxRateOverride = rate
  }

  /**
   * Advance the front by `dt`.
   *
   * `readback` MUST be false for every call but the last on a given encoder. The staging ring
   * defers its `mapAsync` by one call on the assumption that the caller submitted in between —
   * true when there is one step per encoder, false the moment a caller runs several (which
   * `FireSim` does, once per unit of `timeScale`). Mapping a buffer the same, unsubmitted
   * encoder has already copied into makes the submit invalid, and WebGPU responds by
   * DISCARDING THE ENTIRE COMMAND BUFFER. At the shipping default of `timeScale = 8` that meant
   * no fire spread at all, while the `?debug` self-test passed because it pins `timeScale` to 1.
   */
  step(
    encoder: GPUCommandEncoder,
    dt: Seconds,
    weather: SurfaceWeather,
    options: { readonly readback?: boolean } = {},
  ): void {
    if (this.ownsRosCache) {
      uploadRosCache(
        this.device,
        this.rosCache,
        this.cells,
        weather.midflameWind,
        weather.windDirection,
      )
    }

    // R_max without a readback: the §4.5 sanity rail bounds R_head by the effective midflame
    // wind, so the wind field is already a valid upper bound. Conservative but free, and
    // never wrong in the unsafe direction.
    const maxRate = this.maxRateOverride ?? mps(Math.max(weather.midflameWind, 0.05))
    const plan = substepPlan(dt, maxRate, this.cellM)
    if (plan.substeps === 0) return

    const flushing = this.pending.splice(0, MAX_IGNITIONS_PER_STEP)
    this.writeUniform(plan.dt, flushing)

    const wgFor = (items: number, per: number) => Math.ceil(items / per)
    const pipeline = (name: string) => this.pipelines[name] as GPUComputePipeline

    if (flushing.length > 0) {
      const pass = encoder.beginComputePass({ label: 'surface.propagation.ignite' })
      for (let i = 0; i < flushing.length; i++) {
        pass.setBindGroup(0, this.bgCorrector, [UNIFORM_STRIDE * (1 + i)])
        pass.setPipeline(pipeline('igniteClear'))
        pass.dispatchWorkgroups(wgFor(this.tiles.count, CLASSIFY_WG))
        pass.setPipeline(pipeline('ignite'))
        pass.dispatchWorkgroups(this.cells / TILE_CELLS, this.cells / TILE_CELLS)
      }
      pass.end()
    }

    for (let sub = 0; sub < plan.substeps; sub++) {
      const compact = encoder.beginComputePass({ label: 'surface.propagation.compact' })
      compact.setBindGroup(0, this.bgCorrector, [0])
      compact.setPipeline(pipeline('tick'))
      compact.dispatchWorkgroups(1)
      compact.setPipeline(pipeline('classify'))
      compact.dispatchWorkgroups(wgFor(this.tiles.count, CLASSIFY_WG))
      compact.setPipeline(pipeline('args'))
      compact.dispatchWorkgroups(1)
      compact.end()

      encoder.copyBufferToBuffer(this.control, 32, this.args, 0, 12)

      const advance = encoder.beginComputePass({ label: 'surface.propagation.advance' })
      advance.setBindGroup(0, this.bgPredictor, [0])
      advance.setPipeline(pipeline('predictor'))
      advance.dispatchWorkgroupsIndirect(this.args, 0)

      advance.setBindGroup(0, this.bgCorrector, [0])
      advance.setPipeline(pipeline('corrector'))
      advance.dispatchWorkgroupsIndirect(this.args, 0)

      this.substepsSinceReinit++
      if (this.substepsSinceReinit >= REINIT_INTERVAL) {
        this.substepsSinceReinit = 0
        advance.setPipeline(pipeline('jfaSeed'))
        advance.dispatchWorkgroupsIndirect(this.args, 0)
        for (const flood of this.jfaFlood) {
          advance.setPipeline(flood)
          advance.dispatchWorkgroupsIndirect(this.args, 0)
        }
        advance.setPipeline(pipeline('jfaResolve'))
        advance.dispatchWorkgroupsIndirect(this.args, 0)
      }
      advance.end()
    }

    if (options.readback ?? true) this.readback(encoder)
  }

  destroy(): void {
    for (const b of [this.uniform, this.phi, this.work, this.tileMinAbs, this.tileList, this.control, this.args, this.sites, ...this.staging]) {
      b.destroy()
    }
    for (const t of [this.stateTexture, this.arrivalTimeTexture, this.intensityTexture, this.consumedTexture, this.rosArrivalTexture]) {
      t.destroy()
    }
    if (this.ownsRosCache) this.rosCache.destroy()
  }

  // -------------------------------------------------------------------------

  private writeUniform(dt: Seconds, ignitions: readonly IgnitionShape[]): void {
    const view = new DataView(this.uniformScratch)
    const stripe = (index: number, shape: IgnitionShape | null): void => {
      const o = index * UNIFORM_STRIDE
      view.setUint32(o + 0, this.cells, true)
      view.setUint32(o + 4, this.tiles.tilesX, true)
      view.setUint32(o + 8, this.tiles.count, true)
      view.setUint32(o + 12, this.device.limits.maxComputeWorkgroupsPerDimension, true)
      view.setFloat32(o + 16, this.cellM, true)
      view.setFloat32(o + 20, 1 / this.cellM, true)
      view.setFloat32(o + 24, dt, true)
      view.setFloat32(o + 28, BAND_M, true)
      if (shape === null) {
        view.setUint32(o + 56, 0, true)
        return
      }
      const ax = shape.kind === 'line' ? shape.x0 : shape.x
      const ay = shape.kind === 'line' ? shape.z0 : shape.z
      const bx = shape.kind === 'line' ? shape.x1 : shape.x
      const by = shape.kind === 'line' ? shape.z1 : shape.z
      view.setFloat32(o + 32, ax, true)
      view.setFloat32(o + 36, ay, true)
      view.setFloat32(o + 40, bx, true)
      view.setFloat32(o + 44, by, true)
      view.setFloat32(o + 48, shape.kind === 'line' ? 0 : shape.radius, true)
      view.setFloat32(o + 52, shape.kind === 'point' ? 0 : shape.width, true)
      view.setUint32(o + 56, IGNITION_KIND[shape.kind], true)
    }
    stripe(0, null)
    for (let i = 0; i < ignitions.length; i++) stripe(1 + i, ignitions[i] as IgnitionShape)
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      this.uniformScratch,
      0,
      UNIFORM_STRIDE * (1 + ignitions.length),
    )
  }

  /**
   * Copy the control block and map it. Three staging buffers rotate so no buffer is ever
   * mapped while a copy into it is still in flight; the numbers are therefore one to three
   * steps stale, which is the correct trade for never stalling the queue.
   */
  private readback(encoder: GPUCommandEncoder): void {
    // Map the buffer encoded on the PREVIOUS call, not this one.
    //
    // `mapAsync` puts a buffer into the "pending map" state immediately. Calling it on a
    // buffer that a not-yet-submitted encoder copies into makes that submit invalid, and
    // WebGPU then discards the ENTIRE command buffer — every compute pass in it, silently,
    // with only a warning. That is what happened here: the copy was encoded and mapped in
    // the same breath, so every step this solver ever encoded was thrown away, the ignition
    // was consumed from the queue and lost with it, and the front could never advance.
    //
    // Deferring by one call is sufficient and needs no extra synchronisation: `step()` is
    // only reached again after its caller has submitted the previous encoder.
    const previous = this.pendingReadback
    this.pendingReadback = null
    if (previous !== null && previous.mapState === 'unmapped') {
      void previous
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const v = new Uint32Array(previous.getMappedRange().slice(0))
          previous.unmap()
          this.activeTiles = v[0] as number
          this.burntCells = v[1] as number
          this.frontCells = v[2] as number
          this.overflowed = (v[3] as number) !== 0
        })
        .catch(() => {
          /* device lost or buffer destroyed — the stale numbers stand. */
        })
    }

    const buffer = this.staging[this.stagingCursor] as GPUBuffer
    this.stagingCursor = (this.stagingCursor + 1) % this.staging.length
    if (buffer.mapState !== 'unmapped') return
    encoder.copyBufferToBuffer(this.control, 0, buffer, 0, 48)
    this.pendingReadback = buffer
  }
}
