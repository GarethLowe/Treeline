/**
 * WP 3.6 buffer layout and dispatch bookkeeping.
 *
 * These are the bugs that do not show up as wrong physics — they show up as brands that stop
 * moving, or as a shape nibble that silently reads back as a different drag coefficient. M1 lost
 * four bugs to device-only code paths; every one of these assertions runs on the CLI.
 */

import { describe, expect, it } from 'vitest'
import {
  BRAND_CLASSES,
  SHAPES,
  arealDensity,
  beta0For,
} from '@sim/firebrands/brands.ts'
import {
  BRAND_POOL,
  BRAND_STRIDE_BYTES,
  CLASS_STRIDE_F32,
  EMITTERS_PER_THREAD,
  FLAG_ALIVE,
  FLAG_FLAMING,
  FLAG_LANDED,
  INTEGRATE_WORKGROUP,
  MAX_EMITTERS,
  SPAWN_WORKGROUP,
  clampIndirectWorkgroups,
  integrateWorkgroups,
  isAliveBits,
  packBrandBits,
  packBrandClasses,
  populationControl,
  ringIndex,
  unpackBrandBits,
} from '@sim/firebrands/layout.ts'

describe('packed nibbles', () => {
  it('round-trips every field including the top bit of the seed', () => {
    const cases = [
      { shape: 'plate' as const, fuel: 0, biome: 0, flags: 0, rngSeed: 0 },
      { shape: 'cylinder' as const, fuel: 15, biome: 15, flags: 15, rngSeed: 0xffff },
      { shape: 'ribbon' as const, fuel: 6, biome: 3, flags: FLAG_ALIVE | FLAG_FLAMING, rngSeed: 0x8001 },
    ]
    for (const c of cases) expect(unpackBrandBits(packBrandBits(c))).toEqual(c)
  })

  it('never produces a negative u32', () => {
    // JS bitwise ops are signed; a seed with the top bit set is where that bites.
    const p = packBrandBits({
      shape: 'ribbon',
      fuel: 15,
      biome: 15,
      flags: 15,
      rngSeed: 0xffff,
    })
    expect(p).toBeGreaterThan(0)
    expect(p >>> 0).toBe(p)
    // shape nibble is 2 (ribbon); everything above it is set.
    expect(p).toBe(0xffff_fff2)
  })

  it('reads the alive flag the same way the shader does', () => {
    const alive = packBrandBits({ shape: 'plate', fuel: 0, biome: 0, flags: FLAG_ALIVE, rngSeed: 1 })
    const dead = packBrandBits({ shape: 'plate', fuel: 0, biome: 0, flags: FLAG_LANDED, rngSeed: 1 })
    expect(isAliveBits(alive)).toBe(true)
    expect(isAliveBits(dead)).toBe(false)
  })
})

describe('class table packing', () => {
  const classes = Object.values(BRAND_CLASSES)
  const packed = packBrandClasses(classes)

  it('lays out one record per class at the declared stride', () => {
    expect(packed.length).toBe(classes.length * CLASS_STRIDE_F32)
  })

  // Float32Array rounds, so every value check here is relative at f32 precision.
  const near = (got: number | undefined, want: number): void =>
    expect(Math.abs((got ?? Number.NaN) / want - 1)).toBeLessThan(1e-6)

  it('precomputes sigma WITH the shape branch, which is the whole point', () => {
    classes.forEach((c, i) => {
      const b = i * CLASS_STRIDE_F32
      near(packed[b + 0], c.halfThk)
      near(packed[b + 1], arealDensity(c.shape, c.halfThk))
      expect(packed[b + 2]).toBeCloseTo(SHAPES[c.shape].cd, 6)
      near(packed[b + 3], beta0For(c))
      expect(packed[b + 7]).toBe(SHAPES[c.shape].code)
    })
  })

  it('converts the mass truncation to projected AREA, which is what the -2 exponent applies to', () => {
    const i = classes.findIndex((c) => c.id === 'conifer-cylinder')
    const c = BRAND_CLASSES['conifer-cylinder']
    const sigma = arealDensity(c.shape, c.halfThk)
    near(packed[i * CLASS_STRIDE_F32 + 4], c.massMin / sigma)
    near(packed[i * CLASS_STRIDE_F32 + 5], c.massMax / sigma)
    expect(packed[i * CLASS_STRIDE_F32 + 4]).toBeLessThan(packed[i * CLASS_STRIDE_F32 + 5] as number)
  })

  it('rejects a table that would overflow the 4-bit class nibble', () => {
    expect(() => packBrandClasses([])).toThrow()
    expect(() => packBrandClasses(new Array(17).fill(BRAND_CLASSES['grass-plate']))).toThrow()
  })
})

describe('ring allocation and population control (§4.2)', () => {
  it('wraps without collision inside one step', () => {
    expect(ringIndex(BRAND_POOL - 2, 0, 0)).toBe(BRAND_POOL - 2)
    expect(ringIndex(BRAND_POOL - 2, 1, 1)).toBe(0)
    expect(ringIndex(BRAND_POOL - 2, 3, 0)).toBe(1)
    const seen = new Set<number>()
    for (let k = 0; k < 5000; k++) seen.add(ringIndex(BRAND_POOL - 100, 0, k))
    expect(seen.size).toBe(5000)
  })

  it('doubles weight and halves count until demand fits', () => {
    expect(populationControl(1000, BRAND_POOL)).toEqual({ weight: 1, spawn: 1000 })
    const over = populationControl(BRAND_POOL * 8, BRAND_POOL)
    expect(over.weight).toBe(8)
    expect(over.spawn).toBeLessThanOrEqual(BRAND_POOL)
    // Represented brand count is preserved to within the halving granularity — the whole point
    // of super-particles is that cost stays flat while statistical resolution degrades.
    expect(over.weight * over.spawn).toBeCloseTo(BRAND_POOL * 8, -3)
  })

  it('degrades gracefully rather than dividing by zero at capacity 0', () => {
    const none = populationControl(1000, 0)
    expect(none.spawn).toBe(0)
    expect(Number.isFinite(none.weight)).toBe(true)
  })
})

describe('indirect dispatch clamping', () => {
  const LIMIT = 65535

  it('clamps, because WebGPU silently skips an over-large indirect dispatch', () => {
    expect(clampIndirectWorkgroups(10, LIMIT)).toBe(10)
    expect(clampIndirectWorkgroups(LIMIT, LIMIT)).toBe(LIMIT)
    expect(clampIndirectWorkgroups(LIMIT + 1, LIMIT)).toBe(LIMIT)
    expect(clampIndirectWorkgroups(1e12, LIMIT)).toBe(LIMIT)
  })

  it('is total over garbage input', () => {
    expect(clampIndirectWorkgroups(0, LIMIT)).toBe(0)
    expect(clampIndirectWorkgroups(-5, LIMIT)).toBe(0)
    expect(clampIndirectWorkgroups(Number.NaN, LIMIT)).toBe(0)
    // Infinity and NaN both fall to 0: skipping a step beats dispatching 65535 workgroups over
    // a corrupt count, and a stalled brand system is easier to notice than a hung GPU.
    expect(clampIndirectWorkgroups(Number.POSITIVE_INFINITY, LIMIT)).toBe(0)
    expect(clampIndirectWorkgroups(10, 0)).toBe(1)
  })

  it('covers exactly the used prefix of the pool and never more', () => {
    expect(integrateWorkgroups(0, LIMIT)).toBe(0)
    expect(integrateWorkgroups(1, LIMIT)).toBe(1)
    expect(integrateWorkgroups(INTEGRATE_WORKGROUP, LIMIT)).toBe(1)
    expect(integrateWorkgroups(INTEGRATE_WORKGROUP + 1, LIMIT)).toBe(2)
    expect(integrateWorkgroups(BRAND_POOL, LIMIT)).toBe(BRAND_POOL / INTEGRATE_WORKGROUP)
    // A corrupt high-water mark must not dispatch past the buffer.
    expect(integrateWorkgroups(BRAND_POOL * 100, LIMIT)).toBe(BRAND_POOL / INTEGRATE_WORKGROUP)
    // The whole pool is 512 workgroups, three orders under any real device limit — so the clamp
    // can only ever fire on corrupt state, which is exactly when it matters.
    expect(BRAND_POOL / INTEGRATE_WORKGROUP).toBeLessThan(LIMIT)
  })
})

describe('sizes agree with the shader', () => {
  it('holds the struct stride and the one-workgroup spawn budget', () => {
    expect(BRAND_STRIDE_BYTES).toBe(64)
    expect(BRAND_STRIDE_BYTES % 16).toBe(0)
    expect(BRAND_POOL).toBe(2 ** 17)
    expect(SPAWN_WORKGROUP * EMITTERS_PER_THREAD).toBe(MAX_EMITTERS)
    // 8.4 MB of brand pool. Against an 8 GB budget this is not a number worth optimising.
    expect((BRAND_POOL * BRAND_STRIDE_BYTES) / 1e6).toBeLessThan(9)
  })
})
