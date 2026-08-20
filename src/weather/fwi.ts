/**
 * The Canadian Forest Fire Weather Index System — WP 5.2.
 *
 * Six codes from four noon observations. The three moisture codes (FFMC, DMC, DC) are what
 * actually drive the simulation: spec §6.7 uses them for the UK biome, where deep organic
 * layers — peat, moorland duff, leaf mould — are described badly by the timelag-class
 * framework the US biomes use. ISI, BUI and FWI are the derived indices on top.
 *
 * Pure, dimensionless in and out, no clock and no state beyond what the caller carries. The
 * daily codes are a recurrence, so `stepFwi` takes yesterday's three and returns today's; the
 * caller owns the calendar.
 *
 * ## Units are NOT SI here, and that is deliberate
 *
 * Every equation in this system is defined on °C, %, km/h and mm, and the coefficients are
 * fitted to those units. Converting to SI and back would put a units conversion inside a
 * fitted polynomial, which is how a published model silently becomes an unpublished one. The
 * boundary is `FwiObservation`: SI stops there and the caller converts.
 */


/** Noon-LST observation. Units as the FWI system defines them; see the header. */
export interface FwiObservation {
  /** Dry-bulb temperature, °C. */
  readonly temperatureC: number
  /** Relative humidity, %. */
  readonly humidityPct: number
  /** 10 m open wind, km/h. */
  readonly windKmh: number
  /** Precipitation over the previous 24 h, mm. */
  readonly rain24hMm: number
  /** Month, 1-12. Selects the day-length corrections. */
  readonly month: number
}

/** The three moisture codes. The recurrence's state. */
export interface FwiCodes {
  readonly ffmc: number
  readonly dmc: number
  readonly dc: number
}

/** Everything the system produces for one day. */
export interface FwiOutputs extends FwiCodes {
  /** Initial Spread Index — wind and fine fuel moisture. */
  readonly isi: number
  /** Build Up Index — total fuel available, from DMC and DC. */
  readonly bui: number
  /** Fire Weather Index — the headline number. */
  readonly fwi: number
}

/**
 * Van Wagner's spring startup values.
 *
 * **These are Canadian spring conditions.** Spec §6.7 is explicit that they are wrong for a UK
 * late-summer scenario, for which the presets below exist. Starting a July burn from FFMC 85
 * models a fuel bed that has just come out from under snow.
 */
export const FWI_SPRING_STARTUP: FwiCodes = { ffmc: 85, dmc: 6, dc: 15 }

/** Spec §6.7's UK late-summer presets. */
export const FWI_UK_LATE_SUMMER: FwiCodes = { ffmc: 88, dmc: 30, dc: 250 }

/**
 * Effective day length by month for DMC, hours. Canadian standard vector, latitudes >= 30 °N.
 *
 * The system defines day-length bands rather than computing a true day length, so this is a
 * table lookup and not an ephemeris call. The project's actual solar model (WP 1.7,
 * `validated` against an ephemeris to 0.1°) is not used here on purpose: substituting a more
 * accurate day length changes the fitted relationship the coefficients were derived against.
 */
export const DMC_DAY_LENGTH: readonly number[] = [
  6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0,
]

/** Day-length factor by month for DC, north of 20 °N. */
export const DC_DAY_LENGTH_FACTOR: readonly number[] = [
  -1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6,
]

const monthIndex = (month: number): number => Math.min(11, Math.max(0, Math.trunc(month) - 1))

/** FFMC code -> moisture content, % of oven-dry mass. The scale's own inverse. */
export const ffmcToMoisture = (ffmc: number): number => (147.2 * (101 - ffmc)) / (59.5 + ffmc)

/** Moisture content -> FFMC code. */
export const moistureToFfmc = (m: number): number => (59.5 * (250 - m)) / (147.2 + m)

/** Fine Fuel Moisture Code. Fine surface litter, ~0.3 kg m^-2, roughly a 16 h timelag fuel. */
export function stepFfmc(previous: number, o: FwiObservation): number {
  const H = Math.min(100, Math.max(0, o.humidityPct))
  const T = o.temperatureC
  const W = Math.max(0, o.windKmh)
  let m = ffmcToMoisture(previous)

  if (o.rain24hMm > 0.5) {
    const pf = o.rain24hMm - 0.5
    m += 42.5 * pf * Math.exp(-100 / (251 - m)) * (1 - Math.exp(-6.93 / pf))
    // Above 150 % the bed is beyond saturation and sheds water; the correction is what stops
    // a heavy rain day producing an impossible moisture content.
    if (m > 150) m += 0.0015 * (m - 150) ** 2 * Math.sqrt(pf)
    m = Math.min(m, 250)
  }

  const common = 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H))
  const ed = 0.942 * H ** 0.679 + 11 * Math.exp((H - 100) / 10) + common
  const ew = 0.618 * H ** 0.753 + 10 * Math.exp((H - 100) / 10) + common

  if (m > ed) {
    const k0 = 0.424 * (1 - (H / 100) ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - (H / 100) ** 8)
    const kd = 0.581 * k0 * Math.exp(0.0365 * T)
    m = ed + (m - ed) * 10 ** -kd
  } else if (m < ew) {
    const inv = (100 - H) / 100
    const k1 = 0.424 * (1 - inv ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - inv ** 8)
    const kw = 0.581 * k1 * Math.exp(0.0365 * T)
    m = ew - (ew - m) * 10 ** -kw
  }
  // Between E_w and E_d the fuel is in equilibrium and does not move. That flat band is a
  // feature of the model, not a missing branch.

  return Math.min(101, Math.max(0, moistureToFfmc(m)))
}

/** Duff Moisture Code. Loosely compacted organic layer, ~5 kg m^-2. */
export function stepDmc(previous: number, o: FwiObservation): number {
  const H = Math.min(100, Math.max(0, o.humidityPct))
  // The drying rate is undefined below -1.1 °C and the system clamps rather than extrapolating.
  const T = Math.max(-1.1, o.temperatureC)
  const le = DMC_DAY_LENGTH[monthIndex(o.month)] as number
  const k = 1.894 * (T + 1.1) * (100 - H) * le * 1e-4

  let p0 = previous
  if (o.rain24hMm > 1.5) {
    const rw = 0.92 * o.rain24hMm - 1.27
    const m0 = 20 + 280 / Math.exp(0.023 * p0)
    // b is the slope of the wetting response and steepens as the duff dries; the three
    // branches are the published piecewise fit, not a smoothing of one curve.
    const b = p0 <= 33 ? 100 / (0.5 + 0.3 * p0) : p0 <= 65 ? 14 - 1.3 * Math.log(p0) : 6.2 * Math.log(p0) - 17.2
    const mr = m0 + (1000 * rw) / (48.77 + b * rw)
    p0 = 43.43 * (5.6348 - Math.log(mr - 20))
  }
  return Math.max(0, p0 + k)
}

/** Drought Code. Deep compact organic layer, ~25 kg m^-2, seasonal memory. */
export function stepDc(previous: number, o: FwiObservation): number {
  const T = Math.max(-2.8, o.temperatureC)
  const lf = DC_DAY_LENGTH_FACTOR[monthIndex(o.month)] as number
  const pe = Math.max(0, (0.36 * (T + 2.8) + lf) / 2)

  let d0 = previous
  if (o.rain24hMm > 2.8) {
    const rd = 0.83 * o.rain24hMm - 1.27
    const q0 = 800 * Math.exp(-d0 / 400)
    d0 = Math.max(0, d0 - 400 * Math.log(1 + (3.937 * rd) / q0))
  }
  return Math.max(0, d0 + pe)
}

/** Initial Spread Index. Wind and fine fuel moisture, with no fuel-quantity term. */
export function initialSpreadIndex(ffmc: number, windKmh: number): number {
  const m = ffmcToMoisture(ffmc)
  const fW = Math.exp(0.05039 * Math.max(0, windKmh))
  const fF = 91.9 * Math.exp(-0.1386 * m) * (1 + m ** 5.31 / 4.93e7)
  return 0.208 * fW * fF
}

/** Build Up Index. The fuel actually available to burn, from the two duff codes. */
export function buildUpIndex(dmc: number, dc: number): number {
  if (dmc <= 0 && dc <= 0) return 0
  if (dmc <= 0.4 * dc) {
    const denom = dmc + 0.4 * dc
    return denom > 0 ? (0.8 * dmc * dc) / denom : 0
  }
  const denom = dmc + 0.4 * dc
  const factor = denom > 0 ? 1 - (0.8 * dc) / denom : 1
  return Math.max(0, dmc - factor * (0.92 + (0.0114 * dmc) ** 1.7))
}

/** Fire Weather Index. Spread and available fuel combined. */
export function fireWeatherIndex(isi: number, bui: number): number {
  const fD = bui <= 80 ? 0.626 * bui ** 0.809 + 2 : 1000 / (25 + 108.64 * Math.exp(-0.023 * bui))
  const b = 0.1 * isi * fD
  return b <= 1 ? b : Math.exp(2.72 * (0.434 * Math.log(b)) ** 0.647)
}

/** One day of the system. Yesterday's codes plus today's noon observation. */
export function stepFwi(previous: FwiCodes, o: FwiObservation): FwiOutputs {
  const ffmc = stepFfmc(previous.ffmc, o)
  const dmc = stepDmc(previous.dmc, o)
  const dc = stepDc(previous.dc, o)
  const isi = initialSpreadIndex(ffmc, o.windKmh)
  const bui = buildUpIndex(dmc, dc)
  return { ffmc, dmc, dc, isi, bui, fwi: fireWeatherIndex(isi, bui) }
}

// ---------------------------------------------------------------------------
// Cross-walk to the size-class moisture the surface solver takes
// ---------------------------------------------------------------------------

/**
 * FWI codes -> the timelag-class moisture fractions `SpreadInputs` wants.
 *
 * **This mapping is the project's own construction and is not published.** Spec §6.7 says so
 * outright. It is dimensionally reasonable and monotonic in each code, and it is the pragmatic
 * way to drive one solver from two moisture systems — but the UK biome's fire behaviour
 * inherits an unvalidated step here, and that is the honest place to look first if UK spread
 * rates come out wrong.
 *
 * Returns FRACTIONS, not percentages (spec §0.6).
 */
export function fwiToSizeClassMoisture(codes: FwiCodes): {
  readonly dead1h: number
  readonly dead10h: number
  readonly dead100h: number
  readonly dead1000h: number
} {
  const dead1h = ffmcToMoisture(codes.ffmc) / 100
  // The DMC moisture relation, inverted: M = 20 + 280 e^{-0.023 DMC}.
  const duff = (20 + 280 * Math.exp(-0.023 * Math.max(0, codes.dmc))) / 100
  // DC as millimetres of water in a 100 mm-equivalent layer, read as a moisture fraction.
  const deep = (800 * Math.exp(-Math.max(0, codes.dc) / 400)) / 800
  return {
    dead1h,
    // 10 h and 100 h are interpolated between the fine and duff ends rather than modelled:
    // the FWI system simply does not resolve them.
    dead10h: dead1h + (duff - dead1h) * 0.4,
    dead100h: dead1h + (duff - dead1h) * 0.8,
    dead1000h: deep,
  }
}


