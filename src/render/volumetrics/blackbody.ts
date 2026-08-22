/**
 * Blackbody emission colour — WP 4.2, spec §7.1.3.
 *
 * Builds a 256-entry LUT of linear-sRGB chroma over T ∈ [500, 2500] K by integrating Planck's
 * law against the CIE 1931 2° colour-matching functions and normalising each entry to unit
 * luminance. Absolute magnitude is restored at shading time by Stefan–Boltzmann, so the LUT
 * carries hue and saturation only.
 *
 * ## Why not the usual shortcut
 *
 * §7.1.3 explicitly forbids the Kang et al. (2002) Planckian-locus cubic: its stated validity
 * range is 1667–25000 K, and smouldering combustion at 800–1100 K — the glowing-char colour
 * that makes a burnt-over area read as still alive — sits below it. Evaluating Planck at load
 * time costs milliseconds once and removes the restriction entirely.
 *
 * ## The colour-matching functions
 *
 * Wyman, Sloan & Shirley's (2013) multi-lobe piecewise-Gaussian fit is used rather than the
 * tabulated CIE data. It is a published approximation with a stated error bound, it is seven
 * lines instead of 243 transcribed numbers, and a transcription error in a table that large is
 * both likely and invisible. `blackbody.test.ts` checks the result against published Planckian
 * chromaticities, which is what actually pins the model down.
 */

/** Planck's first radiation constant for spectral radiance, 2hc², W m² sr⁻¹. */
export const C1L = 1.1910429e-16
/** Planck's second radiation constant, hc/k_B, m K. */
export const C2 = 1.438777e-2
export const STEFAN_BOLTZMANN = 5.670374419e-8

export const LUT_SIZE = 256
export const LUT_MIN_K = 500
export const LUT_MAX_K = 2500

/**
 * Spectral radiance of a blackbody at wavelength `lambdaNm`, W m⁻² sr⁻¹ m⁻¹.
 *
 * Guarded at both ends: `expm1` keeps the low-temperature tail accurate where `exp(x) - 1`
 * would cancel catastrophically, and a non-positive temperature radiates nothing rather than
 * producing a NaN that would propagate into the LUT and out to every flame in the scene.
 */
export function planck(lambdaNm: number, temperatureK: number): number {
  if (!(temperatureK > 0) || !(lambdaNm > 0)) return 0
  const l = lambdaNm * 1e-9
  const x = C2 / (l * temperatureK)
  // Above ~700 the exponential overflows to Infinity and the ratio becomes 0, which is the
  // correct limit but arrives as NaN if computed as C1L/l^5 * 1/(Inf - 1) in some orders.
  if (x > 700) return 0
  return C1L / (l ** 5 * Math.expm1(x))
}

/** Piecewise Gaussian: `sigma1` below the peak, `sigma2` above. Wyman et al.'s `g`. */
function piecewiseGaussian(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2)
  return Math.exp(-0.5 * t * t)
}

/** CIE 1931 2° x̄, ȳ, z̄ at `lambdaNm`, from the Wyman/Sloan/Shirley multi-lobe fit. */
export function cieXyzBar(lambdaNm: number): readonly [number, number, number] {
  const x =
    1.056 * piecewiseGaussian(lambdaNm, 599.8, 37.9, 31.0) +
    0.362 * piecewiseGaussian(lambdaNm, 442.0, 16.0, 26.7) -
    0.065 * piecewiseGaussian(lambdaNm, 501.1, 20.4, 26.2)
  const y =
    0.821 * piecewiseGaussian(lambdaNm, 568.8, 46.9, 40.5) +
    0.286 * piecewiseGaussian(lambdaNm, 530.9, 16.3, 31.1)
  const z =
    1.217 * piecewiseGaussian(lambdaNm, 437.0, 11.8, 36.0) +
    0.681 * piecewiseGaussian(lambdaNm, 459.0, 26.0, 13.8)
  return [x, y, z]
}

/** Unnormalised CIE XYZ of a blackbody at `temperatureK`, integrated over 380–780 nm. */
export function blackbodyXyz(temperatureK: number, stepNm = 5): readonly [number, number, number] {
  let X = 0
  let Y = 0
  let Z = 0
  for (let l = 380; l <= 780; l += stepNm) {
    const b = planck(l, temperatureK)
    const [xb, yb, zb] = cieXyzBar(l)
    X += xb * b
    Y += yb * b
    Z += zb * b
  }
  return [X * stepNm, Y * stepNm, Z * stepNm]
}

/** CIE 1931 chromaticity of a blackbody. The quantity published tables can be checked against. */
export function blackbodyChromaticity(temperatureK: number): readonly [number, number] {
  const [X, Y, Z] = blackbodyXyz(temperatureK)
  const sum = X + Y + Z
  if (!(sum > 0)) return [0, 0]
  return [X / sum, Y / sum]
}

/** CIE XYZ (D65) → linear sRGB. The standard sRGB matrix, not a fit. */
export function xyzToLinearSrgb(
  X: number,
  Y: number,
  Z: number,
): readonly [number, number, number] {
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ]
}

/**
 * Linear-sRGB chroma of a blackbody, normalised to unit luminance (Y = 1).
 *
 * Negative components are clamped. This is not a rounding guard: a Planckian below roughly
 * 1500 K is genuinely **outside the sRGB gamut**, and at 800 K — glowing char, smouldering duff
 * — both green and blue come out negative, so the result is fully saturated red and cannot be
 * made redder. That is a display limit, not a model limit. The temperature trend is still there
 * in the chromaticity; it just cannot be shown on this gamut, and `blackbody.test.ts` asserts
 * the trend on XYZ for exactly that reason.
 */
export function blackbodyLinearSrgb(temperatureK: number): readonly [number, number, number] {
  const [X, Y, Z] = blackbodyXyz(temperatureK)
  if (!(Y > 0)) return [0, 0, 0]
  const [r, g, b] = xyzToLinearSrgb(X / Y, 1, Z / Y)
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)]
}

/**
 * The shipping LUT: `LUT_SIZE` RGB triples over [`LUT_MIN_K`, `LUT_MAX_K`], unit luminance.
 *
 * Returned as `Float32Array` of `LUT_SIZE * 4` (RGB + padding) so it uploads straight into an
 * `rgba32float` 1D texture without a repack.
 */
export function buildBlackbodyLut(): Float32Array<ArrayBuffer> {
  const out = new Float32Array(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = LUT_MIN_K + ((LUT_MAX_K - LUT_MIN_K) * i) / (LUT_SIZE - 1)
    const [r, g, b] = blackbodyLinearSrgb(t)
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 1
  }
  return out
}

/** Total emissive power per unit area, W m⁻². Restores the magnitude the LUT normalised away. */
export const stefanBoltzmann = (temperatureK: number): number =>
  STEFAN_BOLTZMANN * temperatureK ** 4

