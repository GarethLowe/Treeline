/**
 * The composition layer that makes M2 actually burn — WP 2.2 + 2.3 wired to the frame loop.
 *
 * ## The one integration decision in here
 *
 * WP 2.2 (`src/sim/surface`) evaluates Rothermel over the whole 2048² grid and writes its
 * result to `SurfaceGrid.ellipseCache`, a **storage buffer** of `vec2u` per cell:
 *
 * ```wgsl
 * ellipseCache[cell] = vec2u(pack2x16float(vec2f(R_head [m/s], LB)),
 *                            pack2x16float(heading));            // ros_substep.wgsl
 * ```
 *
 * WP 2.3 (`src/sim/propagation`) reads the identical quantity from a **`rgba16float`
 * texture**:
 *
 * ```wgsl
 * let cache = textureLoad(rosCache, vec2i(ii, jj), 0);
 * let e = ellipseFromRates(cache.x, cache.y, cache.zw);          // propagation.wgsl
 * ```
 *
 * Same four halves, same order, same units, two resource kinds — the two packages were built
 * in parallel and never met. They are byte-identical, so the bridge is one
 * `copyBufferToTexture`: 8 B/cell in both, row pitch `8 × 2048 = 16384` (a multiple of 256),
 * and little-endian `pack2x16float` puts `.x` in the low half, which is the `r` channel.
 *
 * Without it the solver falls back to `stub.ts`, whose own header says *"this is not physics
 * and must never ship"* and which re-packs 32 MiB on the CPU every step. So this file exists
 * mostly to delete that path.
 *
 * ## Rates
 *
 * The two Rothermel passes are amortised on the **simulated** clock, not the frame clock:
 *
 * | pass | rate | why |
 * |---|---|---|
 * | `encodeMoistureTick` | 1 Hz sim, or on moisture change | §4.3: R₀ depends only on fuel and moisture |
 * | `encodeSubstep` + bridge copy | 1 Hz sim, or on weather change | wind and slope factors |
 * | `SurfaceSolver.step` | every fixed step | the level set, which is what moves |
 *
 * ponytail: §4.3 puts the substep pass on every substep, at 96 MiB of traffic each. That is
 * right for M5's gusty wind FIELD; against the constant scalar wind of `STUB_WEATHER` the
 * output is bit-identical between substeps, so it runs on the sim clock instead. When M5
 * lands, move `encodeSubstep` back inside the substep loop — which means the solver has to
 * expose one, so expect to touch `src/sim/propagation/solver.ts` at the same time.
 */

import type { FuelSizeClass, IgnitionShape, SurfaceWeather } from '@contracts/sim.ts'
import { FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/sim.ts'
import type { Radians, Seconds } from '@contracts/units.ts'
import { degToRad, m as metres, moistureFraction, mps, s as seconds, slopeTan } from '@contracts/units.ts'
import type { SpreadOutputs } from '@contracts/sim.ts'
import { curingFraction, rothermelSpread } from '@sim/rothermel/kernel.ts'
import { buildCoefficientLut, type CoefficientLut } from '@sim/surface/coefficients.ts'
import { FLAG_BURNABLE, PLANE_COUNT, SURFACE_CELL_COUNT } from '@sim/surface/layout.ts'
import { createSurfaceGrid, createSurfaceRosPasses, packCell, type SurfaceGrid, type SurfaceRosPasses } from '@sim/surface/surfacePass.ts'
import { SurfaceSolver } from '@sim/propagation/solver.ts'
import { FireOutputs } from '@sim/burnout/outputs.ts'
import { burnoutModelFor, type CellBurnoutModel } from '@sim/burnout/consumption.ts'
import { aggregateStand, type CrownStem } from '@sim/canopy/crown/stand.ts'
import { evaluateCrownFire, type CrownFireResult, type StandCrownParams } from '@sim/canopy/crown/vanWagner.ts'
import type { KgPerCubicMetre } from '@contracts/units.ts'

/**
 * The M5 placeholder, and the ONLY stub in this layer.
 *
 * Every number is a plausible mid-afternoon summer fire day, and none of it is a model — the
 * real thing is `docs/spec/50-meteorology.md` and does not exist yet. It is `estimated` in
 * the provenance readout and says so, because a HUD that reported a `validated` rate of
 * spread driven by an invented wind would be exactly the failure spec §0.7 is about.
 *
 * Moisture is a FRACTION (spec §0.6). 0.06 = 6 % dead 1-h, which is the §4.2 GR2 D2L2
 * benchmark point — so a fresh page load starts at the one condition the solver has been
 * validated against, to 0.32 %.
 */
export const STUB_WEATHER: SurfaceWeather = {
  midflameWind: mps(2.2),
  /** Azimuth the wind blows TOWARD, radians clockwise from north — `ros_substep.wgsl`. */
  windDirection: degToRad(90),
  moisture: {
    dead1h: moistureFraction(0.06),
    dead10h: moistureFraction(0.07),
    dead100h: moistureFraction(0.08),
    liveHerb: moistureFraction(0.6),
    liveWoody: moistureFraction(0.9),
  },
}


/** Simulated seconds between re-evaluations of the two Rothermel passes. */
const ROTHERMEL_TICK_S = 1

export interface FireSimOptions {
  readonly device: GPUDevice
  /** WP 1.2's rg16float slope tangent + downslope aspect. Sampled by `ros_substep.wgsl`. */
  readonly slopeAspectTexture: GPUTexture
  /** Scott & Burgan / UK code, e.g. `'GR2'`. Must exist in WP 2.1's table. */
  readonly fuelModelCode: string
  readonly useSubgroups?: boolean
  /**
   * The stand Van Wagner's crown criteria are evaluated against — WP 1.3's stems and its
   * measured STAND crown bulk density (not the within-crown one). Omit and crown fire is
   * reported as unavailable rather than as `none`, which would be a claim.
   */
  readonly stand?: {
    readonly stems: readonly CrownStem[]
    readonly standCrownBulkDensity: KgPerCubicMetre
  }
}

/**
 * Surface fire on the GPU: the real Rothermel kernel driving the real level set.
 *
 * Owns no physics. Every number it produces comes from `@sim/*`; this class decides only
 * *when* each pass runs and hands WP 2.2's output to WP 2.3 in the resource kind it wants.
 */
/**
 * Every WebGPU validation error this device raises, newest last, capped.
 *
 * Chrome reports these to the console — and then stops, with *"too many warnings, no more
 * warnings will be reported for this GPUDevice"*, after which the console is worse than
 * silent because it serves stale messages from a previous page session. Four separate bugs in
 * this project have been misdiagnosed off that console. This buffer is the ground truth the
 * self-test prints, and it is the first thing to read when a GPU result is empty.
 */
export const gpuErrors: string[] = []

/** Decode one IEEE binary16 to a JS number. */
function halfFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return sign * 2 ** -24 * frac
  if (exp === 31) return frac === 0 ? sign * Infinity : NaN
  return sign * 2 ** (exp - 15) * (1 + frac / 1024)
}

let errorHookInstalled = false

function captureGpuErrors(device: GPUDevice): void {
  if (errorHookInstalled) return
  errorHookInstalled = true
  device.addEventListener('uncapturederror', (event) => {
    const e = event as GPUUncapturedErrorEvent
    if (gpuErrors.length < 50) gpuErrors.push(e.error.message.split('\n')[0] ?? String(e.error))
  })
}

export class FireSim {
  readonly solver: SurfaceSolver

  /** LUT order, index 0 = non-burnable. The `fuelModelId` byte means an index into this. */
  readonly fuelOrder: readonly string[]
  readonly cells: number
  readonly cellM: number

  /** Simulated seconds since the last {@link reset}. Matches the solver's own clock. */
  simTimeS = 0
  /** How many fixed steps run per fixed step of wall time. 1 = real time. */
  timeScale = 1

  #fuelModelCode: string
  #weather: SurfaceWeather = STUB_WEATHER
  #dirty = true
  #nextTickS = 0
  #ignitionCount = 0
  #predicted: SpreadOutputs | null = null
  #crown: CrownFireResult | null = null
  readonly #stand: StandCrownParams | null

  readonly #device: GPUDevice
  readonly #lut: CoefficientLut
  readonly #grid: SurfaceGrid
  readonly #ros: SurfaceRosPasses
  readonly #rosCache: GPUTexture
  /** Diagnostic, filled by probeRosCache(). Non-zero u32 words in a 1 KiB sample of the ROS pass output. */
  ellipseCacheNonZeroWords = -1
  /** Non-zero u32 words per stage of the ROS chain, from a 1 KiB sample of each. */
  chainProbe: { fuelLut: number; rosBase: number; stateWords: number } = { fuelLut: -1, rosBase: -1, stateWords: -1 }
  /** phi state around the ignition point plus the solver's control block. */
  phiProbe: { negatives: number; nearField: number; min: number; control: number[] } = { negatives: -1, nearField: -1, min: NaN, control: [] }
  /** Peak intensity and consumed fraction near the ignition, from probeOutputs(). */
  outputProbe: { peakIntensity: number; burningTexels: number; maxConsumed: number } = {
    peakIntensity: -1,
    burningTexels: -1,
    maxConsumed: -1,
  }
  /** One plane's worth of u32, reused for every rewrite. 16 MiB, allocated once. */
  readonly #plane: Uint32Array<ArrayBuffer>
  /**
   * WP 2.4. Reads the solver's arrival-time and rate-of-spread-at-arrival fields and writes
   * the intensity, consumed-fraction and lifecycle-state fields nothing else fills, plus the
   * burnt-area / perimeter / peak-intensity aggregates.
   *
   * ponytail: one model entry, index 0, because the whole domain carries one fuel model. The
   * per-cell fuel index buffer is left zeroed and the table is re-packed on a fuel change.
   * When the M5 per-cell fuel map lands, widen the table and call `setFuelIndex`.
   */
  readonly #burnout: FireOutputs

  constructor(options: FireSimOptions) {
    const device = options.device
    // `SurfaceSolver` allocates r8uint and r16float STORAGE textures, and `FireOutputs` next
    // door checks the same thing. Without the feature the failure is a WebGPU validation
    // message naming a format enum, from three frames inside a library. Fail here instead.
    if (!device.features.has('texture-formats-tier1')) {
      throw new Error(
        'The surface fire solver needs the "texture-formats-tier1" device feature for its ' +
          'r8uint / r8unorm / r16float storage textures, and this adapter did not grant it. ' +
          'It is already in WANTED_FEATURES (src/contracts/gpu.ts), so the adapter does not ' +
          'support it — the world will render but no fire can run.',
      )
    }
    this.#device = device
    captureGpuErrors(device)
    this.cells = SURFACE_CELLS
    this.cellM = SURFACE_CELL_M

    // The REAL WP 2.1 table, not `STUB_FUEL_TABLE`: 40 Scott & Burgan + 13 Anderson + the UK
    // set, each carrying its own provenance.
    this.#lut = buildCoefficientLut(FUEL_MODELS)
    this.fuelOrder = this.#lut.order
    if (this.fuelOrder.length > 256) {
      throw new RangeError(
        `fuelModelId is one byte; the LUT has ${this.fuelOrder.length} entries. ` +
          'Either the state layout or the table has to change.',
      )
    }
    this.#fuelModelCode = options.fuelModelCode

    this.#grid = createSurfaceGrid(device, this.#lut)
    this.#ros = createSurfaceRosPasses(
      device,
      this.#grid,
      options.slopeAspectTexture.createView(),
      // §4.5 default. `behave` is the debug toggle that reproduces BehavePlus' legacy cap;
      // the model authors' own published recommendation is not to cap at all.
      { windLimit: 'sanity' },
    )

    // rgba16float, COPY_DST only — the bridge target. Handing it to the solver is what stops
    // it allocating `stub.ts`'s CPU-packed one, and `ownsRosCache` then stays false.
    this.#rosCache = device.createTexture({
      label: 'fire.rosCache',
      size: [this.cells, this.cells],
      format: 'rgba16float',
      // COPY_SRC so the self-test can read it back. Without it copyTextureToBuffer is a
      // validation error that invalidates the WHOLE encoder, silently zeroing every other
      // probe in the same command buffer — which is exactly how this bug hid.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    })

    this.solver = new SurfaceSolver(device, {
      rosCache: this.#rosCache,
      ...(options.useSubgroups === undefined ? {} : { useSubgroups: options.useSubgroups }),
    })


    // Stand geometry is static, so this O(stems) pass runs once here rather than per step —
    // WP 3.5's own header says so and measures it at 2.1 ms for 50,000 stems.
    this.#stand =
      options.stand === undefined
        ? null
        : aggregateStand(options.stand.stems, options.stand.standCrownBulkDensity)

    this.#burnout = new FireOutputs(device, [this.burnoutModel()], {
      cells: this.cells,
      cellM: this.cellM,
      fields: this.solver.fields,
    })

    this.#plane = new Uint32Array(SURFACE_CELL_COUNT)
    this.writeFuelBed()
  }

  /**
   * The published fire fields. This is WP 2.4's object, not the solver's: the solver's
   * `outputs` reports `maxFirelineIntensity` as a hard zero and leaves the intensity and
   * consumed textures untouched, because it does not own the burnout curve.
   */
  get outputs(): FireOutputs {
    return this.#burnout
  }

  /**
   * The burnout curve for the current fuel model. `residenceTime` comes from WP 2.1's
   * surface-area-weighted characteristic sigma, so it moves with the fuel but not with the
   * weather — which is why this can be rebuilt from `predicted` alone.
   */
  private burnoutModel(): CellBurnoutModel {
    const residence = this.predicted.residenceTime
    // A non-burnable model has no residence time and no curve. `burnoutModelFor` rejects a
    // non-positive one rather than dividing by it, so substitute a nominal second: every
    // class then carries zero load and the curve evaluates to zero everywhere anyway.
    return burnoutModelFor(FUEL_MODELS.get(this.#fuelModelCode), residence > 0 ? residence : seconds(1))
  }

  /**
   * The burnout curve M4's smoke field emits against.
   *
   * The same object WP 2.4 integrates, handed over rather than rebuilt: the smoke source is the
   * analytic derivative of this curve, and two independently-constructed models would emit a
   * plume whose mass did not match the fuel that was consumed.
   */
  burnoutModelForSmoke(): CellBurnoutModel {
    return this.burnoutModel()
  }

  /**
   * Head-fire behaviour for the current fuel, moisture and wind on LEVEL ground, from WP 2.1's
   * pure kernel — the same oracle `npm run validate` reproduces published rate of spread with
   * to 0.32 %.
   *
   * This is a *prediction*, not a measurement of what the grid did: the GPU adds the local
   * slope factor per cell, so the fire on a hillside outruns this number and one backing into
   * a slope falls short of it. It is here because the alternative is a HUD with no rate of
   * spread at all — WP 2.3 publishes arrival times, not rates — and because a number whose
   * provenance is exactly stated beats a blank line. Cached; recomputed only when an input
   * moves.
   */
  get predicted(): SpreadOutputs {
    if (this.#predicted === null) {
      const mo = this.#weather.moisture
      this.#predicted = rothermelSpread({
        fuel: FUEL_MODELS.get(this.#fuelModelCode),
        moisture: mo,
        midflameWind: this.#weather.midflameWind,
        // Level ground. The per-cell slope factor is the GPU's job (`ros_substep.wgsl`),
        // and averaging it here would produce a number that is true nowhere.
        slope: slopeTan(0),
        cured: curingFraction(mo.liveHerb),
      })
    }
    return this.#predicted
  }

  get activeCellCount(): number {
    return this.solver.activeCellCount
  }

  /** True when a dispatch was clamped and work was dropped. A loud HUD line. */
  get dispatchOverflowed(): boolean {
    return this.solver.dispatchOverflowed
  }

  get weather(): SurfaceWeather {
    return this.#weather
  }

  get fuelModelCode(): string {
    return this.#fuelModelCode
  }

  /** Ignitions requested since the last {@link reset}. Zero here means nothing can burn. */
  get ignitionCount(): number {
    return this.#ignitionCount
  }

  /** The `fuelModelId` byte this world's cells carry. 0 would mean nothing burns. */
  get fuelModelId(): number {
    return Math.max(0, this.fuelOrder.indexOf(this.#fuelModelCode))
  }

  /** The aggregated stand, or null when no vegetation was supplied. */
  get stand(): StandCrownParams | null {
    return this.#stand
  }

  /**
   * Van Wagner crown-fire classification for the current surface behaviour.
   *
   * WP 3.5 is explicit that these criteria are **CPU-side validators and HUD diagnostics**,
   * not the spread mechanism — there is no shader and nothing to amortise, so this is
   * evaluated once per HUD update from the cached surface prediction rather than per step.
   *
   * `crownRos` is handed the surface rate of spread: before crowning starts that is what the
   * front is doing.
   *
   * **`measuredCrownConsumedFraction` now comes from the voxel field** when the canopy solver
   * has reported one. Until it did, every crown fire this project described was Van Wagner's
   * empirical curve narrating over a 3D canopy nobody asked — the two can disagree completely,
   * and when they do the measurement is the answer and the divergence is the finding.
   * `crownFractionBurnedIsDiagnostic` still distinguishes the two in the HUD.
   */
  get crown(): CrownFireResult | null {
    const stand = this.#stand
    if (stand === null) return null
    if (this.#crown === null) {
      const p = this.predicted
      const measured = this.#measuredCrownConsumed
      this.#crown = evaluateCrownFire({
        stand,
        surfaceIntensity: p.firelineIntensity,
        surfaceRos: p.rateOfSpread,
        crownRos: p.rateOfSpread,
        ...(measured === null ? {} : { measuredCrownConsumedFraction: measured }),
      })
    }
    return this.#crown
  }

  #measuredCrownConsumed: number | null = null

  /**
   * Hand the crown model the canopy's own answer. Called by the composition layer once the
   * voxel readback lands; invalidates the cached evaluation so the next HUD update uses it.
   */
  setMeasuredCrownConsumed(fraction: number | null): void {
    if (fraction === this.#measuredCrownConsumed) return
    this.#measuredCrownConsumed = fraction
    this.#crown = null
  }

  /**
   * Replace the weather. Moisture changes rewrite the packed state (it is stored per cell,
   * not passed as a uniform — §4.3, so the moisture tick can read it); wind changes only need
   * the substep pass re-run.
   */
  setWeather(weather: SurfaceWeather): void {
    const moistureChanged = !sameMoisture(this.#weather.moisture, weather.moisture)
    this.#weather = weather
    this.#dirty = true
    this.#predicted = null
    this.#crown = null
    if (moistureChanged) this.writeFuelBed()
    // Moisture moves the residence time through the characteristic sigma weighting, so the
    // burnout curve has to follow. Cheap: 48 bytes.
    this.#burnout.setModels([this.burnoutModel()])
  }

  setFuelModel(code: string): void {
    if (code === this.#fuelModelCode) return
    if (!FUEL_MODELS.has(code)) throw new Error(`unknown fuel model '${code}'`)
    this.#fuelModelCode = code
    this.#predicted = null
    this.#crown = null
    this.writeFuelBed()
    this.#burnout.setModels([this.burnoutModel()])
  }

  ignite(shape: IgnitionShape): void {
    this.#ignitionCount++
    this.solver.ignite(shape)
  }

  reset(): void {
    this.solver.reset()
    this.#burnout.clear(this.#device.createCommandEncoder({ label: 'fire.reset' }))
    this.simTimeS = 0
    this.#nextTickS = 0
    this.#ignitionCount = 0
    this.#dirty = true
  }

  /**
   * One fixed simulation step. Called from `Runtime`'s `onStep`, never from the render
   * callback, so the step size is decoupled from the frame rate (spec §0.5.1, §6.5).
   *
   * `timeScale` multiplies the number of *steps*, never their size — running the same solver
   * more times is honest; enlarging `dt` past the CFL limit silently drops simulated time
   * inside `substepPlan`, and every arrival time and rate of spread the HUD reports would
   * then be wrong by an unreported amount.
   */
  /**
   * Reads WP 2.4's two derived fields — intensity and consumed fraction — over the same
   * 64x64 patch the ROS probe uses.
   *
   * These are the fields that were structurally zero until WP 2.3 and WP 2.4 were reconciled,
   * and a green test suite cannot see them: Vitest has no WebGPU, so the burnout shader never
   * reaches a compiler there. Without this probe the only evidence that the reconciliation
   * worked is that the aggregates are non-zero, and the aggregates are computed from the
   * arrival field alone — they would look exactly the same if the intensity write were still
   * dead.
   */
  private async probeOutputs(): Promise<void> {
    const dev = this.#device
    const N = 64
    const x0 = Math.floor(this.cells / 2) - N / 2
    const y0 = Math.floor(this.cells / 2) - N / 2
    // r16float: 2 B/texel. r8unorm: 1 B/texel. Both rows padded to the 256 B copy alignment.
    const intensityRow = 256 * Math.ceil((N * 2) / 256)
    const consumedRow = 256 * Math.ceil(N / 256)
    const mk = (label: string, size: number): GPUBuffer =>
      dev.createBuffer({ label, size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const iBuf = mk('fire.intensityProbe', intensityRow * N)
    const cBuf = mk('fire.consumedProbe', consumedRow * N)

    // One encoder per resource, for the reason given in probeRosCache.
    const encI = dev.createCommandEncoder({ label: 'fire.probe.intensity' })
    encI.copyTextureToBuffer(
      { texture: this.outputs.intensityTexture, origin: { x: x0, y: y0 } },
      { buffer: iBuf, bytesPerRow: intensityRow },
      { width: N, height: N },
    )
    dev.queue.submit([encI.finish()])
    const encC = dev.createCommandEncoder({ label: 'fire.probe.consumed' })
    encC.copyTextureToBuffer(
      { texture: this.outputs.consumedTexture, origin: { x: x0, y: y0 } },
      { buffer: cBuf, bytesPerRow: consumedRow },
      { width: N, height: N },
    )
    dev.queue.submit([encC.finish()])
    await dev.queue.onSubmittedWorkDone()

    await iBuf.mapAsync(GPUMapMode.READ)
    const halfs = new Uint16Array(iBuf.getMappedRange().slice(0))
    iBuf.unmap()
    iBuf.destroy()
    let peak = 0
    let burning = 0
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = halfFloat(halfs[r * (intensityRow / 2) + c] ?? 0)
        if (v > 0) burning++
        if (v > peak) peak = v
      }
    }

    await cBuf.mapAsync(GPUMapMode.READ)
    const bytes = new Uint8Array(cBuf.getMappedRange().slice(0))
    cBuf.unmap()
    cBuf.destroy()
    let maxConsumed = 0
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = (bytes[r * consumedRow + c] ?? 0) / 255
        if (v > maxConsumed) maxConsumed = v
      }
    }
    this.outputProbe = { peakIntensity: peak, burningTexels: burning, maxConsumed }
  }

  /**
   * Reads a 64x64 patch of `rosCache` around the domain centre and reports whether it holds
   * a non-zero head rate.
   *
   * This exists because "nothing burnt" has two completely different causes with identical
   * symptoms: the Rothermel passes never produced a rate (so the cache is zeros and the
   * front has nothing to advance on), or the rate is fine and the level-set propagation is
   * broken. Without this probe the self-test can only report the symptom, and the two are
   * indistinguishable from the outside.
   */
  private async probeRosCache(): Promise<{ nonZeroTexels: number; maxHead: number }> {
    const dev = this.#device
    const N = 64
    const x0 = Math.floor(this.cells / 2) - N / 2
    const y0 = Math.floor(this.cells / 2) - N / 2
    const bytesPerRow = 256 * Math.ceil((N * 8) / 256) // rgba16float = 8 B/texel
    const buf = dev.createBuffer({
      label: 'fire.rosProbe',
      size: bytesPerRow * N,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    // Also sample the SOURCE buffer the bridge copies from. If the cache is zero but this
    // is not, the copy is at fault; if both are zero, the ROS passes produced nothing.
    const srcBuf = dev.createBuffer({
      label: 'fire.ellipseProbe',
      size: 1024,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const centreCell = (Math.floor(this.cells / 2) * this.cells + Math.floor(this.cells / 2)) * 8

    // Separate encoders per resource kind. A single invalid copy invalidates its entire
    // command buffer, so batching probes together means one mistake zeroes all of them and
    // the diagnostic confidently reports the wrong stage.
    const encTex = dev.createCommandEncoder({ label: 'fire.rosProbe.tex' })
    encTex.copyTextureToBuffer(
      { texture: this.#rosCache, origin: { x: x0, y: y0 } },
      { buffer: buf, bytesPerRow },
      { width: N, height: N },
    )
    dev.queue.submit([encTex.finish()])

    // phi around the ignition point, and the solver's control block. If phi is still FAR
    // everywhere the ignite dispatch never wrote; if it has negatives, ignition worked and
    // the classify/advance path is at fault. Two different bugs, identical symptom.
    const phiBuf = dev.createBuffer({ label: 'fire.phiProbe', size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const ctlBuf = dev.createBuffer({ label: 'fire.ctlProbe', size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })

    const enc = dev.createCommandEncoder({ label: 'fire.rosProbe.buf' })
    enc.copyBufferToBuffer(this.solver.debugBuffers.phi, (centreCell / 8) * 4, phiBuf, 0, 1024)
    enc.copyBufferToBuffer(this.solver.debugBuffers.control, 0, ctlBuf, 0, 48)
    enc.copyBufferToBuffer(this.#grid.ellipseCache, centreCell, srcBuf, 0, 1024)
    // Walk the whole chain, so the failing stage names itself:
    //   fuelLut + stateWords -> rosBase (moisture tick) -> ellipseCache (substep) -> rosCache
    const lutBuf = dev.createBuffer({ label: 'fire.lutProbe', size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const baseBuf = dev.createBuffer({ label: 'fire.baseProbe', size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const stateBuf = dev.createBuffer({ label: 'fire.stateProbe', size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    // NOT offset 0 for the LUT: record 0 is the non-burnable fuel and is legitimately all
    // zeros, so sampling there proves nothing. Sample from the middle of the table instead.
    const lutOffset = Math.min(4096, Math.max(0, this.#grid.fuelLut.size - 1024))
    // stateWords is written uniformly across the whole plane, so offset 0 is representative
    // and avoids depending on the cell-index arithmetic being right.
    enc.copyBufferToBuffer(this.#grid.fuelLut, lutOffset, lutBuf, 0, 1024)
    enc.copyBufferToBuffer(this.#grid.rosBase, (centreCell / 8) * 4, baseBuf, 0, 1024)
    enc.copyBufferToBuffer(this.#grid.stateWords, 0, stateBuf, 0, 1024)
    dev.queue.submit([enc.finish()])

    const nonZero = async (b: GPUBuffer): Promise<number> => {
      await b.mapAsync(GPUMapMode.READ)
      const w = new Uint32Array(b.getMappedRange().slice(0))
      b.unmap()
      b.destroy()
      return w.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)
    }
    await srcBuf.mapAsync(GPUMapMode.READ)
    const srcWords = new Uint32Array(srcBuf.getMappedRange().slice(0))
    srcBuf.unmap()
    srcBuf.destroy()
    this.ellipseCacheNonZeroWords = srcWords.reduce((n, w) => n + (w !== 0 ? 1 : 0), 0)
    this.chainProbe = {
      fuelLut: await nonZero(lutBuf),
      rosBase: await nonZero(baseBuf),
      stateWords: await nonZero(stateBuf),
    }

    await phiBuf.mapAsync(GPUMapMode.READ)
    const phi = new Float32Array(phiBuf.getMappedRange().slice(0))
    phiBuf.unmap()
    phiBuf.destroy()
    let neg = 0
    let finite = 0
    let minPhi = Infinity
    for (const v of phi) {
      if (v < 0) neg++
      if (Number.isFinite(v) && Math.abs(v) < 1e6) finite++
      if (v < minPhi) minPhi = v
    }
    await ctlBuf.mapAsync(GPUMapMode.READ)
    const ctl = Array.from(new Uint32Array(ctlBuf.getMappedRange().slice(0)))
    ctlBuf.unmap()
    ctlBuf.destroy()
    this.phiProbe = { negatives: neg, nearField: finite, min: minPhi, control: ctl.slice(0, 12) }
    await buf.mapAsync(GPUMapMode.READ)
    const half = new Uint16Array(buf.getMappedRange().slice(0))
    buf.unmap()
    buf.destroy()

    // Decode IEEE half precision. Only channel 0 (R_head) is inspected.
    const decode = (h: number): number => {
      const s = h & 0x8000 ? -1 : 1
      const e = (h >> 10) & 0x1f
      const f = h & 0x3ff
      if (e === 0) return s * 2 ** -24 * f
      if (e === 31) return f ? NaN : s * Infinity
      return s * 2 ** (e - 15) * (1 + f / 1024)
    }
    let nonZeroTexels = 0
    let maxHead = 0
    const texelsPerRow = bytesPerRow / 2 // in u16 units
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = decode(half[r * texelsPerRow + c * 4] as number)
        if (v !== 0) nonZeroTexels++
        if (v > maxHead) maxHead = v
      }
    }
    return { nonZeroTexels, maxHead }
  }

  /**
   * Advance the surface fire and RETURN the simulated time it advanced by.
   *
   * `timeScale` is consumed here, as substeps, so the caller's `dt` is NOT how far the world
   * moved — it is `scale * dt`. The canopy and the smoke field run on this clock, and passing
   * them the caller's `dt` instead ran them at `1/timeScale` of the fire driving them: at the
   * default 8x the canopy got an eighth of the drying time the surface got, so crowns sat
   * pinned at the water boiling plateau and nothing ever ignited however hard the surface
   * burned. Returning the number is what stops that from being re-derivable per call site.
   */
  step(encoder: GPUCommandEncoder, dt: Seconds): Seconds {
    // Kick off the aggregate readback for the copy the PREVIOUS step submitted, before
    // anything is encoded into this one. `resolve` below skips its copy while this is in
    // flight, so no command in this encoder can reference a buffer with a pending map.
    void this.#burnout.readAggregates()
    const scale = Math.max(1, Math.round(this.timeScale))
    for (let i = 0; i < scale; i++) {
      if (this.#dirty || this.simTimeS >= this.#nextTickS) {
        this.#dirty = false
        this.#nextTickS = this.simTimeS + ROTHERMEL_TICK_S
        this.#ros.encodeMoistureTick(encoder)
        this.#ros.encodeSubstep(encoder, {
          midflameWind: this.#weather.midflameWind,
          windAzimuth: this.#weather.windDirection,
        })
        this.bridge(encoder)
      }
      // Only the last substep encodes a readback. See the note on `SurfaceSolver.step`: the
      // ring defers its map by one call assuming a submit in between, and this loop does not
      // submit. Getting this wrong discards the whole encoder and stops the fire dead.
      this.solver.step(encoder, dt, this.#weather, { readback: i === scale - 1 })
      this.simTimeS += dt
    }
    // Once per step, not once per substep: the burnout curve is a pure function of
    // (now - arrival), so resolving it at the substep rate would cost a full-grid pass per
    // substep and produce the same textures.
    this.#burnout.resolve(encoder, seconds(this.simTimeS), this.predicted.reactionIntensity)
    return seconds(scale * dt)
  }

  /**
   * The on-device acceptance check `solver.ts` asks the integrator for, in its own words:
   * *"the shader compiles; `outputs.burntAreaM2` grows after `ignite()` + a few `step()`s;
   * `activeCellCount` is a small fraction of 4.19 M; `overflowed` is never set."*
   *
   * It cannot run here — Vitest has no WebGPU, so none of this project's WGSL has ever
   * reached a compiler — so it runs in the browser behind `?debug` and prints to the boot
   * screen. **This is the only thing that can distinguish "the solver is wired" from "the
   * solver is wired and works", and nothing in `npm test` can substitute for it.**
   *
   * Destructive: it resets the fire and ignites at the domain centre.
   */
  async selfTest(steps = 600): Promise<string> {
    const scale = this.timeScale
    this.timeScale = 1
    try {
      this.reset()
      this.ignite({
        kind: 'point',
        x: metres(this.cells * this.cellM * 0.5),
        z: metres(this.cells * this.cellM * 0.5),
        radius: metres(5),
      })
      const dt = seconds(1 / 120)
      const dev = this.#device
      // Yield periodically. The solver keeps a 3-deep readback ring whose buffers are
      // recycled by `mapAsync` callbacks, and those callbacks are macrotasks — a tight
      // 600-iteration loop never lets them run, so every step after the third copies into a
      // buffer that is still mapped. WebGPU rejects the submit, the counters never come
      // back, and the test reports "nothing burnt" whether or not anything burnt. The real
      // frame loop yields naturally between steps; only this loop has to do it by hand.
      for (let i = 0; i < steps; i++) {
        const encoder = dev.createCommandEncoder({ label: 'fire.selfTest' })
        this.step(encoder, dt)
        dev.queue.submit([encoder.finish()])
        if ((i & 15) === 15) {
          await dev.queue.onSubmittedWorkDone()
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      await dev.queue.onSubmittedWorkDone()
      // The control-block readback lands on a `mapAsync` promise, so yield the microtask
      // queue and then a macrotask before reading the counters it fills.
      await new Promise((r) => setTimeout(r, 50))

      const rosProbe = await this.probeRosCache()
      await this.probeOutputs()
      const errors = gpuErrors.slice(0, 6)
      // One more readback with nothing else in flight, so the reported area is the state
      // after the final step rather than one step behind it.
      await this.outputs.readAggregates()
      const area = this.outputs.burntAreaM2
      const p = this.predicted
      // A point ignition of radius r growing at the head rate for t seconds sweeps roughly
      // pi*(r + R*t)^2 on level ground; the real front is an ellipse and the terrain has
      // slope, so this is an order-of-magnitude bracket, not a tolerance.
      const expected = Math.PI * (5 + (p.rateOfSpread as number) * this.simTimeS) ** 2
      const cellFraction = this.activeCellCount / (this.cells * this.cells)
      return [
        `fuel model        ${this.fuelModelCode} (id ${this.fuelModelId} of ${this.fuelOrder.length})`,
        `predicted ROS     ${((p.rateOfSpread as number) * 60).toFixed(3)} m/min` +
          (p.extinguished ? '   EXTINGUISHED — nothing can burn at this moisture' : ''),
        `simulated         ${this.simTimeS.toFixed(2)} s over ${steps} fixed steps`,
        `burnt area        ${area.toFixed(1)} m2   (order-of-magnitude expectation ${expected.toFixed(1)} m2)`,
        `perimeter         ${this.outputs.perimeterM.toFixed(1)} m`,
        `active cells      ${this.activeCellCount} (${(cellFraction * 100).toFixed(3)} % of the grid)`,
        `dispatch overflow ${this.dispatchOverflowed ? 'YES — WORK WAS DROPPED' : 'no'}`,
        `rosCache (centre) ${rosProbe.nonZeroTexels}/4096 texels non-zero, max R_head ` +
          `${rosProbe.maxHead.toFixed(4)} m/s (${(rosProbe.maxHead * 60).toFixed(2)} m/min)`,
        `ellipseCache src   ${this.ellipseCacheNonZeroWords}/256 words non-zero ` +
          `(the buffer the bridge copies FROM — zero here means the ROS passes produced nothing)`,
        `chain (per 256 w)  stateWords ${this.chainProbe.stateWords}  ->  fuelLut ` +
          `${this.chainProbe.fuelLut}  ->  rosBase ${this.chainProbe.rosBase}  ->  ellipseCache ` +
          `${this.ellipseCacheNonZeroWords}   (first zero is the broken stage)`,
        `phi @ ignition     ${this.phiProbe.negatives}/256 negative (inside the burn), ` +
          `${this.phiProbe.nearField}/256 near-field, min ${this.phiProbe.min.toExponential(3)}`,
        `control block      [${this.phiProbe.control.join(', ')}]`,
        `WP 2.4 fields      peak intensity ${this.outputProbe.peakIntensity.toFixed(1)} kW/m over ` +
          `${this.outputProbe.burningTexels}/4096 texels, max consumed ` +
          `${(this.outputProbe.maxConsumed * 100).toFixed(1)} %` +
          (this.outputProbe.peakIntensity > 0
            ? ''
            : '   <- ZERO: the burnout resolve is not writing'),
        '',
        errors.length === 0
          ? 'GPU validation    no errors raised'
          : [`GPU validation    ${gpuErrors.length} ERROR(S) - the first is almost always the cause,`]
              .concat(errors.map((e) => `  ${e}`))
              .join(String.fromCharCode(10)),
        '',
        area > 0
          ? 'PASS — the front advanced, so the WGSL compiled and the ROS bridge carries data.'
          : 'FAIL — nothing burnt. Check, in order: the fuel model id is not 0; the moisture ' +
            'is below extinction; the ellipseCache->rosCache copy ran before solver.step().',
      ].join('\n')
    } finally {
      this.timeScale = scale
      this.reset()
    }
  }

  destroy(): void {
    this.solver.destroy()
    this.#ros.destroy()
    this.#grid.destroy()
    this.#rosCache.destroy()
  }

  // -------------------------------------------------------------------------

  /**
   * WP 2.2's `ellipseCache` buffer → WP 2.3's `rosCache` texture. See the module header: the
   * two are byte-identical and this is the whole of the bridge.
   */
  private bridge(encoder: GPUCommandEncoder): void {
    encoder.copyBufferToTexture(
      { buffer: this.#grid.ellipseCache, bytesPerRow: 8 * this.cells, rowsPerImage: this.cells },
      { texture: this.#rosCache },
      [this.cells, this.cells, 1],
    )
  }

  /**
   * Fill every cell with the current fuel model and moisture.
   *
   * ponytail: one fuel model over the whole domain. The upgrade is a per-cell map rasterised
   * from WP 1.3's stem positions and each species' `surfaceFuelModel` + `litterLoad`, which
   * is a real piece of work and belongs with M5's fuel-moisture field rather than here. Until
   * then the fuel bed is uniform, which is also exactly the condition every published
   * benchmark in `npm run validate` is quoted at.
   *
   * `packCell` is the same packer the GPU test asserts byte offsets against, so this cannot
   * drift from `loadCellState` in `common.wgsl`.
   */
  private writeFuelBed(): void {
    const mo = this.#weather.moisture
    const words = packCell({
      fuelModelId: this.fuelModelId,
      flags: FLAG_BURNABLE,
      moisture: [mo.dead1h, mo.dead10h, mo.dead100h, mo.liveHerb, mo.liveWoody],
    })
    for (let p = 0; p < PLANE_COUNT; p++) {
      this.#plane.fill(words[p] as number)
      this.#device.queue.writeBuffer(
        this.#grid.stateWords,
        p * SURFACE_CELL_COUNT * 4,
        this.#plane,
      )
    }
    this.#dirty = true
  }
}

/**
 * The fuel model to burn, from the world's own vegetation.
 *
 * WP 1.3 gives every species a `surfaceFuelModel` (spec §20 §4.3) — the litter it lays down
 * beneath itself. The mix-weighted dominant species' model is the defensible default for a
 * single-model fuel bed; the user can override it. Falls back to `GR2`, the §4.2 benchmark
 * model, if the biome names something WP 2.1's table does not carry.
 */
export function dominantFuelModel(
  speciesMix: Readonly<Record<string, number>>,
  species: ReadonlyMap<string, { readonly surfaceFuelModel: string }>,
): string {
  let best = ''
  let bestWeight = -1
  for (const [id, weight] of Object.entries(speciesMix)) {
    if (weight <= bestWeight) continue
    const code = species.get(id)?.surfaceFuelModel
    if (code === undefined || !FUEL_MODELS.has(code)) continue
    best = code
    bestWeight = weight
  }
  return best === '' ? 'GR2' : best
}

function sameMoisture(
  a: Readonly<Record<FuelSizeClass, number>>,
  b: Readonly<Record<FuelSizeClass, number>>,
): boolean {
  return (
    a.dead1h === b.dead1h &&
    a.dead10h === b.dead10h &&
    a.dead100h === b.dead100h &&
    a.liveHerb === b.liveHerb &&
    a.liveWoody === b.liveWoody
  )
}

/**
 * Build a `SurfaceWeather` from plain numbers, applying the branded units at the boundary.
 * Moisture arrives as a FRACTION here; the UI is what converts from percent, once.
 */
export function weatherFrom(o: {
  readonly windMps: number
  readonly windFromDeg: number
  readonly dead1h: number
  readonly liveHerb: number
}): SurfaceWeather {
  const base = STUB_WEATHER.moisture
  return {
    midflameWind: mps(Math.max(0, o.windMps)),
    // Meteorological convention is the direction wind blows FROM; the shader wants TOWARD.
    windDirection: degToRad((o.windFromDeg + 180) % 360) as Radians,
    moisture: {
      dead1h: moistureFraction(o.dead1h),
      dead10h: moistureFraction(o.dead1h + 0.01),
      dead100h: moistureFraction(o.dead1h + 0.02),
      liveHerb: moistureFraction(o.liveHerb),
      liveWoody: base.liveWoody,
    },
  }
}
