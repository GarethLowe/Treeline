/**
 * Lunar position, phase and moonlight. **Pure — no GPU, no DOM.**
 *
 * The moon matters for two reasons and neither of them is decoration. First, night has to be
 * dark *and* variable: a full moon puts 0.25 lx on the ground and a new moon puts nothing, and
 * that difference is roughly three orders of magnitude in how a night fire reads. Second, the
 * same night-sky illuminance number feeds the environment SH, so the ambient term at night is
 * derived rather than dialled in.
 *
 * ALGORITHM. Schlyter, "Computing planetary positions — a tutorial with worked examples"
 * (obtainable, §§4-13): Keplerian elements for the moon plus the twelve largest longitude
 * perturbations, five latitude perturbations and two distance perturbations. Quoted accuracy
 * about 2 arcminutes (0.03 deg) in ecliptic longitude — an order of magnitude coarser than the
 * solar solve, and an order of magnitude better than needed to place a moon disc and set a
 * moonlight level. Topocentric parallax IS applied: the moon's horizontal parallax is ~0.95 deg,
 * which would otherwise be by far the largest error in the chain.
 *
 * Phase brightness follows the standard lunar magnitude-phase relation
 * `m = -12.73 + 1.49|phi| + 0.043 phi^4` (phi = phase angle in radians), which gives a half moon
 * about 9% as bright as a full moon rather than the 50% a naive Lambertian model would give.
 * The opposition surge in that expression is why a full moon looks so disproportionately bright.
 */

import { kastenYoungAirMass } from './spectrum.ts'
import { FULL_MOON_ILLUMINANCE_LUX } from './twilight.ts'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

function wrap360(deg: number): number {
  const v = deg % 360
  return v < 0 ? v + 360 : v
}

function sinD(deg: number): number {
  return Math.sin(deg * DEG)
}

function cosD(deg: number): number {
  return Math.cos(deg * DEG)
}

export interface MoonState {
  /** Apparent (topocentric, refraction-corrected) elevation above the horizon, radians. */
  readonly elevation: number
  /** Azimuth clockwise from north, radians. */
  readonly azimuth: number
  /** Unit vector to the moon, world space: +X east, +Y up, +Z south. */
  readonly direction: readonly [number, number, number]
  /** Geocentric distance in Earth radii (mean 60.27). */
  readonly distanceEarthRadii: number
  /** Illuminated fraction of the disc, 0 (new) to 1 (full). */
  readonly illuminatedFraction: number
  /** Phase angle sun-moon-earth, radians. 0 at full moon, pi at new moon. */
  readonly phaseAngle: number
  /** Elongation from the sun, radians. 0 at new moon, pi at full moon. */
  readonly elongation: number
  /** Angular radius of the disc as seen from the observer, radians. */
  readonly angularRadius: number
  /** Horizontal illuminance from moonlight at the observer, lux. Zero below the horizon. */
  readonly illuminanceLux: number
}

/** Mean angular radius of the moon at mean distance, radians (0.259 deg). */
export const MOON_MEAN_ANGULAR_RADIUS = 0.259 * DEG
/** Mean geocentric distance in Earth radii. */
export const MOON_MEAN_DISTANCE_ER = 60.2666

/**
 * Moon position and phase.
 *
 * @param jdUt Julian Day including the UT fraction — the same value `solarGeometry` takes.
 * @param latitudeDeg observer latitude, north positive.
 * @param longitudeDeg observer longitude, **east positive**.
 */
export function moonState(jdUt: number, latitudeDeg: number, longitudeDeg: number): MoonState {
  // Schlyter's day number: d = 0.0 at 1999 Dec 31.0 UT.
  const d = jdUt - 2451543.5

  // --- Orbital elements -----------------------------------------------------
  const N = wrap360(125.1228 - 0.0529538083 * d) // longitude of ascending node
  const i = 5.1454
  const w = wrap360(318.0634 + 0.1643573223 * d) // argument of perigee
  const a = 60.2666 // semi-major axis, Earth radii
  const e = 0.0549
  const M = wrap360(115.3654 + 13.0649929509 * d) // mean anomaly

  // Sun, needed for the perturbations and for the phase.
  const wSun = wrap360(282.9404 + 4.70935e-5 * d)
  const MSun = wrap360(356.047 + 0.9856002585 * d)

  // --- Kepler ---------------------------------------------------------------
  let E = M + RAD * e * sinD(M) * (1 + e * cosD(M))
  for (let k = 0; k < 6; k++) {
    const dE = (E - RAD * e * sinD(E) - M) / (1 - e * cosD(E))
    E -= dE
    if (Math.abs(dE) < 1e-9) break
  }

  const xv = a * (cosD(E) - e)
  const yv = a * (Math.sqrt(1 - e * e) * sinD(E))
  const v = wrap360(Math.atan2(yv, xv) * RAD) // true anomaly
  let r = Math.sqrt(xv * xv + yv * yv) // distance, Earth radii

  // --- Ecliptic position ----------------------------------------------------
  const xh =
    r * (cosD(N) * cosD(v + w) - sinD(N) * sinD(v + w) * cosD(i))
  const yh =
    r * (sinD(N) * cosD(v + w) + cosD(N) * sinD(v + w) * cosD(i))
  const zh = r * (sinD(v + w) * sinD(i))

  let lon = wrap360(Math.atan2(yh, xh) * RAD)
  let lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * RAD

  // --- Perturbations (Schlyter §12) ----------------------------------------
  const Ls = wrap360(MSun + wSun) // sun's mean longitude
  const Lm = wrap360(M + w + N) // moon's mean longitude
  const D = wrap360(Lm - Ls) // mean elongation
  const F = wrap360(Lm - N) // argument of latitude

  lon +=
    -1.274 * sinD(M - 2 * D) + // evection
    0.658 * sinD(2 * D) + // variation
    -0.186 * sinD(MSun) + // yearly equation
    -0.059 * sinD(2 * M - 2 * D) +
    -0.057 * sinD(M - 2 * D + MSun) +
    0.053 * sinD(M + 2 * D) +
    0.046 * sinD(2 * D - MSun) +
    0.041 * sinD(M - MSun) +
    -0.035 * sinD(D) + // parallactic equation
    -0.031 * sinD(M + MSun) +
    -0.015 * sinD(2 * F - 2 * D) +
    0.011 * sinD(M - 4 * D)

  lat +=
    -0.173 * sinD(F - 2 * D) +
    -0.055 * sinD(M - F - 2 * D) +
    -0.046 * sinD(M + F - 2 * D) +
    0.033 * sinD(F + 2 * D) +
    0.017 * sinD(2 * M + F)

  r += -0.58 * cosD(M - 2 * D) - 0.46 * cosD(2 * D)
  lon = wrap360(lon)

  // --- Ecliptic -> equatorial ----------------------------------------------
  const ecl = 23.4393 - 3.563e-7 * d
  const xg = r * cosD(lon) * cosD(lat)
  const yg = r * sinD(lon) * cosD(lat)
  const zg = r * sinD(lat)

  const xe = xg
  const ye = yg * cosD(ecl) - zg * sinD(ecl)
  const ze = yg * sinD(ecl) + zg * cosD(ecl)

  const raDeg = wrap360(Math.atan2(ye, xe) * RAD)
  const decDeg = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * RAD

  // --- Sidereal time and hour angle ----------------------------------------
  const n = jdUt - 2451545.0
  const utHours = ((jdUt - Math.floor(jdUt - 0.5) - 0.5) * 24) % 24
  const gmst = (6.697375 + 0.0657098242 * n + utHours) % 24
  const lst = ((gmst + longitudeDeg / 15) % 24 + 24) % 24
  let haDeg = lst * 15 - raDeg
  haDeg = ((haDeg + 180) % 360 + 360) % 360 - 180

  // --- Topocentric parallax (Schlyter §13) ---------------------------------
  const mpar = Math.asin(1 / Math.max(1.0001, r)) * RAD // horizontal parallax, deg
  const gclat = latitudeDeg - 0.1924 * sinD(2 * latitudeDeg)
  const rho = 0.99833 + 0.00167 * cosD(2 * latitudeDeg)
  const g = Math.atan2(Math.tan(gclat * DEG), cosD(haDeg)) * RAD

  const topRa = raDeg - (mpar * rho * cosD(gclat) * sinD(haDeg)) / Math.max(1e-6, cosD(decDeg))
  const topDec =
    Math.abs(sinD(g)) < 1e-6
      ? decDeg - mpar * rho * sinD(gclat)
      : decDeg - (mpar * rho * sinD(gclat) * sinD(g - decDeg)) / sinD(g)

  let topHa = lst * 15 - topRa
  topHa = ((topHa + 180) % 360 + 360) % 360 - 180

  const phi = latitudeDeg * DEG
  const decRad = topDec * DEG
  const haRad = topHa * DEG
  const sinAlt =
    Math.sin(phi) * Math.sin(decRad) + Math.cos(phi) * Math.cos(decRad) * Math.cos(haRad)
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)))
  const azimuth = Math.atan2(
    -Math.sin(haRad) * Math.cos(decRad),
    Math.cos(phi) * Math.sin(decRad) - Math.sin(phi) * Math.cos(decRad) * Math.cos(haRad),
  )
  const azimuthNorm = azimuth < 0 ? azimuth + 2 * Math.PI : azimuth

  // --- Phase ---------------------------------------------------------------
  // Sun's geocentric ecliptic longitude from the same element set, so phase is self-consistent.
  const eSun = 0.016709 - 1.151e-9 * d
  let ESun = MSun + RAD * eSun * sinD(MSun) * (1 + eSun * cosD(MSun))
  for (let k = 0; k < 4; k++) {
    const dE = (ESun - RAD * eSun * sinD(ESun) - MSun) / (1 - eSun * cosD(ESun))
    ESun -= dE
  }
  const xs = cosD(ESun) - eSun
  const ys = Math.sqrt(1 - eSun * eSun) * sinD(ESun)
  const lonSun = wrap360(Math.atan2(ys, xs) * RAD + wSun)
  const rSun = Math.sqrt(xs * xs + ys * ys) // AU

  const cosElong =
    cosD(lat) * cosD(lon - lonSun)
  const elongation = Math.acos(Math.max(-1, Math.min(1, cosElong)))
  // Phase angle at the moon: from the sun-earth-moon triangle. The sun is ~389x further away
  // than the moon, so phase angle ~= pi - elongation to well inside a degree; the exact form
  // is kept because it costs nothing.
  const rSunEr = rSun * 23454.8 // 1 AU in Earth radii
  const phaseAngle = Math.atan2(rSunEr * Math.sin(elongation), r - rSunEr * Math.cos(elongation))
  const phaseAbs = Math.abs(phaseAngle)
  const illuminatedFraction = (1 + Math.cos(phaseAngle)) / 2

  // --- Moonlight -----------------------------------------------------------
  // Magnitude-phase relation, then the inverse-square distance term, the airmass extinction and
  // the cosine of incidence on a horizontal surface.
  let illuminanceLux = 0
  if (altitude > 0) {
    const deltaMag = 1.49 * phaseAbs + 0.043 * Math.pow(phaseAbs, 4)
    const phaseFactor = Math.pow(10, -0.4 * deltaMag)
    const distanceFactor = (MOON_MEAN_DISTANCE_ER / Math.max(1, r)) ** 2
    const airmass = kastenYoungAirMass(Math.PI / 2 - altitude)
    // 0.28 magnitudes of visual extinction per airmass at sea level (standard clear-sky value).
    const extinction = Math.pow(10, -0.4 * 0.28 * airmass)
    illuminanceLux =
      FULL_MOON_ILLUMINANCE_LUX *
      phaseFactor *
      distanceFactor *
      extinction *
      Math.sin(altitude)
  }

  const cosEl = Math.cos(altitude)
  return {
    elevation: altitude,
    azimuth: azimuthNorm,
    direction: [
      cosEl * Math.sin(azimuthNorm),
      Math.sin(altitude),
      -cosEl * Math.cos(azimuthNorm),
    ],
    distanceEarthRadii: r,
    illuminatedFraction,
    phaseAngle,
    elongation,
    // Apparent size scales inversely with distance: 0.259 deg at the mean 60.27 Earth radii,
    // ~0.28 deg at perigee.
    angularRadius: (MOON_MEAN_ANGULAR_RADIUS * MOON_MEAN_DISTANCE_ER) / Math.max(1, r),
    illuminanceLux,
  }
}

/** Synodic month, days. Exposed so tests can check the phase cycle closes. */
export const SYNODIC_MONTH_DAYS = 29.530588
