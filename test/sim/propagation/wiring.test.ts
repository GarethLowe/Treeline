/**
 * The bits of the GPU path that can be checked without a GPU: ignition geometry, the WP 2.2
 * cache stub's packing, and — the one that actually earns its keep — a drift guard asserting
 * the WGSL constants still match the TypeScript they were transliterated from.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { m, mps, rad, s } from '@contracts/units'
import { LB_MAX, ellipseFromRates, lengthToBreadth } from '@sim/propagation/ellipse'
import { LevelSetField, signedDistanceTo } from '@sim/propagation/levelset'
import { BAND_M, TILE_CELLS } from '@sim/propagation/activeSet'
import { packRosCache, toHalf } from '@sim/propagation/stub'

const shader = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../shaders/sim/propagation/${name}`, import.meta.url)), 'utf8')

describe('ignition shapes', () => {
  it('stamps an exact signed distance for point, line and ring', () => {
    const point = { kind: 'point', x: m(10), z: m(10), radius: m(2) } as const
    expect(signedDistanceTo(point, 10, 10)).toBe(-2)
    expect(signedDistanceTo(point, 12, 10)).toBeCloseTo(0, 12)
    expect(signedDistanceTo(point, 15, 10)).toBeCloseTo(3, 12)

    const line = { kind: 'line', x0: m(0), z0: m(5), x1: m(10), z1: m(5), width: m(2) } as const
    expect(signedDistanceTo(line, 5, 5)).toBeCloseTo(-1, 12)
    expect(signedDistanceTo(line, 5, 7)).toBeCloseTo(1, 12)
    // Beyond the end cap the distance is to the endpoint, so the shape has round ends.
    expect(signedDistanceTo(line, 13, 5)).toBeCloseTo(2, 12)

    const ring = { kind: 'ring', x: m(0), z: m(0), radius: m(10), width: m(2) } as const
    expect(signedDistanceTo(ring, 10, 0)).toBeCloseTo(-1, 12)
    expect(signedDistanceTo(ring, 0, 0)).toBeCloseTo(9, 12) // the unburnt middle
    expect(signedDistanceTo(ring, 12, 0)).toBeCloseTo(1, 12)
  })

  it('merges overlapping ignitions with no topology work', () => {
    const f = new LevelSetField(64, 0.5)
    f.ignite({ kind: 'point', x: m(10), z: m(16), radius: m(3) })
    const one = f.burntAreaM2()
    f.ignite({ kind: 'point', x: m(14), z: m(16), radius: m(3) })
    const two = f.burntAreaM2()
    expect(one).toBeGreaterThan(0)
    expect(two).toBeGreaterThan(one)
    // Two overlapping discs of radius 3 with centres 4 apart cover less than two full discs.
    expect(two).toBeLessThan(2 * one)
  })

  it('a ring burns inward and outward and closes its own middle', () => {
    const f = new LevelSetField(192, 0.5)
    const c = 48
    f.ignite({ kind: 'ring', x: m(c), z: m(c), radius: m(12), width: m(1) })
    const before = f.burntAreaM2()
    const e = ellipseFromRates(0.4, 1, 1, 0)
    for (let i = 0; i < 200; i++) f.step(s(0.4), e)
    // 200 x 0.4 s x 0.4 m/s = 32 m of spread, so the 12 m hole is long since closed.
    const k = Math.floor(c / 0.5) * 192 + Math.floor(c / 0.5)
    expect(f.burnt(k)).toBe(true)
    expect(f.burntAreaM2()).toBeGreaterThan(before * 5)
  })
})

describe('WP 2.2 cache stub', () => {
  it('round-trips through binary16 within half-float precision', () => {
    const fromHalf = (h: number): number => {
      const sign = h & 0x8000 ? -1 : 1
      const exp = (h >> 10) & 0x1f
      const mant = h & 0x3ff
      if (exp === 0) return sign * mant * 2 ** -24
      if (exp === 31) return sign * Infinity
      return sign * (1 + mant / 1024) * 2 ** (exp - 15)
    }
    for (const v of [0, 1, 0.5, -0.5, 3.25, 0.0123, 8, -1]) {
      expect(fromHalf(toHalf(v))).toBeCloseTo(v, 2)
    }
  })

  it('packs (R_head, LB, headingX, headingY) in that order', () => {
    const wind = mps(2)
    const packed = packRosCache(16, wind, rad(Math.PI / 2))
    const lbBits = packed[1] as number
    expect(lbBits).toBe(toHalf(lengthToBreadth(wind)))
    // Heading due east: (sin a, -cos a) = (1, -0). The y component packs to negative zero,
    // which is exactly zero for every use it has.
    expect(packed[2]).toBe(toHalf(1))
    expect((packed[3] as number) & 0x7fff).toBe(0)
    expect(packed.length).toBe(4 * 16 * 16)
  })

  it('zeroes the head rate where the fuel cannot carry fire', () => {
    const packed = packRosCache(16, mps(2), rad(0), { burnable: (i) => i > 7 })
    expect(packed[0]).toBe(toHalf(0))
    expect(packed[4 * 8]).not.toBe(toHalf(0))
  })
})

describe('WGSL / TypeScript parity', () => {
  const ellipseWgsl = shader('ellipse.wgsl')
  const propagationWgsl = shader('propagation.wgsl')

  it('carries the Anderson (1983) constants, not the spec §4.6 ones', () => {
    expect(ellipseWgsl).toContain('0.936 * exp(0.1147 * u) + 0.461 * exp(-0.0692 * u) - 0.397')
    // The spec's exponents may be named in a comment, but must not be evaluated.
    expect(ellipseWgsl).not.toContain('exp(0.2566')
    expect(ellipseWgsl).not.toContain('exp(-0.1548')
    expect(ellipseWgsl).toContain(`const LB_MAX: f32 = ${LB_MAX}.0;`)
    expect(ellipseWgsl).toContain('const MPS_TO_MIH: f32 = 2.2369362920544025;')
    expect(2.2369362920544025).toBeCloseTo(3600 / 1609.344, 12)
  })

  it('uses the same tile size as the CPU active set', () => {
    expect(propagationWgsl).toContain(`const TILE: u32 = ${TILE_CELLS}u;`)
    expect(BAND_M).toBe(2)
  })

  it('keeps every indirect dispatch clamped', () => {
    // Spec §6.4 / WebGPU §16.1.2: an out-of-range indirect dispatch is silently skipped.
    expect(propagationWgsl).toContain('maxWorkgroupsPerDim')
    expect(propagationWgsl).toContain('overflow = 1u')
    const indirectEntries = ['advance', 'jfaSeed', 'jfaFlood', 'jfaResolve']
    for (const e of indirectEntries) {
      expect(propagationWgsl).toContain(`fn ${e}(`)
    }
    // Every indirect kernel bounds-checks its slot against the compacted count — but in one
    // of two forms, and the distinction is load-bearing rather than stylistic.
    //
    // The early-return form is illegal in any kernel containing a `workgroupBarrier`: WGSL's
    // uniformity analysis cannot prove the branch uniform through an `atomicLoad`, so the
    // barrier is rejected and the whole module fails to compile. `advance` has two barriers
    // and therefore uses the non-returning form, guarding its writes with `inRange` so every
    // invocation still reaches both barriers.
    //
    // Count both spellings. What must hold is that each indirect kernel bounds-checks, not
    // that it does so by returning.
    const returningGuards =
      propagationWgsl.match(/if \(slot >= atomicLoad\(&control\.tileCount\)\)/g)?.length ?? 0
    const inRangeGuards =
      propagationWgsl.match(/let inRange = slot < atomicLoad\(&control\.tileCount\)/g)?.length ?? 0
    expect(returningGuards + inRangeGuards).toBe(indirectEntries.length)

    // And a kernel using the non-returning form must actually apply it: an `inRange` that is
    // computed and never tested would compile, run, and write out of bounds.
    if (inRangeGuards > 0) expect(propagationWgsl).toMatch(/if \(inRange\)|&& inRange|inRange &&/)
  })

  it('ships both the subgroup path and a fallback, and only one enables the feature', () => {
    const sub = shader('classify_subgroup.wgsl')
    const wg = shader('classify_workgroup.wgsl')
    expect(sub).toContain('subgroupBallot')
    expect(sub).toContain('subgroupExclusiveAdd')
    for (const builtin of ['subgroupBallot', 'subgroupElect', 'subgroupExclusiveAdd', 'subgroupBroadcastFirst']) {
      expect(wg).not.toContain(builtin)
    }
    // The enable directive is emitted by shaders.ts, never inside a fragment.
    expect(sub).not.toContain('enable subgroups;')
    expect(propagationWgsl).not.toContain('enable ')
  })
})
