/**
 * WP 3.2 — thermally-thin/thick criterion, ignition-delay integral, and the ignition gate.
 * Spec §7.6.
 *
 * ## Which ignition criterion ships, and why
 *
 * Spec §7.6 compares three: a critical temperature (~600 K), a critical mass flux
 * (McAllister: 1.3-3.0 g/m2/s measured), and single-step Arrhenius kinetics. It recommends
 * Arrhenius-for-the-rate gated by critical-mass-flux. Per spec §0.5.1 this module ships the
 * cheapest form that reproduces that gate, which is neither of the three as stated:
 *
 * **The mass-flux gate is inverted CPU-side into an ignition temperature.** `mdot''` is a
 * monotone function of T at fixed dry mass and LAD, so `mdot'' >= mdot''_crit` is identically
 * `T >= T_ig(LAD, rho_dry)`, and `T_ig` is one `log` on the CPU per fuel class. The GPU then
 * ignites on two comparisons — a temperature and a "is it dry" flag — with no exponential, no
 * pyrolysate-flux read, and no dependence on the timestep the kinetics were integrated at.
 *
 * That last point is the real win, and it is not an ALU argument. Spec §7.6 runs distant
 * voxels at 10 Hz and near ones at 30 Hz; an Arrhenius mass-loss accumulator gated on `mdot''`
 * therefore fires at a step-size-dependent time, so the same fire ignites a crown at different
 * moments depending on where the camera is. A temperature threshold on a state variable that
 * is itself integrated with an unconditionally-stable exponential integrator does not.
 *
 * **The error accepted.** `T_ig` is evaluated from the voxel's INITIAL dry mass, not its
 * current one. Solid lost to pyrolysis before the gate fires raises `T_ig` slightly (less
 * solid, so a higher temperature is needed for the same flux). Measured: `+2.6 K` at 5% mass
 * loss, `+11.5 K` at 20%. Both are far inside the 67 K spread `T_ig` already has across the
 * plausible specific-leaf-area range (643-711 K over 5-20 m2/kg). It is *invariant* to canopy
 * bulk density, which is the property that matters — the gate does not drift with stand
 * density, only with how much leaf area a kilogram of foliage presents. Asserted in
 * `ignition.test.ts`.
 *
 * **What 600 K would have cost.** At a representative canopy voxel the folkloric 600 K
 * threshold corresponds to a pyrolysate flux of 0.21 g/m2/s — 7.7x below the shipping gate and
 * below every one of the twelve values McAllister measured. Used as the criterion it fires ~90 K
 * early and, far more damagingly, ignites thin hot voxels holding almost no fuel, which is the
 * exact failure spec §7.6 attributes to a bare temperature threshold. It is kept only as a
 * branch-free early-out, where being unconditionally below the gate is all that is required.
 */

import type { Kelvin, Seconds } from '@contracts/units.ts'
import { K, s as seconds } from '@contracts/units.ts'
import { CRITICAL_MASS_FLUX, PYROLYSIS_A, PYROLYSIS_E_OVER_R, SOLID_CONDUCTIVITY } from './constants.ts'

/** Above this Biot number a lumped (single-temperature) treatment stops being defensible. */
export const THERMALLY_THIN_BIOT = 0.1

export type ThermalRegime = 'thin' | 'marginal' | 'thick'

/**
 * Characteristic length `L_c = V/A` for a cylindrical fuel particle: `d/4`.
 * Spec §7.6 states this convention explicitly and every Biot number here uses it.
 */
export function characteristicLength(diameter: number): number {
  return diameter / 4
}

/** `Bi = h L_c / k_s`, with `L_c = d/4`. Spec §7.6: 1 mm needle at h = 154 gives Bi = 0.19. */
export function biotNumber(
  convectiveCoefficient: number,
  diameter: number,
  conductivity: number = SOLID_CONDUCTIVITY,
): number {
  if (conductivity <= 0) return Number.POSITIVE_INFINITY
  return (convectiveCoefficient * characteristicLength(diameter)) / conductivity
}

/**
 * Classification. `thin` below 0.1 (lumped is exact enough to ignore), `marginal` to 0.5
 * (lumped with the correction below), `thick` above (needs a radial sub-model — spec §7.6
 * allocates 3 radial nodes for the 3-6 mm class only, and that is WP 3.1's storage decision,
 * not this module's).
 */
export function thermalRegime(biot: number): ThermalRegime {
  if (biot < THERMALLY_THIN_BIOT) return 'thin'
  if (biot < 0.5) return 'marginal'
  return 'thick'
}

/**
 * Effective convective coefficient for a lumped model of a body with internal resistance.
 *
 * Derivation (cylinder, quasi-steady, uniform surface flux q''): the internal profile is
 * `T(r) = T_s + g(R^2 - r^2)/(4k)` with `g = 2q''/R`, whose volume mean gives
 * `T_mean - T_s = q'' R/(4k) = q'' L_c/(2k)` since `L_c = R/2`. Adding that internal
 * resistance in series with the surface film gives
 *
 *     1/h_eff = 1/h + L_c/(2k)   =>   h_eff = h / (1 + Bi/2)
 *
 * **Spec deviation, deliberate.** Spec §7.6 prescribes `1/(1 + Bi/4)`. That factor is correct
 * only if `Bi` is built on the RADIUS; the same section defines `L_c = V/A = d/4`, and with
 * that definition the correct denominator is `1 + Bi/2`. At the spec's own worked point
 * (Bi = 0.19) the two differ by 4.4% in `h_eff` and hence 4.4% in convective ignition delay —
 * small, but free to get right, so it is got right. Reported in `contract_issues`.
 */
export function effectiveConvection(convectiveCoefficient: number, biot: number): number {
  return convectiveCoefficient / (1 + biot / 2)
}

// ---------------------------------------------------------------------------
// Ignition temperature — the shipping gate
// ---------------------------------------------------------------------------

/**
 * Invert `pyrolysateFlux(rho_dry, T, LAD) = criticalMassFlux` for T. Kelvin.
 *
 * `Infinity` when the voxel simply cannot reach the critical flux at any temperature — that
 * happens when there is too little solid per unit leaf area, and it is the correct answer: a
 * near-empty voxel does not ignite however hot the gas around it gets. This is precisely the
 * "spurious ignition of thin, hot-but-empty voxels" failure spec §7.6 attributes to a bare
 * temperature threshold, and inverting the flux criterion removes it for free.
 */
export function ignitionTemperature(
  dryMass: number,
  leafAreaDensity: number,
  criticalMassFlux: number = CRITICAL_MASS_FLUX,
): Kelvin {
  const area = 2 * leafAreaDensity
  if (dryMass <= 0 || area <= 0 || criticalMassFlux <= 0) return K(Number.POSITIVE_INFINITY)
  const ratio = (PYROLYSIS_A * dryMass) / (criticalMassFlux * area)
  if (ratio <= 1) return K(Number.POSITIVE_INFINITY)
  return K(PYROLYSIS_E_OVER_R / Math.log(ratio))
}

// ---------------------------------------------------------------------------
// Ignition delay
// ---------------------------------------------------------------------------

/**
 * Thermally-thin (lumped) ignition delay under a constant net surface flux, seconds.
 *
 * `rho c L_c (T_ig - T_0) / q''_net`, plus the moisture heat sink, which for a lumped particle
 * is fully in play — the whole particle is one temperature, so every gram of water must go
 * before the particle can pass the boiling point at all. That is the drying front of §7.6.
 *
 * `moistureEnergy` is J per kg of oven-dry solid; pass `moistureHeatSink(...)`.
 */
export function ignitionDelayThin(
  netFlux: number,
  ignitionK: Kelvin,
  initialK: Kelvin,
  diameter: number,
  density: number,
  specificHeat: number,
  moistureEnergy = 0,
): Seconds {
  if (netFlux <= 0) return seconds(Number.POSITIVE_INFINITY)
  const lc = characteristicLength(diameter)
  const energyPerArea =
    density * lc * (specificHeat * Math.max(0, ignitionK - initialK) + Math.max(0, moistureEnergy))
  return seconds(energyPerArea / netFlux)
}

/**
 * Thermally-thick ignition delay under a constant net flux (Quintiere 2006), seconds:
 * `t_ig = (pi/4) k rho c (T_ig - T_0)^2 / q''_net^2`.
 *
 * `thermalInertia` is `k*rho*c` in W^2 s m^-4 K^-2.
 */
export function ignitionDelayThick(
  netFlux: number,
  ignitionK: Kelvin,
  initialK: Kelvin,
  thermalInertia: number,
): Seconds {
  if (netFlux <= 0) return seconds(Number.POSITIVE_INFINITY)
  const dT = Math.max(0, ignitionK - initialK)
  return seconds(((Math.PI / 4) * thermalInertia * dT * dT) / (netFlux * netFlux))
}

/**
 * Flux threshold the thermally-thick integral criterion compares against:
 * `sqrt((pi/4) k rho c) * (T_ig - T_0)`, in W s^(1/2) m^-2.
 *
 * The criterion for a time-varying flux is `integral(q''_net dt) >= threshold * sqrt(t)`
 * (spec §7.6). Feed a running sum and the elapsed time; it reduces exactly to
 * `ignitionDelayThick` for a constant flux, which `ignition.test.ts` asserts.
 */
export function thickIgnitionThreshold(
  ignitionK: Kelvin,
  initialK: Kelvin,
  thermalInertia: number,
): number {
  return Math.sqrt((Math.PI / 4) * thermalInertia) * Math.max(0, ignitionK - initialK)
}

/** Incremental form of the above. `accumulatedFlux` is the running integral of net flux, J/m2. */
export function thickIgnitionReached(
  accumulatedFlux: number,
  elapsed: Seconds,
  threshold: number,
): boolean {
  if (elapsed <= 0) return false
  return accumulatedFlux >= threshold * Math.sqrt(elapsed)
}

/**
 * Steady-state critical incident radiant flux for piloted ignition, W/m2 — the flux at which a
 * surface asymptotes to `T_ig` and never exceeds it. Loses heat by convection at `h` and by
 * re-radiation at `emissivity`, and absorbs the incident flux with the same emissivity
 * (grey surface, Kirchhoff).
 *
 * This is the one absolute number the critical-temperature criterion can be checked against
 * published data without fitting anything: Dietenberger (1996) FPL measured 17 kW/m2 on the
 * LIFT apparatus and extrapolated 10.5 kW/m2 for turbulent free convection on a vertical wall
 * at h = 10 W/m2/K. `ignition.test.ts` asserts both.
 */
export function criticalIncidentFlux(
  ignitionK: Kelvin,
  ambientK: Kelvin,
  convectiveCoefficient: number,
  emissivity: number,
  stefanBoltzmann: number,
): number {
  const convective = convectiveCoefficient * Math.max(0, ignitionK - ambientK)
  const radiative = emissivity * stefanBoltzmann * (ignitionK ** 4 - ambientK ** 4)
  return (convective + radiative) / emissivity
}
