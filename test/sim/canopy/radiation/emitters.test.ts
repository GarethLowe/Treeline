/**
 * WP 3.3 emitter construction and the fixed-point clustering that mirrors `clusters.wgsl`.
 *
 * The overflow bounds here are the point of this file. `atomicAdd` in WGSL wraps rather than
 * saturating, so a scale chosen one order of magnitude too fine does not error on the device
 * — it relocates a cluster and invents energy. That failure is invisible in a screenshot and
 * cheap to catch here.
 *
 *   npx vitest run test/sim/canopy/radiation/emitters.test.ts
 */

import { describe, expect, it } from 'vitest'
import { K, kWm, m, rad } from '@contracts/units'
import { flameLength } from '@sim/rothermel/kernel.ts'
import { BIN_POWER_UNITS_LIMIT, DEFAULT_CLUSTER_OPTIONS, buildClusters, canopyVoxelEmitter, quantisePower, surfaceFlameEmitter } from '@sim/canopy/radiation/emitters.ts'
import { A2_MIN, EMIT_CELL_M, OVERFLOW_A2, OVERFLOW_POWER_SHIFT, POWER_FIXED_SCALE, RAD_EXTENT_X } from '@sim/canopy/radiation/layout.ts'
import { MAX_RADIANT_FRACTION, extinctionFromLad } from '@sim/canopy/radiation/optics.ts'
import type { EmitterSample, SurfaceFlameInput } from '@sim/canopy/radiation/emitters.ts'

const cell = (over: Partial<SurfaceFlameInput> = {}): SurfaceFlameInput => ({
  x: 100,
  z: 100,
  groundY: 0,
  intensity: kWm(875),
  cellM: m(0.5),
  flameDepth: m(1.5),
  tilt: rad(0),
  heading: rad(0),
  ...over,
})

describe('surface flame panels', () => {
  it('gives a radiant fraction inside the measured 0.15-0.35 band at §7.1\'s worked point', () => {
    // I = 875 kW/m -> L_f = 1.75 m (§7.1); D = 1.5 m -> eps_f = 0.70 at k_f = 0.8.
    expect(flameLength(kWm(875))).toBeCloseTo(1.75, 2)
    const e = surfaceFlameEmitter(cell())
    // Power per metre of front = P / cellM, against I_B in W/m.
    const radiantFraction = e.powerW / 0.5 / (875 * 1000)
    expect(radiantFraction).toBeGreaterThan(0.15)
    expect(radiantFraction).toBeLessThan(0.35)
  })

  it('does not clamp a plausible fire — the guard must not be an active limiter', () => {
    const e = surfaceFlameEmitter(cell({ flameDepth: m(50) }))
    expect(e.powerW).toBeLessThan(MAX_RADIANT_FRACTION * 875 * 1000 * 0.5)
  })

  it('clamps at MAX_RADIANT_FRACTION where the panel model would out-radiate the fire', () => {
    // Byram L_f grows as I^0.46 while the fire releases I, so a black 1 m deep flame sheet
    // over-radiates below ~320 kW/m. That is where the guard earns its place.
    const weak = surfaceFlameEmitter(cell({ intensity: kWm(100), flameDepth: m(50) }))
    expect(weak.powerW).toBeCloseTo(MAX_RADIANT_FRACTION * 100 * 1000 * 0.5, 6)
  })

  it('sits at the flame mid-height, and leans downwind as the flame tilts', () => {
    const upright = surfaceFlameEmitter(cell())
    expect(upright.x).toBeCloseTo(100, 9)
    expect(upright.y).toBeCloseTo(flameLength(kWm(875)) / 2, 6)

    // 60 degrees from vertical, leaning towards +x: displaced downwind and lower.
    const leaning = surfaceFlameEmitter(cell({ tilt: rad(Math.PI / 3) }))
    expect(leaning.x).toBeGreaterThan(upright.x)
    expect(leaning.y).toBeLessThan(upright.y)
    // The displacement magnitude is still half a flame length — the flame did not stretch.
    const d = Math.hypot(leaning.x - 100, leaning.y - 0, leaning.z - 100)
    expect(d).toBeCloseTo(flameLength(kWm(875)) / 2, 6)
  })

  it('leans along the heading, in the x-z ground plane', () => {
    const e = surfaceFlameEmitter(cell({ tilt: rad(Math.PI / 2), heading: rad(Math.PI / 2) }))
    expect(e.x).toBeCloseTo(100, 6)
    expect(e.z).toBeGreaterThan(100)
    expect(e.y).toBeCloseTo(0, 6)
  })

  it('emits nothing from an unburnt cell', () => {
    expect(surfaceFlameEmitter(cell({ intensity: kWm(0) })).powerW).toBe(0)
  })
})

describe('fixed-point scales', () => {
  it('round-trips power through the u32 quantisation to 200 W', () => {
    expect(quantisePower(1e6)).toBe(1e6 * POWER_FIXED_SCALE)
    expect(quantisePower(-5)).toBe(0)
    expect(quantisePower(99)).toBe(0)
    expect(quantisePower(101)).toBe(1)
  })

  it('leaves at least an order of magnitude over the reasoned worst-case bin', () => {
    // A 16 m bin holds 32x32 surface cells at an extreme 10 MW/m, plus 8^3 fully flaming
    // 2 m canopy voxels. See layout.ts.
    const surface = surfaceFlameEmitter(cell({ intensity: kWm(10000), flameDepth: m(3) }))
    const crown = canopyVoxelEmitter(0, 0, 0, extinctionFromLad(2), K(1200), m(2))
    const worstW = 32 * 32 * surface.powerW + 8 ** 3 * crown.powerW
    const worstUnits = worstW * POWER_FIXED_SCALE
    expect(worstUnits).toBeLessThan(BIN_POWER_UNITS_LIMIT / 4)
    // ...and the second-moment slot, r'^2 <= (8*sqrt(3))^2 = 192 m^2, is the tightest of the
    // five. `atomicAdd` wraps, so this margin is the whole defence.
    expect(worstUnits * 192).toBeLessThan(0xffffffff / 4)
  })
})

describe('clustering', () => {
  const opts = { ...DEFAULT_CLUSTER_OPTIONS }

  it('conserves power exactly through binning', () => {
    const samples: EmitterSample[] = []
    for (let n = 0; n < 500; n++) {
      samples.push({ x: 20 + n * 1.7, y: 3, z: 400 + (n % 7), powerW: 1e5 + n, radiusM: 0.4 })
    }
    const r = buildClusters(samples, opts)
    const summed = r.clusters.reduce((a, c) => a + c.powerW, 0)
    expect(summed).toBeCloseTo(r.totalPowerW, 3)
    expect(r.outOfBounds).toBe(0)
  })

  it('recovers the centroid of a bin to the fixed-point resolution', () => {
    // Two emitters in one bin, 3:1 in power: the centroid sits a quarter of the way over.
    const r = buildClusters(
      [
        { x: 8, y: 8, z: 8, powerW: 3e6, radiusM: 0 },
        { x: 12, y: 8, z: 8, powerW: 1e6, radiusM: 0 },
      ],
      opts,
    )
    expect(r.clusters).toHaveLength(1)
    expect(r.clusters[0]!.x).toBeCloseTo(9, 1)
    expect(r.clusters[0]!.powerW).toBeCloseTo(4e6, 3)
  })

  it('keeps an isolated emitter compact rather than smearing it to the bin size', () => {
    const lone = buildClusters([{ x: 8, y: 8, z: 8, powerW: 1e6, radiusM: 0 }], opts)
    expect(lone.clusters[0]!.a2).toBe(A2_MIN)

    const spread = buildClusters(
      [
        { x: 1, y: 8, z: 8, powerW: 1e6, radiusM: 0 },
        { x: 15, y: 8, z: 8, powerW: 1e6, radiusM: 0 },
      ],
      opts,
    )
    // Two emitters 14 m apart: variance = (7)^2 = 49 m^2.
    expect(spread.clusters[0]!.a2).toBeCloseTo(49, 0)
  })

  it('folds an emitter own extent into the softening radius', () => {
    const big = buildClusters([{ x: 8, y: 8, z: 8, powerW: 1e6, radiusM: 6 }], opts)
    expect(big.clusters[0]!.a2).toBeCloseTo(36, 0)
  })

  it('drops emitters outside the grid rather than aliasing them into it', () => {
    const r = buildClusters(
      [
        { x: -10, y: 8, z: 8, powerW: 1e6, radiusM: 0 },
        { x: RAD_EXTENT_X + 10, y: 8, z: 8, powerW: 1e6, radiusM: 0 },
        { x: 8, y: 8, z: 8, powerW: 1e6, radiusM: 0 },
      ],
      opts,
    )
    expect(r.outOfBounds).toBe(2)
    expect(r.clusters).toHaveLength(1)
  })
})

describe('overflow', () => {
  /** One emitter per bin along a long line: enough bins to blow a small cap. */
  function manyBins(n: number, power = 1e6): EmitterSample[] {
    const out: EmitterSample[] = []
    for (let i = 0; i < n; i++) {
      out.push({
        x: (i % 60) * EMIT_CELL_M + 8,
        y: 8,
        z: Math.floor(i / 60) * EMIT_CELL_M + 8,
        powerW: power,
        radiusM: 0,
      })
    }
    return out
  }

  it('never exceeds the cap', () => {
    const opts = { ...DEFAULT_CLUSTER_OPTIONS, cap: 16 }
    const r = buildClusters(manyBins(200), opts)
    expect(r.clusters.length).toBeLessThanOrEqual(16)
    expect(r.overflowBins).toBe(200 - 15)
  })

  it('keeps the surplus power rather than dropping it', () => {
    const opts = { ...DEFAULT_CLUSTER_OPTIONS, cap: 16 }
    const r = buildClusters(manyBins(200), opts)
    const summed = r.clusters.reduce((a, c) => a + c.powerW, 0)
    // The only loss is the catch-all's right shift: at most 2^OVERFLOW_POWER_SHIFT units per
    // overflow bin, and always downwards.
    const maxLoss = (r.overflowBins * 2 ** OVERFLOW_POWER_SHIFT) / POWER_FIXED_SCALE
    expect(summed).toBeLessThanOrEqual(r.totalPowerW)
    expect(summed).toBeGreaterThanOrEqual(r.totalPowerW - maxLoss)
  })

  it('smears the catch-all over the domain so it cannot pose as a nearby hot source', () => {
    const opts = { ...DEFAULT_CLUSTER_OPTIONS, cap: 16 }
    const r = buildClusters(manyBins(200), opts)
    const last = r.clusters[r.clusters.length - 1]!
    expect(last.a2).toBe(OVERFLOW_A2)
    expect(Math.sqrt(OVERFLOW_A2)).toBeGreaterThan(400)
  })

  it('raises the threshold after an overflow and lowers it when there is room', () => {
    const opts = { ...DEFAULT_CLUSTER_OPTIONS, cap: 16, minBinUnits: 4 }
    expect(buildClusters(manyBins(200), opts).nextMinBinUnits).toBe(8)
    expect(buildClusters(manyBins(4), opts).nextMinBinUnits).toBe(2)
  })

  it('converges to keeping the strongest bins once the controller has settled', () => {
    // 200 bins, one of them ten times brighter. After a few steps of feedback the threshold
    // must be high enough that the bright bin survives as its own cluster.
    const samples = manyBins(200)
    samples[137] = { ...samples[137]!, powerW: 1e7 }
    let minBinUnits = 1
    for (let step = 0; step < 12; step++) {
      minBinUnits = buildClusters(samples, {
        ...DEFAULT_CLUSTER_OPTIONS,
        cap: 16,
        minBinUnits,
      }).nextMinBinUnits
    }
    const settled = buildClusters(samples, {
      ...DEFAULT_CLUSTER_OPTIONS,
      cap: 16,
      minBinUnits,
    })
    expect(settled.clusters.some((c) => c.powerW >= 1e7 * 0.99)).toBe(true)
  })
})
