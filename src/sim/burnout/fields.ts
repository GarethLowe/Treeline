/**
 * The output fields of `IFireOutputs`, on the CPU — WP 2.4.
 *
 * This is the oracle for `burnout.wgsl`, and it is also where run-to-run determinism is
 * *designed in* rather than hoped for.
 *
 * ## Why the fields are order-independent
 *
 * Thousands of cells write these fields concurrently from a compute shader, in whatever order
 * the scheduler picks. Determinism therefore cannot come from ordering; it has to come from
 * the combining operations themselves. So the field set is arranged so that only two things
 * are ever accumulated, and both are idempotent and commutative:
 *
 * | Field | Combiner | Why it is safe |
 * |---|---|---|
 * | arrival time | `min` | commutative, associative, idempotent |
 * | peak intensity | `max` | likewise |
 *
 * **Everything else is derived.** `state` and `consumed` are pure functions of
 * `(arrivalTime, fuel model, now)`, so they cannot carry a race at all. That is the whole
 * trick: the alternative — accumulating consumed mass incrementally per substep — would make
 * the result depend on how many substeps ran and in what order they landed, and the CSV
 * export at M6 would stop being reproducible.
 *
 * On the GPU both combiners run as `atomicMin`/`atomicMax` over the **bit patterns** of
 * non-negative f32 values. IEEE-754 orders non-negative floats identically to their unsigned
 * bit patterns, so that is exact, not an approximation — {@link f32Bits} and the test beside
 * it pin it.
 */

import { CELL_BURNING, CELL_BURNT, CELL_UNBURNT, SURFACE_CELL_M } from '@contracts/sim'
import type { CellState } from '@contracts/sim'
import { kWm, s } from '@contracts/units'
import type { KilowattsPerMetre, Seconds } from '@contracts/units'
import { consumedFraction } from './consumption.ts'
import type { CellBurnoutModel } from './consumption.ts'

/**
 * "Has not arrived" sentinel: the largest finite f32.
 *
 * Finite rather than `Infinity` on purpose. `Infinity` in an r32float texture turns any
 * downstream `now − arrival` into `NaN`, and a NaN that reaches a render path is a black
 * screen three milestones from here. A huge finite value just makes every comparison false.
 */
export const ARRIVAL_NEVER = 3.4028234663852886e38
/** Bit pattern of {@link ARRIVAL_NEVER} — the value `clear_accumulators` writes. */
export const ARRIVAL_NEVER_BITS = 0x7f7fffff

/**
 * Staircase-perimeter debias, `π/4`.
 *
 * Summing exposed cell edges measures the L1 (taxicab) length of the boundary, which
 * overestimates the Euclidean length of a smooth boundary by `E[|cosθ| + |sinθ|] = 4/π ≈ 1.27`
 * averaged over orientation. Multiplying by `π/4` makes the estimator unbiased for a boundary
 * of arbitrary orientation — which a fire perimeter is. It is *not* unbiased for an
 * axis-aligned rectangle, where it reads ~21% low; a burn scar shaped like a field boundary
 * will under-report. Documented rather than corrected, because the correction has no
 * defensible form for mixed cases.
 */
export const PERIMETER_DEBIAS = Math.PI / 4

const scratch = new DataView(new ArrayBuffer(4))

/** Bit pattern of an f32, as an unsigned integer. Mirrors WGSL `bitcast<u32>`. */
export function f32Bits(v: number): number {
  scratch.setFloat32(0, v, true)
  return scratch.getUint32(0, true)
}

/** Inverse of {@link f32Bits}. */
export function bitsToF32(bits: number): number {
  scratch.setUint32(0, bits >>> 0, true)
  return scratch.getFloat32(0, true)
}

export interface FireAggregates {
  readonly burntAreaM2: number
  readonly perimeterM: number
  readonly maxFirelineIntensity: KilowattsPerMetre
}

/**
 * CPU mirror of the GPU output fields. Sized `n × n`; the shipping grid is
 * `SURFACE_CELLS`² but tests run small.
 *
 * Arrays are laid out and quantised exactly as the textures are, so a readback of the GPU
 * fields can be compared to this byte for byte.
 */
export class FireOutputFields {
  readonly n: number
  /** Seconds. `ARRIVAL_NEVER` where the front has not reached. Combined with `min`. */
  readonly arrivalTime: Float32Array
  /** kW m⁻¹. Peak Byram intensity seen by this cell. Combined with `max`. */
  readonly peakIntensity: Float32Array
  /** `CELL_UNBURNT` / `CELL_BURNING` / `CELL_BURNT`. Derived. r8uint. */
  readonly state: Uint8Array
  /** Consumed fraction of total loading, quantised as r8unorm. Derived. */
  readonly consumed: Uint8Array
  /** Index into the burnout model table, per cell. */
  readonly fuelIndex: Uint8Array

  constructor(n: number) {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`FireOutputFields: bad grid size ${n}`)
    this.n = n
    const cells = n * n
    this.arrivalTime = new Float32Array(cells)
    this.peakIntensity = new Float32Array(cells)
    this.state = new Uint8Array(cells)
    this.consumed = new Uint8Array(cells)
    this.fuelIndex = new Uint8Array(cells)
    this.reset()
  }

  reset(): void {
    this.arrivalTime.fill(ARRIVAL_NEVER)
    this.peakIntensity.fill(0)
    this.state.fill(CELL_UNBURNT)
    this.consumed.fill(0)
  }

  /** `atomicMin` on arrival. Rejects non-finite and negative times rather than poisoning min. */
  recordArrival(index: number, time: Seconds): void {
    if (!(time >= 0) || !Number.isFinite(time)) return
    const prev = this.arrivalTime[index]
    if (prev === undefined) return
    // Float32Array rounds on store, and rounding is monotonic, so min-then-round and
    // round-then-min agree. Order independence survives the narrowing.
    if (time < prev) this.arrivalTime[index] = time
  }

  /** `atomicMax` on peak fireline intensity [kW m⁻¹]. */
  recordIntensity(index: number, intensity: KilowattsPerMetre): void {
    if (!(intensity >= 0) || !Number.isFinite(intensity)) return
    const prev = this.peakIntensity[index]
    if (prev === undefined) return
    if (intensity > prev) this.peakIntensity[index] = intensity
  }

  /**
   * Derive `state` and `consumed` from the accumulated arrival times. Idempotent: calling it
   * twice with the same `now` is a no-op, and it never reads its own previous output.
   *
   * `models` is indexed by `fuelIndex`.
   */
  resolve(now: Seconds, models: readonly CellBurnoutModel[]): void {
    if (models.length === 0) throw new Error('FireOutputFields.resolve: empty model table')
    for (let i = 0; i < this.arrivalTime.length; i++) {
      const arrival = this.arrivalTime[i] as number
      if (!(arrival <= now)) {
        this.state[i] = CELL_UNBURNT
        this.consumed[i] = 0
        continue
      }
      const model = models[this.fuelIndex[i] as number] ?? models[0]
      if (model === undefined) throw new Error('FireOutputFields.resolve: bad model index')
      const dt = s(now - arrival)
      // Flaming while within the bed's residence time; BURNT thereafter — but `consumed`
      // keeps climbing, because the coarse classes are still smouldering. The three-value
      // state enum is a rendering/lifecycle label, not a statement that combustion stopped.
      this.state[i] = (dt < model.residenceTime ? CELL_BURNING : CELL_BURNT) satisfies CellState
      this.consumed[i] = quantiseUnorm8(consumedFraction(model, dt))
    }
  }

  /**
   * Brute-force recount of the HUD/CSV aggregates. The GPU accumulates these with atomics in
   * the same pass that writes the textures; this is what the test compares against.
   *
   * `cellM` defaults to the shipping 0.5 m cell.
   */
  aggregate(cellM: number = SURFACE_CELL_M): FireAggregates {
    const n = this.n
    let burnt = 0
    let edges = 0
    let maxI = 0
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const intensity = this.peakIntensity[i] as number
        if (intensity > maxI) maxI = intensity
        if (!this.hasArrived(i)) continue
        burnt++
        // Off-grid counts as unburnt, so a fire running off the domain edge still reports a
        // closed perimeter rather than silently losing that side.
        if (x === 0 || !this.hasArrived(i - 1)) edges++
        if (x === n - 1 || !this.hasArrived(i + 1)) edges++
        if (y === 0 || !this.hasArrived(i - n)) edges++
        if (y === n - 1 || !this.hasArrived(i + n)) edges++
      }
    }
    return {
      burntAreaM2: burnt * cellM * cellM,
      perimeterM: edges * cellM * PERIMETER_DEBIAS,
      maxFirelineIntensity: kWm(maxI),
    }
  }

  private hasArrived(index: number): boolean {
    return (this.arrivalTime[index] as number) < ARRIVAL_NEVER
  }
}

/** r8unorm quantisation, matching what the GPU does on `textureStore` to an r8unorm target. */
export function quantiseUnorm8(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v
  return Math.round(c * 255)
}
