/**
 * sRGB <-> linear transfer functions, and the 8-bit encode/decode boundary.
 *
 * WP 1.6. This file is small and boring and it is the single most load-bearing file in the
 * material pipeline. The classic silent failure in a PBR pipeline is a colour that is
 * *encoded* sRGB being treated as *linear* (or vice versa): nothing throws, nothing looks
 * obviously broken, and every lighting result is wrong by a factor that varies with
 * brightness. A linear 0.5 grey encodes to 188/255, not 128/255 — a 2.3x error in the
 * middle of the range.
 *
 * The rules this file exists to enforce:
 *
 *   - Albedo is authored and stored *sRGB-encoded*. The GPU decodes it for free because the
 *     texture format carries the `-srgb` suffix. Shader code therefore never calls a decode.
 *   - Normal, ORM (occlusion/roughness/metallic), height and the crack field are *linear*
 *     data that merely happens to live in 8 bits. They must NOT use an `-srgb` format.
 *   - ALPHA IS ALWAYS LINEAR, even inside an `rgba8unorm-srgb` texture. The sRGB transfer
 *     applies to the three colour channels only. Encoding alpha through the sRGB curve is a
 *     real and common bug that shows up as foliage alpha-test cutouts moving when you change
 *     texture format.
 *   - Mip reduction of an sRGB-encoded image must average in LINEAR space. Averaging the
 *     stored bytes is wrong, and it is wrong in the direction of "distant foliage is too
 *     dark", which reads as a plausible aerial-perspective effect rather than as a bug.
 *
 * Formulation: IEC 61966-2-1 (sRGB), the piecewise curve with the 12.92 linear segment. Not
 * the gamma-2.2 approximation — the two differ by up to ~1% in the midtones and by much more
 * near black, and near-black is exactly where char and ash live in this project.
 */

/** Linear value below which the transfer function is the linear segment. */
export const SRGB_LINEAR_THRESHOLD = 0.0031308
/** Encoded value below which the inverse transfer function is the linear segment. */
export const SRGB_ENCODED_THRESHOLD = 0.04045
/** Slope of the linear segment. */
export const SRGB_LINEAR_SLOPE = 12.92
export const SRGB_ALPHA = 0.055
export const SRGB_GAMMA = 2.4

/**
 * Linear -> sRGB-encoded, both in [0, 1].
 *
 * Values outside [0,1] are clamped; the sRGB curve is not defined for negatives and a
 * negative albedo is a bug in the caller, not something to propagate as NaN.
 */
export function linearToSrgb(linear: number): number {
  if (!(linear > 0)) return 0 // also catches NaN
  if (linear >= 1) return 1
  if (linear <= SRGB_LINEAR_THRESHOLD) return SRGB_LINEAR_SLOPE * linear
  return (1 + SRGB_ALPHA) * Math.pow(linear, 1 / SRGB_GAMMA) - SRGB_ALPHA
}

/** sRGB-encoded -> linear, both in [0, 1]. */
export function srgbToLinear(encoded: number): number {
  if (!(encoded > 0)) return 0
  if (encoded >= 1) return 1
  if (encoded <= SRGB_ENCODED_THRESHOLD) return encoded / SRGB_LINEAR_SLOPE
  return Math.pow((encoded + SRGB_ALPHA) / (1 + SRGB_ALPHA), SRGB_GAMMA)
}

/** Quantise a unit-range value to 8 bits with round-to-nearest and clamping. */
export function encodeU8(unit: number): number {
  if (!(unit > 0)) return 0
  if (unit >= 1) return 255
  return Math.round(unit * 255)
}

/** 8-bit byte -> unit range. */
export function decodeU8(byte: number): number {
  return byte / 255
}

/** Linear scalar -> the byte stored in an `rgba8unorm-srgb` colour channel. */
export function linearToSrgbU8(linear: number): number {
  return encodeU8(linearToSrgb(linear))
}

/** The byte stored in an `rgba8unorm-srgb` colour channel -> the linear value the GPU sees. */
export function srgbU8ToLinear(byte: number): number {
  return srgbToLinear(byte / 255)
}

/**
 * Precomputed 256-entry decode table. The generator round-trips millions of texels; the
 * `Math.pow` in the inverse curve is the hot spot and this removes it from the read path.
 */
export const SRGB_U8_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255)
  return t
})()

/** Fast decode via the lookup table. Byte must be an integer in [0, 255]. */
export function srgbU8ToLinearFast(byte: number): number {
  return SRGB_U8_TO_LINEAR[byte] ?? 0
}

/**
 * Which transfer function a texture array carries. Used to pick the GPU format and to pick
 * the mip-reduction path — the two decisions must never disagree, which is why they are
 * driven from one value.
 */
export type ColorSpace = 'srgb' | 'linear'

/**
 * Reference values. Sourced from the sRGB definition itself rather than transcribed from a
 * blog post; every one is reproducible by hand from the piecewise formula above.
 *
 * These are the assertions that catch a pipeline-wide encode/decode inversion. If someone
 * later "simplifies" the transfer function to `pow(x, 2.2)`, the 0.5 and 0.2 rows fail.
 */
export const SRGB_REFERENCE: readonly {
  readonly name: string
  readonly linear: number
  readonly encoded: number
}[] = [
  { name: 'black', linear: 0, encoded: 0 },
  { name: 'white', linear: 1, encoded: 1 },
  // Inside the linear segment: encoded = 12.92 * linear, exactly.
  { name: 'linear-segment', linear: 0.002, encoded: 0.02584 },
  // The segment join, both sides.
  { name: 'segment-join', linear: SRGB_LINEAR_THRESHOLD, encoded: SRGB_ENCODED_THRESHOLD },
  // Mid-grey. The canonical demonstration: linear 0.5 is byte 188, not byte 128.
  { name: 'mid-grey-linear', linear: 0.5, encoded: 0.735356983052449 },
  // Perceptual middle. sRGB 0.5 is linear 0.214, not 0.5.
  { name: 'mid-grey-encoded', linear: 0.21404114048223255, encoded: 0.5 },
  // 8-bit 128 (= 0.50196...) decodes to this. Widely quoted; derived here, not copied.
  { name: 'byte-128', linear: 0.21586050011389923, encoded: 128 / 255 },
]

/** Byte value of linear 0.5 through the sRGB curve. Exported so the test can name it. */
export const MID_GREY_LINEAR_AS_SRGB_U8 = 188
/** Byte value of linear 0.5 if you (wrongly) skip the transfer function. */
export const MID_GREY_LINEAR_AS_RAW_U8 = 128
