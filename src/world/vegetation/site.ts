/**
 * The site field: terrain → where vegetation goes, and how well it grows there.
 *
 * A coarse regular grid over the domain. For each cell it derives slope, aspect, a
 * topographic position index, a moisture index and a stem-density weight, and it exposes the
 * discrete distribution the placement sampler draws from.
 *
 * ---------------------------------------------------------------------------
 * TWO DESIGN DECISIONS THAT THE 5 % ACCEPTANCE CRITERION RESTS ON
 * ---------------------------------------------------------------------------
 *
 * **1. The density weight field is renormalised to mean 1 over the domain.** Whatever the
 * slope/aspect/valley/elevation responses do, the *expected* number of stems is exactly
 * `stemDensityPerHa × hectares`. Terrain redistributes stems; it cannot change how many there
 * are. Without this the response weights and the requested density would fight, and the
 * acceptance criterion would be a tuning exercise rather than a test.
 *
 * **2. A stem reads its site properties from the cell that contains it, not by interpolating.**
 * That makes the grid the *exact* marginal distribution of site conditions over stems, so
 * `allometry.ts`'s expected-value predictor can integrate over it in closed form and be the
 * true infinite-sample limit of the sampler. Comparing the two is then a real unbiasedness
 * test rather than a tautology. Within-cell variation is not lost — it comes back through the
 * per-stem hashed vigour and age draws, which is where individual variation belongs anyway.
 *
 * Cell size defaults to 8 m: fine enough that a valley bottom and its flank are different
 * cells, coarse enough that 128² covers a 1 km domain.
 *
 * Everything in this file is an engineering estimate and is firewalled from the physics — see
 * `VEGETATION_PLACEMENT` in provenance.ts for the recorded §0.7.3 decision. No fire-behaviour
 * quantity is computed from any number here; the one output that reaches the physics is a
 * `productivity` scalar that moves a stem *within* its own species' cited size envelope.
 */

import type { BiomeId, SpeciesDef, VegetationParams } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { m } from '@contracts/units'
import type { BiomeSiteResponse } from './biomes.ts'
import { biomeExtras } from './biomes.ts'
import { NEUTRAL_AFFINITY, SPECIES_SITE_AFFINITY } from './biomes.ts'
import { clamp, clamp01 } from '../../math.ts'
import { isStemForming } from './species.ts'
import type { TerrainSampler } from '../../camera/terrainStub.ts'

/** Typed-array reads under `noUncheckedIndexedAccess`. Index validity is a caller invariant. */
const f64 = (a: Float64Array, i: number): number => a[i] as number

export const DEFAULT_SITE_CELL_M = 8

export interface SiteFieldOptions {
  readonly seed: number
  readonly biome: BiomeId
  readonly vegetation: VegetationParams
  readonly terrain: TerrainSampler
  /** Domain edge length. Tests use a small square; production uses `DOMAIN_SIZE_M`. */
  readonly sizeM: number
  /** Latitude in degrees. Sign matters: it decides which aspect is the cool one. */
  readonly latitudeDeg: number
  readonly cellSizeM?: number
}

/** Everything a stem needs to know about where it stands. */
export interface SiteConditions {
  /** Ground slope as a tangent (§0.6 rule 4). */
  readonly slopeTangent: number
  /** Downslope azimuth, radians clockwise from north. */
  readonly aspectRad: number
  /** Elevation normalised to the domain's own range, 0 = lowest cell, 1 = highest. */
  readonly elevationNorm: number
  /** Topographic position, −1 = valley bottom, 0 = mid-slope, +1 = ridge crest. */
  readonly topographicPosition: number
  /** Composite moisture index, −1 = driest site in the domain, +1 = wettest. */
  readonly moisture: number
  /** Site productivity 0..1. The only value from this file that reaches per-stem geometry. */
  readonly productivity: number
}

/**
 * The density response, factored out of the field so it can be unit-tested directly.
 *
 * Inside a generated domain every response is confounded with the others — a steep cell is
 * usually also a high cell on a particular aspect — so the only way to assert that "steeper
 * means sparser" is to evaluate the response itself with one input moving at a time.
 *
 * @param slopeTangent ground slope, tangent
 * @param coolness −1 (hottest aspect) … +1 (coolest aspect), already gated by slope and latitude
 * @param topographicPosition −1 (valley bottom) … +1 (ridge crest)
 * @param elevationNorm 0 (lowest cell in the domain) … 1 (highest)
 */
export function densityWeight(
  sr: BiomeSiteResponse,
  slopeTangent: number,
  coolness: number,
  topographicPosition: number,
  elevationNorm: number,
): number {
  const slopeFactor = Math.pow(sr.slopeResponse, Math.min(slopeTangent, 2))
  const aspectFactor = Math.pow(sr.coolAspectResponse, coolness / 2)
  const positionFactor =
    topographicPosition < 0
      ? Math.pow(sr.valleyResponse, -topographicPosition)
      : Math.pow(sr.ridgeResponse, topographicPosition)
  const e = (elevationNorm - sr.elevationOptimum) / sr.elevationWidth
  return slopeFactor * aspectFactor * positionFactor * Math.exp(-0.5 * e * e)
}

/**
 * How strongly aspect matters here. Zero on flat ground (an aspect with no slope is
 * meaningless) and zero at the equator (the sun is overhead, so no aspect is shaded).
 * The half-response at tan = 0.18 (≈ 10°) is where insolation differences between aspects
 * become ecologically visible.
 *
 * The SIGN of the latitude is what picks the cool aspect: north-facing in the northern
 * hemisphere, south-facing in the southern. The eucalypt biome depends on this.
 */
export function aspectCoolness(aspectRad: number, slopeTangent: number, latitudeDeg: number): number {
  const coolAzimuth = latitudeDeg >= 0 ? 0 : Math.PI
  const gate = slopeTangent / (slopeTangent + 0.18)
  return Math.cos(aspectRad - coolAzimuth) * gate * clamp01(Math.abs(latitudeDeg) / 45)
}

/** Composite moisture index: shaded aspects and valley bottoms are the moist sites. */
export function moistureIndex(coolness: number, topographicPosition: number): number {
  return clamp(0.55 * coolness - 0.45 * topographicPosition, -1, 1)
}

export class SiteField {
  readonly cellSizeM: number
  readonly cols: number
  readonly sizeM: number
  readonly cellCount: number
  /** Stems per m², per cell, after renormalisation. Integrates to the requested total. */
  readonly intensity: Float64Array
  /** Inclusive prefix sums of `intensity × cellArea`, length cellCount + 1. */
  readonly cumulative: Float64Array
  /** Expected total stems over the domain = `cumulative[cellCount]`. */
  readonly expectedStemCount: number

  private readonly slopeArr: Float64Array
  private readonly aspectArr: Float64Array
  private readonly elevNormArr: Float64Array
  private readonly tpiArr: Float64Array
  private readonly moistureArr: Float64Array
  private readonly productivityArr: Float64Array
  /** Row-major [cell][species], normalised to sum 1 per cell. Stem-forming species only. */
  private readonly speciesWeights: Float64Array
  readonly stemSpecies: readonly SpeciesDef[]

  constructor(opts: SiteFieldOptions, species: readonly SpeciesDef[]) {
    const cell = opts.cellSizeM ?? DEFAULT_SITE_CELL_M
    this.cellSizeM = cell
    this.sizeM = opts.sizeM
    this.cols = Math.max(4, Math.round(opts.sizeM / cell))
    const n = this.cols
    this.cellCount = n * n

    const heights = new Float64Array(this.cellCount)
    this.slopeArr = new Float64Array(this.cellCount)
    this.aspectArr = new Float64Array(this.cellCount)
    this.elevNormArr = new Float64Array(this.cellCount)
    this.tpiArr = new Float64Array(this.cellCount)
    this.moistureArr = new Float64Array(this.cellCount)
    this.productivityArr = new Float64Array(this.cellCount)

    const half = this.sizeM / n / 2
    const step = this.sizeM / n
    let hMin = Infinity
    let hMax = -Infinity
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = m(i * step + half)
        const z = m(j * step + half)
        const h = opts.terrain.heightAt(x, z)
        const idx = j * n + i
        heights[idx] = h
        this.slopeArr[idx] = opts.terrain.slopeAt(x, z)
        this.aspectArr[idx] = opts.terrain.aspectAt(x, z)
        if (h < hMin) hMin = h
        if (h > hMax) hMax = h
      }
    }

    const hRangeM = Math.max(1e-6, hMax - hMin)
    for (let k = 0; k < this.cellCount; k++) {
      this.elevNormArr[k] = (f64(heights, k) - hMin) / hRangeM
    }

    // --- Topographic position index (Weiss 2001): elevation minus neighbourhood mean.
    // Negative = the cell sits below its surroundings, i.e. a valley bottom or hollow. A ~60 m
    // neighbourhood radius picks out drainage lines and ridge crests without responding to
    // every micro-undulation. Computed as a separable box mean, so it is O(cells) not O(r²).
    const radiusCells = Math.max(1, Math.round(60 / cell))
    const localMean = boxMean2D(heights, n, radiusCells)
    let tpiSumSq = 0
    for (let k = 0; k < this.cellCount; k++) {
      const d = f64(heights, k) - f64(localMean, k)
      this.tpiArr[k] = d
      tpiSumSq += d * d
    }
    // Scale by the field's own RMS so `topographicPosition` means the same thing on a flat
    // domain as on a mountainous one — a relative landform position, not an absolute height.
    const tpiRms = Math.sqrt(tpiSumSq / this.cellCount) || 1
    for (let k = 0; k < this.cellCount; k++) {
      this.tpiArr[k] = clamp(f64(this.tpiArr, k) / (1.5 * tpiRms), -1, 1)
    }

    // --- Moisture and density weight.
    const sr = biomeExtras(opts.biome).siteResponse

    const weights = new Float64Array(this.cellCount)
    let weightSum = 0
    for (let k = 0; k < this.cellCount; k++) {
      const slopeT = f64(this.slopeArr, k)
      const tpi = f64(this.tpiArr, k)
      const coolness = aspectCoolness(f64(this.aspectArr, k), slopeT, opts.latitudeDeg)

      const moisture = moistureIndex(coolness, tpi)
      this.moistureArr[k] = moisture
      // Productivity is deliberately a narrow band around 0.5: it shifts a stem's position
      // inside its species' size range, which is a site-quality effect, not a species change.
      this.productivityArr[k] = clamp01(0.5 + 0.45 * moisture)

      const w = densityWeight(sr, slopeT, coolness, tpi, f64(this.elevNormArr, k))
      weights[k] = w
      weightSum += w
    }

    // Renormalise to mean 1. This is the invariant the density acceptance test rests on.
    const meanW = weightSum / this.cellCount || 1
    const perM2 = opts.vegetation.stemDensityPerHa / 10_000
    const cellArea = step * step
    this.intensity = new Float64Array(this.cellCount)
    this.cumulative = new Float64Array(this.cellCount + 1)
    let acc = 0
    for (let k = 0; k < this.cellCount; k++) {
      const lambda = (perM2 * f64(weights, k)) / meanW
      this.intensity[k] = lambda
      acc += lambda * cellArea
      this.cumulative[k + 1] = acc
    }
    this.expectedStemCount = acc

    // --- Species mix, shifted by site preference.
    const stemSpecies = species
      .filter(isStemForming)
      .filter((sp) => (opts.vegetation.speciesMix[sp.id] ?? 0) > 0)
    this.stemSpecies = stemSpecies
    const ns = stemSpecies.length
    this.speciesWeights = new Float64Array(this.cellCount * Math.max(1, ns))
    if (ns > 0) {
      const base = stemSpecies.map((sp) => opts.vegetation.speciesMix[sp.id] ?? 0)
      const aff = stemSpecies.map((sp) => SPECIES_SITE_AFFINITY[sp.id] ?? NEUTRAL_AFFINITY)
      for (let k = 0; k < this.cellCount; k++) {
        const moisture = f64(this.moistureArr, k)
        const elev = f64(this.elevNormArr, k) * 2 - 1
        const slopeSigned = clamp(f64(this.slopeArr, k), 0, 1) * 2 - 1
        let sum = 0
        for (let a = 0; a < ns; a++) {
          const af = aff[a] ?? NEUTRAL_AFFINITY
          const logit =
            af.moisture * moisture + af.elevation * elev + af.slope * slopeSigned
          const w = (base[a] ?? 0) * Math.exp(logit)
          this.speciesWeights[k * ns + a] = w
          sum += w
        }
        if (sum > 0) {
          for (let a = 0; a < ns; a++) {
            this.speciesWeights[k * ns + a] = f64(this.speciesWeights, k * ns + a) / sum
          }
        }
      }
    }
  }

  cellIndexAt(x: Metres, z: Metres): number {
    const n = this.cols
    const step = this.sizeM / n
    const i = clamp(Math.floor(x / step), 0, n - 1)
    const j = clamp(Math.floor(z / step), 0, n - 1)
    return j * n + i
  }

  conditionsAtCell(k: number): SiteConditions {
    return {
      slopeTangent: f64(this.slopeArr, k),
      aspectRad: f64(this.aspectArr, k),
      elevationNorm: f64(this.elevNormArr, k),
      topographicPosition: f64(this.tpiArr, k),
      moisture: f64(this.moistureArr, k),
      productivity: f64(this.productivityArr, k),
    }
  }

  conditionsAt(x: Metres, z: Metres): SiteConditions {
    return this.conditionsAtCell(this.cellIndexAt(x, z))
  }

  /** Normalised species probability for cell `k`. Sums to 1 over `stemSpecies`. */
  speciesProbability(k: number, speciesIndex: number): number {
    const ns = this.stemSpecies.length
    if (ns === 0) return 0
    return f64(this.speciesWeights, k * ns + speciesIndex)
  }

  /** Probability mass of cell `k` over the whole domain — the weight the predictor uses. */
  cellProbability(k: number): number {
    const total = this.expectedStemCount
    if (total <= 0) return 0
    return (f64(this.cumulative, k + 1) - f64(this.cumulative, k)) / total
  }

  /**
   * Inverse-CDF sample: `u ∈ [0,1)` → cell index. Binary search over the prefix sums, so
   * sampling is O(log cells) and, critically, depends only on `u` — no iteration state, so
   * the result cannot drift with call order.
   */
  sampleCell(u: number): number {
    const target = clamp01(u) * this.expectedStemCount
    let lo = 0
    let hi = this.cellCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (f64(this.cumulative, mid + 1) <= target) lo = mid + 1
      else hi = mid
    }
    return Math.min(lo, this.cellCount - 1)
  }
}

/**
 * Separable box mean with edge clamping. Two O(n) passes rather than one O(n·r²) pass, which
 * matters at 128² with a radius of 8 cells.
 */
function boxMean2D(src: Float64Array, n: number, radius: number): Float64Array {
  const tmp = new Float64Array(n * n)
  const out = new Float64Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let count = 0
      for (let d = -radius; d <= radius; d++) {
        const ii = clamp(i + d, 0, n - 1)
        sum += f64(src, j * n + ii)
        count++
      }
      tmp[j * n + i] = sum / count
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let count = 0
      for (let d = -radius; d <= radius; d++) {
        const jj = clamp(j + d, 0, n - 1)
        sum += f64(tmp, jj * n + i)
        count++
      }
      out[j * n + i] = sum / count
    }
  }
  return out
}
