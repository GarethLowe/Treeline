/**
 * The WGSL cannot be compiled without a device, but everything that silently goes wrong
 * between the two languages is visible in the assembled source: a constant that drifted, an
 * f32 literal without a decimal point, a byte slot that no longer matches `FIELDS`.
 *
 *   npx vitest run test/sim/surface/shaders.test.ts
 */

import { describe, expect, it } from 'vitest'
import { SURFACE_WORKGROUP, buildSurfaceShaders, surfacePrelude } from '@sim/surface/shaders'
import { CURE_BINS } from '@sim/surface/coefficients'
import { FIELDS, SURFACE_CELLS, SURFACE_CELL_COUNT } from '@sim/surface/layout'
import { MAX_SLOPE_TANGENT } from '@sim/surface/rothermel'

const opts = { windLimit: 'sanity' } as const
const prelude = surfacePrelude(opts)
const shaders = buildSurfaceShaders(opts)

describe('prelude', () => {
  it('emits the TypeScript constants rather than copies of them', () => {
    expect(prelude).toContain(`const SURFACE_CELLS: u32 = ${SURFACE_CELLS}u;`)
    expect(prelude).toContain(`const PLANE_STRIDE: u32 = ${SURFACE_CELL_COUNT}u;`)
    expect(prelude).toContain(`const WG: u32 = ${SURFACE_WORKGROUP}u;`)
    expect(prelude).toContain(`const CURE_BINS: u32 = ${CURE_BINS}u;`)
    expect(prelude).toContain(`const MAX_SLOPE_TANGENT: f32 = ${MAX_SLOPE_TANGENT};`)
  })

  it('emits every byte slot from FIELDS, so a layout change cannot leave the shader behind', () => {
    expect(prelude).toContain(`const F_FUEL_MODEL_ID_PLANE: u32 = ${FIELDS.fuelModelId.plane}u;`)
    expect(prelude).toContain(`const F_MOISTURE_LIVE_HERB_BYTE: u32 = ${FIELDS.moistureLiveHerb.byte}u;`)
    expect(prelude).toContain(`const F_MASS_WOODY_PLANE: u32 = ${FIELDS.massWoody.plane}u;`)
    // One constant pair per field, no more and no less.
    expect([...prelude.matchAll(/const F_\w+_PLANE: u32/g)]).toHaveLength(12)
    expect([...prelude.matchAll(/const F_\w+_BYTE: u32/g)]).toHaveLength(12)
  })

  it('gives every f32 constant a decimal point', () => {
    // `const X: f32 = 3;` does not compile, and the symptom is a black screen, not an error.
    const floats = [...prelude.matchAll(/const \w+: f32 = ([^;]+);/g)].map((m) => m[1]!)
    expect(floats.length).toBeGreaterThan(5)
    for (const v of floats) expect(v).toMatch(/\./)
  })

  it('switches the §4.5 wind limit mode', () => {
    expect(surfacePrelude({ windLimit: 'none' })).toContain('const WIND_LIMIT_MODE: u32 = 0u;')
    expect(surfacePrelude({ windLimit: 'sanity' })).toContain('const WIND_LIMIT_MODE: u32 = 1u;')
    expect(surfacePrelude({ windLimit: 'behave' })).toContain('const WIND_LIMIT_MODE: u32 = 2u;')
  })
})

describe('assembly', () => {
  it('produces one compute entry point per pass', () => {
    for (const src of [shaders.rosBase, shaders.rosSubstep]) {
      expect([...src.matchAll(/@compute/g)]).toHaveLength(1)
      expect(src).toContain('fn main(@builtin(global_invocation_id)')
      expect(src).toContain(`@workgroup_size(WG, WG, 1)`)
    }
  })

  it('declares each binding exactly once per assembled module', () => {
    for (const src of [shaders.rosBase, shaders.rosSubstep]) {
      const bindings = [...src.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => m[1]!)
      expect(new Set(bindings).size).toBe(bindings.length)
    }
    // Both share bindings 0 and 1 (state, LUT) and diverge from 2.
    expect(shaders.rosBase).toContain('@binding(2) var<storage, read_write> rosBase')
    expect(shaders.rosSubstep).toContain('@binding(2) var<storage, read> rosBase')
  })

  it('does NOT enable f16 arithmetic — phi_w overflows it (see shaders.ts)', () => {
    for (const src of [shaders.rosBase, shaders.rosSubstep]) {
      expect(src).not.toContain('enable f16')
      expect(src).not.toMatch(/\bf16\b\s*[(;,)]/)
    }
    // f16 is used for STORAGE only, via the core pack/unpack builtins.
    expect(shaders.rosBase).toContain('pack2x16float')
    expect(shaders.rosSubstep).toContain('unpack2x16float')
  })

  it('keeps the moisture-fraction convention: no x100 anywhere in the shader tree', () => {
    const stripComments = (s: string) =>
      s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    for (const src of [shaders.rosBase, shaders.rosSubstep].map(stripComments)) {
      expect(src).not.toMatch(/\*\s*100\.0/)
      expect(src).not.toMatch(/\/\s*100\.0/)
      // The percent-form published constant 0.0111 must not appear in code; the fraction
      // form 1.11 must. (It is still quoted in a comment, so comments are stripped first.)
      expect(src).not.toContain('0.0111')
      expect(src).toContain('1.11 * herbMoisture')
    }
  })

  it('applies the wind cap before the ellipse, never inside it (§4.5, normative)', () => {
    const src = shaders.rosSubstep
    const cap = src.indexOf('WIND_LIMIT_MODE == 2u')
    const lb = src.indexOf('lengthToBreadth(uEff)')
    expect(cap).toBeGreaterThan(0)
    expect(lb).toBeGreaterThan(cap)
  })
})
