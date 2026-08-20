/**
 * The headline correctness requirement of work package 2.3: the emergent perimeter must be
 * the ellipse that fire-shape theory predicts, with no grid artifact.
 */

import { describe, expect, it } from 'vitest'
import { m, mps, s } from '@contracts/units'
import { ellipseFromRates, isotropicEllipse, lengthToBreadth } from '@sim/propagation/ellipse'
import { LevelSetField } from '@sim/propagation/levelset'
import { CFL, cflTimestep } from '@sim/propagation/timestep'
import {
  bilinear,
  cellularAutomatonArrival,
  crossingDistance,
  momentFit,
  radiusProfile,
} from './fit'

const CELL = 0.5

function run(n: number, rate: number, lb: number, bearing: number, seconds: number, r0 = 1) {
  const field = new LevelSetField(n, CELL)
  const cx = (n * CELL) / 2
  const cy = (n * CELL) / 2
  field.ignite({ kind: 'point', x: m(cx), z: m(cy), radius: m(r0) })
  const e = ellipseFromRates(rate, lb, Math.cos(bearing), Math.sin(bearing))
  const dt = cflTimestep(mps(e.head), CELL)
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) field.step(dt, e)
  return { field, e, cx, cy, elapsed: steps * dt, dt, steps }
}

describe('isotropy — no shape artifact in still air', () => {
  it('grows a circle, worst-case radius deviation under 2% over all bearings', () => {
    const n = 192
    const field = new LevelSetField(n, CELL)
    const c = (n * CELL) / 2
    field.ignite({ kind: 'point', x: m(c), z: m(c), radius: m(1) })
    const e = isotropicEllipse(0.5)
    const dt = cflTimestep(mps(e.head), CELL)
    const steps = Math.round(60 / dt)
    for (let i = 0; i < steps; i++) field.step(dt, e)

    const expected = 1 + 0.5 * steps * dt
    const p = radiusProfile(bilinear(field.phi, n, CELL), c, c, 0, 44, 128)

    expect(p.mean).toBeCloseTo(expected, 0)
    expect(Math.abs(p.mean - expected) / expected).toBeLessThan(0.02)
    // Spec §4.6 target. ENO2 + LLF + TVD-RK2 should land near 1%.
    expect(p.maxDeviation).toBeLessThan(0.01)
  })

  it("the spec's axis-vs-diagonal statistic is blind to the 8-neighbour CA octagon", () => {
    // This is why the test above sweeps every bearing. An 8-connected shortest-path metric
    // is EXACT on the axes and EXACT on the diagonals, and 7.6% short at 22.5deg.
    const n = 192
    const c = (n * CELL) / 2
    const rate = 0.5
    const t = 60
    const arrival = cellularAutomatonArrival(n, CELL, c, c, rate)
    const p = radiusProfile(bilinear(arrival, n, CELL), c, c, t, 44, 128)

    expect(p.axisDiagonal).toBeLessThan(0.01) // the spec's statistic says "fine"
    expect(p.maxDeviation).toBeGreaterThan(0.05) // the all-bearing statistic says "octagon"
    // ...and the deficit lands at 22.5deg, exactly between the two sampled families.
    const worst = p.radii.indexOf(Math.min(...p.radii))
    const worstDeg = ((worst * 360) / p.radii.length) % 45
    expect(Math.min(worstDeg, 45 - worstDeg)).toBeGreaterThan(15)
  })
})

describe('elliptical decomposition — the emergent perimeter is the analytic ellipse', () => {
  // Ignition at the REAR FOCUS, so from the ignition point the front reaches
  //   r0 + (b + c)t forward, r0 + (b - c)t backward,
  // and r0 + a t perpendicular *through the ellipse centre*, which sits c*t downwind.
  // Those three extents are exact for the Minkowski sum of the ignition disc with the
  // velocity ellipse, so they can be asserted without any fitting.
  it('matches head, backing and flank rates', () => {
    const n = 256
    const lb = 2
    const { field, e, cx, cy, elapsed } = run(n, 0.25, lb, 0, 200, 0.5)
    const sample = bilinear(field.phi, n, CELL)
    const r0 = 0.5
    const px = -e.hy
    const py = e.hx

    const head = crossingDistance(sample, cx, cy, e.hx, e.hy, 0, 60)
    const back = crossingDistance(sample, cx, cy, -e.hx, -e.hy, 0, 60)
    const midX = cx + e.c * elapsed * e.hx
    const midY = cy + e.c * elapsed * e.hy
    const flank = crossingDistance(sample, midX, midY, px, py, 0, 60)
    const flank2 = crossingDistance(sample, midX, midY, -px, -py, 0, 60)

    expect(rel(head, r0 + e.head * elapsed)).toBeLessThan(0.015)
    expect(rel(flank, r0 + e.a * elapsed)).toBeLessThan(0.02)
    expect(rel(flank2, r0 + e.a * elapsed)).toBeLessThan(0.02)
    // The backing rate is R_head/HB, a fourteenth of the head rate here, so it is the
    // hardest quantity in the model to resolve on a 0.5 m grid: 3.6 m of travel over ~7
    // cells. It lands within 2% only because the Lax-Friedrichs coefficients are bounded
    // locally; with the ellipse-wide bound this assertion fails at 16%.
    expect(rel(back, r0 + e.backing * elapsed)).toBeLessThan(0.04)

    // Length-to-breadth read straight off the perimeter, against the geometric prediction
    // for the Minkowski sum (which is slightly below LB because the ignition disc is round).
    const measuredLb = (head + back) / (flank + flank2)
    const geometricLb = (e.b * elapsed + r0) / (e.a * elapsed + r0)
    expect(rel(measuredLb, geometricLb)).toBeLessThan(0.03)
    expect(measuredLb).toBeGreaterThan(0.9 * lb)
    expect(measuredLb).toBeLessThan(1.05 * lb)
  })

  it('fits an ellipse whose eccentricity matches LB', () => {
    const n = 256
    const lb = 3
    const { field, e, elapsed } = run(n, 0.25, lb, 0.7, 180, 0.5)
    const fit = momentFit(field)
    const geometricLb = (e.b * elapsed + 0.5) / (e.a * elapsed + 0.5)

    expect(rel(fit.lengthToBreadth, geometricLb)).toBeLessThan(0.06)
    // Eccentricity is what the assignment asks for; it is a monotone function of LB.
    const ecc = (x: number) => Math.sqrt(Math.max(0, 1 - 1 / (x * x)))
    expect(Math.abs(ecc(fit.lengthToBreadth) - ecc(geometricLb))).toBeLessThan(0.02)
    // The major axis lines up with the heading (mod pi).
    const dAngle = Math.abs(((fit.majorAngle - 0.7 + Math.PI / 2) % Math.PI) - Math.PI / 2)
    expect(dAngle).toBeLessThan(0.03)
  })
})

describe('rotating wind sweep — an axis-aligned test cannot see grid anisotropy', () => {
  const BEARINGS = 16
  const lb = lengthToBreadth(mps(1.6))

  it('produces the same fire at every wind bearing', () => {
    const n = 192
    const heads: number[] = []
    const flanks: number[] = []
    const areas: number[] = []
    const lbs: number[] = []

    for (let k = 0; k < BEARINGS; k++) {
      const bearing = (k * 2 * Math.PI) / BEARINGS
      const { field, e, cx, cy, elapsed } = run(n, 0.4, lb, bearing, 50, 1)
      const sample = bilinear(field.phi, n, CELL)
      const midX = cx + e.c * elapsed * e.hx
      const midY = cy + e.c * elapsed * e.hy
      const head = crossingDistance(sample, cx, cy, e.hx, e.hy, 0, 44)
      const flank = crossingDistance(sample, midX, midY, -e.hy, e.hx, 0, 44)

      expect(rel(head, 1 + e.head * elapsed)).toBeLessThan(0.03)
      expect(rel(flank, 1 + e.a * elapsed)).toBeLessThan(0.06)

      heads.push(head)
      flanks.push(flank)
      areas.push(field.burntAreaM2())
      lbs.push(momentFit(field).lengthToBreadth)
    }

    // The real anisotropy detector: the SAME fire, rotated, must have the same size.
    // A 4- or 8-neighbour rule fails this even though it can pass an axis-aligned check.
    expect(cv(heads)).toBeLessThan(0.02)
    expect(cv(flanks)).toBeLessThan(0.02)
    expect(cv(areas)).toBeLessThan(0.02)
    expect(cv(lbs)).toBeLessThan(0.02)
  })
})

describe('CFL', () => {
  it('the spec §4.8 rule is inside the 2D split-LLF stability limit at every bearing', () => {
    // Stability needs dt*(ax + ay)/dx <= 1. The spec picks dt = 0.4*dx/R_head; this asserts
    // the margin that choice actually leaves.
    for (const lb of [1, 2, 4, 8]) {
      for (let k = 0; k < 32; k++) {
        const bearing = (k * 2 * Math.PI) / 32
        const e = ellipseFromRates(1.5, lb, Math.cos(bearing), Math.sin(bearing))
        const dt = cflTimestep(mps(e.head), CELL)
        const ax = Math.abs(e.c * e.hx) + Math.hypot(e.b * e.hx, e.a * e.hy)
        const ay = Math.abs(e.c * e.hy) + Math.hypot(e.b * e.hy, e.a * e.hx)
        expect((dt * (ax + ay)) / CELL).toBeLessThanOrEqual(2 * CFL + 1e-12)
        expect((dt * (ax + ay)) / CELL).toBeLessThan(1)
      }
    }
  })

  it('a violated CFL visibly wrecks the front, so the guard is load-bearing', () => {
    const n = 128
    const c = (n * CELL) / 2
    const stable = new LevelSetField(n, CELL)
    const wild = new LevelSetField(n, CELL)
    const e = isotropicEllipse(0.5)
    for (const f of [stable, wild]) f.ignite({ kind: 'point', x: m(c), z: m(c), radius: m(2) })
    const dt = cflTimestep(mps(e.head), CELL)
    for (let i = 0; i < 40; i++) stable.step(dt, e)
    for (let i = 0; i < 10; i++) wild.step(s(dt * 4), e)

    const good = radiusProfile(bilinear(stable.phi, n, CELL), c, c, 0, 28, 64)
    expect(good.maxDeviation).toBeLessThan(0.02)
    const bad = radiusProfile(bilinear(wild.phi, n, CELL), c, c, 0, 28, 64)
    expect(bad.maxDeviation).toBeGreaterThan(good.maxDeviation * 3)
  })
})

const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want)

function cv(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  return Math.sqrt(varr) / Math.abs(mean)
}
