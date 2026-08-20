/**
 * WP 3.2 — Arrhenius mass-loss kinetics, ONE lineage (Grishin 1997 pairs). Spec §7.6.
 *
 * These rate laws exist to produce the pyrolysate mass flux `mdot''` that the ignition gate is
 * calibrated against, and the mass loss that drives canopy consumption. They are NOT evaluated
 * per voxel per frame in the shipping solver: `ignitionTemperature()` in `ignition.ts` inverts
 * the pyrolysis law CPU-side once per fuel class, so the GPU compares a temperature instead of
 * evaluating an exponential. See that file for why.
 */

import type { Kelvin, Seconds } from '@contracts/units.ts'
import {
  EVAPORATION_A,
  EVAPORATION_E_OVER_R,
  PYROLYSIS_A,
  PYROLYSIS_E_OVER_R,
} from './constants.ts'

/**
 * First-order Arrhenius rate constant, `A * exp(-E/(R T))`, in s^-1.
 * `eOverR` is E/R in kelvin — the form every wildland kinetics table is published in, and the
 * form that cannot silently lose the gas constant.
 */
export function arrheniusRate(a: number, eOverR: number, temperature: Kelvin): number {
  if (temperature <= 0) return 0
  return a * Math.exp(-eOverR / temperature)
}

/**
 * Grishin free-water evaporation rate constant, s^-1. Note the `T^(-1/2)`: the published
 * pre-exponential carries K^(1/2) precisely because of it, and dropping it is a factor-of-20
 * error at 373 K.
 *
 * This is NOT what drives drying in `stepVoxel` — drying there is enthalpy-limited (the solid
 * temperature is pinned at the boiling point and every incoming joule goes to phase change),
 * which is both the physically correct regime for a heated fuel particle and the one that
 * conserves energy exactly at any timestep. This function exists so the two can be compared,
 * and because a kinetics module that omits the stage the spec tabulates is misleading.
 */
export function evaporationRate(temperature: Kelvin): number {
  if (temperature <= 0) return 0
  return (EVAPORATION_A / Math.sqrt(temperature)) * Math.exp(-EVAPORATION_E_OVER_R / temperature)
}

/** Grishin pyrolysis rate constant, s^-1. */
export function pyrolysisRate(temperature: Kelvin): number {
  return arrheniusRate(PYROLYSIS_A, PYROLYSIS_E_OVER_R, temperature)
}

/**
 * Volumetric pyrolysate generation rate, kg m^-3 s^-1, for a voxel holding `dryMass` kg/m3 of
 * unpyrolysed solid at `temperature`.
 */
export function pyrolysisMassRate(dryMass: number, temperature: Kelvin): number {
  return pyrolysisRate(temperature) * Math.max(0, dryMass)
}

/**
 * Pyrolysate flux per unit FUEL SURFACE area, kg m^-2 s^-1 — the quantity the critical-mass-flux
 * ignition criterion is stated in, and the quantity McAllister et al. measured.
 *
 * `leafAreaDensity` is one-sided LAD (m2/m3); the exchanging area is `2*LAD` because both leaf
 * faces pyrolyse (spec §7.5 uses the same `A_v = 2 LAD` for convection, and the two must agree
 * or the ignition gate and the heating that reaches it are on different areas).
 */
export function pyrolysateFlux(
  dryMass: number,
  temperature: Kelvin,
  leafAreaDensity: number,
): number {
  const area = 2 * leafAreaDensity
  if (area <= 0) return 0
  return pyrolysisMassRate(dryMass, temperature) / area
}

/**
 * Exact solution of `dm/dt = -k m` over one step. Used instead of `m -= k*m*dt` because at
 * flaming temperatures `k*dt` passes 1 and the explicit form goes negative — a mass sink that
 * creates fuel is exactly the kind of bug that only shows up as a too-fast fire.
 *
 * Returns the mass remaining.
 */
export function decayMass(mass: number, rate: number, dt: Seconds): number {
  if (mass <= 0 || rate <= 0) return Math.max(0, mass)
  return mass * Math.exp(-rate * dt)
}
