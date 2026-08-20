/**
 * The WGSL half of WP 3.4 cannot be executed on the CLI, so the next best thing is asserted
 * here: that every number and every structural constant in
 * `shaders/sim/canopy/convection/convection.wgsl` matches its TypeScript oracle.
 *
 * M1 shipped four bugs that only appeared on a device. Three of the four were a constant or a
 * layout that drifted between the CPU and GPU copies of the same model — exactly what this
 * file makes impossible. It is a text check, not a semantic one; it cannot prove the shader
 * computes the right thing, only that it is not computing it from different numbers.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CB_COEFF_PR070,
  PR_AIR,
  nusseltChurchillBernstein,
} from '@sim/canopy/convection/heatTransfer.ts'
import {
  PLUME_LAMBDA,
  PLUME_LUT_FLOATS_PER_ROW,
  PLUME_LUT_ROWS,
  PLUME_LUT_TOP_M,
} from '@sim/canopy/convection/plume.ts'
import { CONVECTION_BIND_GROUP, PLUME_UNIFORM_BYTES, packPlumeUniforms } from '@sim/canopy/convection/plume.ts'

const wgsl = readFileSync(
  fileURLToPath(new URL('../../../../shaders/sim/canopy/convection/convection.wgsl', import.meta.url)),
  'utf8',
)

/** Comments talk *about* the trap constants; only code must be free of them. */
const wgslCode = wgsl.replace(/\/\/.*$/gm, '')

/** `const NAME : f32 = 1.234;` -> 1.234 */
function wgslConst(name: string): number {
  const match = new RegExp(`const\\s+${name}\\s*:\\s*f32\\s*=\\s*([-0-9.eE+]+)\\s*;`).exec(wgsl)
  if (!match?.[1]) throw new Error(`no const ${name} in convection.wgsl`)
  return Number(match[1])
}

describe('WGSL constants mirror the TypeScript oracle', () => {
  it('carries the same plume LUT geometry', () => {
    expect(wgslConst('PLUME_LUT_ROWS')).toBe(PLUME_LUT_ROWS)
    expect(wgslConst('PLUME_LUT_TOP_M')).toBe(PLUME_LUT_TOP_M)
    // The uniform array must be declared at the same length as the LUT the CPU packs.
    expect(wgsl).toContain(`array<vec4<f32>, ${PLUME_LUT_ROWS}>`)
  })

  it('carries lambda = 1.2, and does NOT carry alpha_e at all', () => {
    expect(wgslConst('PLUME_LAMBDA')).toBe(PLUME_LAMBDA)
    // alpha_e lives only in the CPU ODE solve. Keeping it out of the shader removes the one
    // place where someone could write the top-hat 0.16 into a Gaussian formulation (§7.5 trap).
    expect(wgslCode).not.toMatch(/alpha/i)
    expect(wgslCode).not.toContain('0.16')
  })

  it('carries the same Sutherland air constants', () => {
    expect(wgslConst('MU_REF')).toBe(1.716e-5)
    expect(wgslConst('T_REF')).toBe(273.15)
    expect(wgslConst('S_MU')).toBe(110.4)
    expect(wgslConst('K_REF')).toBe(0.0241)
    expect(wgslConst('S_K')).toBe(194)
    expect(wgslConst('R_AIR')).toBe(287.05)
    expect(wgslConst('P_ATM')).toBe(101325)
  })

  it('carries the folded Churchill-Bernstein Pr coefficient to f32 precision', () => {
    expect(wgslConst('CB_COEFF_PR070')).toBeCloseTo(CB_COEFF_PR070, 7)
    // And that the folded constant really is C&B at Pr = 0.70, not something transcribed.
    const re = 3600
    const fromWgslConst =
      0.3 + wgslConst('CB_COEFF_PR070') * Math.sqrt(re) * (1 + (re / 282000) ** 0.625) ** 0.8
    expect(fromWgslConst).toBeCloseTo(nusseltChurchillBernstein(re, PR_AIR), 5)
  })

  it('keeps the high-Re bracket that the TypeScript keeps', () => {
    expect(wgsl).toContain('282000.0')
    expect(wgsl).toContain('0.625')
  })

  it('declares the bind group index the TypeScript advertises', () => {
    expect(wgsl).toContain(`@group(${CONVECTION_BIND_GROUP}) @binding(0)`)
  })

  it('uses lambda*b for the temperature profile and b for the velocity profile', () => {
    // The other half of the convention error lambda exists to prevent. Order matters: the
    // velocity Gaussian must NOT carry lambda and the temperature one must.
    expect(wgsl).toContain('let gaussV = exp(-s2 / (b * b));')
    expect(wgsl).toContain('let gaussT = exp(-s2 / (PLUME_LAMBDA * PLUME_LAMBDA * b * b));')
  })

  it('applies A_v = 2*LAD', () => {
    expect(wgsl).toContain('h * 2.0 * leafAreaDensity * (gasTempK - solidTempK)')
  })
})

describe('uniform packing matches the WGSL struct', () => {
  it('is 32 vec4 rows plus params plus axis, 16-byte aligned', () => {
    expect(PLUME_UNIFORM_BYTES).toBe((PLUME_LUT_ROWS + 2) * PLUME_LUT_FLOATS_PER_ROW * 4)
    expect(PLUME_UNIFORM_BYTES % 16).toBe(0)
  })

  it('puts each field where the shader reads it', () => {
    const lut = new Float32Array(PLUME_LUT_ROWS * PLUME_LUT_FLOATS_PER_ROW).fill(7)
    const packed = packPlumeUniforms({
      lut,
      sourceX: 11,
      sourceZ: 22,
      sourceGroundY: 33,
      windSpeed: 4.4,
      ambientTempK: 301,
      windDirX: 0.6,
      windDirZ: 0.8,
    })
    const o = PLUME_LUT_ROWS * PLUME_LUT_FLOATS_PER_ROW
    expect(packed.length).toBe(PLUME_UNIFORM_BYTES / 4)
    expect(Array.from(packed.subarray(0, o))).toEqual(Array.from(lut))
    // params = vec4(sourceX, sourceZ, windSpeed, ambientTempK) — plumeGasState reads .z and .w
    expect(packed[o]).toBe(11)
    expect(packed[o + 1]).toBe(22)
    expect(packed[o + 2]).toBeCloseTo(4.4, 5)
    expect(packed[o + 3]).toBe(301)
    // axis = vec4(windDirX, windDirZ, sourceGroundY, 0)
    expect(packed[o + 4]).toBeCloseTo(0.6, 5)
    expect(packed[o + 5]).toBeCloseTo(0.8, 5)
    expect(packed[o + 6]).toBe(33)
  })
})
