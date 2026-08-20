/**
 * Structural sanity and triangle budgets for generated tree meshes (WP 1.4).
 *
 * These are the checks a screenshot cannot make. A mesh with an inverted winding, a
 * zero-area sliver, an index past the end of the vertex buffer, or a submesh range that does
 * not tile the index buffer will still render — badly, or intermittently, or only on one
 * driver — and it will still look like a tree.
 */

import { describe, expect, it } from 'vitest'
import type { TreeLod } from '@contracts/world.ts'
import { generateTree } from '@world/trees/generateTree.ts'
import { checkGeometry, measureTree } from '@world/trees/measure.ts'
import { formParamsFor } from '@world/trees/speciesForm.ts'
import { STUB_SPECIES, stubStem } from '../../fixtures/world.ts'
import { sampleAttractorField } from '@world/trees/crownShape.ts'
import { assignRadii, growSkeleton } from '@world/trees/skeleton.ts'
import { Rng } from '@world/trees/rng.ts'

/** Spec §7.4 LOD table: tris per instance at each tier. */
const TRIANGLE_BUDGET = [25_000, 8_000, 1_500, 2] as const

const SEEDS = [1, 5, 13, 29, 61]

function build(speciesIndex: number, seed: number) {
  const species = STUB_SPECIES[speciesIndex]!
  const stem = stubStem(species, seed)
  return {
    species,
    stem,
    tree: generateTree({
      species,
      heightM: stem.heightM,
      crownBaseM: stem.crownBaseM,
      crownRadiusM: stem.crownRadiusM,
      crownBulkDensityKgM3: stem.crownBulkDensity,
      dbhM: stem.dbhM,
      seed,
      hasLadderFuels: stem.hasLadderFuels,
    }),
  }
}

describe('mesh structure', () => {
  it('is free of degenerate, mis-wound, out-of-range and non-finite geometry', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      for (const seed of SEEDS) {
        const { species, tree } = build(i, seed)
        tree.mesh.lods.forEach((lod: TreeLod, level: number) => {
          const report = checkGeometry(lod)
          const label = `${species.id}#${seed} LOD${level}`
          expect(report.nonFiniteVertices, `${label} non-finite`).toBe(0)
          expect(report.indicesOutOfRange, `${label} out of range`).toBe(0)
          expect(report.degenerateTriangles, `${label} degenerate`).toBe(0)
          // Every tube is a closed surface built ring by ring, and every card is an isolated
          // quad, so no undirected edge should ever be shared by three triangles and no
          // directed edge should appear twice.
          expect(report.overSharedEdges, `${label} over-shared edges`).toBe(0)
          expect(report.inconsistentWinding, `${label} winding`).toBe(0)
          expect(report.submeshCoverageOk, `${label} submesh coverage`).toBe(true)
          expect(report.triangleCount, `${label} empty`).toBeGreaterThan(0)
        })
      }
    }
  })

  it('keeps every LOD inside the spec §7.4 triangle budget', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      for (const seed of SEEDS) {
        const { species, tree } = build(i, seed)
        expect(tree.mesh.lods.length).toBe(4)
        tree.mesh.lods.forEach((lod: TreeLod, level: number) => {
          expect(
            lod.triangleCount,
            `${species.id}#${seed} LOD${level} over budget`,
          ).toBeLessThanOrEqual(TRIANGLE_BUDGET[level]!)
        })
      }
    }
  })

  it('is monotonically cheaper down the LOD chain', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      const { species, tree } = build(i, 17)
      for (let level = 1; level < tree.mesh.lods.length; level++) {
        expect(
          tree.mesh.lods[level]!.triangleCount,
          `${species.id} LOD${level} not cheaper than LOD${level - 1}`,
        ).toBeLessThan(tree.mesh.lods[level - 1]!.triangleCount)
      }
    }
  })

  it('has matching array lengths and a valid submesh partition', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      const { species, tree } = build(i, 23)
      for (const lod of tree.mesh.lods) {
        const verts = lod.positions.length / 3
        expect(lod.normals.length, species.id).toBe(verts * 3)
        expect(lod.uvs.length, species.id).toBe(verts * 2)
        expect(lod.indices.length, species.id).toBe(lod.triangleCount * 3)
        const covered = lod.submeshes.reduce((a, s) => a + s.count, 0)
        expect(covered, species.id).toBe(lod.indices.length)
        for (const sm of lod.submeshes) {
          expect(sm.count % 3, species.id).toBe(0)
          expect(['bark', 'foliage', 'ribbon']).toContain(sm.material)
        }
      }
    }
  })

  it('emits unit-length normals', () => {
    const { tree } = build(0, 7)
    const n = tree.mesh.lods[0]!.normals
    for (let i = 0; i < n.length; i += 3) {
      const len = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!)
      expect(len).toBeGreaterThan(0.99)
      expect(len).toBeLessThan(1.01)
    }
  })
})

describe('foliar mass is invariant down the LOD chain', () => {
  /**
   * A tree that loses fuel as the camera backs away would make the canopy voxeliser's answer
   * depend on where the player is standing. Coarser LODs keep fewer, larger cards carrying
   * the same total leaf area, and this asserts it.
   *
   * LOD 3 is excluded: it is the impostor billboard, a single quad standing in for the whole
   * crown, and it carries an image rather than a fuel bed.
   */
  it('holds for every species', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      const { species, tree } = build(i, 33)
      const f = formParamsFor(species)
      const reference = tree.mesh.derived.foliarBiomassKg
      for (let level = 1; level <= 2; level++) {
        const m = measureTree(tree.mesh.lods[level]!, f)
        expect(
          Math.abs(m.foliarBiomassKg - reference) / reference,
          `${species.id} LOD${level} biomass drift`,
        ).toBeLessThan(0.02)
      }
    }
  })
})

describe('bark strips', () => {
  const eucalypts = STUB_SPECIES.filter(
    (s) => s.bark === 'decorticating-ribbon' || s.bark === 'fibrous',
  )

  it('exist as their own addressable submesh on shedding species', () => {
    const shedders = eucalypts.filter((s) => s.firebrandSource)
    expect(shedders.length).toBeGreaterThan(0)
    for (const species of shedders) {
      const index = STUB_SPECIES.indexOf(species)
      const { tree } = build(index, 3)
      const lod0 = tree.mesh.lods[0]!
      const ribbon = lod0.submeshes.filter((s) => s.material === 'ribbon')
      expect(ribbon.length, species.id).toBe(1)
      expect(ribbon[0]!.count, species.id).toBeGreaterThan(0)
      // The M3 firebrand emitter needs the mass of the reservoir, not just its triangles.
      expect(tree.barkStrips.massKg, species.id).toBeGreaterThan(0)
      expect(tree.barkStrips.stripCount, species.id).toBeGreaterThan(3)
    }
  })

  it('does not exist on smooth- and plated-bark species', () => {
    for (let i = 0; i < STUB_SPECIES.length; i++) {
      const species = STUB_SPECIES[i]!
      if (species.bark !== 'thick-plated' && species.bark !== 'furrowed' && species.bark !== 'smooth') {
        continue
      }
      const { tree } = build(i, 3)
      const ribbon = tree.mesh.lods[0]!.submeshes.filter((s) => s.material === 'ribbon')
      expect(ribbon.length, species.id).toBe(0)
      expect(tree.barkStrips.massKg, species.id).toBe(0)
    }
  })

  it('is excluded from the crown-base measurement', () => {
    // Strips hang below the live crown. If they leaked into the foliage submesh they would
    // drag the measured crown base towards the ground and quietly break crown initiation.
    const species = STUB_SPECIES.find((s) => s.bark === 'decorticating-ribbon')!
    const index = STUB_SPECIES.indexOf(species)
    const { stem, tree } = build(index, 3)
    expect(
      Math.abs(tree.mesh.derived.crownBaseM - stem.crownBaseM) / stem.crownBaseM,
    ).toBeLessThan(0.1)
  })
})

describe('ladder fuels', () => {
  it('add woody geometry below the crown without moving the crown base', () => {
    const species = STUB_SPECIES[0]!
    const stem = stubStem(species, 91)
    const make = (ladder: boolean) =>
      generateTree({
        species,
        heightM: stem.heightM,
        crownBaseM: stem.crownBaseM,
        crownRadiusM: stem.crownRadiusM,
        crownBulkDensityKgM3: stem.crownBulkDensity,
        dbhM: stem.dbhM,
        seed: 4,
        hasLadderFuels: ladder,
      })
    const without = make(false)
    const with_ = make(true)

    const barkTris = (t: ReturnType<typeof make>) =>
      t.mesh.lods[0]!.submeshes
        .filter((s) => s.material === 'bark')
        .reduce((a, s) => a + s.count / 3, 0)
    expect(barkTris(with_)).toBeGreaterThan(barkTris(without))

    // Crown base is defined by live foliage, so retained deadwood on the bole must not move
    // it. This is the whole reason ladder stubs carry no foliage cards.
    expect(with_.mesh.derived.crownBaseM).toBeCloseTo(without.mesh.derived.crownBaseM, 6)
    expect(with_.mesh.derived.foliarBiomassKg).toBeCloseTo(
      without.mesh.derived.foliarBiomassKg,
      6,
    )
  })
})

describe('growth forms are structurally distinct', () => {
  /**
   * Conifer, broadleaf and shrub are supposed to be three different plants, not one plant
   * with three parameter sets that happen to look the same. These assert the differences
   * that matter for how fuel is arranged in space.
   */
  const coniferIndex = STUB_SPECIES.findIndex((s) => s.form === 'conifer')
  const broadleafIndex = STUB_SPECIES.findIndex((s) => s.form === 'broadleaf')
  const shrubIndex = STUB_SPECIES.findIndex((s) => s.form === 'shrub')

  it('drives the three forms from distinct growth parameters', () => {
    const conifer = formParamsFor(STUB_SPECIES[coniferIndex]!)
    const broadleaf = formParamsFor(STUB_SPECIES[broadleafIndex]!)
    const shrub = formParamsFor(STUB_SPECIES[shrubIndex]!)

    // Conifer: a single leader all the way to the apex, strong apical dominance, whorled.
    expect(conifer.basalStems).toBe(1)
    expect(conifer.leaderHeightFrac).toBe(1)
    expect(conifer.whorlSpacingFrac).toBeGreaterThan(0)
    expect(conifer.apicalDominance).toBeGreaterThan(broadleaf.apicalDominance)
    // Broadleaf: leader stops below the crown top so competing leaders emerge, not whorled.
    expect(broadleaf.leaderHeightFrac).toBeLessThan(1)
    expect(broadleaf.whorlSpacingFrac).toBe(0)
    // Shrub: several stems from the base, no trunk to speak of.
    expect(shrub.basalStems).toBeGreaterThan(1)
    expect(shrub.leaderHeightFrac).toBeLessThan(broadleaf.leaderHeightFrac)
    // Crown silhouette: conifer peaks near its base (conical), broadleaf higher (rounded).
    expect(conifer.tPeak).toBeLessThan(broadleaf.tPeak)
  })

  it('produces the structural differences in the generated skeleton', () => {
    const skeletonOf = (index: number) => {
      const species = STUB_SPECIES[index]!
      const stem = stubStem(species, 12)
      const f = formParamsFor(species)
      const crown = {
        heightM: stem.heightM,
        crownBaseM: stem.crownBaseM,
        crownRadiusM: stem.crownRadiusM,
        crownBulkDensityKgM3: stem.crownBulkDensity,
      }
      const rng = new Rng(4242)
      const field = sampleAttractorField(f, crown, rng, f.attractorCount)
      const sk = growSkeleton(f, crown, field, rng)
      assignRadii(sk, stem.dbhM, crown.heightM)
      return { sk, crown, f }
    }

    // A shrub grows several stems from the root plate; a conifer grows one bole.
    expect(skeletonOf(shrubIndex).sk.trunkChains.length).toBeGreaterThan(1)
    expect(skeletonOf(coniferIndex).sk.trunkChains.length).toBe(1)

    // The conifer's leader reaches the apex; the broadleaf's bole stops well short and the
    // upper crown is carried by colonisation-grown competing leaders.
    const conifer = skeletonOf(coniferIndex)
    const broadleaf = skeletonOf(broadleafIndex)
    const trunkTop = (s: ReturnType<typeof skeletonOf>): number => {
      const chain = s.sk.trunkChains[0]!
      return s.sk.nodes[chain[chain.length - 1]!]!.y / s.crown.heightM
    }
    expect(trunkTop(conifer)).toBeGreaterThan(0.95)
    expect(trunkTop(broadleaf)).toBeLessThan(0.8)

    // Whorled branching leaves most of the conifer bole unable to recruit branches.
    const chain = conifer.sk.trunkChains[0]!
    const branchable = chain.filter((i) => conifer.sk.nodes[i]!.canBranch).length
    expect(branchable).toBeGreaterThan(2)
    expect(branchable).toBeLessThan(chain.length * 0.75)
  })
})
