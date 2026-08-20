/**
 * Everything the user can change, in one place, with URL-parameter parsing.
 *
 * The seed and the biome are *world-defining*: changing either means regenerating, which
 * costs seconds. Everything else is live. Keeping that split explicit in the type is what
 * lets `app.ts` decide between "rebuild the world" and "write a uniform" without a table of
 * special cases.
 *
 * URL parameters exist because world generation is seconds long and reproducibility is a
 * spec requirement (§0.2: "World generation is seeded and reproducible"). Being able to send
 * someone `?seed=1234&biome=eucalypt-dry-forest` and have them see the same trees is the
 * cheapest possible form of that.
 *
 * Pure module.
 */

import type { QualityLevel } from '@contracts/gpu.ts'
import { BIOME_IDS, type BiomeId } from '@contracts/world.ts'

/** Settings that require a full world rebuild when changed. */
export interface WorldSettings {
  readonly seed: number
  readonly biome: BiomeId
}

/** Settings applied per frame. Changing any of these never regenerates anything. */
export interface LiveSettings {
  /** 1-366. Drives solar declination and therefore seasonal sun path. */
  readonly dayOfYear: number
  /** Seconds since local midnight. */
  readonly secondsOfDay: number
  /** Simulated hours of clock time per real second. 0 freezes the sun. */
  readonly hoursPerSecond: number
  /** Pin the quality controller, disabling adaptation. Null = adaptive. */
  readonly qualityPin: QualityLevel | null
  /** Free-camera cruise speed, m/s. */
  readonly cameraSpeed: number
  /** Exposure compensation in stops, on top of the automatic value. */
  readonly exposureStops: number
  readonly grassEnabled: boolean
  /** Draw the HUD. */
  readonly hudVisible: boolean

  // --- M2/M3 fire (see src/app/fire.ts) ---------------------------------------------------
  /** Freeze the solver. The world still renders and the sun still moves. */
  readonly firePaused: boolean
  /**
   * Fixed steps of fire per fixed step of wall clock. **Multiplies the number of steps, never
   * their size** — see `FireSim.step`. 1 = real time, which is far too slow to watch a fire
   * that spreads at 0.2 m/s across a 1 km domain.
   */
  readonly fireTimeScale: number
  /** Midflame wind speed, m/s. Already adjusted from the 10 m reference (WAF). */
  readonly windMps: number
  /** Direction the wind blows FROM, degrees clockwise from north. Meteorological convention. */
  readonly windFromDeg: number
  /** Dead 1-h fuel moisture as a **percent**, because that is how fuel tables are quoted.
   *  Converted to a fraction exactly once, at the `weatherFrom` boundary (spec §0.6). */
  readonly dead1hPct: number
  /** Live herbaceous moisture, **percent**. Drives the curing fraction for dynamic models. */
  readonly liveHerbPct: number
  /** Fuel model code, or null to take the biome's dominant species' litter model. */
  readonly fuelModel: string | null
  /** WP 2.6 debug overlay: a `FireDebugViewId`, or `'off'`. */
  readonly fireView: string
  /** What a click on the terrain ignites. */
  readonly ignitionTool: 'point' | 'line' | 'ring'
  /** Radius of a point or ring ignition, and half-width of a line, in metres. */
  readonly ignitionRadiusM: number
}

export interface AppSettings extends WorldSettings, LiveSettings {
  /** `?debug` — run WP 1.1's smoke test and dump subsystem state before starting. */
  readonly debug: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  seed: 1337,
  biome: 'western-us-conifer',
  dayOfYear: 196, // mid July: the northern-hemisphere fire season.
  secondsOfDay: 10 * 3600, // Mid-morning: long shadows, sun clearly off the zenith.
  hoursPerSecond: 0,
  qualityPin: null,
  cameraSpeed: 25,
  exposureStops: 0,
  grassEnabled: true,
  hudVisible: true,
  debug: false,

  firePaused: false,
  fireTimeScale: 8,
  // The §4.2 GR2 D2L2 benchmark point, so a fresh load starts at the one condition the solver
  // has been validated against (to 0.32%). 2.2 m/s midflame ≈ 5 mi/h at 20 ft with WAF 0.4.
  windMps: 2.2,
  windFromDeg: 270,
  dead1hPct: 6,
  liveHerbPct: 60,
  fuelModel: null,
  fireView: 'arrival',
  ignitionTool: 'point',
  ignitionRadiusM: 5,
}

export function isBiomeId(value: string): value is BiomeId {
  return (BIOME_IDS as readonly string[]).includes(value)
}

/**
 * Seeds are `u32`. A text field accepts either a number or a word — hashing a word is much
 * friendlier than telling someone their seed must be an integer, and it is still exactly
 * reproducible.
 */
export function parseSeed(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return DEFAULT_SETTINGS.seed
  if (/^\d+$/.test(trimmed)) return Number(trimmed) >>> 0
  let h = 0x811c9dc5
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, v))
}

export function isQualityLevel(v: number): v is QualityLevel {
  return Number.isInteger(v) && v >= 0 && v <= 5
}

/** Parse `location.search`. Unknown or malformed parameters fall back rather than throwing. */
export function settingsFromSearch(search: string, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const p = new URLSearchParams(search)
  const biome = p.get('biome')
  const seed = p.get('seed')
  const hour = p.get('hour')
  const day = p.get('day')
  const quality = p.get('quality')
  const speed = p.get('speed')
  const stops = p.get('exposure')

  const q = quality === null ? base.qualityPin : Number(quality)
  return {
    seed: seed === null ? base.seed : parseSeed(seed),
    biome: biome !== null && isBiomeId(biome) ? biome : base.biome,
    dayOfYear: day === null ? base.dayOfYear : clampInt(Number(day), 1, 366, base.dayOfYear),
    secondsOfDay:
      hour === null ? base.secondsOfDay : clampNum(Number(hour) * 3600, 0, 86399, base.secondsOfDay),
    hoursPerSecond: base.hoursPerSecond,
    qualityPin: typeof q === 'number' && isQualityLevel(q) ? q : null,
    cameraSpeed: speed === null ? base.cameraSpeed : clampNum(Number(speed), 1, 500, base.cameraSpeed),
    exposureStops: stops === null ? base.exposureStops : clampNum(Number(stops), -8, 8, base.exposureStops),
    grassEnabled: p.get('grass') !== '0',
    hudVisible: p.get('hud') !== '0',
    debug: p.has('debug'),

    firePaused: p.get('fire') === '0',
    fireTimeScale: num('fireScale', 1, 64, base.fireTimeScale),
    windMps: num('wind', 0, 30, base.windMps),
    windFromDeg: num('windFrom', 0, 360, base.windFromDeg),
    dead1hPct: num('mc1h', 0.5, 60, base.dead1hPct),
    liveHerbPct: num('mcHerb', 30, 300, base.liveHerbPct),
    fuelModel: p.get('fuel'),
    fireView: p.get('fireView') ?? base.fireView,
    ignitionTool: toolFrom(p.get('tool')) ?? base.ignitionTool,
    ignitionRadiusM: num('ignR', 0.5, 200, base.ignitionRadiusM),
  }

  function num(key: string, lo: number, hi: number, fallback: number): number {
    const v = p.get(key)
    return v === null ? fallback : clampNum(Number(v), lo, hi, fallback)
  }
}

export function toolFrom(v: string | null): LiveSettings['ignitionTool'] | null {
  return v === 'point' || v === 'line' || v === 'ring' ? v : null
}

/** The inverse, so the address bar can be kept in step with the controls. */
export function searchFromSettings(s: AppSettings): string {
  const p = new URLSearchParams()
  p.set('seed', String(s.seed))
  p.set('biome', s.biome)
  p.set('day', String(s.dayOfYear))
  p.set('hour', (s.secondsOfDay / 3600).toFixed(2))
  if (s.qualityPin !== null) p.set('quality', String(s.qualityPin))
  if (!s.grassEnabled) p.set('grass', '0')
  if (s.debug) p.set('debug', '1')
  if (s.firePaused) p.set('fire', '0')
  p.set('wind', s.windMps.toFixed(1))
  p.set('windFrom', String(Math.round(s.windFromDeg)))
  p.set('mc1h', s.dead1hPct.toFixed(1))
  p.set('fireScale', String(s.fireTimeScale))
  p.set('fireView', s.fireView)
  if (s.fuelModel !== null) p.set('fuel', s.fuelModel)
  return `?${p.toString()}`
}
