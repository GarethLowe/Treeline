/**
 * Presentation-only formatting for the boot screen and the HUD.
 *
 * Pure, and deliberately the *only* place in `src/app` that converts internal SI into
 * display units. Spec §0.6 rule 4: angles are radians internally and degrees only at UI
 * boundaries; rule 3: moisture is a fraction internally and a percent only in the HUD. This
 * module is that boundary, so a grep for `radToDeg` outside it is a bug.
 */

import { radToDeg } from '@contracts/units.ts'
import type { MoistureFraction, Radians } from '@contracts/units.ts'

export function ms(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '--'
  if (v >= 10_000) return `${(v / 1000).toFixed(2)} s`
  return `${v.toFixed(digits)} ms`
}

export function count(v: number): string {
  if (!Number.isFinite(v)) return '--'
  return Math.round(v).toLocaleString('en-US')
}

export function bytes(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '--'
  if (v >= 1 << 30) return `${(v / 2 ** 30).toFixed(2)} GiB`
  if (v >= 1 << 20) return `${(v / 2 ** 20).toFixed(1)} MiB`
  if (v >= 1 << 10) return `${(v / 2 ** 10).toFixed(1)} KiB`
  return `${Math.round(v)} B`
}

/** Degrees, for display only. */
export function deg(v: Radians, digits = 1): string {
  return `${radToDeg(v).toFixed(digits)}°`
}

/** Moisture is a FRACTION internally; percent exists only here (spec §0.6 rule 3). */
export function moisturePct(v: MoistureFraction, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`
}

/** Seconds since local midnight -> HH:MM:SS. */
export function clock(secondsOfDay: number): string {
  const wrapped = ((secondsOfDay % 86400) + 86400) % 86400
  const h = Math.floor(wrapped / 3600)
  const m = Math.floor((wrapped % 3600) / 60)
  const s = Math.floor(wrapped % 60)
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** HH:MM -> seconds since local midnight, or null when unparseable. */
export function parseClock(text: string): number | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*(?::\s*(\d{1,2}))?\s*$/.exec(text)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = m[3] === undefined ? 0 : Number(m[3])
  if (h > 23 || min > 59 || sec > 59) return null
  return h * 3600 + min * 60 + sec
}

/** Day-of-year -> a short date label. Non-leap reference year; drives declination only. */
export function dayLabel(dayOfYear: number): string {
  const clamped = Math.min(365, Math.max(1, Math.round(dayOfYear)))
  const date = new Date(Date.UTC(2023, 0, clamped))
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? '?'}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad(v: number): string {
  return v < 10 ? `0${v}` : String(v)
}

/** Left-pad a key so the HUD's columns line up in a monospace font. */
export function row(key: string, value: string, keyWidth = 15): string {
  return `${key.padEnd(keyWidth)}${value}`
}

/** Compass point for an azimuth in radians clockwise from north. */
export function compass(azimuth: Radians): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  const twoPi = Math.PI * 2
  const a = ((azimuth % twoPi) + twoPi) % twoPi
  const idx = Math.round((a / twoPi) * 16) % 16
  return points[idx] ?? 'N'
}
