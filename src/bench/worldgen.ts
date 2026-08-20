/**
 * CPU world-generation benchmark — work package 3.7.
 *
 * World generation is ~9 s on the target machine and it is the first thing a user waits
 * for, so it is a real cost even though it happens once. It is also entirely CPU-side: WP
 * 1.2 exposes `generateTerrainQueries()`, which produces the whole heightfield with no
 * device, and vegetation placement and tree meshing never touch the GPU either. So this
 * runs on the CLI under Vitest as well as in the browser, and needs no adapter.
 *
 * What it deliberately does NOT do:
 *
 * - It does not re-run the material system or the texture uploads. Those need a device, and
 *   the boot path already times them as a stage.
 * - It does not repeat runs. One 1 km pass is ~9 s; a five-repeat sweep is 45 s of the
 *   owner's time to shrink a confidence interval on a number that is not in the frame
 *   budget. `repeats` is there for anyone who wants it and defaults to 1.
 */

import type { BiomeId, Stem } from '@contracts/world.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import { generateTerrainQueries } from '@world/terrain/field.ts'
import { defaultWorldConfig, generateVegetation } from '@world/vegetation/index.ts'
import { DEFAULT_QUANTISATION, TreeMeshSet } from '@world/trees/treeMeshSet.ts'

export interface WorldGenStageTiming {
  readonly stage: string
  readonly ms: number
  readonly note: string
}

export interface WorldGenBenchResult {
  readonly stages: readonly WorldGenStageTiming[]
  readonly totalMs: number
}

export interface WorldGenBenchOptions {
  readonly seed: number
  readonly biome: BiomeId
  /** Domain edge, metres. Defaults to the real 1 km. Tests use ~200 m. */
  readonly sizeM?: number
  /** Terrain nodes per side. Must be a multiple of 64. Defaults to WP 1.2's own default. */
  readonly gridN?: number
  /** Erosion droplet count override. Only for tests; the default scales with grid area. */
  readonly droplets?: number
  /**
   * Cap on distinct tree meshes actually generated. Purely a benchmark time limit: the dense
   * shrub biomes resolve to thousands of distinct meshes before `src/app/worldGen.ts`
   * negotiates the quantisation down, and generating all of them would take minutes.
   */
  readonly maxMeshes?: number
  readonly repeats?: number
  readonly now?: () => number
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

function once(options: WorldGenBenchOptions): WorldGenStageTiming[] {
  const now = options.now ?? defaultNow
  const sizeM = options.sizeM ?? DOMAIN_SIZE_M
  const maxMeshes = options.maxMeshes ?? 256
  const config = defaultWorldConfig(options.seed, options.biome)
  const stages: WorldGenStageTiming[] = []

  const t0 = now()
  const terrain = generateTerrainQueries(config.terrain, config.seed, {
    domainM: sizeM,
    ...(options.gridN === undefined ? {} : { gridN: options.gridN }),
    ...(options.droplets === undefined ? {} : { droplets: options.droplets }),
  })
  const t1 = now()
  // WP 1.2 already splits its own time; passing it through is free and it is where most of
  // the 9 s lives, so it is the only place a world-gen optimisation could pay.
  const inner = Object.entries(terrain.generation.timingsMs)
    .filter(([k, v]) => k !== 'total' && v >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(0)}`)
    .join(', ')
  stages.push({
    stage: 'terrain',
    ms: t1 - t0,
    note: `${terrain.generation.gridN}² nodes — ${inner}`,
  })

  const vegetation = generateVegetation(config, terrain, { sizeM })
  const t2 = now()
  stages.push({
    stage: 'vegetation',
    ms: t2 - t1,
    note: `${vegetation.stems.length} stems, ${vegetation.measuredDensityPerHa.toFixed(0)}/ha`,
  })

  const meshSet = new TreeMeshSet([...vegetation.species.values()], {
    quantisation: DEFAULT_QUANTISATION,
  })
  const representatives = new Map<string, Stem>()
  for (const stem of vegetation.stems) {
    const key = meshSet.keyFor(stem).key
    if (!representatives.has(key)) representatives.set(key, stem)
  }
  const distinct = representatives.size
  const t3 = now()
  stages.push({
    stage: 'mesh-key scan',
    ms: t3 - t2,
    note: `${distinct} distinct meshes at the default quantisation`,
  })

  let generated = 0
  for (const stem of representatives.values()) {
    if (generated >= maxMeshes) break
    meshSet.get(stem)
    generated += 1
  }
  const t4 = now()
  const s = meshSet.stats()
  stages.push({
    stage: 'tree geometry',
    ms: t4 - t3,
    note:
      `${generated} of ${distinct} meshes generated${generated < distinct ? ' (capped)' : ''}, ` +
      `${s.totalTriangles} triangles, ${((t4 - t3) / Math.max(1, generated)).toFixed(1)} ms each`,
  })

  return stages
}

export function benchWorldGen(options: WorldGenBenchOptions): WorldGenBenchResult {
  const repeats = Math.max(1, options.repeats ?? 1)
  const accumulated = new Map<string, { ms: number; note: string }>()
  const order: string[] = []

  for (let i = 0; i < repeats; i++) {
    for (const s of once(options)) {
      const prev = accumulated.get(s.stage)
      if (prev === undefined) order.push(s.stage)
      accumulated.set(s.stage, { ms: (prev?.ms ?? 0) + s.ms, note: s.note })
    }
  }

  const stages = order.map((stage) => {
    const a = accumulated.get(stage) as { ms: number; note: string }
    return { stage, ms: a.ms / repeats, note: a.note }
  })
  return { stages, totalMs: stages.reduce((acc, s) => acc + s.ms, 0) }
}
