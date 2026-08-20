/**
 * Hand-built vegetation and terrain for the WP 3.1 unit tests.
 *
 * These are fixtures, not mocks of a sibling: `IVegetationSet` and `ITerrainField.heightAt`
 * are M1 contracts that already exist, and the point of building tiny ones here is to make
 * the voxelisation assertions arithmetic rather than statistical.
 */

import type { IVegetationSet, SpeciesDef, Stem, WorldConfig } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { kgm2, kgm3, m, moistureFraction, rad } from '@contracts/units'
import type { TerrainHeights } from '@sim/canopy/storage/voxelise.ts'

export const testSpecies = (
  id: string,
  form: SpeciesDef['form'],
  bark: SpeciesDef['bark'] = 'furrowed',
): SpeciesDef => ({
  id,
  commonName: id,
  scientificName: id,
  biomes: ['western-us-conifer'],
  form,
  heightM: [m(10), m(30)],
  dbhM: [m(0.2), m(0.6)],
  crownBaseFraction: [0.2, 0.4],
  crownBulkDensity: [kgm3(0.1), kgm3(0.2)],
  crownWidthFraction: 0.3,
  foliarMoisture: [moistureFraction(1), moistureFraction(1.2)],
  bark,
  firebrandSource: false,
  litterLoad: kgm2(0.5),
  surfaceFuelModel: 'TL8',
})

export interface StemSpec {
  readonly speciesId: string
  readonly x: number
  readonly z: number
  readonly groundY: number
  readonly heightM: number
  readonly crownBaseM: number
  readonly crownRadiusM: number
  readonly crownBulkDensity: number
  readonly foliarMoisture?: number
}

export const makeStem = (s: StemSpec): Stem => ({
  speciesId: s.speciesId,
  x: m(s.x),
  z: m(s.z),
  groundY: m(s.groundY),
  heightM: m(s.heightM),
  dbhM: m(0.3),
  crownBaseM: m(s.crownBaseM),
  crownRadiusM: m(s.crownRadiusM),
  crownBulkDensity: kgm3(s.crownBulkDensity),
  foliarMoisture: moistureFraction(s.foliarMoisture ?? 1.0),
  age: 0.5,
  seed: 1,
  rotationY: rad(0),
  hasLadderFuels: false,
})

/** Minimal `IVegetationSet`. `stemsInAabb` is a linear scan — 30 stems, not 30 000. */
export function makeVegSet(stems: readonly Stem[], species: readonly SpeciesDef[]): IVegetationSet {
  return {
    config: {} as WorldConfig,
    stems,
    species: new Map(species.map((s) => [s.id, s])),
    measuredDensityPerHa: 0,
    measuredBasalAreaM2PerHa: 0,
    stemsInAabb: (minX, minZ, maxX, maxZ) =>
      stems.filter((s) => s.x >= minX && s.x <= maxX && s.z >= minZ && s.z <= maxZ),
  }
}

/** Terrain plane `y = base + slope · x`. Slope 0 gives the flat case. */
export const planarTerrain = (base: number, slopePerM = 0): TerrainHeights => ({
  heightAt: (x: Metres) => m(base + slopePerM * x),
})
