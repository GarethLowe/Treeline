/**
 * Smoke source terms. Everything here is what the GPU pass transliterates, so a disagreement
 * between this and `smoke.wgsl` is a rendered plume that is wrong by a factor nobody notices.
 */

import { describe, expect, it } from 'vitest'
import {
  F_FLAMING,
  F_SMOULDERING,
  SOOT_YIELD_FLAMING,
  SOOT_YIELD_SMOULDERING,
  compositionOf,
  flamingFraction,
  massLossRate,
  smokeSource,
} from '@sim/smoke/emission.ts'
import { burnoutModelFor, consumedFraction } from '@sim/burnout/consumption.ts'
import { FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { s } from '@contracts/units.ts'

const GR2 = burnoutModelFor(FUEL_MODELS.get('GR2'), s(20))

describe('massLossRate', () => {
  it('is the derivative of the burnout curve WP 2.4 integrates', () => {
    // Integrate the rate numerically and compare against the consumed fraction. If these two
    // drift, the smoke field emits mass the fuel bed never lost.
    const dt = 0.01
    let integrated = 0
    for (let t = dt / 2; t < 200; t += dt) integrated += massLossRate(GR2, t) * dt
    const consumedMass = consumedFraction(GR2, s(200)) * GR2.totalLoad
    expect(integrated).toBeCloseTo(consumedMass, 2)
  })

  it('is zero before the front arrives and decays afterwards', () => {
    expect(massLossRate(GR2, 0)).toBe(0)
    expect(massLossRate(GR2, -5)).toBe(0)
    const early = massLossRate(GR2, 1)
    const late = massLossRate(GR2, 60)
    expect(early).toBeGreaterThan(0)
    expect(late).toBeGreaterThan(0)
    expect(late).toBeLessThan(early)
  })

  it('never exceeds the total loading no matter how long it runs', () => {
    const dt = 0.05
    let integrated = 0
    for (let t = dt / 2; t < 5000; t += dt) integrated += massLossRate(GR2, t) * dt
    expect(integrated).toBeLessThanOrEqual(GR2.totalLoad * 1.001)
  })
})

describe('smokeSource', () => {
  it('switches regime at the residence time, exactly where WP 2.4 relabels the cell', () => {
    expect(flamingFraction(GR2, GR2.residenceTime - 0.01)).toBe(1)
    expect(flamingFraction(GR2, GR2.residenceTime + 0.01)).toBe(0)
  })

  it('emits EC-rich smoke while flaming and OC-rich once smouldering', () => {
    const flaming = smokeSource(GR2, GR2.residenceTime * 0.5)
    const smouldering = smokeSource(GR2, GR2.residenceTime * 2)
    expect(compositionOf(flaming.totalMassRate, flaming.ecMassRate)).toBeCloseTo(F_FLAMING, 6)
    expect(compositionOf(smouldering.totalMassRate, smouldering.ecMassRate)).toBeCloseTo(F_SMOULDERING, 6)
    // Flaming smoke is darker: more elemental carbon per unit mass.
    expect(F_FLAMING).toBeGreaterThan(F_SMOULDERING)
  })

  it('emits more particulate per kg smouldering than flaming', () => {
    expect(SOOT_YIELD_SMOULDERING).toBeGreaterThan(SOOT_YIELD_FLAMING)
  })

  it('produces nothing at all before the front arrives', () => {
    const none = smokeSource(GR2, 0)
    expect(none.totalMassRate).toBe(0)
    expect(none.ecMassRate).toBe(0)
    expect(none.heatRate).toBe(0)
  })

  it('releases heat in proportion to mass, not to smoke', () => {
    // The yields differ by regime but the heat of combustion does not, so heat per unit mass
    // lost must be identical across the boundary while the smoke yield jumps.
    const a = smokeSource(GR2, GR2.residenceTime * 0.9)
    const b = smokeSource(GR2, GR2.residenceTime * 1.1)
    const perKgA = a.heatRate / massLossRate(GR2, GR2.residenceTime * 0.9)
    const perKgB = b.heatRate / massLossRate(GR2, GR2.residenceTime * 1.1)
    expect(perKgA).toBeCloseTo(perKgB, 6)
  })
})

describe('compositionOf', () => {
  it('mixes two parcels by mass, which is the whole reason both are carried', () => {
    // A kg of flaming smoke and a kg of smouldering smoke mix to the mean composition.
    const totalA = 1
    const ecA = totalA * F_FLAMING
    const totalB = 1
    const ecB = totalB * F_SMOULDERING
    expect(compositionOf(totalA + totalB, ecA + ecB)).toBeCloseTo((F_FLAMING + F_SMOULDERING) / 2, 9)
  })

  it('weights the mix by mass, not by parcel count', () => {
    const mixed = compositionOf(1 + 9, 1 * F_FLAMING + 9 * F_SMOULDERING)
    expect(mixed).toBeCloseTo(0.1 * F_FLAMING + 0.9 * F_SMOULDERING, 9)
  })

  it('reports the flaming endmember for empty air rather than pure organic carbon', () => {
    // f = 0 is the brightest, most-scattering smoke there is. Painting empty air with it is
    // the wrong way to be wrong.
    expect(compositionOf(0, 0)).toBe(F_FLAMING)
  })

  it('stays inside [0, 1] even if the two masses disagree', () => {
    expect(compositionOf(1, 5)).toBe(1)
    expect(compositionOf(1, -5)).toBe(0)
  })
})
