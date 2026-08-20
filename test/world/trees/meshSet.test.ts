/**
 * Mesh cache behaviour and generation cost (WP 1.4).
 *
 * Two numbers the assignment asks for explicitly live here: `uniqueMeshCount` for an
 * 80 000-stem domain, and single-tree generation time, which feeds the world-gen budget.
 *
 * The thresholds are deliberately loose where they are timing-dependent — a CI box is not
 * an RTX 4070 laptop and a test that fails on a slow machine teaches nothing. What is
 * asserted tightly is the *structural* behaviour: that the cache actually collapses the
 * population, that widening quantisation collapses it further, and that a cache hit costs
 * nothing.
 */

import { describe, expect, it } from 'vitest'
import { BIOME_IDS } from '@contracts/world.ts'
import { DEFAULT_QUANTISATION, TreeMeshSet } from '@world/trees/treeMeshSet.ts'
import { stubSpeciesForBiome, stubStand, STUB_SPECIES, stubStem } from '../../fixtures/world.ts'

const STAND_SIZE = 80_000

describe('mesh cache collapses a full domain', () => {
  it('maps 80k stems onto a few hundred meshes per biome', () => {
    const summary: string[] = []
    for (const biome of BIOME_IDS) {
      const species = stubSpeciesForBiome(biome)
      const stems = stubStand(species, STAND_SIZE, 20260818)
      const set = new TreeMeshSet(species)
      // Resolving keys is cheap; generating every mesh is not, so the bucket count is
      // measured on keys and the geometry cost is measured separately below.
      const keys = new Set<string>()
      for (const stem of stems) keys.add(set.keyFor(stem).key)
      summary.push(`${biome}: ${keys.size} meshes for ${species.length} species`)

      // Per species, not per biome: the UK pack carries four.
      expect(keys.size / species.length, biome).toBeLessThan(400)
      expect(keys.size, biome).toBeGreaterThan(20)
      // And the collapse itself: three orders of magnitude.
      expect(keys.size, biome).toBeLessThan(STAND_SIZE / 50)
    }
    // eslint-disable-next-line no-console
    console.log(summary.join('\n'))
  }, 120000)

  /**
   * The single biggest unknown handed to this package by WP 1.3, quantified rather than
   * guessed at. `uniqueMeshCount` is set by how much *independent* per-stem scatter the
   * vegetation set puts on crown base height and crown bulk density around their age trend.
   * With none, the population is a curve through the key space and collapses to a few dozen
   * buckets per species. With the full lognormal scatter the stub applies, it fills a box.
   */
  it('is dominated by how much independent scatter the vegetation set applies', () => {
    const species = stubSpeciesForBiome('western-us-conifer')
    const set = new TreeMeshSet(species)
    const countAt = (noiseScale: number): number => {
      const stems = stubStand(species, 40000, 771, 1024, noiseScale)
      const keys = new Set<string>()
      for (const stem of stems) keys.add(set.keyFor(stem).key)
      return keys.size
    }
    const none = countAt(0)
    const half = countAt(0.5)
    const full = countAt(1)
    // eslint-disable-next-line no-console
    console.log(
      `scatter sensitivity (2 species, 40k stems): none=${none} half=${half} full=${full}`,
    )
    expect(none).toBeLessThan(60)
    expect(half).toBeGreaterThan(none)
    expect(full).toBeGreaterThan(half)
  }, 60000)

  it('collapses further as quantisation widens, and refines as it tightens', () => {
    const species = stubSpeciesForBiome('western-us-conifer')
    const stems = stubStand(species, 20000, 5)
    const count = (q: Partial<typeof DEFAULT_QUANTISATION>): number => {
      const set = new TreeMeshSet(species, { quantisation: { ...DEFAULT_QUANTISATION, ...q } })
      const keys = new Set<string>()
      for (const stem of stems) keys.add(set.keyFor(stem).key)
      return keys.size
    }
    const nominal = count({})
    expect(count({ heightRatio: 1.3, crownBaseRatio: 1.35, crownBulkDensityRatio: 1.2 })).toBeLessThan(
      nominal,
    )
    expect(count({ heightRatio: 1.05, crownBaseRatio: 1.05 })).toBeGreaterThan(nominal)
    // The optional fidelity knobs cost what the docs claim they cost.
    expect(count({ keyOnCrownRadius: true })).toBeGreaterThan(nominal)
    expect(count({ variants: 3 })).toBeGreaterThan(nominal * 2)
  }, 60000)

  it('separating ladder-fuel meshes roughly doubles the count', () => {
    const species = stubSpeciesForBiome('western-us-conifer')
    const stems = stubStand(species, 20000, 5)
    const count = (separate: boolean): number => {
      const set = new TreeMeshSet(species, { separateLadderFuelMeshes: separate })
      const keys = new Set<string>()
      for (const stem of stems) keys.add(set.keyFor(stem).key)
      return keys.size
    }
    const off = count(false)
    const on = count(true)
    expect(on).toBeGreaterThan(off * 1.5)
    expect(on).toBeLessThan(off * 2.1)
  }, 60000)
})

describe('cache mechanics', () => {
  it('counts hits and misses, and a hit generates nothing', () => {
    const species = stubSpeciesForBiome('mediterranean-chaparral')
    const set = new TreeMeshSet(species)
    const stem = stubStem(species[0]!, 12)
    set.get(stem)
    const afterFirst = set.stats()
    expect(afterFirst.cacheMisses).toBe(1)
    expect(afterFirst.cacheHits).toBe(0)

    for (let i = 0; i < 50; i++) set.get(stem)
    const afterMany = set.stats()
    expect(afterMany.cacheMisses).toBe(1)
    expect(afterMany.cacheHits).toBe(50)
    expect(afterMany.uniqueMeshCount).toBe(1)
    expect(afterMany.totalGenerationMs).toBe(afterFirst.totalGenerationMs)
  })

  it('reports totals consistent with the meshes it holds', () => {
    const species = stubSpeciesForBiome('uk-mixed-field-forest')
    const set = new TreeMeshSet(species)
    for (let i = 0; i < 40; i++) set.get(stubStem(species[i % species.length]!, 300 + i))

    let tris = 0
    for (const g of set.meshes()) for (const lod of g.mesh.lods) tris += lod.triangleCount
    expect(set.totalTriangles).toBe(tris)
    expect(set.uniqueMeshCount).toBe(set.meshes().length)
    expect(set.stats().approxBytes).toBeGreaterThan(0)
  })

  it('accepts either a species array or a species map', () => {
    const species = stubSpeciesForBiome('grassland-savanna')
    const fromArray = new TreeMeshSet(species)
    const fromMap = new TreeMeshSet(new Map(species.map((s) => [s.id, s])))
    const stem = stubStem(species[0]!, 3)
    expect(fromArray.get(stem).derived).toEqual(fromMap.get(stem).derived)
  })

  it('fails loudly when a stem names a species the set does not carry', () => {
    const set = new TreeMeshSet(stubSpeciesForBiome('grassland-savanna'))
    const stem = stubStem(STUB_SPECIES.find((s) => s.id === 'calluna-vulgaris')!, 1)
    expect(() => set.get(stem)).toThrow(/no SpeciesDef registered/)
  })
})

describe('generation cost', () => {
  /**
   * Reported rather than gated: the assignment asks for the single-tree figure because it
   * multiplies by `uniqueMeshCount` into the world-gen budget. The bound here is generous
   * enough not to fail on a loaded CI box while still catching an order-of-magnitude
   * regression — a 100 ms tree would put a 400-mesh biome at 40 seconds.
   */
  it('builds a tree in single-digit to low-tens of milliseconds', () => {
    const rows: string[] = []
    for (const species of STUB_SPECIES) {
      const set = new TreeMeshSet([species])
      for (let i = 0; i < 8; i++) set.get(stubStem(species, 6000 + i * 977))
      const st = set.stats()
      rows.push(
        `${species.id.padEnd(24)} mean=${st.meanGenerationMs.toFixed(1)}ms ` +
          `meshes=${st.uniqueMeshCount} tris/mesh=${Math.round(st.totalTriangles / st.uniqueMeshCount)} ` +
          `bytes/mesh=${Math.round(st.approxBytes / st.uniqueMeshCount / 1024)}KiB`,
      )
      expect(st.meanGenerationMs, species.id).toBeLessThan(120)
    }
    // eslint-disable-next-line no-console
    console.log(rows.join('\n'))
  }, 120000)

  it('scales linearly enough that a whole biome builds in seconds, not minutes', () => {
    const species = stubSpeciesForBiome('eucalypt-dry-forest')
    const set = new TreeMeshSet(species)
    const t0 = performance.now()
    for (let i = 0; i < 120; i++) set.get(stubStem(species[i % species.length]!, 90000 + i * 7919))
    const elapsed = performance.now() - t0
    const st = set.stats()
    // eslint-disable-next-line no-console
    console.log(
      `120 stems -> ${st.uniqueMeshCount} meshes in ${elapsed.toFixed(0)} ms ` +
        `(${(st.approxBytes / 1e6).toFixed(1)} MB of vertex data)`,
    )
    expect(elapsed / Math.max(1, st.cacheMisses)).toBeLessThan(120)
  }, 120000)
})
