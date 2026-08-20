/**
 * WP 3.2 — the evaporation heat sink, asserted against textbook thermodynamics.
 *
 * This is the largest single energy in the canopy balance, so it is asserted against primary
 * property data rather than against the spec's rounded arithmetic, and the two are compared
 * so the difference is visible rather than silently absorbed.
 */

import { describe, expect, it } from 'vitest'
import { BOUND_WATER_DESORPTION_HEAT, FIBRE_SATURATION_MOISTURE, SOLID_SPECIFIC_HEAT, WATER_BOILING_K, WATER_LATENT_HEAT, WATER_SPECIFIC_HEAT } from '@sim/canopy/kinetics/constants.ts'
import { evaporateWater, latentEnergyRemaining, moistureHeatSink, splitWater, timeToDry } from '@sim/canopy/kinetics/evaporation.ts'
import { K, moistureFraction } from '@contracts/units.ts'
import { MCALLISTER_2011_MOISTURE } from './published.ts'

describe('textbook property values', () => {
  it('latent heat of vaporisation matches NIST at the normal boiling point', () => {
    // dvapH = 40.65 kJ/mol, M = 18.01528 g/mol.
    expect(Math.abs(WATER_LATENT_HEAT / (40650 / 0.01801528) - 1)).toBeLessThan(1e-4)
    // ... and the spec's rounded 2.26e6 to three figures.
    expect(WATER_LATENT_HEAT / 1e6).toBeCloseTo(2.26, 2)
  })

  it('boiling point is on ITS-90, not IPTS-68', () => {
    expect(WATER_BOILING_K).toBeCloseTo(373.124, 3)
    // The familiar 373.15 is the old scale; the 26 mK difference is immaterial here but
    // getting it right is free.
    expect(Math.abs(WATER_BOILING_K - 373.15)).toBeLessThan(0.03)
  })

  it('liquid water specific heat is the mean over the heating interval', () => {
    // IAPWS-95: 4180 J/kg/K at 300 K, 4216 at 373 K.
    expect(WATER_SPECIFIC_HEAT).toBeGreaterThanOrEqual(4180)
    expect(WATER_SPECIFIC_HEAT).toBeLessThanOrEqual(4216)
  })
})

describe('moisture heat sink', () => {
  it('is exactly sensible + latent + desorption', () => {
    const mc = moistureFraction(0.6)
    const expected =
      0.6 * WATER_SPECIFIC_HEAT * (WATER_BOILING_K - 300) +
      0.6 * WATER_LATENT_HEAT +
      FIBRE_SATURATION_MOISTURE * BOUND_WATER_DESORPTION_HEAT
    expect(moistureHeatSink(mc, K(300))).toBeCloseTo(expected, 6)
  })

  it('caps the desorption term at the fibre saturation point', () => {
    const wet = moistureHeatSink(moistureFraction(2.0), K(300))
    const perKgAtSaturation = moistureHeatSink(moistureFraction(FIBRE_SATURATION_MOISTURE), K(300))
    // Above FSP every extra kilogram costs sensible + latent only, no extra desorption.
    const marginal = (wet - perKgAtSaturation) / (2.0 - FIBRE_SATURATION_MOISTURE)
    expect(marginal).toBeCloseTo(
      WATER_SPECIFIC_HEAT * (WATER_BOILING_K - 300) + WATER_LATENT_HEAT,
      6,
    )
  })

  it('reproduces the spec §7.6 worked voxel, and shows what the spec left out', () => {
    // Spec §7.5: 1.2 kg dry mass at FMC 100%, "drying 1.2*(4186*80 + 2.26e6) = 3.1 MJ".
    const perKg = moistureHeatSink(moistureFraction(1.0), K(293))
    const mj = (1.2 * perKg) / 1e6
    expect(mj).toBeGreaterThan(3.1)
    expect(mj).toBeLessThan(3.3)
    // The 3.8% excess is the bound-water desorption term the spec's arithmetic omits.
    const withoutDesorption = (1.2 * (perKg - FIBRE_SATURATION_MOISTURE * BOUND_WATER_DESORPTION_HEAT)) / 1e6
    expect(withoutDesorption).toBeCloseTo(3.11, 2)
  })

  it('dwarfs the dry-solid sensible heat at canopy foliar moisture', () => {
    // FMC 100% is the middle of Van Wagner's validated envelope (95-135%).
    const water = moistureHeatSink(moistureFraction(1.0), K(300))
    const solid = SOLID_SPECIFIC_HEAT * (690 - 300)
    expect(water / solid).toBeGreaterThan(4)
    expect(water / solid).toBeLessThan(5)
  })
})

describe('water inventory', () => {
  it('splits free and bound at the fibre saturation point', () => {
    const dry = splitWater(0.15, moistureFraction(0.1))
    expect(dry.free).toBe(0)
    expect(dry.bound).toBeCloseTo(0.015, 12)

    const wet = splitWater(0.15, moistureFraction(1.0))
    expect(wet.bound).toBeCloseTo(0.15 * FIBRE_SATURATION_MOISTURE, 12)
    expect(wet.free).toBeCloseTo(0.15 - 0.15 * FIBRE_SATURATION_MOISTURE, 12)
    expect(wet.free + wet.bound).toBeCloseTo(0.15, 12)
  })

  it('rejects percent masquerading as a fraction by producing an absurd inventory', () => {
    // Not a guard — a canary. FMC quoted as 100 (percent) instead of 1.0 (fraction) gives a
    // voxel holding 15 kg of water per m3, which nothing in the canopy can ever dry.
    const wrong = splitWater(0.15, moistureFraction(100))
    expect(wrong.free + wrong.bound).toBeCloseTo(15, 6)
  })
})

describe('evaporation energy accounting', () => {
  it('conserves energy exactly through a partial evaporation', () => {
    const water = splitWater(0.15, moistureFraction(1.0))
    const energy = 1e5
    const after = evaporateWater(water, energy)
    expect(after.surplus).toBe(0)
    const spent = latentEnergyRemaining(water) - latentEnergyRemaining(after.water)
    expect(spent).toBeCloseTo(energy, 6)
  })

  it('spends free water before bound water', () => {
    const water = splitWater(0.15, moistureFraction(1.0))
    const after = evaporateWater(water, water.free * WATER_LATENT_HEAT)
    expect(after.water.free).toBeCloseTo(0, 12)
    expect(after.water.bound).toBeCloseTo(water.bound, 12)
  })

  it('hands back the surplus once bone dry, to the last joule', () => {
    const water = splitWater(0.15, moistureFraction(1.0))
    const total = latentEnergyRemaining(water)
    const after = evaporateWater(water, total + 12345)
    expect(after.water.free).toBe(0)
    expect(after.water.bound).toBe(0)
    expect(after.surplus).toBeCloseTo(12345, 6)
  })

  it('is invariant to how the energy is delivered', () => {
    // Ten small parcels must dry exactly as much as one big one — this is what lets the voxel
    // integrator take a 0.5 s step through the drying pin without sub-stepping.
    const water = splitWater(0.15, moistureFraction(1.0))
    const oneShot = evaporateWater(water, 2e5)
    let piecewise = water
    for (let i = 0; i < 10; i++) piecewise = evaporateWater(piecewise, 2e4).water
    expect(piecewise.free).toBeCloseTo(oneShot.water.free, 10)
    expect(piecewise.bound).toBeCloseTo(oneShot.water.bound, 10)
  })
})

describe('drying front', () => {
  it('drying dominates the preheat time at foliar moisture', () => {
    const dryMass = 0.15
    const water = splitWater(dryMass, moistureFraction(1.0))
    // Spec §7.5's 20 m-ahead radiative source, 0.96 kW/m3.
    const power = 960
    const dry = timeToDry(water, dryMass, SOLID_SPECIFIC_HEAT, K(300), power)
    const afterDrying = (dryMass * SOLID_SPECIFIC_HEAT * (690 - WATER_BOILING_K)) / power
    // 431 s to dry, 74 s more to reach the ignition gate: the drying front leads the thermal
    // front by a factor of ~6 in time, which at any front speed is several voxels in space.
    expect(dry).toBeGreaterThan(400)
    expect(dry).toBeLessThan(460)
    expect(dry / afterDrying).toBeGreaterThan(5)
  })

  it('a bone-dry voxel has no drying delay at all', () => {
    const water = splitWater(0.15, moistureFraction(0))
    expect(timeToDry(water, 0.15, SOLID_SPECIFIC_HEAT, K(WATER_BOILING_K), 960)).toBe(0)
  })
})

describe('bound on applying the lumped sink to a thermally-thick sample', () => {
  /**
   * McAllister et al. (2011) measured piloted-ignition delay for poplar at three moisture
   * contents. Poplar blocks are thermally THICK; canopy foliage is thermally thin. Asserting
   * the difference is the point — it is the stated bound on where this sink may be used.
   */
  const rows = MCALLISTER_2011_MOISTURE
  const dryRow = rows[0]
  const meanRatio = (index: number): number => {
    const row = rows[index]
    if (!row || !dryRow) throw new Error('table')
    let sum = 0
    for (let i = 0; i < row.times.length; i++) sum += (row.times[i] ?? 0) / (dryRow.times[i] ?? 1)
    return sum / row.times.length
  }

  it('the lumped sink over-predicts the measured moisture effect on thick samples', () => {
    for (const [index, tolerance] of [
      [1, 0.2],
      [2, 0.5],
    ] as const) {
      const row = rows[index]
      if (!row) throw new Error('table')
      const measured = meanRatio(index)
      const solid = SOLID_SPECIFIC_HEAT * 320
      const lumped = (solid + moistureHeatSink(moistureFraction(row.moisture), K(300))) / solid
      expect(lumped).toBeGreaterThan(measured)
      expect(lumped / measured - 1).toBeLessThan(tolerance)
    }
    // Concretely: predicted 1.48 and 2.10 against measured means 1.28 and 1.47.
    expect(meanRatio(1)).toBeCloseTo(1.284, 2)
    expect(meanRatio(2)).toBeCloseTo(1.466, 2)
  })

  it('the thermally-thick rho*c scaling reproduces the same data to 5%', () => {
    // For a thick sample t_ig ~ k rho c, and moisture enters as an added heat capacity only:
    // the water leaves the heated surface layer without every gram of it being boiled.
    for (const index of [1, 2] as const) {
      const row = rows[index]
      if (!row) throw new Error('table')
      const thick =
        (SOLID_SPECIFIC_HEAT + row.moisture * WATER_SPECIFIC_HEAT) / SOLID_SPECIFIC_HEAT
      expect(Math.abs(thick / meanRatio(index) - 1)).toBeLessThan(0.05)
    }
  })
})
