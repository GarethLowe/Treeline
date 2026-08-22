/**
 * World generation contracts: terrain, biomes, vegetation, tree geometry.
 *
 * FROZEN for M1. Do not edit during fan-out.
 *
 * The load-bearing idea in this file: **vegetation geometry is derived from physical fuel
 * parameters, not authored alongside them.** A tree's crown base height is not an art
 * decision that happens to resemble the number the crown-fire model uses — it IS that
 * number, and the mesh is built from it. Anything else lets the picture and the physics
 * drift apart, which is precisely what this project is trying to avoid.
 */

import type {
  KgPerCubicMetre,
  KgPerSquareMetre,
  Metres,
  MoistureFraction,
  Radians,
  SlopeTangent,
} from './units.ts'

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** 1 km x 1 km. Surface 0.5 m (2048^2), canopy voxels 2 m (512x512x64). Spec §0.2. */
export const DOMAIN_SIZE_M = 1024
export const SURFACE_CELLS = 2048
export const SURFACE_CELL_M = 0.5
export const CANOPY_CELLS_XY = 512
export const CANOPY_CELLS_Z = 64
export const CANOPY_CELL_M = 2

export interface WorldConfig {
  /** Everything procedural derives from this. Same seed + same config = same world. */
  readonly seed: number
  readonly biome: BiomeId
  readonly terrain: TerrainParams
  readonly vegetation: VegetationParams
  /** Latitude/longitude drive solar position and therefore fuel drying. */
  readonly site: { readonly latitudeDeg: number; readonly longitudeDeg: number; readonly elevationM: Metres }
}

// ---------------------------------------------------------------------------
// Terrain (WP 1.2)
// ---------------------------------------------------------------------------

export interface TerrainParams {
  /** 0 = near-flat, 1 = mountainous. Drives amplitude and ridge sharpness. */
  readonly relief: number
  /** Mean elevation of the domain. */
  readonly baseElevationM: Metres
  /** Strength of drainage/valley carving. Slope is a first-order term in spread, and
   *  canyon channelling is where the interesting fire behaviour lives. */
  readonly drainageStrength: number
  /** Dominant ridge orientation, for building deliberate lee/windward test cases. */
  readonly ridgeBearing: Radians
  readonly hydraulicErosionIterations: number
}

export interface ITerrainField {
  readonly params: TerrainParams
  /** Metres above sea level, bilinear between samples. World coords in [0, DOMAIN_SIZE_M]. */
  heightAt(x: Metres, z: Metres): Metres
  /** Unit surface normal. */
  normalAt(x: Metres, z: Metres): readonly [number, number, number]
  /** Slope as a tangent — what the spread model consumes directly. */
  slopeAt(x: Metres, z: Metres): SlopeTangent
  /** Downslope azimuth, radians clockwise from north. */
  aspectAt(x: Metres, z: Metres): Radians
  /** R32F height, RG16F slope+aspect. Must agree with the CPU queries within tolerance. */
  readonly heightTexture: GPUTexture
  readonly slopeAspectTexture: GPUTexture
  readonly minElevationM: Metres
  readonly maxElevationM: Metres
}

// ---------------------------------------------------------------------------
// Biomes & species (WP 1.3)
// ---------------------------------------------------------------------------

export type BiomeId =
  | 'western-us-conifer'
  | 'grassland-savanna'
  | 'mediterranean-chaparral'
  | 'eucalypt-dry-forest'
  | 'uk-mixed-field-forest'

export const BIOME_IDS: readonly BiomeId[] = [
  'western-us-conifer',
  'grassland-savanna',
  'mediterranean-chaparral',
  'eucalypt-dry-forest',
  'uk-mixed-field-forest',
]

/**
 * Species parameters. The fuel figures here are the SAME values the fire model consumes;
 * the mesh generator reads them to build geometry. They are not decoration.
 */
/** Growth habit. `grass` and `fern` are ground cover, never a stand's litter model. */
export type SpeciesForm = 'conifer' | 'broadleaf' | 'shrub' | 'grass' | 'fern'

export interface SpeciesDef {
  readonly id: string
  readonly commonName: string
  readonly scientificName: string
  readonly biomes: readonly BiomeId[]
  readonly form: SpeciesForm

  /** Mature height range. Individuals are sampled within it by age. */
  readonly heightM: readonly [Metres, Metres]
  /** Diameter at breast height, for allometry. */
  readonly dbhM: readonly [Metres, Metres]
  /**
   * Crown base height as a FRACTION of total height. Van Wagner's crown-initiation
   * threshold is dominated by this, so getting it from geometry rather than into geometry
   * would be backwards.
   */
  readonly crownBaseFraction: readonly [number, number]
  /** Crown bulk density. The 0.05 kg/m3 threshold separates passive from active crowning. */
  readonly crownBulkDensity: readonly [KgPerCubicMetre, KgPerCubicMetre]
  /** Crown width as a fraction of height. */
  readonly crownWidthFraction: number
  /** Foliar moisture content, live. Feeds crown initiation directly. */
  readonly foliarMoisture: readonly [MoistureFraction, MoistureFraction]

  /**
   * Bark character. Not cosmetic: decorticating eucalypt ribbon bark is the single largest
   * firebrand source known and is why eucalypt spotting reaches kilometres.
   */
  readonly bark: 'thick-plated' | 'furrowed' | 'smooth' | 'papery' | 'decorticating-ribbon' | 'fibrous'
  /** Whether this species sheds firebrands significantly. */
  readonly firebrandSource: boolean

  /** Surface fuel this species contributes beneath itself (litter). */
  readonly litterLoad: KgPerSquareMetre
  /** Fuel model code the surface solver uses under this species, e.g. 'TL8'. */
  readonly surfaceFuelModel: string
}

export interface VegetationParams {
  /** Stems per hectare, before terrain modulation. */
  readonly stemDensityPerHa: number
  /** 0 = evenly spaced, 1 = strongly clumped. */
  readonly clustering: number
  /** Fraction of mature stems; drives the age distribution. */
  readonly maturity: number
  /** Grass/understory cover fraction. */
  readonly understoryCover: number
  /** Species mix, keyed by SpeciesDef.id. Values are relative weights. */
  readonly speciesMix: Readonly<Record<string, number>>
  /**
   * Master dryness 0..1. NOTE: this is an M1 placeholder for world-gen appearance only.
   * At M5 it is replaced by physical fuel moisture state driven by the weather model, per
   * spec §50. Do not build fire behaviour on this field.
   */
  readonly drynessPlaceholder: number
}

export interface BiomeParams {
  readonly id: BiomeId
  readonly displayName: string
  readonly species: readonly SpeciesDef[]
  readonly defaultVegetation: VegetationParams
  readonly defaultTerrain: TerrainParams
  /** Ground material identifiers for the splat system, by slope/aspect band. */
  readonly groundMaterials: readonly string[]
}

// ---------------------------------------------------------------------------
// Vegetation instances (WP 1.3 output)
// ---------------------------------------------------------------------------

/** One plant. Physical parameters first; geometry is derived from them. */
export interface Stem {
  readonly speciesId: string
  readonly x: Metres
  readonly z: Metres
  /** Terrain height at (x,z), cached. */
  readonly groundY: Metres
  readonly heightM: Metres
  readonly dbhM: Metres
  /** Absolute height above ground of the lowest live crown foliage. */
  readonly crownBaseM: Metres
  readonly crownRadiusM: Metres
  readonly crownBulkDensity: KgPerCubicMetre
  readonly foliarMoisture: MoistureFraction
  /** 0..1, drives geometry variation and litter accumulation. */
  readonly age: number
  /** Per-stem RNG stream, so a stem's mesh is reproducible independent of iteration order. */
  readonly seed: number
  readonly rotationY: Radians
  /** Whether a ladder-fuel path exists from surface to crown. Drives torching likelihood. */
  readonly hasLadderFuels: boolean
}

export interface IVegetationSet {
  readonly config: WorldConfig
  readonly stems: readonly Stem[]
  readonly species: ReadonlyMap<string, SpeciesDef>
  /** Stems per hectare, measured from the generated set. Acceptance: within 5% of requested. */
  readonly measuredDensityPerHa: number
  /** Basal area m2/ha, measured. Acceptance: within 5% of requested. */
  readonly measuredBasalAreaM2PerHa: number
  /** Spatial query for renderer culling and, later, the canopy voxeliser. */
  stemsInAabb(minX: Metres, minZ: Metres, maxX: Metres, maxZ: Metres): readonly Stem[]
}

// ---------------------------------------------------------------------------
// Tree geometry (WP 1.4)
// ---------------------------------------------------------------------------

export interface TreeLod {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array
  readonly indices: Uint32Array
  /** Which material slot each index range uses: bark, foliage, or ribbon bark. */
  readonly submeshes: readonly { readonly material: 'bark' | 'foliage' | 'ribbon'; readonly start: number; readonly count: number }[]
  readonly triangleCount: number
}

/**
 * A generated tree. `derived` is the acceptance mechanism for WP 1.4: the mesh's actual
 * measured crown base and foliar biomass must match the Stem's physical parameters within
 * 10%. If they diverge, the geometry has stopped being an expression of the fuel state.
 */
export interface TreeMesh {
  readonly speciesId: string
  readonly seed: number
  /** LOD 0 = full detail, increasing = cheaper. Last entry may be an impostor. */
  readonly lods: readonly TreeLod[]
  /** Octahedral impostor atlas for the far field, if baked. */
  readonly impostor?: { readonly texture: GPUTexture; readonly views: number }
  readonly derived: {
    /** Measured from the generated geometry, not copied from the Stem. */
    readonly crownBaseM: Metres
    readonly foliarBiomassKg: number
    readonly crownBulkDensity: KgPerCubicMetre
    readonly heightM: Metres
  }
}

export interface ITreeMeshSet {
  /** Meshes are cached by (species, quantised parameters), not one per stem. */
  get(stem: Stem): TreeMesh
  readonly uniqueMeshCount: number
  readonly totalTriangles: number
}
