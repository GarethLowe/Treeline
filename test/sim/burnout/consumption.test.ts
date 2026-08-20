/**
 * WP 2.4 acceptance: "cells burn down over time rather than flipping state; total consumption
 * matches fuel loading".
 *
 * Both halves are asserted here, plus the two things that would silently break them: a
 * non-monotonic or non-size-ordered burnout curve, and a heat-release pulse whose integral is
 * not the heat per unit area Rothermel budgeted.
 */

import { describe, expect, it } from 'vitest'
import { FUEL_SIZE_CLASSES } from '@contracts/sim'
import { kWm2, perM, s } from '@contracts/units'
import {
  BURNOUT_CUTOFF,
  DEFAULT_BURNOUT_PARAMS,
  burnoutModelFor,
  classConsumedFraction,
  classMassLossRate,
  consumedByClass,
  consumedFraction,
  flamingConsumption,
  heatPerUnitArea,
  heatReleaseRate,
  heatReleased,
  massLossRate,
  remainingByClass,
  residenceTimeForSav,
} from '@sim/burnout/consumption.ts'
import { STUB_FUEL_MODELS, stubFuelModel, stubResidenceTime } from '../../fixtures/world.ts'

const modelsUnderTest = STUB_FUEL_MODELS.map((f) => burnoutModelFor(f, stubResidenceTime(f)))

describe('residence time (Anderson 1969, t_r = 384/sigma)', () => {
  // Spec §4.7 quotes these two directly, which makes them the ft/m conversion check as well:
  // a SAV converted the wrong way would land 10x off, not 1% off.
  it('reproduces the spec worked values', () => {
    expect(residenceTimeForSav(stubFuelModel('GR2').sav.dead1h)).toBeCloseTo(11.52, 2)
    // sigma = 1500 ft^-1 -> 15.4 s
    expect(residenceTimeForSav(perM(1500 / 0.3048))).toBeCloseTo(15.36, 2)
  })

  it('rejects a zero or negative SAV rather than returning Infinity', () => {
    expect(() => residenceTimeForSav(perM(0))).toThrow(/positive/)
    expect(() => residenceTimeForSav(perM(-5))).toThrow(/positive/)
  })

  it('orders the size classes: 1-h in the flaming front, 100-h smouldering for minutes', () => {
    const sb1 = burnoutModelFor(stubFuelModel('SB1'), stubResidenceTime(stubFuelModel('SB1')))
    expect(sb1.tau.dead1h).toBeCloseTo(11.52, 2)
    expect(sb1.tau.dead10h).toBeCloseTo((384 / 109) * 60, 2) // 3.5 min
    expect(sb1.tau.dead100h).toBeCloseTo((384 / 30) * 60, 2) // 12.8 min
    // Spec §4.7 puts coarse-fuel smouldering at 10-20 min. 100-h lands at 12.8.
    expect(sb1.tau.dead100h / 60).toBeGreaterThan(10)
    expect(sb1.tau.dead100h / 60).toBeLessThan(20)
  })
})

describe('conservation — total consumed equals total loaded', () => {
  it.each(modelsUnderTest.map((m) => [m.code, m] as const))(
    '%s consumes exactly its loading by burnout time',
    (_code, model) => {
      const end = s(model.burnoutTime)
      const consumed = consumedByClass(model, end)
      const remaining = remainingByClass(model, end)

      let total = 0
      for (const c of FUEL_SIZE_CLASSES) {
        total += consumed[c]
        expect(remaining[c]).toBe(0)
        // Per class, too — a bug that over-consumes one class and under-consumes another
        // would pass a total-only check.
        expect(consumed[c]).toBeCloseTo(model.load[c], 12)
      }
      expect(total).toBeCloseTo(model.totalLoad, 12)
      // Not `toBe(1)`: the fraction is a sum of five per-class terms weighted by loadFraction,
      // and for a real fuel model those weights do not sum to exactly 1 in binary. The old stub
      // table happened to; the shipping table does not, and 1 ulp is not a conservation failure.
      expect(consumedFraction(model, end)).toBeCloseTo(1, 12)
    },
  )

  it('never consumes more than was loaded, at any time', () => {
    for (const model of modelsUnderTest) {
      for (let t = 0; t <= model.burnoutTime * 1.5; t += model.burnoutTime / 97) {
        const consumed = consumedByClass(model, s(t))
        for (const c of FUEL_SIZE_CLASSES) {
          expect(consumed[c]).toBeLessThanOrEqual(model.load[c] + 1e-15)
          expect(consumed[c]).toBeGreaterThanOrEqual(0)
        }
        expect(consumedFraction(model, s(t))).toBeLessThanOrEqual(1)
      }
    }
  })

  it('integrates the mass-loss rate back to the total loading', () => {
    // The soot source term (M3/M4) is the derivative of the consumption curve. If the two
    // ever disagree, smoke stops matching char.
    const model = modelsUnderTest[1]!
    const steps = 200_000
    const dt = model.burnoutTime / steps
    let mass = 0
    for (let i = 0; i < steps; i++) {
      mass += massLossRate(model, s((i + 0.5) * dt)) * dt
    }
    expect(mass).toBeCloseTo(model.totalLoad, 4)
  })
})

describe('burnout curves', () => {
  it('are monotonic non-decreasing in time', () => {
    for (const model of modelsUnderTest) {
      let prev = -1
      for (let t = 0; t <= model.burnoutTime * 1.2; t += model.burnoutTime / 300) {
        const f = consumedFraction(model, s(t))
        expect(f).toBeGreaterThanOrEqual(prev)
        prev = f
      }
    }
  })

  it('are ordered by size class: finer fuel is always further along', () => {
    const model = burnoutModelFor(stubFuelModel('SB1'), stubResidenceTime(stubFuelModel('SB1')))
    const coarser: readonly ['dead1h', 'dead10h', 'dead100h'] = ['dead1h', 'dead10h', 'dead100h']
    for (let t = 1; t < model.burnoutTime; t += model.burnoutTime / 200) {
      const f = coarser.map((c) => classConsumedFraction(s(t), model.tau[c]))
      expect(f[0]!).toBeGreaterThanOrEqual(f[1]!)
      expect(f[1]!).toBeGreaterThanOrEqual(f[2]!)
    }
  })

  it('is continuous where it is truncated at 1', () => {
    const tau = s(100)
    const cut = tau * BURNOUT_CUTOFF
    // The renormalisation exists so the curve reaches exactly 1 without a visible step.
    expect(classConsumedFraction(s(cut * (1 - 1e-9)), tau)).toBeCloseTo(1, 6)
    expect(classConsumedFraction(s(cut), tau)).toBe(1)
    expect(classMassLossRate(s(cut), tau)).toBe(0)
  })

  it('is at zero before ignition and handles the degenerate cases', () => {
    const model = modelsUnderTest[0]!
    expect(consumedFraction(model, s(0))).toBe(0)
    expect(consumedFraction(model, s(-10))).toBe(0)
    expect(massLossRate(model, s(-10))).toBe(0)
  })

  it('a scaled timescale slows burnout without changing the total', () => {
    const fuel = stubFuelModel('SB1')
    const slow = burnoutModelFor(fuel, stubResidenceTime(fuel), {
      timescaleScale: { ...DEFAULT_BURNOUT_PARAMS.timescaleScale, dead100h: 2 },
    })
    const base = burnoutModelFor(fuel, stubResidenceTime(fuel))
    expect(slow.tau.dead100h).toBeCloseTo(base.tau.dead100h * 2, 9)
    expect(consumedFraction(slow, s(600))).toBeLessThan(consumedFraction(base, s(600)))
    expect(consumedFraction(slow, s(slow.burnoutTime))).toBe(1)
  })

  it('rejects a fuel model with loading but no SAV', () => {
    const broken = { ...stubFuelModel('TL5') }
    const sav = { ...broken.sav, dead100h: perM(0) }
    expect(() => burnoutModelFor({ ...broken, sav }, s(20))).toThrow(/positive/)
  })
})

describe('burning down, not flipping', () => {
  it('is still consuming fuel well after the cell has left the flaming state', () => {
    // This is the acceptance criterion, stated as a number. SB1 carries 11 t/ac of 100-h;
    // when the flaming front leaves, most of the cell's mass is still there.
    const fuel = stubFuelModel('SB1')
    const model = burnoutModelFor(fuel, stubResidenceTime(fuel))

    const atFlameOut = consumedFraction(model, s(model.residenceTime))
    expect(atFlameOut).toBeLessThan(0.2)

    expect(consumedFraction(model, s(model.residenceTime * 10))).toBeGreaterThan(atFlameOut)
    expect(consumedFraction(model, s(600))).toBeLessThan(1)
    expect(consumedFraction(model, s(model.burnoutTime))).toBe(1)
  })

  it('grass, by contrast, is essentially gone with the front', () => {
    const fuel = stubFuelModel('GR2')
    const model = burnoutModelFor(fuel, stubResidenceTime(fuel))
    expect(consumedFraction(model, s(model.residenceTime * 3))).toBeGreaterThan(0.9)
  })
})

describe('heat release', () => {
  const IR = kWm2(500)
  const tr = s(12)
  const HA = heatPerUnitArea(IR, tr)

  it('H_A = I_R * t_r, in kJ/m2', () => {
    expect(HA).toBeCloseTo(6000, 9)
  })

  it('the gamma pulse integrates to exactly H_A', () => {
    const tau = tr / 2
    const steps = 500_000
    const dt = (tau * 40) / steps
    let sum = 0
    for (let i = 0; i < steps; i++) sum += heatReleaseRate(HA, s((i + 0.5) * dt), tr) * dt
    expect(sum / HA).toBeCloseTo(1, 6)
  })

  it('peaks at t = t_r/2 and matches its own closed-form integral', () => {
    const tau = tr / 2
    const peak = heatReleaseRate(HA, s(tau), tr)
    expect(heatReleaseRate(HA, s(tau * 0.8), tr)).toBeLessThan(peak)
    expect(heatReleaseRate(HA, s(tau * 1.2), tr)).toBeLessThan(peak)

    // Closed form vs quadrature of the rate.
    const steps = 20_000
    const upto = tau * 3
    const dt = upto / steps
    let sum = 0
    for (let i = 0; i < steps; i++) sum += heatReleaseRate(HA, s((i + 0.5) * dt), tr) * dt
    expect(sum).toBeCloseTo(heatReleased(HA, s(upto), tr), 3)
  })

  it('bridges the two forms of Byram intensity', () => {
    // Spec §4.7 states I_B two ways: H_A*R, and Byram's original h*w_a*R. They agree exactly
    // when w_a is the flaming-front consumption H_A/h — which is what flamingConsumption is.
    const fuel = stubFuelModel('TL5')
    const wa = flamingConsumption(HA, fuel.heatContent)
    const R = 0.05 // m/s
    expect(fuel.heatContent * wa * R).toBeCloseTo(HA * R, 9)

    // And it is a fraction of the loading, not all of it — I_R already carries the moisture,
    // mineral and packing damping. The rest burns post-frontally, into smoke.
    const model = burnoutModelFor(fuel, stubResidenceTime(fuel))
    expect(wa).toBeGreaterThan(0)
    expect(wa).toBeLessThan(model.totalLoad)
  })
})
