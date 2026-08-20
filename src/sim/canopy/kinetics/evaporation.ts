/**
 * WP 3.2 — moisture as a heat sink, and the drying front. Spec §7.6.
 *
 * This is the term that makes low-FMC crowns ignite at low surface intensity and high-FMC
 * crowns refuse to, and it is what Van Wagner's `I_0` is a curve fit to. It is also the
 * largest energy in the canopy balance: at FMC = 100% the water carries 4.5x the energy the
 * dry solid needs to reach ignition, so a 10% error here swamps a 10% error in anything else.
 *
 * **Free vs bound water.** Above the fibre saturation point (~30% MC) water is free. Below it,
 * water is sorbed into the cell wall and needs an extra desorption enthalpy on top of the
 * latent heat.
 *
 * **Deliberate simplification (spec §0.5.1).** Spec §7.6 has bound water coming off over
 * 373-450 K rather than isothermally. This module releases all of it at the boiling point with
 * its full desorption enthalpy. Total energy is identical — only the temperature history
 * between 373 and 450 K differs, and nothing observable depends on it: the pyrolysis rate
 * constant at 450 K is 3.1e-5 s^-1, so a voxel spends that entire band losing under 0.3% of
 * its solid mass. In exchange the drying stage stays a single enthalpy-limited branch with no
 * temperature-band state machine, which is what lets the integrator take a 0.5 s step and
 * still conserve energy exactly.
 */

import type { Kelvin, MoistureFraction, Seconds } from '@contracts/units.ts'
import { s as seconds } from '@contracts/units.ts'
import {
  BOUND_WATER_DESORPTION_HEAT,
  FIBRE_SATURATION_MOISTURE,
  WATER_BOILING_K,
  WATER_LATENT_HEAT,
  WATER_SPECIFIC_HEAT,
} from './constants.ts'

/** Water inventory of a voxel, split at the fibre saturation point. Both kg per m3 of voxel. */
export interface WaterInventory {
  readonly free: number
  readonly bound: number
}

/**
 * Split a voxel's water into free and bound at the fibre saturation point.
 * `dryMass` is oven-dry solid, kg/m3 of voxel; `moisture` is the oven-dry-mass FRACTION.
 */
export function splitWater(dryMass: number, moisture: MoistureFraction): WaterInventory {
  const solid = Math.max(0, dryMass)
  const total = solid * Math.max(0, moisture)
  const bound = Math.min(total, solid * FIBRE_SATURATION_MOISTURE)
  return { free: total - bound, bound }
}

/**
 * Total heat absorbed by the moisture in one kilogram of oven-dry fuel, taken from `fromK` to
 * fully dry. J per kg of oven-dry solid.
 *
 * Three terms: sensible heat in the liquid up to the boiling point, latent heat of
 * vaporisation for all of it, and desorption enthalpy for the bound fraction. Textbook
 * values, asserted directly in `evaporation.test.ts`.
 */
export function moistureHeatSink(moisture: MoistureFraction, fromK: Kelvin): number {
  const mc = Math.max(0, moisture)
  if (mc === 0) return 0
  const sensible = mc * WATER_SPECIFIC_HEAT * Math.max(0, WATER_BOILING_K - fromK)
  const latent = mc * WATER_LATENT_HEAT
  const desorption = Math.min(mc, FIBRE_SATURATION_MOISTURE) * BOUND_WATER_DESORPTION_HEAT
  return sensible + latent + desorption
}

/** Phase-change energy still owed by a voxel's water at the boiling point. J per m3 of voxel. */
export function latentEnergyRemaining(water: WaterInventory): number {
  return (
    Math.max(0, water.free) * WATER_LATENT_HEAT +
    Math.max(0, water.bound) * (WATER_LATENT_HEAT + BOUND_WATER_DESORPTION_HEAT)
  )
}

/**
 * Spend `energy` (J/m3) evaporating water at the pinned boiling point, free water first.
 *
 * Returns what is left and the energy surplus once the voxel is bone dry. The surplus is what
 * resumes heating the solid — that hand-off is what makes the drying front a front and not a
 * step, and it is why the step below can be taken at any size without losing energy.
 */
export function evaporateWater(
  water: WaterInventory,
  energy: number,
): { readonly water: WaterInventory; readonly surplus: number } {
  let free = Math.max(0, water.free)
  let bound = Math.max(0, water.bound)
  let left = Math.max(0, energy)

  if (free > 0) {
    const capacity = free * WATER_LATENT_HEAT
    if (left >= capacity) {
      left -= capacity
      free = 0
    } else {
      free -= left / WATER_LATENT_HEAT
      return { water: { free, bound }, surplus: 0 }
    }
  }
  if (bound > 0) {
    const perKg = WATER_LATENT_HEAT + BOUND_WATER_DESORPTION_HEAT
    const capacity = bound * perKg
    if (left >= capacity) {
      left -= capacity
      bound = 0
    } else {
      bound -= left / perKg
      return { water: { free, bound }, surplus: 0 }
    }
  }
  return { water: { free, bound }, surplus: left }
}

/**
 * Time for a constant net volumetric heat input `power` (W/m3) to drive a voxel from `fromK`
 * to bone dry, seconds. Infinite if there is no input.
 *
 * This is the drying-front speed. Because radiation is long-range and the temperature pin is
 * per-voxel, voxels several cells ahead of the thermal front finish drying long before they
 * approach ignition; that lead is what lets low-FMC crowns ignite at low surface intensity.
 */
export function timeToDry(
  water: WaterInventory,
  dryMass: number,
  solidSpecificHeat: number,
  fromK: Kelvin,
  power: number,
): Seconds {
  if (power <= 0) return seconds(Number.POSITIVE_INFINITY)
  const totalWater = Math.max(0, water.free) + Math.max(0, water.bound)
  const sensible =
    (Math.max(0, dryMass) * solidSpecificHeat + totalWater * WATER_SPECIFIC_HEAT) *
    Math.max(0, WATER_BOILING_K - fromK)
  return seconds((sensible + latentEnergyRemaining(water)) / power)
}
