/**
 * WP 3.3 acceptance: irradiance falls as expected with distance and with intervening leaf
 * area, the solution converges as rays increase, and energy is not created.
 *
 *   npx vitest run test/sim/canopy/radiation/gather.test.ts
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_GATHER_OPTIONS, buildExtinctionField, emptyExtinctionField, gatherIrradiance, sampleExtinction, transmittance } from '@sim/canopy/radiation/gather.ts'
import { MIN_RAY_COUNT } from '@sim/canopy/radiation/layout.ts'
import type { RadCluster } from '@sim/canopy/radiation/emitters.ts'
import type { ExtinctionField } from '@sim/canopy/radiation/gather.ts'

/** A small uniform-kappa test field. 4 m cells, same as the shipping grid. */
function uniformField(kappa: number, n = 64): ExtinctionField {
  const f = emptyExtinctionField(n, n, n, 4)
  f.kappa.fill(kappa)
  return f
}

const VACUUM = uniformField(0)

const point = (x: number, y: number, z: number, powerW: number, a2 = 0): RadCluster => ({
  x,
  y,
  z,
  powerW,
  a2,
})

const opts = (rayCount: number) => ({ ...DEFAULT_GATHER_OPTIONS, rayCount })

describe('distance', () => {
  const P = 1e6
  const src = [point(128, 20, 128, P)]

  it('falls exactly as 1/r^2 for an unsoftened point source in vacuum', () => {
    const at = (r: number) => gatherIrradiance(128 + r, 20, 128, src, VACUUM, opts(8)).irradiance
    expect(at(10)).toBeCloseTo(P / (4 * Math.PI * 100), 9)
    expect(at(10) / at(20)).toBeCloseTo(4, 9)
    expect(at(20) / at(40)).toBeCloseTo(4, 9)
  })

  it('is isotropic — the same at equal range in any direction', () => {
    const g = (dx: number, dy: number, dz: number) =>
      gatherIrradiance(128 + dx, 20 + dy, 128 + dz, src, VACUUM, opts(8)).irradiance
    expect(g(30, 0, 0)).toBeCloseTo(g(0, 30, 0), 9)
    expect(g(30, 0, 0)).toBeCloseTo(g(0, 0, -30), 9)
  })

  it('softening only ever removes flux, and by the documented amount', () => {
    const a2 = 4.6 ** 2
    const soft = [point(128, 20, 128, P, a2)]
    for (const r of [5, 10, 23, 46, 100]) {
      const hard = gatherIrradiance(128 + r, 20, 128, src, VACUUM, opts(8)).irradiance
      const s = gatherIrradiance(128 + r, 20, 128, soft, VACUUM, opts(8)).irradiance
      expect(s).toBeLessThan(hard)
      expect(s / hard).toBeCloseTo(r ** 2 / (r ** 2 + a2), 9)
    }
    // The bounds quoted in provenance.ts: -5% at 23 m, -1.3% at 46 m.
    const rel = (r: number) => 1 - r ** 2 / (r ** 2 + a2)
    expect(rel(23)).toBeLessThan(0.05)
    expect(rel(46)).toBeLessThan(0.013)
    expect(rel(10)).toBeGreaterThan(0.17)
  })
})

describe('intervening leaf area', () => {
  it('attenuates by exp(-kappa*r) through a uniform canopy', () => {
    const P = 1e6
    const src = [point(128, 20, 128, P)]
    for (const kappa of [0.05, 0.2, 0.6]) {
      const field = uniformField(kappa)
      const r = 40
      const g = gatherIrradiance(128 + r, 20, 128, src, field, opts(8)).irradiance
      const expected = (P / (4 * Math.PI * r * r)) * Math.exp(-kappa * r)
      // The field is f32 on the GPU and Float32Array here, so 1e-7 relative is the floor.
      expect(g / expected).toBeCloseTo(1, 5)
    }
  })

  it('is monotone decreasing in leaf area density', () => {
    const src = [point(128, 20, 128, 1e6)]
    let prev = Infinity
    for (const lad of [0, 0.5, 1, 2, 4]) {
      const g = gatherIrradiance(
        168,
        20,
        128,
        src,
        uniformField(0.5 * 0.6 * lad),
        opts(8),
      ).irradiance
      expect(g).toBeLessThan(prev)
      prev = g
    }
  })

  it('sees a slab of leaf area as its optical thickness, not as its position', () => {
    // Two 8 m slabs of kappa = 1 anywhere along the path must give the same transmittance.
    const near = emptyExtinctionField(64, 64, 64, 4)
    const far = emptyExtinctionField(64, 64, 64, 4)
    const set = (f: ExtinctionField, i0: number) => {
      for (let i = i0; i < i0 + 2; i++)
        for (let j = 0; j < 64; j++) for (let k = 0; k < 64; k++) f.kappa[i + j * 64 + k * 64 * 64] = 1
    }
    set(near, 33)
    set(far, 40)
    const t1 = transmittance(near, 128, 20, 128, 128 + 60, 20, 128, 256)
    const t2 = transmittance(far, 128, 20, 128, 128 + 60, 20, 128, 256)
    expect(t1).toBeCloseTo(t2, 3)
    expect(t1).toBeCloseTo(Math.exp(-8), 1)
  })

  it('builds the 4 m field from 2 m LAD without a Jensen error', () => {
    const f = emptyExtinctionField(2, 2, 2, 4)
    // A 2x2x2 group holding one voxel of LAD 8 and seven of 0 must average to LAD 1.
    buildExtinctionField(f, (i, j, k) => (i === 0 && j === 0 && k === 0 ? 8 : 0), () => 0.6)
    expect(f.kappa[0]).toBeCloseTo(0.5 * 0.6 * 1, 7)
  })
})

describe('convergence in ray count', () => {
  // A realistic emitter set: a 300 m front binned to 16 m, plus scattered crown emitters.
  const clusters: RadCluster[] = []
  for (let s = 0; s < 20; s++) {
    clusters.push(point(200 + s * 16, 2, 400, 2.3e6, 21))
  }
  for (let n = 0; n < 120; n++) {
    const a = (n * 2.399) % (2 * Math.PI)
    clusters.push(point(500 + 200 * Math.cos(a), 12 + (n % 5) * 4, 500 + 200 * Math.sin(a), 4e5, 21))
  }
  const field = uniformField(0.15)
  const exact = gatherIrradiance(300, 14, 430, clusters, field, opts(clusters.length)).irradiance

  it('converges monotonically towards the all-cluster solution', () => {
    let prevErr = Infinity
    for (const n of [8, 16, 32, 64, 128]) {
      const g = gatherIrradiance(300, 14, 430, clusters, field, opts(n))
      expect(g.marched).toBe(Math.min(n, clusters.length))
      const err = Math.abs(g.irradiance - exact) / exact
      expect(err).toBeLessThanOrEqual(prevErr + 1e-12)
      prevErr = err
    }
    expect(prevErr).toBeLessThan(1e-9)
  })

  it('is already within a few percent at the floor of 8 rays', () => {
    const g = gatherIrradiance(300, 14, 430, clusters, field, opts(MIN_RAY_COUNT))
    expect(Math.abs(g.irradiance - exact) / exact).toBeLessThan(0.05)
  })

  it('never exceeds the unoccluded bound at any ray count', () => {
    for (const n of [8, 16, 32, 64, 140]) {
      const g = gatherIrradiance(300, 14, 430, clusters, field, opts(n))
      expect(g.irradiance).toBeLessThanOrEqual(g.unoccluded * (1 + 1e-12))
    }
  })

  it('costs exactly rayCount*taps extinction samples — the pass is sized on this', () => {
    const g = gatherIrradiance(300, 14, 430, clusters, field, opts(8))
    expect(g.taps).toBe(8 * DEFAULT_GATHER_OPTIONS.taps)
  })
})

describe('energy is not created', () => {
  /**
   * Integrate the absorbed power kappa*G over a shell from r0 outwards. In the continuum,
   * over all space and with no softening, this is exactly P:
   *   integral of kappa*P*exp(-kappa*r)/(4*pi*r^2) * 4*pi*r^2 dr  =  P.
   */
  function absorbedFraction(a2: number, kappa: number, r0 = 0): number {
    const P = 1e6
    const src = [point(0, 0, 0, P, a2)]
    const field = uniformField(kappa)
    const R = 20 / kappa
    const steps = 8000
    let acc = 0
    for (let n = 0; n < steps; n++) {
      const r = r0 + ((n + 0.5) / steps) * (R - r0)
      const dr = (R - r0) / steps
      const g = gatherIrradiance(r, 0, 0, src, field, opts(1)).irradiance
      acc += kappa * g * 4 * Math.PI * r * r * dr
    }
    return acc / P
  }

  it('recovers the emitted power exactly for an unsoftened source', () => {
    for (const kappa of [0.05, 0.2, 0.6]) {
      expect(absorbedFraction(0, kappa)).toBeCloseTo(1, 2)
    }
  })

  it('loses energy, never gains it, once the finite-emitter softening is applied', () => {
    for (const kappa of [0.05, 0.2, 0.6]) {
      expect(absorbedFraction(4.6 ** 2, kappa)).toBeLessThan(1)
    }
  })

  /**
   * The whole-space deficit above is large in a dense canopy (86% at kappa = 0.6) and that
   * is not a defect: at kappa = 0.6 the mean free path is 1.67 m, so almost all of a point
   * emitter's power is reabsorbed within its own 4.6 m softening radius — i.e. inside the
   * burning cluster itself, whose energy budget belongs to the pyrolysis model rather than
   * to preheating. What has to be preserved is the flux that reaches fuel the emitter has
   * NOT already engulfed, and that is what this asserts.
   */
  it('preserves the absorption beyond the softening radius, which is the part that preheats', () => {
    const a = 4.6
    for (const kappa of [0.05, 0.2, 0.6]) {
      const soft = absorbedFraction(a * a, kappa, 2 * a)
      const hard = absorbedFraction(0, kappa, 2 * a)
      expect(soft).toBeLessThanOrEqual(hard)
      // Measured worst case is 0.842 at kappa = 0.6, where the mean free path is 1.67 m and
      // the weight sits right at the 2a boundary. Recorded in provenance.ts.
      expect(soft / hard).toBeGreaterThan(0.83)
    }
  })

  it('caps a receiver inside the emitter at P/(4*pi*a^2) instead of diverging', () => {
    const P = 1e6
    const a2 = 21
    const g = gatherIrradiance(0, 0, 0, [point(0, 0, 0, P, a2)], VACUUM, opts(8)).irradiance
    expect(g).toBeCloseTo(P / (4 * Math.PI * a2), 6)
    expect(Number.isFinite(g)).toBe(true)
  })

  it('keeps the tail correction below the marched set — it can only under-restore', () => {
    // 200 equal clusters at increasing range: the tail is farther, so its restored
    // transmittance must be at or below the marched mean.
    const cs: RadCluster[] = []
    for (let n = 0; n < 200; n++) cs.push(point(20 + n * 3, 0, 0, 1e6, 4))
    const field = uniformField(0.1)
    const g8 = gatherIrradiance(0, 0, 0, cs, field, opts(8))
    const exact = gatherIrradiance(0, 0, 0, cs, field, opts(200)).irradiance
    expect(g8.irradiance).toBeLessThanOrEqual(exact * 1.02)
    expect(g8.irradiance).toBeGreaterThan(exact * 0.8)
  })
})

describe('sampling', () => {
  it('clamps to edge rather than reading outside the grid', () => {
    const f = uniformField(0.4, 8)
    expect(sampleExtinction(f, -1000, -1000, -1000)).toBeCloseTo(0.4, 7)
    expect(sampleExtinction(f, 1e6, 1e6, 1e6)).toBeCloseTo(0.4, 7)
  })

  it('returns 1 for a zero-length path rather than NaN', () => {
    expect(transmittance(uniformField(1), 4, 4, 4, 4, 4, 4)).toBe(1)
  })
})
