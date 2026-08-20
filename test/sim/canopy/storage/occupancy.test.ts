/**
 * The measurement that closes spec §30 §7.2's OPEN QUESTION.
 *
 * This generates four full 1 km worlds and voxelises each, so it is the slow test in the
 * package (~25 s). It is a test rather than a script because the conclusions it prints are
 * load-bearing: if a change to M1's vegetation or terrain moves the occupancy enough to make
 * a brick pool competitive again, or to push a pool past a binding limit, the build should
 * say so rather than leaving a stale table in a comment.
 */

import { describe, expect, it } from 'vitest'
import type { BiomeId } from '@contracts/world'
import { generateTerrainQueries } from '@world/terrain/field.ts'
import { defaultWorldConfig, generateVegetation } from '@world/vegetation/index.ts'
import { CANOPY_GRID, buildLayout, footprint } from '@sim/canopy/storage/layout.ts'
import { BRICK_8_CUBED, formatReport, measureOccupancy } from '@sim/canopy/storage/occupancy.ts'
import { sampleGround, voxeliseOccupancy } from '@sim/canopy/storage/voxelise.ts'
import type { OccupancyReport } from '@sim/canopy/storage/occupancy.ts'

/** The pool capacity §7.2 proposed, in 8³ bricks. */
const SPEC_BRICK_POOL = 8192

interface Case {
  readonly label: string
  readonly biome: BiomeId
  readonly relief?: number
}

const CASES: readonly Case[] = [
  { label: 'dense conifer', biome: 'western-us-conifer' },
  { label: 'open savanna', biome: 'grassland-savanna' },
  { label: 'steep relief', biome: 'western-us-conifer', relief: 1 },
  { label: 'closed chaparral', biome: 'mediterranean-chaparral' },
]

interface Measured {
  readonly report: OccupancyReport
  readonly terrainSpanM: number
  readonly tallestStemM: number
  readonly layoutVoxels: number
  readonly totalMiB: number
}

function measure(c: Case): Measured {
  const base = defaultWorldConfig(1234, c.biome)
  const cfg =
    c.relief === undefined ? base : { ...base, terrain: { ...base.terrain, relief: c.relief } }
  const terrain = generateTerrainQueries(cfg.terrain, cfg.seed)
  const veg = generateVegetation(cfg, terrain)
  const ground = sampleGround(terrain, CANOPY_GRID)
  const occ = voxeliseOccupancy(veg, ground, CANOPY_GRID)
  const layout = buildLayout(occ.mask)
  let tallest = 0
  for (const s of veg.stems) if (s.heightM > tallest) tallest = s.heightM
  return {
    report: measureOccupancy(`${c.label} (${c.biome}, relief ${cfg.terrain.relief})`, occ.mask, layout),
    terrainSpanM: terrain.maxElevationM - terrain.minElevationM,
    tallestStemM: tallest,
    layoutVoxels: layout.voxelCount,
    totalMiB: footprint(layout).totalMiB,
  }
}

describe('canopy occupancy on the shipping worlds', () => {
  const measured = new Map<string, Measured>()
  for (const c of CASES) {
    it(`measures ${c.label}`, () => {
      const r = measure(c)
      measured.set(c.label, r)
      console.log(
        `${formatReport(r.report)}\nterrain span ${r.terrainSpanM.toFixed(0)} m,` +
          ` tallest stem ${r.tallestStemM.toFixed(0)} m,` +
          ` world-aligned extent would need ${(r.terrainSpanM + r.tallestStemM).toFixed(0)} m` +
          ` (grid is ${CANOPY_GRID.nz * CANOPY_GRID.cellM} m)\nstore ${r.totalMiB.toFixed(1)} MiB`,
      )
    }, 180_000)
  }

  it('the spec 8192-brick pool OVERFLOWS on dense conifer', () => {
    const r = measured.get('dense conifer')
    expect(r, 'dense conifer case must run first').toBeDefined()
    const brick = r!.report.bricks.find((b) => b.shape === BRICK_8_CUBED)!
    expect(brick.slotsTouched).toBeGreaterThan(SPEC_BRICK_POOL)
    // Recorded so a regression is visible: measured 10 117 at seed 1234.
    expect(brick.slotsTouched).toBeGreaterThan(9_500)
    expect(brick.slotsTouched).toBeLessThan(11_000)
  })

  it('brick allocation amplifies occupancy by ~4x; column runs by ~1x', () => {
    for (const [label, r] of measured) {
      const brick = r.report.bricks.find((b) => b.shape === BRICK_8_CUBED)!
      expect(brick.amplification, label).toBeGreaterThan(4)
      expect(brick.meanFillPerTouchedBrick, label).toBeLessThan(0.25)
      expect(r.report.columnRun.amplification, label).toBeLessThan(1.05)
    }
  })

  it('sparsity is vertical, not horizontal — which is why the brickmap loses', () => {
    const conifer = measured.get('dense conifer')!
    // Most 2 m columns of a stocked domain carry canopy, so XY has little to sparsify.
    expect(conifer.report.columnRun.occupiedColumnFraction).toBeGreaterThan(0.7)
    // ...and the band inside them is a handful of voxels of a 64-level axis.
    expect(conifer.report.columnRun.meanRunLength).toBeLessThan(10)
    expect(conifer.report.maxOccupiedLevel).toBeLessThan(CANOPY_GRID.nz)
  })

  it('voxel occupancy is below the 10-18% the spec assumed', () => {
    for (const [label, r] of measured) {
      expect(r.report.voxelOccupancy, label).toBeLessThan(0.1)
    }
  })

  it('the store fits well inside the 7.2 budget and every binding limit', () => {
    for (const [label, r] of measured) {
      expect(r.totalMiB, label).toBeLessThan(50) // §7.2 provisional: 117.6 MB for A+B+C
      const f = footprint({
        grid: CANOPY_GRID,
        columnHeader: new Uint32Array(0),
        columnOffset: new Uint32Array(0),
        voxelCount: r.layoutVoxels,
        occupiedColumns: 0,
        interiorGapVoxels: 0,
        spareVoxels: 0,
      })
      expect(f.exceedsDefaultBindingLimit, label).toBe(false)
    }
  })

  it('a world-axis-aligned vertical grid would NOT fit, which is why k is height above ground', () => {
    const conifer = measured.get('dense conifer')!
    const gridHeightM = CANOPY_GRID.nz * CANOPY_GRID.cellM
    expect(conifer.terrainSpanM + conifer.tallestStemM).toBeGreaterThan(gridHeightM)
    // ...whereas the AGL band comfortably fits.
    expect((conifer.report.maxOccupiedLevel + 1) * CANOPY_GRID.cellM).toBeLessThan(gridHeightM)
  })
})
