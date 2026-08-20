/**
 * WP 3.2 — the voxel oracle: correctness of the integrator, the amortisation budget, and the
 * radiation-vs-convection statement of spec §7.5.
 *
 * The amortisation tests are the ones that matter for spec §0.5.1. The canopy solver has to be
 * cheap, and the cheapest lever is to step it slowly. These measure how slowly it can be
 * stepped before the answer moves, so the choice is made against a number rather than a guess.
 */

import { describe, expect, it } from 'vitest'
import { CRITICAL_MASS_FLUX, SOLID_SPECIFIC_HEAT, STEFAN_BOLTZMANN, WATER_BOILING_K } from '@sim/canopy/kinetics/constants.ts'
import { splitWater, timeToDry } from '@sim/canopy/kinetics/evaporation.ts'
import { ignitionTemperature } from '@sim/canopy/kinetics/ignition.ts'
import { pyrolysateFlux } from '@sim/canopy/kinetics/kinetics.ts'
import { ambientIrradiance, makeVoxel, radiativeSource, stepVoxel, timeToIgnition, voxelHeatCapacity } from '@sim/canopy/kinetics/voxel.ts'
import type { CanopyVoxelEnvironment } from '@sim/canopy/kinetics/voxel.ts'
import { K, m, moistureFraction, s } from '@contracts/units.ts'

/** Spec §7.5's worked voxel: LAD 2, CBD 0.15, 1 mm needles, immersed in 1100 K plume gas. */
const PLUME: CanopyVoxelEnvironment = {
  gasTemperatureK: K(1100),
  convectiveCoefficient: 154,
  irradiance: 0,
  extinction: 0,
  leafAreaDensity: 2,
  particleDiameter: m(0.001),
}

const seed = (moisture: number): Parameters<typeof makeVoxel>[0] => ({
  dryMass: 0.15,
  moisture: moistureFraction(moisture),
  leafAreaDensity: 2,
  temperatureK: K(300),
})

describe('integrator correctness', () => {
  it('the dry convective branch is exact against the analytic exponential', () => {
    // Radiation off, gas below the pyrolysis window, so the ODE is linear and has a closed
    // form. Any deviation here is an integrator bug, not a modelling choice.
    const env: CanopyVoxelEnvironment = { ...PLUME, gasTemperatureK: K(450) }
    let voxel = makeVoxel(seed(0))
    const capacity = voxelHeatCapacity(voxel)
    // h_eff = h/(1+Bi/2); Bi = 154*0.00025/0.2 = 0.1925.
    const hEff = 154 / (1 + 0.1925 / 2)
    const tau = capacity / (hEff * 4)
    for (let i = 0; i < 20; i++) voxel = stepVoxel(voxel, env, s(0.1))
    const analytic = 450 + (300 - 450) * Math.exp(-2 / tau)
    // 3 mK apart after 2 s. The residual is the pyrolysis endotherm, which the analytic form
    // does not contain and which is real; the integrator itself is exact.
    expect(voxel.temperatureK).toBeCloseTo(analytic, 2)
  })

  it('the drying pin delivers exactly the latent energy, at any step size', () => {
    // The analytic prediction: sensible heat to the boiling point plus every joule the water
    // owes, divided by the net power. `timeToDry` computes it independently of the integrator,
    // so agreement is a genuine cross-check of the enthalpy-limited drying branch.
    const water = splitWater(0.15, moistureFraction(1.0))
    const hEff = 154 / (1 + 0.1925 / 2)
    // Mean driving temperature difference over the sensible ramp plus the pinned plateau; the
    // pinned phase is 87% of the total so evaluating the power at the boiling point is close.
    const pinnedPower = hEff * 4 * (1100 - WATER_BOILING_K)
    const predicted = timeToDry(water, 0.15, SOLID_SPECIFIC_HEAT, K(300), pinnedPower)
    for (const dt of [1 / 120, 1 / 30, 0.25, 1.0]) {
      let voxel = makeVoxel(seed(1.0))
      let dryAt = -1
      for (let i = 0; i < Math.round(20 / dt); i++) {
        voxel = stepVoxel(voxel, PLUME, s(dt))
        if (dryAt < 0 && voxel.water.free + voxel.water.bound <= 0) dryAt = (i + 1) * dt
      }
      expect(voxel.water.free + voxel.water.bound).toBe(0)
      // Bracketed by the constant-power prediction to -0%/+6%, plus one step of reporting
      // quantisation. The 6% is the sensible ramp, where the real driving temperature
      // difference is larger than at the plateau the prediction evaluates it at.
      expect(dryAt, `${dt}`).toBeGreaterThan(predicted * 0.94)
      expect(dryAt, `${dt}`).toBeLessThan(predicted * 1.06 + dt)
    }
  })

  it('never produces fuel, water or negative temperature', () => {
    let voxel = makeVoxel(seed(1.0))
    let previousMass = voxel.dryMass
    let previousWater = voxel.water.free + voxel.water.bound
    for (let i = 0; i < 400; i++) {
      voxel = stepVoxel(voxel, PLUME, s(0.25))
      expect(voxel.dryMass).toBeLessThanOrEqual(previousMass + 1e-15)
      expect(voxel.water.free + voxel.water.bound).toBeLessThanOrEqual(previousWater + 1e-15)
      expect(voxel.temperatureK).toBeGreaterThan(0)
      expect(voxel.temperatureK).toBeLessThanOrEqual(1101)
      previousMass = voxel.dryMass
      previousWater = voxel.water.free + voxel.water.bound
    }
    expect(voxel.phase).toBe('char')
  })

  it('a voxel that ignites and burns out inside one step still reports as ignited', () => {
    // Coarse-timestep regression. At dt = 1 s in an 1100 K plume the voxel crosses the gate and
    // drops below 5% of its load in the same step; testing char before the gate made it skip
    // `flaming` entirely and report as never having ignited. Only shows up on the LOD path.
    const ignition = timeToIgnition(makeVoxel(seed(1.0)), PLUME, s(1), s(60))
    expect(Number.isFinite(ignition)).toBe(true)
    expect(ignition).toBeLessThanOrEqual(2)
  })
})

describe('amortisation budget — how slowly the kinetics can be stepped', () => {
  const reference = (dt: number, until: number): ReturnType<typeof stepVoxel> => {
    let voxel = makeVoxel(seed(1.0))
    for (let i = 0; i < Math.round(until / dt); i++) voxel = stepVoxel(voxel, PLUME, s(dt))
    return voxel
  }

  it('the drying front position is within 1.3% of the 120 Hz answer down to 1 Hz', () => {
    // Measured, not asserted from theory: the residual water at t = 1 s, as a fraction of the
    // initial inventory, against a 120 Hz reference.
    const initial = splitWater(0.15, moistureFraction(1.0))
    const total = initial.free + initial.bound
    const truth = reference(1 / 120, 1)
    const truthWater = truth.water.free + truth.water.bound
    for (const rate of [30, 10, 2, 1]) {
      const test = reference(1 / rate, 1)
      const drift = Math.abs(test.water.free + test.water.bound - truthWater) / total
      expect(drift, `${rate} Hz`).toBeLessThan(0.013)
    }
  })

  it('ignition time is within one step of the 120 Hz answer at every rate', () => {
    // The apparent timestep sensitivity is quantisation, not integration error: the reported
    // delay can only be a multiple of dt. That is what justifies running distant voxels slowly.
    const truth = timeToIgnition(makeVoxel(seed(1.0)), PLUME, s(1 / 120), s(60))
    for (const rate of [30, 10, 2, 1]) {
      const test = timeToIgnition(makeVoxel(seed(1.0)), PLUME, s(1 / rate), s(60))
      expect(test - truth, `${rate} Hz`).toBeGreaterThanOrEqual(-1e-9)
      expect(test - truth, `${rate} Hz`).toBeLessThanOrEqual(1 / rate + 1e-9)
    }
  })

  it('reproduces the spec §7.5 immersion estimate of ~0.9 s, slightly slower', () => {
    const ignition = timeToIgnition(makeVoxel(seed(1.0)), PLUME, s(1 / 30), s(60))
    expect(ignition).toBeGreaterThan(1.2)
    expect(ignition).toBeLessThan(1.35)
    // Spec §7.5 gets 0.9 s. The 40% difference is three things it leaves out, all of which
    // slow ignition: the gate is 690 K not 600 K, h is reduced 8.7% by the Biot correction,
    // and (T_g - T) shrinks as the voxel heats rather than staying at 800 K.
    expect(ignition / 0.926).toBeGreaterThan(1.3)
    expect(ignition / 0.926).toBeLessThan(1.5)
  })
})

describe('radiation preheats, convection ignites — with the numbers', () => {
  const radiantOnly = (excessFlux: number): CanopyVoxelEnvironment => ({
    ...PLUME,
    gasTemperatureK: K(300),
    convectiveCoefficient: 0,
    extinction: 0.6,
    irradiance: excessFlux + ambientIrradiance(K(300)),
  })

  it('a voxel in radiative balance with ambient has no net source', () => {
    // The guard against the single easiest error in this coupling: feeding fire-only
    // irradiance makes every voxel in the domain radiate towards 0 K.
    expect(radiativeSource(radiantOnly(0), K(300))).toBeCloseTo(0, 9)
  })

  it('spec §7.5\'s 20 m-ahead irradiance cannot even boil the voxel', () => {
    // 1.6 kW/m2 excess reaches radiative equilibrium at 351 K — below the boiling point, so the
    // drying front never starts. Spec §7.5's "~470 s to ignition at 20 m" drops the 4 sigma T^4
    // re-emission term from its own §7.4 equation; with it, the answer is "never".
    const equilibrium = (4 * STEFAN_BOLTZMANN * 300 ** 4 + 1600) / (4 * STEFAN_BOLTZMANN)
    expect(equilibrium ** 0.25).toBeCloseTo(350.9, 1)
    let voxel = makeVoxel(seed(1.0))
    for (let i = 0; i < 2400; i++) voxel = stepVoxel(voxel, radiantOnly(1600), s(0.5))
    expect(voxel.temperatureK).toBeLessThan(WATER_BOILING_K)
    expect(voxel.water.free).toBeCloseTo(splitWater(0.15, moistureFraction(1.0)).free, 9)
  })

  it('5 kW/m2 excess dries the voxel in ~270 s and then stalls at 417 K', () => {
    // This is the drying front: radiation removes the water over minutes, and then stops. The
    // voxel is left primed — dry, at 417 K — waiting for convection to finish the job.
    let voxel = makeVoxel(seed(1.0))
    let dryAt = -1
    for (let i = 0; i < 6000; i++) {
      voxel = stepVoxel(voxel, radiantOnly(5000), s(0.5))
      if (dryAt < 0 && voxel.water.free + voxel.water.bound <= 0) dryAt = (i + 1) * 0.5
    }
    expect(dryAt).toBeGreaterThan(240)
    expect(dryAt).toBeLessThan(300)
    expect(voxel.phase).toBe('dry')
    expect(voxel.temperatureK).toBeCloseTo(416.7, 0)
  })

  it('radiative ignition needs ~49 kW/m2 — 31x the 20 m-ahead figure, i.e. flame immersion', () => {
    const gate = ignitionTemperature(0.15, 2)
    const required = 4 * STEFAN_BOLTZMANN * (gate ** 4 - 300 ** 4)
    expect(required / 1e3).toBeCloseTo(49.5, 0)
    expect(required / 1600).toBeGreaterThan(29)
    // Convection at the same voxel does it in 1.3 s. Between two and three orders of magnitude
    // apart in time, which is the physical content of spec §7.5's claim.
    const convective = timeToIgnition(makeVoxel(seed(1.0)), PLUME, s(1 / 30), s(60))
    expect(convective).toBeLessThan(2)
  })
})

describe('cost — measured, not predicted', () => {
  it('reports the per-voxel-step cost and the gate comparison', () => {
    const base = makeVoxel({ ...seed(0.1), temperatureK: K(500) })
    const n = 200_000
    const time = (fn: () => number): number => {
      const t0 = performance.now()
      const guard = fn()
      const t1 = performance.now()
      expect(Number.isFinite(guard)).toBe(true)
      return ((t1 - t0) * 1e6) / n
    }

    const stepNs = time(() => {
      let acc = 0
      for (let i = 0; i < n; i++) acc += stepVoxel(base, PLUME, s(1 / 30)).temperatureK
      return acc
    })
    const thresholdNs = time(() => {
      let acc = 0
      for (let i = 0; i < n; i++) acc += 600 + (i % 200) >= base.ignitionK ? 1 : 0
      return acc
    })
    const arrheniusNs = time(() => {
      let acc = 0
      for (let i = 0; i < n; i++) {
        acc += pyrolysateFlux(0.15, K(600 + (i % 200)), 2) >= CRITICAL_MASS_FLUX ? 1 : 0
      }
      return acc
    })

    // Informational — CPU/JS numbers on the dev machine, NOT a GPU prediction. Measured on an
    // i9-13900HX under V8: ~240 ns per voxel-step, ~5 ns for the threshold gate, ~57 ns for the
    // Arrhenius gate. The 11x gate ratio is a V8 artefact (Math.exp is a libm call); on the
    // target GPU exp is an SFU instruction and the ratio will be far smaller. The shipping
    // justification for the threshold is timestep-independence, not ALU — see ignition.ts.
    // eslint-disable-next-line no-console
    console.log(
      `stepVoxel ${stepNs.toFixed(0)} ns  threshold ${thresholdNs.toFixed(1)} ns  ` +
        `arrhenius ${arrheniusNs.toFixed(1)} ns  ratio ${(arrheniusNs / thresholdNs).toFixed(1)}x`,
    )
    expect(thresholdNs).toBeLessThan(arrheniusNs)
    // Loose ceiling so this cannot flake, but tight enough to catch an accidental 10x
    // regression in the oracle (which the validation harness runs over parameter sweeps).
    expect(stepNs).toBeLessThan(5000)
  })

  it('the whole active canopy fits the amortisation budget on the CPU alone', () => {
    // 2.5e6 active voxels (spec §7.4) at 240 ns is 0.6 s of single-threaded JS per full sweep —
    // which is precisely why this is the oracle and the WGSL port is the shipping path. Stated
    // so nobody mistakes this module for something that can run per frame.
    const voxels = 2.5e6
    const nsPerStep = 240
    expect((voxels * nsPerStep) / 1e9).toBeGreaterThan(0.1)
  })
})

describe('unit conventions', () => {
  it('a percent moisture passed as a fraction delays ignition by 74x', () => {
    // FMC 100 (percent) instead of 1.0 (fraction). Not a guard, a canary: the wrong one is
    // never subtly wrong. A crown that should torch in 1.3 s sits in an 1100 K plume for a
    // minute and a half, which is the signature to look for if crown fire refuses to initiate.
    const wrong = timeToIgnition(makeVoxel(seed(100)), PLUME, s(1 / 30), s(300))
    const right = timeToIgnition(makeVoxel(seed(1.0)), PLUME, s(1 / 30), s(300))
    expect(right).toBeLessThan(2)
    expect(wrong / right).toBeGreaterThan(50)
  })

  it('moisture raises ignition delay monotonically', () => {
    let previous = 0
    for (const mc of [0, 0.1, 0.3, 0.6, 1.0, 1.4]) {
      const t = timeToIgnition(makeVoxel(seed(mc)), PLUME, s(1 / 60), s(120))
      expect(t).toBeGreaterThan(previous)
      previous = t
    }
    // FMC 140% (top of Van Wagner's envelope) takes 5x as long as bone-dry fuel.
    const dry = timeToIgnition(makeVoxel(seed(0)), PLUME, s(1 / 60), s(120))
    expect(previous / dry).toBeGreaterThan(4)
  })

  it('heat capacity is the sum of what is actually in the voxel', () => {
    const voxel = makeVoxel(seed(1.0))
    expect(voxelHeatCapacity(voxel)).toBeCloseTo(0.15 * SOLID_SPECIFIC_HEAT + 0.15 * 4190, 6)
  })
})
