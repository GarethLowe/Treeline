/**
 * Lunar position, phase and moonlight.
 *
 * The moon does not have to meet the sun's 0.1 degree criterion — nothing physical depends on
 * it — but it does have to be a real ephemeris rather than a rotating billboard, because the
 * moonlight level it produces is what separates a 0.25 lx full-moon night from a 0.0002 lx
 * moonless one, and at M4 that is the difference between a fire that reads as the only light
 * source and one that does not.
 *
 * The strongest available check without a table of published positions is the phase geometry:
 * new and full moon instants are published to the minute, and hitting them requires the lunar
 * longitude, the solar longitude and the perturbation terms all to be right together.
 */

import { describe, expect, it } from 'vitest'
import { moonState, MOON_MEAN_DISTANCE_ER, SYNODIC_MONTH_DAYS } from '../../../src/render/sky/moon.ts'
import { julianDay } from '../../../src/render/sky/solar.ts'

const RAD = 180 / Math.PI
const LONDON = { lat: 51.5074, lon: -0.1278 }

describe('geometry', () => {
  it('returns a unit direction consistent with the reported elevation and azimuth', () => {
    for (let h = 0; h < 24; h += 1.5) {
      const m = moonState(julianDay(2024, 5, 10 + h / 24), LONDON.lat, LONDON.lon)
      expect(Math.hypot(m.direction[0], m.direction[1], m.direction[2])).toBeCloseTo(1, 9)
      expect(m.direction[1]).toBeCloseTo(Math.sin(m.elevation), 9)
      expect(m.azimuth).toBeGreaterThanOrEqual(0)
      expect(m.azimuth).toBeLessThan(2 * Math.PI + 1e-9)
      expect(Math.abs(m.elevation)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9)
    }
  })

  it('stays within the real range of lunar distance and apparent size', () => {
    for (let d = 0; d < 40; d += 0.37) {
      const m = moonState(julianDay(2024, 7, 1 + d), LONDON.lat, LONDON.lon)
      // Perigee 55.9, apogee 63.8 Earth radii.
      expect(m.distanceEarthRadii).toBeGreaterThan(55)
      expect(m.distanceEarthRadii).toBeLessThan(64.5)
      // 0.24 to 0.28 degrees apparent radius.
      expect(m.angularRadius * RAD).toBeGreaterThan(0.235)
      expect(m.angularRadius * RAD).toBeLessThan(0.29)
    }
    // Mean distance is bracketed by the sweep.
    expect(MOON_MEAN_DISTANCE_ER).toBeGreaterThan(55)
    expect(MOON_MEAN_DISTANCE_ER).toBeLessThan(64.5)
  })

  it('rises and sets, and sweeps the full declination range over a month', () => {
    let min = Infinity
    let max = -Infinity
    for (let d = 0; d < 30; d += 0.02) {
      const m = moonState(julianDay(2024, 3, 5 + d), LONDON.lat, LONDON.lon)
      min = Math.min(min, m.elevation)
      max = Math.max(max, m.elevation)
    }
    // At 51.5 N a moon of declination +-(23.4 +- 5.1) transits between about 15 and 62 degrees,
    // so a month of sampling must find a high transit and a deep set.
    expect(max * RAD).toBeGreaterThan(45)
    expect(min * RAD).toBeLessThan(-40)
  })
})

describe('phase', () => {
  it('is new at the published 2024 January new moon', () => {
    // New moon 2024-01-11 11:57 UT.
    const m = moonState(julianDay(2024, 1, 11 + (11 + 57 / 60) / 24), LONDON.lat, LONDON.lon)
    // Elongation is bounded below by the lunar ecliptic latitude, which reaches 5.1 degrees.
    expect(m.elongation * RAD).toBeLessThan(6)
    expect(m.illuminatedFraction).toBeLessThan(0.01)
  })

  it('is full at the published 2024 January full moon', () => {
    // Full moon 2024-01-25 17:54 UT.
    const m = moonState(julianDay(2024, 1, 25 + (17 + 54 / 60) / 24), LONDON.lat, LONDON.lon)
    expect(m.elongation * RAD).toBeGreaterThan(174)
    expect(m.illuminatedFraction).toBeGreaterThan(0.99)
  })

  it('is half lit at the published 2024 January first quarter', () => {
    // First quarter 2024-01-18 03:52 UT.
    const m = moonState(julianDay(2024, 1, 18 + (3 + 52 / 60) / 24), LONDON.lat, LONDON.lon)
    expect(m.illuminatedFraction).toBeGreaterThan(0.46)
    expect(m.illuminatedFraction).toBeLessThan(0.54)
  })

  it('cycles with the synodic month', () => {
    const sample = (dayOffset: number): number =>
      moonState(julianDay(2024, 1, 1 + dayOffset), 0, 0).illuminatedFraction

    // Locate successive NEW moons as minima of the sun-moon elongation. Elongation is sharply
    // V-shaped there (it changes by ~12 deg/day), which makes the minimum easy to bracket;
    // illuminated fraction is flat near full and would be found imprecisely.
    const elongation = (dayOffset: number): number =>
      moonState(julianDay(2024, 1, 1 + dayOffset), 0, 0).elongation

    const newMoons: number[] = []
    for (let d = 0.05; d < 90; d += 0.05) {
      const before = elongation(d - 0.05)
      const here = elongation(d)
      const after = elongation(d + 0.05)
      if (here < before && here <= after) newMoons.push(d)
    }
    expect(newMoons.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < newMoons.length; i++) {
      const period = newMoons[i]! - newMoons[i - 1]!
      // Individual synodic months vary by up to about +-0.7 day around the mean 29.53.
      expect(Math.abs(period - SYNODIC_MONTH_DAYS)).toBeLessThan(1.0)
    }
    // And the first one must land on the published 2024-01-11 11:57 UT new moon.
    expect(Math.abs(newMoons[0]! - (10 + (11 + 57 / 60) / 24))).toBeLessThan(0.1)

    // The cycle really does reach both ends.
    let min = Infinity
    let max = -Infinity
    for (let d = 0; d < 60; d += 0.1) {
      const v = sample(d)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(min).toBeLessThan(0.01)
    expect(max).toBeGreaterThan(0.99)
  })
})

describe('moonlight', () => {
  it('delivers nothing when the moon is below the horizon', () => {
    for (let h = 0; h < 48; h += 0.5) {
      const m = moonState(julianDay(2024, 9, 1 + h / 24), LONDON.lat, LONDON.lon)
      if (m.elevation <= 0) expect(m.illuminanceLux).toBe(0)
    }
  })

  it('peaks near the published full-moon illuminance and never exceeds it', () => {
    let peak = 0
    for (let d = 0; d < 60; d += 0.02) {
      const m = moonState(julianDay(2024, 1, 1 + d), LONDON.lat, LONDON.lon)
      peak = Math.max(peak, m.illuminanceLux)
    }
    // 0.25 lx is the standard full-moon-at-zenith figure; London never sees the moon overhead,
    // and atmospheric extinction takes a further bite, so the peak sits below it but in range.
    expect(peak).toBeGreaterThan(0.05)
    expect(peak).toBeLessThanOrEqual(0.25)
  })

  it('follows the opposition surge: a half moon is far less than half as bright', () => {
    // Sample the illuminance against phase at a fixed high altitude by searching each day for
    // the moon's transit, then compare a near-full sample with a near-quarter one.
    const brightest = (fractionLow: number, fractionHigh: number): number => {
      let best = 0
      for (let d = 0; d < 60; d += 0.01) {
        const m = moonState(julianDay(2024, 1, 1 + d), LONDON.lat, LONDON.lon)
        if (m.illuminatedFraction >= fractionLow && m.illuminatedFraction <= fractionHigh) {
          best = Math.max(best, m.illuminanceLux)
        }
      }
      return best
    }
    const full = brightest(0.98, 1.0)
    const half = brightest(0.48, 0.52)
    expect(full).toBeGreaterThan(0)
    expect(half).toBeGreaterThan(0)
    // The magnitude-phase law puts a quarter moon around 8-12% of full; a Lambertian model
    // would say 50%, and a night lit that way never looks like a real moonlit night.
    expect(half / full).toBeLessThan(0.25)
    expect(half / full).toBeGreaterThan(0.02)
  })

  it('is dimmer near the horizon than high in the sky at the same phase', () => {
    // Extinction is ~0.28 mag per airmass, so a moon at 5 degrees loses most of its light.
    let low = 0
    let high = 0
    for (let d = 0; d < 40; d += 0.01) {
      const m = moonState(julianDay(2024, 1, 1 + d), LONDON.lat, LONDON.lon)
      if (m.illuminatedFraction < 0.97) continue
      const elDeg = m.elevation * RAD
      if (elDeg > 2 && elDeg < 6) low = Math.max(low, m.illuminanceLux)
      if (elDeg > 45) high = Math.max(high, m.illuminanceLux)
    }
    expect(high).toBeGreaterThan(0)
    if (low > 0) expect(low).toBeLessThan(0.25 * high)
  })
})
