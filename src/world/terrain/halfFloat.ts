/**
 * IEEE 754 binary16 conversion, for packing the `rg16float` slope/aspect texture.
 *
 * WebGPU has no CPU-side half-float helper and this project takes no dependencies, so the
 * conversion is written out. It is round-to-nearest-even, matching what the GPU does when
 * it dequantises the texel, which is why the CPU-side texel emulation in `sampling.ts` can
 * predict the GPU's answer to the bit rather than to a fudge factor.
 *
 * Quantisation budget for the two channels actually stored:
 *  - slope tangent, typically 0..2: ulp is 2^-11 ~ 4.9e-4 at 0.5, 9.8e-4 at 1.0.
 *  - aspect, 0..2*pi: ulp is 2^-8 ~ 3.9e-3 rad at 6.28, i.e. 0.22 degrees worst case.
 *
 * A tenth of a degree of aspect is far below the accuracy of anything that consumes it
 * (solar load on a slope, the Rothermel slope term, terrain shading), so `rg16float` is
 * not a compromise here — but the number is stated because the CPU/GPU agreement tolerance
 * is derived from it rather than guessed.
 */

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** Encode a JS number as an IEEE 754 binary16 bit pattern (round-to-nearest-even). */
export function f32ToF16(value: number): number {
  F32[0] = value
  const x = U32[0] as number
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x007fffff

  if (exp === 0xff) {
    // Inf, or NaN with a non-zero payload preserved as a quiet NaN.
    return sign | 0x7c00 | (mant !== 0 ? 0x0200 : 0)
  }

  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00 // overflow -> Inf
  if (e <= 0) {
    if (e < -10) return sign // magnitude below half of the smallest subnormal
    mant |= 0x00800000 // restore the implicit leading 1
    const shift = 14 - e // 14..24
    let half = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rem > halfway || (rem === halfway && (half & 1) === 1)) half++
    return sign | half
  }

  let half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  // A carry out of the mantissa correctly increments the exponent, and 0x7bff + 1 = Inf.
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1) === 1)) half++
  return sign | half
}

/** Decode an IEEE 754 binary16 bit pattern. Exact — every f16 is representable in f64. */
export function f16ToF32(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const mant = bits & 0x03ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant !== 0 ? NaN : sign * Infinity
  return sign * (mant + 1024) * 2 ** (exp - 25)
}

/** Value as it will read back after a round trip through an f16 texel. */
export function quantiseF16(value: number): number {
  return f16ToF32(f32ToF16(value))
}
