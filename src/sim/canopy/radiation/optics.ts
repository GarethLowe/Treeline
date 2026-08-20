/**
 * Grey-band radiative optics for the canopy. Spec §7.3 and §7.4.
 *
 * Pure, unit-safe, and CLI-testable. Every constant here is precomputed CPU-side or is a
 * single multiply in the shader, so per §0.5.1 there is no accuracy/cost trade to make:
 * getting these right is free and they are written at full published precision.
 *
 * Radiometric quantities are **W m^-2** and **W m^-3** internally (SI per §0.6). The
 * irradiance *texture* stores kW m^-2 for f16 range reasons only — see `layout.ts`.
 */

import type { Kelvin, Metres, PerMetre } from '@contracts/units'
import { perM } from '@contracts/units'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stefan-Boltzmann constant, W m^-2 K^-4. CODATA 2018 exact value derived from the SI base
 * unit redefinition: sigma = 2*pi^5*k^4/(15*h^3*c^2). §7.4 quotes it truncated to 5.670374e-8.
 */
export const STEFAN_BOLTZMANN = 5.670374419e-8

/**
 * Ross's G-function for a **spherical** leaf-angle distribution: the mean projection of unit
 * leaf area onto a plane normal to the beam, and it is 0.5 for every beam direction — which
 * is precisely why the spherical assumption makes the receiver isotropic and lets us store
 * one irradiance coefficient instead of four SH coefficients. Nilson (1971); Ross (1981).
 */
export const LEAF_PROJECTION_SPHERICAL = 0.5

/** Clumping index Omega_c, §7.3. Conifer shoots 0.4-0.8; broadleaf ~0.9 (Chen & Black 1992). */
export const CLUMPING_CONIFER = 0.6
export const CLUMPING_BROADLEAF = 0.9

/**
 * Flame absorption coefficient k_f, m^-1. §7.3 ships 0.8 as default; published wildland
 * values genuinely span 0.3-1.5. This is **calibration knob #1** of §7.7 — do not treat it
 * as a fixed physical constant.
 */
export const DEFAULT_FLAME_ABSORPTION = perM(0.8)

/** Effective wildland flame-sheet temperature, K. §7.4: sigma*T^4 = 117.6 kW m^-2 at 1200 K. */
export const DEFAULT_FLAME_TEMPERATURE_K = 1200 as Kelvin

/**
 * Hard ceiling on the fraction of Byram fireline intensity a surface cell may radiate.
 *
 * This is the energy-conservation guard at the source: the flame-panel geometry is an
 * approximation and a bad flame-depth or flame-length input could make it emit more than the
 * fire releases. Measured radiant fractions for wildland fires are 0.15-0.35 (Frankman et al.
 * 2013 field radiometry; Sullivan et al. 2003 review), so 0.4 clamps only unphysical inputs
 * and never a plausible one.
 */
export const MAX_RADIANT_FRACTION = 0.4

// ---------------------------------------------------------------------------
// Extinction and emissivity
// ---------------------------------------------------------------------------

/**
 * Turbid-medium extinction coefficient of a canopy voxel, m^-1. §7.3:
 *   kappa = G(Omega) * Omega_c * LAD
 *
 * Worked point from §7.3: LAD = 2, Omega_c = 0.6, G = 0.5 -> kappa = 0.6 m^-1.
 */
export function extinctionFromLad(
  leafAreaDensity: number,
  clumping = CLUMPING_CONIFER,
  projection = LEAF_PROJECTION_SPHERICAL,
): PerMetre {
  return perM(Math.max(0, projection * clumping * leafAreaDensity))
}

/** Beer-Lambert emissivity/absorptivity of a grey slab of optical thickness kappa*path. */
export function greyEmissivity(kappa: PerMetre, pathM: Metres): number {
  return 1 - Math.exp(-Math.max(0, kappa) * Math.max(0, pathM))
}

/**
 * Emissivity of a flame of depth D. §7.3: eps_f = 1 - exp(-k_f * D). At the default
 * k_f = 0.8 a flame deeper than 3 m is effectively black (eps > 0.9).
 */
export function flameEmissivity(depth: Metres, kf: PerMetre = DEFAULT_FLAME_ABSORPTION): number {
  return greyEmissivity(kf, depth)
}

/**
 * Hottel's mean beam length for an arbitrary emitting volume, m: L_m = 3.6 V / A.
 *
 * The 3.6 (rather than the optically-thin 4.0) is Hottel's 0.9 correction factor, which
 * keeps the grey-gas emissivity right through the intermediate optical-thickness range
 * instead of only in the thin limit. For a 2 m canopy voxel, V/A = 8/24 -> L_m = 1.2 m.
 */
export function meanBeamLength(volumeM3: number, surfaceAreaM2: number): Metres {
  return (surfaceAreaM2 > 0 ? (3.6 * volumeM3) / surfaceAreaM2 : 0) as Metres
}

// ---------------------------------------------------------------------------
// Emission and absorption
// ---------------------------------------------------------------------------

/** Black-body emissive power sigma*T^4, W m^-2. At 1200 K: 117.6 kW m^-2 (§7.4). */
export function blackbodyEmissivePower(temperature: Kelvin): number {
  const t = Math.max(0, temperature)
  return STEFAN_BOLTZMANN * t * t * t * t
}

/**
 * Total radiant power of a self-contained emitting volume (a flaming canopy voxel), W.
 *
 * P = eps * sigma * T^4 * A_surface with eps from the mean beam length. This is bounded by
 * the black-body limit of the enclosing surface in the optically thick case and reduces to
 * the familiar thin-limit 4*kappa*sigma*T^4*V when kappa*L_m << 1, so it is correct in both
 * regimes with one `exp`. Using the thin limit alone would over-emit a dense crown by ~45%.
 */
export function volumeEmitterPower(kappa: PerMetre, temperature: Kelvin, cellM: Metres): number {
  const v = cellM * cellM * cellM
  const a = 6 * cellM * cellM
  const eps = greyEmissivity(kappa, meanBeamLength(v, a))
  return eps * blackbodyEmissivePower(temperature) * a
}

/**
 * Absorbed volumetric radiative source, W m^-3. §7.4:
 *   q''' = kappa * (G - 4*sigma*T_s^4)
 *
 * `G` is the **spherically integrated** incident irradiance, integral of radiance over 4*pi
 * steradians, W m^-2 — which is what `gather.ts` produces. Passing a directional (single
 * surface, cos-weighted) irradiance here instead is the classic factor-of-several error and
 * is why the gather's units are spelled out in its own doc comment.
 *
 * The result is signed: a hot voxel in a cold surround radiates away, which is real and
 * matters for crown cooling between torching events.
 */
export function absorbedSource(kappa: PerMetre, irradianceWm2: number, solid: Kelvin): number {
  return kappa * (irradianceWm2 - 4 * blackbodyEmissivePower(solid))
}
