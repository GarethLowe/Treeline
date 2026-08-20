import { describe, expect, it } from 'vitest'
import { CANOPY_GRID, INVALID_VOXEL, OccupancyMask, VOXEL_BYTES, buildLayout, columnCount, denseVoxelCount, footprint, lookup, makeGrid, packHeader } from '@sim/canopy/storage/layout.ts'
import { CANOPY_CELL_M_3D, CANOPY_N_XY, CANOPY_N_Z } from '@contracts/sim'

describe('canopy grid', () => {
  it('matches the frozen contract constants', () => {
    expect(CANOPY_GRID.nxy).toBe(CANOPY_N_XY)
    expect(CANOPY_GRID.nz).toBe(CANOPY_N_Z)
    expect(CANOPY_GRID.cellM).toBe(CANOPY_CELL_M_3D)
    expect(CANOPY_GRID.domainM).toBe(1024)
    expect(denseVoxelCount(CANOPY_GRID)).toBe(16_777_216)
    expect(columnCount(CANOPY_GRID)).toBe(262_144)
  })

  it('rejects a z axis that will not fit the u8-packed header', () => {
    expect(() => makeGrid(64, 256)).toThrow(/255/)
    expect(makeGrid(64, 255).nz).toBe(255)
  })
})

describe('OccupancyMask', () => {
  it('sets, reads and counts bits independently', () => {
    const g = makeGrid(4, 8)
    const mask = new OccupancyMask(g)
    expect(mask.count()).toBe(0)
    mask.set(0, 0, 0)
    mask.set(3, 3, 7)
    mask.set(1, 2, 5)
    expect(mask.count()).toBe(3)
    expect(mask.get(0, 0, 0)).toBe(true)
    expect(mask.get(3, 3, 7)).toBe(true)
    expect(mask.get(1, 2, 5)).toBe(true)
    expect(mask.get(1, 2, 4)).toBe(false)
    // Idempotent.
    mask.set(1, 2, 5)
    expect(mask.count()).toBe(3)
  })

  it('counts a fully set mask', () => {
    const g = makeGrid(4, 8)
    const mask = new OccupancyMask(g)
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) mask.set(i, j, k)
    expect(mask.count()).toBe(denseVoxelCount(g))
  })
})

describe('buildLayout', () => {
  const g = makeGrid(4, 16)

  it('allocates exactly the min-to-max span of each column', () => {
    const mask = new OccupancyMask(g)
    // column (0,0): levels 3..5 contiguous -> run 3
    for (let k = 3; k <= 5; k++) mask.set(0, 0, k)
    // column (1,0): levels 2 and 9, a hole between -> run 8, 6 interior gaps
    mask.set(1, 0, 2)
    mask.set(1, 0, 9)
    // column (2,2): a single level
    mask.set(2, 2, 15)

    const layout = buildLayout(mask)
    expect(layout.occupiedColumns).toBe(3)
    expect(layout.voxelCount).toBe(3 + 8 + 1)
    expect(layout.interiorGapVoxels).toBe(6)
    expect(layout.spareVoxels).toBe(0)
  })

  it('round-trips every occupied voxel through lookup and rejects everything else', () => {
    const mask = new OccupancyMask(g)
    for (let k = 3; k <= 5; k++) mask.set(0, 0, k)
    mask.set(1, 0, 2)
    mask.set(1, 0, 9)
    mask.set(2, 2, 15)
    const layout = buildLayout(mask)

    const seen = new Set<number>()
    for (let j = 0; j < g.nxy; j++) {
      for (let i = 0; i < g.nxy; i++) {
        for (let k = 0; k < g.nz; k++) {
          const v = lookup(layout, i, j, k)
          if (mask.get(i, j, k)) {
            expect(v).not.toBe(INVALID_VOXEL)
            expect(v).toBeLessThan(layout.voxelCount)
            expect(seen.has(v)).toBe(false)
            seen.add(v)
          }
        }
      }
    }
    // Every occupied voxel got a distinct slot, and the run also covers the interior gaps.
    expect(seen.size).toBe(mask.count())
  })

  it('returns INVALID outside the grid', () => {
    const layout = buildLayout(new OccupancyMask(g))
    expect(lookup(layout, -1, 0, 0)).toBe(INVALID_VOXEL)
    expect(lookup(layout, 0, -1, 0)).toBe(INVALID_VOXEL)
    expect(lookup(layout, 0, 0, -1)).toBe(INVALID_VOXEL)
    expect(lookup(layout, g.nxy, 0, 0)).toBe(INVALID_VOXEL)
    expect(lookup(layout, 0, 0, g.nz)).toBe(INVALID_VOXEL)
  })

  it('adds the requested growth headroom', () => {
    const mask = new OccupancyMask(g)
    for (let k = 0; k < 10; k++) mask.set(0, 0, k)
    const layout = buildLayout(mask, 0.5)
    expect(layout.voxelCount).toBe(10)
    expect(layout.spareVoxels).toBe(5)
  })
})

describe('header packing', () => {
  it('survives the extremes of a 64-level axis', () => {
    for (const [start, count] of [
      [0, 0],
      [0, 64],
      [63, 1],
      [21, 43],
    ] as const) {
      const h = packHeader(start, count)
      expect(h & 0xff).toBe(start)
      expect((h >>> 8) & 0xff).toBe(count)
    }
  })
})

describe('footprint', () => {
  it('is the sum of the three pools plus the per-column index', () => {
    const g = makeGrid(4, 16)
    const mask = new OccupancyMask(g)
    for (let k = 0; k < 10; k++) mask.set(0, 0, k)
    const f = footprint(buildLayout(mask))
    expect(f.voxelSlots).toBe(10)
    expect(f.poolABytes + f.poolBBytes + f.poolCBytes).toBe(10 * VOXEL_BYTES)
    expect(f.indexBytes).toBe(16 * 12)
    expect(f.totalBytes).toBe(10 * VOXEL_BYTES + 16 * 12)
    expect(f.totalMiB).toBeCloseTo(f.totalBytes / 1048576, 9)
    expect(f.totalMB).toBeCloseTo(f.totalBytes / 1e6, 9)
    expect(f.exceedsDefaultBindingLimit).toBe(false)
  })

  it('flags a pool that would breach the default 128 MiB binding limit', () => {
    // Synthesised, not measured: 9 M slots would need pool A > 128 MiB. The real worlds are
    // an order of magnitude below this (see occupancy.test.ts) — the guard exists so a future
    // grid change cannot cross the limit silently.
    const fake = {
      grid: makeGrid(4, 16),
      columnHeader: new Uint32Array(16),
      columnOffset: new Uint32Array(16),
      voxelCount: 9_000_000,
      occupiedColumns: 16,
      interiorGapVoxels: 0,
      spareVoxels: 0,
    }
    expect(footprint(fake).exceedsDefaultBindingLimit).toBe(true)
  })
})
