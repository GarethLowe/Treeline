/**
 * WP 3.2 — the single-voxel oracle. Pure, deterministic, no GPU. Spec §7.6.
 *
 * This is the reference the WGSL canopy kernel is diffed against: one voxel, one step, given
 * the gas temperature, convective coefficient and irradiance that WP 3.3 and 3.4 supply.
 *
 * ## Integration scheme and why
 *
 * The lumped convective ODE is stiff — spec §7.6 gives `tau = 1.2 s` at `h = 154`, and the
 * canopy solver runs at 10-30 Hz, so explicit Euler is marginal and goes unstable the moment a
 * gust raises `h`. The scheme here is:
 *
 * 1. **Exponential integrator on the convective term.** `T' = T_inf + (T - T_inf) e^(-dt/tau)`
 *    with `T_inf` the steady state of convection plus radiation. Unconditionally stable, exact
 *    for constant coefficients, and it is what lets distant voxels drop to 10 Hz (spec §7.6's
 *    LOD) without changing the answer. **Measured** (`voxel.test.ts`): stepping at 1 Hz instead
 *    of 120 Hz moves the drying-front position by under 1.3% of the water inventory, and moves
 *    the reported ignition time by less than one step — i.e. the residual error is reporting
 *    quantisation, not integration. There is no stability limit at any step size.
 *
 *    That is the §0.5.1 lever for this package: the kinetics can run at whatever rate the
 *    radiation and plume fields are refreshed at (spec §7.4 runs radiation at 7.5 Hz) without
 *    the ignition timing degrading, so it never needs its own faster clock.
 * 2. **Radiation frozen at the start-of-step temperature.** The `4 sigma T^4` re-emission term
 *    is lagged one step. First-order in dt, and it is the only source of the 1.3% figure above.
 *    Linearising it into `T_inf` would cost a divide and buy nothing visible.
 * 3. **Drying is enthalpy-limited, not rate-limited.** While water remains and the voxel has
 *    reached the boiling point, the temperature is pinned and every incoming joule goes to
 *    phase change. The step solves the crossing time analytically, so energy is conserved to
 *    round-off at any `dt` — no sub-stepping, no CFL condition on the drying front.
 * 4. **Pyrolysis mass loss uses the exact decay `m e^(-k dt)`**, never `m - k m dt`, which
 *    goes negative above `k dt = 1` and creates fuel.
 * 5. **Pyrolysis enthalpy is applied after the temperature update** (operator splitting,
 *    first-order in dt). Below the flaming gate the mass-loss rate is small enough that this
 *    is under 0.1% of the step's energy; above it the voxel is burning and WP 3.5 owns the
 *    energy balance.
 *
 * Char oxidation is deliberately **not** implemented — see `provenance.ts`. It does not affect
 * ignition delay, which is this package's acceptance criterion, and the spec's `A`/`E` pair for
 * it belongs to neither of the two lineages §7.6 discusses.
 */

import type { Kelvin, MoistureFraction, Seconds } from '@contracts/units.ts'
import { K, s as seconds } from '@contracts/units.ts'
import {
  CHAR_SPECIFIC_HEAT,
  CHAR_YIELD,
  CRITICAL_MASS_FLUX,
  PYROLYSIS_HEAT,
  SOLID_SPECIFIC_HEAT,
  STEFAN_BOLTZMANN,
  WATER_BOILING_K,
  WATER_SPECIFIC_HEAT,
} from './constants.ts'
import type { WaterInventory } from './evaporation.ts'
import { evaporateWater, splitWater } from './evaporation.ts'
import { biotNumber, effectiveConvection, ignitionTemperature } from './ignition.ts'
import { decayMass, pyrolysisRate } from './kinetics.ts'

/** Spec §7.2 phase flags. `ash` is omitted: nothing here oxidises char, so nothing reaches it. */
export type VoxelPhase = 'wet' | 'dry' | 'pyrolysing' | 'flaming' | 'char'

/** Pyrolysate flux, as a fraction of the ignition gate, at which the voxel is called pyrolysing. */
const PYROLYSING_FRACTION = 0.01
/** Solid remaining, as a fraction of the initial load, below which the voxel is called char. */
const CHAR_FRACTION = 0.05

export interface CanopyVoxelState {
  readonly temperatureK: Kelvin
  /** Unpyrolysed oven-dry solid, kg per m3 of voxel. */
  readonly dryMass: number
  /** Char produced so far, kg per m3 of voxel. */
  readonly char: number
  readonly water: WaterInventory
  readonly phase: VoxelPhase
  /** Pyrolysate flux per unit fuel surface area over the last step, kg/m2/s. */
  readonly pyrolysateFlux: number
  /** Gate temperature, precomputed once from the initial load. See `ignitionTemperature`. */
  readonly ignitionK: Kelvin
  /** Kept so `char` can be recognised as a fraction of what was there to start with. */
  readonly initialDryMass: number
}

export interface CanopyVoxelEnvironment {
  /** Local gas temperature from the plume, K. WP 3.4. */
  readonly gasTemperatureK: Kelvin
  /** Convective coefficient from Hilpert / Churchill-Bernstein, W/m2/K. WP 3.4. */
  readonly convectiveCoefficient: number
  /** Incident irradiance G, W/m2. WP 3.3. */
  readonly irradiance: number
  /** Beer-Lambert extinction kappa, 1/m. WP 3.3 derives it from LAD. */
  readonly extinction: number
  /** One-sided leaf area density, m2/m3. */
  readonly leafAreaDensity: number
  /** Fuel particle diameter, m. Sets the Biot number and the thermal regime. */
  readonly particleDiameter: number
}

export interface VoxelSeed {
  /** Oven-dry solid, kg per m3 of voxel — the canopy bulk density. */
  readonly dryMass: number
  /** FRACTION of oven-dry mass, not percent. FMC 100% is 1.0. */
  readonly moisture: MoistureFraction
  readonly leafAreaDensity: number
  readonly temperatureK: Kelvin
}

/** Build a cold, undisturbed voxel with its ignition gate already inverted. */
export function makeVoxel(seed: VoxelSeed): CanopyVoxelState {
  return {
    temperatureK: seed.temperatureK,
    dryMass: seed.dryMass,
    char: 0,
    water: splitWater(seed.dryMass, seed.moisture),
    phase: seed.moisture > 0 ? 'wet' : 'dry',
    pyrolysateFlux: 0,
    ignitionK: ignitionTemperature(seed.dryMass, seed.leafAreaDensity),
    initialDryMass: seed.dryMass,
  }
}

/** Volumetric heat capacity of the voxel contents, J/m3/K. */
export function voxelHeatCapacity(state: CanopyVoxelState): number {
  return (
    state.dryMass * SOLID_SPECIFIC_HEAT +
    state.char * CHAR_SPECIFIC_HEAT +
    (state.water.free + state.water.bound) * WATER_SPECIFIC_HEAT
  )
}

/**
 * Net volumetric radiative source, W/m3. `kappa (G - 4 sigma T^4)` — spec §7.4.
 *
 * **`env.irradiance` is TOTAL incident irradiance and must include the ambient longwave
 * background.** The `4 sigma T^4` term is the voxel's own emission into 4 pi and it does not
 * switch off when the fire is far away; feed it fire-only irradiance and every voxel in the
 * domain radiates towards 0 K and freezes. Spec §7.5's own worked example ("20 m ahead ...
 * G = 1.6 kW/m2, q''' = kappa G = 0.95 kW/m3") quietly drops the emission term for exactly
 * this reason — that 1.6 kW/m2 is the EXCESS over background, not G. Add
 * `ambientIrradiance(T_ambient)` to it before passing it in.
 */
export function radiativeSource(env: CanopyVoxelEnvironment, temperature: Kelvin): number {
  return env.extinction * (env.irradiance - 4 * STEFAN_BOLTZMANN * temperature ** 4)
}

/**
 * Background longwave irradiance a voxel sits in when nothing is burning, W/m2. Adding this to
 * the fire's contribution makes `radiativeSource` zero at ambient, which is the condition an
 * unheated canopy must satisfy.
 */
export function ambientIrradiance(ambientK: Kelvin): number {
  return 4 * STEFAN_BOLTZMANN * ambientK ** 4
}

/**
 * Advance one voxel by `dt`. Pure: returns a new state, mutates nothing.
 *
 * `dt` is unrestricted — there is no stability limit. The only accuracy cost of a large step
 * is the lagged radiative re-emission and the split pyrolysis enthalpy, both first order.
 */
export function stepVoxel(
  state: CanopyVoxelState,
  env: CanopyVoxelEnvironment,
  dt: Seconds,
): CanopyVoxelState {
  if (dt <= 0) return state

  const heatCapacity = voxelHeatCapacity(state)
  if (heatCapacity <= 0) return { ...state, phase: 'char', pyrolysateFlux: 0 }

  // Convective conductance per unit voxel volume, W/m3/K. A_v = 2*LAD, both leaf faces
  // (spec §7.5) — the same area the pyrolysate flux is divided by, which is not optional:
  // if they disagree, the gate and the heating that reaches it are on different geometries.
  const biot = biotNumber(env.convectiveCoefficient, env.particleDiameter)
  const exchangeArea = 2 * env.leafAreaDensity
  const conductance = effectiveConvection(env.convectiveCoefficient, biot) * exchangeArea

  const radiative = radiativeSource(env, state.temperatureK)
  let temperature = state.temperatureK
  let water = state.water
  const hasWater = water.free + water.bound > 0

  if (conductance > 0) {
    const tau = heatCapacity / conductance
    const steady = env.gasTemperatureK + radiative / conductance
    const boiling = K(WATER_BOILING_K)

    if (hasWater && temperature < boiling && steady > boiling) {
      // Heat to the boiling point, then spend the rest of the step evaporating.
      const toBoil = tau * Math.log((steady - temperature) / (steady - boiling))
      if (toBoil >= dt) {
        temperature = approach(temperature, steady, dt, tau)
      } else {
        const pinnedPower = conductance * (env.gasTemperatureK - boiling) + radiative
        const result = evaporateWater(water, pinnedPower * (dt - toBoil))
        water = result.water
        temperature = boiling
        if (result.surplus > 0) {
          // Bone dry mid-step: the surplus resumes heating a now-lighter voxel. Recomputing
          // tau here is what keeps the hand-off energy-consistent.
          const dryCapacity = heatCapacity - (state.water.free + state.water.bound) * WATER_SPECIFIC_HEAT
          const dryTau = Math.max(dryCapacity, 1e-9) / conductance
          const remaining = result.surplus / pinnedPower
          temperature = approach(boiling, steady, remaining, dryTau)
        }
      }
    } else if (hasWater && temperature >= boiling) {
      const pinnedPower = conductance * (env.gasTemperatureK - temperature) + radiative
      if (pinnedPower > 0) {
        const result = evaporateWater(water, pinnedPower * dt)
        water = result.water
        if (result.surplus > 0) {
          const dryCapacity = heatCapacity - (state.water.free + state.water.bound) * WATER_SPECIFIC_HEAT
          const dryTau = Math.max(dryCapacity, 1e-9) / conductance
          temperature = approach(temperature, steady, result.surplus / pinnedPower, dryTau)
        }
      } else {
        temperature = approach(temperature, steady, dt, tau)
      }
    } else {
      temperature = approach(temperature, steady, dt, tau)
    }
  } else {
    // Radiation only — no gas contact. Explicit, which is fine: without the convective term
    // there is nothing stiff left. The boiling point is still an exact barrier, though, so the
    // step is split there rather than allowed to jump over the drying pin.
    const boiling = K(WATER_BOILING_K)
    let energy = radiative * dt
    if (hasWater && energy > 0) {
      if (temperature < boiling) {
        const toBoil = (boiling - temperature) * heatCapacity
        if (energy <= toBoil) {
          temperature = K(temperature + energy / heatCapacity)
          energy = 0
        } else {
          temperature = boiling
          energy -= toBoil
        }
      }
      if (energy > 0) {
        const result = evaporateWater(water, energy)
        water = result.water
        temperature = K(temperature + result.surplus / heatCapacity)
      }
    } else {
      temperature = K(temperature + energy / heatCapacity)
    }
  }

  // --- Pyrolysis -----------------------------------------------------------
  const rate = pyrolysisRate(temperature)
  const dryMass = decayMass(state.dryMass, rate, dt)
  const lost = state.dryMass - dryMass
  const char = state.char + lost * CHAR_YIELD
  // Total mass leaving the solid per unit fuel surface area — NOT gas-only. That is the
  // quantity McAllister's balance measured, and it is the quantity `ignitionTemperature`
  // inverts, so the two agree by construction. Multiplying by (1 - CHAR_YIELD) here would be
  // more mechanistic but would import an `estimated` constant into an otherwise well-anchored
  // gate, moving it 11 K for no measurable gain.
  const pyrolysateFlux = exchangeArea > 0 ? lost / (exchangeArea * dt) : 0

  if (lost > 0) {
    const capacity = dryMass * SOLID_SPECIFIC_HEAT + char * CHAR_SPECIFIC_HEAT +
      (water.free + water.bound) * WATER_SPECIFIC_HEAT
    if (capacity > 0) temperature = K(temperature - (lost * PYROLYSIS_HEAT) / capacity)
  }

  const next: CanopyVoxelState = {
    temperatureK: temperature,
    dryMass,
    char,
    water,
    phase: state.phase,
    pyrolysateFlux,
    ignitionK: state.ignitionK,
    initialDryMass: state.initialDryMass,
  }
  return { ...next, phase: classify(next) }
}

function approach(from: Kelvin, steady: number, dt: number, tau: number): Kelvin {
  return K(steady + (from - steady) * Math.exp(-dt / tau))
}

/** True once the voxel has passed the ignition gate, whether or not it has since burnt down. */
export function hasIgnited(state: CanopyVoxelState): boolean {
  return state.phase === 'flaming' || state.phase === 'char'
}

/**
 * Phase classification, including the shipping ignition gate: dry, and at or above the
 * mass-flux-derived ignition temperature. Both conditions are comparisons — no exponential.
 *
 * The gate is tested BEFORE the char test on purpose. At a 1 s step a voxel in an 1100 K plume
 * can cross the gate and burn to under 5% of its load inside one step; testing char first made
 * it skip `flaming` entirely and report as never having ignited, which is a coarse-timestep
 * bug of exactly the kind that only appears on the LOD path.
 */
function classify(state: CanopyVoxelState): VoxelPhase {
  if (state.water.free + state.water.bound > 0) return 'wet'
  const spent = state.dryMass <= CHAR_FRACTION * state.initialDryMass
  const ignited = hasIgnited(state) || state.temperatureK >= state.ignitionK
  if (ignited) return spent ? 'char' : 'flaming'
  if (spent) return 'char'
  return state.pyrolysateFlux >= PYROLYSING_FRACTION * CRITICAL_MASS_FLUX ? 'pyrolysing' : 'dry'
}

/**
 * Run a voxel to ignition under a fixed environment and report the delay, seconds.
 * `Infinity` if it does not reach the gate within `limit`. This is the function the
 * published-data tests drive.
 *
 * The answer is quantised to `dt` by construction — a 0.5 s step cannot report a 1.27 s
 * ignition as anything but 1.5 s. That quantisation, not integration error, dominates the
 * apparent timestep sensitivity; `voxel.test.ts` separates the two.
 */
export function timeToIgnition(
  state: CanopyVoxelState,
  env: CanopyVoxelEnvironment,
  dt: Seconds,
  limit: Seconds,
): Seconds {
  let current = state
  let t = 0
  while (t < limit) {
    current = stepVoxel(current, env, dt)
    t += dt
    if (hasIgnited(current)) return seconds(t)
  }
  return seconds(Number.POSITIVE_INFINITY)
}
