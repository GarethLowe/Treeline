/**
 * The terrain generation pipeline.
 *
 * Seven stages, in this order, and the order is load-bearing:
 *
 * | # | Stage | Why it is here and not elsewhere |
 * |---|---|---|
 * | 1 | Noise synthesis | The raw landform. Pure function of position; see `synthesis.ts`. |
 * | 2 | Normalise to relief | Fixes the vertical scale *before* erosion, so erosion sees real gradients and cuts harder on steep ground. |
 * | 3 | Pre-fill | Erosion droplets that start inside a noise pit spend their whole lifetime depositing into it. Filling first means the droplet budget is spent on channels. |
 * | 4 | Droplet erosion | Dendritic channel texture, sediment fans, smoothed divides. |
 * | 5 | Fill + flow accumulation | Depression-free field, then upslope area routed D8. |
 * | 6 | Channel incision | Trunk valleys, which the droplets alone under-cut. |
 * | 7 | Final fill + gradients | Guarantees zero closed basins, then derives slope/aspect analytically from the final surface. |
 *
 * Stage 7's fill is what makes the "no closed basins" acceptance criterion a *guarantee*
 * rather than a hope: priority-flood with an epsilon rise leaves every interior node with a
 * strictly lower neighbour by construction. Running it after incision rather than before is
 * the difference between a claim and a checked property.
 *
 * Gradients are recomputed only once, at the very end, from the final heights — so slope
 * and aspect are the exact derivative of the surface the queries and the textures both
 * describe. Deriving them earlier and carrying them through would let them drift.
 *
 * ## Cost
 *
 * Measured on the target CPU (i9-13900HX, single-threaded, Node 24) at the shipping
 * settings — 1024^2 nodes, 250k droplets, relief 1.0:
 *
 * ```
 *   synthesis 1035 ms   erosion 1876 ms   3 x priority-flood 760 ms
 *   normalise   97 ms   incision  30 ms   pack 61 ms   gradients 5 ms
 *   TOTAL     4060 ms
 * ```
 *
 * Inside the "a few seconds, once, at load" budget, and it is a one-shot cost — nothing
 * here runs per frame. `timingsMs` on the result reports the real split for the run that
 * produced it, so a regression shows up as a number rather than as a feeling.
 *
 * **The same code in Chrome measured 14.5 s** (synthesis 5.9 s, erosion 6.6 s) on the same
 * machine — but under an automation-instrumented browser on the iGPU, and the ratio held at
 * ~3x across grid sizes and across repeated warm runs, so it is not JIT warm-up. Treat it
 * as an upper bound that needs re-measuring in a clean browser before anything is concluded
 * from it. If it is real, the lever is already sized: synthesis is embarrassingly parallel
 * by row, so splitting `synthesize()` across the machine's 24 cores is a contained change
 * that removes the larger half (it would need the COOP/COEP headers back for
 * `SharedArrayBuffer`). Droplet erosion is inherently sequential and would need spatial
 * partitioning with per-region seeds — which would change the output for a given seed, so
 * it is a deliberate decision, not an optimisation to slip in.
 */

import type { TerrainParams } from '@contracts/world'
import { DOMAIN_SIZE_M } from '@contracts/world'
import { degToRad, m } from '@contracts/units'
import { TERRAIN_GRID_N } from './conventions.ts'
import { Heightfield, type HeightfieldStats } from './heightfield.ts'
import { DEFAULT_EROSION, erodeDroplets, type ErosionReport } from './erosion.ts'
import { drainagePathCheck, flowAccumulation, priorityFloodFill } from './hydrology.ts'
import { inciseChannels } from './incision.ts'
import { Rng } from './rng.ts'
import { makeSynthKernel, normaliseToSpan, reliefSpanM, synthesize } from './synthesis.ts'
import { packTerrainTexels, type TerrainTexels } from './sampling.ts'

/** A sensible mid-relief default, used by tests and by the M1 demo world. */
export const DEFAULT_TERRAIN_PARAMS: TerrainParams = {
  relief: 0.55,
  baseElevationM: m(900),
  drainageStrength: 0.7,
  ridgeBearing: degToRad(35),
  hydraulicErosionIterations: 250_000,
}

/**
 * Upslope contributing area, in cells, at which a node counts as a channel. 24 cells is
 * about where a hillslope hollow becomes a defined watercourse in the generated fields; it
 * is a reporting and incision threshold, not a physical claim.
 */
const CHANNEL_THRESHOLD_CELLS = 24

/** Target ground distance a single droplet travels before it is abandoned, metres. */
const DROPLET_RUN_M = 110

export type TerrainStage =
  | 'synthesis'
  | 'normalise'
  | 'prefill'
  | 'erosion'
  | 'fill'
  | 'incision'
  | 'finalFill'
  | 'gradients'
  | 'pack'
  | 'total'

export interface TerrainDiagnostics {
  /** Nodes raised by the final depression fill. */
  readonly filledCells: number
  readonly maxFillDepthM: number
  /** Must be 0. Interior local minima after the final fill. */
  readonly closedBasins: number
  /** Longest D8 walk from any node to the domain edge. Finite means the network resolves. */
  readonly maxPathSteps: number
  /** Must be 0. Flow paths that failed to terminate. */
  readonly unresolvedPaths: number
  /** Nodes above the channel-initiation contributing area. */
  readonly channelCells: number
  readonly channelFraction: number
  readonly deepestIncisionM: number
  readonly erosion: ErosionReport
}

export interface TerrainGeneration {
  readonly params: TerrainParams
  readonly seed: number
  readonly gridN: number
  readonly field: Heightfield
  readonly stats: HeightfieldStats
  readonly diagnostics: TerrainDiagnostics
  readonly timingsMs: Readonly<Record<TerrainStage, number>>
  readonly texels: TerrainTexels
  /** Upslope contributing area per node, m^2. Kept for vegetation and for debug views. */
  readonly flowAccumM2: Float32Array
}

export interface TerrainGenOptions {
  /** Node count per side. Must be a multiple of 64. Defaults to `TERRAIN_GRID_N` (1024). */
  readonly gridN?: number
  /** Domain extent, metres. Defaults to `DOMAIN_SIZE_M`. */
  readonly domainM?: number
  /**
   * Override the droplet count instead of scaling `hydraulicErosionIterations` by grid area.
   * Tests use it to keep a 256-node run under a second.
   */
  readonly droplets?: number
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Number(process.hrtime.bigint()) / 1e6

/**
 * Generate a terrain field on the CPU. Pure and deterministic: the same `(params, seed,
 * options)` produce byte-identical height, slope and aspect data, on any thread, in any
 * order.
 *
 * No GPU is involved — `createTerrainField` in `field.ts` uploads the result. Keeping
 * generation device-free is what lets the whole of it be unit-tested on the CLI.
 */
export function generateTerrain(
  params: TerrainParams,
  seed: number,
  options: TerrainGenOptions = {},
): TerrainGeneration {
  const gridN = options.gridN ?? TERRAIN_GRID_N
  const domainM = options.domainM ?? DOMAIN_SIZE_M
  const t: Record<TerrainStage, number> = {
    synthesis: 0,
    normalise: 0,
    prefill: 0,
    erosion: 0,
    fill: 0,
    incision: 0,
    finalFill: 0,
    gradients: 0,
    pack: 0,
    total: 0,
  }
  const t0 = now()

  const field = new Heightfield(gridN, domainM)
  const rng = new Rng(seed)
  const relief = Math.min(1, Math.max(0, params.relief))
  const drainage = Math.max(0, params.drainageStrength)

  // --- 1. Noise -----------------------------------------------------------
  let mark = now()
  const kernel = makeSynthKernel(params, seed, field.cellM)
  synthesize(field, kernel)
  t.synthesis = now() - mark

  // --- 2. Vertical scale --------------------------------------------------
  mark = now()
  normaliseToSpan(field, reliefSpanM(relief), params.baseElevationM)
  t.normalise = now() - mark

  // --- 3. Pre-fill --------------------------------------------------------
  mark = now()
  priorityFloodFill(field)
  t.prefill = now() - mark

  // --- 4. Droplet erosion -------------------------------------------------
  // Work in cell units (see erosion.ts): one set of constants, any grid resolution.
  mark = now()
  const inv = 1 / field.cellM
  const cellUnits = new Float32Array(field.height.length)
  for (let k = 0; k < cellUnits.length; k++) cellUnits[k] = (field.height[k] as number) * inv
  const areaScale = (gridN / TERRAIN_GRID_N) ** 2
  const droplets =
    options.droplets ?? Math.round(Math.max(0, params.hydraulicErosionIterations) * areaScale)
  const erosion = erodeDroplets(cellUnits, gridN, rng.fork(0x67051), {
    ...DEFAULT_EROSION,
    droplets,
    // A droplet's run is a DISTANCE, not a step count: at 1 m nodes a 48-step lifetime is a
    // 48 m rill, which never reaches a trunk valley and leaves the divides unsmoothed. Held
    // at ~110 m so the erosion signature is the same landscape feature at any resolution.
    maxLifetime: Math.min(128, Math.max(48, Math.round(DROPLET_RUN_M / field.cellM))),
    // Drainage strength buys cutting power, not more droplets: doubling the droplet count
    // would double generation time, and the visible difference is depth, not coverage.
    erodeSpeed: DEFAULT_EROSION.erodeSpeed * (0.35 + 0.9 * drainage),
  })
  for (let k = 0; k < cellUnits.length; k++) field.height[k] = (cellUnits[k] as number) * field.cellM
  t.erosion = now() - mark

  // --- 5. Fill + flow accumulation ---------------------------------------
  mark = now()
  const filled = priorityFloodFill(field)
  const receivers = field.computeReceivers()
  const acc = flowAccumulation(field, filled.order, receivers)
  t.fill = now() - mark

  // --- 6. Channel incision ------------------------------------------------
  mark = now()
  const cellArea = field.cellM * field.cellM
  const incision = inciseChannels(field.height, acc, gridN, {
    // A trunk canyon at full drainage on mountainous relief cuts ~24 m; gentle country
    // gets a 2 m gully, which is about right for a chalk dry valley.
    maxDepthM: drainage * (2 + 22 * relief),
    thresholdAreaM2: CHANNEL_THRESHOLD_CELLS * cellArea,
    saturationAreaM2: 0.02 * domainM * domainM,
    // A 12 m bank on a cut of up to 24 m gives a wall around 45 degrees at full drainage —
    // steep, walkable, and short of the 0.7 clamp on Rothermel's slope factor.
    bankRadiusNodes: Math.max(1, Math.round(12 / field.cellM)),
    blurPasses: 2,
  })
  t.incision = now() - mark

  // --- 7. Final fill, then gradients from the final surface --------------
  mark = now()
  const finalFill = priorityFloodFill(field)
  t.finalFill = now() - mark

  mark = now()
  field.recomputeGradients()
  t.gradients = now() - mark

  const finalReceivers = field.computeReceivers()
  const finalAcc = flowAccumulation(field, finalFill.order, finalReceivers)
  const paths = drainagePathCheck(field, finalReceivers)
  const channelThreshold = CHANNEL_THRESHOLD_CELLS * cellArea
  let channelCells = 0
  for (let k = 0; k < finalAcc.length; k++) {
    if ((finalAcc[k] as number) > channelThreshold) channelCells++
  }

  mark = now()
  const texels = packTerrainTexels(field)
  t.pack = now() - mark

  t.total = now() - t0

  return {
    params,
    seed,
    gridN,
    field,
    stats: field.stats(),
    diagnostics: {
      filledCells: finalFill.filledCells,
      maxFillDepthM: finalFill.maxFillDepthM,
      closedBasins: field.findClosedBasins(1).length,
      maxPathSteps: paths.maxPathSteps,
      unresolvedPaths: paths.unresolved,
      channelCells,
      channelFraction: channelCells / (gridN * gridN),
      deepestIncisionM: incision.maxDepthM,
      erosion,
    },
    timingsMs: t,
    texels,
    flowAccumM2: finalAcc,
  }
}
