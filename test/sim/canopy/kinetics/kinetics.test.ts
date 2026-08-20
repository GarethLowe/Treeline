/**
 * WP 3.2 — Arrhenius kinetics, and the lineage regression.
 *
 * The single most important test in this file is `mixed lineage`. Spec §7.6 records that its
 * own table pairs Grishin's pre-exponentials with activation energies from somewhere else and
 * that this is a ~36x error in pyrolysis rate at 600 K. That estimate is exact. If anyone ever
 * "fixes" the constants back to the spec table, this fails.
 */

import { describe, expect, it } from 'vitest'
import { EVAPORATION_A, EVAPORATION_E_OVER_R, GAS_CONSTANT, PYROLYSIS_A, PYROLYSIS_E_OVER_R } from '@sim/canopy/kinetics/constants.ts'
import { arrheniusRate, decayMass, evaporationRate, pyrolysateFlux, pyrolysisMassRate, pyrolysisRate } from '@sim/canopy/kinetics/kinetics.ts'
import {
  MIXED_LINEAGE_EVAPORATION_E_OVER_R,
  MIXED_LINEAGE_PYROLYSIS_E_OVER_R,
} from '@sim/canopy/kinetics/constants.ts'
import { K, s } from '@contracts/units.ts'

describe('one lineage, both members of the pair', () => {
  it('ships Grishin\'s own pyrolysis pair, not the spec table\'s mixed one', () => {
    expect(PYROLYSIS_A).toBe(3.63e4)
    expect(PYROLYSIS_E_OVER_R).toBe(9400)
    // E = (E/R) * R = 78.16 kJ/mol; the spec quotes 78.1 for this pair.
    expect((PYROLYSIS_E_OVER_R * GAS_CONSTANT) / 1000).toBeCloseTo(78.16, 2)
  })

  it('ships Grishin\'s own evaporation pair', () => {
    expect(EVAPORATION_A).toBe(6.0e5)
    expect(EVAPORATION_E_OVER_R).toBe(6000)
    expect((EVAPORATION_E_OVER_R * GAS_CONSTANT) / 1000).toBeCloseTo(49.9, 1)
  })

  it('mixed lineage: the spec\'s ~36x estimate is exact at 600 K', () => {
    const grishin = arrheniusRate(PYROLYSIS_A, PYROLYSIS_E_OVER_R, K(600))
    const mixed = arrheniusRate(PYROLYSIS_A, MIXED_LINEAGE_PYROLYSIS_E_OVER_R, K(600))
    expect(mixed / grishin).toBeCloseTo(36.0, 1)
  })

  it('mixed lineage shifts the pyrolysis onset by ~137 K', () => {
    // The temperature at which the mixed pair reaches the rate the correct pair reaches at
    // 600 K. This is the "shifts the pyrolysis onset by hundreds of kelvin" of spec §7.6.
    const target = arrheniusRate(PYROLYSIS_A, PYROLYSIS_E_OVER_R, K(600))
    const equivalent = MIXED_LINEAGE_PYROLYSIS_E_OVER_R / Math.log(PYROLYSIS_A / target)
    expect(600 - equivalent).toBeCloseTo(137.2, 1)
  })

  it('mixed lineage evaporation is a 1.8x error at 350 K', () => {
    const grishin = arrheniusRate(1, EVAPORATION_E_OVER_R, K(350))
    const mixed = arrheniusRate(1, MIXED_LINEAGE_EVAPORATION_E_OVER_R, K(350))
    expect(mixed / grishin).toBeCloseTo(1.77, 2)
  })
})

describe('rate laws', () => {
  it('arrhenius is A at infinite temperature and zero at absolute zero', () => {
    expect(arrheniusRate(7, 1000, K(1e12))).toBeCloseTo(7, 6)
    expect(arrheniusRate(7, 1000, K(0))).toBe(0)
  })

  it('evaporation carries the T^(-1/2) the published pre-exponential requires', () => {
    const t = K(373.124)
    expect(evaporationRate(t)).toBeCloseTo(
      (EVAPORATION_A / Math.sqrt(t)) * Math.exp(-EVAPORATION_E_OVER_R / t),
      12,
    )
    // Dropping it would inflate the rate by sqrt(373) ~ 19.3x.
    const withoutRootT = EVAPORATION_A * Math.exp(-EVAPORATION_E_OVER_R / t)
    expect(withoutRootT / evaporationRate(t)).toBeCloseTo(Math.sqrt(t), 6)
  })

  it('pyrolysis mass rate scales linearly with the solid present', () => {
    expect(pyrolysisMassRate(0.3, K(700))).toBeCloseTo(2 * pyrolysisMassRate(0.15, K(700)), 12)
    expect(pyrolysisMassRate(-1, K(700))).toBe(0)
  })

  it('pyrolysate flux divides by 2*LAD, the same area convection uses', () => {
    expect(pyrolysateFlux(0.15, K(700), 2)).toBeCloseTo(pyrolysisMassRate(0.15, K(700)) / 4, 15)
    expect(pyrolysateFlux(0.15, K(700), 0)).toBe(0)
  })

  it('is monotone in temperature over the whole canopy range', () => {
    let previous = 0
    for (let t = 300; t <= 1400; t += 25) {
      const rate = pyrolysisRate(K(t))
      expect(rate).toBeGreaterThan(previous)
      previous = rate
    }
  })
})

describe('mass decay stability', () => {
  it('never goes negative, however coarse the step', () => {
    // At 1400 K, k = 79 s^-1. The explicit form m - k*m*dt would return -3.9 kg at dt = 0.06 s.
    const rate = pyrolysisRate(K(1400))
    expect(rate * 0.06).toBeGreaterThan(1)
    for (const dt of [0.001, 0.06, 0.5, 10]) {
      const left = decayMass(0.15, rate, s(dt))
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left).toBeLessThanOrEqual(0.15)
    }
  })

  it('composes exactly: two half-steps equal one whole step', () => {
    const rate = pyrolysisRate(K(800))
    const whole = decayMass(0.15, rate, s(1))
    const halves = decayMass(decayMass(0.15, rate, s(0.5)), rate, s(0.5))
    expect(halves).toBeCloseTo(whole, 15)
  })
})
