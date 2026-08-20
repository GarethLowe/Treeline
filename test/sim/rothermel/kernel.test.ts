/**
 * WP 2.1 kernel tests. This is the package's real deliverable: the WGSL port of WP 2.2 is
 * checked against this oracle, so the oracle has to be right before anything downstream means
 * anything.
 *
 * Where the spec gives a published value it is asserted here and cited in the comment.
 */

import { describe, expect, it } from 'vitest'
import { ALL_FUEL_MODELS, FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import {
  curingFraction,
  flameDepth,
  flameLength,
  flamingResidenceTime,
  midflameWind,
  midflameWindAdjustment,
  rothermelIntermediates,
  rothermelROS,
  rothermelSpread,
  shelteredWaf,
  unshelteredWaf,
} from '@sim/rothermel/kernel.ts'
import { m, moistureFraction, mps, mpsToChainsPerHour, toFeetPerMinute } from '@contracts/units.ts'
import { DEAD_SCENARIOS, FIVE_MPH_MPS, LIVE_SCENARIOS, makeCase } from './helpers.ts'

describe('spec §4.2 acceptance test — GR2, scenario D2L2', () => {
  // Dead 1-h M_f = 6%, live herbaceous M_f = 60% => T = 0.667, U = 5 mi/h = 440 ft/min
  // midflame, 0% slope. Spec §20 §4.2, corrected worked example.
  const inputs = makeCase('GR2', { wind: FIVE_MPH_MPS })
  const x = rothermelIntermediates(inputs)
  const out = rothermelSpread(inputs)

  it('cures two thirds of the herbaceous load', () => {
    expect(x.curedTransfer).toBeCloseTo(0.667, 3)
  })

  it('reproduces R ~ 38 ft/min = 11.7 m/min ~ 35 ch/h', () => {
    expect(x.rateOfSpread).toBeCloseTo(38, 0) // ft/min
    expect(out.rateOfSpread * 60).toBeCloseTo(11.7, 1) // m/min
    expect(mpsToChainsPerHour(out.rateOfSpread)).toBeCloseTo(35, 0) // ch/h
  })

  it('reproduces the intermediates the spec quotes', () => {
    expect(x.sav).toBeCloseTo(1820, -1) // "Weighted sigma ~ 1820 ft^-1"
    expect(x.bulkDensity).toBeCloseTo(0.0505, 4) // "rho_b = 0.0505 lb ft^-3"
    expect(x.packingRatio).toBeCloseTo(0.001578, 6) // "beta = 0.001578"
    expect(x.optimumPackingRatio).toBeCloseTo(0.007164, 5) // "beta_op = 0.007164"
    expect(x.relativePackingRatio).toBeCloseTo(0.22, 3) // "beta/beta_op = 0.220"
    expect(x.C).toBeCloseTo(1.94e-3, 4) // "C = 1.944e-3"
    expect(x.B).toBeCloseTo(1.454, 2) // "B = 1.454"
    expect(x.E).toBeCloseTo(0.372, 3) // "E = 0.372"
    expect(x.windFactor).toBeCloseTo(23.8, 0) // "phi_w ~ 23.8"
    expect(x.liveMoistureOfExtinction).toBeCloseTo(4.7, 1) // "live M_x (Eq. 88) ~ 4.7"
    expect(x.reactionIntensity).toBeCloseTo(1.15e3, -1) // "I_R ~ 1.15e3 BTU ft^-2 min^-1"
  })

  it('the fully cured GR2 case at the same wind reaches ~18 m/min', () => {
    // Spec §4.2 parenthetical: "the fully cured GR2 case at the same wind gives
    // R ~ 18 m min^-1 ~ 54 ch h^-1".
    const cured = rothermelSpread(
      makeCase('GR2', { wind: FIVE_MPH_MPS, live: [0.3, 0.9], cured: 1 }),
    )
    expect(cured.rateOfSpread * 60).toBeGreaterThan(16)
    expect(cured.rateOfSpread * 60).toBeLessThan(20)
  })
})

describe('unit boundary — SI in, English inside', () => {
  it('converts the SI midflame wind to exactly 440 ft/min', () => {
    // 5 mi/h is 440 ft/min by definition; the SI value fed to the kernel is 2.2352 m/s.
    expect(FIVE_MPH_MPS).toBeCloseTo(2.2352, 6)
    expect(toFeetPerMinute(mps(FIVE_MPH_MPS))).toBeCloseTo(440, 9)
  })

  it('holds the fuel table in SI and the kernel internals in English', () => {
    const gr2 = FUEL_MODELS.get('GR2')
    // 1.0 t/ac herbaceous load stored as kg/m^2, 1 ft depth stored as m.
    expect(gr2.load.liveHerb).toBeCloseTo(0.22417, 5)
    expect(gr2.depth).toBeCloseTo(0.3048, 6)
    expect(gr2.sav.dead1h).toBeCloseTo(2000 / 0.3048, 3)
    // 8000 BTU/lb -> kJ/kg.
    expect(gr2.heatContent).toBeCloseTo(18608, 0)
    // ...while the kernel's own numbers are lb/ft^3 and ft^-1.
    const x = rothermelIntermediates(makeCase('GR2', { wind: FIVE_MPH_MPS }))
    expect(x.bulkDensity).toBeCloseTo(0.0505, 4)
    expect(x.sav).toBeCloseTo(1820, -1)
  })

  it('keeps moisture of extinction a fraction, never a percent', () => {
    // The published tables say 15 / 20 / 25 / 35. Everything inside is /100 of that.
    expect(FUEL_MODELS.get('GR2').moistureOfExtinctionDead).toBeCloseTo(0.15, 10)
    expect(FUEL_MODELS.get('TU1').moistureOfExtinctionDead).toBeCloseTo(0.2, 10)
    expect(FUEL_MODELS.get('TL2').moistureOfExtinctionDead).toBeCloseTo(0.25, 10)
    expect(FUEL_MODELS.get('TL8').moistureOfExtinctionDead).toBeCloseTo(0.35, 10)
    for (const f of ALL_FUEL_MODELS) {
      expect(f.moistureOfExtinctionDead).toBeGreaterThan(0)
      expect(f.moistureOfExtinctionDead).toBeLessThan(1)
    }
  })
})

describe('dynamic curing transfer (spec §4.3)', () => {
  it('matches the documented anchors', () => {
    // Scott & Burgan 2005: T = clamp(1.333 - 0.0111*M_herb%, 0, 1).
    expect(curingFraction(moistureFraction(0.3))).toBeCloseTo(1, 6) // 30% => fully cured
    expect(curingFraction(moistureFraction(0.6))).toBeCloseTo(0.667, 3) // 60% => two thirds
    expect(curingFraction(moistureFraction(1.2))).toBeLessThanOrEqual(0.001) // 120% => green
    expect(curingFraction(moistureFraction(2.0))).toBe(0) // clamped, not negative
    expect(curingFraction(moistureFraction(0.1))).toBe(1) // clamped, not > 1
  })

  it('moves load from live herb to dead 1-h, raising ROS as the grass cures', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1].map((cured) =>
      rothermelROS(makeCase('GR2', { wind: FIVE_MPH_MPS, cured })),
    )
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i] ?? 0).toBeGreaterThan(rates[i - 1] ?? 0)
    }
  })

  it('is ignored by static models', () => {
    const a = rothermelIntermediates(makeCase('TL2', { wind: FIVE_MPH_MPS, cured: 0 }))
    const b = rothermelIntermediates(makeCase('TL2', { wind: FIVE_MPH_MPS, cured: 1 }))
    expect(a.curedTransfer).toBe(0)
    expect(b.curedTransfer).toBe(0)
    expect(a.rateOfSpread).toBeCloseTo(b.rateOfSpread, 12)
  })

  it('is what makes grassland fire curing-sensitive at all', () => {
    // GR/GS models are dominated by this: green to cured is a large multiple, not a nudge.
    const green = rothermelROS(makeCase('GR4', { wind: FIVE_MPH_MPS, cured: 0 }))
    const dry = rothermelROS(makeCase('GR4', { wind: FIVE_MPH_MPS, cured: 1 }))
    expect(dry / green).toBeGreaterThan(3)
  })
})

/** Fuel models with enough dead load to carry fire at the D2 dead-moisture scenario. */
const SWEEP_CODES = ALL_FUEL_MODELS.filter(
  (f) =>
    rothermelROS(makeCase(f.code, { wind: 1, cured: 1 })) > 0 &&
    f.moistureOfExtinctionDead > 0.1,
).map((f) => f.code)

describe('monotonicity sweeps', () => {
  it('covers a broad slice of the table', () => {
    expect(SWEEP_CODES.length).toBeGreaterThan(30)
  })

  it('ROS rises with wind', () => {
    for (const code of SWEEP_CODES) {
      const winds = [0, 0.5, 1, 2, 4, 8]
      let previous = -1
      for (const wind of winds) {
        const r = rothermelROS(makeCase(code, { wind, cured: 1 }))
        expect(r, `${code} @ ${wind} m/s`).toBeGreaterThan(previous)
        previous = r
      }
    }
  })

  it('ROS rises with slope', () => {
    for (const code of SWEEP_CODES) {
      const slopes = [0, 0.1, 0.2, 0.4, 0.7]
      let previous = -1
      for (const slope of slopes) {
        const r = rothermelROS(makeCase(code, { wind: 1, slope, cured: 1 }))
        expect(r, `${code} @ slope ${slope}`).toBeGreaterThan(previous)
        previous = r
      }
    }
  })

  it('the slope factor is clamped at tan 0.7 (spec §4.9)', () => {
    const at = (slope: number) => rothermelIntermediates(makeCase('TL2', { slope })).slopeFactor
    expect(at(0.7)).toBeGreaterThan(at(0.6))
    expect(at(1.5)).toBeCloseTo(at(0.7), 12)
  })

  it('ROS falls with dead moisture', () => {
    for (const code of SWEEP_CODES) {
      let previous = Infinity
      for (const dead of [
        DEAD_SCENARIOS.D1,
        DEAD_SCENARIOS.D2,
        DEAD_SCENARIOS.D3,
        DEAD_SCENARIOS.D4,
      ]) {
        const r = rothermelROS(makeCase(code, { wind: 2, dead, cured: 1 }))
        expect(r, `${code} @ ${dead[0]}`).toBeLessThan(previous)
        previous = r
      }
    }
  })

  it('ROS falls with live moisture where there is live fuel', () => {
    const withLive = ALL_FUEL_MODELS.filter((f) => f.load.liveWoody > 0)
    expect(withLive.length).toBeGreaterThan(5)
    for (const f of withLive) {
      let previous = Infinity
      for (const live of [
        LIVE_SCENARIOS.L1,
        LIVE_SCENARIOS.L2,
        LIVE_SCENARIOS.L3,
        LIVE_SCENARIOS.L4,
      ]) {
        const r = rothermelROS(makeCase(f.code, { wind: 2, live, cured: 0 }))
        expect(r, `${f.code} @ live ${live[1]}`).toBeLessThanOrEqual(previous)
        previous = r
      }
    }
  })

  it('goes to exactly zero at and above the dead moisture of extinction', () => {
    for (const code of SWEEP_CODES) {
      const mx = FUEL_MODELS.get(code).moistureOfExtinctionDead
      for (const factor of [1, 1.001, 1.5, 3]) {
        const wet = mx * factor
        const out = rothermelSpread(
          makeCase(code, { wind: 4, slope: 0.3, dead: [wet, wet, wet], cured: 1 }),
        )
        expect(out.rateOfSpread, `${code} @ M_f = ${wet}`).toBe(0)
        expect(out.reactionIntensity).toBe(0)
        expect(out.firelineIntensity).toBe(0)
        expect(out.extinguished).toBe(true)
      }
    }
  })

  it('is still burning just below extinction', () => {
    for (const code of SWEEP_CODES) {
      const mx = FUEL_MODELS.get(code).moistureOfExtinctionDead
      const dry = mx * 0.99
      const out = rothermelSpread(
        makeCase(code, { wind: 4, dead: [dry, dry, dry], cured: 1 }),
      )
      expect(out.rateOfSpread, code).toBeGreaterThan(0)
      expect(out.extinguished).toBe(false)
    }
  })
})

describe('midflame wind adjustment (spec §4.5)', () => {
  it('reproduces the three sanity values', () => {
    // GR2 (H = 1 ft) -> 0.362; SH7 (H = 6 ft) -> 0.547.
    expect(unshelteredWaf(FUEL_MODELS.get('GR2').depth)).toBeCloseTo(0.362, 3)
    expect(unshelteredWaf(FUEL_MODELS.get('SH7').depth)).toBeCloseTo(0.547, 3)
    // 20 m ponderosa stand at CC = 0.6, CR = 0.5 => f = 0.10, WAF ~ 0.133.
    expect(shelteredWaf(m(20), 0.6, 0.5)).toBeCloseTo(0.133, 3)
  })

  it('brackets the operational 0.1-0.6 range', () => {
    for (const f of ALL_FUEL_MODELS) {
      const waf = unshelteredWaf(f.depth)
      expect(waf, f.code).toBeGreaterThan(0.1)
      expect(waf, f.code).toBeLessThan(0.75)
    }
  })

  it('switches to the sheltered form at crown fill f = 0.05', () => {
    const depth = FUEL_MODELS.get('TL2').depth
    // f = (0.3/3)*0.4 = 0.04 -> unsheltered
    expect(midflameWindAdjustment(depth, { height: m(20), cover: 0.3, crownRatio: 0.4 })).toBe(
      unshelteredWaf(depth),
    )
    // f = (0.6/3)*0.5 = 0.10 -> sheltered, and much lower
    const sheltered = midflameWindAdjustment(depth, {
      height: m(20),
      cover: 0.6,
      crownRatio: 0.5,
    })
    expect(sheltered).toBeCloseTo(0.133, 3)
    expect(sheltered).toBeLessThan(unshelteredWaf(depth))
  })

  it('chains U_10m -> U_20ft -> U_mid', () => {
    // 10 m/s open wind over GR2: /1.15 then x 0.362.
    expect(midflameWind(mps(10), unshelteredWaf(FUEL_MODELS.get('GR2').depth))).toBeCloseTo(
      (10 / 1.15) * 0.36211,
      4,
    )
  })
})

describe('wind limit (spec §4.5)', () => {
  const strong = makeCase('GR1', { wind: 4, cured: 1 })

  it('reports 0.9*I_R but does not apply it by default', () => {
    const x = rothermelIntermediates(strong)
    expect(x.windLimit).toBeCloseTo(0.9 * x.reactionIntensity, 9)
    expect(x.windLimitApplied).toBe(false)
    // In light grass the cap binds absurdly early: the limit is a small fraction of the actual
    // effective wind, which is the whole reason the authors recommend against imposing it.
    expect(x.windLimit).toBeLessThan(x.effectiveWind)
  })

  it('the legacy toggle caps the WIND and re-evaluates, it does not clamp the ROS', () => {
    const free = rothermelIntermediates(strong)
    const capped = rothermelIntermediates(strong, { legacyWindLimit: true })
    expect(capped.windLimitApplied).toBe(true)
    expect(capped.effectiveWind).toBeCloseTo(capped.windLimit, 9)
    expect(capped.rateOfSpread).toBeLessThan(free.rateOfSpread)
    // R = R_0 * (1 + phi_E(U_capped)) — not min(R, something).
    const phiE = capped.C * Math.pow(capped.effectiveWind, capped.B) *
      Math.pow(capped.relativePackingRatio, -capped.E)
    expect(capped.rateOfSpread).toBeCloseTo(capped.noWindNoSlopeRate * (1 + phiE), 9)
  })

  it('acts before the elliptical decomposition — LB follows the capped wind', () => {
    const free = rothermelIntermediates(strong)
    const capped = rothermelIntermediates(strong, { legacyWindLimit: true })
    expect(capped.lengthToBreadth).toBeLessThan(free.lengthToBreadth)
    expect(capped.lengthToBreadth).toBeCloseTo(
      1 + 0.25 * ((capped.effectiveWind * 60) / 5280),
      9,
    )
  })

  it('the R <= U_eff sanity rail is inert at realistic midflame winds', () => {
    // GTR-371's own GR1 example has R/U_eff ~ 0.01. Up to 8 m/s midflame (a ~33 km/h open
    // wind before the WAF) the rail never binds anywhere in the Rothermel-fitted fuel sets.
    for (const code of SWEEP_CODES.filter((c) => !c.startsWith('UK-'))) {
      for (const wind of [0.5, 2, 8]) {
        const withRail = rothermelIntermediates(makeCase(code, { wind, cured: 1 }))
        const without = rothermelIntermediates(makeCase(code, { wind, cured: 1 }), {
          spreadRateRail: false,
        })
        expect(withRail.rateOfSpread, `${code} @ ${wind}`).toBeCloseTo(without.rateOfSpread, 9)
      }
    }
  })

  it('the rail does bind in the pathological regime it exists for', () => {
    // Not the "essentially never binds" the spec claims: the heaviest grass models overtake the
    // wind well inside the range a gusty wind field can produce. GR9 at 15 m/s midflame gives
    // an uncapped 3549 ft/min = 18 m/s, faster than the wind carrying it.
    const inputs = makeCase('GR9', { wind: 15, cured: 1 })
    const railed = rothermelIntermediates(inputs)
    const free = rothermelIntermediates(inputs, { spreadRateRail: false })
    expect(free.rateOfSpread).toBeGreaterThan(free.effectiveWind)
    expect(railed.rateOfSpread).toBeCloseTo(railed.effectiveWind, 9)
    expect(railed.rateOfSpread).toBeLessThan(free.rateOfSpread)
  })

  it('the UK set leaves the wind-factor envelope, and the rail is what catches it', () => {
    // The §7.3.2 SAV values are assigned, not measured, and 8000-12000 m^-1 (2438-3658 ft^-1)
    // sits above everything Rothermel was fitted to (S&B tops out at 2300 ft^-1). B = 0.02526
    // sigma^0.54 then reaches ~1.9, so phi_w passes 240 at 8 m/s midflame and the raw model
    // returns a fire running at twice the wind carrying it. Documented, not hidden.
    const inputs = makeCase('UK-CEREAL-STANDING', { wind: 8, cured: 1 })
    const free = rothermelIntermediates(inputs, { spreadRateRail: false })
    expect(free.B).toBeGreaterThan(1.9)
    expect(free.windFactor).toBeGreaterThan(200)
    expect(free.rateOfSpread).toBeGreaterThan(2 * free.effectiveWind)
    expect(rothermelIntermediates(inputs).rateOfSpread).toBeCloseTo(free.effectiveWind, 9)
  })

  it('the rail never raises the spread rate', () => {
    for (const code of SWEEP_CODES) {
      for (const wind of [0.5, 2, 8, 15, 30]) {
        const railed = rothermelROS(makeCase(code, { wind, cured: 1 }))
        const free = rothermelROS(makeCase(code, { wind, cured: 1 }), { spreadRateRail: false })
        expect(railed, `${code} @ ${wind}`).toBeLessThanOrEqual(free)
      }
    }
  })
})

describe('effective wind', () => {
  it('inverts the wind factor back to the input wind on flat ground', () => {
    for (const code of SWEEP_CODES) {
      for (const wind of [0.5, 2, 6]) {
        const x = rothermelIntermediates(makeCase(code, { wind, cured: 1 }))
        expect(x.effectiveWind, `${code} @ ${wind}`).toBeCloseTo(toFeetPerMinute(mps(wind)), 6)
      }
    }
  })

  it('exceeds the raw wind on a slope, which is the point of using it for LB', () => {
    const flat = rothermelIntermediates(makeCase('TL5', { wind: 2, cured: 1 }))
    const steep = rothermelIntermediates(makeCase('TL5', { wind: 2, slope: 0.5, cured: 1 }))
    expect(steep.effectiveWind).toBeGreaterThan(flat.effectiveWind)
    expect(steep.lengthToBreadth).toBeGreaterThan(flat.lengthToBreadth)
  })

  it('caps the length-to-breadth ratio at 8', () => {
    const x = rothermelIntermediates(makeCase('GR7', { wind: 30, slope: 0.7, cured: 1 }))
    expect(x.lengthToBreadth).toBe(8)
  })
})

describe('intensity, flame length, residence time', () => {
  it('t_r = 384/sigma (Anderson 1969)', () => {
    // sigma = 2000 ft^-1 -> 11.5 s; sigma = 1500 -> 15.4 s. Spec §4.7.
    expect(flamingResidenceTime(FUEL_MODELS.get('TL2').sav.dead1h)).toBeCloseTo(11.52, 2)
    expect(flamingResidenceTime(FUEL_MODELS.get('TU5').sav.dead1h)).toBeCloseTo(15.36, 2)
  })

  it('I_B = I_R * t_r * R and L = 0.0775*I_B^0.46', () => {
    const out = rothermelSpread(makeCase('GR2', { wind: FIVE_MPH_MPS }))
    expect(out.firelineIntensity).toBeCloseTo(
      out.reactionIntensity * out.residenceTime * out.rateOfSpread,
      9,
    )
    expect(out.flameLength).toBeCloseTo(0.0775 * Math.pow(out.firelineIntensity, 0.46), 9)
    // A 35 ch/h grass head fire: a few hundred kW/m and a flame around a metre and a half.
    expect(out.firelineIntensity).toBeGreaterThan(300)
    expect(out.firelineIntensity).toBeLessThan(800)
    expect(out.flameLength).toBeGreaterThan(1)
    expect(out.flameLength).toBeLessThan(2)
  })

  it('flame depth is R * t_r', () => {
    const out = rothermelSpread(makeCase('GR2', { wind: FIVE_MPH_MPS }))
    expect(flameDepth(out.rateOfSpread, out.residenceTime)).toBeCloseTo(
      out.rateOfSpread * out.residenceTime,
      12,
    )
  })

  it('flame length is zero for a fuel that cannot carry fire', () => {
    expect(flameLength(0 as never)).toBe(0)
  })
})

describe('degenerate inputs', () => {
  it('a zero-wind zero-slope run is exactly R_0', () => {
    const out = rothermelSpread(makeCase('TL5', { cured: 1 }))
    expect(out.rateOfSpread).toBeCloseTo(out.noWindNoSlopeRate, 12)
    expect(out.windFactor).toBe(0)
    expect(out.slopeFactor).toBe(0)
    expect(out.lengthToBreadth).toBe(1)
  })

  it('treats downslope as flat (phi_s = 0 for downslope, spec §4.2)', () => {
    const flat = rothermelROS(makeCase('TL5', { wind: 1, slope: 0, cured: 1 }))
    const down = rothermelROS(makeCase('TL5', { wind: 1, slope: -0.4, cured: 1 }))
    expect(down).toBeCloseTo(flat, 12)
  })

  it('never returns NaN anywhere in the sweep', () => {
    for (const f of ALL_FUEL_MODELS) {
      for (const wind of [0, 3, 12]) {
        for (const slope of [0, 0.5]) {
          const out = rothermelSpread(makeCase(f.code, { wind, slope, cured: 0.5 }))
          for (const [key, value] of Object.entries(out)) {
            if (typeof value === 'number') {
              expect(Number.isFinite(value), `${f.code} ${key}`).toBe(true)
              expect(value, `${f.code} ${key}`).toBeGreaterThanOrEqual(0)
            }
          }
        }
      }
    }
  })
})
