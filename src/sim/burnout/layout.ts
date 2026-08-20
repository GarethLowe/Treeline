/**
 * Buffer layouts shared by `fields.ts` (CPU oracle) and `burnout.wgsl` (GPU) — WP 2.4.
 *
 * Pure, so the exact bytes the GPU will read are unit-testable without a device. Every layout
 * bug this catches is one that would otherwise show up as a fire that burns at the wrong rate
 * and looks fine doing it.
 */

import { FUEL_SIZE_CLASSES } from '@contracts/sim'
import { kWm } from '@contracts/units'
import type { CellBurnoutModel } from './consumption.ts'
import { PERIMETER_DEBIAS, bitsToF32 } from './fields.ts'
import type { FireAggregates } from './fields.ts'

/** `struct BurnoutModel` in `burnout.wgsl`: invTau[5], loadFraction[5], residenceTime, totalLoad. */
export const BURNOUT_MODEL_FLOATS = 12
export const BURNOUT_MODEL_BYTES = BURNOUT_MODEL_FLOATS * 4

/** Slots in the aggregate atomic buffer. Must match the `AGG_*` constants in the shader. */
export const AGG_BURNT_CELLS = 0
export const AGG_PERIM_EDGES = 1
export const AGG_FLAMING_X = 3
export const AGG_FLAMING_Z = 4
export const AGG_FLAMING_CELLS = 5
export const AGG_MAX_INTENSITY_BITS = 2
/** burntCells, perimEdges, maxIntensityBits, flamingX, flamingZ, flamingCells. */
export const AGGREGATE_SLOTS = 6

/**
 * Pack the burnout model table for the shader.
 *
 * `invTau` rather than `tau` because the shader multiplies (one reciprocal per model on the
 * CPU beats one divide per class per cell per frame), and because a zero-load class then
 * carries `invTau = 0`, which `class_consumed_fraction` reads as "nothing to burn" without a
 * branch on the loading.
 */
export function packBurnoutModels(models: readonly CellBurnoutModel[]): Float32Array {
  if (models.length === 0) throw new Error('packBurnoutModels: empty table')
  if (models.length > 256) {
    throw new Error(`packBurnoutModels: ${models.length} models exceeds the 8-bit cell index`)
  }
  const out = new Float32Array(models.length * BURNOUT_MODEL_FLOATS)
  models.forEach((model, mi) => {
    const base = mi * BURNOUT_MODEL_FLOATS
    FUEL_SIZE_CLASSES.forEach((c, ci) => {
      out[base + ci] = model.load[c] > 0 ? 1 / model.tau[c] : 0
      out[base + 5 + ci] = model.load[c] > 0 ? model.loadFraction[c] : 0
    })
    out[base + 10] = model.residenceTime
    out[base + 11] = model.totalLoad
  })
  return out
}

/** Four 8-bit fuel-model indices per storage word, little-endian — matches `fuel_index_at`. */
export function packFuelIndex(perCell: Uint8Array): Uint32Array {
  const words = new Uint32Array(Math.ceil(perCell.length / 4))
  for (let i = 0; i < perCell.length; i++) {
    const w = i >> 2
    words[w] = ((words[w] as number) | ((perCell[i] as number) << ((i & 3) * 8))) >>> 0
  }
  return words
}

/** Turn the raw atomic counters into the numbers `IFireOutputs` publishes. */
export function decodeAggregates(raw: Uint32Array, cellM: number): FireAggregates {
  const burntCells = raw[AGG_BURNT_CELLS] ?? 0
  const edges = raw[AGG_PERIM_EDGES] ?? 0
  const maxBits = raw[AGG_MAX_INTENSITY_BITS] ?? 0
  const flamingCells = raw[AGG_FLAMING_CELLS] ?? 0
  // Centroid of the FLAMING front, world metres. Null when nothing is alight — the caller
  // must not fall back to a fixed point, which is the bug this exists to fix.
  const flamingCentroid =
    flamingCells > 0
      ? {
          x: ((raw[AGG_FLAMING_X] ?? 0) / flamingCells + 0.5) * cellM,
          z: ((raw[AGG_FLAMING_Z] ?? 0) / flamingCells + 0.5) * cellM,
        }
      : null
  return {
    burntAreaM2: burntCells * cellM * cellM,
    perimeterM: edges * cellM * PERIMETER_DEBIAS,
    maxFirelineIntensity: kWm(bitsToF32(maxBits)),
    flamingCentroid,
    flamingCells,
  }
}
