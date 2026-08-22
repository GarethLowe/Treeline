/**
 * Per-cell surface fuel, rasterised from the world's own vegetation.
 *
 * The solver used to read one fuel model over all 4.19 M cells, so a tree, a clearing, a grass
 * patch and bare ground carried identical fire and the five biomes were presentation. Fire
 * cannot find a corridor or a break through fuel that is uniform by construction.
 *
 * Nothing here is authored. `UnderstoryField` already computes, per cell and at world build,
 * the canopy closure from the crown-disc gap model and the understory cover after shade
 * suppression; every species already carries the `surfaceFuelModel` it lays down beneath
 * itself (§20 §4.3). This turns those into a fuel-model id per surface cell:
 *
 *   closed canopy   -> the dominant tree's litter model
 *   open with cover -> the understory's own model (grass, shrub)
 *   neither         -> non-burnable, which is fuel model id 0 and already in the LUT
 *
 * **Moisture stays uniform.** A spatial moisture field is M5's, and inventing one here — from
 * shade, aspect or slope — would be a physical claim with nothing behind it.
 *
 * **Load is not scaled either**, though `packCell` accepts a per-class `mass`. The surface
 * shaders do not read those fields: they are packed and never sampled. Scaling them would look
 * like heterogeneity and change nothing, which is a failure mode this project has hit twice.
 */

import { NON_BURNABLE_ID } from '@sim/rothermel/fuelModels.ts'

/** The per-cell field the understory rasteriser supplies. */
export interface UnderstoryCover {
  readonly cols: number
  readonly sizeM: number
  /** 0..1 canopy closure per cell. */
  readonly canopyClosure: Float64Array
  /** 0..1 understory cover per cell, after shade suppression. */
  readonly cover: Float64Array
}

export interface FuelMapInputs {
  readonly understory: UnderstoryCover
  /** Surface cells per axis. */
  readonly cells: number
  /** Fuel-model id for litter under a closed canopy, i.e. the dominant tree's model. */
  readonly canopyFuelId: number
  /** Fuel-model id for the open understory: the cover species' model. */
  readonly understoryFuelId: number
}

/**
 * Closure at or above which a cell is timber litter rather than whatever grows in the open.
 *
 * Not tuned to a look. §7.2's own crown-disc gap model is what produces `canopyClosure`, and
 * half closure is the point at which litter rather than herbaceous cover is what a surface
 * fire is actually running in. Moving it trades clearing area against timber area and nothing
 * else, so it is a single named number rather than a curve.
 */
export const CLOSED_CANOPY_FRACTION = 0.5

/**
 * Below this much cover AND this little closure, a cell has no surface fuel worth carrying
 * fire and becomes non-burnable.
 *
 * This is the only place the map says "nothing burns here", and it says it because the world
 * put nothing there — not because a road or a river was drawn in. Those would be authored
 * content and belong to a layer that does not exist yet.
 */
export const BARE_GROUND_FRACTION = 0.05

export interface FuelMap {
  /** One fuel-model id per surface cell, row-major, `cells` per axis. */
  readonly fuelIds: Uint8Array
  /** How many cells came out non-burnable — the number that says the map is not uniform. */
  readonly nonBurnableCells: number
  /** Distinct ids present, for the boot report. */
  readonly histogram: ReadonlyMap<number, number>
}

/**
 * Rasterise the understory field onto the surface grid.
 *
 * Nearest sample rather than bilinear: these are fuel-model IDS, and interpolating between
 * two of them produces a third that means something else entirely. The understory grid is far
 * coarser than the 0.5 m surface grid, so this is a blocky map — which is what a fuel map is.
 */
export function buildSurfaceFuelMap(inputs: FuelMapInputs): FuelMap {
  const { understory, cells, canopyFuelId, understoryFuelId } = inputs
  const fuelIds = new Uint8Array(cells * cells)
  const histogram = new Map<number, number>()
  let nonBurnableCells = 0

  const cellM = understory.sizeM / cells
  const perU = understory.sizeM / understory.cols

  for (let j = 0; j < cells; j++) {
    const worldZ = (j + 0.5) * cellM
    const uj = Math.min(understory.cols - 1, Math.max(0, Math.floor(worldZ / perU)))
    for (let i = 0; i < cells; i++) {
      const worldX = (i + 0.5) * cellM
      const ui = Math.min(understory.cols - 1, Math.max(0, Math.floor(worldX / perU)))
      const u = uj * understory.cols + ui
      const closure = understory.canopyClosure[u] ?? 0
      const cover = understory.cover[u] ?? 0

      let id: number
      if (closure >= CLOSED_CANOPY_FRACTION) {
        id = canopyFuelId
      } else if (cover >= BARE_GROUND_FRACTION || closure >= BARE_GROUND_FRACTION) {
        id = understoryFuelId
      } else {
        id = NON_BURNABLE_ID
        nonBurnableCells++
      }
      fuelIds[j * cells + i] = id
      histogram.set(id, (histogram.get(id) ?? 0) + 1)
    }
  }

  return { fuelIds, nonBurnableCells, histogram }
}
