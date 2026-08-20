/**
 * Convective heat transfer to a fuel element — WP 3.4, spec §7.5. Pure TypeScript, no GPU.
 *
 * This is the oracle for `shaders/sim/canopy/convection/convection.wgsl`.
 *
 * ## The chain
 *
 *     Re = u·d/ν(T_f)                         (T_f = film temperature, (T_g + T_s)/2)
 *     Nu = Churchill & Bernstein (1977)
 *     h  = Nu · k_g(T_f) / d                  [W m⁻² K⁻¹]
 *     q''' = h · A_v · (T_g − T_s),  A_v = 2·LAD   [W m⁻³]
 *
 * `A_v = 2·LAD` because LAD is one-sided leaf area density and both faces exchange heat
 * (spec §7.5).
 *
 * ## Choices, and the error each one accepts (§0.5.1)
 *
 * **Churchill & Bernstein, not the Hilpert table.** §7.5 offers both. C&B is one continuous
 * branchless expression valid across the whole Re range, which is what a WGSL kernel wants;
 * the Hilpert table needs five branches and a range test. Nothing is given up — C&B is the
 * later correlation and covers the same data.
 *
 * **C&B's high-Re bracket is KEPT.** The first draft of this file dropped
 * `[1+(Re/282000)^(5/8)]^(4/5)` as a cheap `pow`, on an arithmetic slip that put its value at
 * 1.0006 across the wildland range. It is 1.0006 at Re = 38 and **1.052 at Re = 3600**, which
 * is a 6 mm twig in a 20 m s⁻¹ plume — a 5 % systematic under-prediction of `h` for coarse
 * fuels in exactly the strong-plume conditions that matter. The saving was two `pow`s per
 * voxel per canopy step, ~10⁸ s⁻¹, which is noise on a 4070's special-function units. §0.5.1
 * trades accuracy for cost; it does not trade accuracy for a cost that is not there.
 *
 * **Pr is held at 0.70.** Air's Prandtl number moves over 0.68–0.72 across 300–1200 K. `Nu`
 * depends on it with an effective exponent of ~0.39 once the correlation's denominator is
 * accounted for, so this is a **±1.2 % measured** error on `h` at the ends of that range, in
 * exchange for deleting a `c_p(T)` polynomial from the hot path. It also folds `0.62·Pr^⅓ / [1+(0.4/Pr)^⅔]^¼` into one
 * compile-time constant, so the shader form differs from the full correlation in this one
 * respect and nothing else.
 *
 * **Sutherland's law for ν and k, not tabulated air properties.** Two `pow`s CPU-side, or one
 * small LUT if it ever matters. Checked against the §7.5 worked point: at 600 K it gives
 * ν = 5.13×10⁻⁵ m² s⁻¹ and k = 0.0462 W m⁻¹ K⁻¹ against the spec's 5.2×10⁻⁵ and 0.0469 —
 * 1.4 % and 1.6 % low, and the resulting `h` lands within 1 % of the spec's 154 W m⁻² K⁻¹.
 *
 * ## Not in this file
 *
 * The Biot correction `1/(1 + Bi/4)` on the effective `h` (§7.6) belongs to WP 3.2, which owns
 * the thermally-thin/thick criterion. It multiplies the `h` produced here; it is not applied
 * here, and applying it in both places would double-count.
 */

import type { Kelvin, Metres, MetresPerSecond } from '@contracts/units.ts'

// ---------------------------------------------------------------------------
// Air properties
// ---------------------------------------------------------------------------

/** Sutherland reference values for air. */
const MU_REF = 1.716e-5 // Pa·s at T_REF
const T_REF = 273.15
const S_MU = 110.4 // K
const K_REF = 0.0241 // W m⁻¹ K⁻¹ at T_REF
const S_K = 194 // K
/** Specific gas constant for dry air. */
const R_AIR = 287.05
const P_ATM = 101325

/**
 * Prandtl number of air, held constant. See the header for the ±1.2 % bound this buys.
 * Also the value the §7.5 worked point uses.
 */
export const PR_AIR = 0.7

/** Sutherland's law for dynamic viscosity [Pa·s]. */
export const airViscosity = (tempK: number): number =>
  (MU_REF * (tempK / T_REF) ** 1.5 * (T_REF + S_MU)) / (tempK + S_MU)

/** Sutherland's law for thermal conductivity [W m⁻¹ K⁻¹]. */
export const airConductivity = (tempK: number): number =>
  (K_REF * (tempK / T_REF) ** 1.5 * (T_REF + S_K)) / (tempK + S_K)

/** Ideal-gas density at 1 atm [kg m⁻³]. */
export const airDensity = (tempK: number, pressurePa = P_ATM): number =>
  pressurePa / (R_AIR * tempK)

/** Kinematic viscosity [m² s⁻¹]. */
export const airKinematicViscosity = (tempK: number, pressurePa = P_ATM): number =>
  airViscosity(tempK) / airDensity(tempK, pressurePa)

// ---------------------------------------------------------------------------
// Nusselt
// ---------------------------------------------------------------------------

/**
 * Churchill & Bernstein (1977), cylinder in cross-flow, full form. Valid for Re·Pr > 0.2.
 *
 *     Nu = 0.3 + 0.62·Re^½·Pr^⅓ / [1+(0.4/Pr)^⅔]^¼ · [1+(Re/282000)^(5/8)]^(4/5)
 */
export function nusseltChurchillBernstein(re: number, pr = PR_AIR): number {
  const reSafe = Math.max(re, 1e-6)
  const num = 0.62 * Math.sqrt(reSafe) * Math.cbrt(pr)
  const den = (1 + (0.4 / pr) ** (2 / 3)) ** 0.25
  const hi = (1 + (reSafe / 282000) ** 0.625) ** 0.8
  return 0.3 + (num / den) * hi
}

/**
 * Precomputed `0.62·Pr^⅓ / [1+(0.4/Pr)^⅔]^¼` at Pr = 0.70. The whole Pr dependence of the
 * correlation collapses to this one number, which is what makes holding Pr fixed worth doing:
 * it removes two `pow`s from the hot path for a measured ±1.2 %. Mirrored in the WGSL.
 */
export const CB_COEFF_PR070 =
  (0.62 * Math.cbrt(PR_AIR)) / (1 + (0.4 / PR_AIR) ** (2 / 3)) ** 0.25

/**
 * The shader form: C&B with the Pr dependence folded to `CB_COEFF_PR070`. Identical to
 * `nusseltChurchillBernstein(re, 0.70)` to floating point; the only accepted error is holding
 * Pr at 0.70, worth ±1.2 % on `h` across 300–1200 K.
 */
export const nusseltWildland = (re: number): number => {
  const reSafe = Math.max(re, 1e-6)
  return (
    0.3 + CB_COEFF_PR070 * Math.sqrt(reSafe) * (1 + (reSafe / 282000) ** 0.625) ** 0.8
  )
}

// ---------------------------------------------------------------------------
// Coefficient and volumetric source
// ---------------------------------------------------------------------------

export interface ConvectionInputs {
  /** Local gas temperature — from the plume field. */
  readonly gasTempK: Kelvin
  /** Solid (fuel element) temperature. */
  readonly solidTempK: Kelvin
  /** Gas speed past the element — plume vertical velocity combined with ambient wind. */
  readonly gasSpeed: MetresPerSecond
  /** Characteristic fuel element diameter. Pine needle ≈ 1 mm, twig 3–6 mm. */
  readonly diameter: Metres
}

/**
 * Convective heat transfer coefficient [W m⁻² K⁻¹].
 *
 * Properties are evaluated at the **film temperature** `(T_g + T_s)/2`, which is the standard
 * for Hilpert/C&B (Incropera). At the §7.5 worked point this happens to land on the same
 * answer as the spec's 600 K evaluation to within 1 %, because ν and k both rise with
 * temperature and their ratio in `Nu·k/d` nearly cancels.
 *
 */
export function convectiveCoefficient(inp: ConvectionInputs): number {
  const d = inp.diameter
  if (!(d > 0)) throw new RangeError(`diameter must be positive, got ${d}`)
  const film = 0.5 * (inp.gasTempK + inp.solidTempK)
  const re = (Math.abs(inp.gasSpeed) * d) / airKinematicViscosity(film)
  return (nusseltWildland(re) * airConductivity(film)) / d
}

/**
 * Volumetric convective source into a canopy voxel [W m⁻³], `q''' = h·A_v·(T_g − T_s)` with
 * `A_v = 2·LAD`. Negative when the gas is colder than the fuel, which is the correct
 * night-time/post-front behaviour and must not be clamped away.
 *
 * @param leafAreaDensity one-sided LAD [m² m⁻³].
 */
export function convectiveSource(inp: ConvectionInputs, leafAreaDensity: number): number {
  const h = convectiveCoefficient(inp)
  return h * 2 * leafAreaDensity * (inp.gasTempK - inp.solidTempK)
}
