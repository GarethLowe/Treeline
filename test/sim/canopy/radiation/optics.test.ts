/**
 * WP 3.3 optics against the worked points printed in spec §7.3 and §7.4.
 *
 *   npx vitest run test/sim/canopy/radiation/optics.test.ts
 */

import { describe, expect, it } from 'vitest'
import { K, m, perM } from '@contracts/units'
import { CLUMPING_CONIFER, DEFAULT_FLAME_ABSORPTION, DEFAULT_FLAME_TEMPERATURE_K, STEFAN_BOLTZMANN, absorbedSource, blackbodyEmissivePower, extinctionFromLad, flameEmissivity, greyEmissivity, meanBeamLength, volumeEmitterPower } from '@sim/canopy/radiation/optics.ts'

describe('§7.3 canopy extinction', () => {
  it('reproduces the worked point: LAD 2, clumping 0.6 -> kappa 0.6, eps_v 0.70', () => {
    const kappa = extinctionFromLad(2, CLUMPING_CONIFER)
    expect(kappa).toBeCloseTo(0.6, 12)
    expect(greyEmissivity(kappa, m(2))).toBeCloseTo(0.6988, 4)
  })

  it('is linear in LAD, which is what makes the 4 m downsample exact', () => {
    const a = extinctionFromLad(1.3, 0.7)
    const b = extinctionFromLad(2.9, 0.7)
    expect(extinctionFromLad((1.3 + 2.9) / 2, 0.7)).toBeCloseTo((a + b) / 2, 12)
  })

  it('clamps a negative LAD rather than producing negative extinction', () => {
    expect(extinctionFromLad(-1)).toBe(0)
  })
})

describe('§7.3/§7.4 flame grey body', () => {
  it('uses the CODATA sigma, not the truncated one printed in §7.4', () => {
    expect(STEFAN_BOLTZMANN).toBe(5.670374419e-8)
  })

  it('gives sigma*T^4 = 117.6 kW m^-2 at the 1200 K flame-sheet temperature', () => {
    const e = blackbodyEmissivePower(DEFAULT_FLAME_TEMPERATURE_K)
    expect(e / 1000).toBeCloseTo(117.6, 1)
  })

  it('makes a flame deeper than 3 m effectively black at the default k_f = 0.8', () => {
    expect(DEFAULT_FLAME_ABSORPTION).toBe(0.8)
    expect(flameEmissivity(m(3))).toBeGreaterThan(0.9)
    // ...and a shallow grass flame distinctly grey, which is the whole reason k_f exists.
    expect(flameEmissivity(m(0.3))).toBeLessThan(0.25)
  })
})

describe('volume emission', () => {
  it("uses Hottel's 3.6V/A mean beam length, not the optically thin 4V/A", () => {
    // 2 m cube: V/A = 8/24, so L_m = 1.2 m rather than 1.333 m.
    expect(meanBeamLength(8, 24)).toBeCloseTo(1.2, 12)
  })

  it('reduces to the optically thin limit 4*kappa*sigma*T^4*V when kappa*L_m << 1', () => {
    const kappa = perM(1e-5)
    const T = K(1200)
    const cell = m(2)
    const thin = 4 * kappa * blackbodyEmissivePower(T) * cell ** 3
    // The 3.6 mean beam length is 10% short of 4V/A by construction, which is exactly
    // Hottel's correction; agreement to that factor is the check.
    expect(volumeEmitterPower(kappa, T, cell) / (0.9 * thin)).toBeCloseTo(1, 4)
  })

  it('never exceeds the black-body limit of the enclosing surface', () => {
    const T = K(1200)
    const cell = m(2)
    const limit = blackbodyEmissivePower(T) * 6 * cell * cell
    for (const kappa of [0.1, 0.6, 2, 10, 100]) {
      expect(volumeEmitterPower(perM(kappa), T, cell)).toBeLessThanOrEqual(limit)
    }
  })

  it('gives a fully flaming 2 m conifer voxel ~1.5 MW at LAD 2', () => {
    const p = volumeEmitterPower(extinctionFromLad(2, CLUMPING_CONIFER), K(1200), m(2))
    expect(p / 1e6).toBeGreaterThan(1.3)
    expect(p / 1e6).toBeLessThan(1.8)
  })
})

describe('§7.4 absorbed source', () => {
  it('is signed: a hot voxel in a cold surround radiates away', () => {
    const kappa = perM(0.6)
    expect(absorbedSource(kappa, 0, K(800))).toBeLessThan(0)
    expect(absorbedSource(kappa, 1e6, K(300))).toBeGreaterThan(0)
  })

  it('is zero at radiative equilibrium, G = 4*sigma*T^4', () => {
    const T = K(500)
    expect(absorbedSource(perM(0.6), 4 * blackbodyEmissivePower(T), T)).toBeCloseTo(0, 9)
  })
})
