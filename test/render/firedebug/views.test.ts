import { describe, expect, it } from 'vitest'
import { CELL_BURNING, CELL_BURNT, CELL_UNBURNT } from '@contracts/sim'
import type { FireDebugViewId } from '@render/firedebug/views'
import {
  ARRIVAL_NEVER,
  ARRIVAL_RAMP,
  CONSUMED_RAMP,
  DEFAULT_RANGES,
  FIRE_DEBUG_VIEWS,
  INTENSITY_RAMP,
  STATE_COLORS,
  cycleView,
  fireDebugColor,
  hasArrived,
  isochroneBand,
  normalizeLinear,
  normalizeLog,
  radianceScaleForExposure,
  rampColor,
  viewIndex,
} from '@render/firedebug/views'

describe('view toggle', () => {
  it('cycles through every view and wraps', () => {
    let v: FireDebugViewId = FIRE_DEBUG_VIEWS[0]
    const seen = new Set<FireDebugViewId>([v])
    for (let i = 0; i < FIRE_DEBUG_VIEWS.length - 1; i++) {
      v = cycleView(v)
      seen.add(v)
    }
    expect(seen.size).toBe(FIRE_DEBUG_VIEWS.length)
    expect(cycleView(v)).toBe(FIRE_DEBUG_VIEWS[0])
  })

  it('steps backwards', () => {
    expect(cycleView(FIRE_DEBUG_VIEWS[0], -1)).toBe(FIRE_DEBUG_VIEWS[FIRE_DEBUG_VIEWS.length - 1])
  })

  it('numbers the views the way the shader constants do', () => {
    expect(viewIndex('state')).toBe(0)
    expect(viewIndex('intensity')).toBe(1)
    expect(viewIndex('arrival')).toBe(2)
    expect(viewIndex('consumed')).toBe(3)
  })
})

describe('ramps', () => {
  const ramps = [INTENSITY_RAMP, ARRIVAL_RAMP, CONSUMED_RAMP]

  it('are ascending in t, start at 0 and end at 1', () => {
    for (const ramp of ramps) {
      expect(ramp[0]?.[0]).toBe(0)
      expect(ramp[ramp.length - 1]?.[0]).toBe(1)
      for (let i = 1; i < ramp.length; i++) expect(ramp[i]![0]).toBeGreaterThan(ramp[i - 1]![0])
    }
  })

  it('stay inside [0, 1] per channel', () => {
    for (const ramp of ramps) {
      for (const stop of ramp) {
        for (const c of [stop[1], stop[2], stop[3]]) {
          expect(c).toBeGreaterThanOrEqual(0)
          expect(c).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('returns the exact stop colour at a stop and interpolates between', () => {
    expect(rampColor(INTENSITY_RAMP, 0)).toEqual([0.05, 0.03, 0.15])
    expect(rampColor(INTENSITY_RAMP, 1)).toEqual([0.99, 1.0, 0.64])
    const mid = rampColor(CONSUMED_RAMP, 0.25)
    expect(mid[0]).toBeCloseTo((0.55 + 0.35) / 2, 10)
  })

  it('clamps outside [0, 1]', () => {
    expect(rampColor(ARRIVAL_RAMP, -5)).toEqual(rampColor(ARRIVAL_RAMP, 0))
    expect(rampColor(ARRIVAL_RAMP, 99)).toEqual(rampColor(ARRIVAL_RAMP, 1))
  })

  it('is monotone in luminance for the intensity ramp, so it reads in greyscale', () => {
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const [r, g, b] = rampColor(INTENSITY_RAMP, i / 20)
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
      expect(y).toBeGreaterThan(prev)
      prev = y
    }
  })
})

describe('normalisation', () => {
  it('places decades evenly on the log ramp', () => {
    expect(normalizeLog(10, 10, 10000)).toBeCloseTo(0, 10)
    expect(normalizeLog(100, 10, 10000)).toBeCloseTo(1 / 3, 10)
    expect(normalizeLog(1000, 10, 10000)).toBeCloseTo(2 / 3, 10)
    expect(normalizeLog(10000, 10, 10000)).toBeCloseTo(1, 10)
  })

  it('pins values outside the range and refuses non-positive input', () => {
    expect(normalizeLog(1, 10, 10000)).toBe(0)
    expect(normalizeLog(1e9, 10, 10000)).toBe(1)
    expect(normalizeLog(0, 10, 10000)).toBe(0)
    expect(normalizeLog(-5, 10, 10000)).toBe(0)
  })

  it('normalises linearly and clamps', () => {
    expect(normalizeLinear(0.25, 0, 1)).toBe(0.25)
    expect(normalizeLinear(-1, 0, 1)).toBe(0)
    expect(normalizeLinear(4, 0, 1)).toBe(1)
    expect(normalizeLinear(5, 3, 3)).toBe(0)
  })
})

describe('arrival sentinels', () => {
  it('rejects both the large sentinel and the never-written zero', () => {
    expect(hasArrived(ARRIVAL_NEVER)).toBe(false)
    expect(hasArrived(Infinity)).toBe(false)
    expect(hasArrived(NaN)).toBe(false)
    expect(hasArrived(0)).toBe(false)
    expect(hasArrived(-1)).toBe(false)
    expect(hasArrived(0.001)).toBe(true)
    expect(hasArrived(3600)).toBe(true)
  })
})

describe('isochrone banding', () => {
  it('bands at multiples of the interval', () => {
    expect(isochroneBand(0.5, 60)).toEqual({ band: 0, phase: 0.5 / 60 })
    expect(isochroneBand(60, 60).band).toBe(1)
    expect(isochroneBand(150, 60).band).toBe(2)
    expect(isochroneBand(150, 60).phase).toBeCloseTo(0.5, 10)
  })

  it('reports no band where the front never arrived', () => {
    expect(isochroneBand(ARRIVAL_NEVER, 60).band).toBe(-1)
    expect(isochroneBand(120, 0).band).toBe(-1)
  })
})

describe('fireDebugColor', () => {
  const base = { state: CELL_UNBURNT, intensityKWm: 0, arrivalS: ARRIVAL_NEVER, consumed: 0 } as const

  it('draws nothing for unburnt fuel in every view', () => {
    for (const view of FIRE_DEBUG_VIEWS) {
      expect(fireDebugColor(view, base)[3]).toBe(0)
    }
  })

  it('uses the state palette', () => {
    expect(fireDebugColor('state', { ...base, state: CELL_BURNING })).toEqual(
      STATE_COLORS[CELL_BURNING],
    )
    expect(fireDebugColor('state', { ...base, state: CELL_BURNT })).toEqual(STATE_COLORS[CELL_BURNT])
  })

  it('is monotone in intensity — a hotter cell is never a colder colour', () => {
    let prev = -1
    for (const kWm of [15, 50, 200, 900, 4000, 9000]) {
      const [r, g, b] = fireDebugColor('intensity', { ...base, intensityKWm: kWm })
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
      expect(y).toBeGreaterThan(prev)
      prev = y
    }
  })

  it('saturates rather than wrapping outside the intensity range', () => {
    const hot = fireDebugColor('intensity', { ...base, intensityKWm: 1e7 })
    const top = fireDebugColor('intensity', { ...base, intensityKWm: DEFAULT_RANGES.intensityMaxKWm })
    expect(hot).toEqual(top)
  })

  it('brightens the arrival view towards white on a contour line', () => {
    const off = fireDebugColor('arrival', { ...base, arrivalS: 300 }, DEFAULT_RANGES, 0)
    const on = fireDebugColor('arrival', { ...base, arrivalS: 300 }, DEFAULT_RANGES, 1)
    expect(on[0]).toBeCloseTo(1, 10)
    expect(on[1]).toBeCloseTo(1, 10)
    expect(on[2]).toBeCloseTo(1, 10)
    expect(on[3]).toBeGreaterThan(off[3])
  })

  it('darkens the consumed view as fuel is consumed', () => {
    const light = fireDebugColor('consumed', { ...base, consumed: 0.1 })
    const ash = fireDebugColor('consumed', { ...base, consumed: 1 })
    expect(ash[0]).toBeLessThan(light[0])
  })

  it('keeps alpha in [0, 1] across the whole input space', () => {
    for (const view of FIRE_DEBUG_VIEWS) {
      for (const line of [0, 0.5, 1]) {
        const a = fireDebugColor(
          view,
          { state: CELL_BURNING, intensityKWm: 500, arrivalS: 120, consumed: 0.5 },
          DEFAULT_RANGES,
          line,
        )[3]
        expect(a).toBeGreaterThanOrEqual(0)
        expect(a).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('exposure compensation', () => {
  it('inverts exposure so the overlay lands mid-tone', () => {
    expect(radianceScaleForExposure(1)).toBeCloseTo(0.6, 10)
    expect(radianceScaleForExposure(0.01) * 0.01).toBeCloseTo(0.6, 10)
    expect(Number.isFinite(radianceScaleForExposure(0))).toBe(true)
  })
})
