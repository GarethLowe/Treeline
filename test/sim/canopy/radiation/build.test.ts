/**
 * The two world-build inputs WP 3.3 needs and had no producer for.
 *
 * These matter more than a usual unit test: everything downstream of them is WGSL, and WGSL
 * never reaches a compiler under Vitest. If the brick index convention is wrong the fire
 * heats the wrong part of the forest and nothing anywhere reports an error.
 */

import { describe, expect, it } from 'vitest'
import { buildBrickList, buildExtinctionField } from '@sim/canopy/radiation/build.ts'
import { RAD_NI, RAD_NJ, RAD_NK, RAD_CELLS_PER_BRICK_AXIS } from '@sim/canopy/radiation/layout.ts'
import { BRICK_NI, BRICK_NJ } from '@sim/canopy/radiation/shaders.ts'
import { LEAF_PROJECTION_SPHERICAL } from '@sim/canopy/radiation/optics.ts'
import { CLUMPING } from '@sim/canopy/storage/voxelise.ts'
import type { CanopyFields } from '@sim/canopy/storage/voxelise.ts'
import { CANOPY_GRID, packHeader } from '@sim/canopy/storage/layout.ts'
import type { CanopyLayout } from '@sim/canopy/storage/layout.ts'
import type { SpeciesDef } from '@contracts/world.ts'

/**
 * A canopy holding foliage in exactly one column, over the vertical run `[zStart, zStart+n)`.
 * Everything else is an empty column, which is what the packed layout represents natively.
 */
function oneColumn(i: number, j: number, zStart: number, count: number, lad: number): CanopyFields {
  const g = CANOPY_GRID
  const columns = g.nxy * g.nxy
  const columnHeader = new Uint32Array(columns)
  const columnOffset = new Uint32Array(columns)
  columnHeader[j * g.nxy + i] = packHeader(zStart, count)
  columnOffset[j * g.nxy + i] = 0
  const layout: CanopyLayout = {
    grid: g,
    columnHeader,
    columnOffset,
    voxelCount: count,
    occupiedColumns: 1,
    interiorGapVoxels: 0,
    spareVoxels: 0,
  }
  return {
    layout,
    dryDensity: new Float32Array(count),
    lad: new Float32Array(count).fill(lad),
    freeWater: new Float32Array(count),
    boundWater: new Float32Array(count),
    speciesIdx: new Uint8Array(count),
    speciesIds: ['pine'],
    depositedMassKg: 0,
    clippedMassKg: 0,
  }
}

const PINE = new Map<string, SpeciesDef>([
  ['pine', { form: 'conifer' } as SpeciesDef],
])

/** binary16 → number, for reading the field back. */
function fromHalf(h: number): number {
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return frac * 2 ** -24
  return (1 + frac / 1024) * 2 ** (exp - 15)
}

describe('buildExtinctionField', () => {
  it('is the 2x2x2 mean of G * Omega_c * LAD, not the mean of transmittance', () => {
    // Fill one 4 m cell completely: canopy voxels (0..1, 0..1, 0..1) would need four columns,
    // so use one column and expect exactly 2 of the 8 sub-voxels to be occupied.
    const fields = oneColumn(0, 0, 0, 2, 4)
    const out = buildExtinctionField(fields, PINE)
    expect(out.length).toBe(RAD_NI * RAD_NJ * RAD_NK)

    const expected = (2 * LEAF_PROJECTION_SPHERICAL * CLUMPING.conifer * 4) / 8
    expect(fromHalf(out[0] as number)).toBeCloseTo(expected, 3)
  })

  it('is zero wherever no column is allocated', () => {
    const out = buildExtinctionField(oneColumn(0, 0, 0, 2, 4), PINE)
    // Cell (1,0,0) covers canopy voxels i=2,3 — a different, empty column.
    expect(out[1]).toBe(0)
    expect(out[out.length - 1]).toBe(0)
  })

  it('scales linearly with LAD, which is the property that makes averaging legitimate', () => {
    const a = buildExtinctionField(oneColumn(0, 0, 0, 2, 1), PINE)
    const b = buildExtinctionField(oneColumn(0, 0, 0, 2, 3), PINE)
    expect(fromHalf(b[0] as number) / fromHalf(a[0] as number)).toBeCloseTo(3, 2)
  })

  it('rejects a species the voxel data references but the map does not define', () => {
    expect(() => buildExtinctionField(oneColumn(0, 0, 0, 2, 1), new Map())).toThrow(/unknown species/)
  })
})

describe('buildBrickList', () => {
  it('encodes the index exactly as gather.wgsl decodes it', () => {
    // A brick spans RAD_CELLS_PER_BRICK_AXIS radiation cells, each 2 canopy voxels wide.
    const per = RAD_CELLS_PER_BRICK_AXIS * 2
    const bi = 3
    const bj = 5
    const bk = 2
    const list = buildBrickList(oneColumn(bi * per, bj * per, bk * per, 1, 2))
    expect(list.count).toBe(1)
    const idx = list.indices[0] as number
    // The decode in gather.wgsl, run forwards.
    expect(idx % BRICK_NI).toBe(bi)
    expect(Math.floor(idx / BRICK_NI) % BRICK_NJ).toBe(bj)
    expect(Math.floor(idx / (BRICK_NI * BRICK_NJ))).toBe(bk)
  })

  it('lists nothing for a bare world, and never hands back a zero-length buffer', () => {
    const empty = oneColumn(0, 0, 0, 0, 0)
    const list = buildBrickList(empty)
    expect(list.count).toBe(0)
    // A zero-size storage buffer is a WebGPU validation error, so the array keeps one slot.
    expect(list.indices.length).toBeGreaterThan(0)
  })

  it('is sparse: one occupied column touches one brick, not the whole grid', () => {
    const list = buildBrickList(oneColumn(100, 100, 0, 4, 2))
    expect(list.count).toBe(1)
    expect(list.total).toBeGreaterThan(1000)
  })
})
