/**
 * THE acceptance test for WP 1.4 (spec §91, M1 row 1.4).
 *
 *   "Generated crown base height and foliar biomass match the stem's *physical* parameters
 *    within 10% — geometry is derived from fuel data, not authored independently."
 *
 * `TreeMesh.derived` is computed by `measureTree`, which reads nothing but triangles: vertex
 * positions and triangle areas out of the finished LOD 0. This file compares those
 * measurements against the Stem that asked for the tree. If the two ever drift apart, the
 * picture and the physics have come apart, and a crown-fire model reading `Stem.crownBaseM`
 * would be describing a tree the player is not looking at.
 *
 * Two paths are checked, because they fail differently:
 *
 *   1. `generateTree` called with the stem's exact parameters — isolates *geometric* error.
 *      This is the number that has to stay small, because the cache's quantisation budget is
 *      whatever it leaves behind.
 *   2. `TreeMeshSet.get(stem)` — the path the renderer actually uses, where quantisation
 *      error stacks on top. This is the one the acceptance criterion is written against.
 */

import { describe, expect, it } from 'vitest'
import { BIOME_IDS, type SpeciesDef, type Stem } from '@contracts/world.ts'
import { generateTree } from '@world/trees/generateTree.ts'
import { crownVolumeM3, VerticalMassProfile } from '@world/trees/crownShape.ts'
import { formParamsFor } from '@world/trees/speciesForm.ts'
import { STUB_SPECIES, stubSpeciesForBiome, stubStem } from '../../fixtures/world.ts'
import { TreeMeshSet } from '@world/trees/treeMeshSet.ts'

const TOLERANCE = 0.1
const SEEDS = [1, 2, 3, 7, 11, 19, 41, 97, 123, 404, 1337, 20260818]

interface Deviation {
  readonly label: string
  readonly height: number
  readonly crownBase: number
  readonly bulkDensity: number
  readonly biomass: number
}

const rel = (measured: number, declared: number): number =>
  Math.abs(measured - declared) / Math.max(1e-12, Math.abs(declared))

/** The foliar biomass the Stem's physics implies: CBD x crown volume. */
function declaredBiomassKg(species: SpeciesDef, stem: Stem): number {
  const f = formParamsFor(species)
  return stem.crownBulkDensity * crownVolumeM3(f, stem.crownRadiusM, stem.heightM - stem.crownBaseM)
}

function exactPathDeviation(species: SpeciesDef, stem: Stem, seed: number): Deviation {
  const g = generateTree({
    species,
    heightM: stem.heightM,
    crownBaseM: stem.crownBaseM,
    crownRadiusM: stem.crownRadiusM,
    crownBulkDensityKgM3: stem.crownBulkDensity,
    dbhM: stem.dbhM,
    seed,
    hasLadderFuels: stem.hasLadderFuels,
  })
  const d = g.mesh.derived
  return {
    label: `${species.id}#${seed}`,
    height: rel(d.heightM, stem.heightM),
    crownBase: rel(d.crownBaseM, stem.crownBaseM),
    bulkDensity: rel(d.crownBulkDensity, stem.crownBulkDensity),
    biomass: rel(d.foliarBiomassKg, declaredBiomassKg(species, stem)),
  }
}

function worst(devs: readonly Deviation[]): Record<string, { value: number; label: string }> {
  const keys = ['height', 'crownBase', 'bulkDensity', 'biomass'] as const
  const out: Record<string, { value: number; label: string }> = {}
  for (const k of keys) {
    let best = { value: -1, label: '' }
    for (const d of devs) if (d[k] > best.value) best = { value: d[k], label: d.label }
    out[k] = best
  }
  return out
}

describe('derived geometry matches declared fuel parameters', () => {
  it('holds for every species in every biome, across many seeds, generated exactly', () => {
    const devs: Deviation[] = []
    for (const biome of BIOME_IDS) {
      const species = stubSpeciesForBiome(biome)
      expect(species.length, `biome ${biome} has no stub species`).toBeGreaterThan(0)
      for (const s of species) {
        for (const seed of SEEDS) {
          devs.push(exactPathDeviation(s, stubStem(s, seed), seed))
        }
      }
    }

    for (const d of devs) {
      expect(d.height, `height ${d.label}`).toBeLessThan(TOLERANCE)
      expect(d.crownBase, `crown base ${d.label}`).toBeLessThan(TOLERANCE)
      expect(d.bulkDensity, `bulk density ${d.label}`).toBeLessThan(TOLERANCE)
      expect(d.biomass, `foliar biomass ${d.label}`).toBeLessThan(TOLERANCE)
    }

    // Geometric error alone must stay well inside the budget: the mesh cache spends the
    // remainder on parameter quantisation, and if this creeps up the cache has to get
    // finer, which costs memory quadratically in nothing but sloppiness.
    const w = worst(devs)
    expect(w['height']!.value, `worst height: ${w['height']!.label}`).toBeLessThan(0.03)
    expect(w['crownBase']!.value, `worst crown base: ${w['crownBase']!.label}`).toBeLessThan(0.03)
    expect(w['bulkDensity']!.value, `worst CBD: ${w['bulkDensity']!.label}`).toBeLessThan(0.06)
    expect(w['biomass']!.value, `worst biomass: ${w['biomass']!.label}`).toBeLessThan(0.06)
  })

  it('holds through the mesh cache, which is the path the renderer takes', () => {
    for (const biome of BIOME_IDS) {
      const species = stubSpeciesForBiome(biome)
      const set = new TreeMeshSet(species)
      for (const s of species) {
        for (const seed of SEEDS) {
          const stem = stubStem(s, seed)
          const d = set.get(stem).derived
          const label = `${biome}/${s.id}#${seed}`
          expect(rel(d.heightM, stem.heightM), `height ${label}`).toBeLessThan(TOLERANCE)
          expect(rel(d.crownBaseM, stem.crownBaseM), `crown base ${label}`).toBeLessThan(TOLERANCE)
          expect(
            rel(d.crownBulkDensity, stem.crownBulkDensity),
            `bulk density ${label}`,
          ).toBeLessThan(TOLERANCE)
        }
      }
    }
  })

  it('holds across a large random stand, not just hand-picked seeds', () => {
    const species = STUB_SPECIES
    const set = new TreeMeshSet(species)
    let worstHeight = 0
    let worstBase = 0
    let worstCbd = 0
    for (let i = 0; i < 400; i++) {
      const s = species[i % species.length]!
      const stem = stubStem(s, 900000 + i * 7919)
      const d = set.get(stem).derived
      worstHeight = Math.max(worstHeight, rel(d.heightM, stem.heightM))
      worstBase = Math.max(worstBase, rel(d.crownBaseM, stem.crownBaseM))
      worstCbd = Math.max(worstCbd, rel(d.crownBulkDensity, stem.crownBulkDensity))
    }
    expect(worstHeight).toBeLessThan(TOLERANCE)
    expect(worstBase).toBeLessThan(TOLERANCE)
    expect(worstCbd).toBeLessThan(TOLERANCE)
  }, 120000)
})

describe('the measurement is actually sensitive', () => {
  /**
   * A tolerance test only means something if the quantity it measures can move. These
   * perturb one declared parameter at a time and assert the measurement follows — which
   * proves `derived` is reading the geometry rather than echoing the input through a
   * constant. A stub that returned the inputs verbatim would pass every test above and fail
   * every test here.
   */
  const species = STUB_SPECIES[0]!
  const base = stubStem(species, 555)

  it('tracks a change in crown base height', () => {
    const low = generateTree({
      species,
      heightM: base.heightM,
      crownBaseM: base.crownBaseM * 0.5,
      crownRadiusM: base.crownRadiusM,
      crownBulkDensityKgM3: base.crownBulkDensity,
      dbhM: base.dbhM,
      seed: 1,
      hasLadderFuels: false,
    })
    const high = generateTree({
      species,
      heightM: base.heightM,
      crownBaseM: base.crownBaseM * 1.5,
      crownRadiusM: base.crownRadiusM,
      crownBulkDensityKgM3: base.crownBulkDensity,
      dbhM: base.dbhM,
      seed: 1,
      hasLadderFuels: false,
    })
    expect(low.mesh.derived.crownBaseM).toBeLessThan(high.mesh.derived.crownBaseM * 0.75)
    expect(rel(low.mesh.derived.crownBaseM, base.crownBaseM * 0.5)).toBeLessThan(TOLERANCE)
    expect(rel(high.mesh.derived.crownBaseM, base.crownBaseM * 1.5)).toBeLessThan(TOLERANCE)
    // A deeper crown holds more fuel at the same bulk density.
    expect(low.mesh.derived.foliarBiomassKg).toBeGreaterThan(high.mesh.derived.foliarBiomassKg)
  })

  it('tracks a change in crown bulk density roughly proportionally', () => {
    const make = (cbd: number) =>
      generateTree({
        species,
        heightM: base.heightM,
        crownBaseM: base.crownBaseM,
        crownRadiusM: base.crownRadiusM,
        crownBulkDensityKgM3: cbd,
        dbhM: base.dbhM,
        seed: 1,
        hasLadderFuels: false,
      }).mesh.derived
    const a = make(base.crownBulkDensity)
    const b = make(base.crownBulkDensity * 2)
    expect(b.crownBulkDensity / a.crownBulkDensity).toBeGreaterThan(1.85)
    expect(b.crownBulkDensity / a.crownBulkDensity).toBeLessThan(2.15)
    expect(b.foliarBiomassKg / a.foliarBiomassKg).toBeGreaterThan(1.85)
  })

  it('tracks crown radius through the foliar biomass, at constant bulk density', () => {
    const make = (r: number) =>
      generateTree({
        species,
        heightM: base.heightM,
        crownBaseM: base.crownBaseM,
        crownRadiusM: r,
        crownBulkDensityKgM3: base.crownBulkDensity,
        dbhM: base.dbhM,
        seed: 1,
        hasLadderFuels: false,
      }).mesh.derived
    const a = make(base.crownRadiusM)
    const b = make(base.crownRadiusM * 2)
    // Mass goes as the crown volume, i.e. as r^2 ...
    expect(b.foliarBiomassKg / a.foliarBiomassKg).toBeGreaterThan(3.5)
    expect(b.foliarBiomassKg / a.foliarBiomassKg).toBeLessThan(4.5)
    // ... while the bulk density, being mass over that same volume, does not move.
    expect(rel(b.crownBulkDensity, a.crownBulkDensity)).toBeLessThan(0.08)
  })
})

describe('vertical fuel distribution', () => {
  /**
   * The crown-averaged scalar is what Van Wagner's active-crowning threshold reads, but
   * torching and passive crown fire are driven by *where in the crown* the fuel sits. Spec
   * §7.5 step 3 prescribes a species vertical weighting w(t); this asserts the generated
   * geometry actually reproduces it rather than smearing the same total mass uniformly up
   * the crown, which the crown-averaged check alone would not notice.
   *
   * The comparison is on the cumulative *mass* fraction, not on the bulk-density profile.
   * CBD(t) = W f w(t) / A(t) and A(t) collapses towards the apex of a conic crown, so the
   * bulk-density profile legitimately peaks near the top where the mass profile does not —
   * comparing its peak against the mode of w would be comparing two different functions.
   */
  it('reproduces the species mass weighting through the crown', () => {
    for (const species of [STUB_SPECIES[0]!, STUB_SPECIES[7]!, STUB_SPECIES[3]!]) {
      const stem = stubStem(species, 31337)
      const g = generateTree({
        species,
        heightM: stem.heightM,
        crownBaseM: stem.crownBaseM,
        crownRadiusM: stem.crownRadiusM,
        crownBulkDensityKgM3: stem.crownBulkDensity,
        dbhM: stem.dbhM,
        seed: 5,
        hasLadderFuels: false,
      })
      const mass = g.metrics.profileMassKg
      const heights = g.metrics.profileHeightM
      expect(mass.length).toBeGreaterThan(32)

      const total = mass.reduce((a, b) => a + b, 0)
      expect(total).toBeCloseTo(g.metrics.foliarBiomassKg, 6)

      const f = formParamsFor(species)
      const profile = new VerticalMassProfile(f)
      // Invert the tabulated CDF to get the analytic cumulative fraction at a height, by
      // bisection on the quantile function (which is monotone).
      const cdfAt = (t: number): number => {
        let lo = 0
        let hi = 1
        for (let i = 0; i < 40; i++) {
          const mid = 0.5 * (lo + hi)
          if (profile.sample(mid) < t) lo = mid
          else hi = mid
        }
        return 0.5 * (lo + hi)
      }

      const depth = g.metrics.crownTopM - g.metrics.crownBaseM
      let cumulative = 0
      let worstGap = 0
      for (let i = 0; i < mass.length; i++) {
        cumulative += mass[i]!
        const t = Math.min(1, (heights[i]! + 0.5 * (depth / mass.length) - g.metrics.crownBaseM) / depth)
        worstGap = Math.max(worstGap, Math.abs(cumulative / total - cdfAt(t)))
      }
      // Kolmogorov-style sup-norm on the cumulative mass fraction.
      expect(worstGap, species.id).toBeLessThan(0.06)
    }
  })

  it('is a genuine profile, not a uniform slab of fuel', () => {
    const species = STUB_SPECIES[0]!
    const stem = stubStem(species, 31337)
    const g = generateTree({
      species,
      heightM: stem.heightM,
      crownBaseM: stem.crownBaseM,
      crownRadiusM: stem.crownRadiusM,
      crownBulkDensityKgM3: stem.crownBulkDensity,
      dbhM: stem.dbhM,
      seed: 5,
      hasLadderFuels: false,
    })
    const mass = g.metrics.profileMassKg
    const n = mass.length
    const uniform = mass.reduce((a, b) => a + b, 0) / n
    let peak = 0
    for (const v of mass) peak = Math.max(peak, v)
    // A Beta-weighted crown peaks well above its own mean; a uniform one would not.
    expect(peak / uniform).toBeGreaterThan(1.3)
    // And the lowest whorl carries much less mass than the peak.
    expect(mass[0]! / peak).toBeLessThan(0.6)
  })
})
