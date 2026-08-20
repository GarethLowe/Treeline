/**
 * `ITreeMeshSet`: the quantised mesh cache (WP 1.4).
 *
 * A 1 km² domain carries up to 80 000 stems. Generating a unique mesh per stem is out of the
 * question on both time (tens of milliseconds each) and memory (of order a megabyte each at
 * LOD 0), so stems are bucketed by their *physical* parameters and share a mesh.
 *
 * Which parameters, and how finely, is not a free choice — it is set by the package's
 * acceptance criterion. `get(stem)` returns a mesh whose `derived` block must agree with
 * *that stem* within 10%, and the comparable quantities are exactly three: height, crown
 * base height and crown bulk density. Quantisation error in those three lands directly in
 * the 10% budget alongside the geometric error, so they are the key, bucketed geometrically
 * at a ratio that leaves the geometry room to breathe.
 *
 * **Crown radius and DBH are deliberately not in the key.** They appear in neither `derived`
 * nor the Stem-side comparison — crown bulk density is invariant to crown radius, because
 * the foliar mass and the crown volume are both derived from the *same* radius and it
 * cancels in their ratio — so keying on them buys nothing the acceptance criterion can see
 * while multiplying the bucket count by an order of magnitude. Instead both are derived
 * allometrically from the quantised height and the `SpeciesDef`. The cost is real and worth
 * stating: a stem whose crown is unusually wide, or whose bole is unusually thick for its
 * height, renders with the species-typical proportions instead. Set `keyOnCrownRadius` /
 * `keyOnDbh` to trade memory back for that fidelity.
 *
 * The difference is not marginal. With all five parameters in the key, 80 000 stems over two
 * species land in ~5700 buckets — a mesh per fourteen stems, which is not a cache. With
 * three, they land in a few hundred, which is what fits in VRAM.
 *
 * Buckets are geometric rather than linear because the tolerance is relative: a 5% band is
 * 5% whether the crown base is 0.15 m of Adenostoma or 8 m of eucalypt.
 */

import type { ITreeMeshSet, SpeciesDef, Stem, TreeMesh } from '@contracts/world.ts'
import { generateTree, type GeneratedTree } from './generateTree.ts'
import { mixSeed } from './rng.ts'

export interface QuantisationOptions {
  /** Bucket ratio for total height. Worst-case relative error is sqrt(ratio) - 1. */
  readonly heightRatio: number
  /** Bucket ratio for crown base height — the Van Wagner input, so kept tight. */
  readonly crownBaseRatio: number
  /** Bucket ratio for crown bulk density — the active-crowning threshold, so kept tight. */
  readonly crownBulkDensityRatio: number
  /** Put crown radius in the key instead of deriving it from height. Costs ~2x meshes. */
  readonly keyOnCrownRadius: boolean
  /** Bucket ratio for crown radius, used only when `keyOnCrownRadius` is set. */
  readonly crownRadiusRatio: number
  /** Put DBH in the key instead of deriving it from height. Costs ~1.5x meshes. */
  readonly keyOnDbh: boolean
  /** Bucket ratio for DBH, used only when `keyOnDbh` is set. */
  readonly dbhRatio: number
  /**
   * Distinct geometry variants per parameter bucket. Stems in one bucket are otherwise
   * identical meshes; `Stem.rotationY` already de-duplicates them visually at instancing
   * time, so this stays low. Each variant is a full extra mesh.
   */
  readonly variants: number
}

export const DEFAULT_QUANTISATION: QuantisationOptions = {
  heightRatio: 1.14,
  crownBaseRatio: 1.16,
  crownBulkDensityRatio: 1.07,
  keyOnCrownRadius: false,
  crownRadiusRatio: 1.45,
  keyOnDbh: false,
  dbhRatio: 1.6,
  variants: 1,
}

export interface TreeMeshSetOptions {
  readonly quantisation?: QuantisationOptions
  /**
   * Give stems flagged `hasLadderFuels` their own mesh, carrying the retained dead branch
   * stubs on the bole. Off by default, because it exactly doubles `uniqueMeshCount` — the
   * flag is boolean and roughly half the population carries it — for geometry that is a
   * handful of stubs.
   *
   * What is lost when it is off is bounded and worth stating: the *physics* term still rides
   * on `Stem.hasLadderFuels`, and the bulk of real ladder fuel is understorey saplings and
   * shrubs, which the vegetation set places as their own plants rather than as part of this
   * tree. What is missing is only the bole's own retained deadwood. Turn it on where the
   * mesh budget allows.
   */
  readonly separateLadderFuelMeshes?: boolean
}

interface Bucket {
  readonly index: number
  readonly value: number
}

/** The bucket a stem resolves to: its cache key and the parameters the mesh is built from. */
export interface ResolvedMeshKey {
  readonly key: string
  readonly variant: number
  readonly ladder: boolean
  readonly heightM: number
  readonly crownBaseM: number
  readonly crownRadiusM: number
  readonly crownBulkDensityKgM3: number
  readonly dbhM: number
}

/** Geometric bucket: index = round(log_r(v)), representative = r^index. */
function quantise(value: number, ratio: number): Bucket {
  if (!(value > 0) || !Number.isFinite(value)) return { index: 0, value: Math.max(1e-6, value) }
  const logR = Math.log(ratio)
  const index = Math.round(Math.log(value) / logR)
  return { index, value: Math.exp(index * logR) }
}

export interface TreeMeshSetStats {
  readonly uniqueMeshCount: number
  readonly totalTriangles: number
  readonly totalVertices: number
  /** Approximate CPU-side footprint of every cached mesh, bytes. */
  readonly approxBytes: number
  readonly totalGenerationMs: number
  readonly meanGenerationMs: number
  readonly cacheHits: number
  readonly cacheMisses: number
}

export class TreeMeshSet implements ITreeMeshSet {
  private readonly species: ReadonlyMap<string, SpeciesDef>
  private readonly quant: QuantisationOptions
  private readonly separateLadder: boolean
  private readonly cache = new Map<string, GeneratedTree>()
  private hits = 0
  private misses = 0
  private genMs = 0

  constructor(
    species: ReadonlyMap<string, SpeciesDef> | readonly SpeciesDef[],
    options: TreeMeshSetOptions = {},
  ) {
    this.species =
      species instanceof Map
        ? species
        : new Map((species as readonly SpeciesDef[]).map((s) => [s.id, s]))
    this.quant = options.quantisation ?? DEFAULT_QUANTISATION
    this.separateLadder = options.separateLadderFuelMeshes ?? false
  }

  /** The cache key, and the exact parameters the shared mesh is built from. */
  keyFor(stem: Stem): ResolvedMeshKey {
    return this.resolve(stem)
  }

  private resolve(stem: Stem): ResolvedMeshKey {
    const q = this.quant
    const species = this.species.get(stem.speciesId)
    const height = quantise(stem.heightM, q.heightRatio)
    const crownBase = quantise(Math.max(1e-3, stem.crownBaseM), q.crownBaseRatio)
    const cbd = quantise(stem.crownBulkDensity, q.crownBulkDensityRatio)
    const crownRadius = q.keyOnCrownRadius
      ? quantise(stem.crownRadiusM, q.crownRadiusRatio)
      : { index: -1, value: allometricCrownRadius(species, height.value) }
    const dbh = q.keyOnDbh
      ? quantise(stem.dbhM, q.dbhRatio)
      : { index: -1, value: allometricDbh(species, height.value, stem.dbhM) }
    const variants = Math.max(1, Math.round(q.variants))
    // Hash the stem's own stream rather than using it directly: consecutive stems in a
    // vegetation set often carry consecutive seeds, and taking a low bit of that would
    // correlate the variant with position in the world.
    const variant = mixSeed(stem.seed, 0x7a3b) % variants
    const ladder = this.separateLadder && stem.hasLadderFuels

    const rPart = q.keyOnCrownRadius ? `|r${crownRadius.index}` : ''
    const dPart = q.keyOnDbh ? `|d${dbh.index}` : ''
    const key = `${stem.speciesId}|${height.index}|${crownBase.index}|${cbd.index}${rPart}${dPart}|${variant}|${ladder ? 'L' : '-'}`
    return {
      key,
      variant,
      ladder,
      heightM: height.value,
      crownBaseM: Math.min(crownBase.value, 0.95 * height.value),
      crownRadiusM: crownRadius.value,
      crownBulkDensityKgM3: cbd.value,
      dbhM: dbh.value,
    }
  }

  get(stem: Stem): TreeMesh {
    const input = this.resolve(stem)
    const hit = this.cache.get(input.key)
    if (hit !== undefined) {
      this.hits++
      return hit.mesh
    }
    const species = this.species.get(stem.speciesId)
    if (species === undefined) {
      throw new Error(
        `TreeMeshSet: no SpeciesDef registered for '${stem.speciesId}'. The vegetation set and ` +
          `the mesh set must be built from the same species table.`,
      )
    }
    const generated = generateTree({
      species,
      heightM: input.heightM,
      crownBaseM: input.crownBaseM,
      crownRadiusM: input.crownRadiusM,
      crownBulkDensityKgM3: input.crownBulkDensityKgM3,
      dbhM: input.dbhM,
      // Seeded from the key, not from the stem: every stem that lands in this bucket must
      // get byte-identical geometry, whichever of them arrives first.
      seed: hashKey(input.key),
      hasLadderFuels: input.ladder,
    })
    this.misses++
    this.genMs += generated.generationMs
    this.cache.set(input.key, generated)
    return generated.mesh
  }

  /** Full generation record for a stem, including the diagnostics `TreeMesh` cannot carry. */
  getDetailed(stem: Stem): GeneratedTree {
    this.get(stem)
    return this.cache.get(this.resolve(stem).key)!
  }

  get uniqueMeshCount(): number {
    return this.cache.size
  }

  get totalTriangles(): number {
    let n = 0
    for (const g of this.cache.values()) for (const lod of g.mesh.lods) n += lod.triangleCount
    return n
  }

  stats(): TreeMeshSetStats {
    let tris = 0
    let verts = 0
    let bytes = 0
    for (const g of this.cache.values()) {
      for (const lod of g.mesh.lods) {
        tris += lod.triangleCount
        verts += lod.positions.length / 3
        bytes +=
          lod.positions.byteLength + lod.normals.byteLength + lod.uvs.byteLength + lod.indices.byteLength
      }
    }
    return {
      uniqueMeshCount: this.cache.size,
      totalTriangles: tris,
      totalVertices: verts,
      approxBytes: bytes,
      totalGenerationMs: this.genMs,
      meanGenerationMs: this.misses > 0 ? this.genMs / this.misses : 0,
      cacheHits: this.hits,
      cacheMisses: this.misses,
    }
  }

  /** Every mesh generated so far. The renderer packs these into its shared vertex pool. */
  meshes(): readonly GeneratedTree[] {
    return [...this.cache.values()]
  }
}

/**
 * Crown radius from height, via the species' own crown-width fraction. `SpeciesDef` carries
 * that as a single scalar, so this is the species' allometry, not an invention.
 */
function allometricCrownRadius(species: SpeciesDef | undefined, heightM: number): number {
  if (species === undefined) return 0.3 * heightM
  return Math.max(0.02, 0.5 * heightM * species.crownWidthFraction)
}

/**
 * DBH from height by interpolating along the species' own height and DBH ranges together, so
 * a stem at the top of its height range carries the top of its DBH range. Falls back to the
 * stem's declared DBH where the species range is degenerate.
 */
function allometricDbh(species: SpeciesDef | undefined, heightM: number, fallback: number): number {
  if (species === undefined) return fallback
  const h0 = species.heightM[0]
  const h1 = species.heightM[1]
  const d0 = species.dbhM[0]
  const d1 = species.dbhM[1]
  if (!(h1 > h0)) return fallback
  const u = Math.min(1, Math.max(0, (heightM - h0) / (h1 - h0)))
  return Math.max(1e-3, d0 + (d1 - d0) * u)
}

/** Stable 32-bit hash of the cache key, so a bucket's geometry does not depend on order. */
function hashKey(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

