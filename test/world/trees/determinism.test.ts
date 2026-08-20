/**
 * Determinism of tree generation (WP 1.4).
 *
 * Spec §0.2 makes world generation seeded and reproducible, and §90.1 makes each work
 * package independently verifiable. Both need generation to be a pure function of
 * (species, parameters, seed) — not of iteration order, not of how many trees were built
 * before, and not of which worker thread got the job. That is a stronger claim than "looks
 * the same": it has to be byte-identical, because the mesh cache hands one generated buffer
 * to every stem in a bucket and a per-run difference would show up as a fuel difference.
 */

import { describe, expect, it } from 'vitest'
import type { TreeLod, TreeMesh } from '@contracts/world.ts'
import { generateTree } from '@world/trees/generateTree.ts'
import { STUB_SPECIES, stubSpeciesForBiome, stubStem } from '../../fixtures/world.ts'
import { TreeMeshSet } from '@world/trees/treeMeshSet.ts'
import { BIOME_IDS } from '@contracts/world.ts'
import { Rng, hashString, mixSeed } from '@world/trees/rng.ts'

function make(speciesIndex: number, seed: number): TreeMesh {
  const species = STUB_SPECIES[speciesIndex]!
  const stem = stubStem(species, 42)
  return generateTree({
    species,
    heightM: stem.heightM,
    crownBaseM: stem.crownBaseM,
    crownRadiusM: stem.crownRadiusM,
    crownBulkDensityKgM3: stem.crownBulkDensity,
    dbhM: stem.dbhM,
    seed,
    hasLadderFuels: stem.hasLadderFuels,
  }).mesh
}

function expectIdenticalLod(a: TreeLod, b: TreeLod, label: string): void {
  expect(a.triangleCount, `${label} triangleCount`).toBe(b.triangleCount)
  expect(a.positions.length, `${label} vertex count`).toBe(b.positions.length)
  expect(Array.from(a.positions), `${label} positions`).toEqual(Array.from(b.positions))
  expect(Array.from(a.normals), `${label} normals`).toEqual(Array.from(b.normals))
  expect(Array.from(a.uvs), `${label} uvs`).toEqual(Array.from(b.uvs))
  expect(Array.from(a.indices), `${label} indices`).toEqual(Array.from(b.indices))
  expect(a.submeshes, `${label} submeshes`).toEqual(b.submeshes)
}

describe('generation is a pure function of species, parameters and seed', () => {
  it('produces byte-identical geometry on repeat calls', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      const a = make(i, 8080)
      const b = make(i, 8080)
      for (let level = 0; level < a.lods.length; level++) {
        expectIdenticalLod(a.lods[level]!, b.lods[level]!, `${STUB_SPECIES[i]!.id} LOD${level}`)
      }
      expect(a.derived).toEqual(b.derived)
    }
  })

  it('does not depend on how many trees were generated before it', () => {
    const reference = make(2, 999)
    // Burn a lot of unrelated generation in between. If any module held mutable global
    // state — a shared RNG, a cached buffer, an interned array — this would drift.
    for (let i = 0; i < 6; i++) make(i, 100 + i)
    const later = make(2, 999)
    expectIdenticalLod(reference.lods[0]!, later.lods[0]!, 'after other work')
  })

  it('changes with the seed', () => {
    const a = make(0, 1)
    const b = make(0, 2)
    expect(Array.from(a.lods[0]!.positions)).not.toEqual(Array.from(b.lods[0]!.positions))
    // ... but the fuel state it represents does not: same physical parameters in, same
    // physical parameters measured back out. Seed varies appearance, never fuel.
    // Tolerances here are f32 vertex quantisation, not model slop: the extremes are card
    // corners stored as float32, so different jitter lands on different rounding.
    expect(a.derived.crownBaseM / b.derived.crownBaseM).toBeCloseTo(1, 4)
    expect(a.derived.heightM / b.derived.heightM).toBeCloseTo(1, 4)
    expect(a.derived.crownBulkDensity / b.derived.crownBulkDensity).toBeCloseTo(1, 1)
  })

  it('changes with the species', () => {
    const a = make(0, 5)
    const b = make(3, 5)
    expect(a.lods[0]!.positions.length).not.toBe(b.lods[0]!.positions.length)
  })
})

describe('the mesh cache is order-independent', () => {
  it('returns the same object for two stems in the same bucket, whichever arrives first', () => {
    const species = stubSpeciesForBiome('western-us-conifer')
    const forward = new TreeMeshSet(species)
    const reverse = new TreeMeshSet(species)
    const stems = Array.from({ length: 60 }, (_, i) => {
      const s = species[i % species.length]!
      return stubStem(s, 700 + i)
    })

    for (const stem of stems) forward.get(stem)
    for (const stem of [...stems].reverse()) reverse.get(stem)

    expect(forward.uniqueMeshCount).toBe(reverse.uniqueMeshCount)
    for (const stem of stems) {
      const a = forward.get(stem)
      const b = reverse.get(stem)
      expectIdenticalLod(a.lods[0]!, b.lods[0]!, `${stem.speciesId} order`)
      expect(a.derived).toEqual(b.derived)
    }
  })

  it('hands the identical mesh instance to every stem in a bucket', () => {
    const species = stubSpeciesForBiome('eucalypt-dry-forest')
    const set = new TreeMeshSet(species)
    const byKey = new Map<string, TreeMesh>()
    for (let i = 0; i < 300; i++) {
      const s = species[i % species.length]!
      const stem = stubStem(s, 5000 + i)
      const key = set.keyFor(stem).key
      const mesh = set.get(stem)
      const seen = byKey.get(key)
      if (seen === undefined) byKey.set(key, mesh)
      // Identity, not equality: sharing the buffer is the entire point of the cache.
      else expect(mesh).toBe(seen)
    }
    expect(set.uniqueMeshCount).toBe(byKey.size)
  })

  it('gives the same mesh for the same stem across independently constructed sets', () => {
    for (const biome of BIOME_IDS) {
      const species = stubSpeciesForBiome(biome)
      const a = new TreeMeshSet(species)
      const b = new TreeMeshSet(species)
      const stem = stubStem(species[0]!, 31)
      expectIdenticalLod(a.get(stem).lods[0]!, b.get(stem).lods[0]!, biome)
    }
  })
})

describe('the RNG itself', () => {
  it('is reproducible and reasonably uniform', () => {
    const a = new Rng(12345)
    const b = new Rng(12345)
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next())

    const rng = new Rng(7)
    let sum = 0
    let min = 1
    let max = 0
    const n = 200000
    for (let i = 0; i < n; i++) {
      const v = rng.next()
      sum += v
      min = Math.min(min, v)
      max = Math.max(max, v)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(sum / n).toBeCloseTo(0.5, 2)
    expect(min).toBeLessThan(0.001)
    expect(max).toBeGreaterThan(0.999)
  })

  it('produces well-separated streams from nearby seeds', () => {
    // Consecutive stem seeds are common; if mixing were weak, neighbouring trees in the
    // world would share geometry jitter and the stand would show visible banding.
    const first = Array.from({ length: 64 }, (_, i) => new Rng(mixSeed(1000 + i, 0x9e37)).next())
    for (let i = 1; i < first.length; i++) {
      expect(Math.abs(first[i]! - first[i - 1]!)).toBeGreaterThan(1e-4)
    }
  })

  it('hashes strings stably and distinctly', () => {
    expect(hashString('pinus-ponderosa')).toBe(hashString('pinus-ponderosa'))
    const ids = new Set(STUB_SPECIES.map((s) => hashString(s.id)))
    expect(ids.size).toBe(STUB_SPECIES.length)
  })

  it('gaussian draws are clamped and centred', () => {
    const rng = new Rng(3)
    let sum = 0
    const n = 50000
    for (let i = 0; i < n; i++) {
      const v = rng.clampedGaussian(2.5)
      expect(Math.abs(v)).toBeLessThanOrEqual(2.5)
      sum += v
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.03)
  })
})
