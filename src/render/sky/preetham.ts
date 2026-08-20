/**
 * Analytic daylight sky model. **Pure — no GPU, no DOM.**
 *
 * Preetham, Shirley & Smits (1999), "A Practical Analytic Model for Daylight", SIGGRAPH '99
 * — a Perez et al. (1993) all-weather luminance/chromaticity distribution whose five
 * coefficients and whose zenith values are given as closed-form functions of turbidity and
 * solar zenith angle. Everything below is Appendix A.2 of that paper.
 *
 * MODEL CHOICE (spec §0.7.2). Hosek & Wilkie (2012) is the better model — it is fitted to a
 * brute-force spectral atmosphere solver rather than to Perez's clear-sky measurements, and
 * it does not go wrong at low sun in the way Preetham does. It is not used here because it
 * ships as a ~1080-number fitted dataset, and entering a thousand constants that cannot be
 * checked against an obtainable source is exactly what §0.7.1 forbids. Preetham's twenty-odd
 * coefficients are printed in the paper, are reproduced identically in every implementation
 * of it, and are checkable line by line. The known bias is recorded in `provenance.ts`:
 * Preetham overpredicts near-horizon luminance and its chromaticity degrades below ~10° solar
 * elevation, which is why the twilight branch (see `twilight.ts`) takes the model's *shape*
 * but drives its absolute level from measured twilight illuminance instead.
 *
 * OUTPUT UNITS. Preetham is photometric: luminance in cd/m^2, chromaticity in CIE xy. The
 * renderer and the SH projection want radiance in W/(m^2 sr), so everything is divided by the
 * luminous efficacy of daylight (`DAYLIGHT_LUMINOUS_EFFICACY`, 105 lm/W) at the boundary — and
 * then the whole hemisphere is *renormalised* so its cosine-weighted integral equals the
 * diffuse horizontal irradiance that `solar.ts` computed from Erbs. That renormalisation is
 * the point: the sky you see and the diffuse irradiance the fuel-moisture model will use at M5
 * are the same number, not two numbers that happen to look similar.
 */

import { DAYLIGHT_LUMINOUS_EFFICACY, xyYToLinearSrgb } from './spectrum.ts'

/** The five Perez distribution coefficients for one channel. */
export interface PerezCoefficients {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
}

export interface PerezSet {
  readonly Y: PerezCoefficients
  readonly x: PerezCoefficients
  readonly y: PerezCoefficients
}

/** Preetham Appendix A.2, luminance distribution coefficients. */
export function perezLuminance(turbidity: number): PerezCoefficients {
  const t = turbidity
  return {
    a: 0.1787 * t - 1.463,
    b: -0.3554 * t + 0.4275,
    c: -0.0227 * t + 5.3251,
    d: 0.1206 * t - 2.5771,
    e: -0.067 * t + 0.3703,
  }
}

/** Preetham Appendix A.2, x-chromaticity distribution coefficients. */
export function perezX(turbidity: number): PerezCoefficients {
  const t = turbidity
  return {
    a: -0.0193 * t - 0.2592,
    b: -0.0665 * t + 0.0008,
    c: -0.0004 * t + 0.2125,
    d: -0.0641 * t - 0.8989,
    e: -0.0033 * t + 0.0452,
  }
}

/** Preetham Appendix A.2, y-chromaticity distribution coefficients. */
export function perezY(turbidity: number): PerezCoefficients {
  const t = turbidity
  return {
    a: -0.0167 * t - 0.2608,
    b: -0.095 * t + 0.0092,
    c: -0.0079 * t + 0.2102,
    d: -0.0441 * t - 1.6537,
    e: -0.0109 * t + 0.0529,
  }
}

export function perezSet(turbidity: number): PerezSet {
  return { Y: perezLuminance(turbidity), x: perezX(turbidity), y: perezY(turbidity) }
}

/**
 * The Perez sky distribution function
 *
 *   F(theta, gamma) = (1 + a e^(b / cos theta)) (1 + c e^(d gamma) + e cos^2 gamma)
 *
 * `theta` is the angle from zenith to the sample direction and `gamma` the angle between the
 * sample direction and the sun. `cosTheta` is clamped away from zero: b is negative for every
 * physical turbidity so the exponential collapses to zero at the horizon anyway, but the
 * unclamped form divides by zero exactly on it.
 */
export function perezF(k: PerezCoefficients, cosTheta: number, gamma: number): number {
  const ct = Math.max(cosTheta, 0.01)
  return (
    (1 + k.a * Math.exp(k.b / ct)) *
    (1 + k.c * Math.exp(k.d * gamma) + k.e * Math.cos(gamma) * Math.cos(gamma))
  )
}

/**
 * Zenith luminance, cd/m^2. Preetham Eq. A.2 gives kcd/m^2; converted here.
 *
 * `chi = (4/9 - T/120)(pi - 2 thetaS)`,
 * `Yz = (4.0453 T - 4.9710) tan chi - 0.2155 T + 2.4192`.
 *
 * The fit goes negative for a high-turbidity sun below the horizon, which is meaningless; the
 * caller only ever evaluates it with thetaS clamped to the horizon, and the result is floored
 * at zero here as a backstop.
 */
export function zenithLuminance(turbidity: number, solarZenithRad: number): number {
  const t = turbidity
  const chi = (4 / 9 - t / 120) * (Math.PI - 2 * solarZenithRad)
  const kcd = (4.0453 * t - 4.971) * Math.tan(chi) - 0.2155 * t + 2.4192
  return Math.max(0, kcd * 1000)
}

/** Zenith chromaticity (x, y). Preetham Eq. A.1, the two 4x3 coefficient matrices. */
export function zenithChromaticity(
  turbidity: number,
  solarZenithRad: number,
): [number, number] {
  const t = turbidity
  const t2 = t * t
  const z = solarZenithRad
  const z2 = z * z
  const z3 = z2 * z

  const x =
    t2 * (0.00166 * z3 - 0.00375 * z2 + 0.00209 * z) +
    t * (-0.02903 * z3 + 0.06377 * z2 - 0.03202 * z + 0.00394) +
    (0.11693 * z3 - 0.21196 * z2 + 0.06052 * z + 0.25885)

  const y =
    t2 * (0.00275 * z3 - 0.0061 * z2 + 0.00317 * z) +
    t * (-0.04214 * z3 + 0.0897 * z2 - 0.04153 * z + 0.00516) +
    (0.15346 * z3 - 0.26756 * z2 + 0.0667 * z + 0.26688)

  return [x, y]
}

/**
 * Everything needed to evaluate the sky in one direction, precomputed once per solar update.
 * Deliberately a flat, POD-shaped struct: the same numbers are packed into the shader uniform
 * buffer, so the CPU sky (used for SH projection and for tests) and the GPU sky (used for the
 * visible render) evaluate identical coefficients rather than two transcriptions of a formula.
 */
export interface SkyDistribution {
  readonly turbidity: number
  /** Solar zenith angle actually used — clamped to the horizon when the sun has set. */
  readonly solarZenithRad: number
  /** Unit vector to the light source (sun by day, moon at night), world space Y-up. */
  readonly lightDirection: readonly [number, number, number]
  readonly perez: PerezSet
  readonly zenithLuminanceCdM2: number
  readonly zenithX: number
  readonly zenithY: number
  /**
   * Multiplies the model's radiance. Set so the cosine-weighted hemisphere integral equals the
   * physically computed diffuse horizontal irradiance. Dimensionless.
   */
  readonly radianceScale: number
}

/** Normalisation denominator F(0, thetaS) for each channel, hoisted out of the inner loop. */
interface Denominators {
  readonly Y: number
  readonly x: number
  readonly y: number
}

function denominators(d: SkyDistribution): Denominators {
  const zs = d.solarZenithRad
  return {
    Y: perezF(d.perez.Y, 1, zs),
    x: perezF(d.perez.x, 1, zs),
    y: perezF(d.perez.y, 1, zs),
  }
}

/**
 * Sky radiance in a direction, W/(m^2 sr), as linear sRGB.
 *
 * @param dir unit direction, world space (+Y up). Below the horizon returns zero — ground
 *        bounce is the terrain renderer's business, not the sky's.
 */
export function skyRadiance(
  d: SkyDistribution,
  dir: readonly [number, number, number],
): [number, number, number] {
  const cosTheta = dir[1]
  if (cosTheta <= 0) return [0, 0, 0]

  const dot = Math.max(
    -1,
    Math.min(1, dir[0] * d.lightDirection[0] + dir[1] * d.lightDirection[1] + dir[2] * d.lightDirection[2]),
  )
  const gamma = Math.acos(dot)
  const den = denominators(d)

  const lum =
    (d.zenithLuminanceCdM2 * perezF(d.perez.Y, cosTheta, gamma)) / Math.max(1e-6, den.Y)
  const x = (d.zenithX * perezF(d.perez.x, cosTheta, gamma)) / Math.max(1e-6, den.x)
  const y = (d.zenithY * perezF(d.perez.y, cosTheta, gamma)) / Math.max(1e-6, den.y)

  // Photometric -> radiometric, then the irradiance-matching renormalisation.
  const radiance = (lum / DAYLIGHT_LUMINOUS_EFFICACY) * d.radianceScale
  const rgb = xyYToLinearSrgb(x, y, radiance)
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])]
}

/** Luminance only (cd/m^2, before `radianceScale`). Used by the normalisation integral. */
export function skyLuminance(
  d: SkyDistribution,
  dir: readonly [number, number, number],
): number {
  const cosTheta = dir[1]
  if (cosTheta <= 0) return 0
  const dot = Math.max(
    -1,
    Math.min(1, dir[0] * d.lightDirection[0] + dir[1] * d.lightDirection[1] + dir[2] * d.lightDirection[2]),
  )
  const gamma = Math.acos(dot)
  const den = perezF(d.perez.Y, 1, d.solarZenithRad)
  return (d.zenithLuminanceCdM2 * perezF(d.perez.Y, cosTheta, gamma)) / Math.max(1e-6, den)
}

/**
 * Deterministic cosine-free hemisphere sample set (Fibonacci spiral over the upper hemisphere).
 * Deterministic because a randomly-seeded integral makes every downstream test flaky, and
 * because the environment update must produce identical lighting for identical solar state.
 */
export function hemisphereDirections(count: number): [number, number, number][] {
  const out: [number, number, number][] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    // y in (0, 1]: upper hemisphere, sample centres offset by half a step.
    const y = (i + 0.5) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = i * golden
    out.push([r * Math.cos(phi), y, r * Math.sin(phi)])
  }
  return out
}

/**
 * Cosine-weighted hemisphere integral of the model's *unscaled* luminance, giving horizontal
 * illuminance in lux. `hemisphereDirections` samples y uniformly on (0,1], which is a uniform
 * measure in cos(theta): the solid-angle element is then dOmega = 2 pi / N per sample and the
 * cosine weight is applied explicitly.
 */
export function horizontalIlluminance(d: SkyDistribution, samples = 2048): number {
  const dirs = hemisphereDirections(samples)
  let sum = 0
  for (const dir of dirs) sum += skyLuminance(d, dir) * dir[1]
  return (sum * 2 * Math.PI) / samples
}

/**
 * Build a distribution whose cosine-weighted hemisphere integral equals `targetIrradiance`
 * (W/m^2). This is where the sky render is tied to the physics: `targetIrradiance` is the Erbs
 * diffuse horizontal irradiance from `solar.ts`, or the twilight/moonlight irradiance below the
 * horizon, and never an artistic constant.
 */
export function makeSkyDistribution(params: {
  turbidity: number
  solarZenithRad: number
  lightDirection: readonly [number, number, number]
  targetIrradiance: number
  integrationSamples?: number
}): SkyDistribution {
  const zs = Math.min(Math.PI / 2, Math.max(0, params.solarZenithRad))
  const t = Math.max(1.7, params.turbidity)
  const [zx, zy] = zenithChromaticity(t, zs)
  const base: SkyDistribution = {
    turbidity: t,
    solarZenithRad: zs,
    lightDirection: params.lightDirection,
    perez: perezSet(t),
    zenithLuminanceCdM2: zenithLuminance(t, zs),
    zenithX: zx,
    zenithY: zy,
    radianceScale: 1,
  }
  const lux = horizontalIlluminance(base, params.integrationSamples ?? 2048)
  const modelIrradiance = lux / DAYLIGHT_LUMINOUS_EFFICACY
  const scale = modelIrradiance > 1e-12 ? params.targetIrradiance / modelIrradiance : 0
  return { ...base, radianceScale: scale }
}
