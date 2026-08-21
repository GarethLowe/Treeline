/**
 * WP 3.5 — Van Wagner crown fire initiation, active crowning and classification.
 * Spec §30 §7.1.
 *
 * Pure scalar arithmetic. No GPU, no siblings, no state. Every function here is CLI-testable
 * and that is deliberate: spec §7.1 is explicit that Van Wagner's criteria are **validators
 * and HUD diagnostics, not the mechanism that drives spread**. The 3D voxel canopy (WP 3.1-3.4)
 * does the actual heat transfer; this file is the yardstick that says whether the voxel model
 * is calibrated. A yardstick that only runs on a GPU is not a yardstick.
 *
 * ## Cost
 *
 * ~8 flops, two `pow`s and one `exp` per `evaluateCrownFire` call. `ICanopySolver.crownState`
 * is one state for the whole domain, so this runs **once per canopy step**, not per voxel and
 * not per frame. **Measured** at 78 ns/call on the target i9-13900HX under Node (see
 * `vanWagner.test.ts`, "cost"), i.e. 5e-6 of a 16.6 ms frame even if it ran every frame.
 * There is nothing here to amortise and no cheaper formulation worth having; §0.5.1's trade
 * does not arise.
 *
 * ## The three numbers, and what is wrong with them
 *
 * 1. **`I_0 = (0.01 · CBH · (460 + 25.9 · FMC))^1.5`** — the 1/100 is an empirical divisor
 *    fitted to a *single red pine observation*. `CrownTuning.initiationScale` exists so a
 *    biome can move it; the default reproduces Van Wagner exactly.
 * 2. **`S_0 = 0.05 kg m⁻² s⁻¹`** — one fire in a red pine plantation, cross-checked against
 *    Thomas (1963) lab beds. Equivalent to `R'_active = 3.0/CBD` in m min⁻¹, which is the
 *    same constant in different clothes, not independent support.
 * 3. **CFB** — computed here as a *diagnostic only*. Cruz & Alexander (2010) name
 *    "reduction in crown fire rate of spread [via] unsubstantiated crown fraction burned
 *    functions" as one of four principal sources of the systematic **under-prediction bias**
 *    in linked Rothermel-Van Wagner systems. This module therefore never returns a spread
 *    multiplier, and `evaluateCrownFire` prefers the measured voxel consumption fraction
 *    whenever the canopy solver supplies one.
 *
 * See `provenance.ts` for the full critique record; it is `ModelProvenance.openQuestions`,
 * not a comment, because §0.7.4 puts it in front of the user.
 */

import type { CrownFireClass, CrownFireState } from '@contracts/sim.ts'
import { fracToPct, kWm, mps } from '@contracts/units.ts'
import type {
  KgPerCubicMetre,
  KilojoulesPerKg,
  KilowattsPerMetre,
  Metres,
  MetresPerSecond,
  MoistureFraction,
} from '@contracts/units.ts'

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

/** Heat of ignition of foliage at zero moisture, kJ/kg. Van Wagner (1977). */
export const HEAT_OF_IGNITION_DRY = 460

/** Heat of ignition added per *percent* foliar moisture, kJ/kg/%. Van Wagner (1977). */
export const HEAT_OF_IGNITION_PER_FMC_PERCENT = 25.9

/**
 * The empirical divisor in `I_0 = (h·CBH/100)^1.5`. Fitted to one red pine observation and,
 * per spec §7.1, "the weakest number in operational fire science".
 */
export const INITIATION_DIVISOR = 100

/**
 * Van Wagner's critical horizontal mass flow rate for a solid crown flame, kg m⁻² s⁻¹.
 * `R'_active = S_0/CBD` in m/s is identical to the more familiar `3.0/CBD` in m/min.
 */
export const CRITICAL_MASS_FLOW_RATE = 0.05

/**
 * Foliar moisture band Van Wagner's criteria were fitted over (boreal/Canadian conifer),
 * as a FRACTION per §0.6 rule 3. Cruz & Alexander (2014) via spec §7.1.
 */
export const VAN_WAGNER_FMC_ENVELOPE: readonly [MoistureFraction, MoistureFraction] = [
  0.95 as MoistureFraction,
  1.35 as MoistureFraction,
]

/** Van Wagner (1993) dynamic CFB: `a = −ln(0.1)/(0.9·ΔR)`. The numerator. */
const NEG_LN_0_1 = 2.302585092994046

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The two calibration knobs this model exposes. Both default to Van Wagner's published
 * values; both exist because both published values come from a single observation each and
 * the biomes outside the boreal-conifer envelope will need to move them (spec §7.7 step 6).
 */
export interface CrownTuning {
  /** Multiplies `I_0`. 1 = Van Wagner. Per-biome, per spec §7.1's "must be exposed as a tunable". */
  readonly initiationScale: number
  /** `S_0`, kg m⁻² s⁻¹. 0.05 = Van Wagner. */
  readonly criticalMassFlowRate: number
}

export const DEFAULT_CROWN_TUNING: CrownTuning = {
  initiationScale: 1,
  criticalMassFlowRate: CRITICAL_MASS_FLOW_RATE,
}

/**
 * Stand-level canopy fuel description. All three fields come from M1 vegetation data — see
 * `stand.ts` for the aggregation. Nothing new is invented here.
 *
 * `canopyBulkDensity` is the **stand** (canopy) figure, not `Stem.crownBulkDensity`, which is
 * within-crown and several times larger. M1's `species.ts` header settles that distinction;
 * getting it backwards makes every stand crown actively.
 */
export interface StandCrownParams {
  /** Height above ground of the base of the continuous canopy fuel layer, m. */
  readonly canopyBaseHeight: Metres
  /** Stand canopy bulk density, kg m⁻³. */
  readonly canopyBulkDensity: KgPerCubicMetre
  /** Live foliar moisture, FRACTION of oven-dry mass (§0.6 rule 3). */
  readonly foliarMoisture: MoistureFraction
}

export interface CrownFireInput {
  readonly stand: StandCrownParams
  /** Byram surface fireline intensity from the surface solver, kW/m. */
  readonly surfaceIntensity: KilowattsPerMetre
  /** Surface head-fire rate of spread, m/s. Paired with `surfaceIntensity`. */
  readonly surfaceRos: MetresPerSecond
  /**
   * Forward rate of spread of the *crown* front, m/s — from the 3D canopy solver. Before
   * crowning starts this is just the surface ROS; the caller passes what it has.
   */
  readonly crownRos: MetresPerSecond
  /**
   * Fraction of crown fuel consumed, **measured from the canopy voxel field** (WP 3.1/3.3).
   * Spec §7.1: this is the preferred source and the Van Wagner CFB curve is only a stand-in.
   * Supplying it also unlocks detection of independent crown fire, which by definition is a
   * crown that is burning while the surface is not driving it.
   */
  readonly measuredCrownConsumedFraction?: number
  readonly tuning?: CrownTuning
}

/** `CrownFireState` (frozen contract) plus the working values the HUD and §7.7 tests want. */
export interface CrownFireResult extends CrownFireState {
  /** `R'_active = S_0/CBD`, m/s. Infinite when there is no canopy fuel. */
  readonly criticalActiveRos: MetresPerSecond
  /** `R'_init`: the surface ROS at which `I_surf` would reach `I_0`, m/s. */
  readonly criticalInitiationRos: MetresPerSecond
  /** `S = R_crown · CBD`, kg m⁻² s⁻¹. Compare against `S_0`. */
  readonly massFlowRate: number
  /** True when `crownFractionBurned` came from the Van Wagner curve, not the voxel field. */
  readonly crownFractionBurnedIsDiagnostic: boolean
  /**
   * What Van Wagner's curve says, ALWAYS, even when the measured value is the one reported.
   *
   * Two independent answers to the same question: an empirical nomogram fitted to Canadian
   * conifer, and a count of what a 3D voxel canopy actually consumed. Reporting only one of
   * them means a disagreement between them can never be noticed, and for the whole of M3 they
   * disagreed as completely as two numbers can — the curve read 94 % on a stand where the
   * canopy reported 0 %. That is the single most informative comparison this model can make
   * about itself, so it is computed whether or not it is used.
   */
  readonly curveCrownFractionBurned: number
  /** Non-empty when this stand sits outside Van Wagner's validated envelope. Surface it. */
  readonly envelopeWarnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Initiation
// ---------------------------------------------------------------------------

/**
 * Heat of ignition of foliage, `h = 460 + 25.9·FMC` kJ/kg, FMC in **percent**.
 *
 * The percent conversion is the whole reason this is a named function: the published
 * coefficient is per-percent and the project stores a fraction, so `25.9 * fmc` with a
 * fraction is off by 100× and produces `h ≈ 460` — a stand that torches at any intensity.
 */
export function heatOfIgnition(fmc: MoistureFraction): KilojoulesPerKg {
  return (HEAT_OF_IGNITION_DRY +
    HEAT_OF_IGNITION_PER_FMC_PERCENT * fracToPct(fmc)) as KilojoulesPerKg
}

/**
 * Van Wagner (1977) critical surface fireline intensity for crown initiation, kW/m.
 *
 *     I_0 = (0.01 · CBH · (460 + 25.9·FMC))^1.5
 *
 * CBH = 3 m, FMC = 100 % → 875 kW/m (Scott & Reinhardt 2001 worked example).
 *
 * A non-positive CBH returns 0: fuel continuous to the ground has no initiation threshold at
 * all. That is the physically right answer for chaparral and gorse and it is also outside the
 * model's envelope — `evaluateCrownFire` flags it rather than pretending the number means
 * something.
 */
export function criticalInitiationIntensity(
  canopyBaseHeight: Metres,
  fmc: MoistureFraction,
  tuning: CrownTuning = DEFAULT_CROWN_TUNING,
): KilowattsPerMetre {
  if (!(canopyBaseHeight > 0)) return kWm(0)
  const x = (canopyBaseHeight * heatOfIgnition(fmc)) / INITIATION_DIVISOR
  return kWm(tuning.initiationScale * Math.pow(x, 1.5))
}

/**
 * `R'_init`, m/s: the surface rate of spread at which surface intensity would equal `I_0`.
 *
 * Derived from the `(I, R)` pair the surface solver already exports rather than from `H` and
 * `w` separately, because Byram's `I = H·w·R` is linear in `R` at fixed fuel — so
 * `R'_init = R_surf · I_0/I_surf` needs no fuel constants and cannot drift out of step with
 * whatever the surface layer actually did.
 */
export function criticalInitiationSpreadRate(
  criticalIntensity: KilowattsPerMetre,
  surfaceIntensity: KilowattsPerMetre,
  surfaceRos: MetresPerSecond,
): MetresPerSecond {
  if (!(surfaceIntensity > 0) || !(surfaceRos > 0)) return mps(Infinity)
  return mps((surfaceRos * criticalIntensity) / surfaceIntensity)
}

// ---------------------------------------------------------------------------
// Active crowning
// ---------------------------------------------------------------------------

/** `S = R_crown · CBD`, kg m⁻² s⁻¹ — Van Wagner's horizontal mass flow through the crown. */
export function crownMassFlowRate(
  crownRos: MetresPerSecond,
  canopyBulkDensity: KgPerCubicMetre,
): number {
  return Math.max(0, crownRos) * Math.max(0, canopyBulkDensity)
}

/**
 * `R'_active = S_0/CBD`, m/s — the minimum crown-front spread rate that sustains a solid
 * flame. CBD = 0.2 kg m⁻³ → 0.25 m/s = 15 m/min, the spec's check value.
 *
 * Returns `Infinity` for a stand with no canopy fuel: no spread rate crowns an empty canopy.
 */
export function criticalActiveSpreadRate(
  canopyBulkDensity: KgPerCubicMetre,
  tuning: CrownTuning = DEFAULT_CROWN_TUNING,
): MetresPerSecond {
  if (!(canopyBulkDensity > 0)) return mps(Infinity)
  return mps(tuning.criticalMassFlowRate / canopyBulkDensity)
}

// ---------------------------------------------------------------------------
// Crown fraction burned — DIAGNOSTIC ONLY
// ---------------------------------------------------------------------------

/**
 * Van Wagner (1993) crown fraction burned, `CFB = 1 − exp(−a·(R − R'_init))` with the dynamic
 * coefficient `a = −ln(0.1)/(0.9·(R'_active − R'_init))`.
 *
 * Unit-safe in SI: `a` scales as 1/R and `x` as R, so the product is invariant and the m/min
 * convention the literature quotes needs no conversion. Reproduces Scott & Reinhardt Appendix
 * A exactly — jack pine ΔR = 10.74 m/min → a = 0.238; mature stand ΔR = 23.69 → a = 0.108.
 *
 * **Not a spread-rate modifier.** Cruz & Alexander (2010) identify exactly that use as one of
 * the four sources of under-prediction bias in linked systems. `evaluateCrownFire` returns
 * this only when the voxel field has not supplied a measured consumption fraction, and flags
 * it when it does.
 */
export function vanWagnerCrownFractionBurned(
  crownRos: MetresPerSecond,
  criticalInitiationRos: MetresPerSecond,
  criticalActiveRos: MetresPerSecond,
): number {
  if (!Number.isFinite(criticalInitiationRos)) return 0
  const x = crownRos - criticalInitiationRos
  if (!(x > 0)) return 0
  const deltaR = criticalActiveRos - criticalInitiationRos
  // Degenerate stand: the active threshold sits at or below the initiation threshold, so
  // anything that initiates is already fully involved. The exponential would divide by <= 0.
  if (!(deltaR > 0)) return 1
  const a = NEG_LN_0_1 / (0.9 * deltaR)
  return Math.min(1, 1 - Math.exp(-a * x))
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Van Wagner (1977) / Alexander (1988) classification.
 *
 * - `none`      — surface fire: `I_surf < I_0`.
 * - `passive`   — torching: `I_surf ≥ I_0` but `S < S_0`.
 * - `active`    — both thresholds exceeded.
 * - `independent` — crown burning and `S ≥ S_0` while `I_surf < I_0`. Documented so rarely
 *   (Huff 1988; Van Wagner 1993) that spec §7.1 says to let the 3D solver produce it
 *   emergently and label it, and not to calibrate to it. It is therefore only reachable when
 *   the caller supplies a measured crown consumption fraction — i.e. when the voxel field is
 *   *observing* a burning crown, never from a prediction.
 */
export function classifyCrownFire(
  surfaceIntensity: KilowattsPerMetre,
  criticalIntensity: KilowattsPerMetre,
  massFlowRate: number,
  criticalMassFlowRate: number,
  crownIsBurning: boolean,
): CrownFireClass {
  const activeFlow = massFlowRate >= criticalMassFlowRate
  // Zero-intensity guard: a stand with CBH <= 0 has I_0 = 0, and without this an unignited
  // domain would classify as crowning.
  const initiated = surfaceIntensity > 0 && surfaceIntensity >= criticalIntensity
  if (!initiated) return crownIsBurning && activeFlow ? 'independent' : 'none'
  return activeFlow ? 'active' : 'passive'
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Spec §7.1's envelope warning, as data. Van Wagner's criteria were fitted to boreal conifer
 * at FMC 95-135 % with a real canopy base height; §0.7.4 says confidence is surfaced to the
 * user rather than buried, so these strings are meant for the HUD.
 */
export function envelopeWarnings(stand: StandCrownParams): readonly string[] {
  const out: string[] = []
  if (!(stand.canopyBaseHeight > 0)) {
    out.push(
      'Canopy base height is zero: fuel is vertically continuous, so I_0 has no meaning. ' +
        'Van Wagner initiation does not apply (spec §7.1 — chaparral, gorse). Calibrate ' +
        'against Cruz fuel-strata-gap / Vesta / gorse ROS data instead.',
    )
  }
  const [lo, hi] = VAN_WAGNER_FMC_ENVELOPE
  if (stand.foliarMoisture < lo || stand.foliarMoisture > hi) {
    out.push(
      `Foliar moisture ${fracToPct(stand.foliarMoisture).toFixed(0)}% is outside the ` +
        `${fracToPct(lo).toFixed(0)}-${fracToPct(hi).toFixed(0)}% band Van Wagner's criteria ` +
        'were fitted over (Cruz & Alexander 2014). I_0 is extrapolated.',
    )
  }
  if (!(stand.canopyBulkDensity > 0)) {
    out.push('No canopy fuel: crown fire is impossible by construction, not by threshold.')
  }
  return out
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Everything above, assembled into the frozen `CrownFireState` plus diagnostics.
 *
 * Call once per canopy step. See the file header for cost.
 */
export function evaluateCrownFire(input: CrownFireInput): CrownFireResult {
  const tuning = input.tuning ?? DEFAULT_CROWN_TUNING
  const { stand } = input

  const criticalIntensity = criticalInitiationIntensity(
    stand.canopyBaseHeight,
    stand.foliarMoisture,
    tuning,
  )
  const criticalActiveRos = criticalActiveSpreadRate(stand.canopyBulkDensity, tuning)
  const criticalInitiationRos = criticalInitiationSpreadRate(
    criticalIntensity,
    input.surfaceIntensity,
    input.surfaceRos,
  )
  const massFlowRate = crownMassFlowRate(input.crownRos, stand.canopyBulkDensity)

  const measured = input.measuredCrownConsumedFraction
  const hasMeasured = measured !== undefined && Number.isFinite(measured)
  const crownIsBurning = hasMeasured && measured > 0

  const classification =
    stand.canopyBulkDensity > 0
      ? classifyCrownFire(
          input.surfaceIntensity,
          criticalIntensity,
          massFlowRate,
          tuning.criticalMassFlowRate,
          crownIsBurning,
        )
      : 'none'

  const curveCrownFractionBurned =
    classification === 'none'
      ? 0
      : vanWagnerCrownFractionBurned(input.crownRos, criticalInitiationRos, criticalActiveRos)
  const crownFractionBurned = hasMeasured
    ? Math.min(1, Math.max(0, measured))
    : curveCrownFractionBurned

  return {
    classification,
    criticalIntensity,
    crownFractionBurned,
    criticalActiveRos,
    criticalInitiationRos,
    massFlowRate,
    crownFractionBurnedIsDiagnostic: !hasMeasured,
    curveCrownFractionBurned,
    envelopeWarnings: envelopeWarnings(stand),
  }
}
