import { describe, expect, it } from 'vitest'
import { MODELS } from '../../../../src/provenance.ts'
import { INVALID_VOXEL, OccupancyMask, buildLayout, lookup, makeGrid } from '@sim/canopy/storage/layout.ts'
import { canopyStorageWgsl } from '@sim/canopy/storage/shaders.ts'
import { CanopyAllocator, PHASE_INERT, decodeSav, encodeSav, packStore } from '@sim/canopy/storage/store.ts'
import { CLUMPING, FOLIAGE_SAV_PER_M, sampleGround, specificLeafArea, voxeliseVegetation } from '@sim/canopy/storage/voxelise.ts'
import { f16ToF32 } from '@world/terrain/halfFloat.ts'
import { makeStem, makeVegSet, planarTerrain, testSpecies } from './fixtures.ts'

const GRID = makeGrid(32, 32)

describe('SAV log codec', () => {
  it('round-trips every shipped foliage SAV to better than 2%', () => {
    for (const sav of Object.values(FOLIAGE_SAV_PER_M)) {
      const back = decodeSav(encodeSav(sav))
      expect(Math.abs(back / sav - 1)).toBeLessThan(0.02)
    }
  })

  it('clamps rather than wrapping outside its range', () => {
    expect(encodeSav(1)).toBe(0)
    expect(encodeSav(1e9)).toBe(255)
    expect(encodeSav(0)).toBe(0)
  })
})

describe('packStore', () => {
  const sp = testSpecies('pine', 'conifer', 'thick-plated')
  const stem = makeStem({
    speciesId: 'pine',
    x: 32,
    z: 32,
    groundY: 0,
    heightM: 24,
    crownBaseM: 8,
    crownRadiusM: 4,
    crownBulkDensity: 0.15,
    foliarMoisture: 1.0,
  })
  const veg = makeVegSet([stem], [sp])
  const built = voxeliseVegetation(veg, planarTerrain(0), GRID)
  const ground = sampleGround(planarTerrain(0), GRID)
  const packed = packStore(built.fields, ground, veg.species)

  it('sizes the pools from the layout plus the grow tail', () => {
    expect(packed.slotCount).toBeGreaterThan(built.layout.voxelCount)
    expect(packed.slotCount - built.layout.voxelCount).toBeGreaterThanOrEqual(4096)
    expect(packed.poolA.length).toBe(packed.slotCount * 4)
    expect(packed.poolB.length).toBe(packed.slotCount * 2)
    expect(packed.poolC.length).toBe(packed.slotCount)
    expect(packed.columnIndex.length).toBe(32 * 32 * 2)
  })

  it('round-trips LAD and dry density through the f16 pair in pool B', () => {
    let checked = 0
    for (let v = 0; v < built.layout.voxelCount; v++) {
      const rho = built.fields.dryDensity[v] as number
      if (rho <= 0) continue
      const w0 = packed.poolB[v * 2] as number
      // f16 carries ~3 decimal digits; assert relative error, not absolute.
      expect(f16ToF32(w0 & 0xffff) / (built.fields.lad[v] as number)).toBeCloseTo(1, 2)
      expect(f16ToF32(w0 >>> 16) / rho).toBeCloseTo(1, 2)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('stores species, clumping and bark class in pool B word 1', () => {
    const v = firstOccupied(built.fields.dryDensity)
    const w1 = packed.poolB[v * 2 + 1] as number
    expect(decodeSav(w1 & 0xff) / FOLIAGE_SAV_PER_M.conifer).toBeCloseTo(1, 1)
    expect((w1 >>> 8) & 0xff).toBe(0) // one species in the fixture
    expect(((w1 >>> 16) & 0xff) / 255).toBeCloseTo(CLUMPING.conifer, 2)
    expect((w1 >>> 24) & 0xff).toBe(0) // 'thick-plated' is bark class 0
  })

  it('initialises pool A inert, at ambient, full foliage, with the water split', () => {
    const v = firstOccupied(built.fields.dryDensity)
    const a = v * 4
    expect(f16ToF32((packed.poolA[a] as number) & 0xffff)).toBeCloseTo(293.15, 0)
    expect((packed.poolA[a] as number) >>> 16).toBe(65535)
    expect(packed.poolA[a + 1]).toBe(0) // roundwood: deliberately zero, see provenance
    expect(
      f16ToF32((packed.poolA[a + 2] as number) & 0xffff) / (built.fields.freeWater[v] as number),
    ).toBeCloseTo(1, 2)
    expect(
      f16ToF32((packed.poolA[a + 2] as number) >>> 16) / (built.fields.boundWater[v] as number),
    ).toBeCloseTo(1, 2)
    expect(((packed.poolA[a + 3] as number) >>> 8) & 0xff).toBe(PHASE_INERT)
    expect(packed.poolC[v]).toBe(0)
  })

  it('leaves the grow tail zeroed', () => {
    for (let v = built.layout.voxelCount; v < packed.slotCount; v++) {
      expect(packed.poolA[v * 4]).toBe(0)
      expect(packed.poolB[v * 2]).toBe(0)
    }
  })

  it('mirrors the column index the CPU lookup uses', () => {
    for (let c = 0; c < 32 * 32; c++) {
      expect(packed.columnIndex[c * 2]).toBe(built.layout.columnHeader[c])
      expect(packed.columnIndex[c * 2 + 1]).toBe(built.layout.columnOffset[c])
    }
  })

  it('the LAD it stores is the one the shader will reconstruct', () => {
    // Guards the encode/decode pair that WGSL canopy_lad() mirrors.
    const v = firstOccupied(built.fields.dryDensity)
    const rho = built.fields.dryDensity[v] as number
    expect(
      f16ToF32((packed.poolB[v * 2] as number) & 0xffff) / (rho * specificLeafArea('conifer')),
    ).toBeCloseTo(1, 2)
  })
})

describe('CanopyAllocator', () => {
  const g = makeGrid(4, 16)

  const build = (spare: number) => {
    const mask = new OccupancyMask(g)
    for (let k = 4; k <= 6; k++) mask.set(0, 0, k)
    const layout = buildLayout(mask)
    const index = new Uint32Array(4 * 4 * 2)
    for (let c = 0; c < 16; c++) {
      index[c * 2] = layout.columnHeader[c] as number
      index[c * 2 + 1] = layout.columnOffset[c] as number
    }
    return new CanopyAllocator(layout, index, layout.voxelCount + spare)
  }

  it('is a no-op when the range is already covered', () => {
    const a = build(10)
    const before = a.freeSlots
    const r = a.ensureRange(0, 0, 5, 6)
    expect(r.offset).toBe(0)
    expect(r.zStart).toBe(4)
    expect(r.zCount).toBe(3)
    expect(r.leaked).toBe(0)
    expect(a.freeSlots).toBe(before)
  })

  it('activates an empty column from the tail', () => {
    const a = build(10)
    expect(a.lookup(2, 2, 7)).toBe(INVALID_VOXEL)
    const r = a.ensureRange(2, 2, 7, 8)
    expect(r.offset).toBe(3) // straight after the built run
    expect(r.zCount).toBe(2)
    expect(a.lookup(2, 2, 7)).toBe(3)
    expect(a.lookup(2, 2, 8)).toBe(4)
    expect(a.lookup(2, 2, 9)).toBe(INVALID_VOXEL)
    expect(a.freeSlots).toBe(8)
    expect(a.leaked).toBe(0)
  })

  it('re-homes a grown column and leaks the old run', () => {
    const a = build(10)
    const r = a.ensureRange(0, 0, 2, 6) // extend downward from 4 to 2
    expect(r.zStart).toBe(2)
    expect(r.zCount).toBe(5)
    expect(r.offset).toBe(3)
    expect(r.leaked).toBe(3)
    expect(a.leaked).toBe(3)
    expect(a.lookup(0, 0, 2)).toBe(3)
    expect(a.lookup(0, 0, 6)).toBe(7)
    expect(a.lookup(0, 0, 7)).toBe(INVALID_VOXEL)
  })

  it('unions with the existing run rather than replacing it', () => {
    const a = build(20)
    a.ensureRange(0, 0, 10, 10)
    expect(a.lookup(0, 0, 4)).not.toBe(INVALID_VOXEL) // original levels still addressable
    expect(a.lookup(0, 0, 10)).not.toBe(INVALID_VOXEL)
  })

  it('clamps the request to the z axis', () => {
    const a = build(40)
    const r = a.ensureRange(1, 1, -5, 99)
    expect(r.zStart).toBe(0)
    expect(r.zCount).toBe(g.nz)
  })

  it('refuses when the tail is exhausted, changing nothing', () => {
    const a = build(2)
    const r = a.ensureRange(2, 2, 0, 9) // needs 10, only 2 free
    expect(r.offset).toBe(INVALID_VOXEL)
    expect(a.failedAllocations).toBe(1)
    expect(a.overflowed).toBe(true)
    expect(a.freeSlots).toBe(2)
    expect(a.lookup(2, 2, 0)).toBe(INVALID_VOXEL)
    // The pre-existing column is untouched.
    expect(a.lookup(0, 0, 5)).toBe(1)
  })

  it('refuses coordinates outside the grid', () => {
    const a = build(10)
    expect(a.ensureRange(-1, 0, 0, 1).offset).toBe(INVALID_VOXEL)
    expect(a.ensureRange(0, 99, 0, 1).offset).toBe(INVALID_VOXEL)
  })

  it('agrees with the pure lookup for every built voxel', () => {
    const mask = new OccupancyMask(g)
    for (let k = 4; k <= 6; k++) mask.set(0, 0, k)
    mask.set(3, 3, 1)
    const layout = buildLayout(mask)
    const index = new Uint32Array(32)
    for (let c = 0; c < 16; c++) {
      index[c * 2] = layout.columnHeader[c] as number
      index[c * 2 + 1] = layout.columnOffset[c] as number
    }
    const a = new CanopyAllocator(layout, index, layout.voxelCount)
    for (let j = 0; j < g.nxy; j++)
      for (let i = 0; i < g.nxy; i++)
        for (let k = 0; k < g.nz; k++) expect(a.lookup(i, j, k)).toBe(lookup(layout, i, j, k))
  })
})

describe('WGSL emission', () => {
  const src = canopyStorageWgsl(1)

  it('emits the layout constants from the TypeScript definition', () => {
    expect(src).toContain('const CANOPY_NXY: u32 = 512u;')
    expect(src).toContain('const CANOPY_NZ: u32 = 64u;')
    expect(src).toContain('const CANOPY_CELL: f32 = 2.0;')
    expect(src).toContain('const CANOPY_INVALID: u32 = 4294967295u;')
    expect(src).toContain('@group(1) @binding(0)')
    expect(src).toContain('@group(1) @binding(4)')
  })

  it('does not require the shader-f16 feature', () => {
    expect(src).not.toContain('enable f16')
    expect(src).toContain('unpack2x16float')
  })

  it('carries the addressing and accessor functions', () => {
    for (const fn of [
      'canopy_lookup',
      'canopy_sample_at',
      'canopy_voxel_centre',
      'canopy_lad',
      'canopy_extinction',
      'canopy_temperature',
    ]) {
      expect(src).toContain(`fn ${fn}(`)
    }
  })
})

describe('provenance', () => {
  // Full references and open questions moved to `docs/spec/_provenance-notes.md` when the
  // eleven per-package records collapsed into one table. What the CODE still owes is that
  // every model is present, has a status, and cites a locator specific enough to find.
  it('registers both canopy storage models with a locator', () => {
    const ours = MODELS.filter((m) => m.subsystem === 'Canopy storage')
    expect(ours).toHaveLength(2)
    for (const m of ours) expect(m.locator.length).toBeGreaterThan(10)
  })

  it('still declares the foliage optics model estimated', () => {
    expect(MODELS.find((m) => m.id === 'canopy-foliage-optics')?.status).toBe('estimated')
  })
})

function firstOccupied(rho: Float32Array): number {
  for (let v = 0; v < rho.length; v++) if ((rho[v] as number) > 0) return v
  throw new Error('no occupied voxel')
}
