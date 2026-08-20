/**
 * The blackbody LUT, checked against published chromaticities rather than against itself.
 *
 * This matters more than a usual unit test because the colour-matching functions are an
 * analytic *fit* recalled into the source. If those coefficients are wrong the LUT still looks
 * like a plausible fire — warm, orange-ish, monotonic — and only a comparison with a published
 * point catches it. CIE illuminant A is defined as a Planckian radiator at 2856 K with
 * chromaticity x = 0.44757, y = 0.40745, which makes it exactly the right probe.
 */

import { describe, expect, it } from 'vitest'
import {
  LUT_MAX_K,
  LUT_MIN_K,
  LUT_SIZE,
  blackbodyChromaticity,
  blackbodyLinearSrgb,
  blackbodyXyz,
  buildBlackbodyLut,
  planck,
  stefanBoltzmann,
} from '@render/volumetrics/blackbody.ts'

describe('planck', () => {
  it('peaks where Wien says it should', () => {
    // Wien displacement: lambda_max * T = 2.8977719e-3 m K. At 1400 K that is 2070 nm, far
    // into the infrared — which is exactly why a wildland flame is dim and orange rather than
    // bright and white.
    const t = 1400
    const wienNm = (2.8977719e-3 / t) * 1e9
    const atPeak = planck(wienNm, t)
    expect(planck(wienNm * 0.7, t)).toBeLessThan(atPeak)
    expect(planck(wienNm * 1.4, t)).toBeLessThan(atPeak)
  })

  it('rises monotonically with temperature at every wavelength', () => {
    for (const l of [420, 550, 700]) {
      expect(planck(l, 1200)).toBeGreaterThan(planck(l, 900))
      expect(planck(l, 2000)).toBeGreaterThan(planck(l, 1200))
    }
  })

  it('returns zero rather than NaN for degenerate inputs', () => {
    expect(planck(550, 0)).toBe(0)
    expect(planck(550, -100)).toBe(0)
    expect(planck(0, 1500)).toBe(0)
    // Deep in the tail the exponent overflows; the limit is 0, and a NaN here would turn every
    // flame in the scene black.
    expect(Number.isFinite(planck(1, 300))).toBe(true)
  })
})

describe('chromaticity against published points', () => {
  it('reproduces CIE illuminant A at 2856 K', () => {
    const [x, y] = blackbodyChromaticity(2856)
    expect(x).toBeCloseTo(0.44757, 2)
    expect(y).toBeCloseTo(0.40745, 2)
  })

  it('reproduces the Planckian locus at 6500 K', () => {
    // Published Planckian chromaticity at 6500 K is approximately (0.3135, 0.3237). Not D65,
    // which is a daylight illuminant sitting slightly off the locus.
    const [x, y] = blackbodyChromaticity(6500)
    expect(x).toBeCloseTo(0.3135, 2)
    expect(y).toBeCloseTo(0.3237, 2)
  })

  it('moves along the locus in the right direction as temperature rises', () => {
    const [x1000] = blackbodyChromaticity(1000)
    const [x2000] = blackbodyChromaticity(2000)
    const [x5000] = blackbodyChromaticity(5000)
    // Cooler is redder, so x decreases monotonically with temperature.
    expect(x1000).toBeGreaterThan(x2000)
    expect(x2000).toBeGreaterThan(x5000)
  })
})

describe('blackbodyLinearSrgb', () => {
  it('is red-dominant across the whole wildland flame range', () => {
    for (const t of [800, 1100, 1400, 1800, 2500]) {
      const [r, g, b] = blackbodyLinearSrgb(t)
      expect(r).toBeGreaterThan(g)
      expect(g).toBeGreaterThanOrEqual(b)
    }
  })

  it('clamps to saturated red below the sRGB gamut instead of going negative', () => {
    // A Planckian below roughly 1500 K is OUTSIDE sRGB: the unclamped green and blue channels
    // are genuinely negative, not small. Smouldering char therefore renders as fully saturated
    // red and cannot be made more red — a display limit, not a model limit, and worth pinning
    // so nobody later "fixes" the clamp and gets an inverted glow.
    const [r, g, b] = blackbodyLinearSrgb(800)
    expect(r).toBeGreaterThan(0)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })

  it('gets bluer with temperature — the thin-blue-base, thick-orange-core structure', () => {
    // Asserted on chromaticity, not on the clamped sRGB triple: below the gamut the blue
    // channel is pinned at zero and cannot show the trend that is physically there.
    const zOver = (t: number): number => {
      const [X, Y, Z] = blackbodyXyz(t)
      void X
      return Z / Y
    }
    expect(zOver(1800)).toBeGreaterThan(zOver(1100))
    expect(zOver(1100)).toBeGreaterThan(zOver(800))
  })

  it('never returns a negative channel, however far out of gamut', () => {
    for (let t = 500; t <= 2500; t += 25) {
      for (const c of blackbodyLinearSrgb(t)) expect(c).toBeGreaterThanOrEqual(0)
    }
  })

  it('carries chroma only — magnitude comes from Stefan-Boltzmann', () => {
    // Normalised to unit luminance, so a 2500 K entry is not 20x the 800 K one; the LUT would
    // otherwise apply the T^4 law twice.
    const cold = blackbodyLinearSrgb(800)
    const hot = blackbodyLinearSrgb(2400)
    const mag = (c: readonly number[]): number => (c[0] as number) + (c[1] as number) + (c[2] as number)
    expect(mag(hot) / mag(cold)).toBeLessThan(3)
    // The actual ratio of emitted power over that range is enormous, and lives here instead.
    expect(stefanBoltzmann(2400) / stefanBoltzmann(800)).toBeCloseTo(81, 0)
  })
})

describe('buildBlackbodyLut', () => {
  it('is RGBA-packed and spans the declared range', () => {
    const lut = buildBlackbodyLut()
    expect(lut.length).toBe(LUT_SIZE * 4)
    const first = blackbodyLinearSrgb(LUT_MIN_K)
    const last = blackbodyLinearSrgb(LUT_MAX_K)
    expect(lut[0]).toBeCloseTo(first[0] as number, 6)
    expect(lut[(LUT_SIZE - 1) * 4]).toBeCloseTo(last[0] as number, 6)
    for (let i = 0; i < LUT_SIZE; i++) expect(lut[i * 4 + 3]).toBe(1)
  })

  it('holds no NaN anywhere — one would blacken every flame that samples it', () => {
    for (const v of buildBlackbodyLut()) expect(Number.isFinite(v)).toBe(true)
  })
})
