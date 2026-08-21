/**
 * WP 3.4 acceptance: "plume tilt responds correctly to wind".
 *
 * Plus the thing spec §7.5 makes mandatory and calls "the real defence against a convention
 * error": the convention-independent observables of Richardson & Hunt (2022) §3, asserted to
 * ±5 % against the SOLVED field.
 *
 * The regression only means anything because `solvePlume` starts from a NON-similar initial
 * condition — buoyancy with essentially no momentum — and has to generate the similarity
 * solution itself. Seeding it with the analytic answer would make this file an echo.
 */

import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../perfBudget.ts'
import { K, kWm, m } from '@contracts/units'
import {
  ALPHA_E_GAUSSIAN_LINE,
  ALPHA_E_HARD_BOUNDS,
  ALPHA_E_SOFT_BOUNDS,
  PLUME_LAMBDA,
  PLUME_LUT_ROWS,
  PLUME_LUT_TOP_M,
  assertGaussianAlpha,
  buildPlumeLut,
  buoyancyFluxPerMetre,
  samplePlumeLut,
  similarityCoefficients,
  solvePlume,
  topHatAlpha,
} from '@sim/canopy/convection/plume.ts'
import type { PlumeEnvironment, PlumeProfile } from '@sim/canopy/convection/plume.ts'

const still: PlumeEnvironment = {
  tempK: K(300),
  density: 1.2,
  potentialTempGradient: 0,
  wind: () => 0,
}

const windy = (u: number): PlumeEnvironment => ({ ...still, wind: () => u })

const stable = (dThetaDz: number): PlumeEnvironment => ({
  ...still,
  potentialTempGradient: dThetaDz,
})

const source = (intensityKwPerM: number, flameDepthM = 1) => ({
  intensity: kWm(intensityKwPerM),
  flameDepth: m(flameDepthM),
})

/** Nearest-sample lookup; the log grid is dense enough that this is exact to well under 1 %. */
function at(profile: PlumeProfile, zTarget: number): number {
  let best = 0
  for (let i = 1; i < profile.z.length; i++) {
    if (Math.abs(profile.z[i]! - zTarget) < Math.abs(profile.z[best]! - zTarget)) best = i
  }
  return best
}

// ---------------------------------------------------------------------------

describe('the normative constant and the convention it lives in (spec §7.5)', () => {
  it('is the Gaussian line-plume value 0.11 with lambda fixed at 1.2', () => {
    expect(ALPHA_E_GAUSSIAN_LINE).toBe(0.11)
    expect(PLUME_LAMBDA).toBe(1.2)
    expect(ALPHA_E_SOFT_BOUNDS).toEqual({ min: 0.095, max: 0.13 })
    expect(ALPHA_E_HARD_BOUNDS).toEqual({ min: 0.09, max: 0.14 })
  })

  it('converts to top-hat with the lambda=1.2 factor 1.486, not the lambda=1 sqrt(2)', () => {
    expect(topHatAlpha(1, PLUME_LAMBDA)).toBeCloseTo(1.4863, 3)
    expect(topHatAlpha(ALPHA_E_GAUSSIAN_LINE)).toBeCloseTo(0.1635, 4)
    // The sqrt(2) simplification is 5 % low and would be the wrong top-hat coefficient.
    expect(topHatAlpha(1, 1.0)).toBeCloseTo(Math.SQRT2, 6)
  })

  /**
   * The §7.5 NUMERICAL TRAP. 0.16 is simultaneously the correct top-hat value and the rejected
   * Rouse et al. (1952) Gaussian value; putting it in the Gaussian slot is a 41 % error that
   * does not look wrong in any output.
   */
  it('refuses a top-hat coefficient in the Gaussian slot', () => {
    expect(() => assertGaussianAlpha(0.16)).toThrow(/TOP-HAT|top-hat/)
    expect(() => assertGaussianAlpha(topHatAlpha(ALPHA_E_GAUSSIAN_LINE))).toThrow()
    expect(() => assertGaussianAlpha(0.08)).toThrow() // the old, refuted lower bound
    expect(() => assertGaussianAlpha(ALPHA_E_GAUSSIAN_LINE)).not.toThrow()
    expect(() => assertGaussianAlpha(0.13)).not.toThrow() // Lee & Emmons, fire-driven
  })

  it('reproduces the published similarity coefficients from alpha and lambda alone', () => {
    const c = similarityCoefficients()
    expect(c.cb).toBeCloseTo(0.1241, 4) // b = 0.1241 z
    expect(c.cb * PLUME_LAMBDA).toBeCloseTo(0.1489, 4) // lambda b = 0.1489 z
    expect(c.cw).toBeCloseTo(2.157, 3) // w_c = 2.157 B^(1/3)
    expect(c.cg).toBeCloseTo(2.743, 2) // g'_c = 2.743 B^(2/3) / z
    expect(c.cq).toBeCloseTo(0.4746, 4) // Q = 0.4746 B^(1/3) z
  })

  it('would land on visibly different coefficients under a sqrt(2) convention slip', () => {
    // A top-hat alpha wrongly used as a Gaussian one. This is what the CI regression catches.
    const slipped = similarityCoefficients(topHatAlpha(ALPHA_E_GAUSSIAN_LINE))
    expect(slipped.cb / similarityCoefficients().cb).toBeCloseTo(1.486, 2)
    expect(slipped.cw / similarityCoefficients().cw).toBeCloseTo(1.486 ** (-1 / 3), 2)
  })
})

// ---------------------------------------------------------------------------

describe('MANDATORY CI REGRESSION — convention-independent observables to ±5 % (spec §7.5)', () => {
  const c = similarityCoefficients()

  // 1000 kW/m is a vigorous surface fire; 1 m flame depth is a plausible flaming zone.
  const profile = solvePlume(source(1000), still, { topM: 1024, steps: 2048 })
  const B13 = Math.cbrt(profile.buoyancyFlux0)
  const B23 = profile.buoyancyFlux0 ** (2 / 3)

  // Far enough above the source that the lazy start has relaxed onto the plume attractor.
  // 32 m is one quarter of the canopy column, so the whole canopy sits inside the tested band
  // apart from the bottom few metres, where the profile is honestly a clamp (see plume.ts).
  const heights = [32, 64, 128, 256, 512]

  /** The +/-5 % of spec §7.5, stated as a ratio so a failure prints the actual deviation. */
  const within5pc = (label: string, ratio: number): void => {
    expect(Math.abs(ratio - 1), `${label} = ${ratio.toFixed(4)}`).toBeLessThan(0.05)
  }

  for (const z of heights) {
    it(`holds at z = ${z} m`, () => {
      const i = at(profile, z)
      const zi = profile.z[i]!
      within5pc('b/0.1241z', profile.halfWidth[i]! / (c.cb * zi))
      within5pc('w_c/2.157B^1/3', profile.centrelineVelocity[i]! / (c.cw * B13))
      within5pc("g'_c/2.743B^2/3z^-1", profile.centrelineBuoyancy[i]! / ((c.cg * B23) / zi))
      within5pc('Q/0.4746B^1/3z', profile.volumeFlux[i]! / (c.cq * B13 * zi))
      // lambda b is the buoyancy half-width; it is not independent, but it is the number the
      // spec prints, so assert it as printed.
      within5pc('lambda b/0.1489z', (PLUME_LAMBDA * profile.halfWidth[i]!) / (0.1489 * zi))
    })
  }

  it('converges from a forced (jet-like) start as well as a lazy one', () => {
    // Same source but with a wide initial condition: 8 m flame depth.
    const forced = solvePlume(source(1000, 8), still, { topM: 1024, steps: 2048 })
    const i = at(forced, 512)
    const zi = forced.z[i]!
    within5pc('b/0.1241z', forced.halfWidth[i]! / (c.cb * zi))
    within5pc(
      'w_c/2.157B^1/3',
      forced.centrelineVelocity[i]! / (c.cw * Math.cbrt(forced.buoyancyFlux0)),
    )
  })

  it('scales the centreline excess temperature as I^(2/3) z^-1, per §7.5', () => {
    const weak = solvePlume(source(250), still, { topM: 1024, steps: 2048 })
    const strong = solvePlume(source(2000), still, { topM: 1024, steps: 2048 })
    // EACH profile's own index for 256 m. These two no longer share a z-grid: the integration
    // starts at the flame tip and Byram flame length depends on intensity, so an 8x intensity
    // ratio starts the strong plume 2.56 m up and the weak one 0.98 m up, on log grids with
    // different origins. Taking one index from `weak` and using it on `strong` — which is what
    // this test did while both started at flameDepth/2 — silently compares 256 m in one plume
    // against a different height in the other, and reads as a broken scaling law.
    const iWeak = at(weak, 256)
    const iStrong = at(strong, 256)
    // dT ~ B^(2/3) ~ I^(2/3); (2000/250)^(2/3) = 4
    expect(
      strong.centrelineExcessTempK[iStrong]! / weak.centrelineExcessTempK[iWeak]!,
    ).toBeCloseTo(4, 1)
    // dT ~ 1/z
    const j = at(weak, 512)
    expect(weak.centrelineExcessTempK[iWeak]! / weak.centrelineExcessTempK[j]!).toBeCloseTo(2, 1)
  })
})

// ---------------------------------------------------------------------------

describe('plume tilt responds correctly to wind (WP 3.4 acceptance)', () => {
  it('is vertical in still air', () => {
    const p = solvePlume(source(1000), still)
    for (let i = 0; i < p.z.length; i++) expect(p.tiltX[i]!).toBe(0)
  })

  it('leans downwind by u/w_c per unit height, the trajectory closure', () => {
    const u = 4
    const p = solvePlume(source(1000), windy(u), { topM: 1024, steps: 2048 })
    const i = at(p, 200)
    const j = at(p, 400)
    const slope = (p.tiltX[j]! - p.tiltX[i]!) / (p.z[j]! - p.z[i]!)
    // w_c is constant with height in a neutral plume, so the trajectory is a straight line.
    expect(slope).toBeCloseTo(u / p.centrelineVelocity[i]!, 2)
  })

  it('leans further as wind rises and less as fire intensity rises', () => {
    const tiltAt = (u: number, intensity: number): number => {
      const p = solvePlume(source(intensity), windy(u), { topM: 256, steps: 1024 })
      return p.tiltX[at(p, 128)]!
    }
    expect(tiltAt(8, 1000)).toBeGreaterThan(tiltAt(4, 1000))
    expect(tiltAt(4, 1000)).toBeGreaterThan(tiltAt(0, 1000))
    // Stronger fire -> faster plume -> less time in the crosswind per metre of rise.
    expect(tiltAt(4, 4000)).toBeLessThan(tiltAt(4, 1000))
    // w_c ~ I^(1/3), so tilt ~ I^(-1/3): a 8x intensity should roughly halve the tilt.
    expect(tiltAt(4, 8000) / tiltAt(4, 1000)).toBeCloseTo(0.5, 1)
  })

  it('delivers hot gas downwind rather than overhead — the point of the tilt', () => {
    const p = solvePlume(source(1000), windy(6), { topM: 256, steps: 1024 })
    const lut = buildPlumeLut(p)
    const cfg = { ambientTempK: 300, windSpeed: 6 }
    const canopyTop = 20
    const xTilt = p.tiltX[at(p, canopyTop)]!
    expect(xTilt).toBeGreaterThan(5)
    // Hottest gas at canopy height is downwind of the fire, not above it.
    const overFire = samplePlumeLut(lut, canopyTop, 0, cfg).gasTempK
    const downwind = samplePlumeLut(lut, canopyTop, xTilt, cfg).gasTempK
    expect(downwind).toBeGreaterThan(overFire)
  })
})

// ---------------------------------------------------------------------------

describe('atmospheric stability stops the plume (spec §7.5, §6.4)', () => {
  it('does not level off in a neutral atmosphere', () => {
    expect(solvePlume(source(1000), still, { topM: 2048 }).levelOffHeight).toBe(Infinity)
  })

  it('levels off in a stable layer, and scales as B^(1/3) / N', () => {
    // Pasquill E (dtheta/dz = 0.02) and a 4x-stronger gradient.
    const e = solvePlume(source(1000), stable(0.02), { topM: 4096, steps: 4096 })
    const e4 = solvePlume(source(1000), stable(0.08), { topM: 4096, steps: 4096 })
    const strong = solvePlume(source(8000), stable(0.02), { topM: 4096, steps: 4096 })

    expect(e.levelOffHeight).toBeLessThan(4096)
    expect(e.levelOffHeight).toBeGreaterThan(50)
    // z_max ~ B^(1/3) N^-1. N ~ sqrt(dtheta/dz), so 4x gradient -> 2x N -> half the height.
    expect(e4.levelOffHeight / e.levelOffHeight).toBeCloseTo(0.5, 1)
    // 8x buoyancy flux -> 2x height.
    expect(strong.levelOffHeight / e.levelOffHeight).toBeCloseTo(2, 1)
  })

  it('stays finite when the plume stalls inside the LUT range', () => {
    // A weak fire under a strong inversion levels off at ~60 m, well inside the 128 m LUT.
    // Everything here ends up in a GPU uniform, so Infinity is not an acceptable answer.
    const p = solvePlume(source(100), stable(0.08), { topM: 512, steps: 2048 })
    expect(p.levelOffHeight).toBeLessThan(PLUME_LUT_TOP_M)
    const lut = buildPlumeLut(p)
    expect(lut.every((v) => Number.isFinite(v))).toBe(true)
    const cfg = { ambientTempK: 300, windSpeed: 2 }
    const above = samplePlumeLut(lut, PLUME_LUT_TOP_M - 1, 0, cfg)
    expect(Number.isFinite(above.gasTempK)).toBe(true)
    expect(Number.isFinite(above.gasSpeed)).toBe(true)
  })

  it('reports no gas above the level-off height rather than NaN', () => {
    const p = solvePlume(source(1000), stable(0.035), { topM: 4096, steps: 4096 })
    const above = at(p, p.levelOffHeight * 2)
    expect(Number.isFinite(p.centrelineExcessTempK[above]!)).toBe(true)
    expect(p.centrelineExcessTempK[above]!).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------

describe('source strength and the near-source clamp', () => {
  it('computes buoyancy flux per unit LINE length, m3 s-3 (not §6.4 F_b, m4 s-3)', () => {
    const b = buoyancyFluxPerMetre(kWm(1000), still, 0.6)
    // g·chi·I/(rho·cp·Ta) = 9.81·0.6·1e6/(1.2·1005·300)
    expect(b).toBeCloseTo((9.81 * 0.6 * 1e6) / (1.2 * 1005 * 300), 6)
    expect(b).toBeCloseTo(16.27, 1)
    expect(buoyancyFluxPerMetre(kWm(2000), still, 0.6) / b).toBeCloseTo(2, 6)
  })

  it('clamps the singular near-source excess temperature to the flame-sheet value', () => {
    const p = solvePlume(source(5000, 0.2), still, { topM: 256, steps: 2048 })
    for (let i = 0; i < p.z.length; i++) expect(p.centrelineExcessTempK[i]!).toBeLessThanOrEqual(900)
    expect(p.centrelineExcessTempK[0]!).toBeCloseTo(900, 6) // clamped at the source
  })
})

// ---------------------------------------------------------------------------

describe('the GPU lookup table', () => {
  const p = solvePlume(source(1000), windy(3), { topM: 256, steps: 1024 })
  const lut = buildPlumeLut(p)

  it('is 32 rows of 4 covering 0-128 m, the canopy column height', () => {
    expect(lut.length).toBe(PLUME_LUT_ROWS * 4)
    expect(PLUME_LUT_TOP_M).toBe(128)
    expect(lut.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('reproduces the solved profile at its own nodes to 2 %', () => {
    const dz = PLUME_LUT_TOP_M / (PLUME_LUT_ROWS - 1)
    for (let row = 1; row < PLUME_LUT_ROWS; row++) {
      const z = row * dz
      const i = at(p, z)
      expect(Math.abs(lut[row * 4]! / p.centrelineExcessTempK[i]! - 1)).toBeLessThan(0.02)
      expect(Math.abs(lut[row * 4 + 1]! / p.centrelineVelocity[i]! - 1)).toBeLessThan(0.02)
      expect(Math.abs(lut[row * 4 + 2]! / p.halfWidth[i]! - 1)).toBeLessThan(0.02)
    }
  })

  it('uses lambda*b for temperature and b for velocity — the two profiles differ in width', () => {
    const cfg = { ambientTempK: 300, windSpeed: 0 }
    // Sample exactly on a LUT node so `b` and `xTilt` are the row's own values, not a blend.
    const row = 16
    const zTest = (row * PLUME_LUT_TOP_M) / (PLUME_LUT_ROWS - 1)
    const b = lut[row * 4 + 2]!
    const xTilt = lut[row * 4 + 3]!
    const centre = samplePlumeLut(lut, zTest, xTilt, cfg)
    const edge = samplePlumeLut(lut, zTest, xTilt + b, cfg)
    // At |s| = b: velocity has fallen by e^-1, temperature only by e^(-1/lambda^2).
    const dTcentre = centre.gasTempK - 300
    const dTedge = edge.gasTempK - 300
    expect(dTedge / dTcentre).toBeCloseTo(Math.exp(-1 / (PLUME_LAMBDA * PLUME_LAMBDA)), 3)
    expect(dTedge / dTcentre).toBeGreaterThan(Math.exp(-1)) // wider than the velocity profile
  })

  it('returns ambient outside the plume and above the LUT', () => {
    const cfg = { ambientTempK: 300, windSpeed: 3 }
    expect(samplePlumeLut(lut, 64, 500, cfg).gasTempK).toBeCloseTo(300, 6)
    expect(samplePlumeLut(lut, 400, 0, cfg).gasTempK).toBe(300)
    expect(samplePlumeLut(lut, 400, 0, cfg).gasSpeed).toBeCloseTo(3, 6)
  })
})

// ---------------------------------------------------------------------------

describe('cost', () => {
  /**
   * §0.5.1 says measure, do not predict. This is the number quoted in `PLUME_LUT_UPDATE_HZ`.
   * It is a floor, not a guarantee — a CI runner is slower than the target i9 — which is fine,
   * because the claim being defended is "unmeasurably cheap", and a floor proves that.
   */
  it('rebuilds the whole field in well under 100 us', () => {
    const src = source(1000)
    const env = windy(4)
    const reps = 2000
    // Warm up so the JIT is not what is being timed.
    for (let i = 0; i < 200; i++) buildPlumeLut(solvePlume(src, env, { topM: 512, steps: 512 }))
    const t0 = performance.now()
    for (let i = 0; i < reps; i++) buildPlumeLut(solvePlume(src, env, { topM: 512, steps: 512 }))
    const us = ((performance.now() - t0) / reps) * 1000
    expectWithinBudget('plume solve + LUT build', us, 100, 'us')
  })
})
