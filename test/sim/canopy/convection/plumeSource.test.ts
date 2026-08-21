/**
 * The plume's SOURCE conditions, which are derived and must stay derived.
 *
 * `solvePlume` used to start at ground level at a chosen `w0 = 0.1` m/s. Mercer & Weber (1994)
 * is valid above the flaming zone, and starting below it made the half-width collapse by a
 * factor of seven within four metres — which in turn pinned the entire smoke field in its
 * injection layer, because that field samples the plume's vertical velocity through a Gaussian
 * of width `b` and its cells are 4 m across.
 *
 * The failure was silent in every direction that matters: buoyancy flux stayed conserved, the
 * far-field similarity solution stayed correct, the tests stayed green, and the only symptom
 * was smoke that would not rise. So these assert the near field specifically.
 */

import { describe, expect, it } from 'vitest'
import {
  PLUME_LAMBDA,
  buoyancyFluxPerMetre,
  solvePlume,
  buildPlumeLut,
  DEFAULT_CONVECTIVE_FRACTION,
} from '@sim/canopy/convection/plume.ts'
import { flameLength } from '@sim/rothermel/kernel.ts'
import { DEFAULT_FLAME_TEMPERATURE_K } from '@sim/canopy/radiation/optics.ts'
import { kWm, m } from '@contracts/units'

const AMBIENT_K = 293.15
const G = 9.80665

const still = {
  tempK: AMBIENT_K as never,
  density: 1.2,
  potentialTempGradient: 0,
  wind: () => 0,
}
const source = (intensity: number, depth = 4.37) => ({
  intensity: kWm(intensity),
  flameDepth: m(depth),
})

describe('the plume starts above the flaming zone', () => {
  it('starts at the flame tip, not at the ground', () => {
    const i = 8011
    const p = solvePlume(source(i), still, { topM: 1024, steps: 2048 })
    // Byram flame length for this intensity, which is where the integration must begin.
    expect(p.z[0]).toBeCloseTo(flameLength(kWm(i)) as number, 2)
  })

  it('takes its start height from the intensity, so a bigger fire starts higher', () => {
    const weak = solvePlume(source(250), still)
    const strong = solvePlume(source(8011), still)
    expect(strong.z[0]!).toBeGreaterThan(weak.z[0]!)
  })
})

describe('w0 is derived from buoyancy-flux conservation, never chosen', () => {
  // The model conserves g'*w*b = F*k_lambda/(lambda*sqrt(pi)) in a neutral environment. Fixing
  // g'_0 from the flame temperature and b_0 from the flame depth leaves w_0 determined.
  const expectedW0 = (intensity: number, depth: number): number => {
    const B0 = buoyancyFluxPerMetre(kWm(intensity), still, DEFAULT_CONVECTIVE_FRACTION)
    const b0 = Math.max(depth / 2, 0.1)
    const g0 = (G * (DEFAULT_FLAME_TEMPERATURE_K - AMBIENT_K)) / AMBIENT_K
    const kLambda = Math.sqrt(1 + PLUME_LAMBDA * PLUME_LAMBDA)
    return (B0 * kLambda) / (PLUME_LAMBDA * Math.sqrt(Math.PI) * b0 * g0)
  }

  for (const [i, d] of [
    [8011, 4.37],
    [1000, 1],
    [250, 1],
  ] as const) {
    it(`matches the closed form at I = ${i} kW/m`, () => {
      const p = solvePlume(source(i, d), still, { topM: 1024, steps: 2048 })
      expect(p.centrelineVelocity[0]!).toBeCloseTo(expectedW0(i, d), 2)
    })
  }

  it('is nowhere near the 0.1 m/s that used to be hard-coded', () => {
    const p = solvePlume(source(8011, 4.37), still)
    expect(p.centrelineVelocity[0]!).toBeGreaterThan(1)
  })
})

describe('the near field still necks, and by how much is worth pinning', () => {
  const narrowest = (topZ: number): { ratio: number; z: number } => {
    const p = solvePlume(source(8011, 4.37), still, { topM: 1024, steps: 2048 })
    const b0 = p.halfWidth[0]!
    let worst = Infinity
    let worstZ = 0
    for (let i = 0; i < p.z.length; i++) {
      if (p.z[i]! > topZ) break
      if (p.halfWidth[i]! < worst) {
        worst = p.halfWidth[i]!
        worstZ = p.z[i]!
      }
    }
    return { ratio: worst / b0, z: worstZ }
  }

  it('necks less than it did, but still by a factor of about five', () => {
    // Honest bound, and the number it replaces is a caution. The commit that derived the
    // source conditions reported the collapse improving from a factor of 7 to 3.5 — read off
    // LUT ROW 2. The LUT's rows are 4.13 m apart and the minimum sits at 5.9 m, between rows,
    // so the coarse grid stepped straight over it. Measured on the PROFILE the improvement is
    // 7.3x -> 4.7x, which is real but smaller than was claimed.
    //
    // Necking above a flame zone is itself real — pool-fire plumes do it — so this pins the
    // magnitude rather than demanding it vanish. Below 0.18 is the old, unphysical behaviour.
    const { ratio, z } = narrowest(32)
    expect(ratio, `narrowest b/b0 = ${ratio.toFixed(3)} at z = ${z.toFixed(1)} m`).toBeGreaterThan(0.18)
    expect(ratio).toBeLessThan(0.45)
  })

  it('puts the neck above the flame tip, where necking is a real phenomenon', () => {
    const { z } = narrowest(32)
    expect(z).toBeGreaterThan(flameLength(kWm(8011)) as number)
  })

  it('the LUT consumers actually sample never shows the collapse', () => {
    // Not a reassurance — a warning. Everything downstream reads `buildPlumeLut`, whose 32
    // rows over 128 m cannot resolve a 1 m dip, so the field consumers see is smoother than
    // the profile. Anyone diagnosing the near field from LUT rows will conclude it is fine.
    const p = solvePlume(source(8011, 4.37), still, { topM: 1024, steps: 2048 })
    const lut = buildPlumeLut(p)
    let lutMin = Infinity
    for (let r = 0; r < 8; r++) lutMin = Math.min(lutMin, lut[r * 4 + 2]!)
    const { ratio } = narrowest(32)
    expect(lutMin / p.halfWidth[0]!).toBeGreaterThan(ratio)
  })
})

describe('buoyancy flux is still conserved, which is what says the ODE was not traded away', () => {
  it('holds g′wb constant in a neutral environment', () => {
    const p = solvePlume(source(8011, 4.37), still, { topM: 1024, steps: 2048 })
    const at = (z: number): number => {
      let best = 0
      for (let i = 1; i < p.z.length; i++) {
        if (Math.abs(p.z[i]! - z) < Math.abs(p.z[best]! - z)) best = i
      }
      return p.centrelineBuoyancy[best]! * p.centrelineVelocity[best]! * p.halfWidth[best]!
    }
    const ref = at(8)
    for (const z of [8, 16, 32, 64, 128]) {
      expect(at(z) / ref, `g'wb ratio at ${z} m`).toBeCloseTo(1, 2)
    }
  })
})
