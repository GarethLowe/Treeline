/**
 * Rothermel (1972) as implemented, in TypeScript.
 *
 * **This is a STUB of WP 2.1**, which owns the real pure kernel. It exists because WP 2.2's
 * acceptance criterion is "GPU output matches the 2.1 oracle", and 2.1 does not exist yet.
 * It is not a mock: it is the same formulation, in the same units, pinned to the same
 * published worked example, so the WGSL is being checked against real physics rather than
 * against itself. When 2.1 lands, `test/sim/surface/gpu.test.ts` swaps oracle by changing
 * the one import at the top of that file — the sweep, the tolerances and the packing all
 * stay put.
 *
 * ## Structure, and why it is split this way
 *
 * Spec §4.3's critical optimisation is that every σ-dependent coefficient depends on the
 * *fuel model*, not the cell. So the algebra is split in two:
 *
 *   `buildCoefficients(fuel, cure)` — everything that does not depend on per-cell moisture,
 *   wind or slope. This runs on the CPU, 16 cure bins per model, and is uploaded as a
 *   read-only storage buffer. The GPU never evaluates Γ′, ξ, β_op, C, B, E or the Albini
 *   size-class weights.
 *
 *   `spread(coeff, moisture, wind, slope)` — the ~20 FLOP + 2 `pow` the GPU actually runs.
 *   Transliterated in `shaders/sim/surface/ros_base.wgsl` and `ros_substep.wgsl`.
 *
 * ## Units
 *
 * Everything inside this module is **English (BTU-lb-ft-min)**, because that is the system
 * Rothermel's coefficients are dimensional fits in and converting them breaks every published
 * cross-check (§0.6 rule 2). Conversion happens at `spreadFromSI()`, the only exported
 * function that speaks the contract's SI types. Moisture is a **fraction** throughout, on
 * both sides of the boundary — it has no unit and never needs converting, which is exactly
 * why a stray ×100 is invisible.
 */

import { toBtuPerLb, toFeet, toLbPerFt2, toPerFoot } from '@contracts/units'
import type { FuelModel } from '@contracts/sim'
import { FUEL_SIZE_CLASS_ORDER } from '@sim/rothermel/fuelModels.ts'

/** Rothermel 1972: oven-dry particle density, total mineral content, effective mineral content. */
export const RHO_P_LB_FT3 = 32
export const S_T = 0.0555
export const S_E = 0.0100
/** Eq. 30. 0.174·S_e^−0.19 = 0.4174, capped at 1. */
export const ETA_S = Math.min(0.174 * S_E ** -0.19, 1)

/** §4.9: φ_s is validated to ~30% slope and grows as tan² without restraint above it. */
export const MAX_SLOPE_TANGENT = 0.7

/** Moisture channels, in the order they are packed into the cell state. */
export const CH_DEAD_1H = 0
export const CH_DEAD_10H = 1
export const CH_DEAD_100H = 2
export const CH_LIVE_HERB = 3
export const CH_LIVE_WOODY = 4
export type MoistureVector = readonly [number, number, number, number, number]

// ---------------------------------------------------------------------------
// Fuel-only coefficients — what gets uploaded to the GPU
// ---------------------------------------------------------------------------

export interface RothermelCoefficients {
  /** Γ′ · η_s [min⁻¹]. */
  readonly gammaEtaS: number
  /** w_n,dead · h [BTU ft⁻²]. Net load already carries Albini's size-class weights. */
  readonly wnDeadH: number
  readonly wnLiveH: number
  /** ξ / ρ_b [ft³ lb⁻¹]. */
  readonly xiOverRhoB: number
  /** f_i · f_ij · exp(−138/σ_ij), summed onto the 5 stored moisture channels. */
  readonly kHeat: MoistureVector
  /** 250 · Σ kHeat — the moisture-independent half of the heat sink. */
  readonly kHeatQ0: number
  /** Dead moisture of extinction, FRACTION. */
  readonly mxDead: number
  /** 2.9·W from Eq. 88. Zero when the bed has no live load, which disables the live branch. */
  readonly mxLiveW: number
  /** Within-dead-category surface-area weights, folded onto the 3 dead channels. */
  readonly fDead: readonly [number, number, number]
  /** Within-live-category weights, herb and woody. */
  readonly fLive: readonly [number, number]
  /** Normalised exp(−138/σ) dead weights for M′_f in Eq. 88. */
  readonly wpDead: readonly [number, number, number]
  /** C · (β/β_op)^−E, so φ_w = windC · U^B with U in ft min⁻¹ — one pow, not three. */
  readonly windC: number
  readonly windB: number
  /** 1/B, for the Eq. 47 inversion that gives effective wind. */
  readonly windInvB: number
  /** 5.275 · β^−0.3, so φ_s = slopeK · tan²φ. */
  readonly slopeK: number
  /** Anderson (1969) t_r = 384/σ, in SECONDS. */
  readonly residenceSeconds: number
  /** Characteristic SAV [ft⁻¹] — reported, and what t_r came from. */
  readonly savFt: number
  /** Diagnostics, not consumed by the shader. */
  readonly beta: number
  readonly betaRatio: number
  readonly rhoB: number
  readonly reactionVelocity: number
  readonly xi: number
}

interface Particle {
  readonly savFt: number
  readonly loadLbFt2: number
  readonly live: boolean
  /** Which of the 5 stored moisture channels drives this particle. */
  readonly channel: number
}

/**
 * Albini (1976) size-class bins, ft⁻¹. Within a category the `f_ij` are summed per bin and
 * the bin total is the `g_ij` of every particle in that bin — NOT of the largest particle
 * only. The distinction is load-bearing: the two readings differ by 7.7× on GR2 D2L2, and
 * only the bin-total reading reproduces spec §4.2's published `I_R ≈ 1.15×10³`. It is also
 * what `firelib`/BehavePlus do. (Spec §4.3's prose says "assigned wholly to the largest class
 * present in each bin"; the arithmetic in §4.2 contradicts the prose, and the arithmetic
 * wins — reported as a spec issue.)
 */
function sizeClassBin(savFt: number): number {
  if (savFt >= 1200) return 0
  if (savFt >= 192) return 1
  if (savFt >= 96) return 2
  if (savFt >= 48) return 3
  if (savFt >= 16) return 4
  return 5
}

/** §4.3 dynamic transfer, in FRACTION form. Published as `T = 1.333 − 0.0111·M_herb%`. */
export const curingFromHerbMoisture = (herbMoistureFraction: number): number =>
  Math.min(1, Math.max(0, 1.333 - 1.11 * herbMoistureFraction))

/**
 * Explode a fuel model at a given curing fraction into English-unit particles.
 *
 * For a dynamic model, `T·w_herb` moves to the DEAD category but keeps `σ_herb`, and takes
 * its moisture from the dead 1-h channel. It is therefore a sixth particle, not an addition
 * to the 1-h load — a detail that changes the characteristic σ and hence every coefficient.
 */
function particles(fuel: FuelModel, cure: number): Particle[] {
  // The English-unit boundary of the kernel (§0.6 rule 2). Every conversion below goes
  // through a named helper in @contracts/units, so `grep toLbPerFt2` finds them all.
  const load = FUEL_SIZE_CLASS_ORDER.map((c) => toLbPerFt2(fuel.load[c]) as number)
  const sav = FUEL_SIZE_CLASS_ORDER.map((c) => toPerFoot(fuel.sav[c]) as number)
  const T = fuel.type === 'dynamic' ? Math.min(1, Math.max(0, cure)) : 0

  const herb = load[CH_LIVE_HERB] ?? 0
  const out: Particle[] = [
    { savFt: sav[CH_DEAD_1H]!, loadLbFt2: load[CH_DEAD_1H]!, live: false, channel: CH_DEAD_1H },
    { savFt: sav[CH_DEAD_10H]!, loadLbFt2: load[CH_DEAD_10H]!, live: false, channel: CH_DEAD_10H },
    { savFt: sav[CH_DEAD_100H]!, loadLbFt2: load[CH_DEAD_100H]!, live: false, channel: CH_DEAD_100H },
    // Cured herbaceous, now dead, still at σ_herb, drying on the 1-h channel.
    { savFt: sav[CH_LIVE_HERB]!, loadLbFt2: T * herb, live: false, channel: CH_DEAD_1H },
    { savFt: sav[CH_LIVE_HERB]!, loadLbFt2: (1 - T) * herb, live: true, channel: CH_LIVE_HERB },
    { savFt: sav[CH_LIVE_WOODY]!, loadLbFt2: load[CH_LIVE_WOODY]!, live: true, channel: CH_LIVE_WOODY },
  ]
  return out.filter((p) => p.loadLbFt2 > 0 && p.savFt > 0)
}

export function buildCoefficients(fuel: FuelModel, cure: number): RothermelCoefficients {
  const ps = particles(fuel, cure)
  const heatBtuLb = toBtuPerLb(fuel.heatContent) as number

  // --- Surface-area weighting (§4.4) -------------------------------------
  const area = ps.map((p) => (p.savFt * p.loadLbFt2) / RHO_P_LB_FT3)
  const areaDead = ps.reduce((t, p, i) => (p.live ? t : t + area[i]!), 0)
  const areaLive = ps.reduce((t, p, i) => (p.live ? t + area[i]! : t), 0)
  const areaAll = areaDead + areaLive
  if (areaAll <= 0) return inertCoefficients(fuel)

  const fCat = { dead: areaDead / areaAll, live: areaLive / areaAll }
  const fij = ps.map((p, i) => {
    const denom = p.live ? areaLive : areaDead
    return denom > 0 ? area[i]! / denom : 0
  })

  const sigmaDead = ps.reduce((t, p, i) => (p.live ? t : t + fij[i]! * p.savFt), 0)
  const sigmaLive = ps.reduce((t, p, i) => (p.live ? t + fij[i]! * p.savFt : t), 0)
  const sigma = fCat.dead * sigmaDead + fCat.live * sigmaLive

  // --- Packing ratio and reaction velocity -------------------------------
  const depthFt = toFeet(fuel.depth) as number
  const totalLoad = ps.reduce((t, p) => t + p.loadLbFt2, 0)
  const rhoB = totalLoad / depthFt
  const beta = rhoB / RHO_P_LB_FT3
  const betaOp = 3.348 * sigma ** -0.8189 // Eq. 37
  const betaRatio = beta / betaOp
  const A = 133 * sigma ** -0.7913 // Albini 1976 refit of Eq. 39
  const gammaMax = sigma ** 1.5 / (495 + 0.0594 * sigma ** 1.5) // Eq. 36
  const gamma = gammaMax * betaRatio ** A * Math.exp(A * (1 - betaRatio))
  const xi = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192 + 0.2595 * sigma) // Eq. 42

  // --- Net load with Albini size-class weights (§4.4) ---------------------
  const binSum = [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ]
  ps.forEach((p, i) => {
    binSum[p.live ? 1 : 0]![sizeClassBin(p.savFt)]! += fij[i]!
  })
  let wnDead = 0
  let wnLive = 0
  ps.forEach((p) => {
    const g = binSum[p.live ? 1 : 0]![sizeClassBin(p.savFt)]!
    const wn = g * p.loadLbFt2 * (1 - S_T) // Eq. 24
    if (p.live) wnLive += wn
    else wnDead += wn
  })

  // --- Heat sink weights (Eqs. 12 & 14), folded onto the 5 stored channels -
  const kHeat: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  ps.forEach((p, i) => {
    const eps = Math.exp(-138 / p.savFt) // Eq. 14
    kHeat[p.channel]! += (p.live ? fCat.live : fCat.dead) * fij[i]! * eps
  })
  const kHeatQ0 = 250 * kHeat.reduce((t, k) => t + k, 0)

  // --- Live moisture of extinction, Eq. 88 -------------------------------
  // Note the asymmetric exponents: −138 for dead, −500 for live.
  const deadHeat = ps.map((p) => (p.live ? 0 : p.loadLbFt2 * Math.exp(-138 / p.savFt)))
  const liveHeat = ps.map((p) => (p.live ? p.loadLbFt2 * Math.exp(-500 / p.savFt) : 0))
  const deadHeatSum = deadHeat.reduce((t, v) => t + v, 0)
  const liveHeatSum = liveHeat.reduce((t, v) => t + v, 0)
  const wpDead: [number, number, number] = [0, 0, 0]
  if (deadHeatSum > 0) {
    ps.forEach((p, i) => {
      if (!p.live) wpDead[p.channel]! += deadHeat[i]! / deadHeatSum
    })
  }
  const mxLiveW = liveHeatSum > 0 ? (2.9 * deadHeatSum) / liveHeatSum : 0

  // --- Within-category moisture weights, folded onto the channels ---------
  const fDead: [number, number, number] = [0, 0, 0]
  const fLive: [number, number] = [0, 0]
  ps.forEach((p, i) => {
    if (p.live) fLive[p.channel - CH_LIVE_HERB]! += fij[i]!
    else fDead[p.channel]! += fij[i]!
  })

  // --- Wind and slope (Eqs. 47-51) ---------------------------------------
  const C = 7.47 * Math.exp(-0.133 * sigma ** 0.55)
  const B = 0.02526 * sigma ** 0.54
  const E = 0.715 * Math.exp(-3.59e-4 * sigma)

  return {
    gammaEtaS: gamma * ETA_S,
    wnDeadH: wnDead * heatBtuLb,
    wnLiveH: wnLive * heatBtuLb,
    xiOverRhoB: xi / rhoB,
    kHeat,
    kHeatQ0,
    mxDead: fuel.moistureOfExtinctionDead as number,
    mxLiveW,
    fDead,
    fLive,
    wpDead,
    windC: C * betaRatio ** -E,
    windB: B,
    windInvB: 1 / B,
    slopeK: 5.275 * beta ** -0.3,
    residenceSeconds: (384 / sigma) * 60, // Anderson 1969, min → s
    savFt: sigma,
    beta,
    betaRatio,
    rhoB,
    reactionVelocity: gamma,
    xi,
  }
}

/** A bed with no fuel: everything zero, so `R = 0` and nothing divides by zero. */
function inertCoefficients(fuel: FuelModel): RothermelCoefficients {
  return {
    gammaEtaS: 0,
    wnDeadH: 0,
    wnLiveH: 0,
    xiOverRhoB: 0,
    kHeat: [0, 0, 0, 0, 0],
    kHeatQ0: 1,
    mxDead: Math.max(1e-6, fuel.moistureOfExtinctionDead as number),
    mxLiveW: 0,
    fDead: [0, 0, 0],
    fLive: [0, 0],
    wpDead: [0, 0, 0],
    windC: 0,
    windB: 1,
    windInvB: 1,
    slopeK: 0,
    residenceSeconds: 1,
    savFt: 1,
    beta: 0,
    betaRatio: 0,
    rhoB: 1,
    reactionVelocity: 0,
    xi: 0,
  }
}

// ---------------------------------------------------------------------------
// What was deleted from here, 2026-08-20
// ---------------------------------------------------------------------------
//
// The CONTRACT-level API that used to follow `kernel()` — `rothermelROS`, `SpreadOptions`,
// `byramIntensity`, `flameLength`, `windToFeetPerMinute` — was a third public transcription of
// Rothermel, after `sim/rothermel/kernel.ts` (the shipping model and validation oracle) and the
// WP 2.5 stub. It had no production caller and is gone.
//
// Everything above stays, and is NOT duplication:
//   - `buildCoefficients` factors the algebra into its moisture-INDEPENDENT half so the shader
//     evaluates a cell in a few multiplies. `rothermelIntermediates` cannot do that; it takes
//     moisture as an input.
//   - `kernel()` is the CPU MIRROR of the shader's per-cell evaluation over that record. It is
//     what makes the LUT and the cure interpolation testable without a GPU.

// ---------------------------------------------------------------------------
// The per-cell evaluation — the part the shader runs
// ---------------------------------------------------------------------------

/** Eq. 29, clamped. `r_M ≥ 1` ⇒ `η_M = 0` and the cell cannot burn. */
export function moistureDamping(ratio: number): number {
  if (ratio >= 1) return 0
  const r = Math.max(0, ratio)
  return Math.min(1, Math.max(0, 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r))
}

/** §4.5 wind limit. Default `sanity` per the spec decision: no hard cap, inert rail only. */
export type WindLimitMode = 'none' | 'sanity' | 'behave'
export const DEFAULT_WIND_LIMIT: WindLimitMode = 'sanity'

export interface KernelResult {
  /** ft min⁻¹. */
  readonly rateOfSpread: number
  readonly noWindNoSlopeRate: number
  /** BTU ft⁻² min⁻¹. */
  readonly reactionIntensity: number
  readonly windFactor: number
  readonly slopeFactor: number
  /** ft min⁻¹. */
  readonly effectiveWind: number
  readonly lengthToBreadth: number
  readonly extinguished: boolean
}

/**
 * §4.6 elliptical length-to-breadth, Anderson (1983) form, `U_eff` in mi h⁻¹.
 *
 * **Status `estimated`.** Spec §4.6 carries a live OPEN QUESTION on these exponents: neither
 * reference implementation agrees with them or with each other, and one of the two is wrong
 * by the 2.237 mi h⁻¹-per-m s⁻¹ factor. WP 2.3 owns closing it. It is isolated in this one
 * function so that closing it is a one-function edit and not a hunt.
 */
export function lengthToBreadth(effectiveWindFtMin: number): number {
  const mph = effectiveWindFtMin / 88 // 1 mi h⁻¹ = 88 ft min⁻¹, exact
  return Math.min(0.936 * Math.exp(0.2566 * mph) + 0.461 * Math.exp(-0.1548 * mph) - 0.397, 8)
}

/**
 * The whole per-cell kernel, English units in and out.
 *
 * `windFtMin` is MIDFLAME wind, already through the §4.5 WAF chain. `slopeTangent` is
 * upslope-positive; downslope gives `φ_s = 0` (Eq. 51). Wind and slope are treated as
 * aligned here, which is what the scalar `SpreadInputs` contract expresses; the shader does
 * the vector combination of §4.5 with the terrain aspect and passes the resultant magnitude.
 */
export function kernel(
  c: RothermelCoefficients,
  moisture: MoistureVector,
  windFtMin: number,
  slopeTangent: number,
  windLimit: WindLimitMode = DEFAULT_WIND_LIMIT,
): KernelResult {
  // --- Heat source ------------------------------------------------------
  const mDead = c.fDead[0] * moisture[0] + c.fDead[1] * moisture[1] + c.fDead[2] * moisture[2]
  const mLive = c.fLive[0] * moisture[3] + c.fLive[1] * moisture[4]
  const mPrime = c.wpDead[0] * moisture[0] + c.wpDead[1] * moisture[1] + c.wpDead[2] * moisture[2]

  const mxLive =
    c.mxLiveW > 0 ? Math.max(c.mxLiveW * (1 - mPrime / c.mxDead) - 0.226, c.mxDead) : c.mxDead

  const etaMDead = moistureDamping(mDead / c.mxDead)
  const etaMLive = c.mxLiveW > 0 ? moistureDamping(mLive / mxLive) : 0

  const reactionIntensity = c.gammaEtaS * (c.wnDeadH * etaMDead + c.wnLiveH * etaMLive)

  // --- Heat sink: ρ_b · Σ f_i f_ij ε_ij (250 + 1116 M_ij), Eqs. 12 & 14 ---
  const sinkOverRhoB =
    c.kHeatQ0 +
    1116 *
      (c.kHeat[0] * moisture[0] +
        c.kHeat[1] * moisture[1] +
        c.kHeat[2] * moisture[2] +
        c.kHeat[3] * moisture[3] +
        c.kHeat[4] * moisture[4])

  const noWindNoSlopeRate =
    sinkOverRhoB > 0 ? (reactionIntensity * c.xiOverRhoB) / sinkOverRhoB : 0

  // --- Wind and slope factors -------------------------------------------
  const u = Math.max(0, windFtMin)
  const windFactor = u > 0 ? c.windC * u ** c.windB : 0
  const tanPhi = Math.min(Math.max(slopeTangent, 0), MAX_SLOPE_TANGENT)
  const slopeFactor = c.slopeK * tanPhi * tanPhi

  // --- Effective wind, then the cap, then the ellipse (§4.5 order) -------
  let phiE = windFactor + slopeFactor
  let effectiveWind = phiE > 0 && c.windC > 0 ? (phiE / c.windC) ** c.windInvB : 0
  let rateOfSpread = noWindNoSlopeRate * (1 + phiE)

  if (windLimit === 'behave') {
    // Cap the WIND and re-evaluate. Clamping R directly gives different numbers and will not
    // reproduce BehavePlus (§4.5, firelab/behave surfaceFire.cpp:384-392).
    const limit = 0.9 * reactionIntensity
    if (effectiveWind > limit) {
      effectiveWind = limit
      phiE = c.windC * effectiveWind ** c.windB
      rateOfSpread = noWindNoSlopeRate * (1 + phiE)
    }
  } else if (windLimit === 'sanity') {
    // The 2013 substitute: an inert rail against pathological wind fields. R/U_eff runs
    // 0.01-0.2 in reality, so this never binds; it only stops a NaN wind producing a NaN fire.
    rateOfSpread = Math.min(rateOfSpread, Math.max(effectiveWind, noWindNoSlopeRate))
  }

  return {
    rateOfSpread,
    noWindNoSlopeRate,
    reactionIntensity,
    windFactor,
    slopeFactor,
    effectiveWind,
    lengthToBreadth: lengthToBreadth(effectiveWind),
    extinguished: noWindNoSlopeRate <= 0,
  }
}

// ---------------------------------------------------------------------------
// SI boundary — the contract-facing entry point
// ---------------------------------------------------------------------------
