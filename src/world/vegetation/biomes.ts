/**
 * The five biomes (§0.2 locked decision), plus the placement-side tables that `BiomeParams`
 * has no room for.
 *
 * `BiomeParams` is frozen and deliberately minimal, so everything this package needs beyond
 * it lives in a parallel record keyed by `BiomeId`. That is the contract-safe way to add
 * fields: nothing here is imported by a sibling, and the contract stays untouched (§90.1
 * rule 2).
 *
 * **The site-response numbers below are engineering estimates and are firewalled from the
 * physics.** They decide *where* stems go and how vigorous the site is; they never appear in
 * a crown base height, a bulk density or a moisture. See `VEGETATION_PLACEMENT` in
 * provenance.ts for the recorded §0.7.3 decision.
 */

import type { BiomeId, BiomeParams, TerrainParams, VegetationParams } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { degToRad, m } from '@contracts/units'
import { speciesForBiome } from './species.ts'

// ---------------------------------------------------------------------------
// Extra per-biome tables (not expressible in the frozen BiomeParams)
// ---------------------------------------------------------------------------

/**
 * How stem density responds to terrain. All weights are multiplicative log-space nudges
 * applied to a base intensity that is then renormalised to mean 1 over the domain, so no
 * combination of these can change the *requested* stems per hectare — only its distribution.
 * That renormalisation is what makes the 5 % density acceptance criterion hold regardless of
 * how aggressive these numbers are.
 */
export interface BiomeSiteResponse {
  /** Density multiplier at 100 % slope (45°) relative to flat. < 1 means steep ground is barer. */
  readonly slopeResponse: number
  /**
   * Density multiplier on the cool, moist aspect (north-facing in the northern hemisphere,
   * south-facing in the southern) relative to the hot aspect. > 1 in every biome here:
   * shaded slopes carry denser, moister vegetation. Scaled by latitude — the effect vanishes
   * at the equator, where the sun is overhead.
   */
  readonly coolAspectResponse: number
  /** Density multiplier in a valley bottom (strongly negative TPI) relative to a mid-slope. */
  readonly valleyResponse: number
  /** Density multiplier on an exposed ridge crest (strongly positive TPI). */
  readonly ridgeResponse: number
  /** Elevation of peak density, relative to the domain's own elevation range (0 = lowest, 1 = highest). */
  readonly elevationOptimum: number
  /** Width of the elevation response, in the same normalised units. Large = nearly indifferent. */
  readonly elevationWidth: number
}

/**
 * Ladder-fuel test configuration. `Stem.hasLadderFuels` drives torching likelihood at M3, so
 * unlike the rest of this file it *is* a fire-behaviour quantity — which is exactly why it is
 * computed from real vertical geometry (crown base minus the top of the tallest stratum
 * beneath it) rather than assigned.
 */
export interface BiomeLadderFuelConfig {
  /**
   * Vertical gap, in metres, at or below which surface fire is taken to bridge into the crown.
   *
   * ESTIMATE — no obtainable source. §30 §7.1 names Cruz's fuel-strata-gap formulation as the
   * calibration target for biomes outside the Van Wagner envelope; see the blocking open
   * question on `VEGETATION_LADDER_FUEL` in provenance.ts. Biome-specific because the bridging
   * stratum differs: a 0.4 m fescue sward under ponderosa is a much weaker bridge than a 4 m
   * gorse thicket, and the threshold absorbs that until the real criterion lands.
   */
  readonly gapThresholdM: Metres
  /** Understory cover fraction below which the understory is too sparse to bridge at all. */
  readonly minUnderstoryCover: number
}

export interface BiomeExtras {
  readonly siteResponse: BiomeSiteResponse
  readonly ladderFuel: BiomeLadderFuelConfig
  /**
   * Minimum stem separation as a fraction of the mean nearest-neighbour distance of a Poisson
   * process at the local intensity (which is 0.5·λ^(-1/2)). Below ~1.1 the pattern is close to
   * Poisson; above ~1.6 dart-throwing starts failing to reach the target count. This is the
   * Poisson-disc radius that turns "random" into "a stand".
   */
  readonly separationFactor: number
}

/**
 * Per-species site preference, used to shift the species mix across the landscape. Each value
 * is a log-odds weight per unit of the (already normalised, roughly [-1, 1]) site variable.
 *
 * ENGINEERING ESTIMATES, chosen for recognisable landscape structure: Douglas fir into the
 * cool moist draws and ponderosa onto the dry ridges is the textbook western-US gradient;
 * ash and beech into damp valley bottoms, birch onto poor exposed ground, gorse and heather
 * onto thin dry acidic soils is the textbook British one. Species not listed are indifferent.
 */
export interface SpeciesSiteAffinity {
  /** Positive = prefers moist sites (cool aspect, valley bottom). */
  readonly moisture: number
  /** Positive = prefers higher ground within the domain. */
  readonly elevation: number
  /** Positive = tolerates or prefers steep ground. */
  readonly slope: number
}

export const SPECIES_SITE_AFFINITY: Readonly<Record<string, SpeciesSiteAffinity>> = {
  'pinus-ponderosa': { moisture: -0.8, elevation: -0.2, slope: 0.2 },
  'pseudotsuga-menziesii': { moisture: 1.0, elevation: 0.4, slope: -0.1 },
  'quercus-gambelii': { moisture: -0.2, elevation: -0.3, slope: 0.4 },
  'quercus-macrocarpa': { moisture: 0.6, elevation: -0.2, slope: -0.3 },
  'adenostoma-fasciculatum': { moisture: -0.9, elevation: 0.0, slope: 0.5 },
  'arctostaphylos-glandulosa': { moisture: 0.5, elevation: 0.3, slope: 0.0 },
  'ceanothus-megacarpus': { moisture: 0.3, elevation: -0.1, slope: -0.2 },
  'eucalyptus-obliqua': { moisture: 0.7, elevation: 0.2, slope: -0.2 },
  'eucalyptus-marginata': { moisture: -0.5, elevation: -0.1, slope: 0.3 },
  'eucalyptus-viminalis': { moisture: 0.9, elevation: -0.3, slope: -0.4 },
  'quercus-robur': { moisture: 0.2, elevation: -0.2, slope: -0.2 },
  'fraxinus-excelsior': { moisture: 0.9, elevation: -0.4, slope: -0.3 },
  'fagus-sylvatica': { moisture: 0.1, elevation: 0.1, slope: 0.2 },
  'betula-pendula': { moisture: -0.6, elevation: 0.5, slope: 0.3 },
  'calluna-vulgaris': { moisture: -0.7, elevation: 0.8, slope: 0.2 },
  'ulex-europaeus': { moisture: -0.8, elevation: 0.2, slope: 0.5 },
}

export const NEUTRAL_AFFINITY: SpeciesSiteAffinity = { moisture: 0, elevation: 0, slope: 0 }

// ---------------------------------------------------------------------------
// Biome definitions
// ---------------------------------------------------------------------------

const WESTERN_US_CONIFER_VEG: VegetationParams = {
  // A dry, frequently-burned ponderosa/Douglas fir stand. Historical open ponderosa forest
  // ran 50–150 stems/ha; a century of fire exclusion took it to several hundred with a dense
  // fir understorey, which is the modern crown-fire-prone condition this biome represents.
  stemDensityPerHa: 350,
  clustering: 0.35,
  maturity: 0.6,
  understoryCover: 0.35,
  speciesMix: {
    'pinus-ponderosa': 0.45,
    'pseudotsuga-menziesii': 0.4,
    'quercus-gambelii': 0.15,
    'festuca-arizonica': 1.0, // cover species; weighted separately from the stem mix
  },
  drynessPlaceholder: 0.65,
}

const GRASSLAND_SAVANNA_VEG: VegetationParams = {
  // Savanna is defined by its tree density, not by its grass: scattered open-grown trees over
  // continuous grass. 25 stems/ha gives ~20 m mean spacing, which is a savanna rather than a
  // woodland, and leaves the grass layer continuous enough to carry fire between crowns.
  stemDensityPerHa: 25,
  clustering: 0.55,
  maturity: 0.7,
  understoryCover: 0.92,
  speciesMix: {
    'quercus-macrocarpa': 1.0,
    'andropogon-gerardii': 0.6,
    'schizachyrium-scoparium': 0.4,
  },
  drynessPlaceholder: 0.7,
}

const CHAPARRAL_VEG: VegetationParams = {
  // Mature chaparral is a CLOSED shrub canopy, and that closure is the structural premise of
  // §60 §7.2.3's single-crowning-layer treatment — a gappy chaparral is not chaparral.
  //
  // Field stem counts for chamise run to 10 000–30 000 genets per hectare, which is not
  // renderable at 1 km² and is not what a `Stem` means here: one stem is a shrub CLUMP of
  // roughly one crown width. 2200/ha gives ~2.1 m mean spacing against the 2–4 m crown widths
  // of §60 §7.2.3, which closes the canopy and lands the emergent stand-level bulk density
  // inside that section's cited 1.0–3.5 kg m⁻³ band. Below about 1000/ha it does not, and the
  // stand stops behaving as one layer.
  stemDensityPerHa: 2200,
  clustering: 0.45,
  maturity: 0.75,
  understoryCover: 0.1,
  speciesMix: {
    'adenostoma-fasciculatum': 0.55,
    'arctostaphylos-glandulosa': 0.25,
    'ceanothus-megacarpus': 0.2,
  },
  drynessPlaceholder: 0.85,
}

const EUCALYPT_VEG: VegetationParams = {
  stemDensityPerHa: 250,
  clustering: 0.3,
  maturity: 0.65,
  // The near-surface layer is the term Vesta is most sensitive to (§60 §7.1.2: doubling H_ns
  // raises the wind-driven term 55 %), so it is deliberately high here.
  understoryCover: 0.55,
  speciesMix: {
    'eucalyptus-obliqua': 0.45,
    'eucalyptus-marginata': 0.33,
    'eucalyptus-viminalis': 0.22,
    'pteridium-esculentum': 1.0,
  },
  drynessPlaceholder: 0.8,
}

const UK_VEG: VegetationParams = {
  // Domain-average, not woodland-average. §60 §7.3.3: a 1 km² British domain is a mosaic of
  // 10–50 fields with woodland blocks, hedgerows and open moor between them, so the mean stem
  // density is low and the clustering is high — the trees are in blocks and lines, not spread.
  stemDensityPerHa: 130,
  clustering: 0.78,
  maturity: 0.6,
  understoryCover: 0.85,
  speciesMix: {
    'quercus-robur': 0.26,
    'fraxinus-excelsior': 0.18,
    'fagus-sylvatica': 0.18,
    'betula-pendula': 0.13,
    'calluna-vulgaris': 0.15,
    'ulex-europaeus': 0.1,
    'pteridium-aquilinum': 0.35,
    'molinia-caerulea': 0.25,
    'lolium-perenne': 0.4,
  },
  drynessPlaceholder: 0.4,
}

const WESTERN_US_CONIFER_TERRAIN: TerrainParams = {
  relief: 0.7,
  baseElevationM: m(2000), // Southwestern ponderosa belt.
  drainageStrength: 0.6,
  ridgeBearing: degToRad(340),
  hydraulicErosionIterations: 60,
}

const GRASSLAND_SAVANNA_TERRAIN: TerrainParams = {
  relief: 0.15,
  baseElevationM: m(400),
  drainageStrength: 0.3,
  ridgeBearing: degToRad(90),
  hydraulicErosionIterations: 20,
}

const CHAPARRAL_TERRAIN: TerrainParams = {
  relief: 0.65,
  baseElevationM: m(600),
  // Steep, sharply dissected coastal ranges: the canyon channelling that makes Santa Ana runs
  // what they are.
  drainageStrength: 0.75,
  ridgeBearing: degToRad(300),
  hydraulicErosionIterations: 50,
}

const EUCALYPT_TERRAIN: TerrainParams = {
  relief: 0.5,
  baseElevationM: m(250),
  drainageStrength: 0.55,
  ridgeBearing: degToRad(20),
  hydraulicErosionIterations: 40,
}

const UK_TERRAIN: TerrainParams = {
  relief: 0.25,
  baseElevationM: m(180),
  drainageStrength: 0.45,
  ridgeBearing: degToRad(60),
  hydraulicErosionIterations: 30,
}

export const BIOMES: Readonly<Record<BiomeId, BiomeParams>> = {
  'western-us-conifer': {
    id: 'western-us-conifer',
    displayName: 'Western US conifer',
    species: speciesForBiome('western-us-conifer'),
    defaultVegetation: WESTERN_US_CONIFER_VEG,
    defaultTerrain: WESTERN_US_CONIFER_TERRAIN,
    groundMaterials: ['needle-duff', 'granite-scree', 'dry-bunchgrass', 'bare-mineral-soil'],
  },
  'grassland-savanna': {
    id: 'grassland-savanna',
    displayName: 'Grassland & oak savanna',
    species: speciesForBiome('grassland-savanna'),
    defaultVegetation: GRASSLAND_SAVANNA_VEG,
    defaultTerrain: GRASSLAND_SAVANNA_TERRAIN,
    groundMaterials: ['tallgrass-thatch', 'cured-grass', 'dark-prairie-soil', 'gravel'],
  },
  'mediterranean-chaparral': {
    id: 'mediterranean-chaparral',
    displayName: 'Mediterranean chaparral',
    species: speciesForBiome('mediterranean-chaparral'),
    defaultVegetation: CHAPARRAL_VEG,
    defaultTerrain: CHAPARRAL_TERRAIN,
    groundMaterials: ['shrub-litter', 'weathered-sandstone', 'bare-clay', 'talus'],
  },
  'eucalypt-dry-forest': {
    id: 'eucalypt-dry-forest',
    displayName: 'Dry eucalypt forest',
    species: speciesForBiome('eucalypt-dry-forest'),
    defaultVegetation: EUCALYPT_VEG,
    defaultTerrain: EUCALYPT_TERRAIN,
    groundMaterials: ['eucalypt-leaf-bark-litter', 'lateritic-gravel', 'bracken-mat', 'ironstone'],
  },
  'uk-mixed-field-forest': {
    id: 'uk-mixed-field-forest',
    displayName: 'UK mixed field & forest',
    species: speciesForBiome('uk-mixed-field-forest'),
    defaultVegetation: UK_VEG,
    defaultTerrain: UK_TERRAIN,
    groundMaterials: ['improved-pasture', 'broadleaf-leaf-litter', 'moor-peat', 'chalk-soil'],
  },
}

export const BIOME_EXTRAS: Readonly<Record<BiomeId, BiomeExtras>> = {
  'western-us-conifer': {
    siteResponse: {
      slopeResponse: 0.6,
      coolAspectResponse: 1.9, // The strongest aspect contrast of the five: hot dry SW slopes go nearly bare.
      valleyResponse: 1.5,
      ridgeResponse: 0.7,
      elevationOptimum: 0.55,
      elevationWidth: 0.6,
    },
    // The bridging stratum is a 0.2–0.6 m bunchgrass sward plus Gambel oak. Grass alone barely
    // bridges; the threshold reflects a mixed stratum.
    ladderFuel: { gapThresholdM: m(2.0), minUnderstoryCover: 0.15 },
    separationFactor: 1.25,
  },
  'grassland-savanna': {
    siteResponse: {
      slopeResponse: 0.8,
      coolAspectResponse: 1.3,
      valleyResponse: 2.2, // Savanna trees concentrate hard along drainage lines. Very visible, and real.
      ridgeResponse: 0.5,
      elevationOptimum: 0.35,
      elevationWidth: 0.7,
    },
    ladderFuel: { gapThresholdM: m(1.5), minUnderstoryCover: 0.3 },
    separationFactor: 1.15,
  },
  'mediterranean-chaparral': {
    siteResponse: {
      slopeResponse: 0.9, // Chaparral holds steep ground better than anything else here.
      coolAspectResponse: 1.35,
      valleyResponse: 1.3,
      ridgeResponse: 0.85,
      elevationOptimum: 0.5,
      elevationWidth: 0.9,
    },
    // §30 §7.1: chaparral has "no meaningful CBH because fuel is vertically continuous". The
    // ladder test is therefore near-vacuously true, which is the physically correct answer.
    ladderFuel: { gapThresholdM: m(0.75), minUnderstoryCover: 0.0 },
    separationFactor: 1.3,
  },
  'eucalypt-dry-forest': {
    siteResponse: {
      slopeResponse: 0.75,
      // Southern hemisphere: the cool aspect is south-facing. Handled by latitude sign in
      // site.ts, not by flipping this number.
      coolAspectResponse: 1.6,
      valleyResponse: 1.7,
      ridgeResponse: 0.7,
      elevationOptimum: 0.45,
      elevationWidth: 0.7,
    },
    // Vesta's near-surface stratum, 5–40 cm (§60 §7.1.2), sits under a 10–25 m clear bole. The
    // bridge that matters in eucalypt is bark up the trunk, not a continuous fuel column — so
    // the geometric threshold is small and the real mechanism arrives with WP 3.6.
    ladderFuel: { gapThresholdM: m(1.5), minUnderstoryCover: 0.2 },
    separationFactor: 1.2,
  },
  'uk-mixed-field-forest': {
    siteResponse: {
      slopeResponse: 1.4, // Inverted: the flat ground is farmed. Trees survive on the banks and slopes.
      coolAspectResponse: 1.15,
      valleyResponse: 1.4,
      ridgeResponse: 0.8,
      elevationOptimum: 0.4,
      elevationWidth: 0.8,
    },
    // Gorse and mature heather are tall enough to reach a low broadleaf crown directly, hence
    // the larger threshold. §60 §7.3.2: gorse "carries fire in the elevated dead layer
    // independently of surface fuels" and is the UK crown-fire analogue.
    ladderFuel: { gapThresholdM: m(2.5), minUnderstoryCover: 0.2 },
    separationFactor: 1.2,
  },
}

export function biomeParams(id: BiomeId): BiomeParams {
  return BIOMES[id]
}

export function biomeExtras(id: BiomeId): BiomeExtras {
  return BIOME_EXTRAS[id]
}
