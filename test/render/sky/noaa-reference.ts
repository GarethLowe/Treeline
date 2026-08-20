/**
 * An INDEPENDENT solar position implementation, used only as a test oracle.
 *
 * This is the NOAA Solar Calculator formulation (NOAA Global Monitoring Laboratory,
 * "Solar Calculation Details", after Meeus, *Astronomical Algorithms*): a different series
 * expansion from the Michalsky/Astronomical Almanac algorithm the simulation ships, with more
 * terms in the equation of centre, a nutation term in the apparent longitude, and the equation
 * of time computed from the obliquity rather than from the right ascension.
 *
 * Two independent formulations agreeing to a few thousandths of a degree over a grid of dates,
 * times and latitudes is what "matches an ephemeris" actually means in practice — far stronger
 * evidence than a handful of transcribed table values, which mostly test whether the values were
 * transcribed correctly.
 *
 * Deliberately written to be as textually unlike src/render/sky/solar.ts as possible: it works
 * in degrees throughout, takes UTC calendar fields rather than a Julian Day, and does not share
 * a single helper with the implementation under test.
 */

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

function sinD(d: number): number {
  return Math.sin(d * D2R)
}
function cosD(d: number): number {
  return Math.cos(d * D2R)
}
function tanD(d: number): number {
  return Math.tan(d * D2R)
}

/** Julian Day from a UTC calendar instant. Meeus Eq. 7.1. */
export function noaaJulianDay(
  year: number,
  month: number,
  day: number,
  hourUtc: number,
): number {
  let y = year
  let m = month
  if (m <= 2) {
    y -= 1
    m += 12
  }
  const a = Math.floor(y / 100)
  const b = 2 - a + Math.floor(a / 4)
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5 +
    hourUtc / 24
  )
}

export interface NoaaResult {
  /** Geometric (no refraction) elevation, degrees. */
  readonly elevationDeg: number
  /** Azimuth clockwise from north, degrees. */
  readonly azimuthDeg: number
  readonly declinationDeg: number
  /** Equation of time, minutes. */
  readonly equationOfTimeMin: number
  readonly hourAngleDeg: number
}

/**
 * @param longitudeDeg east positive, matching the project convention (the NOAA spreadsheet uses
 *        west positive; the sign is flipped here once, at the input).
 */
export function noaaSolarPosition(
  year: number,
  month: number,
  day: number,
  hourUtc: number,
  latitudeDeg: number,
  longitudeDeg: number,
): NoaaResult {
  const jd = noaaJulianDay(year, month, day, hourUtc)
  const t = (jd - 2451545) / 36525

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)

  const centre =
    sinD(meanAnom) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    sinD(2 * meanAnom) * (0.019993 - 0.000101 * t) +
    sinD(3 * meanAnom) * 0.000289

  const trueLong = meanLong + centre
  const omega = 125.04 - 1934.136 * t
  const appLong = trueLong - 0.00569 - 0.00478 * sinD(omega)

  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliqCorr = meanObliq + 0.00256 * cosD(omega)

  const declination = Math.asin(sinD(obliqCorr) * sinD(appLong)) * R2D

  const varY = tanD(obliqCorr / 2) * tanD(obliqCorr / 2)
  const eqTime =
    4 *
    R2D *
    (varY * sinD(2 * meanLong) -
      2 * eccent * sinD(meanAnom) +
      4 * eccent * varY * sinD(meanAnom) * cosD(2 * meanLong) -
      0.5 * varY * varY * sinD(4 * meanLong) -
      1.25 * eccent * eccent * sinD(2 * meanAnom))

  // True solar time, minutes. NOAA's sheet works in local clock minutes with a timezone term;
  // feeding it UTC minutes and the east-positive longitude directly is the same thing.
  const minutesUtc = hourUtc * 60
  const trueSolarTime = (((minutesUtc + eqTime + 4 * longitudeDeg) % 1440) + 1440) % 1440
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180

  const zenith =
    Math.acos(
      Math.max(
        -1,
        Math.min(
          1,
          sinD(latitudeDeg) * sinD(declination) +
            cosD(latitudeDeg) * cosD(declination) * cosD(hourAngle),
        ),
      ),
    ) * R2D
  const elevation = 90 - zenith

  let azimuth: number
  const denom = cosD(latitudeDeg) * sinD(zenith)
  if (Math.abs(denom) < 1e-12) {
    azimuth = hourAngle > 0 ? 180 : 0
  } else {
    const inner = Math.max(
      -1,
      Math.min(1, (sinD(latitudeDeg) * cosD(zenith) - sinD(declination)) / denom),
    )
    const acosDeg = Math.acos(inner) * R2D
    azimuth = hourAngle > 0 ? (acosDeg + 180) % 360 : (540 - acosDeg) % 360
  }

  return {
    elevationDeg: elevation,
    azimuthDeg: (azimuth + 360) % 360,
    declinationDeg: declination,
    equationOfTimeMin: eqTime,
    hourAngleDeg: hourAngle,
  }
}

/** Smallest signed difference between two bearings, degrees. */
export function angleDeltaDeg(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}
