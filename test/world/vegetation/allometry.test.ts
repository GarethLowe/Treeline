/**
 * Allometry is the part of WP 1.3 that can be verified exactly, so it is tested exactly.
 *
 * Three classes of assertion:
 *  - **Identities.** E[age] = maturity is a property of the chosen distribution, not a
 *    tolerance; if it drifts, `VegetationParams.maturity` has stopped meaning what it says.
 *  - **Bounds.** Every quantity the fire model consumes is a point inside a cited species
 *    range. That is the mechanism that keeps an `estimated` allometry from contaminating
 *    `calibrated` data, so it is asserted for every species at the corners of the input space.
 *  - **Unbiasedness.** The quadrature predictors are compared against a large Monte-Carlo
 *    sample of the same functions. This is what makes the predictors usable as the basal-area
 *    acceptance target in placement.test.ts.
 */

import { describe, expect, it } from 'vitest'
import type { SpeciesDef } from '@contracts/world'
import { ELASTIC_SIMILARITY_EXPONENT, ageFromQuantile, deriveStem, expectedBasalAreaM2, expectedGrowthPower, expectedMatureDbhSquared, growthFraction, matureDbh, matureHeight, sizeRank, stemDraws, stemHashSeed } from '../../../src/world/vegetation/allometry.ts'
import { ALL_SPECIES } from '../../../src/world/vegetation/species.ts'
import { makeRng, triangularQuantile } from '../../../src/world/vegetation/rng.ts'

const FORMS: SpeciesDef['form'][] = ['conifer', 'broadleaf', 'shrub', 'fern', 'grass']

describe('growth curve', () => {
  it.each(FORMS)('%s is normalised: g(0) = 0, g(1) = 1', (form) => {
    expect(growthFraction(0, form)).toBeCloseTo(0, 12)
    expect(growthFraction(1, form)).toBeCloseTo(1, 12)
  })

  it.each(FORMS)('%s is monotone increasing', (form) => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const g = growthFraction(i / 100, form)
      expect(g).toBeGreaterThan(prev)
      prev = g
    }
  })

  it('reaches maturity sooner for shrubs and herbs than for trees', () => {
    const at = (f: SpeciesDef['form']) => growthFraction(0.3, f)
    expect(at('grass')).toBeGreaterThan(at('shrub'))
    expect(at('shrub')).toBeGreaterThan(at('broadleaf'))
    expect(at('broadleaf')).toBeGreaterThan(at('conifer'))
  })
})

describe('age distribution', () => {
  // E[age] = maturity is an identity of u^(1/k) with k = maturity/(1 − maturity). It is what
  // turns `maturity` from a dial into a statement about the stand.
  it.each([0.1, 0.25, 0.5, 0.6, 0.75, 0.9])('E[age] = maturity for maturity = %f', (maturity) => {
    const n = 200_000
    let sum = 0
    for (let i = 0; i < n; i++) sum += ageFromQuantile((i + 0.5) / n, maturity)
    expect(sum / n).toBeCloseTo(maturity, 4)
  })

  it('is a valid inverse CDF: monotone and spanning [0, 1]', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const a = ageFromQuantile(i / 100, 0.6)
      expect(a).toBeGreaterThanOrEqual(prev)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(1)
      prev = a
    }
    expect(ageFromQuantile(1, 0.6)).toBeCloseTo(1, 12)
  })

  it('maturity = 0.5 gives a uniform age structure', () => {
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(ageFromQuantile(u, 0.5)).toBeCloseTo(u, 12)
    }
  })
})

describe('elastic similarity (McMahon 1973)', () => {
  it('makes juveniles proportionally more slender than mature stems', () => {
    const sp = ALL_SPECIES.find((s) => s.id === 'pinus-ponderosa') as SpeciesDef
    const site = { productivity: 0.5, moisture: 0, competition: 0.5 }
    const young = deriveStem(sp, 0.25, 0.5, site)
    const old = deriveStem(sp, 1.0, 0.5, site)
    const slenderness = (s: { heightM: number; dbhM: number }) => s.heightM / s.dbhM
    expect(slenderness(young)).toBeGreaterThan(slenderness(old))
  })

  it('holds D ∝ H^1.5 along the growth trajectory', () => {
    const sp = ALL_SPECIES.find((s) => s.id === 'fagus-sylvatica') as SpeciesDef
    const site = { productivity: 0.5, moisture: 0, competition: 0.5 }
    const a = deriveStem(sp, 0.4, 0.5, site)
    const b = deriveStem(sp, 0.9, 0.5, site)
    const ratioH = b.heightM / a.heightM
    const ratioD = b.dbhM / a.dbhM
    expect(ratioD).toBeCloseTo(Math.pow(ratioH, ELASTIC_SIMILARITY_EXPONENT), 6)
  })
})

describe('derived stems stay inside their species envelope', () => {
  const corners = [0, 0.5, 1]
  it.each(ALL_SPECIES.map((s) => [s.id, s] as const))('%s', (_id, sp) => {
    for (const productivity of corners) {
      for (const moisture of [-1, 0, 1]) {
        for (const competition of corners) {
          for (const vigour of corners) {
            for (const age of [0.01, 0.5, 1]) {
              const d = deriveStem(sp, age, vigour, { productivity, moisture, competition })

              // Height and DBH: a MATURE stem is inside the declared range; a juvenile is
              // below it, never above.
              expect(d.heightM).toBeGreaterThan(0)
              expect(d.heightM).toBeLessThanOrEqual(sp.heightM[1] + 1e-9)
              expect(d.dbhM).toBeLessThanOrEqual(sp.dbhM[1] + 1e-9)

              // ACCEPTANCE CRITERION: "every species' derived crown base falls inside its
              // declared crownBaseFraction range".
              const frac = d.heightM > 0 ? d.crownBaseM / d.heightM : 0
              expect(frac).toBeGreaterThanOrEqual(sp.crownBaseFraction[0] - 1e-9)
              expect(frac).toBeLessThanOrEqual(sp.crownBaseFraction[1] + 1e-9)

              // The two quantities Van Wagner's criteria consume directly.
              expect(d.crownBulkDensity).toBeGreaterThanOrEqual(sp.crownBulkDensity[0] - 1e-9)
              expect(d.crownBulkDensity).toBeLessThanOrEqual(sp.crownBulkDensity[1] + 1e-9)
              expect(d.foliarMoisture).toBeGreaterThanOrEqual(sp.foliarMoisture[0] - 1e-9)
              expect(d.foliarMoisture).toBeLessThanOrEqual(sp.foliarMoisture[1] + 1e-9)

              expect(d.crownRadiusM).toBeGreaterThan(0)
              expect(d.crownBaseM).toBeLessThan(d.heightM + 1e-9)
            }
          }
        }
      }
    }
  })

  it('reaches exactly the declared mature bounds at the extremes', () => {
    const sp = ALL_SPECIES.find((s) => s.id === 'pinus-ponderosa') as SpeciesDef
    // rank = 0.75·vigour + 0.25·productivity, so both at 0 (or 1) hit the range ends exactly.
    expect(matureHeight(sp, sizeRank(0, 0))).toBeCloseTo(sp.heightM[0], 12)
    expect(matureHeight(sp, sizeRank(1, 1))).toBeCloseTo(sp.heightM[1], 12)
    expect(matureDbh(sp, sizeRank(0, 0))).toBeCloseTo(sp.dbhM[0], 12)
    expect(matureDbh(sp, sizeRank(1, 1))).toBeCloseTo(sp.dbhM[1], 12)
  })
})

describe('crown recession responds to competition and age', () => {
  const sp = ALL_SPECIES.find((s) => s.id === 'pseudotsuga-menziesii') as SpeciesDef

  it('lifts the crown base fraction in a crowded stand', () => {
    const open = deriveStem(sp, 1, 0.5, { productivity: 0.5, moisture: 0, competition: 0 })
    const dense = deriveStem(sp, 1, 0.5, { productivity: 0.5, moisture: 0, competition: 1 })
    expect(dense.crownBaseM / dense.heightM).toBeGreaterThan(open.crownBaseM / open.heightM)
  })

  it('narrows crowns in a crowded stand', () => {
    const open = deriveStem(sp, 1, 0.5, { productivity: 0.5, moisture: 0, competition: 0 })
    const dense = deriveStem(sp, 1, 0.5, { productivity: 0.5, moisture: 0, competition: 1 })
    expect(dense.crownRadiusM).toBeLessThan(open.crownRadiusM)
  })

  it('raises foliar moisture on moist sites and never touches drynessPlaceholder', () => {
    const dry = deriveStem(sp, 1, 0.5, { productivity: 0.5, moisture: -1, competition: 0.5 })
    const wet = deriveStem(sp, 1, 0.5, { productivity: 0.5, moisture: 1, competition: 0.5 })
    expect(wet.foliarMoisture).toBeGreaterThan(dry.foliarMoisture)
    expect(dry.foliarMoisture).toBeCloseTo(sp.foliarMoisture[0], 12)
    expect(wet.foliarMoisture).toBeCloseTo(sp.foliarMoisture[1], 12)
  })
})

describe('quadrature predictors are the sampler’s infinite-sample limit', () => {
  it('E[g(age)^3] matches a Monte-Carlo sample', () => {
    const maturity = 0.62
    const predicted = expectedGrowthPower('conifer', maturity, 3, 64)
    const rng = makeRng(20260818)
    const n = 400_000
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += Math.pow(growthFraction(ageFromQuantile(rng(), maturity), 'conifer'), 3)
    }
    expect(predicted).toBeCloseTo(sum / n, 2)
  })

  it('E[matureDBH²] matches a Monte-Carlo sample over the vigour draw', () => {
    const sp = ALL_SPECIES.find((s) => s.id === 'quercus-robur') as SpeciesDef
    const productivity = 0.63
    const predicted = expectedMatureDbhSquared(sp, productivity, 64)
    const rng = makeRng(7717)
    const n = 400_000
    let sum = 0
    for (let i = 0; i < n; i++) {
      const d = matureDbh(sp, sizeRank(triangularQuantile(rng()), productivity))
      sum += d * d
    }
    expect(predicted).toBeCloseTo(sum / n, 3)
  })

  it('E[basal area] matches a Monte-Carlo sample of the full derivation', () => {
    const sp = ALL_SPECIES.find((s) => s.id === 'pinus-ponderosa') as SpeciesDef
    const maturity = 0.6
    const productivity = 0.55
    const predicted = expectedBasalAreaM2(sp, productivity, maturity, {
      ageNodes: 64,
      vigourNodes: 48,
    })

    const rng = makeRng(0xbeef)
    const n = 300_000
    let sum = 0
    for (let i = 0; i < n; i++) {
      const age = ageFromQuantile(rng(), maturity)
      const vigour = triangularQuantile(rng())
      // Competition deliberately varied: it must NOT affect DBH, or the predictor becomes
      // circular. If someone routes competition into diameter growth, this test fails.
      const d = deriveStem(sp, age, vigour, { productivity, moisture: 0, competition: rng() })
      sum += (Math.PI / 4) * d.dbhM * d.dbhM
    }
    const measured = sum / n
    expect(Math.abs(predicted - measured) / measured).toBeLessThan(0.02)
  })
})

describe('per-stem draws are hashed, not streamed', () => {
  it('gives the same parameters for the same position regardless of order', () => {
    const a = stemDraws(stemHashSeed(1234, 512.25, 128.75), 0.6)
    const b = stemDraws(stemHashSeed(1234, 512.25, 128.75), 0.6)
    expect(a).toEqual(b)
  })

  it('decorrelates neighbouring positions', () => {
    // Adjacent stems must not share an age; a weak hash shows up here as visible banding in
    // the generated forest.
    const ages: number[] = []
    for (let i = 0; i < 64; i++) ages.push(stemDraws(stemHashSeed(9, 100 + i * 0.5, 100), 0.6).age)
    const mean = ages.reduce((s, v) => s + v, 0) / ages.length
    let lag1 = 0
    let variance = 0
    for (let i = 0; i < ages.length; i++) {
      const d = (ages[i] as number) - mean
      variance += d * d
      if (i > 0) lag1 += d * ((ages[i - 1] as number) - mean)
    }
    expect(Math.abs(lag1 / variance)).toBeLessThan(0.3)
  })

  it('changes the whole draw when the world seed changes', () => {
    const a = stemDraws(stemHashSeed(1, 300, 300), 0.6)
    const b = stemDraws(stemHashSeed(2, 300, 300), 0.6)
    expect(a.age).not.toBeCloseTo(b.age, 6)
  })
})
