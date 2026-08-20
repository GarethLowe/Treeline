/**
 * The WGSL cannot be compiled without a device, but everything that silently goes wrong
 * between the two languages is visible in the assembled source: a fixed-point scale that
 * drifted, an f32 literal without a decimal point, a ray-count floor that stopped matching
 * §6.7.
 *
 *   npx vitest run test/sim/canopy/radiation/shaders.test.ts
 */

import { describe, expect, it } from 'vitest'
import { A2_MIN, EMIT_CELL_M, EMIT_CLUSTER_CAP, EMIT_GRID_CELLS, GATHER_WORKGROUP, MIN_RAY_COUNT, OVERFLOW_POWER_SHIFT, POSITION_BIAS_M, POSITION_FIXED_SCALE, POWER_FIXED_SCALE, RAD_CELL_M, RAD_NI, RAY_COUNTS, RAY_TAPS } from '@sim/canopy/radiation/layout.ts'
import { BRICK_NI, MAX_RAY_COUNT, buildRadiationShaders, radiationPrelude } from '@sim/canopy/radiation/shaders.ts'

const prelude = radiationPrelude()
const shaders = buildRadiationShaders()

describe('prelude', () => {
  it('emits the TypeScript constants rather than copies of them', () => {
    expect(prelude).toContain(`const RAD_CELL_M: f32 = ${RAD_CELL_M}.0;`)
    expect(prelude).toContain(`const RAD_NI: u32 = ${RAD_NI}u;`)
    expect(prelude).toContain(`const EMIT_CELL_M: f32 = ${EMIT_CELL_M}.0;`)
    expect(prelude).toContain(`const EMIT_GRID_CELLS: u32 = ${EMIT_GRID_CELLS}u;`)
    expect(prelude).toContain(`const EMIT_CLUSTER_CAP: u32 = ${EMIT_CLUSTER_CAP}u;`)
    expect(prelude).toContain(`const BRICK_NI: u32 = ${BRICK_NI}u;`)
    expect(prelude).toContain(`const GATHER_WG: u32 = ${GATHER_WORKGROUP}u;`)
    expect(prelude).toContain(`const RAY_TAPS: u32 = ${RAY_TAPS}u;`)
  })

  it('emits the four fixed-point scales, which are what a silent drift would corrupt', () => {
    expect(prelude).toContain(`const POWER_FIXED_SCALE: f32 = ${POWER_FIXED_SCALE};`)
    expect(prelude).toContain(`const POSITION_BIAS_M: f32 = ${POSITION_BIAS_M}.0;`)
    expect(prelude).toContain(`const POSITION_FIXED_SCALE: f32 = ${POSITION_FIXED_SCALE}.0;`)
    expect(prelude).toContain(`const A2_MIN: f32 = ${A2_MIN}.0;`)
    expect(prelude).toContain(`const OVERFLOW_POWER_SHIFT: u32 = ${OVERFLOW_POWER_SHIFT}u;`)
  })

  it('gives every f32 constant a decimal point or an exponent', () => {
    // `const X: f32 = 3;` does not compile, and the symptom is a black screen, not an error.
    const floats = [...prelude.matchAll(/const \w+: f32 = ([^;]+);/g)].map((v) => v[1]!)
    expect(floats.length).toBeGreaterThan(10)
    for (const v of floats) expect(v).toMatch(/[.e]/)
  })

  it('gives the vec3 constant three f32 components', () => {
    expect(prelude).toMatch(/const OVERFLOW_CENTRE: vec3f = vec3f\([\d.]+, [\d.]+, [\d.]+\);/)
  })
})

describe('§6.7 ray count', () => {
  it('keeps the floor at 8 — below it the estimator biases crown initiation early', () => {
    expect(MIN_RAY_COUNT).toBe(8)
    expect(Math.min(...RAY_COUNTS)).toBe(MIN_RAY_COUNT)
    expect(RAY_COUNTS).toHaveLength(6)
    expect(prelude).toContain(`const MIN_RAY_COUNT: u32 = 8u;`)
  })

  it('sizes the shader register arrays for the largest tier the controller can ask for', () => {
    expect(MAX_RAY_COUNT).toBe(Math.max(...RAY_COUNTS))
    expect(prelude).toContain(`const MAX_RAY_COUNT: u32 = ${MAX_RAY_COUNT}u;`)
    expect(shaders.gather).toContain('array<f32, MAX_RAY_COUNT>')
  })

  it('is monotone across quality levels, so the controller cannot oscillate', () => {
    for (let q = 1; q < RAY_COUNTS.length; q++) {
      expect(RAY_COUNTS[q]!).toBeGreaterThanOrEqual(RAY_COUNTS[q - 1]!)
    }
  })
})

describe('assembly', () => {
  it('produces one entry point per pass and three in the cluster module', () => {
    expect([...shaders.extinction.matchAll(/@compute/g)]).toHaveLength(1)
    expect([...shaders.gather.matchAll(/@compute/g)]).toHaveLength(1)
    expect([...shaders.clusters.matchAll(/@compute/g)]).toHaveLength(3)
    for (const fn of ['fn scatter(', 'fn compact(', 'fn finalise(']) {
      expect(shaders.clusters).toContain(fn)
    }
  })

  it('declares each binding exactly once per assembled module', () => {
    for (const src of [shaders.extinction, shaders.clusters, shaders.gather]) {
      const slots = [...src.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((v) => Number(v[1]))
      expect(new Set(slots).size).toBe(slots.length)
    }
  })

  it('writes the irradiance texture in kW m^-2, which is what keeps it inside f16', () => {
    expect(shaders.gather).toContain('const W_TO_KW: f32 = 0.001;')
    expect(shaders.gather).toContain('g * W_TO_KW')
    expect(shaders.gather).toContain('texture_storage_3d<r16float, write>')
  })

  it('does not carry a temporal blend — the field is written, not accumulated', () => {
    // If this starts failing, layout.ts's TEMPORAL_BLEND_IMPLEMENTED note is stale.
    expect(shaders.gather).not.toContain('blendAlpha')
    expect(shaders.gather).not.toMatch(/var\s+\w+:\s*texture_storage_3d<\w+,\s*read_write>/)
  })

  it('leaves no unresolved prelude identifier in any module', () => {
    // Every SCREAMING_CASE identifier a shader uses must be declared by the prelude or by
    // the shader itself; a typo here is a compile failure that only a device would show.
    for (const [name, src] of Object.entries(shaders)) {
      const code = src.replace(/\/\/[^\n]*/g, '')
      const declared = new Set([...code.matchAll(/const (\w+)\s*:/g)].map((v) => v[1]!))
      const used = new Set([...code.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((v) => v[1]!))
      const missing = [...used].filter((n) => !declared.has(n))
      expect(missing, `${name} uses undeclared ${missing.join(', ')}`).toEqual([])
    }
  })
})
