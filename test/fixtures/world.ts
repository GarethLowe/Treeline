/**
 * The one shared world fixture. Replaces the nine per-package `stub*` modules that used to
 * ship in `src/` — deterministic species, stems and stands for tests that need a plausible
 * forest without standing up the real generator.
 */

import type {
  BiomeId,
  ITreeMeshSet,
  IVegetationSet,
  SpeciesDef,
  Stem,
  TreeLod,
  TreeMesh,
  WorldConfig,
} from '@contracts/world.ts'
import type { IMaterialSystem, MaterialDef } from '@contracts/render.ts'
import type { Metres } from '@contracts/units.ts'
import { defaultWorldConfig } from '@world/vegetation/index.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import { StubTerrain } from '../../src/camera/terrainStub.ts'
import { kgm2, kgm3, m, moistureFraction, rad } from '@contracts/units.ts'
import { Rng, hashString, mixSeed } from '@world/trees/rng.ts'
import type { FuelModel } from '@contracts/sim.ts'
import type { Seconds } from '@contracts/units.ts'
import { FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { flamingResidenceTime } from '@sim/rothermel/kernel.ts'

const sp = (d: {
  id: string
  commonName: string
  scientificName: string
  biomes: BiomeId[]
  form: SpeciesDef['form']
  heightM: [number, number]
  dbhM: [number, number]
  crownBaseFraction: [number, number]
  crownBulkDensity: [number, number]
  crownWidthFraction: number
  foliarMoisture: [number, number]
  bark: SpeciesDef['bark']
  firebrandSource: boolean
  litterLoad: number
  surfaceFuelModel: string
}): SpeciesDef => ({
  id: d.id,
  commonName: d.commonName,
  scientificName: d.scientificName,
  biomes: d.biomes,
  form: d.form,
  heightM: [m(d.heightM[0]), m(d.heightM[1])],
  dbhM: [m(d.dbhM[0]), m(d.dbhM[1])],
  crownBaseFraction: d.crownBaseFraction,
  crownBulkDensity: [kgm3(d.crownBulkDensity[0]), kgm3(d.crownBulkDensity[1])],
  crownWidthFraction: d.crownWidthFraction,
  foliarMoisture: [moistureFraction(d.foliarMoisture[0]), moistureFraction(d.foliarMoisture[1])],
  bark: d.bark,
  firebrandSource: d.firebrandSource,
  litterLoad: kgm2(d.litterLoad),
  surfaceFuelModel: d.surfaceFuelModel,
})

/**
 * Heights, crown diameters and crown base heights follow the spec §7.5 table; the ranges
 * around them are engineering spreads.
 *
 * Note on crown bulk density: the spec table quotes *peak* per-tree CBD, while
 * `Stem.crownBulkDensity` is the crown-volume average that Van Wagner's active-crowning
 * threshold compares against. For a Beta vertical profile the peak runs roughly 1.5-1.9x the
 * mean, so the means here sit below the table's peaks by about that factor. The chaparral
 * and Calluna/Ulex rows are fuel-bed bulk densities and are used directly.
 */
export const STUB_SPECIES: readonly SpeciesDef[] = [
  sp({
    id: 'pinus-ponderosa',
    commonName: 'Ponderosa pine',
    scientificName: 'Pinus ponderosa',
    biomes: ['western-us-conifer'],
    form: 'conifer',
    heightM: [12, 30],
    dbhM: [0.18, 0.75],
    crownBaseFraction: [0.24, 0.38],
    crownBulkDensity: [0.04, 0.075],
    crownWidthFraction: 0.3,
    foliarMoisture: [0.9, 1.4],
    bark: 'thick-plated',
    firebrandSource: false,
    litterLoad: 1.2,
    surfaceFuelModel: 'TL8',
  }),
  sp({
    id: 'pseudotsuga-menziesii',
    commonName: 'Douglas-fir',
    scientificName: 'Pseudotsuga menziesii',
    biomes: ['western-us-conifer'],
    form: 'conifer',
    heightM: [14, 34],
    dbhM: [0.2, 0.9],
    crownBaseFraction: [0.07, 0.16],
    crownBulkDensity: [0.07, 0.13],
    crownWidthFraction: 0.23,
    foliarMoisture: [1.0, 1.5],
    bark: 'furrowed',
    firebrandSource: false,
    litterLoad: 1.6,
    surfaceFuelModel: 'TL5',
  }),
  sp({
    id: 'quercus-douglasii',
    commonName: 'Blue oak',
    scientificName: 'Quercus douglasii',
    biomes: ['grassland-savanna'],
    form: 'broadleaf',
    heightM: [5, 12],
    dbhM: [0.15, 0.55],
    crownBaseFraction: [0.18, 0.34],
    crownBulkDensity: [0.03, 0.06],
    crownWidthFraction: 1.05,
    foliarMoisture: [0.8, 1.6],
    bark: 'furrowed',
    firebrandSource: false,
    litterLoad: 0.5,
    surfaceFuelModel: 'GR2',
  }),
  sp({
    id: 'adenostoma-fasciculatum',
    commonName: 'Chamise',
    scientificName: 'Adenostoma fasciculatum',
    biomes: ['mediterranean-chaparral'],
    form: 'shrub',
    heightM: [1.2, 3.2],
    dbhM: [0.02, 0.07],
    crownBaseFraction: [0.04, 0.12],
    crownBulkDensity: [1.2, 2.4],
    crownWidthFraction: 0.9,
    foliarMoisture: [0.5, 1.1],
    bark: 'fibrous',
    firebrandSource: false,
    litterLoad: 0.9,
    surfaceFuelModel: 'SH5',
  }),
  sp({
    id: 'ceanothus-megacarpus',
    commonName: 'Bigpod ceanothus',
    scientificName: 'Ceanothus megacarpus',
    biomes: ['mediterranean-chaparral'],
    form: 'shrub',
    heightM: [1.5, 3.5],
    dbhM: [0.02, 0.08],
    crownBaseFraction: [0.05, 0.15],
    crownBulkDensity: [1.0, 2.0],
    crownWidthFraction: 0.95,
    foliarMoisture: [0.6, 1.3],
    bark: 'smooth',
    firebrandSource: false,
    litterLoad: 0.7,
    surfaceFuelModel: 'SH7',
  }),
  sp({
    id: 'eucalyptus-obliqua',
    commonName: 'Messmate stringybark',
    scientificName: 'Eucalyptus obliqua',
    biomes: ['eucalypt-dry-forest'],
    form: 'broadleaf',
    heightM: [14, 34],
    dbhM: [0.2, 0.95],
    crownBaseFraction: [0.26, 0.42],
    crownBulkDensity: [0.045, 0.085],
    crownWidthFraction: 0.32,
    foliarMoisture: [1.0, 1.4],
    bark: 'fibrous',
    firebrandSource: true,
    litterLoad: 1.5,
    surfaceFuelModel: 'TU5',
  }),
  sp({
    id: 'eucalyptus-viminalis',
    commonName: 'Manna gum',
    scientificName: 'Eucalyptus viminalis',
    biomes: ['eucalypt-dry-forest'],
    form: 'broadleaf',
    heightM: [16, 38],
    dbhM: [0.22, 1.0],
    crownBaseFraction: [0.3, 0.46],
    crownBulkDensity: [0.04, 0.08],
    crownWidthFraction: 0.34,
    foliarMoisture: [1.0, 1.5],
    bark: 'decorticating-ribbon',
    firebrandSource: true,
    litterLoad: 1.4,
    surfaceFuelModel: 'TU5',
  }),
  sp({
    id: 'quercus-robur',
    commonName: 'English oak',
    scientificName: 'Quercus robur',
    biomes: ['uk-mixed-field-forest'],
    form: 'broadleaf',
    heightM: [10, 26],
    dbhM: [0.2, 1.1],
    crownBaseFraction: [0.14, 0.28],
    crownBulkDensity: [0.05, 0.095],
    crownWidthFraction: 0.6,
    foliarMoisture: [1.1, 2.0],
    bark: 'furrowed',
    firebrandSource: false,
    litterLoad: 1.1,
    surfaceFuelModel: 'TL6',
  }),
  sp({
    id: 'calluna-vulgaris',
    commonName: 'Heather',
    scientificName: 'Calluna vulgaris',
    biomes: ['uk-mixed-field-forest'],
    form: 'shrub',
    heightM: [0.2, 0.7],
    dbhM: [0.006, 0.02],
    crownBaseFraction: [0.03, 0.1],
    crownBulkDensity: [2.4, 4.5],
    crownWidthFraction: 1.25,
    foliarMoisture: [0.6, 1.2],
    bark: 'fibrous',
    firebrandSource: false,
    litterLoad: 0.6,
    surfaceFuelModel: 'UK-CV1',
  }),
  sp({
    id: 'ulex-europaeus',
    commonName: 'Gorse',
    scientificName: 'Ulex europaeus',
    biomes: ['uk-mixed-field-forest'],
    form: 'shrub',
    heightM: [0.9, 2.6],
    dbhM: [0.012, 0.05],
    crownBaseFraction: [0.04, 0.12],
    crownBulkDensity: [1.0, 2.1],
    crownWidthFraction: 0.9,
    foliarMoisture: [0.7, 1.5],
    bark: 'fibrous',
    firebrandSource: false,
    litterLoad: 0.5,
    surfaceFuelModel: 'UK-UE1',
  }),
  sp({
    id: 'pteridium-aquilinum',
    commonName: 'Bracken',
    scientificName: 'Pteridium aquilinum',
    biomes: ['uk-mixed-field-forest'],
    form: 'fern',
    heightM: [0.5, 1.8],
    dbhM: [0.004, 0.012],
    crownBaseFraction: [0.06, 0.2],
    crownBulkDensity: [0.8, 1.8],
    crownWidthFraction: 0.8,
    foliarMoisture: [1.2, 2.5],
    bark: 'smooth',
    firebrandSource: false,
    litterLoad: 0.4,
    surfaceFuelModel: 'UK-PA1',
  }),
  sp({
    id: 'andropogon-gerardii',
    commonName: 'Big bluestem',
    scientificName: 'Andropogon gerardii',
    biomes: ['grassland-savanna'],
    form: 'grass',
    heightM: [0.6, 2.0],
    dbhM: [0.004, 0.014],
    crownBaseFraction: [0.02, 0.08],
    crownBulkDensity: [0.9, 2.2],
    crownWidthFraction: 0.45,
    foliarMoisture: [0.3, 1.8],
    bark: 'smooth',
    firebrandSource: false,
    litterLoad: 0.3,
    surfaceFuelModel: 'GR4',
  }),
]

export const STUB_SPECIES_BY_ID: ReadonlyMap<string, SpeciesDef> = new Map(
  STUB_SPECIES.map((s) => [s.id, s]),
)

export function stubSpeciesForBiome(biome: BiomeId): readonly SpeciesDef[] {
  return STUB_SPECIES.filter((s) => s.biomes.includes(biome))
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Generate one stem. Parameters are functions of `age` with multiplicative lognormal noise.
 *
 * `noiseScale` exists so the integrator can measure a real sensitivity rather than guess at
 * one. It is the single biggest driver of `TreeMeshSet.uniqueMeshCount`: at `noiseScale = 0`
 * every per-stem parameter is a deterministic function of age, so the whole population lies
 * on a one-dimensional curve through the cache's key space and collapses into a few dozen
 * buckets per species. At `noiseScale = 1` the parameters scatter independently around that
 * curve and the population fills a three-dimensional box, costing a couple of hundred
 * buckets per species. Whichever WP 1.3 actually does decides the tree-geometry VRAM bill,
 * so it is worth knowing before integration rather than after.
 */
export function stubStem(
  species: SpeciesDef,
  seed: number,
  x = 0,
  z = 0,
  noiseScale = 1,
): Stem {
  const rng = new Rng(mixSeed(hashString(species.id), seed))
  // Reverse-J age structure: many young stems, few old ones, as in an uneven-aged stand.
  const age = Math.pow(rng.next(), 1.6)

  const noise = (sigma: number): number => Math.exp(rng.clampedGaussian() * sigma * noiseScale)

  const heightM = lerp(species.heightM[0], species.heightM[1], age) * noise(0.06)
  const dbhM = lerp(species.dbhM[0], species.dbhM[1], age) * noise(0.1)
  // Crown recession with age: an old, previously crowded stem has lifted its crown.
  const cbFrac = lerp(species.crownBaseFraction[0], species.crownBaseFraction[1], age) * noise(0.06)
  const crownBaseM = Math.min(0.9 * heightM, cbFrac * heightM)
  const crownRadiusM = 0.5 * heightM * species.crownWidthFraction * noise(0.1)
  // Bulk density falls as a crown ages and opens out.
  const cbd = lerp(species.crownBulkDensity[1], species.crownBulkDensity[0], age) * noise(0.07)
  const foliarMoisture = lerp(species.foliarMoisture[0], species.foliarMoisture[1], rng.next())

  return {
    speciesId: species.id,
    x: m(x),
    z: m(z),
    groundY: m(0),
    heightM: m(heightM),
    dbhM: m(dbhM),
    crownBaseM: m(crownBaseM),
    crownRadiusM: m(crownRadiusM),
    crownBulkDensity: kgm3(cbd),
    foliarMoisture: moistureFraction(foliarMoisture),
    age,
    seed: mixSeed(seed, 0x9e37),
    rotationY: rad(rng.next() * 2 * Math.PI),
    // Ladder fuels are more likely under a low crown and in younger, denser stands.
    hasLadderFuels: rng.next() < 0.35 * (1 - age) + 0.1,
  }
}

/** A deterministic stand of `count` stems drawn from `species`, spread over the domain. */
export function stubStand(
  species: readonly SpeciesDef[],
  count: number,
  seed: number,
  domainM = 1024,
  noiseScale = 1,
): Stem[] {
  const rng = new Rng(mixSeed(seed, 0x5eed))
  const stems: Stem[] = []
  for (let i = 0; i < count; i++) {
    const s = species[rng.int(species.length)]!
    stems.push(
      stubStem(s, mixSeed(seed, i), rng.next() * domainM, rng.next() * domainM, noiseScale),
    )
  }
  return stems
}


// ---------------------------------------------------------------------------
// Analytic terrain
// ---------------------------------------------------------------------------

/**
 * Deterministic fbm terrain for the biome's default parameters.
 *
 * Structurally a `TerrainSampler`, so it drops into anything that takes the real field.
 */
export function makeStubTerrain(seed: number, _biome: BiomeId, _sizeM = DOMAIN_SIZE_M): StubTerrain {
  // The biome's own terrain parameters are no longer threaded through: `StubTerrain` takes its
  // own analytic parameter set, and every caller here only needs "a plausible landscape with a
  // known seed". Biome-specific relief is the real generator's job.
  return new StubTerrain({ seed })
}


// ---------------------------------------------------------------------------
// Fuel models
// ---------------------------------------------------------------------------

/**
 * A spread of real fuel models for tests that want variety rather than one bed.
 *
 * The shipping table, not a stub copy: WP 2.5's parallel fuel table is gone, and a test that
 * exercises the burnout curve against models nothing ships was pinning the wrong thing.
 */
export const STUB_FUEL_MODELS: readonly FuelModel[] = [
  'GR2', 'GS2', 'SH5', 'TU1', 'TL3', 'SB2', 'FM1', 'FM10',
].map((c) => FUEL_MODELS.get(c))

/** Anderson (1969) flaming residence time for a model, seconds. */
export const stubResidenceTime = (f: FuelModel): Seconds =>
  flamingResidenceTime(f.sav.dead1h)


// ---------------------------------------------------------------------------
// Scene fixtures for the foliage tests
// ---------------------------------------------------------------------------

/**
 * A deterministic vegetation set over the full domain.
 *
 * Implements `IVegetationSet` structurally, so it drops into anything that takes the real one.
 * `stemsInAabb` is a linear scan: the sets here are hundreds of stems, and a grid index would
 * be fixture machinery pretending to be a spatial structure.
 */
export class StubVegetationSet implements IVegetationSet {
  readonly config: WorldConfig
  readonly stems: readonly Stem[]
  readonly species: ReadonlyMap<string, SpeciesDef>
  readonly measuredDensityPerHa: number
  readonly measuredBasalAreaM2PerHa: number

  constructor(opts: { seed: number; stemDensityPerHa: number; biome?: BiomeId; sizeM?: number }) {
    const biome = opts.biome ?? 'western-us-conifer'
    const sizeM = opts.sizeM ?? DOMAIN_SIZE_M
    const hectares = (sizeM * sizeM) / 10_000
    const count = Math.max(1, Math.round(opts.stemDensityPerHa * hectares))
    const species = stubSpeciesForBiome(biome)
    this.stems = stubStand(species, count, opts.seed, sizeM)
    this.species = new Map(species.map((s) => [s.id, s] as const))
    this.config = defaultWorldConfig(opts.seed, biome)
    this.measuredDensityPerHa = this.stems.length / hectares
    const basal = this.stems.reduce((a, s) => a + Math.PI * ((s.dbhM as number) / 2) ** 2, 0)
    this.measuredBasalAreaM2PerHa = basal / hectares
  }

  stemsInAabb(minX: Metres, minZ: Metres, maxX: Metres, maxZ: Metres): readonly Stem[] {
    return this.stems.filter(
      (s) =>
        (s.x as number) >= (minX as number) &&
        (s.x as number) <= (maxX as number) &&
        (s.z as number) >= (minZ as number) &&
        (s.z as number) <= (maxZ as number),
    )
  }
}

/** One triangle per LOD. Geometry content is irrelevant to what these tests assert. */
function stubLod(triangleCount: number): TreeLod {
  const v = triangleCount * 3
  return {
    positions: new Float32Array(v * 3),
    normals: new Float32Array(v * 3),
    uvs: new Float32Array(v * 2),
    indices: new Uint32Array(Array.from({ length: v }, (_, i) => i)),
    submeshes: [
      { material: 'bark', start: 0, count: Math.max(3, Math.floor(v / 2)) },
      { material: 'foliage', start: Math.max(3, Math.floor(v / 2)), count: v - Math.max(3, Math.floor(v / 2)) },
    ],
    triangleCount,
  }
}

/** `ITreeMeshSet` that caches one mesh per species, which is what the cull path exercises. */
export class StubTreeMeshSet implements ITreeMeshSet {
  private readonly cache = new Map<string, TreeMesh>()

  get(stem: Stem): TreeMesh {
    const existing = this.cache.get(stem.speciesId)
    if (existing !== undefined) return existing
    const mesh: TreeMesh = {
      speciesId: stem.speciesId,
      seed: this.cache.size,
      lods: [stubLod(64), stubLod(16), stubLod(4)],
      derived: {
        crownBaseM: stem.crownBaseM,
        foliarBiomassKg: 10,
        crownBulkDensity: stem.crownBulkDensity,
        heightM: stem.heightM,
      },
    }
    this.cache.set(stem.speciesId, mesh)
    return mesh
  }

  get uniqueMeshCount(): number {
    return this.cache.size
  }

  get totalTriangles(): number {
    let n = 0
    for (const m of this.cache.values()) for (const l of m.lods) n += l.triangleCount
    return n
  }
}

/**
 * The four material slots the foliage pipeline binds, in layer order.
 *
 * The sampler sits at binding **4**, not 3 — binding 3 is the crack field. A fixture that
 * disagrees with `MaterialSystem.bindGroupLayout` makes the package's own tests pass against a
 * fiction, which is exactly how the "no tree renders at all" bug survived.
 */
export const STUB_MATERIALS: readonly MaterialDef[] = [
  { id: 'bark', layer: 0, baseColorFactor: [0.42, 0.32, 0.24], roughnessFactor: 0.85, metallicFactor: 0, alphaTest: false, doubleSided: false, burnable: true },
  { id: 'foliage', layer: 1, baseColorFactor: [0.22, 0.42, 0.16], roughnessFactor: 0.7, metallicFactor: 0, alphaTest: true, doubleSided: true, burnable: true },
  { id: 'ribbon', layer: 2, baseColorFactor: [0.55, 0.45, 0.35], roughnessFactor: 0.9, metallicFactor: 0, alphaTest: true, doubleSided: true, burnable: true },
  { id: 'grass-blade', layer: 3, baseColorFactor: [0.34, 0.5, 0.2], roughnessFactor: 0.75, metallicFactor: 0, alphaTest: true, doubleSided: true, burnable: true },
]

/**
 * `IMaterialSystem` with no GPU resources, for CPU-side scene-building tests.
 *
 * Touching a GPU member throws, loudly and at the point of the mistake — a silently-null
 * `GPUTexture` surfaces as an unrelated validation error several calls later.
 */
export const createStubMaterialSystem = (): IMaterialSystem => createCpuStubMaterialSystem()

export function createCpuStubMaterialSystem(): IMaterialSystem {
  const materials = new Map(STUB_MATERIALS.map((m) => [m.id, m] as const))
  const unavailable = (what: string): never => {
    throw new Error(`CPU stub material system has no ${what}`)
  }
  return {
    get albedoArray(): GPUTexture {
      return unavailable('albedoArray')
    },
    get normalArray(): GPUTexture {
      return unavailable('normalArray')
    },
    get ormArray(): GPUTexture {
      return unavailable('ormArray')
    },
    get bindGroupLayout(): GPUBindGroupLayout {
      return unavailable('bindGroupLayout')
    },
    materials,
    bytesUsed: 0,
    get: (id: string): MaterialDef => {
      const def = materials.get(id)
      if (def === undefined) throw new Error(`stub material '${id}' does not exist`)
      return def
    },
    createBindGroup: (): GPUBindGroup => unavailable('bind group'),
  }
}


// ---------------------------------------------------------------------------
// Wind and plume environment for the firebrand flight tests
// ---------------------------------------------------------------------------

export interface LogWindProfile {
  /** Reference wind, m/s, at `refHeightM`. */
  readonly uRef: number
  readonly refHeightM: number
  /** Aerodynamic roughness length, m. 0.03 is open short grass. */
  readonly z0: number
}

/** Log profile anchored on a reference wind at a reference height. */
export const logProfileFrom = (uRef: number, refHeightM: number, z0 = 0.03): LogWindProfile => ({
  uRef,
  refHeightM,
  z0,
})

/** `u(z) = u_ref ln(z/z0) / ln(z_ref/z0)`, floored at the roughness length. */
export function logWind(p: LogWindProfile, z: number): number {
  const zz = Math.max(z, p.z0 * 1.001)
  return (p.uRef * Math.log(zz / p.z0)) / Math.log(p.refHeightM / p.z0)
}

/**
 * Heskestad plume centreline vertical velocity, `w(z) = 1.03 (Q_c/z)^(1/3)`, Q_c in kW.
 *
 * The 1.03 is the same constant `albini.test.ts` inverts to derive its convective flux from a
 * target loft height, so the two stay consistent by construction.
 */
export const heskestadUz = (convectiveKw: number, z: number): number =>
  1.03 * Math.cbrt(Math.max(convectiveKw, 0) / Math.max(z, 0.1))

/** The shipping fuel table, by code. */
export const stubFuelModel = (code: string): FuelModel => FUEL_MODELS.get(code)
