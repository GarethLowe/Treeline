/**
 * The Rothermel (1972) surface fire spread kernel — WP 2.1, the oracle for the WGSL port.
 *
 * Spec §4.2-§4.5. Equation numbers below are Rothermel's own unless marked otherwise.
 *
 * **Unit boundary.** Rothermel's coefficients are dimensional fits in BTU-lb-ft-min. Converting
 * them to SI would change ~20 published constants and break every cross-check against BEHAVE.
 * So this module converts SI -> English on entry and English -> SI on exit, and the coefficients
 * are transcribed exactly as printed. `rothermelIntermediates` exposes the English internals so
 * a test can assert the boundary at a known point rather than trusting it.
 *
 * **Moisture is a fraction throughout.** Nothing here multiplies or divides by 100. The one
 * published equation stated in percent — the §4.3 curing transfer `T = 1.333 - 0.0111*M_herb%`
 * — appears below in its fraction form `T = 1.333 - 1.11*M_herb`, with the identity noted.
 */

import type { FuelModel, SpreadInputs, SpreadOutputs } from '@contracts/sim.ts'
import type {
  BtuPerSquareFootMinute,
  FeetPerMinute,
  KilowattsPerMetre,
  KilowattsPerSquareMetre,
  Metres,
  MetresPerSecond,
  MoistureFraction,
  PerMetre,
  Seconds,
} from '@contracts/units.ts'
import {
  FACTORS,
  fromBtuPerFt2Min,
  fromFeetPerMinute,
  kWm,
  m,
  moistureFraction,
  mps,
  s,
  toBtuPerLb,
  toFeet,
  toFeetPerMinute,
  toLbPerFt2,
  toPerFoot,
} from '@contracts/units.ts'

// `units.ts` deliberately exports no constructors for the English brands: English quantities
// exist only inside a kernel, and this is the kernel. Nothing English leaves this file.
const asFtMin = (v: number): FeetPerMinute => v as FeetPerMinute
const asBtuFt2Min = (v: number): BtuPerSquareFootMinute => v as BtuPerSquareFootMinute

// ---------------------------------------------------------------------------
// Constants — all English, all from the sources named
// ---------------------------------------------------------------------------

/** Oven-dry particle density, lb/ft^3 (spec §4.1, §4.3). */
const RHO_P = 32
/** Total mineral content (Eq. 24). */
const S_T = 0.0555
/** Effective (silica-free) mineral content (Eq. 30). */
const S_E = 0.01
/** Spec §4.9: phi_s grows as tan^2 with no restraint above ~30% slope. Clamp at 35 degrees. */
const MAX_SLOPE_TAN = 0.7
/** Spec §4.6 / GTR-371 §6.2 p. 87. */
const MAX_LENGTH_TO_BREADTH = 8
/** Rothermel 1972 p. 33 wind limit: U_eff <= 0.9*I_R, both in the English system. */
const WIND_LIMIT_COEFF = 0.9

// ---------------------------------------------------------------------------
// The §4.5 wind-limit forms, exported so the validation harness can anchor each one
// separately. `rothermelSpread` applies them through `SpreadOptions`; these are the bare
// relations, which is what the published cases quote.
// ---------------------------------------------------------------------------

/** Largest slope the model is defined on, as a tangent. */
export const MAX_SLOPE_TANGENT = MAX_SLOPE_TAN

/** Rothermel (1972) p. 33, the legacy BEHAVE cap: `U_eff <= 0.9 I_R`, ft/min from BTU/ft^2/min. */
export const behaveWindLimitFtMin = (irBtuFt2Min: number): number => WIND_LIMIT_COEFF * irBtuFt2Min

/** Andrews, Cruz & Rothermel (2013), the revised form: `96.8 I_R^(1/3)`. */
export const revisedWindLimitFtMin = (irBtuFt2Min: number): number => 96.8 * irBtuFt2Min ** (1 / 3)

/** The sanity rail: `R_head <- min(R_head, U_eff)`. Inert at realistic spread rates. */
export const applyRosRail = (rHeadFtMin: number, uEffFtMin: number): number =>
  uEffFtMin > 0 ? Math.min(rHeadFtMin, uEffFtMin) : rHeadFtMin

/** BTU ft^-1 min^-1 -> kW m^-1. */
export const BTUFTMIN_TO_KWM = FACTORS.BTUFT2MIN_TO_KWM2 * 0.3048
/** BTU ft^-1 s^-1 -> kW m^-1. */
export const BTUFTSEC_TO_KWM = BTUFTMIN_TO_KWM * 60
/** Spec §4.5: U_10m -> U_20ft. */
const WIND_10M_TO_20FT = 1.15
const FT_MIN_PER_MI_H = 5280 / 60

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SpreadOptions {
  /**
   * The legacy `U_eff <= 0.9*I_R` cap, implemented as BEHAVE does it: cap the *wind* and
   * re-evaluate, never clamp the ROS (spec §4.5). Default **false** — the model authors,
   * Rothermel included, recommend no wind limit be imposed, and firelab/behave never applies it.
   * Exists for cross-checking against BehavePlus.
   */
  readonly legacyWindLimit?: boolean
  /**
   * The `R_head <- min(R_head, U_eff)` sanity rail from the Andrews, Cruz & Rothermel (2013)
   * abstract. Default **true**, and inert at realistic spread rates (R/U_eff ~ 0.01-0.2); it
   * only guards against pathological wind fields.
   */
  readonly spreadRateRail?: boolean
}

const DEFAULTS = { legacyWindLimit: false, spreadRateRail: true } as const

// ---------------------------------------------------------------------------
// Curing and the dynamic load transfer (spec §4.3)
// ---------------------------------------------------------------------------

/**
 * Cure fraction from live herbaceous moisture. Scott & Burgan (2005) publish this in percent as
 * `T = 1.333 - 0.0111*M_herb%`; since `M_herb% = 100*M_herb`, the fraction form is
 * `T = 1.333 - 1.11*M_herb`, which is what is evaluated.
 *
 * Anchors from the source document: 0.30 -> fully cured, 1.20 -> fully green, 0.60 -> 2/3 cured.
 */
export function curingFraction(liveHerbMoisture: MoistureFraction): number {
  return clamp(1.333 - 1.11 * liveHerbMoisture, 0, 1)
}

// ---------------------------------------------------------------------------
// Midflame wind (spec §4.5)
// ---------------------------------------------------------------------------

/** The `ln[(20 + 0.36H)/(0.13H)]` term both WAF forms share. H in feet. */
const wafLog = (heightFt: number): number =>
  Math.log((20 + 0.36 * heightFt) / (0.13 * heightFt))

/** Unsheltered fuel, crown fill f < 0.05. `H` is the fuel bed depth. */
export function unshelteredWaf(fuelBedDepth: Metres): number {
  const h = toFeet(fuelBedDepth)
  if (h <= 0) return 0
  return clamp(1.83 / wafLog(h), 0, 1)
}

/**
 * Sheltered fuel, crown fill `f = (CC/3)*CR >= 0.05`. `H` is the *canopy* height, not the fuel
 * bed depth — the single easiest thing to get wrong here.
 */
export function shelteredWaf(canopyHeight: Metres, canopyCover: number, crownRatio: number): number {
  const h = toFeet(canopyHeight)
  const f = (canopyCover / 3) * crownRatio
  if (h <= 0 || f <= 0) return 0
  return clamp(0.555 / (Math.sqrt(f * h) * wafLog(h)), 0, 1)
}

export interface CanopyShelter {
  readonly height: Metres
  /** Canopy cover, fraction 0-1. */
  readonly cover: number
  /** Crown ratio, fraction 0-1. */
  readonly crownRatio: number
}

/** Picks the sheltered or unsheltered form on the crown fill threshold f = 0.05. */
export function midflameWindAdjustment(
  fuelBedDepth: Metres,
  canopy?: CanopyShelter,
): number {
  if (canopy === undefined) return unshelteredWaf(fuelBedDepth)
  const f = (canopy.cover / 3) * canopy.crownRatio
  return f < 0.05
    ? unshelteredWaf(fuelBedDepth)
    : shelteredWaf(canopy.height, canopy.cover, canopy.crownRatio)
}

/** `U_10m -> U_20ft -> U_mid`. The 1.15 is the 10 m to 20 ft reduction (spec §4.5). */
export function midflameWind(wind10m: MetresPerSecond, waf: number): MetresPerSecond {
  return mps((wind10m / WIND_10M_TO_20FT) * waf)
}

// ---------------------------------------------------------------------------
// Fuel bed assembly
// ---------------------------------------------------------------------------

interface Particle {
  /** lb/ft^2 */
  readonly load: number
  /** ft^-1 */
  readonly sav: number
  readonly moisture: MoistureFraction
}

/**
 * Albini's six size-class bins, ft^-1 (spec §4.4). Net load uses the summed bin weight `g_ij`,
 * not the surface-area weight `f_ij`; skipping this is the classic reimplementation bug.
 */
function sizeClassBin(sav: number): number {
  if (sav >= 1200) return 0
  if (sav >= 192) return 1
  if (sav >= 96) return 2
  if (sav >= 48) return 3
  if (sav >= 16) return 4
  return 5
}

interface Category {
  /** Total surface area per unit ground area, ft^2/ft^2. Zero when the category is absent. */
  readonly area: number
  /** Characteristic SAV of the category, ft^-1. */
  readonly sav: number
  /** Mineral-free net load, lb/ft^2, using Albini's g_ij size-class weights. */
  readonly netLoad: number
  /** Surface-area-weighted moisture, fraction. */
  readonly moisture: MoistureFraction
  /** `sum_j f_ij * exp(-138/sigma_ij) * (250 + 1116*M_ij)`, the category's heat-sink term. */
  readonly heatSinkTerm: number
}

function buildCategory(particles: readonly Particle[]): Category {
  const areas = particles.map((p) => (p.sav * p.load) / RHO_P)
  const total = areas.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    return { area: 0, sav: 0, netLoad: 0, moisture: moistureFraction(0), heatSinkTerm: 0 }
  }

  const f = areas.map((a) => a / total)

  // g_ij: each class takes the summed f of every class sharing its size-class bin
  // (Albini 1976; GTR-371 §3.2.2). Where one class occupies a bin alone, g_ij == f_ij.
  const bins = [0, 0, 0, 0, 0, 0]
  particles.forEach((p, i) => {
    const b = sizeClassBin(p.sav)
    bins[b] = (bins[b] ?? 0) + (f[i] ?? 0)
  })

  let sav = 0
  let netLoad = 0
  let moisture = 0
  let heatSinkTerm = 0
  particles.forEach((p, i) => {
    const fi = f[i] ?? 0
    const gi = bins[sizeClassBin(p.sav)] ?? 0
    sav += fi * p.sav
    netLoad += gi * p.load * (1 - S_T) // Eq. 24
    moisture += fi * p.moisture
    // Eq. 14 effective heating number, Eq. 12 heat of preignition, per particle.
    heatSinkTerm += fi * Math.exp(-138 / p.sav) * (250 + 1116 * p.moisture)
  })

  return { area: total, sav, netLoad, moisture: moistureFraction(moisture), heatSinkTerm }
}

/**
 * Live moisture of extinction (Eq. 88). Not tabulated — derived from how dry the fine dead fuel
 * is. Note the asymmetric exponents: -138 for dead, -500 for live.
 */
function liveMoistureOfExtinction(
  dead: readonly Particle[],
  live: readonly Particle[],
  mxDead: number,
): number {
  let deadWeighted = 0
  let deadMoistureWeighted = 0
  for (const p of dead) {
    if (p.load <= 0 || p.sav <= 0) continue
    const w = p.load * Math.exp(-138 / p.sav)
    deadWeighted += w
    deadMoistureWeighted += w * p.moisture
  }
  let liveWeighted = 0
  for (const p of live) {
    if (p.load <= 0 || p.sav <= 0) continue
    liveWeighted += p.load * Math.exp(-500 / p.sav)
  }
  if (liveWeighted <= 0 || deadWeighted <= 0) return mxDead

  const W = deadWeighted / liveWeighted
  const fineDeadMoisture = deadMoistureWeighted / deadWeighted
  return Math.max(2.9 * W * (1 - fineDeadMoisture / mxDead) - 0.226, mxDead)
}

/**
 * Moisture damping, Eq. 29. Clamped to [0,1]; r_M >= 1 gives 0 and the fuel cannot burn.
 *
 * The `1 - EXTINCTION_EPS` cutoff is not cosmetic. The polynomial is exactly zero at r = 1 by
 * construction (1 - 2.59 + 5.11 - 3.52 = 0), so a category whose moisture is *at* extinction
 * lands on a cancellation and returns float noise instead of zero — enough to make
 * `extinguished` disagree between this f64 oracle and the f32 WGSL port, which is the one place
 * the two must agree exactly. One part in 10^6 of r costs ~3e-6 of eta_M: nothing physical.
 */
const EXTINCTION_EPS = 1e-6

function moistureDamping(moisture: number, mx: number): number {
  if (mx <= 0) return 0
  const r = moisture / mx
  if (r >= 1 - EXTINCTION_EPS) return 0
  return clamp(1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r, 0, 1)
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

/**
 * Everything the kernel computes, in its native English units, so WP 2.2 can be diffed against
 * this term by term rather than only on the final ROS, and so a test can assert the unit
 * boundary at a known point.
 */
export interface RothermelIntermediates {
  /** ft^-1, surface-area weighted across both categories. */
  readonly sav: number
  /** lb/ft^3, total (dead + live) load over depth. */
  readonly bulkDensity: number
  readonly packingRatio: number
  readonly optimumPackingRatio: number
  readonly relativePackingRatio: number
  /** min^-1 */
  readonly reactionVelocity: number
  readonly propagatingFluxRatio: number
  /** BTU/ft^2/min */
  readonly reactionIntensity: number
  readonly windFactor: number
  readonly slopeFactor: number
  /** ft/min, after any cap. */
  readonly effectiveWind: number
  /** BTU/ft^3 */
  readonly heatSink: number
  /** ft/min */
  readonly noWindNoSlopeRate: number
  /** ft/min, after any cap or rail. */
  readonly rateOfSpread: number
  /** min */
  readonly residenceTime: number
  /** BTU/ft/min */
  readonly firelineIntensity: number
  readonly deadMoistureDamping: number
  readonly liveMoistureDamping: number
  readonly liveMoistureOfExtinction: number
  readonly lengthToBreadth: number
  /** `0.9*I_R` in ft/min. Reported always; applied only when `legacyWindLimit` is on. */
  readonly windLimit: number
  readonly windLimitApplied: boolean
  /** Fraction of live herbaceous load transferred to dead 1-h. 0 for static models. */
  readonly curedTransfer: number
  /** Wind-factor coefficients, exposed because they are pure functions of sigma (spec §4.3). */
  readonly C: number
  readonly B: number
  readonly E: number
  readonly extinguished: boolean
}

const EMPTY: RothermelIntermediates = {
  sav: 0,
  bulkDensity: 0,
  packingRatio: 0,
  optimumPackingRatio: 0,
  relativePackingRatio: 0,
  reactionVelocity: 0,
  propagatingFluxRatio: 0,
  reactionIntensity: 0,
  windFactor: 0,
  slopeFactor: 0,
  effectiveWind: 0,
  heatSink: 0,
  noWindNoSlopeRate: 0,
  rateOfSpread: 0,
  residenceTime: 0,
  firelineIntensity: 0,
  deadMoistureDamping: 0,
  liveMoistureDamping: 0,
  liveMoistureOfExtinction: 0,
  lengthToBreadth: 1,
  windLimit: 0,
  windLimitApplied: false,
  curedTransfer: 0,
  C: 0,
  B: 0,
  E: 0,
  extinguished: true,
}

/** Splits a fuel model into English-unit particles, applying the dynamic curing transfer. */
function particles(fuel: FuelModel, inputs: SpreadInputs): {
  dead: Particle[]
  live: Particle[]
  transfer: number
  totalLoad: number
} {
  const load = (c: keyof FuelModel['load']): number => toLbPerFt2(fuel.load[c])
  const sav = (c: keyof FuelModel['sav']): number => toPerFoot(fuel.sav[c])
  const mf = inputs.moisture

  const herbLoad = load('liveHerb')
  const transfer = fuel.type === 'dynamic' ? clamp(inputs.cured, 0, 1) : 0

  const dead: Particle[] = [
    { load: load('dead1h'), sav: sav('dead1h'), moisture: mf.dead1h },
    { load: load('dead10h'), sav: sav('dead10h'), moisture: mf.dead10h },
    { load: load('dead100h'), sav: sav('dead100h'), moisture: mf.dead100h },
    // Cured herbaceous load becomes a fourth dead class carrying the herb SAV and the dead 1-h
    // moisture (Scott & Burgan 2005; this is what BEHAVE does).
    { load: transfer * herbLoad, sav: sav('liveHerb'), moisture: mf.dead1h },
  ].filter((p) => p.load > 0 && p.sav > 0)

  const live: Particle[] = [
    { load: (1 - transfer) * herbLoad, sav: sav('liveHerb'), moisture: mf.liveHerb },
    { load: load('liveWoody'), sav: sav('liveWoody'), moisture: mf.liveWoody },
  ].filter((p) => p.load > 0 && p.sav > 0)

  // Bulk density uses the TOTAL bed load, dead plus live, over the bed depth.
  const totalLoad =
    load('dead1h') + load('dead10h') + load('dead100h') + herbLoad + load('liveWoody')

  return { dead, live, transfer, totalLoad }
}

/** The full kernel, in English units. */
export function rothermelIntermediates(
  inputs: SpreadInputs,
  options: SpreadOptions = {},
): RothermelIntermediates {
  const legacyWindLimit = options.legacyWindLimit ?? DEFAULTS.legacyWindLimit
  const spreadRateRail = options.spreadRateRail ?? DEFAULTS.spreadRateRail

  const fuel = inputs.fuel
  const depthFt = toFeet(fuel.depth)
  const { dead, live, transfer, totalLoad } = particles(fuel, inputs)
  if (depthFt <= 0 || totalLoad <= 0) return { ...EMPTY, curedTransfer: transfer }

  const cDead = buildCategory(dead)
  const cLive = buildCategory(live)
  const totalArea = cDead.area + cLive.area
  if (totalArea <= 0) return { ...EMPTY, curedTransfer: transfer }

  const fDead = cDead.area / totalArea
  const fLive = cLive.area / totalArea
  const sav = fDead * cDead.sav + fLive * cLive.sav

  const bulkDensity = totalLoad / depthFt // rho_b, lb/ft^3
  const packingRatio = bulkDensity / RHO_P // beta
  const sav15 = Math.pow(sav, 1.5)
  const optimumPackingRatio = 3.348 * Math.pow(sav, -0.8189) // beta_op, Eq. 37
  const relativePackingRatio = packingRatio / optimumPackingRatio

  // Eq. 36 with Albini's (1976) refit of the Eq. 39 exponent.
  const gammaMax = sav15 / (495 + 0.0594 * sav15)
  const A = 133 * Math.pow(sav, -0.7913)
  const reactionVelocity =
    gammaMax *
    Math.pow(relativePackingRatio, A) *
    Math.exp(A * (1 - relativePackingRatio))

  const etaS = Math.min(0.174 * Math.pow(S_E, -0.19), 1) // Eq. 30
  const mxDead = fuel.moistureOfExtinctionDead
  const mxLive = liveMoistureOfExtinction(dead, live, mxDead)
  const etaMDead = moistureDamping(cDead.moisture, mxDead)
  const etaMLive = moistureDamping(cLive.moisture, mxLive)

  const heat = toBtuPerLb(fuel.heatContent)
  // Eq. 27, summed over life categories as Albini assembles it.
  const reactionIntensity =
    reactionVelocity *
    heat *
    etaS *
    (cDead.netLoad * etaMDead + cLive.netLoad * etaMLive)

  // Eq. 42
  const propagatingFluxRatio =
    Math.exp((0.792 + 0.681 * Math.sqrt(sav)) * (packingRatio + 0.1)) / (192 + 0.2595 * sav)

  // Heat sink: rho_b * sum_i f_i * sum_j f_ij * eps_ij * Q_ig,ij (Eqs. 12, 14).
  const heatSink = bulkDensity * (fDead * cDead.heatSinkTerm + fLive * cLive.heatSinkTerm)
  if (heatSink <= 0 || reactionIntensity <= 0) {
    return {
      ...EMPTY,
      sav,
      bulkDensity,
      packingRatio,
      optimumPackingRatio,
      relativePackingRatio,
      reactionVelocity,
      propagatingFluxRatio,
      residenceTime: 384 / sav,
      deadMoistureDamping: etaMDead,
      liveMoistureDamping: etaMLive,
      liveMoistureOfExtinction: mxLive,
      curedTransfer: transfer,
      extinguished: true,
    }
  }

  const noWindNoSlopeRate = (reactionIntensity * propagatingFluxRatio) / heatSink // R_0, ft/min

  // Wind factor, Eqs. 47-50. U is MIDFLAME wind in ft/min.
  const C = 7.47 * Math.exp(-0.133 * Math.pow(sav, 0.55))
  const B = 0.02526 * Math.pow(sav, 0.54)
  const E = 0.715 * Math.exp(-3.59e-4 * sav)
  const packingTerm = Math.pow(relativePackingRatio, -E)
  const windFtMin = Math.max(toFeetPerMinute(inputs.midflameWind), 0)
  const windFactor = windFtMin > 0 ? C * Math.pow(windFtMin, B) * packingTerm : 0

  // Slope factor, Eq. 51. Downslope contributes nothing; tan is clamped per spec §4.9.
  const slopeTan = clamp(inputs.slope, 0, MAX_SLOPE_TAN)
  const slopeFactor = 5.275 * Math.pow(packingRatio, -0.3) * slopeTan * slopeTan

  // Effective wind: invert Eq. 47 on the combined factor (GTR-371 §4.1 p. 27).
  const inversionScale = C * packingTerm
  const toEffectiveWind = (phi: number): number =>
    phi <= 0 || inversionScale <= 0 ? 0 : Math.pow(phi / inversionScale, 1 / B)

  let phiE = windFactor + slopeFactor
  let effectiveWind = toEffectiveWind(phiE)
  let rateOfSpread = noWindNoSlopeRate * (1 + phiE)

  // Spec §4.5: any cap acts on the pair (U_eff, R_head) BEFORE the elliptical decomposition,
  // and caps the WIND then re-evaluates — clamping R directly does not reproduce BehavePlus.
  const windLimit = WIND_LIMIT_COEFF * reactionIntensity
  let windLimitApplied = false
  if (legacyWindLimit && effectiveWind > windLimit) {
    effectiveWind = windLimit
    phiE = C * Math.pow(effectiveWind, B) * packingTerm
    rateOfSpread = noWindNoSlopeRate * (1 + phiE)
    windLimitApplied = true
    // `windFactor` and `slopeFactor` below stay at their uncapped values: the recomputed phiE
    // subsumes both, so `1 + windFactor + slopeFactor` no longer reconstructs the ROS once the
    // cap has bitten. `windLimitApplied` is how a caller knows that has happened.
  }

  // The inert sanity rail (2013 abstract). Never binds at realistic spread rates.
  if (spreadRateRail && effectiveWind > 0) {
    rateOfSpread = Math.min(rateOfSpread, effectiveWind)
  }

  const residenceTime = 384 / sav // min, Anderson 1969
  const firelineIntensity = residenceTime * reactionIntensity * rateOfSpread // BTU/ft/min

  // LB from the CAPPED effective wind. BehavePlus / GTR-371 §6.2 p. 87 form, deliberately not
  // the unverified Anderson (1983) exponentials of spec §4.6 — see LENGTH_TO_BREADTH_MODEL.
  const lengthToBreadth = Math.min(
    1 + 0.25 * (effectiveWind / FT_MIN_PER_MI_H),
    MAX_LENGTH_TO_BREADTH,
  )

  return {
    sav,
    bulkDensity,
    packingRatio,
    optimumPackingRatio,
    relativePackingRatio,
    reactionVelocity,
    propagatingFluxRatio,
    reactionIntensity,
    windFactor,
    slopeFactor,
    effectiveWind,
    heatSink,
    noWindNoSlopeRate,
    rateOfSpread,
    residenceTime,
    firelineIntensity,
    deadMoistureDamping: etaMDead,
    liveMoistureDamping: etaMLive,
    liveMoistureOfExtinction: mxLive,
    lengthToBreadth,
    windLimit,
    windLimitApplied,
    curedTransfer: transfer,
    C,
    B,
    E,
    extinguished: false,
  }
}

/** `SpreadInputs -> SpreadOutputs`, the contract entry point. Everything SI. */
export function rothermelSpread(inputs: SpreadInputs, options: SpreadOptions = {}): SpreadOutputs {
  const x = rothermelIntermediates(inputs, options)

  const rateOfSpread = fromFeetPerMinute(asFtMin(x.rateOfSpread))
  const reactionIntensity = fromBtuPerFt2Min(asBtuFt2Min(x.reactionIntensity))
  const flaming = s(x.residenceTime * 60)
  const firelineIntensity = byramIntensity(reactionIntensity, flaming, rateOfSpread)

  return {
    rateOfSpread,
    noWindNoSlopeRate: fromFeetPerMinute(asFtMin(x.noWindNoSlopeRate)),
    reactionIntensity,
    windFactor: x.windFactor,
    slopeFactor: x.slopeFactor,
    effectiveWind: fromFeetPerMinute(asFtMin(x.effectiveWind)),
    firelineIntensity,
    flameLength: flameLength(firelineIntensity),
    residenceTime: flaming,
    lengthToBreadth: x.lengthToBreadth,
    extinguished: x.extinguished || x.rateOfSpread <= 0,
  }
}

/** Head-fire rate of spread only. */
export function rothermelROS(inputs: SpreadInputs, options: SpreadOptions = {}): MetresPerSecond {
  return rothermelSpread(inputs, options).rateOfSpread
}

/**
 * Byram (1959) fireline intensity in the Rothermel/Albini form, `I_B = I_R * t_r * R`.
 *
 * Computed in SI (kW/m^2 * s * m/s -> kW/m), which is algebraically identical to the English
 * `(384/sigma)*I_R*R` and needs no extra conversion constant to be trusted.
 */
export function byramIntensity(
  reactionIntensity: KilowattsPerSquareMetre,
  flamingResidence: Seconds,
  rateOfSpread: MetresPerSecond,
): KilowattsPerMetre {
  return kWm(reactionIntensity * flamingResidence * rateOfSpread)
}

/**
 * Byram (1959) flame length, `L = 0.0775 * I_B^0.46`, I_B in kW/m.
 *
 * Fitted to grass and low-intensity fires; over-predicts above ~2 m in forest and shrub fuels
 * (spec §4.7). Treat as a rendering cue there, not a measurement.
 */
export function flameLength(firelineIntensity: KilowattsPerMetre): Metres {
  return m(firelineIntensity > 0 ? 0.0775 * Math.pow(firelineIntensity, 0.46) : 0)
}

/** Anderson (1969) flaming residence time, `t_r = 384/sigma` [min] with sigma in ft^-1. */
export function flamingResidenceTime(sav: PerMetre): Seconds {
  const savPerFt = toPerFoot(sav)
  return s(savPerFt > 0 ? (384 / savPerFt) * 60 : 0)
}

/** Flame depth `D = R * t_r` — the width of the flaming band the renderer draws (spec §4.7). */
export function flameDepth(rateOfSpread: MetresPerSecond, flamingResidence: Seconds): Metres {
  return m(rateOfSpread * flamingResidence)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
