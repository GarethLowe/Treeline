/**
 * Cheney, Gould & Catchpole (1998) grassland spread — spec §4.9.
 *
 * Recommended over Rothermel for the grassland biome, which Rothermel systematically
 * under-predicts at high wind. The published equations are in PERCENT; the conversion happens
 * on entry and nothing percent-shaped leaves this file (spec §0.6).
 */

import type { MetresPerSecond, MoistureFraction } from '@contracts/units.ts'
import { fracToPct, mps } from '@contracts/units.ts'

/** Phi_M, the moisture coefficient. `u10Kmh` is the 10 m open wind. */
export function csiroPhiM(mDead: MoistureFraction, u10Kmh: number): number {
  const mg = fracToPct(mDead)
  if (mg <= 12) return Math.exp(-0.108 * mg)
  return Math.max(0, u10Kmh <= 10 ? 0.684 - 0.0342 * mg : 0.547 - 0.0228 * mg)
}

/** Phi_C, the curing coefficient. `cured` is a fraction; the published form is percent. */
export function csiroPhiC(cured: number): number {
  const c = cured * 100
  if (c < 20) return 0
  return 1.036 / (1 + 103.989 * Math.exp(-0.0996 * (c - 20)))
}

/** Natural / undisturbed pasture rate of spread, SI. `u10Kmh` is the 10 m open wind. */
export function csiroGrassROS(
  u10Kmh: number,
  mDead: MoistureFraction,
  cured: number,
): MetresPerSecond {
  const base = u10Kmh >= 5 ? 1.4 + 0.838 * (u10Kmh - 5) ** 0.844 : 0.054 + 0.269 * u10Kmh
  return mps((base * csiroPhiM(mDead, u10Kmh) * csiroPhiC(cured)) / 3.6)
}
