/**
 * The fuel bed is rasterised from the world, and the failure mode is that it silently is not.
 *
 * A map that comes out uniform is indistinguishable from the uniform fill it replaced — same
 * type, same size, same everything except that the fire has nothing to find. That happened on
 * the first run of this code and the boot report caught it, so it is worth a test too.
 */

import { describe, expect, it } from 'vitest'
import { buildSurfaceFuelMap, CLOSED_CANOPY_FRACTION, BARE_GROUND_FRACTION } from '@sim/surface/fuelMap.ts'
import { NON_BURNABLE_ID } from '@sim/rothermel/fuelModels.ts'

/** A 4x4 understory field: one closed-canopy quarter, one covered, one bare. */
const field = (closure: readonly number[], cover: readonly number[]) => ({
  cols: 4,
  sizeM: 64,
  canopyClosure: Float64Array.from(closure),
  cover: Float64Array.from(cover),
})

const uniform = (n: number, v: number): number[] => Array.from({ length: n }, () => v)

describe('cover becomes fuel', () => {
  it('puts litter under a closed canopy and the understory model in the open', () => {
    const closure = uniform(16, 0)
    const cover = uniform(16, 0.8)
    closure[0] = 0.9 // one closed cell
    const map = buildSurfaceFuelMap({
      understory: field(closure, cover),
      cells: 8,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    expect(map.histogram.get(7), 'no closed-canopy litter').toBeGreaterThan(0)
    expect(map.histogram.get(3), 'no open-ground fuel').toBeGreaterThan(0)
  })

  it('marks genuinely bare ground non-burnable, and nothing else', () => {
    const map = buildSurfaceFuelMap({
      understory: field(uniform(16, 0), uniform(16, 0)),
      cells: 8,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    expect(map.nonBurnableCells).toBe(64)
    expect(map.histogram.get(NON_BURNABLE_ID)).toBe(64)
  })

  it('keeps sparse-but-present cover burnable', () => {
    // Just above the bare threshold is still fuel. The only thing that stops burning is the
    // absence of anything to burn.
    const map = buildSurfaceFuelMap({
      understory: field(uniform(16, 0), uniform(16, BARE_GROUND_FRACTION + 0.01)),
      cells: 8,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    expect(map.nonBurnableCells).toBe(0)
  })

  it('switches at the closure threshold, not somewhere near it', () => {
    const below = buildSurfaceFuelMap({
      understory: field(uniform(16, CLOSED_CANOPY_FRACTION - 0.01), uniform(16, 0.5)),
      cells: 4,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    const above = buildSurfaceFuelMap({
      understory: field(uniform(16, CLOSED_CANOPY_FRACTION), uniform(16, 0.5)),
      cells: 4,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    expect(below.histogram.get(3)).toBe(16)
    expect(above.histogram.get(7)).toBe(16)
  })
})

describe('the map covers the grid it claims to', () => {
  it('writes every cell exactly once', () => {
    const cells = 16
    const map = buildSurfaceFuelMap({
      understory: field(uniform(16, 0.9), uniform(16, 0.9)),
      cells,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    expect(map.fuelIds.length).toBe(cells * cells)
    let total = 0
    for (const n of map.histogram.values()) total += n
    expect(total).toBe(cells * cells)
  })

  it('does not interpolate between fuel ids', () => {
    // Ids are labels. A cell between a 7 and a 3 must be one of them and never a 5, which
    // would name a completely different fuel model.
    const closure = uniform(16, 0)
    for (let i = 0; i < 8; i++) closure[i] = 0.9
    const map = buildSurfaceFuelMap({
      understory: field(closure, uniform(16, 0.8)),
      cells: 32,
      canopyFuelId: 7,
      understoryFuelId: 3,
    })
    for (const id of map.histogram.keys()) expect([3, 7]).toContain(id)
  })
})
