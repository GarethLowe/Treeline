/**
 * One tree, end to end (WP 1.4).
 *
 * The derivation chain of spec §7.5, in order, with nothing looping back:
 *
 *   Stem physics (H, CBH, CD, CBD, DBH)
 *     -> crown envelope and target CBD(z)          crownShape.ts
 *     -> attractor field                           crownShape.ts
 *     -> woody skeleton by space colonisation      skeleton.ts
 *     -> branch radii by the pipe model, scaled to the declared DBH
 *     -> foliage cards carrying the field's mass   foliage.ts
 *     -> bark strips on their own submesh          bark.ts
 *     -> LOD chain
 *     -> measurement of the *triangles*            measure.ts
 *
 * The last step never reads the first. That is the invariant the acceptance test exists to
 * protect, and it is why `TreeMesh.derived` is filled from `measureTree` rather than copied
 * out of the input.
 */

import type { Metres, KgPerCubicMetre } from '@contracts/units.ts'
import type { SpeciesDef, TreeLod, TreeMesh } from '@contracts/world.ts'
import type { BarkStripStats } from './bark.ts'
import type { FormParams } from './speciesForm.ts'
import type { CrownSpec } from './crownShape.ts'
import type { TreeMetrics } from './measure.ts'
import { addBarkStrips } from './bark.ts'
import { addFoliage, decimate, placeFoliage, type FoliageElement } from './foliage.ts'
import { addTube, LOD0_TUBE, LOD1_TUBE, LOD2_TUBE, woodyVolumeM3 } from './branchMesh.ts'
import { MeshBuilder } from './meshBuilder.ts'
import { Rng, hashString, mixSeed } from './rng.ts'
import { addLadderStubs, assignRadii, extractChains, growSkeleton, type Skeleton } from './skeleton.ts'
import { measureTree } from './measure.ts'
import { formParamsFor } from './speciesForm.ts'
import { sampleAttractorField } from './crownShape.ts'

export interface TreeGenInput {
  readonly species: SpeciesDef
  readonly heightM: number
  readonly crownBaseM: number
  readonly crownRadiusM: number
  readonly crownBulkDensityKgM3: number
  readonly dbhM: number
  /** Deterministic per-mesh seed. Same seed + same parameters => byte-identical geometry. */
  readonly seed: number
  readonly hasLadderFuels: boolean
}

export interface GeneratedTree {
  readonly mesh: TreeMesh
  /** Measured from LOD 0. Same numbers as `mesh.derived`, plus the diagnostics that do not
   *  fit in the frozen contract (leaf area, crown volume, the vertical CBD profile). */
  readonly metrics: TreeMetrics
  /** Shed-able bark reservoir. M3's firebrand emitter needs the mass, not just the mesh. */
  readonly barkStrips: BarkStripStats
  /** Swept volume of the woody skeleton, m3 — the 1-h/10-h/100-h load M2 will want. */
  readonly woodyVolumeM3: number
  readonly skeletonNodeCount: number
  readonly generationMs: number
}

/** Relative foliage-element counts down the LOD chain. LOD 3 is the impostor billboard. */
const LOD_FOLIAGE_FRACTION = [1, 0.22, 0.035] as const

/**
 * Chain-pruning thresholds per LOD, as a fraction of the trunk's basal radius. LOD 1 keeps
 * everything down to fine branches; LOD 2 keeps the trunk and main limbs only, which is the
 * "branch cards" tier of spec §7.4.
 */
const LOD_MIN_RADIUS_FRACTION = [0, 0.14, 0.42] as const

function clampInputs(input: TreeGenInput): CrownSpec {
  const heightM = Math.max(0.05, input.heightM)
  // A crown base at or above the apex is not a tree; clamp rather than emit an empty crown,
  // and leave at least 5% of the height as live crown.
  const crownBaseM = Math.min(Math.max(0, input.crownBaseM), 0.95 * heightM)
  const crownRadiusM = Math.max(0.02, input.crownRadiusM)
  const crownBulkDensityKgM3 = Math.max(1e-4, input.crownBulkDensityKgM3)
  return { heightM, crownBaseM, crownRadiusM, crownBulkDensityKgM3 }
}

function buildLod(
  f: FormParams,
  crown: CrownSpec,
  sk: Skeleton,
  elements: readonly FoliageElement[],
  level: 0 | 1 | 2,
  rng: Rng,
): { lod: TreeLod; bark: BarkStripStats } {
  const mb = new MeshBuilder()
  const trunkRadius = sk.nodes[sk.trunkChains[0]?.[0] ?? 0]?.radius ?? 0.05
  const tube = level === 0 ? LOD0_TUBE : level === 1 ? LOD1_TUBE : LOD2_TUBE
  const minRadius = LOD_MIN_RADIUS_FRACTION[level]! * trunkRadius

  mb.begin('bark')
  const chains = extractChains(sk, minRadius)
  for (const chain of chains) addTube(mb, sk.nodes, chain, tube)

  mb.begin('foliage')
  const target = Math.max(4, Math.round(elements.length * LOD_FOLIAGE_FRACTION[level]!))
  const { kept, massScale } = decimate(elements, target)
  addFoliage(mb, f, crown, kept, { quads: level === 2 ? 1 : 2, massScale })

  // Bark strips survive to LOD 1 because they are a firebrand source, not decoration, and
  // the brand emitter should not have to care which LOD happens to be resident.
  let bark: BarkStripStats = { stripCount: 0, areaM2: 0, massKg: 0 }
  if (level <= 1) {
    mb.begin('ribbon')
    bark = addBarkStrips(mb, f, crown, sk, rng, level === 0 ? 4 : 2)
  }

  return { lod: mb.build(), bark }
}

/**
 * The far-field tier: one camera-facing quad sized to the tree's bounding box, ready for the
 * octahedral impostor atlas of spec §7.4.
 *
 * TODO(WP 1.4 -> integrator): the atlas itself is NOT baked here. Baking needs a live
 * GPUDevice to render the 12x12 octahedral views and a BC7 encode path, neither of which
 * exists inside a pure world-gen package, and `TreeMesh.impostor` is optional in the
 * contract precisely so this can land separately. Until it is baked, LOD 3 is a correctly
 * sized, correctly UV'd billboard with no atlas behind it; the LOD *structure* is real and
 * selectable, the texture is missing.
 */
function buildBillboard(crown: CrownSpec): TreeLod {
  const mb = new MeshBuilder()
  mb.begin('foliage')
  const r = crown.crownRadiusM
  const h = crown.heightM
  const v0 = mb.vertex(-r, 0, 0, 0, 0, 1, 0, 0)
  const v1 = mb.vertex(r, 0, 0, 0, 0, 1, 1, 0)
  const v2 = mb.vertex(r, h, 0, 0, 0, 1, 1, 1)
  const v3 = mb.vertex(-r, h, 0, 0, 0, 1, 0, 1)
  mb.quad(v0, v1, v2, v3)
  return mb.build()
}

export function generateTree(input: TreeGenInput): GeneratedTree {
  const t0 = performance.now()
  const f = formParamsFor(input.species)
  const crown = clampInputs(input)

  // One stream, consumed in a fixed order. Reproducibility comes from the order being fixed,
  // not from every consumer getting its own generator — the latter is easy to get subtly
  // wrong when a consumer is added.
  const rng = new Rng(mixSeed(hashString(input.species.id), input.seed))

  const skeletonField = sampleAttractorField(f, crown, rng, f.attractorCount)
  const sk = growSkeleton(f, crown, skeletonField, rng)
  assignRadii(sk, Math.max(1e-3, input.dbhM), crown.heightM)
  if (input.hasLadderFuels) addLadderStubs(sk, crown, rng)

  const foliageField = sampleAttractorField(f, crown, rng, f.foliageElementsLod0)
  const elements = placeFoliage(f, foliageField, sk, rng)

  const lod0 = buildLod(f, crown, sk, elements, 0, new Rng(mixSeed(input.seed, 0x51ed)))
  const lod1 = buildLod(f, crown, sk, elements, 1, new Rng(mixSeed(input.seed, 0x51ed)))
  const lod2 = buildLod(f, crown, sk, elements, 2, new Rng(mixSeed(input.seed, 0x51ed)))
  const lod3 = buildBillboard(crown)

  const metrics = measureTree(lod0.lod, f)

  const mesh: TreeMesh = {
    speciesId: input.species.id,
    seed: input.seed,
    lods: [lod0.lod, lod1.lod, lod2.lod, lod3],
    derived: {
      crownBaseM: metrics.crownBaseM as Metres,
      foliarBiomassKg: metrics.foliarBiomassKg,
      crownBulkDensity: metrics.crownBulkDensityKgM3 as KgPerCubicMetre,
      heightM: metrics.heightM as Metres,
    },
  }

  return {
    mesh,
    metrics,
    barkStrips: lod0.bark,
    woodyVolumeM3: woodyVolumeM3(sk.nodes, extractChains(sk, 0)),
    skeletonNodeCount: sk.nodes.length,
    generationMs: performance.now() - t0,
  }
}
