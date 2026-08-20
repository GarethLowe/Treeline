/**
 * Turning M1 vegetation into the three stand numbers Van Wagner needs. WP 3.5, spec §30 §7.1.
 *
 * There is deliberately very little here, because most of the work is already done elsewhere
 * and doing it again would be doing it differently:
 *
 * - **Stand canopy bulk density is NOT `Stem.crownBulkDensity`.** The per-stem field is
 *   *within-crown* (M1 `species.ts` settles this at length: `TreeMesh.derived.crownBulkDensity`
 *   is measured from generated geometry, so it can only be foliage mass over the crown
 *   envelope's own volume). The stand figure is foliage mass over *ground* area × canopy
 *   depth, several times smaller because crowns do not fill a stand. M1 already computes it
 *   as `VegetationDiagnostics.measuredStandCrownBulkDensity`, with the per-form crown shape
 *   factors, and WP 3.1's 2 m voxeliser will produce the authoritative version. This module
 *   consumes one of those; it does not invent a third.
 * - **CBH and FMC** are per-stem physical parameters on `Stem` and are aggregated here.
 *
 * The input is declared structurally rather than importing `VegetationSet`, so WP 3.5 stays
 * a pure CLI-testable module and does not drag world generation into a unit test.
 */

import type { Stem } from '@contracts/world.ts'
import { kgm3, m, moistureFraction } from '@contracts/units.ts'
import type { KgPerCubicMetre, Metres } from '@contracts/units.ts'
import type { StandCrownParams } from './vanWagner.ts'

/** The subset of `Stem` this module reads. Keeps test fixtures to five fields. */
export type CrownStem = Pick<
  Stem,
  'heightM' | 'crownBaseM' | 'foliarMoisture' | 'hasLadderFuels'
>

export interface StandAggregationOptions {
  /**
   * Effective canopy base height, m, for stems M1 measured a surface-to-crown fuel path on
   * (`Stem.hasLadderFuels`). A ladder fuel *is* a continuous fuel path from the surface into
   * the crown, so for those stems the height the flame has to bridge is the top of the
   * ladder, not the lowest live foliage.
   *
   * Left undefined by default: the value is the understory/ladder height, which lives in the
   * weather-and-fuels layer (M5) and in WP 3.1's voxel field, not here. Supplying a number
   * invented in this file would be exactly the guess §0.7.1 forbids. When omitted, ladder
   * fuels have no effect and torching is under-predicted in stands that have them — stated
   * in `CROWN_FIRE_MODEL.openQuestions`.
   */
  readonly ladderFuelCbhM?: Metres
}

/**
 * Stand aggregate from a stem list plus a stand bulk density from M1 or WP 3.1.
 *
 * `canopyBaseHeight` is the arithmetic mean of per-stem crown base over stems that have a
 * crown — Van Wagner's own stand-mean definition. The operational alternative (Scott &
 * Reinhardt 2001 / FuelCalc "effective" CBH: the lowest height at which the vertical bulk
 * density profile exceeds 0.011 kg m⁻³) needs a vertical profile that only WP 3.1's voxel
 * field can give, and it generally sits *lower* than the stand mean — so this aggregate is
 * conservative about torching. Recorded in provenance rather than hidden.
 *
 * Cost is O(stems), one pass, no allocation: **measured** at 2.1 ms for 50 000 stems on the
 * target i9-13900HX under Node (`stand.test.ts`). Stand geometry is static, so this runs
 * **once at world load**, not per step. Foliar moisture changes on the weather model's
 * timescale (minutes); re-run then, or override `foliarMoisture` on the returned object,
 * which is one object literal.
 */
export function aggregateStand(
  stems: readonly CrownStem[],
  standCrownBulkDensity: KgPerCubicMetre,
  options: StandAggregationOptions = {},
): StandCrownParams {
  let cbhSum = 0
  let fmcSum = 0
  let n = 0
  for (const st of stems) {
    // A stem with no crown depth contributes no canopy fuel layer, so it must not pull the
    // stand crown base up or its moisture into the mean.
    if (!(st.heightM > st.crownBaseM)) continue
    const ladder = options.ladderFuelCbhM
    cbhSum +=
      st.hasLadderFuels && ladder !== undefined ? Math.min(ladder, st.crownBaseM) : st.crownBaseM
    fmcSum += st.foliarMoisture
    n++
  }
  if (n === 0) {
    return {
      canopyBaseHeight: m(0),
      canopyBulkDensity: kgm3(0),
      foliarMoisture: moistureFraction(0),
    }
  }
  return {
    canopyBaseHeight: m(cbhSum / n),
    canopyBulkDensity: kgm3(Math.max(0, standCrownBulkDensity)),
    foliarMoisture: moistureFraction(fmcSum / n),
  }
}
