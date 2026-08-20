/**
 * Elliptical fire-shape decomposition — work package 2.3.
 *
 * A wind-driven fire on uniform fuel grows as an ellipse with the ignition point at the
 * **rear focus** (spec §4.6). This module turns the pair `(R_head, U_eff)` handed over by
 * the Rothermel kernel into the three ellipse rates the level-set Hamiltonian consumes.
 *
 * ---------------------------------------------------------------------------------------
 * ## CLOSED — the Anderson (1983) length-to-breadth exponents
 * ---------------------------------------------------------------------------------------
 *
 * Spec §4.6 shipped this relation as `estimated` because its exponents (0.2566 / 0.1548)
 * disagreed with both reference implementations *and* with each other by exactly 2.237 —
 * the mi/h-per-m/s factor — so one of them had to be on the wrong wind unit.
 *
 * **Settled against the primary source.** Anderson (1983), INT-305, page 7, equation 17,
 * obtained free from FRAMES, states it verbatim:
 *
 * ```
 *   l/w = 0.936 EXP(0.1147U) + 0.461 EXP(-0.0692U)              (17)
 *   where U = windspeed at 1.5 ft or midflame miles per hour.
 * ```
 *
 * So **`firelab/behave` is right and this project's spec was wrong.** The exponents are
 * `0.1147 / 0.0692` on midflame wind in **mi/h**. Three independent checks confirm the OCR
 * is not lying to us:
 *
 * 1. The same exponent recurs in Anderson's equation 18 on the next line,
 *    `d/b = 1/(0.534·EXP[−0.1147U]) = 1.873·EXP[0.1147U]`, and `1/0.534 = 1.873` — the
 *    equation is internally consistent, which a garbled digit would not be.
 * 2. Anderson writes that Fons' linear fit `l/w = 1.0 + 0.5U` has "nearly twice the slope"
 *    of equation 17. Over Fons' stated 2–12 mi/h range equation 17 has mean slope 0.233 vs
 *    Fons' 0.5 — a ratio of 2.15, i.e. "nearly twice". With 0.2566 the mean slope would be
 *    1.9, four times Fons' rather than half.
 * 3. Anderson's figure 6 plots equation 17 against a y-axis topping out at 10 over a 0–12
 *    mi/h x-axis. With 0.2566 the curve would leave the plot at 8 mi/h (l/w = 20 at 12).
 *
 * `firelab/behave` `src/behave/fireSize.cpp:93–101` transcribes it correctly, on a wind it
 * has just converted to mi/h at :17–24. The spec's exponents are Anderson's relation
 * reparameterised for wind in **m/s**, applied to a number in mi/h — which inflates `LB` by
 * a factor rising to the cap almost immediately (LB = 8 at 8.6 mi/h midflame instead of
 * 19.1 mi/h). The spec text is left alone per the file-ownership rule; the discrepancy is
 * reported to the integrator.
 *
 * Two things in the shipped relation are **not** Anderson's and are labelled as such:
 *
 * - **`− 0.397`.** Equation 17 evaluates to 1.397 at zero wind, because it is assembled
 *   from fits to Fons' wind-tunnel data over 2–12 mi/h and was never meant to be evaluated
 *   at zero. A no-wind fire is a circle, so FARSITE (Finney 1998) subtracts 0.397 to force
 *   `LB(0) = 1` exactly, and `firelab/behave` does the same. Without it the level set would
 *   produce an ellipse in still air, which is both wrong and the exact failure the isotropy
 *   test hunts for.
 * - **the cap at 8.** Also FARSITE/behave, not Anderson. It binds at 19.1 mi/h (8.5 m/s)
 *   midflame, far outside Fons' 2–12 mi/h calibration range.
 *
 * ---------------------------------------------------------------------------------------
 *
 * `U_eff` here is the **effective midflame wind** of spec §4.5 — the wind+slope resultant
 * inverted through Rothermel Eq. 47 — already capped if the legacy `0.9·I_R` debug toggle
 * is on, because any cap acts on the pair `(U_eff, R_head)` *before* this decomposition.
 * The flank and backing rates derived below are **never capped again**.
 */

import type { MetresPerSecond, Radians } from '@contracts/units'

/** 1 mile = 1609.344 m exactly, so this factor is exact. Rounds to the spec's 2.237. */
const MPS_TO_MIH = 3600 / 1609.344

/** Anderson (1983) Eq. 17 coefficients, on midflame wind in mi/h. */
const LB_A = 0.936
const LB_B = 0.1147
const LB_C = 0.461
const LB_D = 0.0692
/** Finney (1998) zero-wind normalisation. `LB_A + LB_C - LB_ZERO_SHIFT === 1` exactly. */
const LB_ZERO_SHIFT = 0.397
/** Finney (1998) / behave cap. Binds at 19.1 mi/h = 8.5 m/s midflame. */
export const LB_MAX = 8

/**
 * Length-to-breadth ratio of the fire ellipse.
 *
 * @param effectiveWind effective **midflame** wind (spec §4.5), already capped if the
 *   legacy wind-limit toggle is on. Negative values are treated as zero.
 */
export function lengthToBreadth(effectiveWind: MetresPerSecond): number {
  const u = Math.max(0, effectiveWind) * MPS_TO_MIH
  const lb = LB_A * Math.exp(LB_B * u) + LB_C * Math.exp(-LB_D * u) - LB_ZERO_SHIFT
  return Math.min(Math.max(lb, 1), LB_MAX)
}

/**
 * The fire ellipse expressed as *rates*, in the frame of the heading direction. Everything
 * is m/s; multiply by elapsed time to get the geometric ellipse.
 *
 * `b` is the semi-major axis, `a` the semi-minor, `c` the offset from centre to the rear
 * focus — so the head runs at `b + c` and the back at `b − c`.
 */
export interface FireEllipse {
  /** Semi-minor rate = flank rate. */
  readonly a: number
  /** Semi-major rate. */
  readonly b: number
  /** Focal offset rate. */
  readonly c: number
  /** Unit heading, in grid axes: x = world +x (east), y = world +z (south). */
  readonly hx: number
  readonly hy: number
  readonly lengthToBreadth: number
  readonly head: number
  readonly backing: number
  readonly flank: number
}

/** A circle: no wind, no slope. Every rate equal, no preferred direction. */
export function isotropicEllipse(rate: number): FireEllipse {
  return {
    a: rate, b: rate, c: 0, hx: 1, hy: 0,
    lengthToBreadth: 1, head: rate, backing: rate, flank: rate,
  }
}

export interface EllipseOptions {
  /**
   * The §4.5 sanity rail `R_head ← min(R_head, U_eff)`, on by default.
   *
   * This is *not* the `0.9·I_R` wind limit — that one acts on the wind and is a debug
   * toggle owned by the Rothermel kernel. This is the Andrews, Cruz & Rothermel (2013)
   * substitute the authors recommend in its place: a guard against a pathological wind
   * field driving the front faster than the air moving it. It is inert at realistic spread
   * rates (`R/U_eff` ≈ 0.01–0.2 in GTR-371's own worked example) and `min` is idempotent,
   * so it does no harm if the kernel has already applied it.
   */
  readonly spreadRateRail?: boolean
}

/**
 * Decompose a head-fire rate into the ellipse.
 *
 * @param heading direction the head fire runs, as an azimuth in radians clockwise from
 *   north. Converted to the project's world frame by `(sin a, −cos a)` in (x, z) —
 *   the single conversion point, per `src/world/terrain/conventions.ts`.
 */
export function fireEllipse(
  headRate: MetresPerSecond,
  effectiveWind: MetresPerSecond,
  heading: Radians,
  options: EllipseOptions = {},
): FireEllipse {
  const lb = lengthToBreadth(effectiveWind)
  const rHead =
    options.spreadRateRail === false
      ? Math.max(0, headRate)
      : Math.min(Math.max(0, headRate), Math.max(0, effectiveWind))
  return ellipseFromRates(rHead, lb, Math.sin(heading), -Math.cos(heading))
}

/**
 * The same decomposition from an already-resolved `(R_head, LB, heading)` triple — which is
 * exactly what WP 2.2 caches per cell in its `rgba16float` texture, so this is the function
 * the GPU path mirrors.
 *
 * Uses the eccentricity form `R_b = R_head·(1 − e)/(1 + e)` rather than the algebraically
 * equivalent `R_head / HB` from spec §4.6: they agree exactly, but `HB` diverges as
 * `LB → 1` and the eccentricity form stays finite there, which matters because `LB = 1` is
 * the no-wind case and therefore the most common one in a test suite.
 */
export function ellipseFromRates(
  headRate: number,
  lengthToBreadthRatio: number,
  headingX: number,
  headingY: number,
): FireEllipse {
  const lb = Math.min(Math.max(lengthToBreadthRatio, 1), LB_MAX)
  const rHead = Math.max(0, headRate)
  const ecc = Math.sqrt(Math.max(0, lb * lb - 1)) / lb
  const backing = (rHead * (1 - ecc)) / (1 + ecc)
  const b = (rHead + backing) / 2
  const c = b - backing
  const a = b / lb
  const len = Math.hypot(headingX, headingY)
  const inv = len > 1e-12 ? 1 / len : 0
  return {
    a, b, c,
    hx: len > 1e-12 ? headingX * inv : 1,
    hy: len > 1e-12 ? headingY * inv : 0,
    lengthToBreadth: lb,
    head: b + c,
    backing,
    flank: a,
  }
}

/**
 * Head-to-back ratio, spec §4.6: `HB = (LB + √(LB²−1)) / (LB − √(LB²−1))`.
 *
 * Evaluated as `(LB + √(LB²−1))²`, which is exactly equal — the two factors are
 * reciprocals — and avoids the catastrophic cancellation in the denominator at large `LB`,
 * where `LB − √(LB²−1)` is the difference of two nearly equal numbers.
 */
export function headToBackRatio(lb: number): number {
  const root = Math.sqrt(Math.max(0, lb * lb - 1))
  return (lb + root) ** 2
}

// ---------------------------------------------------------------------------
// The Hamiltonian
// ---------------------------------------------------------------------------

/**
 * `H(∇φ) = S(n̂)·|∇φ|` where `S` is the **support function** of the ellipse taken about the
 * rear focus (Richards 1990; spec §4.6).
 *
 * This is the whole trick. Setting `S(n̂)` to the ellipse *radius* in direction `n̂` gives a
 * different, wrong curve. The support function makes `H` positively homogeneous of degree
 * one and convex, so the level-set viscosity solution coincides exactly with the Huygens
 * envelope and the emergent perimeter **is** the analytic ellipse, to discretisation error —
 * with no per-direction correction factors anywhere.
 *
 * Written directly in terms of `p = ∇φ` rather than normalising first, which removes a
 * division and the `|∇φ| → 0` singularity:
 *
 * ```
 *   q = p · ŵ
 *   H = c·q + √( b²q² + a²(|p|² − q²) )
 * ```
 */
export function hamiltonian(px: number, py: number, e: FireEllipse): number {
  const q = px * e.hx + py * e.hy
  const perp = Math.max(0, px * px + py * py - q * q)
  return e.c * q + Math.sqrt(e.b * e.b * q * q + e.a * e.a * perp)
}

/**
 * Exact per-axis bound on `|∂H/∂p|`, for the local Lax–Friedrichs dissipation.
 *
 * `∇_p H` is the point of the velocity ellipse that `p` selects, so the bound is the extent
 * of that ellipse along the axis: `|c·ŵ_i| + √((b·ŵ_i)² + (a·ŵ_⊥i)²)`. Tight, closed-form,
 * and direction-aware — using the isotropic `b + c` instead would be valid but would smear
 * the flanks with the head fire's viscosity, which is exactly the numerical diffusion the
 * scheme is trying to avoid.
 */
export function alphaX(e: FireEllipse): number {
  return Math.abs(e.c * e.hx) + Math.hypot(e.b * e.hx, e.a * e.hy)
}

export function alphaY(e: FireEllipse): number {
  return Math.abs(e.c * e.hy) + Math.hypot(e.b * e.hy, e.a * e.hx)
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------


