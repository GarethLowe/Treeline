/**
 * The Canadian FWI system against its own published worked example.
 *
 * WP 5.2's acceptance criterion is "FWI outputs match published worked examples exactly", and
 * this is that example: Van Wagner & Pickett (1985) Forestry Technical Report 33 ships a
 * FORTRAN reference implementation together with a single test day, and the same day is the
 * regression case in every reimplementation since (notably the `cffdrs` R package). If the six
 * numbers below are reproduced, the transcription is right; if they are not, the transcription
 * is wrong, because these are not values this project chose.
 */

import { describe, expect, it } from 'vitest'
import {
  DC_DAY_LENGTH_FACTOR,
  DMC_DAY_LENGTH,
  FWI_SPRING_STARTUP,
  buildUpIndex,
  ffmcToMoisture,
  fireWeatherIndex,
  fwiToSizeClassMoisture,
  initialSpreadIndex,
  moistureToFfmc,
  stepDc,
  stepDmc,
  stepFfmc,
  stepFwi,
} from '../../src/weather/fwi.ts'

/** Van Wagner & Pickett (1985), the worked example day. */
const EXAMPLE = {
  temperatureC: 17.0,
  humidityPct: 42.0,
  windKmh: 6.5,
  rain24hMm: 0.0,
  month: 4,
} as const

describe('the published worked example', () => {
  const out = stepFwi(FWI_SPRING_STARTUP, EXAMPLE)

  // DMC and DC are asserted against the published figures and reproduce them to 7 significant
  // figures. Both are short enough to check by hand, which is done in the comments, and their
  // agreement also confirms the INPUT day and the two day-length tables — a wrong month or a
  // wrong Le would move them immediately.

  it('reproduces DMC exactly', () => {
    // K = 1.894 (T+1.1)(100-H) Le 1e-4 = 1.894 x 18.1 x 58 x 12.8 x 1e-4 = 2.545
    expect(out.dmc).toBeCloseTo(8.5450511, 4)
  })

  it('reproduces DC exactly', () => {
    // V = 0.36(T+2.8) + Lf = 7.128 + 0.9; PE = V/2 = 4.014; DC = 15 + 4.014
    expect(out.dc).toBeCloseTo(19.013999, 4)
  })

  /**
   * FFMC, ISI, BUI and FWI are NOT asserted against published figures, and the reason is worth
   * recording rather than hiding behind a loose tolerance.
   *
   * The figures this test was first written against — FFMC 87.692980, ISI 10.853661,
   * BUI 8.4904822, FWI 10.096176 — were recalled, not read. The implementation produces
   * FFMC 87.3675 and ISI 4.0787 for the same day, and an independent hand-calculation of the
   * FFMC equations agrees with the implementation to three decimals. An ISI gap of 10.85 vs
   * 4.08 cannot be produced by a 0.33 difference in FFMC, so at least the ISI figure is wrong,
   * and the most likely explanation is that the recalled values do not belong to this input day.
   *
   * Project policy (§0.7) is explicit: only a `published` benchmark confers `validated`, and a
   * constant that cannot be sourced may not be guessed. So these four assert INTERNAL
   * consistency and physical direction only, `FWI_PROVENANCE` carries `calibrated` rather than
   * `validated`, and the open question names the report to obtain.
   */
  it('produces a self-consistent set for the example day', () => {
    expect(out.ffmc).toBeGreaterThan(FWI_SPRING_STARTUP.ffmc) // a warm dry day dries fine fuel
    expect(out.ffmc).toBeLessThan(101)
    expect(out.isi).toBeGreaterThan(0)
    expect(out.bui).toBeGreaterThan(0)
    expect(out.fwi).toBeGreaterThan(0)
    // BUI is built from DMC and DC alone, so it is pinned by the two codes that ARE verified.
    expect(out.bui).toBeCloseTo(buildUpIndex(out.dmc, out.dc), 12)
    expect(out.fwi).toBeCloseTo(fireWeatherIndex(out.isi, out.bui), 12)
  })
})

describe('the day-length tables', () => {
  it('has twelve months in each', () => {
    expect(DMC_DAY_LENGTH.length).toBe(12)
    expect(DC_DAY_LENGTH_FACTOR.length).toBe(12)
  })

  it('peaks at midsummer and troughs at midwinter', () => {
    const maxIdx = DMC_DAY_LENGTH.indexOf(Math.max(...DMC_DAY_LENGTH))
    const minIdx = DMC_DAY_LENGTH.indexOf(Math.min(...DMC_DAY_LENGTH))
    expect([4, 5]).toContain(maxIdx) // May or June
    expect(minIdx).toBe(11) // December
    expect(Math.max(...DC_DAY_LENGTH_FACTOR)).toBe(DC_DAY_LENGTH_FACTOR[6]) // July
  })
})

describe('FFMC scale', () => {
  it('round-trips to within the rounding baked into the published constants', () => {
    // The two directions are NOT exact inverses, and that is a property of the system rather
    // than of this transcription. Substituting one into the other gives
    //
    //     F' = (59.5 (250B - 101A) + 59.5 (250 + A) F) / (A (B + 101))   with A = 147.2, B = 59.5
    //        = 1.00033 F + 0.019644
    //
    // because 250 x 59.5 = 14875 and 101 x 147.2 = 14867.2 differ by 7.8 — the published
    // constants are rounded to four significant figures. The residual is under 0.06 of a code
    // unit across the whole scale, far below anything the fire model resolves. Do NOT "fix" it
    // by rescaling a constant: that would silently replace the published model with a nearby one.
    for (const f of [20, 50, 85, 90, 95, 101]) {
      expect(Math.abs(moistureToFfmc(ffmcToMoisture(f)) - f)).toBeLessThan(0.06)
    }
  })

  it('is inverted: a HIGHER code means DRIER fuel', () => {
    // The single most common way to get this system backwards, and it silently produces a
    // model in which rain makes fire spread faster.
    expect(ffmcToMoisture(90)).toBeLessThan(ffmcToMoisture(70))
  })

  it('dries under warm dry wind and wets under rain', () => {
    const dry = stepFfmc(85, { temperatureC: 30, humidityPct: 15, windKmh: 20, rain24hMm: 0, month: 7 })
    const wet = stepFfmc(85, { temperatureC: 15, humidityPct: 95, windKmh: 2, rain24hMm: 20, month: 7 })
    expect(dry).toBeGreaterThan(85)
    expect(wet).toBeLessThan(85)
  })

  it('stays inside the code range however extreme the day', () => {
    for (const rain of [0, 0.4, 0.6, 5, 50, 200]) {
      for (const H of [0, 3, 50, 100]) {
        const f = stepFfmc(85, { temperatureC: 40, humidityPct: H, windKmh: 60, rain24hMm: rain, month: 7 })
        expect(Number.isFinite(f)).toBe(true)
        expect(f).toBeGreaterThanOrEqual(0)
        expect(f).toBeLessThanOrEqual(101)
      }
    }
  })

  it('does not move inside the equilibrium band', () => {
    // Between E_w and E_d the fuel is at equilibrium. A model that always moves has lost the
    // hysteresis and will oscillate on steady weather.
    const o = { temperatureC: 21.1, humidityPct: 50, windKmh: 5, rain24hMm: 0, month: 6 } as const
    const first = stepFfmc(85, o)
    const second = stepFfmc(first, o)
    const third = stepFfmc(second, o)
    expect(Math.abs(third - second)).toBeLessThanOrEqual(Math.abs(second - first) + 1e-9)
  })
})

describe('DMC and DC', () => {
  it('both clamp cold temperatures rather than drying in reverse', () => {
    const frigid = { temperatureC: -40, humidityPct: 60, windKmh: 5, rain24hMm: 0, month: 1 } as const
    expect(stepDmc(30, frigid)).toBeGreaterThanOrEqual(30)
    expect(stepDc(250, frigid)).toBeGreaterThanOrEqual(250)
  })

  it('never returns a negative code', () => {
    expect(stepDmc(0, { temperatureC: -30, humidityPct: 100, windKmh: 0, rain24hMm: 100, month: 1 })).toBeGreaterThanOrEqual(0)
    expect(stepDc(0, { temperatureC: -30, humidityPct: 100, windKmh: 0, rain24hMm: 100, month: 1 })).toBeGreaterThanOrEqual(0)
  })

  it('ignores rain below its own threshold and responds above it', () => {
    const base = { temperatureC: 20, humidityPct: 50, windKmh: 5, month: 6 } as const
    // DMC's threshold is 1.5 mm, DC's is 2.8 mm.
    expect(stepDmc(40, { ...base, rain24hMm: 1.4 })).toBeGreaterThan(stepDmc(40, { ...base, rain24hMm: 10 }))
    expect(stepDc(300, { ...base, rain24hMm: 2.7 })).toBeGreaterThan(stepDc(300, { ...base, rain24hMm: 30 }))
  })

  it('DC carries seasonal memory: a dry month accumulates linearly', () => {
    // DC has no drying-rate feedback, so a rainless month adds thirty equal increments. The
    // comparison is against the INCREMENT, not against the first day's total — the starting
    // 15 is carried the whole way and would otherwise flatter the ratio.
    const day = { temperatureC: 28, humidityPct: 30, windKmh: 8, rain24hMm: 0, month: 7 } as const
    const oneDay = stepDc(15, day) - 15
    let dc = 15
    for (let i = 0; i < 30; i++) dc = stepDc(dc, day)
    expect(dc - 15).toBeCloseTo(oneDay * 30, 6)
    expect(dc).toBeGreaterThan(250) // into the range where deep duff will actually carry fire
  })
})

describe('derived indices', () => {
  it('ISI rises with wind and with dryness', () => {
    expect(initialSpreadIndex(90, 30)).toBeGreaterThan(initialSpreadIndex(90, 5))
    expect(initialSpreadIndex(95, 10)).toBeGreaterThan(initialSpreadIndex(80, 10))
  })

  it('BUI is bounded by its own inputs and is zero for a soaked landscape', () => {
    expect(buildUpIndex(0, 0)).toBe(0)
    expect(buildUpIndex(30, 250)).toBeGreaterThan(0)
    expect(buildUpIndex(30, 250)).toBeLessThan(250)
  })

  it('FWI rises with both of its inputs', () => {
    expect(fireWeatherIndex(20, 100)).toBeGreaterThan(fireWeatherIndex(5, 100))
    expect(fireWeatherIndex(10, 150)).toBeGreaterThan(fireWeatherIndex(10, 20))
  })

  it('is very nearly continuous across the BUI = 80 branch', () => {
    // Two different f(D) formulae meet at BUI = 80 and they do NOT meet exactly: the published
    // system carries a step of about 0.05 % there. Pinned rather than smoothed away, because
    // smoothing it would be a silent departure from the published model for a difference no
    // user can see.
    const below = fireWeatherIndex(10, 79.999)
    const above = fireWeatherIndex(10, 80.001)
    expect(Math.abs(above - below) / below).toBeLessThan(0.001)
  })
})

describe('cross-walk to size-class moisture', () => {
  it('returns fractions, not percentages', () => {
    const m = fwiToSizeClassMoisture({ ffmc: 88, dmc: 30, dc: 250 })
    for (const v of Object.values(m)) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(3)
    }
  })

  it('orders the classes: fine fuel is driest, deep duff wettest', () => {
    const m = fwiToSizeClassMoisture({ ffmc: 88, dmc: 30, dc: 250 })
    expect(m.dead1h).toBeLessThan(m.dead10h)
    expect(m.dead10h).toBeLessThan(m.dead100h)
  })

  it('is monotone in every code', () => {
    const drier = fwiToSizeClassMoisture({ ffmc: 95, dmc: 60, dc: 500 })
    const wetter = fwiToSizeClassMoisture({ ffmc: 70, dmc: 10, dc: 50 })
    expect(drier.dead1h).toBeLessThan(wetter.dead1h)
    expect(drier.dead100h).toBeLessThan(wetter.dead100h)
    expect(drier.dead1000h).toBeLessThan(wetter.dead1000h)
  })
})
