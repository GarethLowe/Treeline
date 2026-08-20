/**
 * Solar position and solar load. **Pure — no GPU, no DOM.**
 *
 * This is the single source of truth for where the sun is and how much energy it delivers.
 * The sky render reads it now; at M5 the fuel-drying calculation reads the *same* values,
 * because solar load on a slope is what makes south-facing aspects drier and that is a real
 * driver of fire behaviour. There is deliberately no separate "graphics sun".
 *
 * Algorithm: Michalsky (1988), "The Astronomical Almanac's algorithm for approximate solar
 * position (1950-2050)", Solar Energy 40(3):227-235, with the 1989 erratum. Quoted accuracy
 * 0.01° in declination and right ascension over 1950-2050 — an order of magnitude inside the
 * 0.1° acceptance criterion — for about thirty floating-point operations, and it ports to
 * WGSL unchanged should the fuel-heating kernel ever want it on the GPU. The full NREL SPA
 * (Reda & Andreas 2004) buys 0.0003° for roughly 20x the cost and is not warranted here.
 *
 * Spec: docs/spec/50-meteorology.md §6.5.
 *
 * CONVENTIONS (normative, spec §0.6):
 *  - angles in radians internally; the `*Deg` inputs are the UI/config boundary
 *  - longitude is **east positive**
 *  - azimuth is measured **clockwise from north** (contract `SolarState.azimuth`)
 *  - irradiance in W/m^2, time in seconds
 *  - `SolarState.elevation` is the **apparent** (refraction-corrected) elevation, because
 *    that is where the sun is seen and where its light actually comes from. The unrefracted
 *    geometric elevation is available on `SolarGeometry.trueElevationRad`.
 */

import type { Kelvin, Radians, Seconds } from '@contracts/units.ts'
import { K, rad } from '@contracts/units.ts'
import type { SolarState, TimeOfDay } from '@contracts/render.ts'
import { directBeamColour } from './spectrum.ts'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

/** Solar constant, W/m^2 (WMO / ASTM E490 mean total solar irradiance at 1 AU). */
export const SOLAR_CONSTANT = 1367

/**
 * Standard altitude of the solar centre at rise/set: -50 arcminutes. Refraction at the
 * horizon accounts for 34', the solar semidiameter for 16'. Meeus, *Astronomical
 * Algorithms* 2nd ed., Ch. 15, p. 102.
 */
export const SUNRISE_ALTITUDE_DEG = -0.833

// ---------------------------------------------------------------------------
// Calendar / Julian date
// ---------------------------------------------------------------------------

/**
 * Julian Day for a Gregorian calendar date with fractional day. Meeus Ch. 7, Eq. 7.1.
 * Valid for the Gregorian calendar (1582-10-15 onwards), which covers everything the
 * simulation can be configured with.
 */
export function julianDay(year: number, month: number, dayWithFraction: number): number {
  let y = year
  let m = month
  if (m <= 2) {
    y -= 1
    m += 12
  }
  const a = Math.floor(y / 100)
  const b = 2 - a + Math.floor(a / 4)
  return (
    Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + dayWithFraction + b - 1524.5
  )
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Calendar month (1-12) and day (1-31) for a day-of-year (1-366). */
export function calendarFromDayOfYear(year: number, dayOfYear: number): {
  month: number
  day: number
} {
  const leap = isLeapYear(year)
  let remaining = Math.max(1, Math.min(daysInYear(year), Math.floor(dayOfYear)))
  for (let i = 0; i < 12; i++) {
    const len = (MONTH_LENGTHS[i] ?? 30) + (leap && i === 1 ? 1 : 0)
    if (remaining <= len) return { month: i + 1, day: remaining }
    remaining -= len
  }
  return { month: 12, day: 31 }
}

/** Day-of-year (1-366) for a calendar date. */
export function dayOfYearFromCalendar(year: number, month: number, day: number): number {
  const leap = isLeapYear(year)
  let n = day
  for (let i = 0; i < month - 1; i++) n += (MONTH_LENGTHS[i] ?? 30) + (leap && i === 1 ? 1 : 0)
  return n
}

/** Julian Day at 00:00 UT of the given day-of-year. */
export function julianDayFromDayOfYear(year: number, dayOfYear: number): number {
  const { month, day } = calendarFromDayOfYear(year, dayOfYear)
  return julianDay(year, month, day)
}

// ---------------------------------------------------------------------------
// Angle helpers
// ---------------------------------------------------------------------------

/** Fold to [0, 360). */
function wrap360(deg: number): number {
  const v = deg % 360
  return v < 0 ? v + 360 : v
}

/** Fold to [-180, 180). */
function wrap180(deg: number): number {
  return wrap360(deg + 180) - 180
}

/** Fold to [0, 24). */
function wrap24(h: number): number {
  const v = h % 24
  return v < 0 ? v + 24 : v
}

// ---------------------------------------------------------------------------
// Refraction
// ---------------------------------------------------------------------------

/**
 * Atmospheric refraction, degrees to ADD to a true (geometric) altitude to obtain the
 * apparent altitude. Sæmundsson's formula as given by Meeus, Eq. 16.4, scaled for ambient
 * pressure and temperature (Meeus p. 106).
 *
 * The formula is only meaningful near and above the horizon; below -1° true altitude it is
 * faded to zero, since the sun is then geometrically set and refraction has no observable
 * consequence for either the render or the energy balance.
 */
export function refractionDeg(trueAltitudeDeg: number, pressureHpa = 1013.25, tempC = 15): number {
  if (trueAltitudeDeg < -1) return 0
  const h = trueAltitudeDeg
  const rMinutes = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG)
  const scale = (pressureHpa / 1010) * (283 / (273 + tempC))
  const fade = h < 0 ? 1 + h : 1 // linear taper across [-1°, 0°]
  return (rMinutes / 60) * scale * fade
}

// ---------------------------------------------------------------------------
// Sun position
// ---------------------------------------------------------------------------

/** Everything the Michalsky solve produces. The contract's `SolarState` is a subset. */
export interface SolarGeometry {
  readonly julianDay: number
  /** Days since J2000.0. */
  readonly n: number
  readonly declinationRad: number
  readonly rightAscensionRad: number
  /** Apparent ecliptic longitude, rad. */
  readonly eclipticLongitudeRad: number
  /** Local hour angle, rad, folded to [-pi, pi). Negative before local solar noon. */
  readonly hourAngleRad: number
  /** Geometric elevation, no refraction. */
  readonly trueElevationRad: number
  /** Refraction-corrected elevation — where the sun is seen. */
  readonly apparentElevationRad: number
  /** Clockwise from north. */
  readonly azimuthRad: number
  /** Equation of time, minutes (apparent solar time minus mean solar time). */
  readonly equationOfTimeMinutes: number
  /** Sun-Earth distance in AU, for the inverse-square irradiance correction. */
  readonly distanceAu: number
}

/**
 * Sun position for an instant given as a Julian Day (UT) and a site.
 *
 * @param jdUt Julian Day including the UT fraction of the day.
 * @param latitudeDeg positive north.
 * @param longitudeDeg positive **east**.
 */
export function solarGeometry(
  jdUt: number,
  latitudeDeg: number,
  longitudeDeg: number,
): SolarGeometry {
  const n = jdUt - 2451545.0

  // Mean longitude and mean anomaly of the sun, degrees.
  const meanLongitude = wrap360(280.46 + 0.9856474 * n)
  const meanAnomaly = wrap360(357.528 + 0.9856003 * n) * DEG

  // Apparent ecliptic longitude (equation of centre truncated to two terms).
  const eclipticLongitude =
    wrap360(meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG

  // Obliquity of the ecliptic.
  const obliquity = (23.439 - 0.0000004 * n) * DEG

  const sinLambda = Math.sin(eclipticLongitude)
  const cosLambda = Math.cos(eclipticLongitude)
  const rightAscension = Math.atan2(Math.cos(obliquity) * sinLambda, cosLambda)
  const declination = Math.asin(Math.sin(obliquity) * sinLambda)

  // Greenwich mean sidereal time. `n` already carries the UT fraction, so the +utHours term
  // completes the 1.0027379 sidereal/solar ratio (Michalsky 1988 Eq. 7).
  const utHours = ((jdUt - Math.floor(jdUt - 0.5) - 0.5) * 24) % 24
  const gmst = wrap24(6.697375 + 0.0657098242 * n + utHours)
  const lmstHours = wrap24(gmst + longitudeDeg / 15)
  const hourAngleDeg = wrap180(lmstHours * 15 - rightAscension * RAD)
  const hourAngle = hourAngleDeg * DEG

  const phi = latitudeDeg * DEG
  const sinEl =
    Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle)
  const trueElevation = Math.asin(Math.max(-1, Math.min(1, sinEl)))

  // Azimuth clockwise from north. Verified by construction: at H = 0 in the northern
  // mid-latitudes the numerator vanishes and the denominator is negative, giving 180° (due
  // south); before local noon (H < 0) the numerator is positive, giving an easterly bearing.
  const azimuth = Math.atan2(
    -Math.sin(hourAngle) * Math.cos(declination),
    Math.cos(phi) * Math.sin(declination) - Math.sin(phi) * Math.cos(declination) * Math.cos(hourAngle),
  )

  const apparentElevation = trueElevation + refractionDeg(trueElevation * RAD) * DEG

  // Equation of time = apparent solar time - mean solar time, in minutes. The -0.0057183°
  // term is the annual aberration of the sun's apparent position (NOAA solar calculator).
  const eot = 4 * wrap180(meanLongitude - 0.0057183 - rightAscension * RAD)

  // Sun-Earth distance, AU. Meeus Eq. 25.5 truncated consistently with the position above.
  const distanceAu = 1.00014 - 0.01671 * Math.cos(meanAnomaly) - 0.00014 * Math.cos(2 * meanAnomaly)

  return {
    julianDay: jdUt,
    n,
    declinationRad: declination,
    rightAscensionRad: rightAscension < 0 ? rightAscension + 2 * Math.PI : rightAscension,
    eclipticLongitudeRad: eclipticLongitude,
    hourAngleRad: hourAngle,
    trueElevationRad: trueElevation,
    apparentElevationRad: apparentElevation,
    azimuthRad: azimuth < 0 ? azimuth + 2 * Math.PI : azimuth,
    equationOfTimeMinutes: eot,
    distanceAu,
  }
}

// ---------------------------------------------------------------------------
// Site and clock
// ---------------------------------------------------------------------------

/**
 * Where and when. The frozen `TimeOfDay` contract carries only `secondsOfDay` and
 * `dayOfYear`; a Julian Day additionally needs the **year**, and converting local clock time
 * to UT needs the **UTC offset**. Both live here rather than in the contract, and both are
 * explicit rather than taken from the host clock so that a run is reproducible.
 */
export interface SiteConfig {
  readonly latitudeDeg: number
  /** East positive. */
  readonly longitudeDeg: number
  /**
   * Local standard time offset from UTC, hours. Defaults to the nearest standard meridian,
   * `round(longitude / 15)`, which is correct for most sites and never more than an hour out.
   * Daylight saving is NOT applied: the simulation clock is local *standard* time throughout,
   * which is also what fire-weather observations are recorded in.
   */
  readonly utcOffsetHours: number
  /** Calendar year. `TimeOfDay` has no year field; this supplies it. */
  readonly year: number
  /** Site elevation above sea level, m. Used for the pressure correction on refraction. */
  readonly elevationM: number
}

export const DEFAULT_YEAR = 2024

export function makeSite(
  latitudeDeg: number,
  longitudeDeg: number,
  overrides: Partial<SiteConfig> = {},
): SiteConfig {
  return {
    latitudeDeg,
    longitudeDeg,
    utcOffsetHours: overrides.utcOffsetHours ?? Math.round(longitudeDeg / 15),
    year: overrides.year ?? DEFAULT_YEAR,
    elevationM: overrides.elevationM ?? 0,
  }
}

/** Julian Day (UT) for a local-standard-time instant at a site. */
export function julianDayForLocalTime(site: SiteConfig, time: TimeOfDay): number {
  const localHours = time.secondsOfDay / 3600
  const utHours = localHours - site.utcOffsetHours
  return julianDayFromDayOfYear(site.year, time.dayOfYear) + utHours / 24
}

// ---------------------------------------------------------------------------
// Sunrise, sunset, solar noon
// ---------------------------------------------------------------------------

export interface DayEvents {
  /** Local standard time, seconds since midnight. Null on a polar day/night. */
  readonly sunriseSeconds: number | null
  readonly sunsetSeconds: number | null
  /** Solar transit (local apparent noon), local standard time seconds. Always defined. */
  readonly solarNoonSeconds: number
  /** True when the sun never sets on this date at this site. */
  readonly polarDay: boolean
  /** True when the sun never rises. */
  readonly polarNight: boolean
}

/**
 * Sunrise, solar noon and sunset for a date at a site, iterated to convergence.
 *
 * The event is defined at a solar centre altitude of -0.833° (refraction plus semidiameter),
 * which is the convention every published almanac and newspaper table uses; comparing against
 * a table computed for the *geometric* horizon would be off by four minutes at UK latitudes.
 */
export function dayEvents(site: SiteConfig, dayOfYear: number): DayEvents {
  const jd0 = julianDayFromDayOfYear(site.year, dayOfYear)
  const phi = site.latitudeDeg * DEG
  const h0 = SUNRISE_ALTITUDE_DEG * DEG

  // Transit: local apparent time 12:00 => UT = 12 - lon/15 - EoT/60.
  let noonUt = 12 - site.longitudeDeg / 15
  for (let i = 0; i < 3; i++) {
    const g = solarGeometry(jd0 + noonUt / 24, site.latitudeDeg, site.longitudeDeg)
    noonUt = 12 - site.longitudeDeg / 15 - g.equationOfTimeMinutes / 60
  }

  const gNoon = solarGeometry(jd0 + noonUt / 24, site.latitudeDeg, site.longitudeDeg)
  const dec = gNoon.declinationRad
  const cosH =
    (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))

  const toLocalSeconds = (utHours: number): number => (utHours + site.utcOffsetHours) * 3600
  const solarNoonSeconds = toLocalSeconds(noonUt)

  if (cosH < -1) {
    return {
      sunriseSeconds: null,
      sunsetSeconds: null,
      solarNoonSeconds,
      polarDay: true,
      polarNight: false,
    }
  }
  if (cosH > 1) {
    return {
      sunriseSeconds: null,
      sunsetSeconds: null,
      solarNoonSeconds,
      polarDay: false,
      polarNight: true,
    }
  }

  const halfDayHours = (Math.acos(cosH) * RAD) / 15

  // Refine each event by re-evaluating declination and the equation of time at the event
  // instant rather than at noon. Two iterations is ample; the residual is well under a second.
  const refine = (initialUt: number, sign: 1 | -1): number => {
    let t = initialUt
    for (let i = 0; i < 3; i++) {
      const g = solarGeometry(jd0 + t / 24, site.latitudeDeg, site.longitudeDeg)
      const c =
        (Math.sin(h0) - Math.sin(phi) * Math.sin(g.declinationRad)) /
        (Math.cos(phi) * Math.cos(g.declinationRad))
      if (c < -1 || c > 1) return t
      const hHours = (Math.acos(c) * RAD) / 15
      const transit = 12 - site.longitudeDeg / 15 - g.equationOfTimeMinutes / 60
      t = transit + sign * hHours
    }
    return t
  }

  return {
    sunriseSeconds: toLocalSeconds(refine(noonUt - halfDayHours, -1)),
    sunsetSeconds: toLocalSeconds(refine(noonUt + halfDayHours, 1)),
    solarNoonSeconds,
    polarDay: false,
    polarNight: false,
  }
}

// ---------------------------------------------------------------------------
// Irradiance
// ---------------------------------------------------------------------------

/**
 * Atmospheric conditions that modulate solar load. Held separately from the site so that a
 * weather change does not invalidate the site geometry.
 */
export interface AtmosphereConfig {
  /** Cloud fraction [0,1]. */
  readonly cloudFraction: number
  /** Ångström/Linke turbidity: 2 exceptionally clear, 3 clear, 6 hazy. */
  readonly turbidity: number
  /** Ground albedo, 0.15-0.25 typical; feeds reflected shortwave onto sloping fuel at M5. */
  readonly groundAlbedo: number
  /** Broadband smoke optical depth over the site. Driven by the M4 plume; 0 otherwise. */
  readonly plumeOpticalDepth: number
}

export const DEFAULT_ATMOSPHERE: AtmosphereConfig = {
  cloudFraction: 0,
  turbidity: 2.5,
  groundAlbedo: 0.2,
  plumeOpticalDepth: 0,
}

export interface IrradianceSplit {
  /** Direct normal irradiance, W/m^2 (on a surface facing the sun). */
  readonly directNormal: number
  /** Diffuse horizontal irradiance, W/m^2. */
  readonly diffuseHorizontal: number
  /** Global horizontal irradiance, W/m^2. */
  readonly globalHorizontal: number
  /** Extraterrestrial normal irradiance, W/m^2. */
  readonly extraterrestrialNormal: number
  /** Clearness index k_t. */
  readonly clearnessIndex: number
}

/**
 * Direct/diffuse split of the solar load.
 *
 * Chain, per spec §6.5 with one documented correction:
 *  1. Extraterrestrial normal `G_on = 1367 (1 + 0.033 cos(360 d/365))`.
 *  2. Clear-sky global horizontal from **Haurwitz (1946)**, J. Meteor. 3:123:
 *     `G_clear = 1098 cos Z exp(-0.059 / cos Z)`.
 *  3. Cloud reduction, **Kasten & Czeplak (1980)**, Solar Energy 24:177:
 *     `G = G_clear (1 - 0.75 c^3.4)`.
 *  4. Clearness index `k_t = G / G_0` where `G_0 = G_on cos Z`.
 *  5. Diffuse fraction from **Erbs et al. (1982)**, Solar Energy 28:293.
 *
 * SPEC DEVIATION (deliberate, documented): §6.5 writes the Kasten & Czeplak reduction as
 * acting on the *extraterrestrial* horizontal irradiance, i.e. `G = G_0 (1 - 0.75 c^3.4)`.
 * That implies a completely transparent atmosphere at `c = 0`, giving `k_t = 1` and, through
 * Erbs, a clear-sky noon DNI of ~1140 W/m^2 — about 25% above anything measured at sea
 * level. Kasten & Czeplak's relation is defined against the *clear-sky* global irradiance,
 * so a clear-sky model has to sit in front of it. Haurwitz is used because it is a one-line
 * fit with an obtainable primary source, and it puts clear-sky noon DNI at ~850 W/m^2 and
 * k_t at ~0.76, which are the textbook values.
 */
export function irradianceSplit(
  apparentElevationRad: number,
  dayOfYear: number,
  atmosphere: AtmosphereConfig,
): IrradianceSplit {
  const eccentricity = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365)
  const gOn = SOLAR_CONSTANT * eccentricity

  const cosZ = Math.sin(apparentElevationRad)
  if (cosZ <= 0) {
    return {
      directNormal: 0,
      diffuseHorizontal: 0,
      globalHorizontal: 0,
      extraterrestrialNormal: gOn,
      clearnessIndex: 0,
    }
  }

  const g0 = gOn * cosZ
  const gClear = 1098 * cosZ * Math.exp(-0.059 / cosZ)
  const c = Math.min(1, Math.max(0, atmosphere.cloudFraction))
  const g = gClear * (1 - 0.75 * Math.pow(c, 3.4))

  const kt = Math.min(1, Math.max(0, g / g0))
  let kd: number
  if (kt <= 0.22) {
    kd = 1.0 - 0.09 * kt
  } else if (kt <= 0.8) {
    const k2 = kt * kt
    const k3 = k2 * kt
    const k4 = k3 * kt
    kd = 0.9511 - 0.1604 * kt + 4.388 * k2 - 16.638 * k3 + 12.336 * k4
  } else {
    kd = 0.165
  }
  kd = Math.min(1, Math.max(0, kd))

  let diffuseHorizontal = kd * g
  let directHorizontal = g - diffuseHorizontal
  let directNormal = directHorizontal / cosZ

  // Smoke plume. Beer-Lambert on the beam; the extinguished beam is not destroyed, it is
  // scattered, and wildfire smoke scatters strongly forward, so half of what leaves the beam
  // is returned to the diffuse field. The rest is absorbed by soot.
  const tau = Math.max(0, atmosphere.plumeOpticalDepth)
  if (tau > 0) {
    const transmitted = Math.exp(-tau)
    const removedHorizontal = directHorizontal * (1 - transmitted)
    directNormal *= transmitted
    directHorizontal *= transmitted
    diffuseHorizontal += 0.5 * removedHorizontal
  }

  return {
    directNormal,
    diffuseHorizontal,
    globalHorizontal: directHorizontal + diffuseHorizontal,
    extraterrestrialNormal: gOn,
    clearnessIndex: kt,
  }
}

// ---------------------------------------------------------------------------
// Slope-aspect insolation (used by the sky render's ground term now, by fuel drying at M5)
// ---------------------------------------------------------------------------

/**
 * Cosine of the incidence angle of the direct beam on an inclined plane.
 *
 * @param slopeRad terrain slope angle from horizontal.
 * @param aspectRad downslope azimuth, **clockwise from north**, matching the terrain
 *        contract's aspect convention and `SolarState.azimuth`. Note that §6.5 writes the
 *        formula with aspect measured from south; using a consistent north-referenced
 *        convention on both terms leaves `cos(γ_s − γ)` unchanged.
 * @returns cos θ_i, clamped at 0 — a negative value means the face is self-shadowed.
 */
export function cosIncidenceOnSlope(
  solarElevationRad: number,
  solarAzimuthRad: number,
  slopeRad: number,
  aspectRad: number,
): number {
  const zenith = Math.PI / 2 - solarElevationRad
  const c =
    Math.cos(slopeRad) * Math.cos(zenith) +
    Math.sin(slopeRad) * Math.sin(zenith) * Math.cos(solarAzimuthRad - aspectRad)
  return Math.max(0, c)
}

/**
 * Total shortwave absorbed by a fuel element on a slope, W/m^2. Spec §6.5.
 *
 * `S_abs = a_f [ G_bn cos θ_i + G_d (1 + cos β)/2 + ρ_g G (1 - cos β)/2 ]`
 *
 * M1 does not use this for anything but a sanity check; M5's fuel-temperature integration
 * is its real consumer, and it lives here so that there is exactly one implementation.
 */
export function absorbedShortwaveOnSlope(
  solar: SolarState,
  irradiance: IrradianceSplit,
  slopeRad: number,
  aspectRad: number,
  fuelAbsorptivity: number,
  groundAlbedo: number,
  /** Canopy shading factor along the sun ray, exp(-k PAI / cos Z). 1 = unshaded. */
  canopyTransmittance = 1,
): number {
  const cosI = cosIncidenceOnSlope(solar.elevation, solar.azimuth, slopeRad, aspectRad)
  const skyView = (1 + Math.cos(slopeRad)) / 2
  const groundView = (1 - Math.cos(slopeRad)) / 2
  return (
    fuelAbsorptivity *
    (irradiance.directNormal * canopyTransmittance * cosI +
      irradiance.diffuseHorizontal * skyView +
      groundAlbedo * irradiance.globalHorizontal * groundView)
  )
}

// ---------------------------------------------------------------------------
// The contract surface
// ---------------------------------------------------------------------------

/** `SolarState` plus everything the sky renderer and M5 need, without a second solve. */
export interface FullSolarState extends SolarState {
  readonly geometry: SolarGeometry
  readonly irradiance: IrradianceSplit
  /** Unit vector to the sun in world space: +X east, +Y up, +Z south (right-handed, Y-up). */
  readonly direction: readonly [number, number, number]
  /** Normalised linear-sRGB tint of the direct beam, peak channel 1. */
  readonly beamColor: readonly [number, number, number]
}

/**
 * World-space unit vector to the sun.
 *
 * World basis is the project's Y-up right-handed convention: +X east, +Y up, and +Z is then
 * south (because east x up = south for a right-handed frame). Azimuth is clockwise from
 * north, so north is -Z.
 */
export function sunDirection(
  elevationRad: number,
  azimuthRad: number,
): [number, number, number] {
  const cosEl = Math.cos(elevationRad)
  return [cosEl * Math.sin(azimuthRad), Math.sin(elevationRad), -cosEl * Math.cos(azimuthRad)]
}

/**
 * The full solar solve for an instant. This is the function every other module should call;
 * `ISkyRenderer.solarState` is a thin wrapper over it that discards the extras.
 */
export function computeSolarState(
  site: SiteConfig,
  time: TimeOfDay,
  atmosphere: AtmosphereConfig = DEFAULT_ATMOSPHERE,
): FullSolarState {
  const jd = julianDayForLocalTime(site, time)
  const geometry = solarGeometry(jd, site.latitudeDeg, site.longitudeDeg)
  const irradiance = irradianceSplit(geometry.apparentElevationRad, time.dayOfYear, atmosphere)
  const beam = directBeamColour(
    geometry.apparentElevationRad,
    atmosphere.turbidity,
    atmosphere.plumeOpticalDepth,
  )

  return {
    elevation: rad(geometry.apparentElevationRad) as Radians,
    azimuth: rad(geometry.azimuthRad) as Radians,
    directIrradiance: irradiance.directNormal,
    diffuseIrradiance: irradiance.diffuseHorizontal,
    colorTemperature: K(beam.cct) as Kelvin,
    isDaytime: geometry.apparentElevationRad > 0,
    geometry,
    irradiance,
    direction: sunDirection(geometry.apparentElevationRad, geometry.azimuthRad),
    beamColor: beam.rgb,
  }
}

/** Convenience: build a `TimeOfDay` from hours/minutes and a day-of-year. */
export function timeOfDay(dayOfYear: number, hours: number, minutes = 0, seconds = 0): TimeOfDay {
  return {
    secondsOfDay: (hours * 3600 + minutes * 60 + seconds) as Seconds,
    dayOfYear,
  }
}
