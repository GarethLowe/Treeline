/**
 * Spectral radiometry and colorimetry for the sun and sky.
 *
 * This module exists because "the sun goes orange at sunset" must not be an artist's ramp.
 * The correlated colour temperature reported in `SolarState.colorTemperature` is computed by
 * pushing an extraterrestrial solar spectrum through Rayleigh and aerosol extinction at the
 * actual relative air mass, integrating against the CIE 1931 colour matching functions, and
 * reading the CCT off the resulting chromaticity. The reddening therefore falls out of the
 * physics of the atmosphere the sunlight traversed, and the same machinery reddens the beam
 * when a smoke plume is over the site (M4 drives `setPlumeOpticalDepth`).
 *
 * Sources (all obtainable per spec §0.7.1):
 *  - Rayleigh optical depth: Hansen & Travis (1974) Space Sci. Rev. 16:527, Eq. 2.30;
 *    equivalently Bodhaine et al. (1999) JTECH 16:1854 §3 for the sea-level fit.
 *  - Ångström aerosol turbidity β(T): Preetham, Shirley & Smits (1999), "A Practical
 *    Analytic Model for Daylight", SIGGRAPH '99, §A.2.
 *  - Relative optical air mass: Kasten & Young (1989), Applied Optics 28:4735, Eq. 3.
 *  - CIE 1931 2° colour matching functions: multi-lobe Gaussian fit of Wyman, Sloan &
 *    Shirley (2013), "Simple Analytic Approximations to the CIE XYZ Color Matching
 *    Functions", JCGT 2(2):1-11, Table 1 (max error < 1% of peak).
 *  - CCT from chromaticity: McCamy (1992), Color Res. Appl. 17:142, Eq. 1.
 */

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Planck constant, J s. */
const H_PLANCK = 6.62607015e-34
/** Speed of light in vacuum, m/s. */
const C_LIGHT = 2.99792458e8
/** Boltzmann constant, J/K. */
const K_BOLTZMANN = 1.380649e-23

/**
 * Effective blackbody temperature of the solar photosphere, K. Used as the shape of the
 * extraterrestrial spectrum. A Planck curve is not the true ASTM E490 spectrum (which has
 * Fraunhofer absorption structure), but chromaticity of the *transmitted* beam is dominated
 * by the smooth wavelength dependence of the extinction, not by the line structure, and the
 * Planck form is exactly reproducible with no data table.
 */
export const SUN_EFFECTIVE_TEMPERATURE_K = 5778

// ---------------------------------------------------------------------------
// Blackbody
// ---------------------------------------------------------------------------

/**
 * Planck spectral radiance, W / (m^2 sr m), for wavelength in nanometres.
 * Only ratios across wavelength matter here, but the absolute form costs nothing.
 */
export function planckSpectralRadiance(lambdaNm: number, temperatureK: number): number {
  const l = lambdaNm * 1e-9
  const l5 = l * l * l * l * l
  const expo = (H_PLANCK * C_LIGHT) / (l * K_BOLTZMANN * temperatureK)
  return (2 * H_PLANCK * C_LIGHT * C_LIGHT) / (l5 * (Math.exp(expo) - 1))
}

// ---------------------------------------------------------------------------
// CIE 1931 colour matching (Wyman/Sloan/Shirley multi-lobe fit)
// ---------------------------------------------------------------------------

function lobe(x: number, mu: number, sigma1: number, sigma2: number): number {
  const t = (x - mu) / (x < mu ? sigma1 : sigma2)
  return Math.exp(-0.5 * t * t)
}

export function cieXBar(lambdaNm: number): number {
  return (
    1.056 * lobe(lambdaNm, 599.8, 37.9, 31.0) +
    0.362 * lobe(lambdaNm, 442.0, 16.0, 26.7) -
    0.065 * lobe(lambdaNm, 501.1, 20.4, 26.2)
  )
}

export function cieYBar(lambdaNm: number): number {
  return 0.821 * lobe(lambdaNm, 568.8, 46.9, 40.5) + 0.286 * lobe(lambdaNm, 530.9, 16.3, 31.1)
}

export function cieZBar(lambdaNm: number): number {
  return 1.217 * lobe(lambdaNm, 437.0, 11.8, 36.0) + 0.681 * lobe(lambdaNm, 459.0, 26.0, 13.8)
}

export const CIE_LAMBDA_MIN_NM = 380
export const CIE_LAMBDA_MAX_NM = 780
export const CIE_LAMBDA_STEP_NM = 5

/**
 * Integrate an arbitrary spectral power distribution against the CIE 1931 observer.
 * Returns unnormalised XYZ; only chromaticity is used downstream, so the scale is free.
 */
export function spectrumToXYZ(spd: (lambdaNm: number) => number): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  for (let l = CIE_LAMBDA_MIN_NM; l <= CIE_LAMBDA_MAX_NM; l += CIE_LAMBDA_STEP_NM) {
    const s = spd(l)
    x += s * cieXBar(l)
    y += s * cieYBar(l)
    z += s * cieZBar(l)
  }
  const k = CIE_LAMBDA_STEP_NM
  return [x * k, y * k, z * k]
}

/** Chromaticity coordinates from tristimulus values. */
export function xyFromXYZ(xyz: readonly [number, number, number]): [number, number] {
  const sum = xyz[0] + xyz[1] + xyz[2]
  if (sum <= 0) return [0.3333, 0.3333]
  return [xyz[0] / sum, xyz[1] / sum]
}

/**
 * Correlated colour temperature from CIE 1931 chromaticity, McCamy's cubic approximation.
 *
 * Valid to about ±2 K over 2856-6500 K and degrades outside roughly [2000, 12500] K, which
 * is exactly the region a low sun ends up in. The result is therefore clamped, and the clamp
 * is deliberate: below ~1800 K the beam is so attenuated it carries no usable irradiance and
 * the sky render is driven by scattered light rather than by the direct beam.
 */
export function cctMcCamy(x: number, y: number): number {
  const denom = 0.1858 - y
  if (Math.abs(denom) < 1e-9) return 6500
  const n = (x - 0.332) / denom
  const cct = 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33
  return Math.min(12000, Math.max(1500, cct))
}

// ---------------------------------------------------------------------------
// Atmospheric extinction
// ---------------------------------------------------------------------------

/** Sea-level Rayleigh optical depth at wavelength in micrometres (Hansen & Travis 1974). */
export function rayleighOpticalDepth(lambdaUm: number): number {
  const l2 = lambdaUm * lambdaUm
  const l4 = l2 * l2
  return (0.008569 / l4) * (1 + 0.0113 / l2 + 0.00013 / l4)
}

/**
 * Ångström turbidity coefficient from Linke-style turbidity T, per Preetham §A.2.
 * T = 2 is an exceptionally clear atmosphere, 3 clear, 6 hazy, 10+ heavily polluted.
 */
export function angstromBeta(turbidity: number): number {
  return 0.04608365822050 * turbidity - 0.04586025928522
}

/** Aerosol optical depth, Ångström law with the standard continental exponent α = 1.3. */
export function aerosolOpticalDepth(lambdaUm: number, turbidity: number): number {
  const beta = Math.max(0, angstromBeta(turbidity))
  return beta * Math.pow(lambdaUm, -1.3)
}

/**
 * Smoke optical depth at wavelength, given a broadband (550 nm reference) plume optical
 * depth. Fresh wildfire smoke has an Ångström exponent near 1.5-2.0 for scattering; 1.5 is
 * used, which is why heavy smoke turns the sun deep orange-red rather than merely dimming it.
 */
export function smokeOpticalDepth(lambdaUm: number, tau550: number): number {
  if (tau550 <= 0) return 0
  return tau550 * Math.pow(0.55 / lambdaUm, 1.5)
}

/**
 * Relative optical air mass (Kasten & Young 1989). `zenithRad` is the *apparent* zenith
 * angle. Diverges gracefully past the horizon; clamped to the 90° value below it.
 */
export function kastenYoungAirMass(zenithRad: number): number {
  const zDeg = Math.min(90, (zenithRad * 180) / Math.PI)
  const cosZ = Math.cos((zDeg * Math.PI) / 180)
  return 1 / (cosZ + 0.50572 * Math.pow(96.07995 - zDeg, -1.6364))
}

// ---------------------------------------------------------------------------
// Direct beam colour
// ---------------------------------------------------------------------------

export interface BeamColour {
  /** CIE 1931 chromaticity of the transmitted direct beam. */
  readonly x: number
  readonly y: number
  /** Correlated colour temperature, K. */
  readonly cct: number
  /** Broadband (photopic-weighted) transmittance of the beam, [0,1]. */
  readonly transmittance: number
  /** Normalised linear sRGB, peak channel = 1. For tinting the sun disc and the key light. */
  readonly rgb: readonly [number, number, number]
}

/**
 * Colour of the direct solar beam after traversing the atmosphere (and any smoke plume).
 *
 * @param apparentElevationRad refracted solar elevation; below the horizon the beam is
 *        evaluated at the horizon air mass, since there is no beam to speak of anyway.
 * @param turbidity Ångström/Linke turbidity.
 * @param plumeTau broadband smoke optical depth along the sun ray, 0 when no plume.
 */
export function directBeamColour(
  apparentElevationRad: number,
  turbidity: number,
  plumeTau = 0,
): BeamColour {
  const zenith = Math.PI / 2 - Math.max(apparentElevationRad, 0)
  const m = kastenYoungAirMass(zenith)

  const transmit = (lambdaNm: number): number => {
    const um = lambdaNm / 1000
    const tau = rayleighOpticalDepth(um) + aerosolOpticalDepth(um, turbidity)
    // The plume sits between sun and observer but is not stratified with air mass in the
    // same way; it is a local column, so it is applied once rather than scaled by m.
    return Math.exp(-tau * m - smokeOpticalDepth(um, plumeTau))
  }

  const beam = (lambdaNm: number): number =>
    planckSpectralRadiance(lambdaNm, SUN_EFFECTIVE_TEMPERATURE_K) * transmit(lambdaNm)
  const top = (lambdaNm: number): number =>
    planckSpectralRadiance(lambdaNm, SUN_EFFECTIVE_TEMPERATURE_K)

  const xyzBeam = spectrumToXYZ(beam)
  const xyzTop = spectrumToXYZ(top)
  const [cx, cy] = xyFromXYZ(xyzBeam)

  const transmittance = xyzTop[1] > 0 ? xyzBeam[1] / xyzTop[1] : 0
  const rgb = normalisedRgbFromChromaticity(cx, cy)

  return { x: cx, y: cy, cct: cctMcCamy(cx, cy), transmittance, rgb }
}

// ---------------------------------------------------------------------------
// Colour space
// ---------------------------------------------------------------------------

/** CIE XYZ (D65) to linear sRGB. IEC 61966-2-1. */
export function xyzToLinearSrgb(
  xyz: readonly [number, number, number],
): [number, number, number] {
  const [X, Y, Z] = xyz
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ]
}

/** xyY (Y = luminance) to linear sRGB. */
export function xyYToLinearSrgb(x: number, y: number, Y: number): [number, number, number] {
  if (y <= 1e-6) return [0, 0, 0]
  const X = (x * Y) / y
  const Z = ((1 - x - y) * Y) / y
  return xyzToLinearSrgb([X, Y, Z])
}

/** Linear sRGB for a chromaticity, renormalised so the largest channel is 1 and none negative. */
export function normalisedRgbFromChromaticity(x: number, y: number): [number, number, number] {
  const rgb = xyYToLinearSrgb(x, y, 1)
  const clipped: [number, number, number] = [
    Math.max(0, rgb[0]),
    Math.max(0, rgb[1]),
    Math.max(0, rgb[2]),
  ]
  const peak = Math.max(clipped[0], clipped[1], clipped[2])
  if (peak <= 0) return [1, 1, 1]
  return [clipped[0] / peak, clipped[1] / peak, clipped[2] / peak]
}

/**
 * Luminous efficacy of daylight, lm/W. Used to convert the Preetham model's photometric
 * output (cd/m^2) into radiometric sky radiance (W/m^2/sr) so that the sky's integrated
 * irradiance can be compared with — and normalised against — the Erbs diffuse horizontal
 * irradiance computed from the same solar state.
 *
 * 105 lm/W is the standard value for global daylight (Littlefair 1985, "The luminous
 * efficacy of daylight: a review", Lighting Res. Technol. 17:162, Table 1).
 */
export const DAYLIGHT_LUMINOUS_EFFICACY = 105
