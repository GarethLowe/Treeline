/**
 * Solar position and solar load — the acceptance test for work package 1.7.
 *
 * The contract's criterion is "matches an ephemeris for a given date/latitude/longitude within
 * 0.1 degrees". That is tested three ways, because each catches a different class of error:
 *
 *  1. Against an INDEPENDENT implementation (the NOAA formulation, in ./noaa-reference.ts) over
 *     a grid of dates, times and sites. This catches algebra and convention errors — a sign on
 *     longitude, a sidereal-time slip, an azimuth measured from south.
 *  2. Against ASTRONOMICAL ANCHORS that are true by definition rather than by transcription:
 *     declination is zero at the equinox instant and equals the obliquity at the solstice; the
 *     equation of time has known extrema in early November and mid February; noon elevation at
 *     a site is 90 - latitude + declination.
 *  3. Against PUBLISHED sunrise/sunset times for two of the specified sites.
 */

import { describe, expect, it } from 'vitest'
import {
  absorbedShortwaveOnSlope,
  computeSolarState,
  cosIncidenceOnSlope,
  dayEvents,
  dayOfYearFromCalendar,
  irradianceSplit,
  julianDay,
  makeSite,
  refractionDeg,
  solarGeometry,
  sunDirection,
  timeOfDay,
  DEFAULT_ATMOSPHERE,
} from '../../../src/render/sky/solar.ts'
import { angleDeltaDeg, noaaJulianDay, noaaSolarPosition } from './noaa-reference.ts'

const RAD = 180 / Math.PI

/** Sites named in the assignment plus a southern-hemisphere and an equatorial control. */
const SITES = [
  { name: 'London (UK)', lat: 51.5074, lon: -0.1278 },
  { name: 'Los Angeles (California)', lat: 34.0522, lon: -118.2437 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219 },
  { name: 'Reykjavik', lat: 64.1466, lon: -21.9426 },
] as const

const DATES = [
  { y: 2024, m: 1, d: 15 },
  { y: 2024, m: 3, d: 20 },
  { y: 2024, m: 6, d: 21 },
  { y: 2024, m: 9, d: 22 },
  { y: 2024, m: 12, d: 21 },
  { y: 2031, m: 8, d: 3 },
] as const

const HOURS_UTC = [0, 3, 6, 9, 12, 15, 18, 21]

describe('Julian day', () => {
  it('places the J2000 epoch exactly', () => {
    // 2000 January 1.5 UT is JD 2451545.0 by definition.
    expect(julianDay(2000, 1, 1.5)).toBe(2451545.0)
    expect(noaaJulianDay(2000, 1, 1, 12)).toBe(2451545.0)
  })

  it('agrees with the reference implementation across the test dates', () => {
    for (const { y, m, d } of DATES) {
      for (const h of HOURS_UTC) {
        expect(julianDay(y, m, d + h / 24)).toBeCloseTo(noaaJulianDay(y, m, d, h), 9)
      }
    }
  })
})

describe('sun position against an independent ephemeris implementation', () => {
  it('agrees to well inside the 0.1 degree acceptance criterion', () => {
    let worstElevation = 0
    let worstAzimuth = 0
    let samples = 0

    for (const site of SITES) {
      for (const { y, m, d } of DATES) {
        for (const h of HOURS_UTC) {
          const jd = julianDay(y, m, d + h / 24)
          const ours = solarGeometry(jd, site.lat, site.lon)
          const ref = noaaSolarPosition(y, m, d, h, site.lat, site.lon)

          // Compare the GEOMETRIC elevation: refraction models legitimately differ, and the
          // refracted position is not what an ephemeris publishes.
          const dEl = ours.trueElevationRad * RAD - ref.elevationDeg
          expect(Math.abs(dEl)).toBeLessThan(0.1)
          worstElevation = Math.max(worstElevation, Math.abs(dEl))
          samples++

          // Azimuth is ill-conditioned within a few degrees of the horizon and near the zenith;
          // compare where it is meaningful.
          if (ref.elevationDeg > 5 && ref.elevationDeg < 85) {
            const dAz = angleDeltaDeg(ours.azimuthRad * RAD, ref.azimuthDeg)
            expect(Math.abs(dAz)).toBeLessThan(0.1)
            worstAzimuth = Math.max(worstAzimuth, Math.abs(dAz))
          }
        }
      }
    }

    expect(samples).toBe(SITES.length * DATES.length * HOURS_UTC.length)
    // Not merely inside the 0.1 deg criterion: the two independent formulations actually agree
    // to ~0.015 deg in elevation and ~0.022 deg in azimuth across this grid, which is the
    // combined size of their quoted errors. These tighter bounds are the regression guard — if
    // either loosens, the algorithm changed.
    expect(worstElevation).toBeLessThan(0.02)
    expect(worstAzimuth).toBeLessThan(0.03)
  })

  it('agrees on declination and the equation of time', () => {
    for (const { y, m, d } of DATES) {
      for (const h of [0, 12]) {
        const jd = julianDay(y, m, d + h / 24)
        const ours = solarGeometry(jd, 0, 0)
        const ref = noaaSolarPosition(y, m, d, h, 0, 0)
        expect(Math.abs(ours.declinationRad * RAD - ref.declinationDeg)).toBeLessThan(0.02)
        expect(Math.abs(ours.equationOfTimeMinutes - ref.equationOfTimeMin)).toBeLessThan(0.2)
      }
    }
  })
})

describe('astronomical anchors', () => {
  it('puts the declination at zero at the March 2024 equinox instant', () => {
    // 2024 March equinox: 03:06 UTC on the 20th (apparent solar longitude exactly 0).
    const jd = julianDay(2024, 3, 20 + (3 + 6 / 60) / 24)
    const g = solarGeometry(jd, 0, 0)
    expect(Math.abs(g.declinationRad * RAD)).toBeLessThan(0.02)
  })

  it('puts the declination at zero at the September 2024 equinox instant', () => {
    // 2024 September equinox: 12:44 UTC on the 22nd.
    const jd = julianDay(2024, 9, 22 + (12 + 44 / 60) / 24)
    const g = solarGeometry(jd, 0, 0)
    expect(Math.abs(g.declinationRad * RAD)).toBeLessThan(0.02)
  })

  it('reaches the obliquity of the ecliptic at the June 2024 solstice', () => {
    // 2024 June solstice: 20:51 UTC on the 20th. Mean obliquity in 2024 is 23.4362 deg.
    const jd = julianDay(2024, 6, 20 + (20 + 51 / 60) / 24)
    const g = solarGeometry(jd, 0, 0)
    expect(g.declinationRad * RAD).toBeGreaterThan(23.41)
    expect(g.declinationRad * RAD).toBeLessThan(23.46)
  })

  it('reproduces the equation of time extrema and zero crossings', () => {
    const eot = (month: number, day: number): number =>
      solarGeometry(julianDay(2024, month, day + 0.5), 0, 0).equationOfTimeMinutes

    // Minimum ~-14.2 min around 11 February, maximum ~+16.4 min around 3 November.
    expect(eot(2, 11)).toBeLessThan(-14.0)
    expect(eot(2, 11)).toBeGreaterThan(-14.5)
    expect(eot(11, 3)).toBeGreaterThan(16.2)
    expect(eot(11, 3)).toBeLessThan(16.6)

    // Four zero crossings: mid April, mid June, early September, late December.
    expect(Math.abs(eot(4, 15))).toBeLessThan(1.0)
    expect(Math.abs(eot(6, 13))).toBeLessThan(1.0)
    expect(Math.abs(eot(9, 1))).toBeLessThan(1.0)
    expect(Math.abs(eot(12, 25))).toBeLessThan(1.0)
  })

  it('gives the textbook solstice noon elevation at the UK and California sites', () => {
    // Noon elevation = 90 - latitude + declination, and declination at the June solstice is the
    // obliquity. That is an ephemeris fact, not a fit: London 61.93 deg, Los Angeles 79.38 deg.
    const cases = [
      { site: makeSite(51.5074, -0.1278, { utcOffsetHours: 0 }), expected: 90 - 51.5074 + 23.436 },
      { site: makeSite(34.0522, -118.2437, { utcOffsetHours: -8 }), expected: 90 - 34.0522 + 23.436 },
    ]
    for (const { site, expected } of cases) {
      const doy = dayOfYearFromCalendar(2024, 6, 20)
      const events = dayEvents(site, doy)
      const noon = timeOfDay(doy, 0, 0, Math.round(events.solarNoonSeconds))
      const state = computeSolarState(site, noon)
      const trueElevation = state.geometry.trueElevationRad * RAD
      expect(Math.abs(trueElevation - expected)).toBeLessThan(0.1)
      // Transit in the northern hemisphere is due south, exactly.
      expect(Math.abs(angleDeltaDeg(state.geometry.azimuthRad * RAD, 180))).toBeLessThan(0.2)
    }
  })

  it('transits due north in the southern hemisphere', () => {
    const site = makeSite(-33.8688, 151.2093, { utcOffsetHours: 10 })
    const doy = dayOfYearFromCalendar(2024, 6, 20)
    const events = dayEvents(site, doy)
    const state = computeSolarState(site, timeOfDay(doy, 0, 0, Math.round(events.solarNoonSeconds)))
    expect(Math.abs(angleDeltaDeg(state.geometry.azimuthRad * RAD, 0))).toBeLessThan(0.2)
    // Winter solstice there: noon elevation = 90 - |lat| - obliquity.
    expect(state.geometry.trueElevationRad * RAD).toBeCloseTo(90 - 33.8688 - 23.436, 0)
  })

  it('rises due east at the equinox', () => {
    // With the sun on the celestial equator, the geometric rising azimuth is 90 deg at every
    // latitude. Evaluated at the moment the geometric elevation crosses zero.
    for (const site of [SITES[0], SITES[1], SITES[2]]) {
      const jd0 = julianDay(2024, 3, 20 + 3 / 24)
      let best = jd0
      let bestAbs = Infinity
      for (let k = 0; k < 24 * 60; k++) {
        const jd = jd0 + k / (24 * 60)
        const g = solarGeometry(jd, site.lat, site.lon)
        const prev = solarGeometry(jd - 1 / (24 * 60), site.lat, site.lon)
        const rising = g.trueElevationRad > prev.trueElevationRad
        if (rising && Math.abs(g.trueElevationRad) < bestAbs) {
          bestAbs = Math.abs(g.trueElevationRad)
          best = jd
        }
      }
      const g = solarGeometry(best, site.lat, site.lon)
      expect(Math.abs(angleDeltaDeg(g.azimuthRad * RAD, 90))).toBeLessThan(0.6)
    }
  })
})

describe('refraction', () => {
  it('is about 34 arcminutes at the horizon and negligible at the zenith', () => {
    expect(refractionDeg(0)).toBeGreaterThan(0.45)
    expect(refractionDeg(0)).toBeLessThan(0.6)
    expect(refractionDeg(90)).toBeLessThan(0.01)
    expect(refractionDeg(-2)).toBe(0)
  })
})

describe('sunrise, sunset and solar noon', () => {
  it('matches published times for London at the summer solstice', () => {
    // 21 June 2024, London: sunrise 04:43 BST, sunset 21:21 BST = 03:43 / 20:21 UTC.
    const site = makeSite(51.5074, -0.1278, { utcOffsetHours: 0, year: 2024 })
    const events = dayEvents(site, dayOfYearFromCalendar(2024, 6, 21))
    expect(events.sunriseSeconds).not.toBeNull()
    expect(events.sunsetSeconds).not.toBeNull()
    const sunrise = events.sunriseSeconds! / 3600
    const sunset = events.sunsetSeconds! / 3600
    expect(Math.abs(sunrise - (3 + 43 / 60))).toBeLessThan(3 / 60)
    expect(Math.abs(sunset - (20 + 21 / 60))).toBeLessThan(3 / 60)
    // Solar noon within a couple of minutes of 12:02 UTC.
    expect(Math.abs(events.solarNoonSeconds / 3600 - (12 + 2 / 60))).toBeLessThan(3 / 60)
  })

  it('matches published times for London at the winter solstice', () => {
    // 21 December 2024, London: sunrise 08:04, sunset 15:53 GMT.
    const site = makeSite(51.5074, -0.1278, { utcOffsetHours: 0, year: 2024 })
    const events = dayEvents(site, dayOfYearFromCalendar(2024, 12, 21))
    expect(Math.abs(events.sunriseSeconds! / 3600 - (8 + 4 / 60))).toBeLessThan(4 / 60)
    expect(Math.abs(events.sunsetSeconds! / 3600 - (15 + 53 / 60))).toBeLessThan(4 / 60)
  })

  it('matches published times for Los Angeles at the summer solstice', () => {
    // 21 June 2024, Los Angeles: sunrise 05:42 PDT, sunset 20:08 PDT — 04:42 / 19:08 in local
    // STANDARD time, which is what the simulation clock uses.
    const site = makeSite(34.0522, -118.2437, { utcOffsetHours: -8, year: 2024 })
    const events = dayEvents(site, dayOfYearFromCalendar(2024, 6, 21))
    expect(Math.abs(events.sunriseSeconds! / 3600 - (4 + 42 / 60))).toBeLessThan(3 / 60)
    expect(Math.abs(events.sunsetSeconds! / 3600 - (19 + 8 / 60))).toBeLessThan(3 / 60)
  })

  it('reports polar day and polar night above the Arctic Circle', () => {
    const site = makeSite(78.2, 15.6, { utcOffsetHours: 1, year: 2024 }) // Longyearbyen
    const summer = dayEvents(site, dayOfYearFromCalendar(2024, 6, 21))
    const winter = dayEvents(site, dayOfYearFromCalendar(2024, 12, 21))
    expect(summer.polarDay).toBe(true)
    expect(summer.sunriseSeconds).toBeNull()
    expect(winter.polarNight).toBe(true)
    expect(winter.sunsetSeconds).toBeNull()
  })

  it('brackets the day: the sun is below the horizon before sunrise and after sunset', () => {
    const site = makeSite(51.5074, -0.1278, { utcOffsetHours: 0, year: 2024 })
    const doy = dayOfYearFromCalendar(2024, 4, 10)
    const events = dayEvents(site, doy)
    const before = computeSolarState(site, timeOfDay(doy, 0, 0, events.sunriseSeconds! - 600))
    const after = computeSolarState(site, timeOfDay(doy, 0, 0, events.sunsetSeconds! + 600))
    const midday = computeSolarState(site, timeOfDay(doy, 0, 0, events.solarNoonSeconds))
    expect(before.elevation).toBeLessThan(0)
    expect(after.elevation).toBeLessThan(0)
    expect(midday.elevation).toBeGreaterThan(0)
    expect(before.isDaytime).toBe(false)
    expect(midday.isDaytime).toBe(true)
  })
})

describe('irradiance', () => {
  const site = makeSite(34.0522, -118.2437, { utcOffsetHours: -8, year: 2024 })
  const doy = dayOfYearFromCalendar(2024, 6, 21)

  it('is exactly zero below the horizon', () => {
    const night = computeSolarState(site, timeOfDay(doy, 1, 0))
    expect(night.elevation).toBeLessThan(0)
    expect(night.directIrradiance).toBe(0)
    expect(night.diffuseIrradiance).toBe(0)
    expect(night.irradiance.globalHorizontal).toBe(0)
  })

  it('is physically plausible at local noon', () => {
    const events = dayEvents(site, doy)
    const noon = computeSolarState(site, timeOfDay(doy, 0, 0, Math.round(events.solarNoonSeconds)))
    // Clear-sky sea-level noon: DNI 800-950, GHI 950-1100, clearness index 0.7-0.8.
    expect(noon.directIrradiance).toBeGreaterThan(750)
    expect(noon.directIrradiance).toBeLessThan(1000)
    expect(noon.irradiance.globalHorizontal).toBeGreaterThan(900)
    expect(noon.irradiance.globalHorizontal).toBeLessThan(1120)
    expect(noon.irradiance.clearnessIndex).toBeGreaterThan(0.65)
    expect(noon.irradiance.clearnessIndex).toBeLessThan(0.82)
    // Diffuse is a minority of the total on a clear day but never zero.
    expect(noon.diffuseIrradiance).toBeGreaterThan(50)
    expect(noon.diffuseIrradiance).toBeLessThan(0.35 * noon.irradiance.globalHorizontal)
  })

  it('falls off through the afternoon and reddens as it goes', () => {
    const events = dayEvents(site, doy)
    const noonS = Math.round(events.solarNoonSeconds)
    const noon = computeSolarState(site, timeOfDay(doy, 0, 0, noonS))
    const evening = computeSolarState(site, timeOfDay(doy, 0, 0, noonS + 6.5 * 3600))
    expect(evening.elevation).toBeGreaterThan(0)
    expect(evening.elevation).toBeLessThan(noon.elevation)
    expect(evening.directIrradiance).toBeLessThan(noon.directIrradiance)
    // Colour temperature drops as the path length through the atmosphere grows.
    expect(evening.colorTemperature).toBeLessThan(noon.colorTemperature)
    expect(noon.colorTemperature).toBeGreaterThan(4800)
    expect(evening.colorTemperature).toBeLessThan(4200)
  })

  it('responds to cloud cover through the Kasten-Czeplak reduction', () => {
    const clear = computeSolarState(site, timeOfDay(doy, 12), DEFAULT_ATMOSPHERE)
    const overcast = computeSolarState(site, timeOfDay(doy, 12), {
      ...DEFAULT_ATMOSPHERE,
      cloudFraction: 1,
    })
    expect(overcast.irradiance.globalHorizontal).toBeLessThan(
      0.3 * clear.irradiance.globalHorizontal,
    )
    // Under full cloud essentially all of what is left is diffuse.
    expect(overcast.diffuseIrradiance).toBeGreaterThan(0.9 * overcast.irradiance.globalHorizontal)
  })

  it('dims and reddens the beam under a smoke plume, and conserves the scattered fraction', () => {
    const clear = computeSolarState(site, timeOfDay(doy, 12), DEFAULT_ATMOSPHERE)
    const smoky = computeSolarState(site, timeOfDay(doy, 12), {
      ...DEFAULT_ATMOSPHERE,
      plumeOpticalDepth: 1.5,
    })
    expect(smoky.directIrradiance).toBeLessThan(0.3 * clear.directIrradiance)
    expect(smoky.diffuseIrradiance).toBeGreaterThan(clear.diffuseIrradiance)
    expect(smoky.colorTemperature).toBeLessThan(clear.colorTemperature - 500)
    // Beer-Lambert on the beam: tau = 1.5 transmits exp(-1.5) = 0.223.
    const ratio = smoky.directIrradiance / clear.directIrradiance
    expect(ratio).toBeCloseTo(Math.exp(-1.5), 2)
  })

  it('is monotone in optical depth and reduces to the clear case at tau = 0', () => {
    const base = irradianceSplit(0.8, 172, DEFAULT_ATMOSPHERE)
    const zero = irradianceSplit(0.8, 172, { ...DEFAULT_ATMOSPHERE, plumeOpticalDepth: 0 })
    expect(zero.directNormal).toBe(base.directNormal)
    let previous = base.directNormal
    for (const tau of [0.25, 0.5, 1, 2, 4]) {
      const s = irradianceSplit(0.8, 172, { ...DEFAULT_ATMOSPHERE, plumeOpticalDepth: tau })
      expect(s.directNormal).toBeLessThan(previous)
      previous = s.directNormal
    }
  })
})

describe('slope-aspect insolation — the M5 coupling', () => {
  const site = makeSite(40, -105, { utcOffsetHours: -7, year: 2024 })
  const doy = dayOfYearFromCalendar(2024, 3, 21)

  it('gives a south-facing slope more direct load than a north-facing one', () => {
    const noon = computeSolarState(site, timeOfDay(doy, 12))
    const slope = 25 * (Math.PI / 180)
    const south = cosIncidenceOnSlope(noon.elevation, noon.azimuth, slope, Math.PI) // aspect 180
    const north = cosIncidenceOnSlope(noon.elevation, noon.azimuth, slope, 0)
    const flat = cosIncidenceOnSlope(noon.elevation, noon.azimuth, 0, 0)
    expect(south).toBeGreaterThan(flat)
    expect(north).toBeLessThan(flat)
    // This asymmetry is what makes south-facing aspects drier at M5.
    expect(south / Math.max(north, 1e-6)).toBeGreaterThan(1.5)
  })

  it('self-shadows a slope steeper than the sun is high, on the away-facing side', () => {
    const low = computeSolarState(site, timeOfDay(doy, 7))
    expect(low.elevation).toBeGreaterThan(0)
    const away = cosIncidenceOnSlope(low.elevation, low.azimuth, (60 * Math.PI) / 180, low.azimuth + Math.PI)
    expect(away).toBe(0)
  })

  it('absorbs less than it receives, and never more than the fuel absorptivity allows', () => {
    const noon = computeSolarState(site, timeOfDay(doy, 12))
    const absorbed = absorbedShortwaveOnSlope(noon, noon.irradiance, 0, 0, 0.8, 0.2)
    const incident = noon.irradiance.directNormal * Math.sin(noon.elevation) + noon.diffuseIrradiance
    expect(absorbed).toBeGreaterThan(0)
    expect(absorbed).toBeLessThan(incident)
    expect(absorbed).toBeGreaterThan(0.7 * 0.8 * incident)
  })

  it('shades the beam under a canopy but leaves the diffuse and reflected terms', () => {
    const noon = computeSolarState(site, timeOfDay(doy, 12))
    const open = absorbedShortwaveOnSlope(noon, noon.irradiance, 0, 0, 0.8, 0.2, 1)
    const shaded = absorbedShortwaveOnSlope(noon, noon.irradiance, 0, 0, 0.8, 0.2, 0.1)
    expect(shaded).toBeLessThan(0.4 * open)
    expect(shaded).toBeGreaterThan(0)
  })
})

describe('world-space sun direction', () => {
  it('uses the project basis: +X east, +Y up, north is -Z', () => {
    const east = sunDirection(0, Math.PI / 2)
    expect(east[0]).toBeCloseTo(1, 6)
    expect(east[1]).toBeCloseTo(0, 6)
    expect(east[2]).toBeCloseTo(0, 6)

    const north = sunDirection(0, 0)
    expect(north[2]).toBeCloseTo(-1, 6)

    const overhead = sunDirection(Math.PI / 2, 1.234)
    expect(overhead[1]).toBeCloseTo(1, 6)
  })

  it('is a unit vector for any elevation and azimuth', () => {
    for (let el = -1.5; el < 1.5; el += 0.31) {
      for (let az = 0; az < 6.28; az += 0.77) {
        const d = sunDirection(el, az)
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 9)
      }
    }
  })
})
