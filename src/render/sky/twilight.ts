/**
 * Twilight and night illuminance. **Pure — no GPU, no DOM.**
 *
 * WHY THIS EXISTS. At M4 the fire becomes the dominant light source in the scene, and that
 * only reads if night is genuinely dark. "Genuinely dark" is not an exposure choice, it is a
 * number: clear-sky horizontal illuminance falls from ~10^5 lx at noon to ~2x10^-4 lx on a
 * moonless night — nine orders of magnitude. A sky model that bottoms out at "dark blue" gets
 * this wrong by five or six decades and no amount of tone mapping recovers it.
 *
 * Preetham's fit is undefined below the horizon, so the twilight branch takes the model's
 * angular *shape* (evaluated with the sun pinned to the horizon) and drives its absolute level
 * from the measured twilight illuminance sequence, which is standard and obtainable:
 *
 * | solar elevation | horizontal illuminance | name |
 * |---|---|---|
 * | 0 deg    | 400 lx     | sunrise / sunset |
 * | -6 deg   | 3.4 lx     | civil twilight ends |
 * | -12 deg  | 0.008 lx   | nautical twilight ends |
 * | -18 deg  | 0.0008 lx  | astronomical twilight ends |
 * | below    | 0.0002 lx  | clear moonless night sky (airglow + starlight + zodiacal) |
 *
 * Source: the standard twilight illuminance sequence tabulated in Schlyter, "Radiometry and
 * photometry in astronomy" (obtainable), which reproduces the values in the IES Lighting
 * Handbook and in Brown (1952), "Natural Illumination Charts", US Navy Bureau of Ships report
 * 374-1. Interpolation between the anchors is linear in log10(illuminance) against elevation,
 * which is what the underlying physics (exponential loss of the illuminated scattering volume)
 * produces and what the published curves look like on log paper.
 */

import { DAYLIGHT_LUMINOUS_EFFICACY } from './spectrum.ts'

const DEG = Math.PI / 180

/** Anchor points, elevation in degrees (descending) against horizontal illuminance in lux. */
export const TWILIGHT_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 400],
  [-6, 3.4],
  [-12, 0.008],
  [-18, 0.0008],
]

/** Clear moonless night sky horizontal illuminance, lux. Airglow, starlight, zodiacal light. */
export const NIGHT_SKY_ILLUMINANCE_LUX = 0.0002

/** Full-moon horizontal illuminance at the zenith, lux. Used by `moon.ts`. */
export const FULL_MOON_ILLUMINANCE_LUX = 0.25

/**
 * Horizontal illuminance from the sky alone (no moon) for a solar elevation, lux.
 *
 * Above the horizon this returns the sunrise anchor: the daytime diffuse level comes from Erbs
 * in `solar.ts`, and the caller takes the larger of the two so the two branches cross over
 * smoothly at about +1 deg elevation, where the Erbs value overtakes 400 lx.
 */
export function twilightIlluminanceLux(solarElevationRad: number): number {
  const elDeg = (solarElevationRad * 180) / Math.PI
  if (elDeg >= 0) return TWILIGHT_ANCHORS[0]![1]

  for (let i = 0; i < TWILIGHT_ANCHORS.length - 1; i++) {
    const hi = TWILIGHT_ANCHORS[i]!
    const lo = TWILIGHT_ANCHORS[i + 1]!
    if (elDeg <= hi[0] && elDeg >= lo[0]) {
      const t = (elDeg - hi[0]) / (lo[0] - hi[0])
      const logE = Math.log10(hi[1]) + t * (Math.log10(lo[1]) - Math.log10(hi[1]))
      return Math.max(NIGHT_SKY_ILLUMINANCE_LUX, Math.pow(10, logE))
    }
  }
  return NIGHT_SKY_ILLUMINANCE_LUX
}

/** The same quantity as an irradiance, W/m^2, which is what the sky normalisation consumes. */
export function twilightIrradiance(solarElevationRad: number): number {
  return twilightIlluminanceLux(solarElevationRad) / DAYLIGHT_LUMINOUS_EFFICACY
}

/**
 * Effective turbidity for the sky *shape* at a given solar elevation.
 *
 * Preetham's chromaticity fit degrades below ~10 deg solar elevation and its horizon luminance
 * runs high. Rather than let it produce a lurid green-yellow horizon through twilight, the
 * turbidity fed to the distribution is eased toward a low, clean value as the sun sets. This is
 * an appearance correction to a model used outside its validated envelope, and it is confined
 * to this one function so it is visible rather than smeared through the shader.
 */
export function effectiveTurbidity(configuredTurbidity: number, solarElevationRad: number): number {
  const elDeg = (solarElevationRad * 180) / Math.PI
  if (elDeg >= 10) return configuredTurbidity
  const t = Math.max(0, Math.min(1, (elDeg + 6) / 16))
  const floorT = 2.0
  return floorT + (configuredTurbidity - floorT) * t
}

/**
 * Chromaticity of the residual night sky (CIE 1931 xy).
 *
 * Deep twilight and the moonless night sky sit near CIE xy (0.25, 0.26) — bluer than daylight
 * because what is left is high-altitude Rayleigh scattering plus airglow. Photopic vision does
 * not actually see this (it is below the rod/cone crossover, the Purkinje shift makes it read
 * as colourless blue-grey) but the physically correct chromaticity is what belongs in a linear
 * radiance buffer; any perceptual desaturation is the tone mapper's job.
 */
export const NIGHT_SKY_CHROMATICITY: readonly [number, number] = [0.25, 0.26]

/**
 * Blend factor from "daylight chromaticity" to "night chromaticity" for a solar elevation.
 * 0 at and above the horizon, 1 at the end of nautical twilight.
 */
export function nightChromaticityBlend(solarElevationRad: number): number {
  const elDeg = (solarElevationRad * 180) / Math.PI
  if (elDeg >= 0) return 0
  if (elDeg <= -12) return 1
  return -elDeg / 12
}

/**
 * Solar elevation, in radians, below which the sun contributes no usable direct beam. Used to
 * gate the sun disc and the key light. -0.833 deg is the standard sunset altitude of the solar
 * centre (refraction 34' plus semidiameter 16').
 */
export const SUNSET_ELEVATION_RAD = -0.833 * DEG
