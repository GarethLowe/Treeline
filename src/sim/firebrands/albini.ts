/**
 * WP 3.6 — the Albini reference models, as an offline calibration and validation harness.
 *
 * These are **not** the runtime spread mechanism. The runtime is the Lagrangian solver in
 * `brands.ts`, which advects brands in the actual simulated plume. Albini's models exist here
 * for one reason: they are the only spotting models with decades of operational use, so they
 * are the envelope the Lagrangian solver has to land inside (spec §40 §1).
 *
 * **Albini is in US customary units throughout and we do not re-derive him in SI.** Re-fitting
 * the constants in SI silently changes the answers. Conversion happens at this module's
 * boundary — every exported function takes and returns SI, and every internal quantity is
 * ft / mi / mi·h⁻¹ / Btu·ft⁻¹·s⁻¹ exactly as printed in RP INT-309 and in `firelab/behave`'s
 * `src/behave/spot.cpp`, which is the canonical numerical statement of it.
 *
 * Implemented: §1.2 wind-driven surface fire and §1.4 flat-terrain deposition. Not implemented:
 * the 14-species torching-tree table (§1.1), burning piles (§1.3) and the mountain fixed-point
 * correction (§1.4) — see `deferred` in the work-package report.
 */

import type { Metres, MetresPerSecond } from '@contracts/units'
import { m as metres } from '@contracts/units'

const FT_PER_M = 1 / 0.3048
const MI_TO_M = 1609.344
/** mi h⁻¹ per m s⁻¹. */
const MPS_TO_MIH = 3600 / MI_TO_M

export interface SurfaceFireSpotInput {
  /** 20-ft windspeed, SI. */
  readonly wind20ft: MetresPerSecond
  /** Byram flame length, SI. */
  readonly flameLength: Metres
  /** Downwind cover (canopy) height, SI. */
  readonly coverHeight: Metres
}

export interface AlbiniSpot {
  /** Maximum firebrand loft height, m. */
  readonly loftHeight: Metres
  /** Downwind displacement accumulated while still rising in the line thermal, m. */
  readonly drift: Metres
  /** Flat-terrain deposition distance, m. */
  readonly flat: Metres
  /** flat + drift, m. The number to compare a Lagrangian max against. */
  readonly total: Metres
}

/**
 * Albini (1983, RP INT-309) wind-driven surface fire, §1.2 + §1.4.
 *
 *   f  = 322 (0.474 U₂₀)^−1.01          U₂₀ in mi h⁻¹
 *   I_B = (L_f / 0.45)^(1/0.46)          L_f in ft, I_B in Btu ft⁻¹ s⁻¹
 *   z_b = 1.055 √(f I_B)                 ft
 *
 * `f` is Albini's dimensional thermal-energy/windspeed function — it is not a physical group
 * that survives a unit change, which is exactly why this module stays in his units.
 */
export function albiniSurfaceFireSpot(input: SurfaceFireSpotInput): AlbiniSpot {
  const u20 = Math.max(input.wind20ft * MPS_TO_MIH, 1e-6)
  const lf = Math.max(input.flameLength * FT_PER_M, 1e-6)

  const f = 322 * Math.pow(0.474 * u20, -1.01)
  const ib = Math.pow(lf / 0.45, 1 / 0.46)
  const zb = 1.055 * Math.sqrt(f * ib)

  const driftMi = 2.78e-4 * u20 * Math.pow(zb, 0.643)
  const flatMi = albiniFlatDistanceMi(u20, zb, input.coverHeight * FT_PER_M)

  return {
    loftHeight: metres(zb / FT_PER_M),
    drift: metres(driftMi * MI_TO_M),
    flat: metres(flatMi * MI_TO_M),
    total: metres((flatMi + driftMi) * MI_TO_M),
  }
}

/**
 * §1.4 common deposition phase, in Albini's units. The brand descends at terminal velocity
 * through a logarithmic wind profile scaled on the downwind canopy, and the cover height gets a
 * floor so the logarithm stays well-behaved when the loft height dwarfs the cover.
 *
 * Note what is NOT an input: terminal velocity. Albini folded a characteristic brand into the
 * constants, which is the single largest reason a Lagrangian solver carrying a real v_t will
 * not reproduce him exactly — see `test/sim/firebrands/albini.test.ts`.
 */
export function albiniFlatDistanceMi(u20Mih: number, zbFt: number, coverFt: number): number {
  const hc = Math.max(coverFt, 2.2 * Math.pow(zbFt, 0.337) - 4.0, 1e-6)
  const r = zbFt / hc
  return 7.18e-4 * u20Mih * Math.sqrt(hc) * (0.362 + 0.5 * Math.sqrt(r) * Math.log(r))
}

/**
 * Albini (1981) burning-pile loft: z_b = 12.2 h_f. Included because it is one line and it is
 * the upper bound on how efficiently a compact steady source lofts — 12.2 flame heights against
 * a torching tree's ~4, because the pile does not entrain along a tall flame.
 */
export const albiniPileLoft = (flameHeight: Metres): Metres => metres(12.2 * flameHeight)
