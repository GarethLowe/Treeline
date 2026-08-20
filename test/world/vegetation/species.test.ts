/**
 * The species table is data, so the tests over it are consistency and provenance tests: they
 * cannot check that a ponderosa is 30 m tall, but they can check that no range is inverted,
 * no moisture is secretly a percentage, no biome is missing its fire carriers, and no species
 * mix references something that does not exist.
 *
 * The unit checks in particular are worth having. §0.6 warns that a moisture stored as a
 * percent instead of a fraction produces "a fire that spreads, looks plausible, and is
 * wrong"; a value above ~4 in a `MoistureFraction` field is that bug, caught at build time.
 */

import { describe, expect, it } from 'vitest'
import { BIOME_IDS, type BiomeId, type SpeciesDef } from '@contracts/world'
import { BIOMES, BIOME_EXTRAS } from '../../../src/world/vegetation/biomes.ts'
import { ALL_SPECIES, SPECIES_BY_ID, isStemForming, speciesForBiome } from '../../../src/world/vegetation/species.ts'

describe('species table', () => {
  it('has unique ids', () => {
    const ids = ALL_SPECIES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(ALL_SPECIES.map((s) => [s.id, s] as const))('%s has well-ordered ranges', (_id, sp) => {
    expect(sp.heightM[0]).toBeGreaterThan(0)
    expect(sp.heightM[1]).toBeGreaterThanOrEqual(sp.heightM[0])
    expect(sp.dbhM[0]).toBeGreaterThan(0)
    expect(sp.dbhM[1]).toBeGreaterThanOrEqual(sp.dbhM[0])
    expect(sp.crownBaseFraction[1]).toBeGreaterThanOrEqual(sp.crownBaseFraction[0])
    expect(sp.crownBulkDensity[1]).toBeGreaterThanOrEqual(sp.crownBulkDensity[0])
    expect(sp.foliarMoisture[1]).toBeGreaterThanOrEqual(sp.foliarMoisture[0])
  })

  it.each(ALL_SPECIES.map((s) => [s.id, s] as const))(
    '%s keeps crown base as a fraction in [0, 1)',
    (_id, sp) => {
      expect(sp.crownBaseFraction[0]).toBeGreaterThanOrEqual(0)
      // A crown base at or above the tree top is not a tree.
      expect(sp.crownBaseFraction[1]).toBeLessThan(1)
    },
  )

  it.each(ALL_SPECIES.map((s) => [s.id, s] as const))(
    '%s stores foliar moisture as a FRACTION, not a percent (§0.6 rule 3)',
    (_id, sp) => {
      // §0.6: "Oven-dry-mass fraction, range [0, ~4]". A transcribed percentage lands at 95,
      // not 0.95, so this bound is the tripwire for the single most damaging unit error in
      // the project.
      expect(sp.foliarMoisture[0]).toBeGreaterThan(0)
      expect(sp.foliarMoisture[1]).toBeLessThanOrEqual(4)
    },
  )

  it.each(ALL_SPECIES.map((s) => [s.id, s] as const))(
    '%s has a physically plausible crown bulk density',
    (_id, sp) => {
      // Within-crown, not stand-level (see species.ts header). Even the densest shrub crown
      // is far below the ~500 kg m⁻³ of solid wood.
      expect(sp.crownBulkDensity[0]).toBeGreaterThan(0)
      expect(sp.crownBulkDensity[1]).toBeLessThan(10)
    },
  )

  it.each(ALL_SPECIES.filter((s) => s.form === 'conifer' || s.form === 'broadleaf').map((s) => [s.id, s] as const))(
    '%s size ranges are mutually consistent under elastic similarity',
    (_id, sp) => {
      // D ∝ H^1.5 (McMahon 1973), so a height range spanning a factor f implies a diameter
      // range spanning f^1.5. If these drift apart, the smallest mature stem of the species is
      // a broomstick and the largest is a stump — and, worse, the mean stem's basal area stops
      // being anything a real stand carries. This is the check that caught the first draft's
      // 100 m²/ha ponderosa stand.
      const heightRatio = sp.heightM[1] / sp.heightM[0]
      const dbhRatio = sp.dbhM[1] / sp.dbhM[0]
      expect(dbhRatio / Math.pow(heightRatio, 1.5)).toBeGreaterThan(0.9)
      expect(dbhRatio / Math.pow(heightRatio, 1.5)).toBeLessThan(1.1)
    },
  )

  it.each(ALL_SPECIES.filter((s) => s.form === 'conifer' || s.form === 'broadleaf').map((s) => [s.id, s] as const))(
    '%s has a plausible height-to-diameter ratio at mid-range',
    (_id, sp) => {
      const hd =
        ((sp.heightM[0] + sp.heightM[1]) / 2) / ((sp.dbhM[0] + sp.dbhM[1]) / 2)
      // Open-grown savanna oaks sit near 25; slender stand-grown conifers near 75. Outside
      // 15–110 the tree is not a shape that stands up.
      expect(hd).toBeGreaterThan(15)
      expect(hd).toBeLessThan(110)
    },
  )

  it('flags the ribbon-bark eucalypt as a firebrand source (§60 §7.1.3)', () => {
    const ribbon = ALL_SPECIES.filter((s) => s.bark === 'decorticating-ribbon')
    expect(ribbon.length).toBeGreaterThan(0)
    for (const sp of ribbon) expect(sp.firebrandSource).toBe(true)
  })

  it('flags both stringybark eucalypts as firebrand sources (§60 §7.1.3)', () => {
    for (const id of ['eucalyptus-obliqua', 'eucalyptus-marginata']) {
      expect(SPECIES_BY_ID.get(id)?.firebrandSource).toBe(true)
    }
  })

})

describe('biomes', () => {
  it('defines all five locked biomes (§0.2)', () => {
    for (const id of BIOME_IDS) expect(BIOMES[id]).toBeDefined()
    expect(Object.keys(BIOMES).sort()).toEqual([...BIOME_IDS].sort())
  })

  it.each(BIOME_IDS)('%s has at least one stem-forming species', (id: BiomeId) => {
    expect(speciesForBiome(id).some(isStemForming)).toBe(true)
  })

  it.each(BIOME_IDS)('%s species mix references only species in that biome', (id: BiomeId) => {
    const inBiome = new Set(speciesForBiome(id).map((s) => s.id))
    for (const key of Object.keys(BIOMES[id].defaultVegetation.speciesMix)) {
      expect(inBiome.has(key), `${id} mixes ${key}, which is not in the biome`).toBe(true)
    }
  })

  it.each(BIOME_IDS)('%s has sane default vegetation parameters', (id: BiomeId) => {
    const v = BIOMES[id].defaultVegetation
    expect(v.stemDensityPerHa).toBeGreaterThan(0)
    expect(v.clustering).toBeGreaterThanOrEqual(0)
    expect(v.clustering).toBeLessThanOrEqual(1)
    expect(v.maturity).toBeGreaterThan(0)
    expect(v.maturity).toBeLessThan(1)
    expect(v.understoryCover).toBeGreaterThanOrEqual(0)
    expect(v.understoryCover).toBeLessThanOrEqual(1)
  })

  it.each(BIOME_IDS)('%s separation factor keeps dart-throwing convergent', (id: BiomeId) => {
    // Dart throwing saturates around 0.55 of hexagonal packing, i.e. it stops reaching the
    // target count once the exclusion coefficient c in r = c·λ^(-1/2) exceeds about 0.8.
    // Guarding it here means a future tweak to a biome's spacing cannot silently start
    // under-filling the domain and quietly break the density acceptance criterion.
    const c = BIOME_EXTRAS[id].separationFactor * 0.5
    expect(c).toBeLessThan(0.8)
    expect(c).toBeGreaterThan(0.1)
  })

  it('gives chaparral and gorse no meaningful crown base height (§30 §7.1)', () => {
    // "chaparral, where there is no meaningful CBH because fuel is vertically continuous"
    const continuous = ['adenostoma-fasciculatum', 'arctostaphylos-glandulosa', 'ceanothus-megacarpus', 'ulex-europaeus']
    for (const id of continuous) {
      const sp = SPECIES_BY_ID.get(id) as SpeciesDef
      expect(sp.crownBaseFraction[0]).toBe(0)
      expect(sp.crownBaseFraction[1]).toBeLessThanOrEqual(0.1)
    }
  })

  it('routes gorse through SH7, the fuel model §20 §4.3 names for it', () => {
    expect(SPECIES_BY_ID.get('ulex-europaeus')?.surfaceFuelModel).toBe('SH7')
  })

  it('carries the UK fire carriers named in §60 §7.3.2', () => {
    const uk = new Set(speciesForBiome('uk-mixed-field-forest').map((s) => s.id))
    for (const id of ['calluna-vulgaris', 'pteridium-aquilinum', 'ulex-europaeus']) {
      expect(uk.has(id), `UK biome is missing ${id}`).toBe(true)
    }
  })
})
