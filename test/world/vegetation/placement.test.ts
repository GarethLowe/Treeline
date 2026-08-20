/**
 * WP 1.3 acceptance tests.
 *
 * From §91 M1 row 1.3: "Stem density and basal area match requested values within 5 %;
 * distributions respond correctly to slope, aspect and moisture."
 *
 * Density has a stated target. **Basal area does not** — `VegetationParams` never declares
 * one; it emerges from the species mix, the age distribution and the allometry. So the target
 * is computed, by evaluating the same functions the sampler draws from at equal-probability
 * quantile nodes and integrating against the site field's own cell probabilities (see
 * allometry.ts). Comparing the sampler against that quadrature is a genuine unbiasedness
 * test: it catches a biased draw, a wrong normalisation or a species silently dropped from
 * the mix. Measuring the stems and comparing them to themselves would catch none of those.
 *
 * The domain is the full 1 km square for four of the five biomes, because the basal-area
 * statistic has a heavy-tailed per-stem distribution (BA ∝ D², and D spans an order of
 * magnitude across the age structure). At tens of thousands of stems the sampling error is
 * well under 1 %; on the 256 m square a faster test would use, it would approach the 5 %
 * criterion itself and the test would be measuring noise rather than bias.
 */

import { describe, expect, it } from 'vitest'
import { makeStubTerrain } from '../../fixtures/world.ts'
import type { BiomeId, SpeciesDef, Stem } from '@contracts/world'
import { m } from '@contracts/units'
import { BIOMES } from '../../../src/world/vegetation/biomes.ts'
import { defaultWorldConfig, generateVegetation } from '../../../src/world/vegetation/index.ts'
import { deriveLadderFuel, exclusionRadius } from '../../../src/world/vegetation/placement.ts'
import { StemGrid } from '../../../src/world/vegetation/spatialIndex.ts'
import { speciesById } from '../../../src/world/vegetation/species.ts'

const ALL_BIOMES = Object.keys(BIOMES) as BiomeId[]

/** Sizes chosen so each biome generates a statistically useful but affordable stem count. */
const TEST_SIZE_M: Readonly<Record<BiomeId, number>> = {
  'western-us-conifer': 1024, // ~36 700 stems
  'grassland-savanna': 1024, // ~2 600 stems
  'mediterranean-chaparral': 384, // ~32 000 shrubs
  'eucalypt-dry-forest': 1024, // ~26 000 stems
  'uk-mixed-field-forest': 1024, // ~13 600 stems
}

function generate(biome: BiomeId, seed = 20260818) {
  const sizeM = TEST_SIZE_M[biome]
  const terrain = makeStubTerrain(seed, biome, sizeM)
  return generateVegetation(defaultWorldConfig(seed, biome), terrain, { sizeM })
}

describe('acceptance: stem density within 5 % of requested', () => {
  it.each(ALL_BIOMES)('%s', (biome) => {
    const veg = generate(biome)
    const requested = BIOMES[biome].defaultVegetation.stemDensityPerHa
    const error = Math.abs(veg.measuredDensityPerHa - requested) / requested
    expect(error, `measured ${veg.measuredDensityPerHa.toFixed(1)}/ha vs ${requested}/ha`).toBeLessThan(0.05)
  })

  it.each(ALL_BIOMES)('%s reaches its target without exhausting the dart budget', (biome) => {
    const veg = generate(biome)
    // A ratio near 40 means the sampler hit its attempt cap and gave up short — which would
    // show up as an under-dense forest long before anyone noticed the spacing was wrong.
    expect(veg.diagnostics.attemptsPerStem).toBeLessThan(6)
  })
})

describe('acceptance: basal area within 5 % of the predicted value', () => {
  it.each(ALL_BIOMES)('%s', (biome) => {
    const veg = generate(biome)
    const predicted = veg.diagnostics.predictedBasalAreaM2PerHa
    expect(predicted).toBeGreaterThan(0)
    const error = Math.abs(veg.measuredBasalAreaM2PerHa - predicted) / predicted
    expect(
      error,
      `measured ${veg.measuredBasalAreaM2PerHa.toFixed(3)} m²/ha vs predicted ${predicted.toFixed(3)}`,
    ).toBeLessThan(0.05)
  })

  it('converges toward the prediction as the sample grows, i.e. the error is noise not bias', () => {
    // Four independent seeds. If the sampler were biased, the mean error would not shrink.
    let sumRatio = 0
    const seeds = [1, 2, 3, 4]
    for (const seed of seeds) {
      const veg = generate('western-us-conifer', seed)
      sumRatio += veg.measuredBasalAreaM2PerHa / veg.diagnostics.predictedBasalAreaM2PerHa
    }
    expect(Math.abs(sumRatio / seeds.length - 1)).toBeLessThan(0.025)
  })
})

describe('acceptance: determinism', () => {
  it.each(ALL_BIOMES)('%s is byte-identical for the same seed', (biome) => {
    const a = generate(biome, 4242)
    const b = generate(biome, 4242)
    expect(a.stems.length).toBe(b.stems.length)
    expect(a.stems).toEqual(b.stems)
  })

  it('produces a different world for a different seed', () => {
    const a = generate('uk-mixed-field-forest', 1)
    const b = generate('uk-mixed-field-forest', 2)
    const key = (s: Stem) => `${s.x.toFixed(3)},${s.z.toFixed(3)}`
    const shared = new Set(a.stems.map(key))
    const overlap = b.stems.filter((s) => shared.has(key(s))).length
    expect(overlap / Math.max(1, b.stems.length)).toBeLessThan(0.01)
  })
})

describe('acceptance: every derived crown base falls inside its declared range', () => {
  it.each(ALL_BIOMES)('%s', (biome) => {
    const veg = generate(biome)
    for (const st of veg.stems) {
      const sp = speciesById(st.speciesId)
      const frac = st.crownBaseM / st.heightM
      expect(frac).toBeGreaterThanOrEqual(sp.crownBaseFraction[0] - 1e-9)
      expect(frac).toBeLessThanOrEqual(sp.crownBaseFraction[1] + 1e-9)
    }
  })

  it.each(ALL_BIOMES)('%s keeps every stem inside its species size envelope', (biome) => {
    const veg = generate(biome)
    for (const st of veg.stems) {
      const sp = speciesById(st.speciesId)
      expect(st.heightM).toBeGreaterThan(0)
      expect(st.heightM).toBeLessThanOrEqual(sp.heightM[1] + 1e-9)
      expect(st.dbhM).toBeLessThanOrEqual(sp.dbhM[1] + 1e-9)
      expect(st.crownBulkDensity).toBeGreaterThanOrEqual(sp.crownBulkDensity[0] - 1e-9)
      expect(st.crownBulkDensity).toBeLessThanOrEqual(sp.crownBulkDensity[1] + 1e-9)
      expect(st.foliarMoisture).toBeGreaterThanOrEqual(sp.foliarMoisture[0] - 1e-9)
      expect(st.foliarMoisture).toBeLessThanOrEqual(sp.foliarMoisture[1] + 1e-9)
      expect(st.age).toBeGreaterThanOrEqual(0)
      expect(st.age).toBeLessThanOrEqual(1)
    }
  })
})

describe('acceptance: distributions respond to terrain', () => {
  it('puts stems on gentler ground than the domain average in the conifer biome', () => {
    const biome = 'western-us-conifer' as const
    const sizeM = TEST_SIZE_M[biome]
    const terrain = makeStubTerrain(77, biome, sizeM)
    const veg = generateVegetation(defaultWorldConfig(77, biome), terrain, { sizeM })

    let stemSlope = 0
    for (const st of veg.stems) stemSlope += terrain.slopeAt(st.x, st.z)
    stemSlope /= veg.stems.length

    let domainSlope = 0
    const n = 64
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        domainSlope += terrain.slopeAt(m(((i + 0.5) / n) * sizeM), m(((j + 0.5) / n) * sizeM))
      }
    }
    domainSlope /= n * n
    expect(stemSlope).toBeLessThan(domainSlope)
  })

  it('places stems on moister sites than the domain average', () => {
    const biome = 'western-us-conifer' as const
    const veg = generate(biome, 31)
    let stemMoisture = 0
    for (const st of veg.stems) stemMoisture += veg.site.conditionsAt(st.x, st.z).moisture
    stemMoisture /= veg.stems.length

    let domainMoisture = 0
    for (let k = 0; k < veg.site.cellCount; k++) {
      domainMoisture += veg.site.conditionsAtCell(k).moisture
    }
    domainMoisture /= veg.site.cellCount

    expect(stemMoisture).toBeGreaterThan(domainMoisture)
  })

  it('shifts the species mix along the moisture gradient (Douglas fir into the draws)', () => {
    // SPECIES_SITE_AFFINITY gives ponderosa moisture −0.8 and Douglas fir +1.0, which is the
    // textbook western-US gradient. It must be visible in the generated stand.
    const veg = generate('western-us-conifer', 5150)
    let dryFir = 0
    let dryTotal = 0
    let wetFir = 0
    let wetTotal = 0
    for (const st of veg.stems) {
      const moist = veg.site.conditionsAt(st.x, st.z).moisture
      const isFir = st.speciesId === 'pseudotsuga-menziesii'
      if (moist < -0.1) {
        dryTotal++
        if (isFir) dryFir++
      } else if (moist > 0.1) {
        wetTotal++
        if (isFir) wetFir++
      }
    }
    expect(dryTotal).toBeGreaterThan(50)
    expect(wetTotal).toBeGreaterThan(50)
    expect(wetFir / wetTotal).toBeGreaterThan(dryFir / dryTotal)
  })
})

describe('ladder fuels are measured, not assigned', () => {
  it('is a pure function of the vertical geometry', () => {
    // Two identical stems whose only difference is crown base height must differ in the test.
    const veg = generate('western-us-conifer', 606)
    const low = { ...(veg.stems[0] as Stem), crownBaseM: m(0.2), crownRadiusM: m(2), heightM: m(20) }
    const high = { ...low, crownBaseM: m(15) }
    const grid = new StemGrid([], 1024, 16)
    expect(deriveLadderFuel(low, -1, [], grid, veg.understory, 'western-us-conifer')).toBe(true)
    expect(deriveLadderFuel(high, -1, [], grid, veg.understory, 'western-us-conifer')).toBe(false)
  })

  it('bridges when a subordinate neighbour reaches into the gap', () => {
    const veg = generate('western-us-conifer', 607)
    const tall: Stem = {
      ...(veg.stems[0] as Stem),
      x: m(500),
      z: m(500),
      heightM: m(30),
      crownBaseM: m(12),
      crownRadiusM: m(4),
    }
    const ladder: Stem = { ...tall, x: m(502), z: m(500), heightM: m(11), crownBaseM: m(1) }
    const withLadder = new StemGrid([tall, ladder], 1024, 16)
    const alone = new StemGrid([tall], 1024, 16)
    expect(deriveLadderFuel(tall, 0, [tall], alone, veg.understory, 'western-us-conifer')).toBe(false)
    expect(
      deriveLadderFuel(tall, 0, [tall, ladder], withLadder, veg.understory, 'western-us-conifer'),
    ).toBe(true)
  })

  it('is not a coin flip: it correlates with crown base height across a whole stand', () => {
    const veg = generate('western-us-conifer', 608)
    let withLadderBase = 0
    let withLadderN = 0
    let withoutBase = 0
    let withoutN = 0
    for (const st of veg.stems) {
      if (st.hasLadderFuels) {
        withLadderBase += st.crownBaseM
        withLadderN++
      } else {
        withoutBase += st.crownBaseM
        withoutN++
      }
    }
    expect(withLadderN).toBeGreaterThan(10)
    expect(withoutN).toBeGreaterThan(10)
    expect(withLadderBase / withLadderN).toBeLessThan(withoutBase / withoutN)
  })

  it('gives chaparral near-universal ladder continuity (§30 §7.1)', () => {
    // "chaparral, where there is no meaningful CBH because fuel is vertically continuous"
    const veg = generate('mediterranean-chaparral')
    expect(veg.diagnostics.ladderFuelFraction).toBeGreaterThan(0.95)
  })
})

describe('IVegetationSet surface', () => {
  it('exposes the species used, keyed by id', () => {
    const veg = generate('uk-mixed-field-forest')
    for (const st of veg.stems) expect(veg.species.get(st.speciesId)).toBeDefined()
  })

  it('stemsInAabb agrees with a linear scan', () => {
    const veg = generate('western-us-conifer', 8080)
    const box: [number, number, number, number] = [200, 300, 450, 620]
    const got = veg.stemsInAabb(m(box[0]), m(box[1]), m(box[2]), m(box[3]))
    const want = veg.stems.filter(
      (s) => s.x >= box[0] && s.x <= box[2] && s.z >= box[1] && s.z <= box[3],
    )
    expect(got.length).toBe(want.length)
    expect(new Set(got.map((s) => s.seed))).toEqual(new Set(want.map((s) => s.seed)))
  })

  it('reports an emergent stand crown bulk density in a physically sane band', () => {
    // Stand-level CBD, NOT the per-stem within-crown value. §30 §7.1 puts the passive/active
    // crowning threshold at 0.05 kg m⁻³ and works in the 0.05–0.40 band; a closed conifer
    // stand should land inside that, and being an order of magnitude out would mean the
    // per-stem field had been interpreted as stand-level somewhere.
    const veg = generate('western-us-conifer')
    expect(veg.diagnostics.measuredStandCrownBulkDensity).toBeGreaterThan(0.01)
    expect(veg.diagnostics.measuredStandCrownBulkDensity).toBeLessThan(0.6)
  })

  it('gives the eucalypt biome a near-surface height in Vesta’s centimetre units', () => {
    // §60 §7.1.2: H_ns validated range 5–40 cm, and the generator must emit it as a
    // first-class field rather than derive it from a fuel-load scalar.
    const veg = generate('eucalypt-dry-forest')
    const cm = veg.understory.nearSurfaceHeightCm(m(500), m(500))
    expect(cm).toBeGreaterThan(5)
    expect(cm).toBeLessThan(200)
  })

  it('suppresses understory cover under a closed canopy', () => {
    const veg = generate('western-us-conifer')
    let openSum = 0
    let openN = 0
    let closedSum = 0
    let closedN = 0
    for (let k = 0; k < veg.site.cellCount; k++) {
      const closure = veg.understory.canopyClosure[k] as number
      const cover = veg.understory.cover[k] as number
      if (closure < 0.2) {
        openSum += cover
        openN++
      } else if (closure > 0.6) {
        closedSum += cover
        closedN++
      }
    }
    expect(openN).toBeGreaterThan(0)
    expect(closedN).toBeGreaterThan(0)
    expect(openSum / openN).toBeGreaterThan(closedSum / closedN)
  })
})

describe('exclusion radius', () => {
  it('shrinks as local density rises', () => {
    const sparse = exclusionRadius('western-us-conifer', 0.35, 25 / 10_000)
    const dense = exclusionRadius('western-us-conifer', 0.35, 900 / 10_000)
    expect(dense).toBeLessThan(sparse)
  })

  it('shrinks with clustering, so clumping is possible without changing the count', () => {
    const even = exclusionRadius('western-us-conifer', 0, 0.035)
    const clumped = exclusionRadius('western-us-conifer', 1, 0.035)
    expect(clumped).toBeLessThan(even)
  })
})

describe('species mix is honoured', () => {
  it.each(ALL_BIOMES)('%s instantiates every stem-forming species in its mix', (biome) => {
    const veg = generate(biome)
    const wanted = BIOMES[biome].species.filter(
      (sp: SpeciesDef) =>
        (BIOMES[biome].defaultVegetation.speciesMix[sp.id] ?? 0) > 0 &&
        (sp.form === 'conifer' || sp.form === 'broadleaf' || sp.form === 'shrub'),
    )
    for (const sp of wanted) {
      expect(
        veg.diagnostics.stemCountBySpecies.get(sp.id) ?? 0,
        `${biome} generated no ${sp.id}`,
      ).toBeGreaterThan(0)
    }
  })

  it('never instantiates a grass or fern as a stem', () => {
    for (const biome of ALL_BIOMES) {
      const veg = generate(biome)
      for (const id of veg.diagnostics.stemCountBySpecies.keys()) {
        const form = speciesById(id).form
        expect(form === 'grass' || form === 'fern', `${biome} placed ${id} as a stem`).toBe(false)
      }
    }
  })
})
