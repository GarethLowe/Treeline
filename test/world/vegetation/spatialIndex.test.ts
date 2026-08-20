/**
 * Spatial index tests. Every query is checked against brute force on the same data, because
 * the only failure mode that matters here is a silently-dropped stem: a renderer with a
 * slightly wrong cull list looks fine, and the M3 canopy voxeliser built on the same query
 * would then be missing fuel that the fire model thinks is there.
 */

import { describe, expect, it } from 'vitest'
import type { Stem } from '@contracts/world'
import { m, rad, kgm3, moistureFraction } from '@contracts/units'
import { PointGrid, StemGrid } from '../../../src/world/vegetation/spatialIndex.ts'
import { makeRng } from '../../../src/world/vegetation/rng.ts'

function makeStems(n: number, sizeM: number, seed: number): Stem[] {
  const rng = makeRng(seed)
  const out: Stem[] = []
  for (let i = 0; i < n; i++) {
    const x = rng() * sizeM
    const z = rng() * sizeM
    out.push({
      speciesId: 'test',
      x: m(x),
      z: m(z),
      groundY: m(0),
      heightM: m(1 + rng() * 20),
      dbhM: m(0.1),
      crownBaseM: m(0.5),
      crownRadiusM: m(1),
      crownBulkDensity: kgm3(0.2),
      foliarMoisture: moistureFraction(1),
      age: rng(),
      seed: i,
      rotationY: rad(0),
      hasLadderFuels: false,
    })
  }
  return out
}

describe('StemGrid.queryAabb', () => {
  const sizeM = 400
  const stems = makeStems(3000, sizeM, 12345)
  const grid = new StemGrid(stems, sizeM, 16)

  it('matches brute force on random boxes, exactly', () => {
    const rng = makeRng(777)
    for (let t = 0; t < 60; t++) {
      const x0 = rng() * sizeM
      const z0 = rng() * sizeM
      const x1 = x0 + rng() * 120
      const z1 = z0 + rng() * 120
      const got = new Set(grid.queryAabb(x0, z0, x1, z1).map((s) => s.seed))
      const want = new Set(
        stems.filter((s) => s.x >= x0 && s.x <= x1 && s.z >= z0 && s.z <= z1).map((s) => s.seed),
      )
      expect(got).toEqual(want)
    }
  })

  it('returns every stem exactly once for a whole-domain query', () => {
    const all = grid.queryAabb(0, 0, sizeM, sizeM)
    expect(all.length).toBe(stems.length)
    expect(new Set(all.map((s) => s.seed)).size).toBe(stems.length)
  })

  it('returns nothing for an inverted or off-domain box', () => {
    expect(grid.queryAabb(200, 200, 100, 100)).toHaveLength(0)
    expect(grid.queryAabb(-500, -500, -400, -400)).toHaveLength(0)
  })

  it('is insensitive to cell size', () => {
    for (const cell of [4, 16, 64, 512]) {
      const g = new StemGrid(stems, sizeM, cell)
      expect(g.queryAabb(50, 50, 150, 150).length).toBe(
        stems.filter((s) => s.x >= 50 && s.x <= 150 && s.z >= 50 && s.z <= 150).length,
      )
    }
  })
})

describe('StemGrid.queryRadiusIndices', () => {
  const sizeM = 300
  const stems = makeStems(1500, sizeM, 999)
  const grid = new StemGrid(stems, sizeM, 12)

  it('matches brute force', () => {
    const rng = makeRng(31337)
    for (let t = 0; t < 40; t++) {
      const x = rng() * sizeM
      const z = rng() * sizeM
      const r = 3 + rng() * 30
      const got = new Set(grid.queryRadiusIndices(x, z, r))
      const want = new Set(
        stems
          .map((s, i) => [s, i] as const)
          .filter(([s]) => (s.x - x) ** 2 + (s.z - z) ** 2 <= r * r)
          .map(([, i]) => i),
      )
      expect(got).toEqual(want)
    }
  })

  it('includes the query point’s own stem', () => {
    const s0 = stems[0] as Stem
    expect(grid.queryRadiusIndices(s0.x, s0.z, 0.001)).toContain(0)
  })
})

describe('PointGrid', () => {
  it('rejects candidates closer than the exclusion radius', () => {
    const g = new PointGrid(100, 5)
    g.insert(50, 50, 5)
    expect(g.conflicts(52, 50, 5)).toBe(true)
    expect(g.conflicts(56, 50, 5)).toBe(false)
  })

  it('is symmetric: the larger of the two radii wins', () => {
    const g = new PointGrid(100, 10)
    g.insert(50, 50, 10) // a sparse-stand point with a large exclusion
    // A dense-stand candidate with a small radius must still be pushed away by its neighbour.
    expect(g.conflicts(54, 50, 1)).toBe(true)
    expect(g.conflicts(61, 50, 1)).toBe(false)
  })

  it('finds conflicts across cell boundaries', () => {
    const g = new PointGrid(100, 4)
    // Deliberately straddle a 4 m cell boundary at x = 40.
    g.insert(39.9, 20, 4)
    expect(g.conflicts(40.1, 20, 4)).toBe(true)
  })

  it('produces a pattern with the requested minimum separation', () => {
    const g = new PointGrid(200, 6)
    const rng = makeRng(2024)
    const pts: [number, number][] = []
    for (let i = 0; i < 20_000; i++) {
      const x = rng() * 200
      const z = rng() * 200
      if (g.conflicts(x, z, 6)) continue
      g.insert(x, z, 6)
      pts.push([x, z])
    }
    expect(pts.length).toBeGreaterThan(200)
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i] as [number, number]
        const b = pts[j] as [number, number]
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(6 - 1e-9)
      }
    }
  })
})
