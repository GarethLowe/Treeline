/**
 * `IVegetationSet` — the WP 1.3 output.
 *
 * Beyond the contract this class carries diagnostics the acceptance tests and the HUD need
 * but the frozen interface has no room for: the *predicted* density and basal area (see
 * allometry.ts for why a prediction is the only honest target for basal area), the emergent
 * stand-level crown bulk density, and the site and understory fields.
 *
 * Extra public members are safe here in a way that a contract edit would not be: nothing
 * outside this package can depend on them by accident, because nothing outside this package
 * imports this file — siblings receive an `IVegetationSet` (§90.1 rules 1 and 2).
 */

import type {
  IVegetationSet,
  SpeciesDef,
  Stem,
  WorldConfig,
} from '@contracts/world'
import type { KgPerCubicMetre, Metres } from '@contracts/units'
import { kgm3 } from '@contracts/units'
import {
  DEFAULT_QUADRATURE,
  ELASTIC_SIMILARITY_EXPONENT,
  expectedGrowthPower,
  expectedMatureDbhSquared,
  type QuadratureResolution,
} from './allometry.ts'
import type { PlacementOutput } from './placement.ts'
import type { SiteField } from './site.ts'
import type { StemGrid } from './spatialIndex.ts'
import type { UnderstoryField } from './understory.ts'

/**
 * Crown volume shape factor: crown volume = factor · π · r² · crownLength.
 *
 * Cone for conifers (1/3), prolate half-spheroid for broadleaves and shrubs (2/3), slab for
 * the herb layer (1). These are the same idealisations WP 1.4 builds geometry from, so the
 * stand-level bulk density reported here and the mesh-measured one should agree.
 */
const CROWN_SHAPE_FACTOR: Readonly<Record<SpeciesDef['form'], number>> = {
  conifer: 1 / 3,
  broadleaf: 2 / 3,
  shrub: 2 / 3,
  fern: 1,
  grass: 1,
}

export function crownVolumeM3(stem: Stem, form: SpeciesDef['form']): number {
  const length = Math.max(0, stem.heightM - stem.crownBaseM)
  return CROWN_SHAPE_FACTOR[form] * Math.PI * stem.crownRadiusM * stem.crownRadiusM * length
}

export interface VegetationDiagnostics {
  /** Stems the intensity field expected, per hectare. The density acceptance target. */
  readonly predictedDensityPerHa: number
  /**
   * Basal area the allometry predicts, m²/ha, by quadrature over the same distributions the
   * sampler draws from. The basal-area acceptance target — `VegetationParams` states no basal
   * area, so this prediction *is* the requested value (see allometry.ts).
   */
  readonly predictedBasalAreaM2PerHa: number
  /**
   * Emergent stand-level (canopy) crown bulk density, kg m⁻³: total crown foliage mass over
   * the domain area times the mean canopy depth.
   *
   * This is the quantity Van Wagner's 0.05 kg m⁻³ active-crowning threshold refers to (§30
   * §7.1), and it is NOT `Stem.crownBulkDensity`, which is within-crown. Reported so the
   * emergent number can be sanity-checked without anyone having to reinterpret the per-stem
   * field. M3's voxeliser produces the authoritative version at 2 m resolution; this is the
   * domain mean of the same thing.
   */
  readonly measuredStandCrownBulkDensity: KgPerCubicMetre
  /** Mean canopy depth (height − crown base) over stems with a crown, metres. */
  readonly meanCanopyDepthM: number
  readonly meanHeightM: number
  readonly meanCrownBaseM: number
  /** Fraction of stems with a measured surface-to-crown fuel path. Drives torching at M3. */
  readonly ladderFuelFraction: number
  readonly stemCountBySpecies: ReadonlyMap<string, number>
  /** Darts thrown per accepted stem. Above ~3 the exclusion radius is too tight. */
  readonly attemptsPerStem: number
}

export class VegetationSet implements IVegetationSet {
  readonly config: WorldConfig
  readonly stems: readonly Stem[]
  readonly species: ReadonlyMap<string, SpeciesDef>
  readonly measuredDensityPerHa: number
  readonly measuredBasalAreaM2PerHa: number
  readonly diagnostics: VegetationDiagnostics
  readonly site: SiteField
  readonly understory: UnderstoryField
  readonly sizeM: number

  private readonly grid: StemGrid

  constructor(
    config: WorldConfig,
    placement: PlacementOutput,
    species: readonly SpeciesDef[],
    sizeM: number,
    quadrature: QuadratureResolution = DEFAULT_QUADRATURE,
  ) {
    this.config = config
    this.stems = placement.stems
    this.species = new Map(species.map((sp) => [sp.id, sp]))
    this.site = placement.site
    this.understory = placement.understory
    this.grid = placement.grid
    this.sizeM = sizeM

    const areaHa = (sizeM * sizeM) / 10_000
    this.measuredDensityPerHa = this.stems.length / areaHa

    let basalAreaM2 = 0
    let foliageMassKg = 0
    let heightSum = 0
    let crownBaseSum = 0
    let ladderCount = 0
    const counts = new Map<string, number>()
    for (const st of this.stems) {
      const r = st.dbhM / 2
      basalAreaM2 += Math.PI * r * r
      heightSum += st.heightM
      crownBaseSum += st.crownBaseM
      if (st.hasLadderFuels) ladderCount++
      counts.set(st.speciesId, (counts.get(st.speciesId) ?? 0) + 1)
      const sp = this.species.get(st.speciesId)
      if (sp !== undefined) foliageMassKg += st.crownBulkDensity * crownVolumeM3(st, sp.form)
    }
    this.measuredBasalAreaM2PerHa = basalAreaM2 / areaHa

    const count = this.stems.length
    const meanHeightM = count > 0 ? heightSum / count : 0
    const meanCrownBaseM = count > 0 ? crownBaseSum / count : 0
    const meanCanopyDepthM = Math.max(0, meanHeightM - meanCrownBaseM)
    const domainArea = sizeM * sizeM
    const standCbd =
      meanCanopyDepthM > 0 ? foliageMassKg / (domainArea * meanCanopyDepthM) : 0

    this.diagnostics = {
      predictedDensityPerHa: placement.targetStemCount / areaHa,
      predictedBasalAreaM2PerHa: predictBasalAreaM2PerHa(
        placement.site,
        config.vegetation.maturity,
        areaHa,
        quadrature,
      ),
      measuredStandCrownBulkDensity: kgm3(standCbd),
      meanCanopyDepthM,
      meanHeightM,
      meanCrownBaseM,
      ladderFuelFraction: count > 0 ? ladderCount / count : 0,
      stemCountBySpecies: counts,
      attemptsPerStem: count > 0 ? placement.attempts / count : 0,
    }
  }

  stemsInAabb(minX: Metres, minZ: Metres, maxX: Metres, maxZ: Metres): readonly Stem[] {
    return this.grid.queryAabb(minX, minZ, maxX, maxZ)
  }
}

/**
 * Expected basal area per hectare, by quadrature.
 *
 * The integral is over three independent draws — site cell, then species given the cell, then
 * (vigour, age) — and it factorises, because DBH is `matureDBH(rank) · g(age)^1.5` with rank
 * and age independent:
 *
 *     E[BA] = Σ_cell P(cell) Σ_sp P(sp|cell) · (π/4) · E[matureDBH²|sp, productivity(cell)]
 *                                                     · E[g(age)^3|form(sp), maturity]
 *
 * `E[g^3]` depends only on (form, maturity), so it is computed once per form and reused across
 * every cell — which is what keeps this an O(cells × species × vigourNodes) sum rather than an
 * O(cells × species × vigourNodes × ageNodes) one.
 */
export function predictBasalAreaM2PerHa(
  site: SiteField,
  maturity: number,
  areaHa: number,
  q: QuadratureResolution = DEFAULT_QUADRATURE,
): number {
  const species = site.stemSpecies
  if (species.length === 0 || areaHa <= 0) return 0

  const growthPower = new Map<SpeciesDef['form'], number>()
  for (const sp of species) {
    if (!growthPower.has(sp.form)) {
      growthPower.set(
        sp.form,
        expectedGrowthPower(sp.form, maturity, 2 * ELASTIC_SIMILARITY_EXPONENT, q.ageNodes),
      )
    }
  }

  let expectedBaPerStem = 0
  for (let k = 0; k < site.cellCount; k++) {
    const pCell = site.cellProbability(k)
    if (pCell <= 0) continue
    const productivity = site.conditionsAtCell(k).productivity
    let cellSum = 0
    for (let a = 0; a < species.length; a++) {
      const pSp = site.speciesProbability(k, a)
      if (pSp <= 0) continue
      const sp = species[a]
      if (sp === undefined) continue
      const d2 = expectedMatureDbhSquared(sp, productivity, q.vigourNodes)
      cellSum += pSp * (Math.PI / 4) * d2 * (growthPower.get(sp.form) ?? 0)
    }
    expectedBaPerStem += pCell * cellSum
  }

  return (site.expectedStemCount * expectedBaPerStem) / areaHa
}
