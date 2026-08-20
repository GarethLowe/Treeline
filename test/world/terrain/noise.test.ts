/**
 * The primitives everything else is built on: the PRNG, the noise field, and the half-float
 * codec. If any of these is non-deterministic or subtly out of range, every downstream
 * property — reproducible worlds, relief-controlled slope, CPU/GPU agreement — fails in a
 * way that is very hard to attribute. So they are pinned here first.
 */

import { describe, expect, it } from 'vitest'
import { Rng, hash3, hashU32 } from '@world/terrain/rng.ts'
import { DEFAULT_FBM, fbm2, perlin2, ridged2, warp2 } from '@world/terrain/noise.ts'
import { f16ToF32, f32ToF16, quantiseF16 } from '@world/terrain/halfFloat.ts'

describe('Rng', () => {
  it('is a pure function of the seed', () => {
    const a = Array.from({ length: 64 }, (_, i) => new Rng(99).nextU32() + i * 0)
    const b = Array.from({ length: 64 }, () => 0)
    const r = new Rng(99)
    for (let i = 0; i < 64; i++) b[i] = r.nextU32()
    // Every element of `a` is the FIRST draw of a fresh Rng(99), so they are all equal to
    // each other and to b[0]: that is the determinism claim in its strongest form.
    expect(new Set(a).size).toBe(1)
    expect(a[0]).toBe(b[0])
  })

  it('produces the same sequence for the same seed', () => {
    const seq = (): number[] => {
      const r = new Rng(0xbeef)
      return Array.from({ length: 256 }, () => r.nextU32())
    }
    expect(seq()).toEqual(seq())
  })

  it('produces different sequences for adjacent seeds', () => {
    const first = (s: number): number => new Rng(s).nextU32()
    const draws = [first(1), first(2), first(3), first(4)]
    expect(new Set(draws).size).toBe(4)
  })

  it('nextFloat stays in [0, 1) with a plausible mean', () => {
    const r = new Rng(7)
    let sum = 0
    let min = 1
    let max = 0
    const draws = 50_000
    for (let i = 0; i < draws; i++) {
      const v = r.nextFloat()
      if (!(v >= 0 && v < 1)) throw new Error(`nextFloat out of range: ${v}`)
      sum += v
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(sum / draws).toBeCloseTo(0.5, 2)
    expect(min).toBeLessThan(0.005)
    expect(max).toBeGreaterThan(0.995)
  })

  it('fork depends on the tag, not on how many draws the parent has taken', () => {
    const a = new Rng(5)
    const forkedEarly = a.fork(3).nextU32()
    for (let i = 0; i < 100; i++) a.nextU32()
    const forkedLate = a.fork(3).nextU32()
    expect(forkedLate).toBe(forkedEarly)
    expect(new Rng(5).fork(4).nextU32()).not.toBe(forkedEarly)
  })

  it('hashU32 and hash3 are stable and well spread', () => {
    expect(hashU32(0)).toBe(hashU32(0))
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3))
    expect(hash3(1, 2, 3)).not.toBe(hash3(3, 2, 1))
    const seen = new Set<number>()
    for (let i = 0; i < 20_000; i++) seen.add(hashU32(i))
    // A 32-bit hash of 20k distinct inputs collides ~0.05 times by birthday; more than a
    // handful means the finaliser is not mixing.
    expect(seen.size).toBeGreaterThan(19_995)
  })
})

describe('perlin2', () => {
  it('is deterministic and seed-dependent', () => {
    expect(perlin2(1.25, -3.5, 11)).toBe(perlin2(1.25, -3.5, 11))
    expect(perlin2(1.25, -3.5, 11)).not.toBe(perlin2(1.25, -3.5, 12))
  })

  it('vanishes at integer lattice points', () => {
    // Gradient noise is the dot product of a gradient with the offset from the lattice
    // point, so it is exactly zero on the lattice. Worth pinning: if this drifts, the fade
    // or the offset indexing is wrong.
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        expect(Math.abs(perlin2(i, j, 42))).toBeLessThan(1e-12)
      }
    }
  })

  it('stays inside [-1, 1] over a dense sample', () => {
    const r = new Rng(3)
    let max = 0
    for (let i = 0; i < 100_000; i++) {
      const v = perlin2(r.range(-500, 500), r.range(-500, 500), 8)
      max = Math.max(max, Math.abs(v))
    }
    // The analytic bound for 2D gradient noise with unit gradients is sqrt(2)/2, and the
    // implementation scales by sqrt(2) to land on 1.
    expect(max).toBeLessThanOrEqual(1.0001)
    // ...and actually uses the range, rather than being a flat field.
    expect(max).toBeGreaterThan(0.7)
  })

  it('is continuous — no seams at lattice boundaries', () => {
    const eps = 1e-4
    for (let k = 0; k < 200; k++) {
      const x = k * 0.37 // sweeps across many lattice boundaries
      const d = Math.abs(perlin2(x + eps, 2.5, 5) - perlin2(x - eps, 2.5, 5))
      expect(d).toBeLessThan(0.01)
    }
  })
})

describe('fractal stacks', () => {
  it('fbm2 is amplitude-normalised and octave count changes detail, not scale', () => {
    const stats = (octaves: number): number => {
      let max = 0
      const rr = new Rng(21)
      for (let i = 0; i < 20_000; i++) {
        const v = fbm2(rr.range(-200, 200), rr.range(-200, 200), 3, {
          ...DEFAULT_FBM,
          octaves,
        })
        max = Math.max(max, Math.abs(v))
      }
      return max
    }
    const m4 = stats(4)
    const m8 = stats(8)
    expect(m4).toBeLessThanOrEqual(1)
    expect(m8).toBeLessThanOrEqual(1)
    // Same order of magnitude: adding octaves must not rescale the field.
    expect(Math.abs(m8 - m4)).toBeLessThan(0.35)
  })

  it('ridged2 lands in [0, 1] with crests near the top', () => {
    const r = new Rng(9)
    let min = 1
    let max = 0
    for (let i = 0; i < 20_000; i++) {
      const v = ridged2(r.range(-200, 200), r.range(-200, 200), 17)
      if (!(v >= 0 && v <= 1)) throw new Error(`ridged2 out of range: ${v}`)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max).toBeGreaterThan(0.7)
    expect(min).toBeLessThan(0.1)
  })

  it('warp2 displaces by an amount bounded by the strength', () => {
    const out = { x: 0, z: 0 }
    const r = new Rng(4)
    for (let i = 0; i < 5_000; i++) {
      const x = r.range(-50, 50)
      const z = r.range(-50, 50)
      warp2(x, z, 1, 0.6, DEFAULT_FBM, out)
      expect(Math.abs(out.x - x)).toBeLessThanOrEqual(0.6)
      expect(Math.abs(out.z - z)).toBeLessThanOrEqual(0.6)
    }
  })
})

describe('half float', () => {
  it('matches known bit patterns', () => {
    expect(f32ToF16(0)).toBe(0x0000)
    expect(f32ToF16(-0)).toBe(0x8000)
    expect(f32ToF16(1)).toBe(0x3c00)
    expect(f32ToF16(-1)).toBe(0xbc00)
    expect(f32ToF16(0.5)).toBe(0x3800)
    expect(f32ToF16(2)).toBe(0x4000)
    expect(f32ToF16(65504)).toBe(0x7bff) // largest finite half
    expect(f32ToF16(65536)).toBe(0x7c00) // overflow -> Inf
    expect(f32ToF16(Infinity)).toBe(0x7c00)
    expect(f32ToF16(6.103515625e-5)).toBe(0x0400) // smallest normal
    expect(f32ToF16(5.960464477539063e-8)).toBe(0x0001) // smallest subnormal
  })

  it('round-trips exactly for values that are representable', () => {
    for (const v of [0, 1, -1, 0.5, 0.25, 1024, -2048, 65504, 6.103515625e-5]) {
      expect(f16ToF32(f32ToF16(v))).toBe(v)
    }
  })

  it('rounds to nearest even', () => {
    // 1 + 2^-11 is exactly halfway between 1.0 (0x3c00) and the next half (0x3c01);
    // nearest-even picks the even mantissa, which is 1.0.
    expect(f32ToF16(1 + 2 ** -11)).toBe(0x3c00)
    // 1 + 3*2^-11 is halfway between 0x3c01 and 0x3c02; even wins again.
    expect(f32ToF16(1 + 3 * 2 ** -11)).toBe(0x3c02)
  })

  it('quantisation error over the terrain ranges stays inside the documented budget', () => {
    const r = new Rng(55)
    let worstSlope = 0
    let worstAspect = 0
    for (let i = 0; i < 50_000; i++) {
      const slope = r.range(0, 3)
      const aspect = r.range(0, 2 * Math.PI)
      worstSlope = Math.max(worstSlope, Math.abs(quantiseF16(slope) - slope))
      worstAspect = Math.max(worstAspect, Math.abs(quantiseF16(aspect) - aspect))
    }
    // Documented in halfFloat.ts: ~1e-3 on slope at the top of the range, and half an ulp
    // of 3.9e-3 rad on aspect, i.e. 0.11 degrees.
    expect(worstSlope).toBeLessThan(1.1e-3)
    expect(worstAspect).toBeLessThan(2.0e-3)
  })

  it('never returns NaN or Inf for finite terrain-range inputs', () => {
    const r = new Rng(56)
    for (let i = 0; i < 20_000; i++) {
      const v = quantiseF16(r.range(-1000, 1000))
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})
