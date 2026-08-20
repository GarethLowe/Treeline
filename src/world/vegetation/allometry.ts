/**
 * Per-stem parameter derivation, and the expected-value predictors that make it testable.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN
 * ---------------------------------------------------------------------------
 *   age        ← inverse CDF of the maturity-parameterised age distribution
 *   vigour     ← per-stem hash, triangular on [0,1]
 *   size rank  ← vigour and site productivity, combined; positions the stem inside its
 *                species' DECLARED range, so a mature stem is always inside the cited bounds
 *   height     = matureHeight × g(age)          g = Chapman–Richards, normalised g(1) = 1
 *   DBH        = matureDBH × g(age)^1.5         elastic similarity, H ∝ D^(2/3) (McMahon 1973)
 *   crown base = crownBaseFraction(age, competition) × height
 *   crown rad  = ½ × crownWidthFraction × height × (competition narrowing)
 *   CBD, FMC   = interpolated inside the species' declared ranges
 *
 * Everything that reaches the fire model is a *fraction of, or a point inside*, a range that
 * species.ts cites. An error in the estimated shape constants below moves an individual
 * within its species' envelope; it cannot move a species outside it. That is what lets an
 * `estimated` model sit under `calibrated` data without contaminating it (see
 * `VEGETATION_ALLOMETRY` in provenance.ts for the recorded §0.7.3 decision).
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREDICTORS EXIST
 * ---------------------------------------------------------------------------
 * The acceptance criterion is "stem density and basal area match requested values within
 * 5 %". Density has an obvious target. Basal area does not — `VegetationParams` never states
 * one; it emerges from the species mix, the age distribution and this allometry.
 *
 * So the target is computed rather than asserted: the same functions the sampler evaluates
 * at random draws are evaluated here at equal-probability quantile nodes, i.e. as a
 * quadrature rule over the exact same distributions, integrated against the site field's own
 * cell probabilities. The predictor is therefore the infinite-sample limit of the sampler,
 * and comparing them is a genuine unbiasedness test — it catches a biased draw, a wrong
 * normalisation or a lost species, none of which a self-consistent "measure what you made"
 * check would see.
 *
 * This only works because DBH is deliberately *not* a function of local competition. Real
 * diameter growth obviously is, but making it so would make the predictor circular (it would
 * need the realised stem positions it is supposed to be predicting). Competition therefore
 * routes into crown geometry only — crown recession and crown narrowing — where it belongs
 * most strongly anyway, and where nothing needs to be predicted in closed form.
 */

import type { SpeciesDef } from '@contracts/world'
import type { KgPerCubicMetre, Metres, MoistureFraction, Radians } from '@contracts/units'
import { kgm3, m, moistureFraction, rad } from '@contracts/units'
import { hash1, hash2, hashUnit, quantileNodes, triangularQuantile } from './rng.ts'
import { clamp, clamp01, lerp } from '../../math.ts'

// ---------------------------------------------------------------------------
// Growth form shape constants — ESTIMATES (see VEGETATION_ALLOMETRY)
// ---------------------------------------------------------------------------

interface GrowthShape {
  /** Chapman–Richards rate. Larger = reaches mature size sooner. */
  readonly k: number
  /** Chapman–Richards shape. > 1 gives the sigmoid an initial lag, as juvenile growth has. */
  readonly p: number
}

/**
 * Chosen so a stem reaches roughly 90 % of mature height at age 0.75 for trees, and much
 * sooner for shrubs and herbs, which is the ordering that matters. No source; see the open
 * question on `VEGETATION_ALLOMETRY`.
 */
const GROWTH_SHAPE: Readonly<Record<SpeciesDef['form'], GrowthShape>> = {
  conifer: { k: 3.2, p: 1.35 },
  // Slightly faster than conifer: broadleaves generally out-grow conifers in early height
  // growth, which is why birch and ash occupy gaps first. Also an estimate.
  broadleaf: { k: 3.4, p: 1.25 },
  shrub: { k: 4.5, p: 1.1 },
  fern: { k: 6.0, p: 1.0 },
  grass: { k: 6.5, p: 1.0 },
}

/**
 * Normalised Chapman–Richards growth: g(0) = 0, g(1) = 1, monotone increasing.
 * Richards (1959) gives the form; the constants are estimates.
 */
export function growthFraction(age: number, form: SpeciesDef['form']): number {
  const shape = GROWTH_SHAPE[form]
  const a = clamp01(age)
  const num = Math.pow(1 - Math.exp(-shape.k * a), shape.p)
  const den = Math.pow(1 - Math.exp(-shape.k), shape.p)
  return num / den
}

/**
 * Inverse CDF of the age distribution, parameterised so that **E[age] = maturity exactly**.
 *
 * Age is distributed as `u^(1/k)` with `k = maturity / (1 − maturity)`, whose mean is
 * `k/(k+1) = maturity`. That identity is what makes `VegetationParams.maturity` a statement
 * about the stand rather than a dial — and it is directly assertable in a test.
 *
 * maturity → 0 gives an all-seedling stand, → 0.5 gives a uniform age structure, → 1 gives an
 * even-aged mature stand.
 */
export function ageFromQuantile(u: number, maturity: number): number {
  const mat = clamp(maturity, 0.02, 0.98)
  const k = mat / (1 - mat)
  return Math.pow(clamp01(u), 1 / k)
}

// ---------------------------------------------------------------------------
// Per-stem derivation
// ---------------------------------------------------------------------------

/** Site inputs the allometry is allowed to see. Deliberately narrow. */
export interface AllometryInputs {
  /** 0..1 site quality from `SiteField`. Positions the stem inside its species' size range. */
  readonly productivity: number
  /** −1..1 site moisture index. The ONLY driver of foliar moisture at M1. */
  readonly moisture: number
  /**
   * 0..1 local crowding relative to the stand's nominal density. Drives crown recession and
   * crown narrowing — and nothing else, so the basal-area predictor stays closed-form.
   */
  readonly competition: number
}

export interface DerivedStem {
  readonly heightM: Metres
  readonly dbhM: Metres
  readonly crownBaseM: Metres
  readonly crownRadiusM: Metres
  readonly crownBulkDensity: KgPerCubicMetre
  readonly foliarMoisture: MoistureFraction
  readonly age: number
  readonly rotationY: Radians
  /** Absolute height of the top of the crown. Used by the ladder-fuel test. */
  readonly crownTopM: Metres
}

/**
 * Where a stem sits inside its species' declared size range, in [0, 1].
 *
 * Vigour (genetics, microsite luck) dominates; site productivity shifts the whole stand. Kept
 * as a single scalar so height and diameter stay correlated — a stem cannot be simultaneously
 * the tallest and the thinnest, which independent draws would happily produce.
 */
export function sizeRank(vigour: number, productivity: number): number {
  return clamp01(0.75 * vigour + 0.25 * clamp01(productivity))
}

/** Mature (age = 1) height for a stem of this size rank. Always inside the declared range. */
export function matureHeight(sp: SpeciesDef, rank: number): number {
  return lerp(sp.heightM[0], sp.heightM[1], clamp01(rank))
}

/** Mature (age = 1) DBH for a stem of this size rank. Always inside the declared range. */
export function matureDbh(sp: SpeciesDef, rank: number): number {
  return lerp(sp.dbhM[0], sp.dbhM[1], clamp01(rank))
}

/**
 * Elastic-similarity exponent. McMahon (1973): a self-supporting column buckles when
 * H ∝ D^(2/3), so D ∝ H^(3/2). Applied to the *growth* trajectory, meaning a half-grown tree
 * is not simply a scaled copy of a mature one — it is proportionally more slender, which is
 * what real juvenile stems are.
 */
export const ELASTIC_SIMILARITY_EXPONENT = 1.5

export function deriveStem(sp: SpeciesDef, age: number, vigour: number, site: AllometryInputs): DerivedStem {
  const rank = sizeRank(vigour, site.productivity)
  const g = growthFraction(age, sp.form)

  const heightM = matureHeight(sp, rank) * g
  const dbhM = matureDbh(sp, rank) * Math.pow(g, ELASTIC_SIMILARITY_EXPONENT)

  // Crown recession. Two real drivers: self-pruning with age, and shading by neighbours. The
  // second is the stronger one in a closed stand, which is why an open-grown savanna oak keeps
  // branches to the ground while the same species in a woodland does not. The result is a
  // fraction inside the species' declared, cited `crownBaseFraction` range by construction.
  const recession = clamp01(0.35 * g + 0.65 * clamp01(site.competition))
  const crownBaseFrac = lerp(sp.crownBaseFraction[0], sp.crownBaseFraction[1], recession)
  const crownBaseM = crownBaseFrac * heightM

  // Crowded stems have narrower crowns. 0.35 at full crowding keeps crowns from interlocking
  // into a solid slab, which would give the M3 voxeliser a physically wrong bulk density.
  const crownRadiusM = Math.max(
    0.05,
    0.5 * sp.crownWidthFraction * heightM * (1 - 0.35 * clamp01(site.competition)),
  )

  // Denser crowns on productive sites, on vigorous individuals, in crowded stands, and on
  // young stems (old crowns thin out). All four are inside the declared range.
  const cbdRank = clamp01(
    0.4 * clamp01(site.productivity) + 0.3 * vigour + 0.2 * clamp01(site.competition) + 0.1 * (1 - g),
  )
  const crownBulkDensity = lerp(sp.crownBulkDensity[0], sp.crownBulkDensity[1], cbdRank)

  // Foliar moisture tracks SITE moisture only. `VegetationParams.drynessPlaceholder` is
  // explicitly excluded: the contract says "Do not build fire behaviour on this field", and
  // foliar moisture feeds Van Wagner crown initiation directly (§30 §7.1). WP 5.3 replaces
  // this with real live-fuel-moisture state.
  const fmcRank = clamp01(0.5 + 0.5 * site.moisture)
  const foliarMoisture = lerp(sp.foliarMoisture[0], sp.foliarMoisture[1], fmcRank)

  return {
    heightM: m(heightM),
    dbhM: m(dbhM),
    crownBaseM: m(crownBaseM),
    crownRadiusM: m(crownRadiusM),
    crownBulkDensity: kgm3(crownBulkDensity),
    foliarMoisture: moistureFraction(foliarMoisture),
    age,
    rotationY: rad(0),
    crownTopM: m(heightM),
  }
}

/**
 * Per-stem draws, hashed from the quantised position rather than drawn from the placement
 * stream. `Stem.seed` in the contract exists so "a stem's mesh is reproducible independent of
 * iteration order", and that only holds if the parameters are hashed too — otherwise
 * reordering the placement loop silently reshuffles every tree in the world.
 *
 * Position is quantised to 1 mm, which is far finer than any placement jitter and coarse
 * enough that float formatting differences between engines cannot change the hash.
 */
export function stemHashSeed(worldSeed: number, x: number, z: number): number {
  return hash2(worldSeed ^ 0x51ed270b, Math.round(x * 1000), Math.round(z * 1000))
}

export interface StemDraws {
  readonly age: number
  readonly vigour: number
  readonly rotationY: Radians
  readonly seed: number
}

export function stemDraws(stemSeed: number, maturity: number): StemDraws {
  const uAge = hashUnit(hash1(stemSeed, 1))
  const uVig = hashUnit(hash1(stemSeed, 2))
  const uRot = hashUnit(hash1(stemSeed, 3))
  return {
    age: ageFromQuantile(uAge, maturity),
    vigour: triangularQuantile(uVig),
    rotationY: rad(uRot * 2 * Math.PI),
    seed: stemSeed,
  }
}

// ---------------------------------------------------------------------------
// Expected-value predictors (quadrature at the same nodes the sampler draws from)
// ---------------------------------------------------------------------------

export interface QuadratureResolution {
  readonly ageNodes: number
  readonly vigourNodes: number
}

export const DEFAULT_QUADRATURE: QuadratureResolution = { ageNodes: 24, vigourNodes: 12 }

/**
 * E[g(age)^exponent] for a growth form under a given maturity, by quadrature at
 * equal-probability age nodes. Depends only on (form, maturity), so it is computed once and
 * reused across every cell — which is what keeps the whole predictor cheap.
 */
export function expectedGrowthPower(
  form: SpeciesDef['form'],
  maturity: number,
  exponent: number,
  nodes: number,
): number {
  const q = quantileNodes(nodes)
  let sum = 0
  for (let i = 0; i < nodes; i++) {
    const age = ageFromQuantile(q[i] ?? 0, maturity)
    sum += Math.pow(growthFraction(age, form), exponent)
  }
  return sum / nodes
}

/** E[matureDBH(rank)²] over the vigour distribution at a fixed site productivity. */
export function expectedMatureDbhSquared(sp: SpeciesDef, productivity: number, nodes: number): number {
  const q = quantileNodes(nodes)
  let sum = 0
  for (let i = 0; i < nodes; i++) {
    const v = triangularQuantile(q[i] ?? 0)
    const d = matureDbh(sp, sizeRank(v, productivity))
    sum += d * d
  }
  return sum / nodes
}

/** E[matureHeight(rank)] over the vigour distribution at a fixed site productivity. */
export function expectedMatureHeight(sp: SpeciesDef, productivity: number, nodes: number): number {
  const q = quantileNodes(nodes)
  let sum = 0
  for (let i = 0; i < nodes; i++) {
    sum += matureHeight(sp, sizeRank(triangularQuantile(q[i] ?? 0), productivity))
  }
  return sum / nodes
}

/**
 * E[basal area] of a single stem, m², for one species at one site productivity.
 *
 * BA = π/4 · D², D = matureDBH(rank) · g(age)^1.5, and rank and age are independent draws, so
 * the expectation factorises into E[matureDBH²] × E[g(age)³]. Exact, not an approximation.
 */
export function expectedBasalAreaM2(
  sp: SpeciesDef,
  productivity: number,
  maturity: number,
  q: QuadratureResolution = DEFAULT_QUADRATURE,
): number {
  const g3 = expectedGrowthPower(sp.form, maturity, 2 * ELASTIC_SIMILARITY_EXPONENT, q.ageNodes)
  const d2 = expectedMatureDbhSquared(sp, productivity, q.vigourNodes)
  return (Math.PI / 4) * d2 * g3
}
