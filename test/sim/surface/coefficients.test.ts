/**
 * The fuel coefficient LUT: packing, cure interpolation, and the invariants the shader
 * relies on to stay branch-free.
 *
 *   npx vitest run test/sim/surface/coefficients.test.ts
 */

import { describe, expect, it } from 'vitest'
import {
  COEFF_BYTES,
  COEFF_FLOATS,
  CURE_BINS,
  buildCoefficientLut,
  lutIndex,
  sampleLut,
} from '@sim/surface/coefficients'
import { FUEL_MODELS as STUB_FUEL_TABLE, NON_BURNABLE_ID } from '@sim/rothermel/fuelModels.ts'
import { buildCoefficients, kernel } from '@sim/surface/rothermel'
import type { MoistureVector } from '@sim/surface/rothermel'

const lut = buildCoefficientLut(STUB_FUEL_TABLE)
const M: MoistureVector = [0.06, 0.07, 0.08, 0.6, 1.2]

describe('LUT shape', () => {
  it('is 128 B per record, one record per (model, cure bin), plus a non-burnable row', () => {
    expect(COEFF_FLOATS).toBe(32)
    expect(COEFF_BYTES).toBe(128)
    expect(lut.order[NON_BURNABLE_ID]).toBe('<non-burnable>')
    expect(lut.recordCount).toBe((STUB_FUEL_TABLE.codes.length + 1) * CURE_BINS)
    expect(lut.data.byteLength).toBe(lut.recordCount * COEFF_BYTES)
  })

  it('stays well inside a storage buffer even at the full 53-model table', () => {
    const full = (53 + 1) * CURE_BINS * COEFF_BYTES
    expect(full).toBeLessThan(128 * 1024) // ~108 KB
    // ...and confirms why it is NOT a uniform buffer: the default cap is 64 KiB.
    expect(full).toBeGreaterThan(64 * 1024)
  })

  it('makes fuel model 0 inert, so a zeroed grid does not spontaneously become grassland', () => {
    const c = sampleLut(lut, NON_BURNABLE_ID, 0.5)
    expect(kernel(c, M, 1000, 0.2).rateOfSpread).toBe(0)
  })
})

describe('cure interpolation — the shader mirror', () => {
  it('is exact at bin centres for every model', () => {
    for (let id = 1; id < lut.order.length; id++) {
      const fuel = STUB_FUEL_TABLE.get(lut.order[id]!)
      for (let bin = 0; bin < CURE_BINS; bin++) {
        const cure = bin / (CURE_BINS - 1)
        const direct = buildCoefficients(fuel, cure)
        const viaLut = sampleLut(lut, id, cure)
        expect(viaLut.gammaEtaS).toBeCloseTo(direct.gammaEtaS, 9)
        expect(viaLut.windC).toBeCloseTo(direct.windC, 12)
        expect(viaLut.savFt).toBeCloseTo(direct.savFt, 6)
      }
    }
  })

  it('is flat across cure for static models, which is what removes the branch', () => {
    for (let id = 1; id < lut.order.length; id++) {
      const fuel = STUB_FUEL_TABLE.get(lut.order[id]!)
      if (fuel.type !== 'static') continue
      const a = lut.records[lutIndex(id, 0)]!
      const b = lut.records[lutIndex(id, CURE_BINS - 1)]!
      expect(b.gammaEtaS).toBeCloseTo(a.gammaEtaS, 12)
      expect(b.savFt).toBeCloseTo(a.savFt, 12)
    }
  })

  it('interpolates dynamic models to within 1% of the exact recomputation', () => {
    // 16 bins is only worth having if the lerp error is below the noise in the cure estimate
    // itself. Checked at the worst place: off-bin cure on the most dynamic model.
    const id = lut.order.indexOf('GR2')
    const fuel = STUB_FUEL_TABLE.get('GR2')
    for (const cure of [0.03, 0.17, 0.42, 0.667, 0.91]) {
      const exact = kernel(buildCoefficients(fuel, cure), M, 440, 0)
      const lerped = kernel(sampleLut(lut, id, cure), M, 440, 0)
      expect(lerped.rateOfSpread).toBeCloseTo(exact.rateOfSpread, 1)
      const rel = Math.abs(lerped.rateOfSpread - exact.rateOfSpread) / exact.rateOfSpread
      expect(rel).toBeLessThan(0.01)
    }
  })
})

describe('packing', () => {
  it('lands every field where common.wgsl expects it', () => {
    const id = lut.order.indexOf('GR2')
    const bin = 10
    const c = lut.records[lutIndex(id, bin)]!
    const at = lutIndex(id, bin) * COEFF_FLOATS
    const d = lut.data
    // The table is Float32Array, so equality is to f32 precision (~1e-7 relative), not f64.
    const rel = (got: number, want: number) =>
      want === 0 ? expect(got).toBe(0) : expect(Math.abs(got / want - 1)).toBeLessThan(1e-6)
    rel(d[at + 0]!, c.gammaEtaS) // v0.x
    rel(d[at + 3]!, c.xiOverRhoB) // v0.w
    rel(d[at + 8]!, c.kHeat[4]) // v2.x (GR2 has no woody load, so this is 0)
    rel(d[at + 10]!, c.mxDead) // v2.z
    rel(d[at + 12]!, c.fDead[0]) // v3.x
    rel(d[at + 15]!, c.fLive[0]) // v3.w
    rel(d[at + 20]!, c.windC) // v5.x
    rel(d[at + 23]!, c.slopeK) // v5.w
    rel(d[at + 24]!, c.residenceSeconds) // v6.x
  })

  it('emits no NaN or Infinity anywhere in the table', () => {
    for (let i = 0; i < lut.data.length; i++) expect(Number.isFinite(lut.data[i]!)).toBe(true)
  })
})
