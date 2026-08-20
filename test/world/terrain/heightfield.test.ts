/**
 * The query layer, tested against surfaces whose height, slope, aspect and normal are known
 * in closed form. Procedural terrain cannot tell you whether your aspect convention is
 * ninety degrees out; a plane sloping due east can.
 *
 * The compass convention under test (src/world/terrain/conventions.ts):
 *   +x = East, +z = South, north = -z, aspect = DOWNSLOPE azimuth clockwise from north.
 */

import { describe, expect, it } from 'vitest'
import { Heightfield } from '@world/terrain/heightfield.ts'
import { azimuthOf, directionOf } from '@world/terrain/conventions.ts'
import {
  drainagePathCheck,
  flowAccumulation,
  priorityFloodFill,
} from '@world/terrain/hydrology.ts'
import { Rng } from '@world/terrain/rng.ts'

/** Field of `h = c + a*x + b*z` on an `n`-node grid over `domainM`. */
function planeField(n: number, domainM: number, a: number, b: number, c: number): Heightfield {
  const f = new Heightfield(n, domainM)
  for (let j = 0; j < n; j++) {
    const z = f.nodeZ(j)
    for (let i = 0; i < n; i++) f.height[j * n + i] = c + a * f.nodeX(i) + b * z
  }
  f.recomputeGradients()
  return f
}

describe('conventions', () => {
  it('azimuthOf and directionOf are inverses on the compass', () => {
    for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const a = (deg * Math.PI) / 180
      const [vx, vz] = directionOf(a)
      expect(azimuthOf(vx, vz)).toBeCloseTo(a, 12)
    }
  })

  it('places north at -z and east at +x', () => {
    expect(directionOf(0)[0]).toBeCloseTo(0, 12)
    expect(directionOf(0)[1]).toBeCloseTo(-1, 12) // north = -z
    expect(directionOf(Math.PI / 2)[0]).toBeCloseTo(1, 12) // east = +x
    expect(directionOf(Math.PI / 2)[1]).toBeCloseTo(0, 12)
  })
})

describe('Heightfield on an analytic plane', () => {
  const n = 64
  const domain = 128
  const a = 0.3
  const b = -0.2
  const c = 500

  it('reproduces the plane exactly at arbitrary interior positions', () => {
    const f = planeField(n, domain, a, b, c)
    const r = new Rng(1)
    for (let k = 0; k < 500; k++) {
      // Stay a cell inside the outer half-cell margin, where clamping applies.
      const x = r.range(f.cellM, domain - f.cellM)
      const z = r.range(f.cellM, domain - f.cellM)
      expect(f.heightAt(x, z)).toBeCloseTo(c + a * x + b * z, 3)
    }
  })

  it('derives exact gradients, slope, aspect and normal in the interior', () => {
    const f = planeField(n, domain, a, b, c)
    const g = { x: 0, z: 0 }
    f.gradientAt(30, 40, g)
    expect(g.x).toBeCloseTo(a, 5)
    expect(g.z).toBeCloseTo(b, 5)
    expect(f.slopeAt(30, 40)).toBeCloseTo(Math.hypot(a, b), 5)
    // 4 places, not more: node gradients live in a Float32Array, so an angle derived from
    // them carries ~1e-5 rad of storage rounding. That is 6e-4 of a degree.
    expect(f.aspectAt(30, 40)).toBeCloseTo(azimuthOf(-a, -b), 4)

    const nrm = f.normalAt(30, 40)
    expect(Math.hypot(nrm[0], nrm[1], nrm[2])).toBeCloseTo(1, 9)
    // The normal must be perpendicular to both in-surface tangents.
    expect(nrm[0] * 1 + nrm[1] * a + nrm[2] * 0).toBeCloseTo(0, 5)
    expect(nrm[0] * 0 + nrm[1] * b + nrm[2] * 1).toBeCloseTo(0, 5)
    expect(nrm[1]).toBeGreaterThan(0) // y-up
  })

  it.each([
    // dh/dx, dh/dz, expected downslope azimuth (degrees)
    ['downhill to the north', 0, 0.5, 0],
    ['downhill to the east', -0.5, 0, 90],
    ['downhill to the south', 0, -0.5, 180],
    ['downhill to the west', 0.5, 0, 270],
    ['downhill to the north-east', -0.5, 0.5, 45],
  ] as const)('aspect: %s', (_label, gx, gz, expectedDeg) => {
    const f = planeField(n, domain, gx, gz, c)
    const got = (f.aspectAt(64, 64) * 180) / Math.PI
    expect(got).toBeCloseTo(expectedDeg, 4)
  })

  it('clamps outside the domain instead of extrapolating or returning NaN', () => {
    const f = planeField(n, domain, a, b, c)
    const edge = f.heightAt(f.cellM * 0.5, f.cellM * 0.5) // exact corner node
    expect(f.heightAt(-1000, -1000)).toBeCloseTo(edge, 6)
    expect(Number.isFinite(f.heightAt(1e9, -1e9))).toBe(true)
    expect(Number.isFinite(f.heightAt(NaN, NaN))).toBe(true)
  })
})

describe('Heightfield bilinear query', () => {
  it('is exact for a bilinear surface', () => {
    // h = x*z / 100 is bilinear on every cell, so the piecewise-bilinear interpolant is the
    // function itself. Any error here is an indexing or weighting bug, not interpolation.
    const n = 64
    const domain = 64
    const f = new Heightfield(n, domain)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) f.height[j * n + i] = (f.nodeX(i) * f.nodeZ(j)) / 100
    }
    f.recomputeGradients()
    const r = new Rng(2)
    for (let k = 0; k < 300; k++) {
      const x = r.range(1, domain - 1)
      const z = r.range(1, domain - 1)
      expect(f.heightAt(x, z)).toBeCloseTo((x * z) / 100, 3)
    }
  })

  it('returns node values exactly at node centres', () => {
    const f = planeField(32, 64, 0.11, -0.07, 20)
    for (const [i, j] of [
      [0, 0],
      [5, 9],
      [31, 31],
      [17, 3],
    ] as const) {
      expect(f.heightAt(f.nodeX(i), f.nodeZ(j))).toBeCloseTo(f.height[j * 32 + i] as number, 6)
    }
  })
})

describe('hydrology', () => {
  /** A cone: strictly descending away from the centre, so it has no interior pit. */
  function cone(n: number): Heightfield {
    const f = new Heightfield(n, n)
    const c = (n - 1) / 2
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        f.height[j * n + i] = 100 - Math.hypot(i - c, j - c)
      }
    }
    f.recomputeGradients()
    return f
  }

  it('finds no basins on a cone, and one in a bowl', () => {
    const c = cone(33)
    expect(c.findClosedBasins()).toHaveLength(0)
    expect(c.hasNoClosedBasins()).toBe(true)

    const bowl = cone(33)
    for (let k = 0; k < bowl.height.length; k++) {
      bowl.height[k] = -(bowl.height[k] as number)
    }
    expect(bowl.findClosedBasins().length).toBeGreaterThan(0)
  })

  it('priority-flood removes every closed basin and leaves a strict descent', () => {
    // Random noise is dense with pits: a hard case, not a friendly one.
    const n = 96
    const f = new Heightfield(n, n)
    const r = new Rng(31)
    for (let k = 0; k < n * n; k++) f.height[k] = 800 + r.range(0, 40)

    expect(f.findClosedBasins().length).toBeGreaterThan(10)
    const filled = priorityFloodFill(f)
    expect(f.findClosedBasins()).toHaveLength(0)
    expect(filled.filledCells).toBeGreaterThan(0)
    expect(filled.order).toHaveLength(n * n)

    // The pop order must be a permutation of every node, ascending in filled elevation.
    expect(new Set(Array.from(filled.order)).size).toBe(n * n)
    for (let k = 1; k < filled.order.length; k++) {
      const prev = f.height[filled.order[k - 1] as number] as number
      const cur = f.height[filled.order[k] as number] as number
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-6)
    }
  })

  it('never lowers the terrain', () => {
    const n = 64
    const f = new Heightfield(n, n)
    const r = new Rng(32)
    for (let k = 0; k < n * n; k++) f.height[k] = 500 + r.range(0, 20)
    const before = Float32Array.from(f.height)
    priorityFloodFill(f)
    for (let k = 0; k < n * n; k++) {
      expect(f.height[k] as number).toBeGreaterThanOrEqual(before[k] as number)
    }
  })

  it('routes every interior node downhill to the domain edge', () => {
    const n = 96
    const f = new Heightfield(n, n)
    const r = new Rng(33)
    for (let k = 0; k < n * n; k++) f.height[k] = 700 + r.range(0, 30)
    const filled = priorityFloodFill(f)
    const recv = f.computeReceivers()

    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i
        const rcv = recv[c] as number
        // An interior node with no receiver would be a pit masquerading as an outlet.
        expect(rcv).toBeGreaterThanOrEqual(0)
        expect(f.height[rcv] as number).toBeLessThan(f.height[c] as number)
      }
    }

    const paths = drainagePathCheck(f, recv)
    expect(paths.unresolved).toBe(0)
    expect(paths.maxPathSteps).toBeGreaterThan(0)
    expect(paths.maxPathSteps).toBeLessThan(n * n)

    const acc = flowAccumulation(f, filled.order, recv)
    const cellArea = f.cellM * f.cellM
    let total = 0
    for (let k = 0; k < acc.length; k++) {
      expect(acc[k] as number).toBeGreaterThanOrEqual(cellArea - 1e-6)
      total = Math.max(total, acc[k] as number)
    }
    // No node can drain more than the whole domain, and the trunk must drain a lot of it.
    expect(total).toBeLessThanOrEqual(n * n * cellArea + 1e-6)
    expect(total).toBeGreaterThan(20 * cellArea)
  })
})
