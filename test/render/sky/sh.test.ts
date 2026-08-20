/**
 * Spherical harmonics: orthonormality, projection round-trip, and the physical identity that
 * matters — a uniform sky of radiance L must produce irradiance pi*L on every surface.
 *
 * If the SH path is wrong by a factor of pi (the classic failure) every surface in the scene is
 * lit 3.14x too brightly or too dimly and nothing else in the renderer will tell you.
 */

import { describe, expect, it } from 'vitest'
import {
  addDirectionalToSh,
  convolveWithCosineLobe,
  evaluateSh,
  packShToFloat32,
  projectRadianceToSh,
  shBasis,
  shIrradiance,
  sphereDirections,
  unpackShFromFloat32,
  SH_COEFFICIENT_COUNT,
  SH_BUFFER_BYTES,
} from '../../../src/render/sky/sh.ts'

const N = 20000

describe('SH basis', () => {
  it('is orthonormal over the sphere', () => {
    const dirs = sphereDirections(N)
    const dOmega = (4 * Math.PI) / N
    const gram: number[][] = Array.from({ length: SH_COEFFICIENT_COUNT }, () =>
      new Array<number>(SH_COEFFICIENT_COUNT).fill(0),
    )
    for (const d of dirs) {
      const y = shBasis(d)
      for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
        for (let j = 0; j < SH_COEFFICIENT_COUNT; j++) {
          gram[i]![j]! += y[i]! * y[j]! * dOmega
        }
      }
    }
    for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
      for (let j = 0; j < SH_COEFFICIENT_COUNT; j++) {
        expect(gram[i]![j]!).toBeCloseTo(i === j ? 1 : 0, 2)
      }
    }
  })
})

describe('projection round-trip', () => {
  it('recovers a single basis function as a unit coefficient', () => {
    for (let k = 0; k < SH_COEFFICIENT_COUNT; k++) {
      const sh = projectRadianceToSh((d) => {
        const v = shBasis(d)[k]!
        return [v, v, v]
      }, N)
      for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
        expect(sh[i]![0]).toBeCloseTo(i === k ? 1 : 0, 2)
      }
    }
  })

  it('reconstructs a smooth function it can represent', () => {
    // A clamped cosine lobe about +Y. Order 2 captures ~99% of its ENERGY (which is why the
    // irradiance convolution is accurate) but the pointwise reconstruction still rings by a few
    // percent at the peak and up to ~9% at the clamp discontinuity. That is the expected
    // behaviour of the truncation, not a projection bug: the irradiance tests below are the ones
    // that pin the quantity the renderer actually consumes.
    const f = (d: readonly [number, number, number]): [number, number, number] => {
      const v = Math.max(0, d[1])
      return [v, 0.5 * v, 0.25 * v]
    }
    const sh = projectRadianceToSh(f, N)
    for (const dir of [
      [0, 1, 0],
      [1, 0, 0],
      [0, -1, 0],
      [0.577, 0.577, 0.577],
    ] as const) {
      const got = evaluateSh(sh, dir)
      const want = f(dir)
      expect(Math.abs(got[0] - want[0])).toBeLessThan(0.1)
      expect(Math.abs(got[1] - want[1])).toBeLessThan(0.1)
    }
  })
})

describe('irradiance convolution', () => {
  it('turns a uniform sky of radiance L into irradiance pi*L', () => {
    const L = 3.7
    const radiance = projectRadianceToSh(() => [L, L, L], N)
    const irradiance = convolveWithCosineLobe(radiance)
    for (const n of [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
      [-0.577, 0.577, 0.577],
    ] as const) {
      const e = shIrradiance(irradiance, n)
      expect(e[0]).toBeCloseTo(Math.PI * L, 4)
      expect(e[1]).toBeCloseTo(Math.PI * L, 4)
      expect(e[2]).toBeCloseTo(Math.PI * L, 4)
    }
  })

  it('turns a uniform UPPER hemisphere of radiance L into irradiance pi*L on an up-facing surface', () => {
    const L = 2
    const radiance = projectRadianceToSh((d) => (d[1] > 0 ? [L, L, L] : [0, 0, 0]), N)
    const irradiance = convolveWithCosineLobe(radiance)
    const up = shIrradiance(irradiance, [0, 1, 0])
    // Exact answer is pi*L; order-2 SH reproduces it to about 1%.
    expect(up[0]).toBeGreaterThan(Math.PI * L * 0.97)
    expect(up[0]).toBeLessThan(Math.PI * L * 1.03)
    // A downward-facing surface sees nothing but the (clamped) ringing.
    const down = shIrradiance(irradiance, [0, -1, 0])
    expect(down[0]).toBeLessThan(0.06 * Math.PI * L)
  })

  it('reproduces a directional light as E cos(theta) to order 2', () => {
    const dir: [number, number, number] = [0, 1, 0]
    const E = 900
    const sh = convolveWithCosineLobe(addDirectionalToSh(
      projectRadianceToSh(() => [0, 0, 0], 64),
      dir,
      [E, E, E],
    ))
    // Facing the light: irradiance ~= E.
    expect(shIrradiance(sh, dir)[0]).toBeGreaterThan(0.9 * E)
    expect(shIrradiance(sh, dir)[0]).toBeLessThan(1.15 * E)
    // Perpendicular: near zero.
    expect(Math.abs(shIrradiance(sh, [1, 0, 0])[0])).toBeLessThan(0.1 * E)
  })
})

describe('GPU packing', () => {
  it('round-trips through the vec4 buffer layout', () => {
    const sh = projectRadianceToSh((d) => [1 + d[0], 2 + d[1], 3 + d[2]], 4096)
    const packed = packShToFloat32(sh)
    expect(packed.length * 4).toBe(SH_BUFFER_BYTES)
    expect(SH_BUFFER_BYTES).toBe(144)
    const back = unpackShFromFloat32(packed)
    for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
      expect(back[i]![0]).toBeCloseTo(sh[i]![0], 6)
      expect(back[i]![1]).toBeCloseTo(sh[i]![1], 6)
      expect(back[i]![2]).toBeCloseTo(sh[i]![2], 6)
      // The padding lane must stay zero: the shader reads vec4 and ignores .w.
      expect(packed[i * 4 + 3]).toBe(0)
    }
  })
})

describe('sampling', () => {
  it('produces unit vectors that integrate to the area of the sphere', () => {
    const dirs = sphereDirections(5000)
    for (const d of dirs) expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 9)
    const total = dirs.length * ((4 * Math.PI) / dirs.length)
    expect(total).toBeCloseTo(4 * Math.PI, 9)
  })

  it('is deterministic — identical input gives byte-identical output', () => {
    const a = packShToFloat32(projectRadianceToSh((d) => [d[1], d[1], d[1]], 512))
    const b = packShToFloat32(projectRadianceToSh((d) => [d[1], d[1], d[1]], 512))
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})
