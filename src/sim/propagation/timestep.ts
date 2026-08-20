/**
 * CFL condition and substepping — work package 2.3, spec §4.8.
 *
 * The explicit level-set advance is limited by the maximum characteristic speed of the
 * Hamiltonian, which for the fire ellipse is `max S(n̂) = b + c = R_head`:
 *
 * ```
 *   Δt ≤ CFL · Δx / R_max ,   Δx = 0.5 m,  CFL = 0.4
 * ```
 *
 * CFL = 0.4 rather than 0.9 because the dimensionally-split local Lax–Friedrichs stencil
 * needs `Δt·(αx + αy)/Δx ≤ 1` in 2D, and we want headroom for the second RK stage. That
 * bound is verifiable: the per-axis dissipation coefficients satisfy `αx + αy ≤ R_head + a`
 * and `a ≤ b ≤ R_head`, so `Δt = 0.4·Δx/R_head` gives at worst 0.8 — inside the limit with
 * margin regardless of wind direction. `test/sim/propagation/timestep.test.ts` asserts it.
 *
 * `R_max` spans 250× across the regimes the simulation must cover (0.02 m/s in timber
 * litter to 5 m/s in extreme grass), so `Δt` is adaptive. `R_max` comes from a GPU
 * reduction over the active band read back with one frame of latency, hence the 1.25×
 * safety factor for staleness.
 *
 * **Hard rule from the spec: never silently exceed CFL.** A violated level set does not
 * merely lose accuracy, it stalls and oscillates in ways that read as physical behaviour.
 * So when the substep cap binds, `plan()` *simulates less time* and says so, rather than
 * stretching Δt.
 */

import type { MetresPerSecond, Seconds } from '@contracts/units'
import { s } from '@contracts/units'

export const CFL = 0.4
/** Absorbs one frame of staleness in the `R_max` readback. */
export const RMAX_SAFETY = 1.25
export const DT_MIN_S = 0.005
export const DT_MAX_S = 0.25
/** Spec §4.8: beyond this, reduce the time-acceleration factor instead. */
export const MAX_SUBSTEPS = 8

/** `Δt = clamp(CFL·Δx / (1.25·R_max), 5 ms, 250 ms)`. */
export function cflTimestep(maxRateOfSpread: MetresPerSecond, cellM: number): Seconds {
  const r = Math.max(0, maxRateOfSpread) * RMAX_SAFETY
  if (!(r > 0)) return s(DT_MAX_S)
  return s(Math.min(Math.max((CFL * cellM) / r, DT_MIN_S), DT_MAX_S))
}

export interface SubstepPlan {
  /** Stable substep length. Always satisfies CFL. */
  readonly dt: Seconds
  readonly substeps: number
  /**
   * Simulated time this plan actually advances — `dt · substeps`. Less than the requested
   * frame step when `capped` is true; that shortfall is dropped simulated time and belongs
   * in the HUD, not in a silently stretched Δt.
   */
  readonly simulated: Seconds
  readonly capped: boolean
}

export function substepPlan(
  frameDt: Seconds,
  maxRateOfSpread: MetresPerSecond,
  cellM: number,
): SubstepPlan {
  const dt = cflTimestep(maxRateOfSpread, cellM)
  if (frameDt <= 0) return { dt, substeps: 0, simulated: s(0), capped: false }
  const wanted = Math.ceil(frameDt / dt)
  const substeps = Math.min(wanted, MAX_SUBSTEPS)
  // Below the cap, shrink dt to land exactly on frameDt — still ≤ the CFL dt, so stable.
  const exact = substeps > 0 && wanted <= MAX_SUBSTEPS ? s(frameDt / substeps) : dt
  return {
    dt: exact,
    substeps,
    simulated: s(exact * substeps),
    capped: wanted > MAX_SUBSTEPS,
  }
}
