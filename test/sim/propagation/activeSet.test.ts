import { describe, expect, it } from 'vitest'
import { m, mps } from '@contracts/units'
import {
  BAND_M,
  TILE_CELLS,
  classifyTiles,
  dispatchArgs,
  fromSortableBits,
  sortableBits,
  tileGrid,
  workgroupsFor,
} from '@sim/propagation/activeSet'
import { isotropicEllipse } from '@sim/propagation/ellipse'
import { LevelSetField } from '@sim/propagation/levelset'
import { cflTimestep } from '@sim/propagation/timestep'

describe('tile classification', () => {
  const grid = tileGrid(64, 64) // 4 x 4 tiles

  it('selects the active tile and dilates it by exactly one tile', () => {
    const minAbs = new Float32Array(grid.count).fill(Number.POSITIVE_INFINITY)
    minAbs[grid.tilesX * 1 + 1] = 0
    const out = new Uint32Array(grid.count)
    const n = classifyTiles(minAbs, grid, BAND_M, out)
    expect(n).toBe(9)
    const ids = new Set(Array.from(out.subarray(0, n)))
    for (const ty of [0, 1, 2]) for (const tx of [0, 1, 2]) expect(ids.has(ty * grid.tilesX + tx)).toBe(true)
    expect(ids.has(3)).toBe(false)
  })

  it('clips the dilation at the domain edge', () => {
    const minAbs = new Float32Array(grid.count).fill(Number.POSITIVE_INFINITY)
    minAbs[0] = 0
    const out = new Uint32Array(grid.count)
    expect(classifyTiles(minAbs, grid, BAND_M, out)).toBe(4)
  })

  it('drops tiles whose front is outside the band', () => {
    const minAbs = new Float32Array(grid.count).fill(Number.POSITIVE_INFINITY)
    minAbs[grid.tilesX * 1 + 1] = BAND_M + 0.001
    const out = new Uint32Array(grid.count)
    expect(classifyTiles(minAbs, grid, BAND_M, out)).toBe(0)
    minAbs[grid.tilesX * 1 + 1] = BAND_M
    expect(classifyTiles(minAbs, grid, BAND_M, out)).toBe(9)
  })

  it('never writes past the end of the output list', () => {
    const minAbs = new Float32Array(grid.count).fill(0)
    const out = new Uint32Array(3)
    expect(classifyTiles(minAbs, grid, BAND_M, out)).toBe(3)
  })
})

describe('sortable float bits — atomicMin on u32 is min on the float', () => {
  it('preserves order for non-negative floats', () => {
    const values = [0, 1e-8, 0.25, 0.5, 1, 4, 1e6, Number.POSITIVE_INFINITY]
    for (let i = 1; i < values.length; i++) {
      expect(sortableBits(values[i] as number)).toBeGreaterThan(sortableBits(values[i - 1] as number))
    }
    for (const v of values) expect(fromSortableBits(sortableBits(v))).toBe(Math.fround(v))
  })
})

describe('indirect dispatch args — WebGPU silently skips an out-of-range dispatch', () => {
  const LIMIT = 65535 // maxComputeWorkgroupsPerDimension on the target part

  it('passes small counts straight through', () => {
    expect(dispatchArgs(0, LIMIT)).toEqual({ x: 0, y: 0, z: 1, overflowed: false })
    expect(dispatchArgs(1, LIMIT)).toEqual({ x: 1, y: 1, z: 1, overflowed: false })
    expect(dispatchArgs(LIMIT, LIMIT)).toEqual({ x: LIMIT, y: 1, z: 1, overflowed: false })
  })

  it('folds the excess into Y rather than losing the whole dispatch', () => {
    const a = dispatchArgs(LIMIT + 1, LIMIT)
    expect(a.overflowed).toBe(false)
    expect(a.x).toBe(LIMIT)
    expect(a.y).toBe(2)
    expect(a.x * a.y).toBeGreaterThanOrEqual(LIMIT + 1)
  })

  it('always covers the requested work and always stays inside the limit', () => {
    for (const n of [7, 100, 65535, 65536, 130000, 1_000_000, 4_294_967_295]) {
      const a = dispatchArgs(n, LIMIT)
      expect(a.x).toBeLessThanOrEqual(LIMIT)
      expect(a.y).toBeLessThanOrEqual(LIMIT)
      expect(a.z).toBe(1)
      if (!a.overflowed) expect(a.x * a.y).toBeGreaterThanOrEqual(n)
    }
  })

  it('flags the case it genuinely cannot cover, instead of failing silently', () => {
    const a = dispatchArgs(LIMIT * LIMIT + 1, LIMIT)
    expect(a.overflowed).toBe(true)
    // 2048^2 / 256 cells per workgroup = 16,384 workgroups worst case, so the real solver
    // never gets near this. The flag exists because the failure mode is invisible.
    expect(workgroupsFor(2048 * 2048, 256)).toBeLessThan(LIMIT)
  })
})

describe('cost scales with burning area, not domain area', () => {
  const CELL = 0.5

  function grow(n: number, seconds: number) {
    const field = new LevelSetField(n, CELL)
    const c = (n * CELL) / 2
    field.ignite({ kind: 'point', x: m(c), z: m(c), radius: m(1) })
    const e = isotropicEllipse(0.4)
    const dt = cflTimestep(mps(e.head), CELL)
    const steps = Math.round(seconds / dt)
    for (let i = 0; i < steps; i++) field.step(dt, e)
    return field
  }

  it('touches a small fraction of the domain', () => {
    const n = 256
    const field = grow(n, 30)
    const totalCells = n * n
    expect(field.activeCellCount).toBeLessThan(totalCells * 0.25)
    expect(field.activeCellCount).toBeGreaterThan(0)
  })

  it('grows with the perimeter, not with the burnt area', () => {
    // Doubling the radius quadruples the area and doubles the perimeter. A domain-sized
    // solver would show no change at all; a band solver must track the perimeter.
    const small = grow(256, 30)
    const large = grow(256, 60)
    const areaRatio = large.burntAreaM2() / small.burntAreaM2()
    const costRatio = large.activeCellCount / small.activeCellCount

    expect(areaRatio).toBeGreaterThan(3)
    expect(costRatio).toBeLessThan(2.4)
    expect(costRatio).toBeGreaterThan(1.4)
  })

  it('a tile is 16 cells, so 2048^2 compacts to 128^2 = 16,384 elements', () => {
    expect(TILE_CELLS).toBe(16)
    const g = tileGrid(2048, 2048)
    expect(g.count).toBe(16_384)
  })
})
