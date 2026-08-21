/**
 * The M2 integration invariants. Nothing here needs a GPU.
 *
 * These are the analogue of the reversed-Z test next door: each guards an integration point
 * where two packages built in parallel agree today and would fail *silently* if either moved.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SURFACE_CELLS, SURFACE_CELL_M } from '../../src/contracts/sim.ts'
import { DOMAIN_SIZE_M } from '../../src/contracts/world.ts'
import { FUEL_MODELS } from '../../src/sim/rothermel/fuelModels.ts'
import { buildCoefficientLut } from '../../src/sim/surface/coefficients.ts'
import { SURFACE_BUFFERS } from '../../src/sim/surface/layout.ts'
import { packCell } from '../../src/sim/surface/surfacePass.ts'
import { STUB_WEATHER, dominantFuelModel, weatherFrom } from '../../src/app/fire.ts'
import { DEFAULT_SETTINGS, searchFromSettings, settingsFromSearch } from '../../src/app/settings.ts'
import { fireLines } from '../../src/app/ui.ts'
import { aggregateStand } from '../../src/sim/canopy/crown/stand.ts'
import { evaluateCrownFire } from '../../src/sim/canopy/crown/vanWagner.ts'
import { kWm, kgm3, m as metres, moistureFraction, mps } from '../../src/contracts/units.ts'

describe('the WP 2.2 -> WP 2.3 rate-of-spread bridge', () => {
  // `FireSim.bridge` copies `SurfaceGrid.ellipseCache` (a storage buffer of vec2u) straight
  // into the propagation solver's `rosCache` (an rgba16float texture). That copy is only
  // legal — and only *correct* — while all three of these hold. If any fails, the solver
  // reads garbage rates and the fire either stalls or explodes, with no error anywhere.
  const ellipse = SURFACE_BUFFERS.find((b) => b.name === 'ellipseCache')

  it('the source buffer is 8 bytes per cell, exactly one rgba16float texel', () => {
    expect(ellipse?.bytesPerCell).toBe(8)
    expect(ellipse?.copies).toBe(1)
  })

  it('the row pitch is a legal copy pitch (WebGPU requires a multiple of 256)', () => {
    expect((8 * SURFACE_CELLS) % 256).toBe(0)
  })

  it('the two packages agree on the grid the copy spans', () => {
    // `SurfaceSolver` defaults to SURFACE_CELLS and both come from contracts/world.ts, so
    // this checks the domain rather than the constant: 2048 x 0.5 m must be the 1 km world.
    expect(SURFACE_CELLS * SURFACE_CELL_M).toBe(DOMAIN_SIZE_M)
  })
})

describe('fuel bed', () => {
  it('numbers every fuel model inside the one byte the packed state gives it', () => {
    const lut = buildCoefficientLut(FUEL_MODELS)
    expect(lut.order.length).toBeLessThanOrEqual(256)
    expect(lut.order[0]).toBe('<non-burnable>')
  })

  it('round-trips a fuel model id through the packed cell state', () => {
    const lut = buildCoefficientLut(FUEL_MODELS)
    const id = lut.order.indexOf('GR2')
    expect(id).toBeGreaterThan(0)
    const words = packCell({ fuelModelId: id, flags: 1, moisture: [0.06, 0.07, 0.08, 0.6, 0.9] })
    expect(words[0] & 0xff).toBe(id)
  })

  it('takes the mix-weighted dominant species litter model', () => {
    const species = new Map([
      ['a', { surfaceFuelModel: 'TL8' }],
      ['b', { surfaceFuelModel: 'GR2' }],
    ])
    expect(dominantFuelModel({ a: 0.7, b: 0.3 }, species)).toBe('TL8')
    expect(dominantFuelModel({ a: 0.2, b: 0.8 }, species)).toBe('GR2')
  })

  it('falls back to the benchmark model rather than to id 0, which cannot burn', () => {
    const species = new Map([['a', { surfaceFuelModel: 'NOT-A-MODEL' }]])
    expect(dominantFuelModel({ a: 1 }, species)).toBe('GR2')
    expect(FUEL_MODELS.has(dominantFuelModel({}, new Map()))).toBe(true)
  })
})

describe('moisture is a fraction, never a percent (spec §0.6)', () => {
  it('keeps the stub weather inside the fraction range', () => {
    for (const v of Object.values(STUB_WEATHER.moisture)) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(4) // LIVE_MOISTURE_FULL_SCALE; anything near 6 is a stray x100
    }
  })

  it('converts the percent-quoted UI value exactly once', () => {
    const w = weatherFrom({ windMps: 2, windFromDeg: 0, dead1h: 6 / 100, liveHerb: 60 / 100 })
    expect(w.moisture.dead1h).toBeCloseTo(0.06, 10)
    expect(w.moisture.liveHerb).toBeCloseTo(0.6, 10)
  })

  it('turns meteorological "wind from" into the shader\'s "blows toward"', () => {
    // ros_substep.wgsl: azimuthToVec(a) = vec2(sin a, cos a), a = azimuth blown TOWARD.
    // A westerly (from 270) must push the fire east, i.e. toward azimuth 90.
    const w = weatherFrom({ windMps: 2, windFromDeg: 270, dead1h: 0.06, liveHerb: 0.6 })
    expect(Math.sin(w.windDirection)).toBeCloseTo(1, 10)
    expect(Math.cos(w.windDirection)).toBeCloseTo(0, 10)
  })
})

describe('fire settings round-trip through the URL', () => {
  it('survives a serialise/parse cycle', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      windMps: 4.5,
      windFromDeg: 135,
      dead1hPct: 8.5,
      fireTimeScale: 16,
      fireView: 'arrival',
      fuelModel: 'SH7',
    }
    const back = settingsFromSearch(searchFromSettings(s))
    expect(back.windMps).toBeCloseTo(4.5, 6)
    expect(back.windFromDeg).toBe(135)
    expect(back.dead1hPct).toBeCloseTo(8.5, 6)
    expect(back.fireTimeScale).toBe(16)
    expect(back.fuelModel).toBe('SH7')
  })

  it('never parses a moisture percent as a fraction', () => {
    // `?mc1h=6` means 6 %, not 600 %. The clamp floor of 0.5 is what makes a value that was
    // meant as a fraction (0.06) obvious rather than silently 20x too dry.
    expect(settingsFromSearch('?mc1h=6').dead1hPct).toBe(6)
    expect(settingsFromSearch('?mc1h=0.06').dead1hPct).toBe(0.5)
  })
})

describe('the HUD tells predictions from measurements (spec §0.7.4)', () => {
  const frame = {
    running: true,
    timeScale: 8,
    simTimeS: 125,
    fuelModelCode: 'GR2',
    fuelModelName: 'Low Load, Dry Climate Grass',
    ignitionCount: 1,
    windMps: 2.2,
    windFromDeg: 270,
    dead1hPct: 6,
    predicted: {
      rateOfSpreadMps: 11.7 / 60,
      firelineIntensityKWm: 1200,
      flameLengthM: 2.1,
      lengthToBreadth: 2.3,
      effectiveWindMps: 2.2,
      extinguished: false,
    },
    measured: {
      burntAreaM2: 12_345,
      perimeterM: 410,
      activeCellCount: 8192,
      maxFirelineIntensityKWm: 0,
      dispatchOverflowed: false,
    },
    missing: ['intensityTexture — WP 2.4 gap'],
  }

  it('labels the two groups so a prediction cannot be read as a measurement', () => {
    const text = fireLines(frame).join('\n')
    expect(text).toMatch(/predicted.*level ground/)
    expect(text).toMatch(/measured.*read back/)
  })

  it('reports the rate of spread in both m/min and chains per hour', () => {
    const text = fireLines(frame).join('\n')
    expect(text).toContain('11.70 m/min')
    expect(text).toContain('34.9 ch/h') // 11.7 m/min = 35 ch/h, the §4.2 benchmark
  })

  it('says EXTINGUISHED rather than printing a zero rate', () => {
    const text = fireLines({
      ...frame,
      predicted: { ...frame.predicted, rateOfSpreadMps: 0, extinguished: true },
    }).join('\n')
    expect(text).toContain('EXTINGUISHED')
    expect(text).not.toMatch(/ROS\s+0\.00 m\/min/)
  })

  it('names unwired contract fields instead of printing zero for them', () => {
    expect(fireLines(frame).join('\n')).toContain('NOT WIRED')
  })

  it('shouts when a dispatch overflowed, because the numbers are then invalid', () => {
    const text = fireLines({
      ...frame,
      measured: { ...frame.measured, dispatchOverflowed: true },
    }).join('\n')
    expect(text).toContain('DISPATCH OVERFLOW')
  })
})

describe('crown fire is fed real stand geometry (WP 3.5)', () => {
  // WP 1.3 hands out a STAND crown bulk density and a per-stem within-crown one that is
  // several times larger. Van Wagner's 0.05 kg/m3 active-crowning threshold is defined
  // against the stand value; feeding it the per-stem number would classify almost any fire
  // as active crowning, which is the kind of wrong that looks plausible.
  const stems = Array.from({ length: 200 }, () => ({
    heightM: metres(22),
    crownBaseM: metres(4),
    foliarMoisture: moistureFraction(1.0),
    hasLadderFuels: false,
  }))

  it('aggregates the stand mean crown base, not the tallest or the lowest', () => {
    const stand = aggregateStand(stems, kgm3(0.12))
    expect(stand.canopyBaseHeight as number).toBeCloseTo(4, 6)
    expect(stand.foliarMoisture as number).toBeCloseTo(1.0, 6)
  })

  it('needs more surface intensity to torch a high canopy than a low one', () => {
    const low = evaluateCrownFire({
      stand: aggregateStand(
        stems.map((s) => ({ ...s, crownBaseM: metres(1) })),
        kgm3(0.12),
      ),
      surfaceIntensity: kWm(1500),
      surfaceRos: mps(0.2),
      crownRos: mps(0.2),
    })
    const high = evaluateCrownFire({
      stand: aggregateStand(
        stems.map((s) => ({ ...s, crownBaseM: metres(12) })),
        kgm3(0.12),
      ),
      surfaceIntensity: kWm(1500),
      surfaceRos: mps(0.2),
      crownRos: mps(0.2),
    })
    expect(low.criticalIntensity as number).toBeLessThan(high.criticalIntensity as number)
    expect(low.classification).not.toBe('none')
  })

  it('reports CFB as diagnostic while the canopy voxel field is not wired', () => {
    const r = evaluateCrownFire({
      stand: aggregateStand(stems, kgm3(0.12)),
      surfaceIntensity: kWm(1500),
      surfaceRos: mps(0.2),
      crownRos: mps(0.2),
    })
    // This is the flag the HUD prints. If it ever comes back false without the canopy solver
    // being wired, someone has started passing a measured fraction that is not measured.
    expect(r.crownFractionBurnedIsDiagnostic).toBe(true)
  })

  it('a stand with no canopy fuel cannot crown, whatever the surface does', () => {
    const r = evaluateCrownFire({
      stand: aggregateStand([], kgm3(0)),
      surfaceIntensity: kWm(50_000),
      surfaceRos: mps(2),
      crownRos: mps(2),
    })
    expect(r.crownFractionBurned).toBe(0)
  })
})

/**
 * The canopy and the smoke field run on the SURFACE fire's clock.
 *
 * `FireSim.step` consumes `timeScale` as substeps, so it advances the world by `scale * dt`
 * and not by the `dt` its caller passed. Handing that same `dt` to the canopy ran the crowns
 * at `1/timeScale` of the fire drying them — at the default 8x they sat pinned at the water
 * boiling plateau and the 3D canopy could not ignite under any surface fire, which read for
 * three sessions as a plume bug.
 *
 * Nothing here can be caught at compile time: both are `Seconds`, so the wrong one type-checks
 * perfectly. It cannot be caught under Vitest either, since stepping any of this needs a GPU.
 * So this reads the call sites, exactly as the WGSL mirror tests read the shaders.
 */
describe('the canopy steps on the same clock as the fire (main.ts)', () => {
  const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8')

  /** Argument list of every `<object>.step(` call, `?.` or not. */
  const callsTo = (object: string): string[] => {
    const out: string[] = []
    for (const opener of [object + '.step(', object + '?.step(']) {
      let from = 0
      for (let at = main.indexOf(opener, from); at >= 0; at = main.indexOf(opener, from)) {
        let depth = 1
        let i = at + opener.length
        for (; i < main.length && depth > 0; i++) {
          if (main[i] === '(') depth++
          else if (main[i] === ')') depth--
        }
        out.push(main.slice(at + opener.length, i - 1))
        from = i
      }
    }
    return out
  }

  it('takes the simulated time the fire returns, rather than recomputing it', () => {
    expect(main).toMatch(/const simDt = f\.step\(/)
  })

  it('passes that time to every canopy and smoke step, at every call site', () => {
    const calls = [...callsTo('canopy'), ...callsTo('c'), ...callsTo('smoke')]
    // Two canopy call sites (frame loop, primeCanopy) and two smoke ones.
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const args of calls) {
      expect(args).toContain('simDt')
      expect(args).not.toMatch(/(^|[(,]\s*)dt\s*[,)]/)
    }
  })
})
