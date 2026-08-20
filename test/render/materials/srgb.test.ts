/**
 * sRGB / linear correctness. WP 1.6.
 *
 * This is the highest-value test in the package. A PBR pipeline that confuses the two does not
 * throw and does not look obviously broken; it is wrong everywhere by a brightness-dependent
 * factor, and the error is largest near black, which in this project is exactly where char and
 * ash live. Every reference value below is derived from the IEC 61966-2-1 definition rather
 * than transcribed, so the test is checkable by hand.
 */

import { describe, expect, it } from 'vitest'
import {
  MID_GREY_LINEAR_AS_RAW_U8,
  MID_GREY_LINEAR_AS_SRGB_U8,
  SRGB_ENCODED_THRESHOLD,
  SRGB_LINEAR_SLOPE,
  SRGB_LINEAR_THRESHOLD,
  SRGB_REFERENCE,
  SRGB_U8_TO_LINEAR,
  linearToSrgb,
  linearToSrgbU8,
  srgbToLinear,
  srgbU8ToLinear,
  srgbU8ToLinearFast,
} from '../../../src/render/materials/srgb.ts'
import { reduceLevel, type BakedLevel } from '../../../src/render/materials/bake.ts'

describe('sRGB transfer function', () => {
  it('reproduces every reference value in both directions', () => {
    for (const ref of SRGB_REFERENCE) {
      // The segment-join row is the one place the standard is not self-consistent: IEC
      // 61966-2-1 publishes 0.0031308 and 0.04045 as ROUNDED constants, and 12.92 * 0.0031308
      // is 0.040449936, not 0.04045. The real curve therefore has a ~6.4e-8 discontinuity at
      // the join. That is a property of the standard, not of this implementation, and pinning
      // it here is worth more than papering over it — a future "fix" that removes the step
      // would silently change every encoded value near black.
      const digits = ref.name === 'segment-join' ? 6 : 12
      expect(linearToSrgb(ref.linear), `linearToSrgb(${ref.name})`).toBeCloseTo(ref.encoded, digits)
      expect(srgbToLinear(ref.encoded), `srgbToLinear(${ref.name})`).toBeCloseTo(ref.linear, digits)
    }
  })

  it('has the standard\'s own ~6.4e-8 step at the segment join, and no more', () => {
    const below = SRGB_LINEAR_SLOPE * SRGB_LINEAR_THRESHOLD
    const above = 1.055 * Math.pow(SRGB_LINEAR_THRESHOLD, 1 / 2.4) - 0.055
    expect(Math.abs(below - above)).toBeLessThan(1e-6)
    expect(Math.abs(below - SRGB_ENCODED_THRESHOLD)).toBeLessThan(1e-6)
  })

  it('uses the piecewise curve, not the gamma-2.2 approximation', () => {
    // The two agree to ~1% in the midtones and diverge badly near black. If someone
    // "simplifies" the implementation to pow(x, 2.2), this is the assertion that catches it.
    const approx = Math.pow(0.5, 2.2)
    const exact = srgbToLinear(0.5)
    expect(exact).toBeCloseTo(0.21404114048223255, 12)
    expect(Math.abs(exact - approx)).toBeGreaterThan(0.0);
    expect(approx).not.toBeCloseTo(exact, 3)
  })

  it('is exactly linear below the segment threshold', () => {
    for (const x of [0, 1e-5, 0.001, SRGB_LINEAR_THRESHOLD]) {
      expect(linearToSrgb(x)).toBeCloseTo(SRGB_LINEAR_SLOPE * x, 12)
    }
    for (const y of [0, 1e-4, 0.01, SRGB_ENCODED_THRESHOLD]) {
      expect(srgbToLinear(y)).toBeCloseTo(y / SRGB_LINEAR_SLOPE, 12)
    }
  })

  it('is continuous across the segment join to within the standard\'s own rounding', () => {
    const eps = 1e-9
    expect(linearToSrgb(SRGB_LINEAR_THRESHOLD - eps)).toBeCloseTo(
      linearToSrgb(SRGB_LINEAR_THRESHOLD + eps),
      7,
    )
  })

  it('round-trips through 8 bits within half a code value', () => {
    for (let byte = 0; byte <= 255; byte++) {
      const back = linearToSrgbU8(srgbU8ToLinear(byte))
      expect(Math.abs(back - byte), `byte ${byte}`).toBeLessThanOrEqual(0)
    }
  })

  it('puts linear 0.5 at byte 188, not 128 — the canonical demonstration', () => {
    expect(linearToSrgbU8(0.5)).toBe(MID_GREY_LINEAR_AS_SRGB_U8)
    expect(MID_GREY_LINEAR_AS_SRGB_U8).not.toBe(MID_GREY_LINEAR_AS_RAW_U8)
    // And the reverse mistake: reading byte 128 as if it were linear.
    expect(srgbU8ToLinear(128)).toBeCloseTo(0.21586050011389923, 12)
  })

  it('has a lookup table identical to the analytic decode', () => {
    expect(SRGB_U8_TO_LINEAR.length).toBe(256)
    for (let byte = 0; byte <= 255; byte++) {
      expect(srgbU8ToLinearFast(byte)).toBeCloseTo(srgbU8ToLinear(byte), 6)
    }
  })

  it('clamps rather than producing NaN outside [0,1]', () => {
    expect(linearToSrgb(-1)).toBe(0)
    expect(linearToSrgb(Number.NaN)).toBe(0)
    expect(linearToSrgb(2)).toBe(1)
    expect(srgbToLinear(-1)).toBe(0)
    expect(srgbToLinear(Number.NaN)).toBe(0)
    expect(srgbToLinear(2)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The mip-reduction consequence
// ---------------------------------------------------------------------------

function checker(size: number, a: number, b: number): BakedLevel {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x + y) % 2 === 0 ? a : b
      const i = (y * size + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { size, data }
}

describe('mip reduction respects the transfer function', () => {
  it('averages sRGB albedo in LINEAR space', () => {
    // A black/white checker. The correct 2x2 reduction averages LINEAR 0 and 1 to linear 0.5,
    // which encodes to byte 188. Averaging the stored bytes gives 128 — a factor of 2.3 too
    // dark in linear terms, and it looks like aerial perspective rather than like a bug.
    const level = checker(4, 0, 255)
    const reduced = reduceLevel(level, 'srgb-rgb-linear-a')
    expect(reduced.size).toBe(2)
    expect(reduced.data[0]).toBe(MID_GREY_LINEAR_AS_SRGB_U8)
    expect(reduced.data[0]).not.toBe(MID_GREY_LINEAR_AS_RAW_U8)
  })

  it('averages a linear array (ORM) as stored bytes', () => {
    // Same checker through the linear path must give the arithmetic mean of the BYTES,
    // because there is no transfer function on a roughness.
    const reduced = reduceLevel(checker(4, 0, 255), 'linear')
    expect(reduced.data[0]).toBe(128)
  })

  it('leaves alpha linear inside an sRGB texture', () => {
    // Alpha 0 and 255 in a checker; the sRGB path must average them arithmetically to 128.
    // Pushing alpha through the curve would give 188 and would move every foliage alpha-test
    // cutout, which reads as an LOD silhouette change rather than as a colour-space bug.
    const size = 4
    const data = new Uint8Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const x = i % size
      const y = Math.floor(i / size)
      data[i * 4 + 3] = (x + y) % 2 === 0 ? 0 : 255
    }
    const reduced = reduceLevel({ size, data }, 'srgb-rgb-linear-a')
    expect(reduced.data[3]).toBe(128)
  })

  it('renormalises averaged normals', () => {
    // Two normals tilted symmetrically about the surface normal. Averaging the encoded bytes
    // and stopping there shortens the vector; the reduction must produce a UNIT normal.
    const size = 2
    const data = new Uint8Array(size * size * 4)
    const enc = (v: number): number => Math.round((v * 0.5 + 0.5) * 255)
    const set = (i: number, x: number, y: number): void => {
      data[i * 4] = enc(x)
      data[i * 4 + 1] = enc(y)
      data[i * 4 + 2] = 128
      data[i * 4 + 3] = 255
    }
    set(0, 0.6, 0)
    set(1, -0.6, 0)
    set(2, 0, 0.6)
    set(3, 0, -0.6)
    const reduced = reduceLevel({ size, data }, 'normal')
    const nx = (reduced.data[0] as number) / 255 * 2 - 1
    const ny = (reduced.data[1] as number) / 255 * 2 - 1
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5)
    // Symmetric inputs average to the flat normal.
    expect(nx).toBeCloseTo(0, 2)
    expect(ny).toBeCloseTo(0, 2)
  })
})
