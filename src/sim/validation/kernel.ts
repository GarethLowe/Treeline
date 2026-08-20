/**
 * The single point through which the benchmark suite reaches the Rothermel kernel.
 *
 * Swapped from the WP 2.5 stub to the shipping kernel on 2026-08-20. The names below are the
 * harness's; the right-hand side is production. Where the two disagree on units the adapter is
 * here rather than in `cases.ts`, so the cases stay readable as physics.
 */

import type { SpreadInputs } from '@contracts/sim.ts'
import type { KilowattsPerMetre, MetresPerSecond, PerMetre } from '@contracts/units.ts'
import { mps, perM } from '@contracts/units.ts'
import {
  flameLength,
  flamingResidenceTime,
  rothermelIntermediates,
  rothermelSpread as spreadSI,
} from '../rothermel/kernel.ts'
import type { RothermelIntermediates, SpreadOptions } from '../rothermel/kernel.ts'
import { lengthToBreadth as lbFromMps } from '../propagation/ellipse.ts'

export {
  BTUFTMIN_TO_KWM,
  BTUFTSEC_TO_KWM,
  MAX_SLOPE_TANGENT,
  applyRosRail,
  behaveWindLimitFtMin,
  curingFraction as curingFromHerbMoisture,
  revisedWindLimitFtMin,
  shelteredWaf,
  unshelteredWaf,
} from '../rothermel/kernel.ts'
export { FUEL_MODELS as fuelModelTable } from '../rothermel/fuelModels.ts'
export { csiroGrassROS, csiroPhiC, csiroPhiM } from '../rothermel/grass.ts'

/**
 * Everything a case can assert, English units included.
 *
 * The stub returned one object carrying both SI and English; production splits them across
 * `rothermelSpread` (SI, the shipping API) and `rothermelIntermediates` (English, the algebra).
 * This recombines them under the harness's field names.
 */
export interface RothermelDetail
  extends Omit<RothermelIntermediates, 'rateOfSpread' | 'firelineIntensity'> {
  /**
   * SI rate of spread, m/s.
   *
   * NOTE the collision this resolves: `RothermelIntermediates.rateOfSpread` is ft/min, but the
   * harness has always meant SI by that name and its cases feed it straight into
   * `mpsToChainsPerHour`. Overriding here keeps every case reading as physics; the English
   * value is `rateOfSpreadFtMin`.
   */
  readonly rateOfSpread: MetresPerSecond
  /**
   * SI fireline intensity, kW/m — same override, same reason. Left as the English BTU/ft/min
   * this reads as `1 / 0.0577 = 17.33` in the SI-vs-English structural case, which is exactly
   * the ratio that case exists to catch.
   */
  readonly firelineIntensity: KilowattsPerMetre
  /** BTU/ft/min, the English form. */
  readonly firelineIntensityBtu: number
  /** ft/min. The stub's `rateOfSpreadFtMin`. */
  readonly rateOfSpreadFtMin: number
  /** ft^-1. The stub's `sigmaFtInv`. */
  readonly sigmaFtInv: number
  /** BTU/ft^2/min. The stub's `reactionIntensityBtu`. */
  readonly reactionIntensityBtu: number
  /** Byram flame length, metres. */
  readonly flameLength: number
}

export function rothermelSpread(inputs: SpreadInputs, options: SpreadOptions = {}): RothermelDetail {
  const detail = rothermelIntermediates(inputs, options)
  const si = spreadSI(inputs, options)
  return {
    ...detail,
    rateOfSpread: si.rateOfSpread,
    firelineIntensity: si.firelineIntensity,
    firelineIntensityBtu: detail.firelineIntensity,
    rateOfSpreadFtMin: detail.rateOfSpread,
    sigmaFtInv: detail.sav,
    reactionIntensityBtu: detail.reactionIntensity,
    flameLength: si.flameLength as number,
  }
}

/**
 * Anderson (1983) length-to-breadth from the effective wind in ft/min.
 *
 * WP 2.3 owns the relation and takes SI; the cases quote the English form, so the conversion
 * lives here rather than in the case list.
 */
export const lengthToBreadth = (uEffFtMin: number): number =>
  lbFromMps(mps((uEffFtMin * 0.3048) / 60))

/** Anderson (1969) residence time in seconds from sigma in ft^-1, the form the cases quote. */
export const residenceTimeSeconds = (savFtInv: number): number =>
  savFtInv > 0 ? flamingResidenceTime(perM((savFtInv / 0.3048) as number) as PerMetre) : 0

/** Byram (1959) flame length, metres, from I_B in kW/m. */
export const byramFlameLength = (ibKwm: number): number => flameLength(ibKwm as never) as number

/** The same relation in its published English form: L [ft] from I_B in BTU ft^-1 s^-1. */
export const byramFlameLengthFt = (ibBtuFtSec: number): number =>
  ibBtuFtSec > 0 ? 0.45 * ibBtuFtSec ** 0.46 : 0

export type { SpreadOptions as KernelOptions }
