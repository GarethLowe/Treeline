import { describe, expect, it } from 'vitest'
import { buildLayout, makeGrid } from '@sim/canopy/storage/layout.ts'
import { CLUMPING, FOLIAGE_SAV_PER_M, PARTICLE_DENSITY_KG_M3, crownRadiusFraction, groundStepM, sampleGround, specificLeafArea, voxeliseFields, voxeliseOccupancy, voxeliseVegetation } from '@sim/canopy/storage/voxelise.ts'
import { crownVolumeM3 } from '@world/vegetation/vegetationSet.ts'
import type { Form } from '@sim/canopy/storage/voxelise.ts'
import { makeStem, makeVegSet, planarTerrain, testSpecies } from './fixtures.ts'

const GRID = makeGrid(32, 32) // 64 m x 64 m x 64 m at 2 m

describe('crown shape', () => {
  // The rasterised envelope must integrate to the same volume `crownVolumeM3` uses, or the
  // mass ends up in the wrong voxels even though the total is conserved by normalisation.
  const analyticFactor: Record<Form, number> = {
    conifer: 1 / 3,
    broadleaf: 2 / 3,
    shrub: 2 / 3,
    fern: 1,
    grass: 1,
  }

  for (const form of ['conifer', 'broadleaf', 'shrub', 'grass'] as Form[]) {
    it(`${form} radius profile integrates to the ${analyticFactor[form].toFixed(3)} shape factor`, () => {
      const n = 20_000
      let sum = 0
      for (let q = 0; q < n; q++) {
        const r = crownRadiusFraction(form, (q + 0.5) / n)
        sum += r * r
      }
      expect(sum / n).toBeCloseTo(analyticFactor[form], 3)
    })
  }

  it('is zero outside [0, 1]', () => {
    expect(crownRadiusFraction('conifer', -0.01)).toBe(0)
    expect(crownRadiusFraction('conifer', 1.01)).toBe(0)
  })
})

describe('leaf area density derivation', () => {
  it('is SLA = sigma / (2 rho_p), not a transcribed constant', () => {
    for (const form of Object.keys(FOLIAGE_SAV_PER_M) as Form[]) {
      expect(specificLeafArea(form)).toBeCloseTo(
        FOLIAGE_SAV_PER_M[form] / (2 * PARTICLE_DENSITY_KG_M3),
        10,
      )
    }
  })

  it('lands inside the reported one-sided SLA ranges for each growth form', () => {
    // Cross-check, not a source: the derivation is what ships (see provenance.ts).
    expect(specificLeafArea('conifer')).toBeGreaterThan(3)
    expect(specificLeafArea('conifer')).toBeLessThan(6)
    expect(specificLeafArea('broadleaf')).toBeGreaterThan(8)
    expect(specificLeafArea('broadleaf')).toBeLessThan(20)
    expect(specificLeafArea('shrub')).toBeGreaterThan(4)
    expect(specificLeafArea('shrub')).toBeLessThan(7)
  })

  it('reproduces the spec 7.3 worked extinction point when given its LAD', () => {
    // kappa = G * Omega_c * LAD; LAD = 2, Omega_c = 0.6 -> 0.6 /m, eps = 1 - exp(-0.6*2) = 0.70
    const kappa = 0.5 * CLUMPING.conifer * 2
    expect(kappa).toBeCloseTo(0.6, 10)
    expect(1 - Math.exp(-kappa * 2)).toBeCloseTo(0.6988, 3)
  })
})

describe('voxelisation', () => {
  const sp = testSpecies('pine', 'conifer')
  const centreStem = makeStem({
    speciesId: 'pine',
    x: 32,
    z: 32,
    groundY: 0,
    heightM: 24,
    crownBaseM: 8,
    crownRadiusM: 4,
    crownBulkDensity: 0.15,
  })

  it('conserves total oven-dry foliage mass exactly', () => {
    const veg = makeVegSet([centreStem], [sp])
    const { fields, occupancy } = voxeliseVegetation(veg, planarTerrain(0), GRID)
    const analytic = 0.15 * crownVolumeM3(centreStem, 'conifer')
    expect(occupancy.stemFoliageMassKg).toBeCloseTo(analytic, 9)
    expect(fields.depositedMassKg + fields.clippedMassKg).toBeCloseTo(analytic, 6)
    expect(fields.clippedMassKg).toBe(0)

    const vol = GRID.cellM ** 3
    let gridMass = 0
    for (const d of fields.dryDensity) gridMass += d * vol
    expect(gridMass / analytic).toBeCloseTo(1, 6) // f32 accumulation, not the algorithm
  })

  it('derives LAD from the deposited density and nothing else', () => {
    const veg = makeVegSet([centreStem], [sp])
    const { fields } = voxeliseVegetation(veg, planarTerrain(0), GRID)
    const sla = specificLeafArea('conifer')
    let checked = 0
    for (let v = 0; v < fields.dryDensity.length; v++) {
      const rho = fields.dryDensity[v] as number
      if (rho <= 0) continue
      expect((fields.lad[v] as number) / (rho * sla)).toBeCloseTo(1, 6)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('splits moisture at fibre saturation', () => {
    const wet = makeStem({ ...toSpec(centreStem), foliarMoisture: 1.0 })
    const veg = makeVegSet([wet], [sp])
    const { fields } = voxeliseVegetation(veg, planarTerrain(0), GRID)
    for (let v = 0; v < fields.dryDensity.length; v++) {
      const rho = fields.dryDensity[v] as number
      if (rho <= 0) continue
      expect(fields.boundWater[v] as number).toBeCloseTo(rho * 0.3, 6)
      expect(fields.freeWater[v] as number).toBeCloseTo(rho * 0.7, 6)
    }
  })

  it('puts the crown in the right AGL levels and nowhere else', () => {
    const veg = makeVegSet([centreStem], [sp])
    const ground = sampleGround(planarTerrain(0), GRID)
    const occ = voxeliseOccupancy(veg, ground, GRID)
    let lo = GRID.nz
    let hi = -1
    for (let j = 0; j < GRID.nxy; j++)
      for (let i = 0; i < GRID.nxy; i++)
        for (let k = 0; k < GRID.nz; k++)
          if (occ.mask.get(i, j, k)) {
            if (k < lo) lo = k
            if (k > hi) hi = k
          }
    // Crown base 8 m -> level 4; nothing below it.
    expect(lo).toBe(4)
    // Top 24 m -> level 11, but the cone's apex is thinner than a 2 m voxel's sub-sample
    // spacing, so the last level or two of a narrow crown legitimately holds no sample.
    expect(hi).toBeGreaterThanOrEqual(9)
    expect(hi).toBeLessThanOrEqual(11)
  })

  it('follows the terrain: the same crown lands at the same AGL level on a slope', () => {
    const slope = 0.5 // 26.6 deg
    const terrain = planarTerrain(0, slope)
    const lowGround = terrain.heightAt(20.5 as never, 0 as never)
    const highGround = terrain.heightAt(44.5 as never, 0 as never)
    expect(highGround - lowGround).toBeGreaterThan(10)

    const stems = [
      makeStem({ speciesId: 'pine', x: 20, z: 32, groundY: lowGround, heightM: 20, crownBaseM: 8, crownRadiusM: 3, crownBulkDensity: 0.15 }),
      makeStem({ speciesId: 'pine', x: 44, z: 32, groundY: highGround, heightM: 20, crownBaseM: 8, crownRadiusM: 3, crownBulkDensity: 0.15 }),
    ]
    const ground = sampleGround(terrain, GRID)
    const occ = voxeliseOccupancy(makeVegSet(stems, [sp]), ground, GRID)
    const layout = buildLayout(occ.mask)

    const runAt = (i: number, j: number): [number, number] => {
      const h = layout.columnHeader[j * GRID.nxy + i] as number
      return [h & 0xff, (h >>> 8) & 0xff]
    }
    // Both stems sit at the same height above their own ground, so their runs must coincide
    // in k even though they are ~12 m apart in world Y. That is the whole point of the axis.
    expect(runAt(10, 16)).toEqual(runAt(22, 16))
  })

  it('reports the ground step a stencil must correct for', () => {
    const ground = sampleGround(planarTerrain(100, 0.5), GRID)
    expect(groundStepM(ground, GRID, 10, 10, 1, 0)).toBeCloseTo(0.5 * GRID.cellM, 4)
    expect(groundStepM(ground, GRID, 10, 10, 0, 1)).toBeCloseTo(0, 6)
    // Off-grid neighbour: no step rather than a wrapped one.
    expect(groundStepM(ground, GRID, GRID.nxy - 1, 0, 1, 0)).toBe(0)
  })

  it('counts mass clipped above the grid instead of concentrating it below', () => {
    const tall = makeStem({
      speciesId: 'pine',
      x: 32,
      z: 32,
      groundY: 0,
      heightM: 80, // grid top is 32 * 2 = 64 m
      crownBaseM: 20,
      crownRadiusM: 4,
      crownBulkDensity: 0.15,
    })
    const veg = makeVegSet([tall], [sp])
    const ground = sampleGround(planarTerrain(0), GRID)
    const occ = voxeliseOccupancy(veg, ground, GRID)
    expect(occ.clippedStems).toBe(1)
    const layout = buildLayout(occ.mask)
    const fields = voxeliseFields(veg, occ, layout)
    expect(fields.clippedMassKg).toBeGreaterThan(0)
    expect(fields.depositedMassKg + fields.clippedMassKg).toBeCloseTo(occ.stemFoliageMassKg, 6)
  })

  it('counts mass hanging over the domain edge as clipped, not redistributed', () => {
    const edge = makeStem({
      speciesId: 'pine',
      x: 1,
      z: 32,
      groundY: 0,
      heightM: 24,
      crownBaseM: 8,
      crownRadiusM: 6,
      crownBulkDensity: 0.15,
    })
    const veg = makeVegSet([edge], [sp])
    const ground = sampleGround(planarTerrain(0), GRID)
    const occ = voxeliseOccupancy(veg, ground, GRID)
    const fields = voxeliseFields(veg, occ, buildLayout(occ.mask))
    expect(fields.clippedMassKg).toBeGreaterThan(0)
    expect(fields.depositedMassKg + fields.clippedMassKg).toBeCloseTo(occ.stemFoliageMassKg, 6)
    // Peak bulk density must not exceed what an unclipped crown of the same stem would reach.
    const interior = makeStem({ ...toSpec(edge), x: 32 })
    const veg2 = makeVegSet([interior], [sp])
    const occ2 = voxeliseOccupancy(veg2, ground, GRID)
    const f2 = voxeliseFields(veg2, occ2, buildLayout(occ2.mask))
    expect(Math.max(...fields.dryDensity)).toBeLessThanOrEqual(Math.max(...f2.dryDensity) * 1.001)
  })

  it('skips degenerate crowns rather than dividing by zero', () => {
    const grass = makeStem({
      speciesId: 'grass',
      x: 10,
      z: 10,
      groundY: 0,
      heightM: 0.5,
      crownBaseM: 0.5,
      crownRadiusM: 0.4,
      crownBulkDensity: 1,
    })
    const gsp = testSpecies('grass', 'grass')
    const veg = makeVegSet([grass], [gsp])
    const { occupancy, fields } = voxeliseVegetation(veg, planarTerrain(0), GRID)
    expect(occupancy.skippedStems).toBe(1)
    expect(occupancy.mask.count()).toBe(0)
    expect(fields.depositedMassKg).toBe(0)
  })

  it('is deterministic', () => {
    const veg = makeVegSet([centreStem], [sp])
    const a = voxeliseVegetation(veg, planarTerrain(0), GRID)
    const b = voxeliseVegetation(veg, planarTerrain(0), GRID)
    expect(Array.from(a.fields.dryDensity)).toEqual(Array.from(b.fields.dryDensity))
    expect(Array.from(a.layout.columnHeader)).toEqual(Array.from(b.layout.columnHeader))
  })
})

/** Re-derive a `StemSpec` from a `Stem` so a test can vary one field. */
function toSpec(s: ReturnType<typeof makeStem>) {
  return {
    speciesId: s.speciesId,
    x: s.x as number,
    z: s.z as number,
    groundY: s.groundY as number,
    heightM: s.heightM as number,
    crownBaseM: s.crownBaseM as number,
    crownRadiusM: s.crownRadiusM as number,
    crownBulkDensity: s.crownBulkDensity as number,
  }
}
