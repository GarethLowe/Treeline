import { describe, expect, it } from 'vitest'
import { CELL_BURNING, CELL_BURNT, CELL_UNBURNT, type CellState } from '@contracts/sim'
import {
  RAMP_SAMPLES,
  fireDebugPrelude,
  fireDebugShader,
  resampleRamp,
} from '@render/firedebug/shaders'
import { FIRE_DEBUG_VIEWS, INTENSITY_RAMP, RAMPS, STATE_COLORS, rampColor } from '@render/firedebug/views'
import { legendModel } from '@render/firedebug/legend'

describe('ramp resampling', () => {
  it('keeps the endpoints exact', () => {
    const s = resampleRamp(INTENSITY_RAMP)
    expect(s).toHaveLength(RAMP_SAMPLES)
    expect(s[0]).toEqual(rampColor(INTENSITY_RAMP, 0))
    expect(s[RAMP_SAMPLES - 1]).toEqual(rampColor(INTENSITY_RAMP, 1))
  })

  it('stays within 0.02 per channel of the authored ramp, so the legend does not lie', () => {
    for (const ramp of Object.values(RAMPS)) {
      const table = resampleRamp(ramp)
      for (let i = 0; i <= 40; i++) {
        const t = i / 40
        const exact = rampColor(ramp, t)
        // Reproduce the shader's lookup: index into the table and mix.
        const u = t * (RAMP_SAMPLES - 1)
        const lo = Math.min(Math.floor(u), RAMP_SAMPLES - 1)
        const hi = Math.min(lo + 1, RAMP_SAMPLES - 1)
        const f = u - Math.floor(u)
        for (let c = 0; c < 3; c++) {
          const approx = table[lo]![c]! + (table[hi]![c]! - table[lo]![c]!) * f
          expect(Math.abs(approx - exact[c]!)).toBeLessThan(0.02)
        }
      }
    }
  })
})

describe('generated WGSL prelude', () => {
  const prelude = fireDebugPrelude()

  it('declares one array per ramp plus the state palette, all the right length', () => {
    for (const name of ['FD_RAMP_INTENSITY', 'FD_RAMP_ARRIVAL', 'FD_RAMP_CONSUMED']) {
      const decl = prelude.split('\n').find((l) => l.includes(name))
      expect(decl, name).toBeDefined()
      expect(decl).toContain(`array<vec3<f32>, ${RAMP_SAMPLES}>`)
      expect(decl!.match(/vec3<f32>\(/g)).toHaveLength(RAMP_SAMPLES)
    }
    expect(prelude).toContain(`const FD_RAMP_N : u32 = ${RAMP_SAMPLES}u;`)
    expect(prelude.match(/vec4<f32>\(/g)).toHaveLength(3)
  })

  it('emits the state colours in CELL_* order, unburnt fully transparent', () => {
    const line = prelude.split('\n').find((l) => l.includes('FD_STATE_COLORS'))!
    const vecs = [...line.matchAll(/vec4<f32>\(([^)]*)\)/g)].map((m) =>
      m[1]!.split(',').map((v) => Number.parseFloat(v)),
    )
    expect(vecs).toHaveLength(3)
    const order: readonly CellState[] = [CELL_UNBURNT, CELL_BURNING, CELL_BURNT]
    for (const [i, state] of order.entries()) {
      const want = STATE_COLORS[state]
      for (let c = 0; c < 4; c++) expect(vecs[i]![c]).toBeCloseTo(want[c]!, 3)
    }
    expect(vecs[0]![3]).toBe(0)
  })

  it('writes every literal with a decimal point — WGSL has no implicit int-to-float', () => {
    for (const lit of prelude.matchAll(/vec[34]<f32>\(([^)]*)\)/g)) {
      for (const v of lit[1]!.split(',')) expect(v.trim()).toMatch(/^-?\d+\.\d+$/)
    }
  })
})

describe('assembled shader', () => {
  const code = fireDebugShader()
  /** Comments talk ABOUT samplers and atomics; the assertions below are about the code. */
  const bare = code.replace(/\/\/.*/g, '')

  it('puts the generated constants before the code that uses them', () => {
    expect(code.indexOf('FD_RAMP_INTENSITY :')).toBeLessThan(code.indexOf('fn fd_ramp'))
  })

  it('declares both entry points the pipeline asks for', () => {
    expect(code).toContain('fn vs_firedebug')
    expect(code).toContain('fn fs_firedebug')
  })

  it('numbers the view constants the same way FIRE_DEBUG_VIEWS does', () => {
    for (const [i, view] of FIRE_DEBUG_VIEWS.entries()) {
      const name = `FD_VIEW_${view.toUpperCase()}`
      expect(code).toContain(`const ${name} : u32 = ${i}u;`)
    }
  })

  it('binds all four IFireOutputs textures', () => {
    for (const b of ['fdState', 'fdIntensity', 'fdArrival', 'fdConsumed']) {
      expect(code).toContain(b)
    }
  })

  it('never samples the fire textures — textureLoad only, so no filterable-float dependency', () => {
    expect(bare).not.toContain('textureSample')
    expect(bare).not.toMatch(/var\s+\w+\s*:\s*sampler/)
  })

  it('reads the outputs and nothing else — a debug view must not stall the solver', () => {
    expect(bare).not.toContain('read_write')
    expect(bare).not.toContain('atomic')
  })
})

describe('legend', () => {
  it('covers every view', () => {
    for (const view of FIRE_DEBUG_VIEWS) {
      const m = legendModel(view)
      expect(m.title.length).toBeGreaterThan(0)
      expect(m.swatches.length).toBeGreaterThan(1)
      for (const s of m.swatches) expect(s.color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('labels the ends of the intensity ramp with the configured range', () => {
    const m = legendModel('intensity', {
      intensityMinKWm: 10,
      intensityMaxKWm: 10000,
      isochroneIntervalS: 60,
      arrivalMaxS: 1800,
    })
    expect(m.kind).toBe('gradient')
    expect(m.swatches[0]!.label).toBe('10 kW/m')
    expect(m.swatches[m.swatches.length - 1]!.label).toBe('10 MW/m')
    expect(m.note).toContain('log')
  })

  it('states the arrival range in real time units and names the contour spacing', () => {
    const m = legendModel('arrival')
    expect(m.swatches[0]!.label).toBe('0.0 s')
    expect(m.swatches[m.swatches.length - 1]!.label).toBe('30 min')
    expect(m.note).toContain('60 s')
  })

  it('labels consumed fuel as a fraction, never a percent (spec §0.6 rule 3)', () => {
    const m = legendModel('consumed')
    expect(m.unit).toBe('fraction')
    expect(m.swatches.map((s) => s.label)).toContain('1.00')
    for (const s of m.swatches) expect(s.label).not.toContain('%')
  })

  it('keys the state view discretely rather than as a ramp', () => {
    const m = legendModel('state')
    expect(m.kind).toBe('swatches')
    expect(m.swatches.map((s) => s.label)).toEqual([
      'unburnt (not drawn)',
      'burning',
      'burnt',
    ])
  })
})
