/**
 * Fire debug view definitions — WP 2.6.
 *
 * Deliberately provisional. M4 owns the real fire rendering (froxel raymarch of the sim's
 * own soot/temperature fields); this package exists so M2 can be judged by eye while it is
 * being built, and it is expected to be deleted or hidden behind a developer flag once M4
 * lands. Nothing here tries to look like fire.
 *
 * This file is the ONE definition of what each view shows and what colour it maps a value
 * to. `shaders.ts` generates the WGSL ramp constants from these tables, so the picture and
 * the legend cannot disagree with each other, and `fireDebugColor` below is the CPU oracle
 * the tests assert against.
 *
 * Units follow spec §0.6: intensity in kW/m, arrival time in seconds, consumed fraction
 * dimensionless in [0, 1]. No percentages anywhere.
 */

import { CELL_BURNING, CELL_BURNT, CELL_UNBURNT, type CellState } from '@contracts/sim.ts'

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

export const FIRE_DEBUG_VIEWS = ['state', 'intensity', 'arrival', 'consumed'] as const
export type FireDebugViewId = (typeof FIRE_DEBUG_VIEWS)[number]

/** Numeric id handed to the shader. Index into `FIRE_DEBUG_VIEWS`. */
export function viewIndex(view: FireDebugViewId): number {
  return FIRE_DEBUG_VIEWS.indexOf(view)
}

/** The toggle. Wrapping, so one key can cycle the lot. */
export function cycleView(view: FireDebugViewId, step = 1): FireDebugViewId {
  const n = FIRE_DEBUG_VIEWS.length
  const i = (((viewIndex(view) + step) % n) + n) % n
  return FIRE_DEBUG_VIEWS[i] as FireDebugViewId
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * Display ranges. These are presentation choices, not physics — but the defaults are picked
 * off real spans so the ramp is not all one colour on a typical run:
 *
 *  - Fireline intensity runs from a creeping timber-litter fire (~10 kW/m) to an extreme
 *    grass or chaparral head fire (~10 MW/m), four decades, so the ramp is LOG. A linear
 *    ramp over that span shows one orange dot and nothing else.
 *  - The isochrone interval is the single most diagnostic number in the whole package: it
 *    sets the contour spacing that reveals whether the front shape is the right ellipse.
 */
export interface FireDebugRanges {
  readonly intensityMinKWm: number
  readonly intensityMaxKWm: number
  /** Contour spacing for the arrival-time view. */
  readonly isochroneIntervalS: number
  /** Full-scale of the arrival-time colour ramp. */
  readonly arrivalMaxS: number
}

export const DEFAULT_RANGES: FireDebugRanges = {
  intensityMinKWm: 10,
  intensityMaxKWm: 10000,
  isochroneIntervalS: 60,
  arrivalMaxS: 1800,
}

/** Sentinel for "the front never got here". `arrivalTimeTexture` is r32float, atomicMin-written. */
export const ARRIVAL_NEVER = 3.4e38

// ---------------------------------------------------------------------------
// Ramps
// ---------------------------------------------------------------------------

/** `[t, r, g, b]`, t ascending in [0, 1]. Treated as linear RGB; see `radianceScaleForExposure`. */
export type RampStop = readonly [number, number, number, number]
export type Ramp = readonly RampStop[]

/** Inferno-like. Dark cold end, white-hot top, monotone in luminance so it reads greyscale too. */
export const INTENSITY_RAMP: Ramp = [
  [0.0, 0.05, 0.03, 0.15],
  [0.25, 0.47, 0.11, 0.42],
  [0.5, 0.79, 0.28, 0.24],
  [0.75, 0.96, 0.6, 0.09],
  [1.0, 0.99, 1.0, 0.64],
]

/** Viridis-like. Sequential and colour-blind safe, so isochrone order reads unambiguously. */
export const ARRIVAL_RAMP: Ramp = [
  [0.0, 0.27, 0.0, 0.33],
  [0.25, 0.19, 0.41, 0.56],
  [0.5, 0.14, 0.58, 0.51],
  [0.75, 0.47, 0.77, 0.25],
  [1.0, 0.99, 0.91, 0.15],
]

/** Cured fuel -> scorch -> ash. */
export const CONSUMED_RAMP: Ramp = [
  [0.0, 0.55, 0.5, 0.35],
  [0.5, 0.35, 0.25, 0.15],
  [1.0, 0.06, 0.06, 0.07],
]

export const RAMPS: Readonly<Record<'intensity' | 'arrival' | 'consumed', Ramp>> = {
  intensity: INTENSITY_RAMP,
  arrival: ARRIVAL_RAMP,
  consumed: CONSUMED_RAMP,
}

/** `[r, g, b, a]` per cell state. Unburnt is fully transparent — the terrain shows through. */
export const STATE_COLORS: Readonly<Record<CellState, readonly [number, number, number, number]>> = {
  [CELL_UNBURNT]: [0, 0, 0, 0],
  [CELL_BURNING]: [1.0, 0.35, 0.05, 0.9],
  [CELL_BURNT]: [0.09, 0.08, 0.08, 0.75],
}

/** Piecewise-linear ramp lookup. `t` is clamped, so out-of-range values pin to the ends. */
export function rampColor(ramp: Ramp, t: number): [number, number, number] {
  const first = ramp[0]
  const last = ramp[ramp.length - 1]
  if (first === undefined || last === undefined) return [0, 0, 0]
  if (!(t > first[0])) return [first[1], first[2], first[3]]
  for (let i = 1; i < ramp.length; i++) {
    const b = ramp[i] as RampStop
    if (t <= b[0]) {
      const a = ramp[i - 1] as RampStop
      const span = b[0] - a[0]
      const f = span > 0 ? (t - a[0]) / span : 0
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
    }
  }
  return [last[1], last[2], last[3]]
}

/**
 * Log-normalise a value onto [0, 1]. Anything at or below `min` pins to 0, which is what you
 * want for intensity: a cell with zero intensity is not "the coldest colour", it is off.
 */
export function normalizeLog(v: number, min: number, max: number): number {
  if (!(v > 0) || !(max > min) || min <= 0) return 0
  const t = (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min))
  return Math.min(1, Math.max(0, t))
}

export function normalizeLinear(v: number, min: number, max: number): number {
  if (!(max > min)) return 0
  return Math.min(1, Math.max(0, (v - min) / (max - min)))
}

// ---------------------------------------------------------------------------
// The mapping — CPU oracle for shaders/firedebug/firedebug.wgsl
// ---------------------------------------------------------------------------

/** One cell's worth of `IFireOutputs`, as the fragment shader reads it. */
export interface FireSample {
  readonly state: CellState
  readonly intensityKWm: number
  readonly arrivalS: number
  readonly consumed: number
}

export type Rgba = readonly [number, number, number, number]

const TRANSPARENT: Rgba = [0, 0, 0, 0]

/**
 * Colour for one cell in one view. Straight (non-premultiplied) alpha.
 *
 * `isochroneLine` is the shader's screen-space contour term (0 = no line, 1 = on a contour);
 * it needs `fwidth` to be a constant width on screen and so cannot be computed here. The
 * tests pass it explicitly.
 */
export function fireDebugColor(
  view: FireDebugViewId,
  sample: FireSample,
  ranges: FireDebugRanges = DEFAULT_RANGES,
  isochroneLine = 0,
): Rgba {
  switch (view) {
    case 'state': {
      const c = STATE_COLORS[sample.state] ?? TRANSPARENT
      return [c[0], c[1], c[2], c[3]]
    }
    case 'intensity': {
      if (!(sample.intensityKWm > 0)) return TRANSPARENT
      const t = normalizeLog(sample.intensityKWm, ranges.intensityMinKWm, ranges.intensityMaxKWm)
      const [r, g, b] = rampColor(INTENSITY_RAMP, t)
      return [r, g, b, 0.85]
    }
    case 'arrival': {
      if (!hasArrived(sample.arrivalS)) return TRANSPARENT
      const t = normalizeLinear(sample.arrivalS, 0, ranges.arrivalMaxS)
      const [r, g, b] = rampColor(ARRIVAL_RAMP, t)
      const l = Math.min(1, Math.max(0, isochroneLine))
      // Bands are dimmed and the contour itself is drawn white on top, so the lines read as
      // lines rather than as one more colour in the ramp.
      return [r * 0.7 + l * (1 - r * 0.7), g * 0.7 + l * (1 - g * 0.7), b * 0.7 + l * (1 - b * 0.7), 0.6 + 0.4 * l]
    }
    case 'consumed': {
      if (!(sample.consumed > 0)) return TRANSPARENT
      const [r, g, b] = rampColor(CONSUMED_RAMP, normalizeLinear(sample.consumed, 0, 1))
      return [r, g, b, 0.85]
    }
  }
}

/**
 * A cell has an arrival time if the front reached it.
 *
 * Both sentinels are rejected: a huge value (the atomicMin initial state the contract
 * implies) and zero (what a texture that was never written holds, since WebGPU zeroes new
 * textures). That costs the single ignition cell at t = 0 and buys immunity to whichever
 * convention WP 2.2 lands on — worth it, since this package cannot see that decision.
 */
export function hasArrived(arrivalS: number): boolean {
  return Number.isFinite(arrivalS) && arrivalS > 0 && arrivalS < ARRIVAL_NEVER
}

/** Which isochrone band a cell falls in, and where within it. */
export function isochroneBand(arrivalS: number, intervalS: number): { band: number; phase: number } {
  if (!hasArrived(arrivalS) || !(intervalS > 0)) return { band: -1, phase: 0 }
  const p = arrivalS / intervalS
  return { band: Math.floor(p), phase: p - Math.floor(p) }
}

/**
 * The overlay is drawn into the linear-HDR world target, BEFORE exposure and the ACES curve
 * (src/app/resolvePass.ts). Written at unit magnitude it would be crushed to black in
 * daylight, so it is scaled by the inverse of the frame's exposure. 0.6 lands mid-tone
 * through the ACES fit — bright enough to read, short of clipping to white.
 *
 * This is the calibration knob: if the overlay is composited after tone mapping instead,
 * pass 1.
 */
export function radianceScaleForExposure(exposure: number): number {
  return 0.6 / Math.max(exposure, 1e-9)
}
