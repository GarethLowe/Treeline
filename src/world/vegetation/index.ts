/**
 * WP 1.3 — biome definitions and seeded vegetation placement.
 *
 * Consumes `ITerrainField` (WP 1.2) and `BiomeParams`; provides `IVegetationSet`.
 *
 * ```ts
 * const veg = generateVegetation(worldConfig, terrainField)
 * const nearby = veg.stemsInAabb(m(100), m(100), m(200), m(200))
 * ```
 *
 * Until WP 1.2 lands, `makeStubTerrain` gives a deterministic analytic surface with the same
 * CPU query interface (§90.1 rule 4: stubs, never mocks of siblings).
 */

import type { BiomeId, ITerrainField, IVegetationSet, WorldConfig } from '@contracts/world'
import { DOMAIN_SIZE_M } from '@contracts/world'
import { biomeParams } from './biomes.ts'
import { placeStems } from './placement.ts'
import type { TerrainSampler } from '../../camera/terrainStub.ts'
import { VegetationSet } from './vegetationSet.ts'

export interface GenerateOptions {
  /**
   * Domain edge length. Defaults to `DOMAIN_SIZE_M` (1 km). Tests use a smaller square, since
   * a full 1 km chaparral stand is ~90 000 shrubs and the point of a unit test is not to
   * generate them.
   */
  readonly sizeM?: number
  /** Site-field cell size, metres. Defaults to 8 m — see site.ts for why it matters. */
  readonly siteCellM?: number
}

/**
 * Generate the vegetation set for a world.
 *
 * Deterministic in `(config.seed, config.biome, config.vegetation, config.terrain, terrain,
 * options)`. Same inputs, same stems, in the same order.
 */
export function generateVegetation(
  config: WorldConfig,
  terrain: TerrainSampler | ITerrainField,
  options: GenerateOptions = {},
): IVegetationSet & VegetationSet {
  const sizeM = options.sizeM ?? DOMAIN_SIZE_M
  const biome = biomeParams(config.biome)
  const placement = placeStems({
    seed: config.seed,
    biome: config.biome,
    vegetation: config.vegetation,
    terrain,
    species: biome.species,
    sizeM,
    latitudeDeg: config.site.latitudeDeg,
    ...(options.siteCellM === undefined ? {} : { siteCellM: options.siteCellM }),
  })
  return new VegetationSet(config, placement, biome.species, sizeM)
}

/** A ready-to-run `WorldConfig` on the biome's own defaults. */
export function defaultWorldConfig(seed: number, biome: BiomeId): WorldConfig {
  const b = biomeParams(biome)
  return {
    seed,
    biome,
    terrain: b.defaultTerrain,
    vegetation: b.defaultVegetation,
    site: DEFAULT_SITES[biome],
  }
}

/**
 * Representative sites. Latitude is load-bearing beyond solar position: its **sign** decides
 * which aspect is the cool, moist one, so the eucalypt biome's southern latitude is why its
 * dense vegetation sits on south-facing slopes and the other four biomes' sits on north-facing
 * ones. Getting that backwards would be invisible in a screenshot and wrong in every fire.
 */
export const DEFAULT_SITES: Readonly<Record<BiomeId, WorldConfig['site']>> = {
  // Mogollon Rim, Arizona — the ponderosa belt.
  'western-us-conifer': { latitudeDeg: 34.5, longitudeDeg: -111.3, elevationM: 2000 as WorldConfig['site']['elevationM'] },
  // Flint Hills, Kansas — tallgrass prairie and oak savanna.
  'grassland-savanna': { latitudeDeg: 38.4, longitudeDeg: -96.6, elevationM: 400 as WorldConfig['site']['elevationM'] },
  // Santa Monica Mountains, California — the Santa Ana corridor of §60 §7.2.
  'mediterranean-chaparral': { latitudeDeg: 34.1, longitudeDeg: -118.8, elevationM: 600 as WorldConfig['site']['elevationM'] },
  // Otway Ranges, Victoria — dry sclerophyll, and southern hemisphere.
  'eucalypt-dry-forest': { latitudeDeg: -38.6, longitudeDeg: 143.5, elevationM: 250 as WorldConfig['site']['elevationM'] },
  // Peak District, England — the Saddleworth Moor 2018 landscape of §60 §7.3.4.
  'uk-mixed-field-forest': { latitudeDeg: 53.5, longitudeDeg: -1.9, elevationM: 180 as WorldConfig['site']['elevationM'] },
}

export { BIOMES, BIOME_EXTRAS, biomeExtras, biomeParams, SPECIES_SITE_AFFINITY } from './biomes.ts'
export type { BiomeExtras, BiomeLadderFuelConfig, BiomeSiteResponse, SpeciesSiteAffinity } from './biomes.ts'
export { ALL_SPECIES, SPECIES_BY_ID, isStemForming, speciesById, speciesForBiome } from './species.ts'
export {
  ageFromQuantile,
  deriveStem,
  ELASTIC_SIMILARITY_EXPONENT,
  expectedBasalAreaM2,
  expectedGrowthPower,
  expectedMatureDbhSquared,
  expectedMatureHeight,
  growthFraction,
  matureDbh,
  matureHeight,
  sizeRank,
  stemDraws,
  stemHashSeed,
} from './allometry.ts'
export type { AllometryInputs, DerivedStem, QuadratureResolution } from './allometry.ts'
export { aspectCoolness, densityWeight, moistureIndex, SiteField, DEFAULT_SITE_CELL_M } from './site.ts'
export type { SiteConditions } from './site.ts'
export { PointGrid, StemGrid } from './spatialIndex.ts'
export { UnderstoryField } from './understory.ts'
export { deriveLadderFuel, exclusionRadius, placeStems } from './placement.ts'
export type { PlacementOptions, PlacementOutput } from './placement.ts'
export type { TerrainSampler } from '../../camera/terrainStub.ts'
export { VegetationSet, crownVolumeM3, predictBasalAreaM2PerHa } from './vegetationSet.ts'
export type { VegetationDiagnostics } from './vegetationSet.ts'
