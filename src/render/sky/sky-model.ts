/**
 * Assembly of the complete sky state from the solar solve. **Pure — no GPU, no DOM.**
 *
 * This is the module that turns "where is the sun and how much energy is it delivering" into
 * "what radiance comes from every direction", and it is deliberately CPU-side and testable: the
 * GPU shader evaluates exactly these coefficients out of a uniform buffer rather than
 * re-deriving them, so there is no second transcription of the model to drift.
 *
 * Structure: two Perez lobes, summed.
 *  - the SOLAR lobe, oriented on the sun, normalised so its cosine-weighted hemisphere integral
 *    equals max(Erbs diffuse horizontal irradiance, the measured twilight irradiance). By day
 *    the Erbs term wins; the two cross over about 1 deg above the horizon.
 *  - the LUNAR lobe, oriented on the moon, normalised to the moon's horizontal illuminance.
 *
 * Both are anchored to irradiances the physics side computes, which is what keeps the visible
 * sky and the M5 fuel-drying energy budget the same quantity rather than two parallel models.
 */

import type { SolarState } from '@contracts/render.ts'
import { DAYLIGHT_LUMINOUS_EFFICACY, directBeamColour, xyYToLinearSrgb } from './spectrum.ts'
import {
  makeSkyDistribution,
  perezF,
  skyRadiance,
  type SkyDistribution,
} from './preetham.ts'
import { moonState, type MoonState } from './moon.ts'
import type { AtmosphereConfig, FullSolarState } from './solar.ts'
import {
  NIGHT_SKY_CHROMATICITY,
  nightChromaticityBlend,
  effectiveTurbidity,
  twilightIrradiance,
} from './twilight.ts'

/** Angular radius of the solar disc at 1 AU, radians (0.2666 deg). */
export const SUN_ANGULAR_RADIUS = 0.2666 * (Math.PI / 180)

/** Solid angle of a disc of angular radius `r`, steradians. */
export function discSolidAngle(angularRadius: number): number {
  return 2 * Math.PI * (1 - Math.cos(angularRadius))
}

export interface SkyEnvironment {
  readonly solar: FullSolarState
  readonly moon: MoonState
  /** Perez lobe oriented on the sun. Carries day *and* twilight. */
  readonly solarLobe: SkyDistribution
  /** Perez lobe oriented on the moon, normalised to moonlight illuminance. */
  readonly lunarLobe: SkyDistribution
  /** Radiance of the solar disc itself, W/(m^2 sr), linear sRGB. Zero once the sun has set. */
  readonly sunDiscRadiance: readonly [number, number, number]
  /** Radiance of the lunar disc, W/(m^2 sr). */
  readonly moonDiscRadiance: readonly [number, number, number]
  /** Diffuse horizontal irradiance the sky lobes are normalised to, W/m^2. */
  readonly skyIrradiance: number
  /** Moonlight horizontal irradiance, W/m^2. */
  readonly moonIrradiance: number
  /** Peak radiance of an individual star, W/(m^2 sr). Fades to zero as the sky brightens. */
  readonly starRadiance: number
}

/** Linear interpolation of a chromaticity pair. */
function mixXy(
  a: readonly [number, number],
  b: readonly [number, number],
  t: number,
): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/**
 * Build the complete sky state.
 *
 * @param solar the one solar solve — never recomputed here, so the sky and the physics cannot
 *        disagree about where the sun is.
 * @param jdUt Julian Day (UT) of the same instant, needed for the lunar ephemeris.
 */
export function makeSkyEnvironment(
  solar: FullSolarState,
  jdUt: number,
  latitudeDeg: number,
  longitudeDeg: number,
  atmosphere: AtmosphereConfig,
): SkyEnvironment {
  const elevation = solar.geometry.apparentElevationRad
  const moon = moonState(jdUt, latitudeDeg, longitudeDeg)

  // --- Solar lobe -----------------------------------------------------------
  const skyIrradiance = Math.max(solar.diffuseIrradiance, twilightIrradiance(elevation))
  const turbidity = effectiveTurbidity(atmosphere.turbidity, elevation)
  const solarZenith = Math.PI / 2 - elevation
  const solarLobeBase = makeSkyDistribution({
    turbidity,
    solarZenithRad: solarZenith,
    lightDirection: solar.direction,
    targetIrradiance: skyIrradiance,
  })

  // Push chromaticity toward the night sky as the sun sinks. Luminance normalisation is
  // independent of chromaticity (xyY carries luminance in Y), so this cannot disturb the
  // irradiance the lobe was built to deliver.
  const nightBlend = nightChromaticityBlend(elevation)
  const [sx, sy] = mixXy(
    [solarLobeBase.zenithX, solarLobeBase.zenithY],
    NIGHT_SKY_CHROMATICITY,
    nightBlend,
  )
  const solarLobe: SkyDistribution = { ...solarLobeBase, zenithX: sx, zenithY: sy }

  // --- Lunar lobe -----------------------------------------------------------
  const moonIrradiance = moon.illuminanceLux / DAYLIGHT_LUMINOUS_EFFICACY
  const lunarLobe = makeSkyDistribution({
    turbidity: 2.0,
    solarZenithRad: Math.PI / 2 - Math.max(0, moon.elevation),
    lightDirection: moon.direction,
    targetIrradiance: moonIrradiance,
  })
  const lunarLobeTinted: SkyDistribution = {
    ...lunarLobe,
    zenithX: NIGHT_SKY_CHROMATICITY[0],
    zenithY: NIGHT_SKY_CHROMATICITY[1],
  }

  // --- Discs ----------------------------------------------------------------
  // The disc radiance is set so that integrating it over the disc's solid angle returns exactly
  // the direct normal irradiance the physics uses. Colour comes from the transmitted beam
  // spectrum (which is also what reddens it at low elevation and under smoke).
  const beam = directBeamColour(elevation, atmosphere.turbidity, atmosphere.plumeOpticalDepth)
  const sunSolidAngle = discSolidAngle(SUN_ANGULAR_RADIUS)
  const sunDiscLuminanceEquivalent = solar.directIrradiance / sunSolidAngle
  const sunDiscRadiance =
    solar.directIrradiance > 0
      ? xyYToLinearSrgb(beam.x, beam.y, sunDiscLuminanceEquivalent)
      : ([0, 0, 0] as [number, number, number])

  const moonBeam = directBeamColour(
    Math.max(moon.elevation, 0),
    atmosphere.turbidity,
    atmosphere.plumeOpticalDepth,
  )
  const moonSolidAngle = discSolidAngle(moon.angularRadius)
  const moonDiscRadiance =
    moon.elevation > 0 && moonIrradiance > 0
      ? xyYToLinearSrgb(
          moonBeam.x,
          moonBeam.y,
          // E_horizontal = L * Omega * sin(altitude)  =>  L = E / (Omega sin alt)
          moonIrradiance / (moonSolidAngle * Math.max(0.02, Math.sin(moon.elevation))),
        )
      : ([0, 0, 0] as [number, number, number])

  // --- Stars ----------------------------------------------------------------
  // A magnitude-0 star delivers ~2.5e-6 lux; rendered as a disc a few pixels across its radiance
  // is small but not zero. Faded out once the sky is more than ~1000x the moonless floor, which
  // is roughly the end of nautical twilight.
  const skyBrightnessRatio = skyIrradiance / (0.0002 / DAYLIGHT_LUMINOUS_EFFICACY)
  const starFade = Math.max(0, Math.min(1, 1 - Math.log10(Math.max(1, skyBrightnessRatio)) / 3))
  const starRadiance = 4e-4 * starFade

  return {
    solar,
    moon,
    solarLobe,
    lunarLobe: lunarLobeTinted,
    sunDiscRadiance,
    moonDiscRadiance,
    skyIrradiance,
    moonIrradiance,
    starRadiance,
  }
}

/**
 * Total sky radiance in a direction, W/(m^2 sr), excluding the sun and moon discs.
 * This is what the SH projection integrates and what the shader evaluates for a miss ray.
 */
export function environmentRadiance(
  env: SkyEnvironment,
  dir: readonly [number, number, number],
): [number, number, number] {
  const a = skyRadiance(env.solarLobe, dir)
  const b = skyRadiance(env.lunarLobe, dir)
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

// ---------------------------------------------------------------------------
// GPU uniform packing
// ---------------------------------------------------------------------------

/**
 * Floats in the sky uniform buffer. MUST match `struct SkyUniforms` in shaders/sky/sky.wgsl.
 *
 * Layout (all vec4-aligned, WGSL uniform address space rules):
 *   [ 0..15] invViewProj           mat4x4<f32>
 *   [16..19] cameraPos.xyz, exposure
 *   [20..23] sunDir.xyz, sunAngularRadius
 *   [24..27] sunDiscRadiance.rgb, sunVisible
 *   [28..31] moonDir.xyz, moonAngularRadius
 *   [32..35] moonDiscRadiance.rgb, moonIlluminatedFraction
 *   [36..39] starRadiance, outputMode, plumeTau, groundAlbedo
 *   [40..67] solar lobe   (7 x vec4, see packLobe)
 *   [68..95] lunar lobe   (7 x vec4)
 */
export const SKY_UNIFORM_FLOATS = 96
export const SKY_UNIFORM_BYTES = SKY_UNIFORM_FLOATS * 4

/** How the shader should treat the output. Mirrors `OUTPUT_*` in sky.wgsl. */
export type SkyOutputMode = 'linear-hdr' | 'tonemapped' | 'tonemapped-srgb'

const OUTPUT_MODE_CODE: Record<SkyOutputMode, number> = {
  'linear-hdr': 0,
  tonemapped: 1,
  'tonemapped-srgb': 2,
}

/** 7 vec4 = 28 floats per lobe. */
export const LOBE_FLOATS = 28

function packLobe(out: Float32Array, offset: number, d: SkyDistribution): void {
  const { Y, x, y } = d.perez
  const denY = perezF(Y, 1, d.solarZenithRad)
  const denX = perezF(x, 1, d.solarZenithRad)
  const denYy = perezF(y, 1, d.solarZenithRad)

  const v = [
    Y.a, Y.b, Y.c, Y.d,
    Y.e, x.a, x.b, x.c,
    x.d, x.e, y.a, y.b,
    y.c, y.d, y.e, d.zenithLuminanceCdM2,
    d.zenithX, d.zenithY, d.radianceScale, 1 / DAYLIGHT_LUMINOUS_EFFICACY,
    denY, denX, denYy, 0,
    d.lightDirection[0], d.lightDirection[1], d.lightDirection[2], d.radianceScale > 0 ? 1 : 0,
  ]
  out.set(v, offset)
}

export interface SkyUniformInputs {
  readonly invViewProjMatrix: Float32Array
  readonly cameraPosition: readonly [number, number, number]
  /** Linear exposure multiplier applied before tone mapping. Ignored in 'linear-hdr' mode. */
  readonly exposure: number
  readonly outputMode: SkyOutputMode
  readonly plumeOpticalDepth: number
  readonly groundAlbedo: number
}

/** Pack the uniform buffer contents. Pure and testable; the renderer only uploads the result. */
export function packSkyUniforms(
  env: SkyEnvironment,
  inputs: SkyUniformInputs,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(SKY_UNIFORM_FLOATS)
  out.set(inputs.invViewProjMatrix.subarray(0, 16), 0)

  out[16] = inputs.cameraPosition[0]
  out[17] = inputs.cameraPosition[1]
  out[18] = inputs.cameraPosition[2]
  out[19] = inputs.exposure

  out[20] = env.solar.direction[0]
  out[21] = env.solar.direction[1]
  out[22] = env.solar.direction[2]
  out[23] = SUN_ANGULAR_RADIUS

  out[24] = env.sunDiscRadiance[0]
  out[25] = env.sunDiscRadiance[1]
  out[26] = env.sunDiscRadiance[2]
  out[27] = env.solar.isDaytime ? 1 : 0

  out[28] = env.moon.direction[0]
  out[29] = env.moon.direction[1]
  out[30] = env.moon.direction[2]
  out[31] = env.moon.angularRadius

  out[32] = env.moonDiscRadiance[0]
  out[33] = env.moonDiscRadiance[1]
  out[34] = env.moonDiscRadiance[2]
  out[35] = env.moon.illuminatedFraction

  out[36] = env.starRadiance
  out[37] = OUTPUT_MODE_CODE[inputs.outputMode]
  out[38] = inputs.plumeOpticalDepth
  out[39] = inputs.groundAlbedo

  packLobe(out, 40, env.solarLobe)
  packLobe(out, 40 + LOBE_FLOATS, env.lunarLobe)

  // Solar lobe `den.w` (float 63) carries the global horizontal irradiance. The shader's ground
  // branch needs it to return a Lambertian bounce of albedo * E / pi for rays below the horizon,
  // which is what gives the environment cube a plausible lower hemisphere for specular
  // reflections. It rides in the lobe's spare lane rather than growing the uniform block.
  out[40 + 23] = env.solar.irradiance.globalHorizontal + env.moonIrradiance
  return out
}

/**
 * The CPU evaluation of exactly what the shader computes for a miss ray, used by the SH
 * projection and by the tests that keep the two implementations honest.
 */
export function radianceIncludingDiscs(
  env: SkyEnvironment,
  dir: readonly [number, number, number],
): [number, number, number] {
  const base = environmentRadiance(env, dir)
  const sunDot =
    dir[0] * env.solar.direction[0] + dir[1] * env.solar.direction[1] + dir[2] * env.solar.direction[2]
  if (sunDot > Math.cos(SUN_ANGULAR_RADIUS)) {
    base[0] += env.sunDiscRadiance[0]
    base[1] += env.sunDiscRadiance[1]
    base[2] += env.sunDiscRadiance[2]
  }
  const moonDot =
    dir[0] * env.moon.direction[0] + dir[1] * env.moon.direction[1] + dir[2] * env.moon.direction[2]
  if (moonDot > Math.cos(env.moon.angularRadius)) {
    base[0] += env.moonDiscRadiance[0]
    base[1] += env.moonDiscRadiance[1]
    base[2] += env.moonDiscRadiance[2]
  }
  return base
}

/** Solar state and derived scalars a caller may want without touching the lobes. */
export function skyDiagnostics(env: SkyEnvironment): {
  skyIlluminanceLux: number
  moonIlluminanceLux: number
  sunElevationDeg: number
  moonElevationDeg: number
} {
  return {
    skyIlluminanceLux: env.skyIrradiance * DAYLIGHT_LUMINOUS_EFFICACY,
    moonIlluminanceLux: env.moon.illuminanceLux,
    sunElevationDeg: (env.solar.geometry.apparentElevationRad * 180) / Math.PI,
    moonElevationDeg: (env.moon.elevation * 180) / Math.PI,
  }
}

/** Re-exported so consumers do not have to reach into `preetham.ts` for the type. */
export type { SkyDistribution }
export type { SolarState }
