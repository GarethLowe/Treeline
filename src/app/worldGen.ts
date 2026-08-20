/**
 * Staged world generation: terrain -> vegetation -> tree geometry -> materials.
 *
 * This is where the four world-building packages meet each other. Two things it owns that no
 * package could:
 *
 *  1. **Yielding.** Terrain synthesis alone is ~4 s of straight-line CPU on the target
 *     machine. Run from a click handler it freezes the tab, and the user sees a hung browser
 *     rather than a progress screen. Every stage boundary awaits a real frame so the boot
 *     screen repaints.
 *  2. **Mesh-budget negotiation.** `buildFoliageScene` silently *drops stems* once the mesh
 *     set exceeds `MAX_BUCKETS / LOD_COUNT = 256` unique meshes, and chaparral at its own
 *     default density is ~220 000 shrubs whose quantised parameter space is far wider than
 *     that. Neither package can fix it alone: WP 1.4 does not know the bucket limit and
 *     WP 1.5 cannot change the quantisation. So the mesh budget is negotiated here, cheaply,
 *     using `TreeMeshSet.keyFor()` to *count* distinct meshes before generating any.
 */

import type { BiomeParams, ITerrainField, IVegetationSet, Stem, WorldConfig } from '@contracts/world.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import { createTerrainField } from '@world/terrain/gpu.ts'
import type { TerrainField } from '@world/terrain/field.ts'
import { biomeParams } from '@world/vegetation/biomes.ts'
import { defaultWorldConfig, generateVegetation } from '@world/vegetation/index.ts'
import type { VegetationSet } from '@world/vegetation/vegetationSet.ts'
import { DEFAULT_QUANTISATION, TreeMeshSet, type QuantisationOptions } from '@world/trees/treeMeshSet.ts'
import { createMaterialSystem, type ForestFireMaterialSystem } from '@render/materials/materialSystem.ts'
import { resolveGroundMaterials, type MaterialId } from '@render/materials/library.ts'
import type { MaterialIdMap } from '@render/foliage/sceneBuild.ts'
import { LOD_COUNT, MAX_BUCKETS } from '@render/foliage/config.ts'
import { foliageMaterialIds, resolveGroundMaterialIds } from './biomeMaterials.ts'
import { packDrainageTexels } from './terrainGrid.ts'
import type { StageTracker } from './stages.ts'
import type { AppSettings } from './settings.ts'
import { bytes, count, ms } from './format.ts'

/** Unique-mesh ceiling imposed by WP 1.5's single-workgroup bucket scan. */
export const MESH_BUDGET = Math.floor(MAX_BUCKETS / LOD_COUNT)

/**
 * Quantisation ladder, coarsest last.
 *
 * Each rung roughly halves the distinct-mesh count by widening the geometric buckets on
 * height, crown base and crown bulk density. The first rung is WP 1.4's own default; the
 * later ones are only reached by the dense shrub biomes, and the HUD reports which was used
 * so a coarse-looking chaparral stand is explained rather than mysterious.
 */
const QUANTISATION_LADDER: readonly QuantisationOptions[] = [
  DEFAULT_QUANTISATION,
  { ...DEFAULT_QUANTISATION, heightRatio: 1.3, crownBaseRatio: 1.35, crownBulkDensityRatio: 1.2 },
  { ...DEFAULT_QUANTISATION, heightRatio: 1.6, crownBaseRatio: 1.7, crownBulkDensityRatio: 1.5 },
  { ...DEFAULT_QUANTISATION, heightRatio: 2.2, crownBaseRatio: 2.4, crownBulkDensityRatio: 2.2 },
  { ...DEFAULT_QUANTISATION, heightRatio: 3.5, crownBaseRatio: 4, crownBulkDensityRatio: 4 },
]

export interface WorldGenStats {
  readonly terrainMs: number
  readonly terrainStages: string
  readonly stemCount: number
  readonly measuredDensityPerHa: number
  readonly measuredBasalAreaM2PerHa: number
  readonly uniqueMeshCount: number
  readonly treeTriangles: number
  readonly treeGenMs: number
  readonly quantisationRung: number
  readonly materialBytes: number
  readonly minElevationM: number
  readonly maxElevationM: number
}

export interface GeneratedWorld {
  readonly config: WorldConfig
  readonly biome: BiomeParams
  readonly terrain: TerrainField & ITerrainField
  readonly vegetation: IVegetationSet & VegetationSet
  readonly trees: TreeMeshSet
  readonly materials: ForestFireMaterialSystem
  /** Normalised log flow accumulation, r8unorm. Feeds `terrainSplat`'s drainage input. */
  readonly drainageTexture: GPUTexture
  /** Table indices, in GROUND_SLOT order, ready for the terrain uniform. */
  readonly groundMaterialSlots: readonly [number, number, number, number]
  readonly groundMaterialIds: readonly MaterialId[]
  readonly materialIds: MaterialIdMap
  readonly stats: WorldGenStats
  readonly warnings: readonly string[]
  destroy(): void
}

export interface WorldGenOptions {
  readonly device: GPUDevice
  readonly settings: AppSettings
  readonly stages: StageTracker
  /** Called with a 0..1 fraction inside a long stage, so the bar moves during tree meshing. */
  readonly onSubProgress?: (stageFraction: number) => void
}

/**
 * Hand the browser a real frame.
 *
 * `setTimeout(0)` is not enough: it runs before paint, so the progress screen would update
 * its DOM and then never be composited before the next multi-second block. Two rAFs
 * guarantee a presented frame.
 */
export async function yieldToBrowser(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return
  }
  // rAF never fires in a tab the browser is not compositing (backgrounded, or a hidden
  // preview pane), so waiting on it alone deadlocks world generation forever with no error.
  // Race it against a timeout: visible tabs still get a real presented frame, hidden ones
  // fall through and keep generating.
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 100)
    requestAnimationFrame(() => requestAnimationFrame(finish))
  })
}

export async function generateWorld(options: WorldGenOptions): Promise<GeneratedWorld> {
  const { device, settings, stages } = options
  const warnings: string[] = []

  const config: WorldConfig = defaultWorldConfig(settings.seed, settings.biome)
  const biome = biomeParams(settings.biome)

  // --- materials ----------------------------------------------------------
  // First because it is the only genuinely async stage: the GPU generation pass is queued
  // here and has the whole of terrain synthesis to complete in before anything samples it.
  const materials = await stages.run('materials', async () => {
    await yieldToBrowser()
    const system = await createMaterialSystem(device, { source: 'gpu-procedural', maxAnisotropy: 8 })
    stages.note(
      'materials',
      `${system.materials.size} materials, ${system.plan.layerCount} array layers, ${bytes(system.bytesUsed)}`,
    )
    return system
  })

  const ground = resolveGroundMaterialIds(settings.biome, biome.groundMaterials)
  if (ground.warning !== null) warnings.push(ground.warning)
  const groundMaterialSlots = resolveGroundMaterials(materials.packing, ground.ids)

  // --- terrain ------------------------------------------------------------
  const terrain = await stages.run('terrain', async () => {
    await yieldToBrowser()
    const field = createTerrainField(device, config.terrain, config.seed)
    const t = field.generation.timingsMs
    stages.note(
      'terrain',
      `${field.generation.gridN}² nodes, relief ${(config.terrain.relief * 100).toFixed(0)}%, ` +
        `${(field.minElevationM as number).toFixed(0)}–${(field.maxElevationM as number).toFixed(0)} m · ` +
        `synth ${ms(t.synthesis, 0)}, erosion ${ms(t.erosion, 0)}, fill ${ms(t.fill + t.prefill + t.finalFill, 0)}`,
    )
    if (field.generation.diagnostics.closedBasins > 0) {
      warnings.push(`terrain reports ${field.generation.diagnostics.closedBasins} closed basins (expected 0)`)
    }
    return field
  })

  const drainageTexture = createDrainageTexture(device, terrain)

  // --- vegetation ---------------------------------------------------------
  const vegetation = await stages.run('vegetation', async () => {
    await yieldToBrowser()
    const set = generateVegetation(config, terrain, { sizeM: DOMAIN_SIZE_M })
    const requested = config.vegetation.stemDensityPerHa
    const deviation = requested > 0 ? Math.abs(set.measuredDensityPerHa - requested) / requested : 0
    stages.note(
      'vegetation',
      `${count(set.stems.length)} stems, ${set.measuredDensityPerHa.toFixed(0)}/ha ` +
        `(requested ${requested}/ha, ${(deviation * 100).toFixed(1)}% off), ` +
        `basal area ${set.measuredBasalAreaM2PerHa.toFixed(1)} m²/ha`,
    )
    return set
  })

  // --- tree geometry ------------------------------------------------------
  const trees = await stages.run('tree-meshes', async () => {
    await yieldToBrowser()
    const { meshSet, rung, keys } = negotiateMeshBudget(vegetation, warnings)
    await generateAllMeshes(meshSet, keys, options.onSubProgress)
    const s = meshSet.stats()
    stages.note(
      'tree-meshes',
      `${s.uniqueMeshCount} unique meshes (rung ${rung}), ${count(s.totalTriangles)} triangles, ` +
        `${ms(s.totalGenerationMs, 0)} total / ${ms(s.meanGenerationMs)} mean`,
    )
    return { meshSet, rung }
  })

  const treeStats = trees.meshSet.stats()

  return {
    config,
    biome,
    terrain,
    vegetation,
    trees: trees.meshSet,
    materials,
    drainageTexture,
    groundMaterialSlots,
    groundMaterialIds: ground.ids,
    materialIds: foliageMaterialIds(settings.biome),
    warnings,
    stats: {
      terrainMs: terrain.generation.timingsMs.total,
      terrainStages: describeTerrainTimings(terrain),
      stemCount: vegetation.stems.length,
      measuredDensityPerHa: vegetation.measuredDensityPerHa,
      measuredBasalAreaM2PerHa: vegetation.measuredBasalAreaM2PerHa,
      uniqueMeshCount: treeStats.uniqueMeshCount,
      treeTriangles: treeStats.totalTriangles,
      treeGenMs: treeStats.totalGenerationMs,
      quantisationRung: trees.rung,
      materialBytes: materials.bytesUsed,
      minElevationM: terrain.minElevationM as number,
      maxElevationM: terrain.maxElevationM as number,
    },
    destroy(): void {
      drainageTexture.destroy()
      terrain.destroy()
      materials.destroy()
    },
  }
}

// ---------------------------------------------------------------------------
// Mesh budget
// ---------------------------------------------------------------------------

interface MeshBudgetResult {
  readonly meshSet: TreeMeshSet
  readonly rung: number
  /** One representative stem per distinct mesh key, in first-seen order. */
  readonly keys: readonly Stem[]
}

/**
 * Pick the finest quantisation whose distinct-mesh count fits the bucket table.
 *
 * `keyFor()` resolves a stem to its cache key *without generating geometry*, so a whole
 * candidate rung costs one string per stem and no tree building at all. That is what makes
 * trying five rungs affordable: the expensive step happens exactly once, at the rung that
 * was chosen.
 */
function negotiateMeshBudget(vegetation: IVegetationSet, warnings: string[]): MeshBudgetResult {
  const species = [...vegetation.species.values()]
  let last: MeshBudgetResult | null = null
  for (let rung = 0; rung < QUANTISATION_LADDER.length; rung++) {
    const quantisation = QUANTISATION_LADDER[rung] as QuantisationOptions
    const meshSet = new TreeMeshSet(species, { quantisation })
    const seen = new Map<string, Stem>()
    for (const stem of vegetation.stems) {
      const key = meshSet.keyFor(stem).key
      if (!seen.has(key)) seen.set(key, stem)
      // No early exit: the count itself is what the next rung is chosen from, and the loop
      // is a map lookup per stem — cheap next to generating even one extra tree.
    }
    last = { meshSet, rung, keys: [...seen.values()] }
    if (seen.size <= MESH_BUDGET) return last
  }
  const result = last as MeshBudgetResult
  warnings.push(
    `even the coarsest quantisation yields ${result.keys.length} unique meshes against a ` +
      `budget of ${MESH_BUDGET}; WP 1.5 will drop the overflow stems and report the count.`,
  )
  return result
}

/**
 * Build every mesh up front, yielding periodically.
 *
 * `buildFoliageScene` would generate them lazily while walking the stem list, which would be
 * one opaque multi-second block with no progress and no per-mesh attribution. Doing it here
 * makes tree generation a stage with a moving bar and a number.
 */
async function generateAllMeshes(
  meshSet: TreeMeshSet,
  representatives: readonly Stem[],
  onSubProgress?: (fraction: number) => void,
): Promise<void> {
  const total = Math.max(1, representatives.length)
  const chunk = 4
  for (let i = 0; i < representatives.length; i++) {
    meshSet.get(representatives[i] as Stem)
    if ((i + 1) % chunk === 0) {
      onSubProgress?.((i + 1) / total)
      await yieldToBrowser()
    }
  }
  onSubProgress?.(1)
}

// ---------------------------------------------------------------------------
// Drainage
// ---------------------------------------------------------------------------

function createDrainageTexture(device: GPUDevice, terrain: TerrainField): GPUTexture {
  const gen = terrain.generation
  const n = gen.gridN
  const texels = packDrainageTexels(gen.flowAccumM2, gen.field.cellM * gen.field.cellM)
  const texture = device.createTexture({
    label: 'terrain-drainage-r8unorm',
    size: { width: n, height: n, depthOrArrayLayers: 1 },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  // r8unorm is 1 byte per texel, so bytesPerRow = n. WP 1.2 guarantees n is a multiple of
  // 64, and writeTexture has no 256-byte row alignment requirement (that is copyBufferToTexture).
  device.queue.writeTexture({ texture }, texels, { bytesPerRow: n, rowsPerImage: n }, { width: n, height: n })
  return texture
}

function describeTerrainTimings(terrain: TerrainField): string {
  const t = terrain.generation.timingsMs
  return [
    `synthesis ${ms(t.synthesis, 0)}`,
    `erosion ${ms(t.erosion, 0)}`,
    `fill ${ms(t.prefill + t.fill + t.finalFill, 0)}`,
    `incision ${ms(t.incision, 0)}`,
    `pack ${ms(t.pack, 0)}`,
  ].join(', ')
}
