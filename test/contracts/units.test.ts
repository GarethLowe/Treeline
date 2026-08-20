import { describe, expect, it } from 'vitest'
import {
  FACTORS,
  chainsPerHourToMps,
  fracToPct,
  fromFeetPerMinute,
  fromLbPerFt2,
  kgm2,
  moistureFraction,
  moisturePercent,
  mpsToChainsPerHour,
  pctToFrac,
  toLbPerFt2,
  tonsPerAcreToKgM2,
  tonsPerAcreToLbFt2,
  type MoistureFraction,
} from '@contracts/units'

/**
 * These tests exist because a unit error in this project does not throw and does not look
 * wrong — it produces a fire that spreads plausibly at the wrong rate. The round-trip and
 * known-value checks below are the cheapest possible guard on the conversion boundary.
 */

describe('moisture convention', () => {
  it('converts percent to fraction and back', () => {
    expect(pctToFrac(moisturePercent(6))).toBeCloseTo(0.06, 12)
    expect(fracToPct(moistureFraction(0.6))).toBeCloseTo(60, 12)
  })

  it('round-trips', () => {
    for (const v of [0, 3, 15, 60, 120, 300]) {
      expect(fracToPct(pctToFrac(moisturePercent(v)))).toBeCloseTo(v, 10)
    }
  })

  it('rejects mixing fraction and percent at compile time', () => {
    const frac: MoistureFraction = moistureFraction(0.06)
    // @ts-expect-error a MoisturePercent is not a MoistureFraction — this is the whole point
    const bad: MoistureFraction = moisturePercent(6)
    // @ts-expect-error a raw number is not a MoistureFraction either
    const alsoBad: MoistureFraction = 0.06
    expect(frac).toBe(0.06)
    expect(bad).toBe(6)
    expect(alsoBad).toBe(0.06)
  })
})

describe('Rothermel kernel boundary (SI <-> English)', () => {
  it('round-trips fuel load through lb/ft2', () => {
    const si = kgm2(0.5)
    expect(fromLbPerFt2(toLbPerFt2(si))).toBeCloseTo(0.5, 10)
  })

  it('agrees with the published rounded factors to their stated precision', () => {
    // The spec had the direction inverted: 0.204816 is SI->English, 4.88243 is English->SI.
    // Following the table literally would have made fuel loads wrong by a factor of ~23.8.
    // We derive from exact SI definitions rather than transcribing either rounded value,
    // but the derived factors must still match what the literature prints.
    expect(FACTORS.LBFT2_TO_KGM2).toBeCloseTo(4.88243, 5)
    expect(1 / FACTORS.LBFT2_TO_KGM2).toBeCloseTo(0.204816, 6)
    expect(FACTORS.FTMIN_TO_MPS).toBeCloseTo(0.00508, 12)
    expect(FACTORS.BTULB_TO_KJKG).toBeCloseTo(2.326, 12)
    expect(FACTORS.BTUFT2MIN_TO_KWM2).toBeCloseTo(0.189275, 6)
    expect(FACTORS.TONSACRE_TO_KGM2).toBeCloseTo(0.224170, 6)
  })

  it('is exactly reciprocal, unlike the published rounded pair', () => {
    // 0.204816 * 4.88243 = 0.99999978 — the published pair drifts ~2e-7 per round trip
    // and makes the forward and reverse paths disagree.
    expect(0.204816 * 4.88243).not.toBeCloseTo(1, 9)
    for (const v of [0.05, 0.5, 5, 50]) {
      expect(fromLbPerFt2(toLbPerFt2(kgm2(v)))).toBeCloseTo(v, 12)
    }
  })

  it('converts the GR2 fuel load consistently by both paths', () => {
    // GR2 total load 1.10 t/ac. Going via SI and via lb/ft2 must agree.
    const viaSi = toLbPerFt2(tonsPerAcreToKgM2(1.1))
    const direct = tonsPerAcreToLbFt2(1.1)
    expect(viaSi).toBeCloseTo(direct, 6)
    expect(direct).toBeCloseTo(0.0505, 4)
  })
})

describe('rate of spread units', () => {
  it('reproduces the GR2 D2L2 acceptance value across unit systems', () => {
    // Spec 20-surface-spread.md §4.2: R = 38 ft/min = 11.7 m/min = 35 ch/h.
    const rMps = fromFeetPerMinute(38 as never)
    expect(rMps * 60).toBeCloseTo(11.58, 1)
    expect(mpsToChainsPerHour(rMps)).toBeCloseTo(34.5, 0)
  })

  it('round-trips chains per hour', () => {
    expect(mpsToChainsPerHour(chainsPerHourToMps(35))).toBeCloseTo(35, 10)
  })
})
