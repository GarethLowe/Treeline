/**
 * The acceptance criteria for work package 1.2, minus the GPU half (see agreement.test.ts):
 *
 *   - deterministic for a seed, byte-identical;
 *   - slope statistics respond monotonically to `relief`;
 *   - the drainage network is connected and flows downhill, with no closed basins;
 *   - `ridgeBearing` actually orients the ridges.
 *
 * Runs on a 256-node grid with a proportionally reduced droplet budget so the whole file
 * finishes in a few seconds. The generator is resolution-independent by construction — the
 * noise is band-limited to the node spacing and the erosion works in cell units — so these
 * are statements about the algorithm, not about one grid size. The 1024-node shipping
 * configuration is exercised once, at the end, to pin the wall-clock budget.
 */

import { describe, expect, it } from 'vitest'
import { degToRad, m } from '@contracts/units'
import type { TerrainParams } from '@contracts/world'
import { DEFAULT_TERRAIN_PARAMS, generateTerrain } from '@world/terrain/generate.ts'
import { reliefSpanM } from '@world/terrain/synthesis.ts'
import { directionOf } from '@world/terrain/conventions.ts'
import { generateTerrainQueries } from '@world/terrain/field.ts'

const GRID = 256
const DROPS = 12_000
const SEED = 20250818

function params(over: Partial<TerrainParams> = {}): TerrainParams {
  return { ...DEFAULT_TERRAIN_PARAMS, baseElevationM: m(900), ...over }
}

function run(over: Partial<TerrainParams> = {}, seed = SEED) {
  return generateTerrain(params(over), seed, { gridN: GRID, droplets: DROPS })
}

const bytesOf = (v: ArrayBufferView): Uint8Array =>
  new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)

describe('determinism', () => {
  it('is byte-identical across two runs of the same seed', () => {
    const a = run()
    const b = run()
    expect(bytesOf(a.field.height)).toEqual(bytesOf(b.field.height))
    expect(bytesOf(a.field.gradX)).toEqual(bytesOf(b.field.gradX))
    expect(bytesOf(a.field.gradZ)).toEqual(bytesOf(b.field.gradZ))
    expect(bytesOf(a.texels.height)).toEqual(bytesOf(b.texels.height))
    expect(bytesOf(a.texels.slopeAspect)).toEqual(bytesOf(b.texels.slopeAspect))
    expect(a.stats).toEqual(b.stats)
  })

  it('changes with the seed', () => {
    const a = run({}, 1)
    const b = run({}, 2)
    expect(bytesOf(a.field.height)).not.toEqual(bytesOf(b.field.height))
    // ...but stays the same *kind* of terrain: the seed must not move the relief control.
    expect(a.stats.medianSlopeTan).toBeCloseTo(b.stats.medianSlopeTan, 1)
  })

  it('is unaffected by evaluation order — queries do not mutate hidden state', () => {
    const q = generateTerrainQueries(params(), SEED, { gridN: GRID, droplets: DROPS })
    const probe = (): number[] => [
      q.heightAt(m(101.7), m(613.2)),
      q.slopeAt(m(101.7), m(613.2)),
      q.aspectAt(m(101.7), m(613.2)),
    ]
    const first = probe()
    for (let i = 0; i < 100; i++) q.heightAt(m(i * 7.3), m(i * 3.1))
    expect(probe()).toEqual(first)
  })
})

describe('relief control', () => {
  const reliefs = [0, 0.25, 0.5, 0.75, 1]

  it('reliefSpanM is strictly increasing and starts near flat', () => {
    for (let i = 1; i < reliefs.length; i++) {
      expect(reliefSpanM(reliefs[i] as number)).toBeGreaterThan(reliefSpanM(reliefs[i - 1] as number))
    }
    expect(reliefSpanM(0)).toBeLessThan(10)
    expect(reliefSpanM(1)).toBeGreaterThan(150)
    // Clamped, not extrapolated.
    expect(reliefSpanM(-5)).toBe(reliefSpanM(0))
    expect(reliefSpanM(5)).toBe(reliefSpanM(1))
  })

  it('mean, median and p90 slope all increase monotonically with relief', () => {
    const stats = reliefs.map((relief) => run({ relief }).stats)
    for (let i = 1; i < stats.length; i++) {
      const prev = stats[i - 1]!
      const cur = stats[i]!
      expect(cur.meanSlopeTan).toBeGreaterThan(prev.meanSlopeTan)
      expect(cur.medianSlopeTan).toBeGreaterThan(prev.medianSlopeTan)
      expect(cur.p90SlopeTan).toBeGreaterThan(prev.p90SlopeTan)
    }
    // Endpoints have to mean something, not merely be ordered.
    expect(stats[0]!.medianSlopeTan).toBeLessThan(0.03) // under 2 degrees: a flat control case
    expect(stats[4]!.medianSlopeTan).toBeGreaterThan(0.35) // over 19 degrees: mountainous
  })

  it('holds the requested mean elevation regardless of relief', () => {
    for (const relief of [0, 0.5, 1]) {
      const g = run({ relief, baseElevationM: m(1200) })
      // Erosion moves material and incision removes some, so the mean drifts a little from
      // the value normalisation set. A few metres out of 1200 is the whole of that drift.
      expect(g.stats.meanM).toBeGreaterThan(1180)
      expect(g.stats.meanM).toBeLessThan(1215)
      expect(g.stats.minM).toBeLessThan(g.stats.maxM)
    }
  })

  it('reports min and max elevation on the contract object', () => {
    const q = generateTerrainQueries(params(), SEED, { gridN: GRID, droplets: DROPS })
    expect(q.minElevationM).toBeLessThan(q.maxElevationM)
    for (const [x, z] of [
      [0, 0],
      [512, 512],
      [1023, 1023],
      [1024, 1024],
    ] as const) {
      const h = q.heightAt(m(x), m(z))
      expect(h).toBeGreaterThanOrEqual(q.minElevationM - 1e-3)
      expect(h).toBeLessThanOrEqual(q.maxElevationM + 1e-3)
    }
  })
})

describe('drainage', () => {
  it('leaves no closed basins at any relief or drainage strength', () => {
    for (const relief of [0, 0.5, 1]) {
      for (const drainageStrength of [0, 0.5, 1]) {
        const g = run({ relief, drainageStrength })
        expect(g.diagnostics.closedBasins).toBe(0)
        expect(g.diagnostics.unresolvedPaths).toBe(0)
      }
    }
  })

  it('routes every interior node strictly downhill to the domain edge', () => {
    const g = run({ relief: 0.7 })
    const f = g.field
    const n = f.n
    const recv = f.computeReceivers()
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i
        const r = recv[c] as number
        expect(r).toBeGreaterThanOrEqual(0)
        expect(f.height[r] as number).toBeLessThan(f.height[c] as number)
      }
    }
    expect(g.diagnostics.maxPathSteps).toBeGreaterThan(n / 4)
    expect(g.diagnostics.maxPathSteps).toBeLessThan(n * n)
  })

  it('produces a connected channel network covering a meaningful fraction of the domain', () => {
    const g = run({ relief: 0.7, drainageStrength: 1 })
    // Channels are nodes above the contributing-area threshold. Too few and there is no
    // network; ~all of them and the threshold is meaningless.
    expect(g.diagnostics.channelFraction).toBeGreaterThan(0.03)
    expect(g.diagnostics.channelFraction).toBeLessThan(0.5)

    // Every channel node must reach the edge purely by descending. Walking the receiver
    // chain and requiring a strict height decrease at every step is the operational form of
    // "connected and flows downhill".
    const f = g.field
    const recv = f.computeReceivers()
    const acc = g.flowAccumM2
    const cellArea = f.cellM * f.cellM
    const threshold = 24 * cellArea
    let walked = 0
    for (let c = 0; c < acc.length; c++) {
      if ((acc[c] as number) <= threshold) continue
      // Boundary nodes ARE the outlets — they leave the domain in zero steps by definition.
      const i = c % f.n
      const j = (c - i) / f.n
      if (i === 0 || j === 0 || i === f.n - 1 || j === f.n - 1) continue
      walked++
      if (walked % 37 !== 0) continue // every 37th channel node keeps the test quick
      let cur = c
      let steps = 0
      while (true) {
        const next = recv[cur] as number
        if (next < 0) break
        expect(f.height[next] as number).toBeLessThan(f.height[cur] as number)
        cur = next
        steps++
        expect(steps).toBeLessThan(f.n * f.n)
      }
      expect(steps).toBeGreaterThan(0)
    }
    expect(walked).toBeGreaterThan(100)
  })

  it('cuts deeper channels as drainageStrength rises', () => {
    const weak = run({ relief: 0.7, drainageStrength: 0.1 })
    const strong = run({ relief: 0.7, drainageStrength: 1 })
    expect(strong.diagnostics.deepestIncisionM).toBeGreaterThan(
      weak.diagnostics.deepestIncisionM * 2,
    )
    // Erosion has to have moved material, not merely been called.
    expect(strong.diagnostics.erosion.erodedCellUnits).toBeGreaterThan(0)
    expect(strong.diagnostics.erosion.depositedCellUnits).toBeGreaterThan(0)
    expect(strong.diagnostics.erosion.meanLifetime).toBeGreaterThan(5)
  })

  it('keeps the field free of single-node spikes', () => {
    // A droplet scheme with unbounded sediment capacity dumps its whole load the moment the
    // ground flattens, building a tower tens of metres tall in one cell. That reads as a
    // slope tangent in the hundreds and would put a vertical wall in the middle of the
    // spread grid, so the ceiling on capacity is worth an explicit regression test.
    for (const relief of [0.5, 1]) {
      const g = run({ relief })
      expect(g.stats.maxSlopeTan).toBeLessThan(12)
      expect(g.stats.maxM - g.stats.minM).toBeLessThan(4 * reliefSpanM(relief) + 40)
    }
  })
})

describe('ridgeBearing', () => {
  it.each([0, 45, 90, 135])('orients ridges along %i degrees', (deg) => {
    const g = run({ relief: 0.7, ridgeBearing: degToRad(deg) })
    const [ax, az] = directionOf(degToRad(deg))
    const px = -az
    const pz = ax
    let along = 0
    let across = 0
    const f = g.field
    for (let k = 0; k < f.gradX.length; k++) {
      const gx = f.gradX[k] as number
      const gz = f.gradZ[k] as number
      along += Math.abs(gx * ax + gz * az)
      across += Math.abs(gx * px + gz * pz)
    }
    // Terrain varies less ALONG a ridge line than across it. The synthesis compresses the
    // sample frame by 0.42 along the bearing, so the design target is ~2.4x; anything above
    // 1.5 is unambiguous anisotropy in the requested direction.
    expect(across / along).toBeGreaterThan(1.5)
  })
})

describe('shipping configuration', () => {
  it('generates the 1024-node domain within the load-time budget', () => {
    const g = generateTerrain(params({ relief: 0.8 }), SEED)
    expect(g.gridN).toBe(1024)
    expect(g.field.cellM).toBe(1)
    expect(g.diagnostics.closedBasins).toBe(0)
    expect(g.diagnostics.unresolvedPaths).toBe(0)
    expect(g.texels.height).toHaveLength(1024 * 1024)
    expect(g.texels.slopeAspect).toHaveLength(1024 * 1024 * 2)

    // Generous ceiling — this is a smoke alarm for an accidental O(n^2) regression, not a
    // benchmark. The measured figure on the target CPU is ~4.1 s; see generate.ts.
    console.info('[terrain 1024^2] timings ms:', g.timingsMs)
    expect(g.timingsMs.total).toBeLessThan(30_000)
  }, 60_000)
})
