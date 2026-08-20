/**
 * Fuel consumption and burnout — WP 2.4, spec §4.7.
 *
 * Pure. No GPU, no siblings. This is the oracle for `burnout.wgsl`.
 *
 * ## The one idea in this file
 *
 * A cell must **burn down**, not flip state. Rothermel fixes the *energy budget* — heat per
 * unit area `H_A = I_R · t_r` — and says nothing whatever about how that release is
 * distributed in time, nor about what happens after the flaming front passes. So this module
 * models only the time distribution, and it models it so that the totals are exact:
 *
 * - **Mass** drains per size class on that class's own timescale. 1-h fuel and the fine live
 *   classes go in the flaming front (~10-20 s); 10-h takes minutes; 100-h smoulders for
 *   ~13 minutes after the front has gone. Total consumed converges to the total loading
 *   *exactly*, which is this package's acceptance criterion.
 * - **Energy** follows a normalised gamma pulse whose integral is exactly `H_A`.
 *
 * Nothing here re-derives Rothermel. `residenceTime` and `reactionIntensity` are inputs,
 * taken from `SpreadOutputs` (WP 2.1).
 *
 * ## Timescales — provenance
 *
 * Anderson (1969) gives flaming residence time `t_r = 384/σ` minutes with `σ` in ft⁻¹. It is
 * applied here **per size class**, using each class's own SAV, which gives size-ordering for
 * free and introduces no constant that is not in the source:
 *
 * | Class | σ (ft⁻¹) | τ |
 * |---|---|---|
 * | 1-h (GR2) | 2000 | 11.5 s |
 * | 10-h | 109 | 3.5 min |
 * | 100-h | 30 | 12.8 min |
 *
 * That lands the coarse classes inside the spec's stated 10-20 min smouldering band without
 * inventing a second correlation. **It is still an extrapolation:** Anderson fitted fines,
 * and post-frontal consumption is properly the domain of the Albini/Reinhardt duff models
 * this project does not implement. The coarse-class timescales are therefore `estimated`
 * (see `BURNOUT_PROVENANCE`) and `BurnoutParams.timescaleScale` exists so they can be tuned
 * against observation without touching this file.
 */

import { FUEL_SIZE_CLASSES } from '@contracts/sim'
import type { FuelModel, FuelSizeClass } from '@contracts/sim'
import { kgm2, s, toPerFoot } from '@contracts/units'
import type {
  KgPerSquareMetre,
  KilojoulesPerKg,
  KilowattsPerSquareMetre,
  PerMetre,
  Seconds,
} from '@contracts/units'

// ---------------------------------------------------------------------------
// Small typed helpers
// ---------------------------------------------------------------------------

/** Build a full per-class record. Explicit keys so `noUncheckedIndexedAccess` stays happy. */
export const mapSizeClasses = <T>(f: (c: FuelSizeClass) => T): Record<FuelSizeClass, T> => ({
  dead1h: f('dead1h'),
  dead10h: f('dead10h'),
  dead100h: f('dead100h'),
  liveHerb: f('liveHerb'),
  liveWoody: f('liveWoody'),
})

// ---------------------------------------------------------------------------
// The burnout curve
// ---------------------------------------------------------------------------

/**
 * Residual mass fraction at which a class is declared fully consumed.
 *
 * A bare exponential `exp(−t/τ)` never reaches zero, so "total consumed equals total loaded"
 * could only ever hold in the limit — and the consumed-fraction texture would never reach 1,
 * so char/ash materials would never finish. Instead the curve is truncated at 0.1% remaining
 * and renormalised by `1/(1−ε)`, which makes it reach exactly 1.0 at `t = τ·ln(1/ε)` while
 * staying continuous, monotonic and within 0.1% of the exponential everywhere.
 */
export const BURNOUT_RESIDUAL = 1e-3
/** `ln(1/ε)` — burnout completes at `τ · BURNOUT_CUTOFF`. ≈ 6.908. */
export const BURNOUT_CUTOFF = -Math.log(BURNOUT_RESIDUAL)
const RENORM = 1 / (1 - BURNOUT_RESIDUAL)

/**
 * Anderson (1969) flaming residence time, `t_r = 384/σ` [min], σ in ft⁻¹.
 *
 * SAV is stored SI (m⁻¹); the correlation is an English-unit dimensional fit, so it converts
 * at its own boundary per spec §0.6 rule 2.
 */
export function residenceTimeForSav(sav: PerMetre): Seconds {
  const savFt = toPerFoot(sav)
  if (!(savFt > 0) || !Number.isFinite(savFt)) {
    throw new Error(`residenceTimeForSav: SAV must be finite and positive, got ${sav} m^-1`)
  }
  return s((384 / savFt) * 60)
}

/**
 * Fraction of one size class consumed `t` seconds after ignition. Monotonic non-decreasing,
 * 0 at t≤0, exactly 1 at t ≥ τ·BURNOUT_CUTOFF.
 */
export function classConsumedFraction(tSinceIgnition: Seconds, tau: Seconds): number {
  if (!(tSinceIgnition > 0)) return 0
  if (tSinceIgnition >= tau * BURNOUT_CUTOFF) return 1
  return (1 - Math.exp(-tSinceIgnition / tau)) * RENORM
}

/** d/dt of {@link classConsumedFraction} — the shape of the mass-loss (soot source) curve. */
export function classMassLossRate(tSinceIgnition: Seconds, tau: Seconds): number {
  if (!(tSinceIgnition > 0) || tSinceIgnition >= tau * BURNOUT_CUTOFF) return 0
  return (Math.exp(-tSinceIgnition / tau) / tau) * RENORM
}

// ---------------------------------------------------------------------------
// Per-cell burnout model
// ---------------------------------------------------------------------------

export interface BurnoutParams {
  /**
   * Per-class multiplier on the Anderson timescale. The calibration knob: the coarse-class
   * values are an extrapolation and real smouldering varies with duff depth, packing and
   * moisture in ways nothing here sees. Default 1 everywhere = pure Anderson.
   */
  readonly timescaleScale: Readonly<Record<FuelSizeClass, number>>
}

export const DEFAULT_BURNOUT_PARAMS: BurnoutParams = {
  timescaleScale: mapSizeClasses(() => 1),
}

/** Everything the burnout of one fuel model needs, precomputed once per model. */
export interface CellBurnoutModel {
  readonly code: string
  /** Per-class e-folding time. */
  readonly tau: Readonly<Record<FuelSizeClass, Seconds>>
  /** Per-class oven-dry loading, copied so the model is self-contained. */
  readonly load: Readonly<Record<FuelSizeClass, KgPerSquareMetre>>
  /** Per-class share of the total loading. Sums to 1 (or all-zero for a bare cell). */
  readonly loadFraction: Readonly<Record<FuelSizeClass, number>>
  readonly totalLoad: KgPerSquareMetre
  /**
   * Flaming residence time of the *bed* — from `SpreadOutputs.residenceTime` (WP 2.1), which
   * uses Rothermel's surface-area-weighted characteristic σ. Sets the flaming band width
   * (`D = R·t_r`) and the width of the heat-release pulse. Deliberately NOT the same as
   * `tau.dead1h`: that one is a single class's own SAV.
   */
  readonly residenceTime: Seconds
  /** Time from ignition at which every class with load has finished. */
  readonly burnoutTime: Seconds
}

export function burnoutModelFor(
  fuel: FuelModel,
  residenceTime: Seconds,
  params: BurnoutParams = DEFAULT_BURNOUT_PARAMS,
): CellBurnoutModel {
  if (!(residenceTime > 0) || !Number.isFinite(residenceTime)) {
    throw new Error(`burnoutModelFor(${fuel.code}): residenceTime must be finite > 0`)
  }

  const tau = mapSizeClasses((c) => {
    const load = fuel.load[c]
    // A class with no load has no burnout curve; a class with load but no SAV is a broken
    // fuel table, and a broken fuel table is exactly the silent-wrong-fire failure mode.
    if (load <= 0) return s(1)
    const scale = params.timescaleScale[c]
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new Error(`burnoutModelFor(${fuel.code}): timescaleScale.${c} must be finite > 0`)
    }
    return s(residenceTimeForSav(fuel.sav[c]) * scale)
  })

  const totalLoad = FUEL_SIZE_CLASSES.reduce((sum, c) => sum + fuel.load[c], 0)
  const loadFraction = mapSizeClasses((c) => (totalLoad > 0 ? fuel.load[c] / totalLoad : 0))

  const burnoutTime = FUEL_SIZE_CLASSES.reduce(
    (worst, c) => (fuel.load[c] > 0 ? Math.max(worst, tau[c] * BURNOUT_CUTOFF) : worst),
    0,
  )

  return {
    code: fuel.code,
    tau,
    load: mapSizeClasses((c) => fuel.load[c]),
    loadFraction,
    totalLoad: kgm2(totalLoad),
    residenceTime,
    burnoutTime: s(burnoutTime),
  }
}

// ---------------------------------------------------------------------------
// Queries — all pure functions of (model, time since ignition)
// ---------------------------------------------------------------------------

/**
 * Mass-weighted fraction of the cell's total loading consumed. This is what goes into
 * `IFireOutputs.consumedTexture` and what the char/ash materials read.
 *
 * Being a pure function of the arrival time is not a convenience — it is what makes the
 * output fields order-independent. See `fields.ts`.
 */
export function consumedFraction(model: CellBurnoutModel, tSinceIgnition: Seconds): number {
  if (model.totalLoad <= 0) return 0
  let f = 0
  for (const c of FUEL_SIZE_CLASSES) {
    if (model.load[c] <= 0) continue
    f += model.loadFraction[c] * classConsumedFraction(tSinceIgnition, model.tau[c])
  }
  return f
}

export function consumedByClass(
  model: CellBurnoutModel,
  tSinceIgnition: Seconds,
): Record<FuelSizeClass, KgPerSquareMetre> {
  return mapSizeClasses((c) =>
    kgm2(model.load[c] * classConsumedFraction(tSinceIgnition, model.tau[c])),
  )
}

export function remainingByClass(
  model: CellBurnoutModel,
  tSinceIgnition: Seconds,
): Record<FuelSizeClass, KgPerSquareMetre> {
  return mapSizeClasses((c) =>
    kgm2(model.load[c] * (1 - classConsumedFraction(tSinceIgnition, model.tau[c]))),
  )
}

/** Total mass-loss rate [kg m⁻² s⁻¹] — the soot and smoke source term for M3/M4. */
export function massLossRate(model: CellBurnoutModel, tSinceIgnition: Seconds): number {
  let r = 0
  for (const c of FUEL_SIZE_CLASSES) {
    if (model.load[c] <= 0) continue
    r += model.load[c] * classMassLossRate(tSinceIgnition, model.tau[c])
  }
  return r
}

// ---------------------------------------------------------------------------
// Energy: heat per unit area and the release pulse
// ---------------------------------------------------------------------------

/**
 * `H_A = I_R · t_r` — heat per unit area of the flaming front [kJ m⁻²].
 *
 * kW m⁻² × s = kJ m⁻². Spec §4.7 states this in BTU ft⁻²; the SI form is exact, not a refit.
 */
export function heatPerUnitArea(
  reactionIntensity: KilowattsPerSquareMetre,
  residenceTime: Seconds,
): number {
  return reactionIntensity * residenceTime
}

/**
 * Normalised gamma pulse, spec §4.7: `q̇(t) = H_A·(t/τ²)·exp(−t/τ)` with `τ = t_r/2`.
 * Returns kW m⁻². Peaks at `t = τ`; `∫₀^∞ q̇ dt = H_A` exactly.
 *
 * This is the fire-lighting and plume-forcing source. It is deliberately a *shape*: the
 * total is Rothermel's, only the distribution is modelled.
 */
export function heatReleaseRate(
  heatArea: number,
  tSinceIgnition: Seconds,
  residenceTime: Seconds,
): KilowattsPerSquareMetre {
  if (!(tSinceIgnition > 0)) return 0 as KilowattsPerSquareMetre
  const tau = residenceTime / 2
  const x = tSinceIgnition / tau
  return ((heatArea * x * Math.exp(-x)) / tau) as KilowattsPerSquareMetre
}

/** Cumulative form of {@link heatReleaseRate} [kJ m⁻²]: `H_A·(1 − (1 + t/τ)·e^{−t/τ})`. */
export function heatReleased(
  heatArea: number,
  tSinceIgnition: Seconds,
  residenceTime: Seconds,
): number {
  if (!(tSinceIgnition > 0)) return 0
  const x = tSinceIgnition / (residenceTime / 2)
  return heatArea * (1 - (1 + x) * Math.exp(-x))
}

/**
 * Mass the flaming front actually consumes, implied by Rothermel's own energy budget:
 * `w_a = H_A / h` [kg m⁻²].
 *
 * The bridge between the two equivalent statements of Byram intensity in spec §4.7 —
 * `I_B = H_A·R` and `I_B = h·w_a·R`. It is always a *fraction* of the total loading, because
 * `I_R` already carries the mineral, moisture and packing damping: the rest of the mass burns
 * post-frontally and contributes to smoke, not to fireline intensity. That distinction is the
 * whole reason this module tracks mass per class rather than one lumped number.
 */
export function flamingConsumption(heatArea: number, heatContent: KilojoulesPerKg): KgPerSquareMetre {
  if (!(heatContent > 0)) throw new Error('flamingConsumption: heatContent must be > 0')
  return kgm2(heatArea / heatContent)
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

