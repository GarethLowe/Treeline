/**
 * Seeded stem placement.
 *
 * ---------------------------------------------------------------------------
 * THE ALGORITHM
 * ---------------------------------------------------------------------------
 * Variable-radius Poisson-disc by dart throwing against the site field's intensity:
 *
 *  1. Draw a cell by inverse CDF over the (terrain-modulated, mean-normalised) intensity, then
 *     jitter uniformly inside it. Sampling from the CDF rather than rejection-sampling the
 *     whole domain means cost does not blow up when the terrain response is aggressive.
 *  2. Compute the local exclusion radius from the local intensity: `r = c·λ^(-1/2)`, so a
 *     dense valley stand and a sparse ridge stand get their own spacing. A single global
 *     radius would make the sparse areas look regular and the dense ones fail to fill.
 *  3. Reject if it conflicts with an already-placed stem; otherwise keep it.
 *
 * Clustering shrinks the exclusion radius, which is what lets stems bunch. The *count* is not
 * affected by clustering, because the intensity field is renormalised to mean 1 upstream —
 * clustering changes the pattern, not the total, which is exactly the separation of concerns
 * the acceptance criterion needs.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY PER-STEM DRAW IS HASHED FROM POSITION
 * ---------------------------------------------------------------------------
 * Only the candidate *positions* come from the sequential stream. Species, age, vigour and
 * rotation are all hashed from the accepted position. The contract asks for this in as many
 * words — `Stem.seed` exists "so a stem's mesh is reproducible independent of iteration
 * order" — and it only holds if the parameters are hashed too. Otherwise adding one rejected
 * dart reshuffles every tree downstream of it, and a rendering change that reorders placement
 * silently regenerates the world.
 *
 * ---------------------------------------------------------------------------
 * LADDER FUELS
 * ---------------------------------------------------------------------------
 * `Stem.hasLadderFuels` drives torching likelihood at M3, so it is measured, never assigned:
 * the vertical gap between a stem's crown base and the top of the tallest fuel stratum
 * beneath it — the understory layer where cover is sufficient, plus any subordinate
 * neighbouring stem whose crown reaches into the gap. See `deriveLadderFuel`.
 */

import type { BiomeId, SpeciesDef, Stem, VegetationParams } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { m } from '@contracts/units'
import { biomeExtras } from './biomes.ts'
import { deriveStem, stemDraws, stemHashSeed } from './allometry.ts'
import { hash1, hashUnit, makeRng } from './rng.ts'
import { clamp, clamp01 } from '../../math.ts'
import { SiteField } from './site.ts'
import { PointGrid, StemGrid } from './spatialIndex.ts'
import { isStemForming } from './species.ts'
import type { TerrainSampler } from '../../camera/terrainStub.ts'
import { UnderstoryField } from './understory.ts'

const f64 = (a: Float64Array, i: number): number => a[i] as number
const i32 = (a: Int32Array, i: number): number => a[i] as number

/** Darts thrown per stem before the sampler gives up on the target count. */
const MAX_ATTEMPTS_PER_STEM = 40
/** Exclusion radius bounds, metres. The lower bound is roughly two mature trunk radii. */
const MIN_EXCLUSION_M = 0.25
const MAX_EXCLUSION_M = 25

export interface PlacementOptions {
  readonly seed: number
  readonly biome: BiomeId
  readonly vegetation: VegetationParams
  readonly terrain: TerrainSampler
  readonly species: readonly SpeciesDef[]
  readonly sizeM: number
  readonly latitudeDeg: number
  readonly siteCellM?: number
}

export interface PlacementOutput {
  readonly stems: readonly Stem[]
  readonly site: SiteField
  readonly understory: UnderstoryField
  readonly grid: StemGrid
  /** Stems the intensity field expected. The sampler aims at `round()` of this. */
  readonly targetStemCount: number
  /** Darts thrown. A ratio far above ~3 means the exclusion radius is too tight. */
  readonly attempts: number
}

export function placeStems(opts: PlacementOptions): PlacementOutput {
  const site = new SiteField(
    {
      seed: opts.seed,
      biome: opts.biome,
      vegetation: opts.vegetation,
      terrain: opts.terrain,
      sizeM: opts.sizeM,
      latitudeDeg: opts.latitudeDeg,
      ...(opts.siteCellM === undefined ? {} : { cellSizeM: opts.siteCellM }),
    },
    opts.species,
  )

  const extras = biomeExtras(opts.biome)
  const target = Math.round(site.expectedStemCount)
  const cellStep = site.sizeM / site.cols

  // --- 1. Dart throwing.
  const rng = makeRng(hash1(opts.seed, 0x5730d15)) // 'stems'
  const clusterRelax = 1 - 0.6 * clamp01(opts.vegetation.clustering)
  const coefficient = extras.separationFactor * 0.5 * clusterRelax

  // The grid's cell size must be at least the largest exclusion radius in play, or the 3×3
  // neighbourhood scan can miss a conflict. Derive it from the minimum non-zero intensity.
  let lambdaMin = Infinity
  for (let k = 0; k < site.cellCount; k++) {
    const l = f64(site.intensity, k)
    if (l > 0 && l < lambdaMin) lambdaMin = l
  }
  const maxRadius = Number.isFinite(lambdaMin)
    ? clamp(coefficient / Math.sqrt(lambdaMin), MIN_EXCLUSION_M, MAX_EXCLUSION_M)
    : MAX_EXCLUSION_M

  const pointGrid = new PointGrid(site.sizeM, maxRadius)
  const xs: number[] = []
  const zs: number[] = []
  const cellIds: number[] = []

  const maxAttempts = Math.max(64, target * MAX_ATTEMPTS_PER_STEM)
  let attempts = 0
  while (xs.length < target && attempts < maxAttempts) {
    attempts++
    const cell = site.sampleCell(rng())
    const ci = cell % site.cols
    const cj = (cell - ci) / site.cols
    const x = (ci + rng()) * cellStep
    const z = (cj + rng()) * cellStep
    const lambda = f64(site.intensity, cell)
    if (lambda <= 0) continue
    const r = clamp(coefficient / Math.sqrt(lambda), MIN_EXCLUSION_M, MAX_EXCLUSION_M)
    if (pointGrid.conflicts(x, z, r)) continue
    pointGrid.insert(x, z, r)
    xs.push(x)
    zs.push(z)
    cellIds.push(cell)
  }

  const n = xs.length
  const xArr = Float64Array.from(xs)
  const zArr = Float64Array.from(zs)

  // --- 2. Local competition, from realised neighbour counts.
  // The comparison radius scales with the stand's own spacing so a savanna at 25 stems/ha and
  // a chaparral at 900 are measured on comparable terms — a fixed radius would put 0 or 1
  // neighbours in the savanna window and hundreds in the chaparral one.
  const competition = new Float64Array(n)
  if (n > 0) {
    const radii = new Float64Array(n)
    let maxCompRadius = 0
    for (let s = 0; s < n; s++) {
      const lambda = Math.max(1e-9, f64(site.intensity, cellIds[s] ?? 0))
      const r = clamp(2.5 / Math.sqrt(lambda), 6, 40)
      radii[s] = r
      if (r > maxCompRadius) maxCompRadius = r
    }
    const index = buildPositionIndex(xArr, zArr, site.sizeM, Math.max(4, maxCompRadius / 2))
    for (let s = 0; s < n; s++) {
      const r = f64(radii, s)
      const lambda = Math.max(1e-9, f64(site.intensity, cellIds[s] ?? 0))
      const count = countWithin(index, xArr, zArr, f64(xArr, s), f64(zArr, s), r)
      const expected = lambda * Math.PI * r * r
      // Half the nominal neighbour count maps to competition 0.5, so a stand generated at its
      // own requested density sits mid-scale and both directions are expressible.
      competition[s] = clamp01((count - 1) / (2 * expected))
    }
  }

  // --- 3. Species, draws and derivation. All hashed from position.
  const stemSpecies = site.stemSpecies
  const provisional: Stem[] = []
  const crownTops = new Float64Array(n)
  for (let s = 0; s < n; s++) {
    const x = f64(xArr, s)
    const z = f64(zArr, s)
    const cell = cellIds[s] ?? 0
    const seed = stemHashSeed(opts.seed, x, z)
    const sp = pickSpecies(site, cell, stemSpecies, hashUnit(hash1(seed, 4)))
    if (sp === undefined) continue
    const draws = stemDraws(seed, opts.vegetation.maturity)
    const cond = site.conditionsAtCell(cell)
    const derived = deriveStem(sp, draws.age, draws.vigour, {
      productivity: cond.productivity,
      moisture: cond.moisture,
      competition: f64(competition, s),
    })
    crownTops[s] = derived.crownTopM
    provisional.push({
      speciesId: sp.id,
      x: m(x),
      z: m(z),
      groundY: opts.terrain.heightAt(m(x), m(z)),
      heightM: derived.heightM,
      dbhM: derived.dbhM,
      crownBaseM: derived.crownBaseM,
      crownRadiusM: derived.crownRadiusM,
      crownBulkDensity: derived.crownBulkDensity,
      foliarMoisture: derived.foliarMoisture,
      age: derived.age,
      seed,
      rotationY: draws.rotationY,
      hasLadderFuels: false, // measured in step 5, never guessed
    })
  }

  // --- 4. Understory, which needs the crowns that shade it.
  const coverSpecies = opts.species.filter(
    (sp) => !isStemForming(sp) && (opts.vegetation.speciesMix[sp.id] ?? 0) > 0,
  )
  const understory = new UnderstoryField(site, opts.vegetation, coverSpecies, provisional)

  // --- 5. Ladder fuels, from the realised vertical geometry.
  const provisionalGrid = new StemGrid(provisional, site.sizeM, Math.max(8, cellStep))
  const stems: Stem[] = provisional.map((st, s) => ({
    ...st,
    hasLadderFuels: deriveLadderFuel(st, s, provisional, provisionalGrid, understory, opts.biome),
  }))

  const grid = new StemGrid(stems, site.sizeM, Math.max(8, cellStep))
  return { stems, site, understory, grid, targetStemCount: site.expectedStemCount, attempts }
}

function pickSpecies(
  site: SiteField,
  cell: number,
  stemSpecies: readonly SpeciesDef[],
  u: number,
): SpeciesDef | undefined {
  if (stemSpecies.length === 0) return undefined
  let acc = 0
  for (let a = 0; a < stemSpecies.length; a++) {
    acc += site.speciesProbability(cell, a)
    if (u < acc) return stemSpecies[a]
  }
  return stemSpecies[stemSpecies.length - 1]
}

/**
 * Is there a continuous fuel path from the surface into this stem's crown?
 *
 * Measured from the realised vertical geometry, never assigned. The chain is:
 *
 *   1. **Surface stratum.** The understory layer, but only where its cover is dense enough to
 *      carry — a 5 %-cover scatter of bracken under a 20 m oak is not a ladder, whatever its
 *      height. Below `minUnderstoryCover` the surface stratum tops out at the ground.
 *   2. **Intermediate stratum.** A neighbouring stem bridges *only if it is itself rooted in
 *      the surface stratum*, i.e. its own crown base is within the threshold of the surface
 *      top. This is the condition that makes the test mean something. Without it, any
 *      neighbouring tree at all counts as a ladder, every stem in a closed stand passes, and
 *      the flag stops carrying information — a co-dominant whose crown floats 12 m up is a
 *      peer in the same canopy layer, not a route into it.
 *   3. **The stem's own crown**, if its base is already within the threshold of the ground.
 *
 * The neighbour search radius is the stem's own crown radius plus a margin: a bridge has to be
 * under or beside the crown to matter, not merely somewhere nearby.
 *
 * The chain is one level deep on purpose. Following it recursively would make the result
 * depend on evaluation order across the whole stand, and the physical gain is small — a
 * two-step ladder implies a stratum continuity that the one-step test already catches through
 * the intermediate stem.
 *
 * ESTIMATE — the gap threshold has no obtainable source. See the blocking open question on
 * `VEGETATION_LADDER_FUEL` in provenance.ts: §30 §7.1 names Cruz's fuel-strata-gap formulation
 * as the calibration target, and this must be replaced by it before M3 relies on the result.
 */
export function deriveLadderFuel(
  stem: Stem,
  stemIndex: number,
  all: readonly Stem[],
  grid: StemGrid,
  understory: UnderstoryField,
  biome: BiomeId,
): boolean {
  const cfg = biomeExtras(biome).ladderFuel
  const threshold = cfg.gapThresholdM
  if (stem.crownBaseM <= threshold) return true

  const surfaceTop =
    understory.coverAt(stem.x, stem.z) >= cfg.minUnderstoryCover
      ? understory.topHeightAt(stem.x, stem.z)
      : 0

  let reachableTop = surfaceTop
  const searchR = stem.crownRadiusM + 2
  for (const j of grid.queryRadiusIndices(stem.x, stem.z, searchR)) {
    if (j === stemIndex) continue
    const other = all[j]
    if (other === undefined) continue
    // Rooted in the surface stratum? If not, its crown is floating too and it bridges nothing.
    if (other.crownBaseM - surfaceTop > threshold) continue
    if (other.heightM > reachableTop) reachableTop = other.heightM
  }

  return stem.crownBaseM - reachableTop <= threshold
}

// ---------------------------------------------------------------------------
// Compact CSR index over raw positions (competition pass only)
// ---------------------------------------------------------------------------

interface PositionIndex {
  readonly cols: number
  readonly cellM: number
  readonly starts: Int32Array
  readonly items: Int32Array
}

function buildPositionIndex(
  xs: Float64Array,
  zs: Float64Array,
  sizeM: number,
  cellM: number,
): PositionIndex {
  const cols = Math.max(1, Math.ceil(sizeM / cellM))
  const cells = cols * cols
  const starts = new Int32Array(cells + 1)
  const of = new Int32Array(xs.length)
  const cellOf = (x: number, z: number): number => {
    const i = Math.min(cols - 1, Math.max(0, Math.floor(x / cellM)))
    const j = Math.min(cols - 1, Math.max(0, Math.floor(z / cellM)))
    return j * cols + i
  }
  for (let s = 0; s < xs.length; s++) {
    const c = cellOf(f64(xs, s), f64(zs, s))
    of[s] = c
    starts[c + 1] = i32(starts, c + 1) + 1
  }
  for (let c = 0; c < cells; c++) starts[c + 1] = i32(starts, c + 1) + i32(starts, c)
  const cursor = new Int32Array(cells)
  const items = new Int32Array(xs.length)
  for (let s = 0; s < xs.length; s++) {
    const c = i32(of, s)
    items[i32(starts, c) + i32(cursor, c)] = s
    cursor[c] = i32(cursor, c) + 1
  }
  return { cols, cellM, starts, items }
}

function countWithin(
  index: PositionIndex,
  xs: Float64Array,
  zs: Float64Array,
  x: number,
  z: number,
  radius: number,
): number {
  const { cols, cellM, starts, items } = index
  const i0 = Math.min(cols - 1, Math.max(0, Math.floor((x - radius) / cellM)))
  const i1 = Math.min(cols - 1, Math.max(0, Math.floor((x + radius) / cellM)))
  const j0 = Math.min(cols - 1, Math.max(0, Math.floor((z - radius) / cellM)))
  const j1 = Math.min(cols - 1, Math.max(0, Math.floor((z + radius) / cellM)))
  const r2 = radius * radius
  let count = 0
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * cols + i
      const end = i32(starts, c + 1)
      for (let k = i32(starts, c); k < end; k++) {
        const s = i32(items, k)
        const dx = f64(xs, s) - x
        const dz = f64(zs, s) - z
        if (dx * dx + dz * dz <= r2) count++
      }
    }
  }
  return count
}

/** Exposed so tests can assert on the exclusion radius without re-deriving the formula. */
export function exclusionRadius(
  biome: BiomeId,
  clustering: number,
  intensityPerM2: number,
): Metres {
  const coefficient = biomeExtras(biome).separationFactor * 0.5 * (1 - 0.6 * clamp01(clustering))
  return m(clamp(coefficient / Math.sqrt(Math.max(1e-9, intensityPerM2)), MIN_EXCLUSION_M, MAX_EXCLUSION_M))
}
