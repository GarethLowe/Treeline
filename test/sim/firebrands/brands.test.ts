/**
 * WP 3.6 physics. The three acceptance clauses that live here: brands conserve mass, the
 * burnout criterion behaves, and ignition probability is bounded [0,1]. The fourth (spot
 * distances inside the Albini envelope) is in `albini.test.ts`.
 *
 * The first four tests are the ones that matter most, because they are the traps §2.1 and §2.2
 * spent two open questions closing: the half-thickness convention, the shape branch in σ, the
 * reference area for C_D, and the −2 power law having no defined mean.
 */

import { describe, expect, it } from 'vitest'
import { moistureFraction } from '@contracts/units'
import {
  AIR_DENSITY,
  BRAND_BULK_DENSITY,
  BRAND_CLASSES,
  DEFAULT_IGNITION_COEFFS,
  GLOW_MASS_FRACTION,
  GRAVITY,
  SHAPES,
  arealDensity,
  beta0For,
  brandClassForSpecies,
  brandMass,
  dragRelaxationTime,
  equivalentDiameter,
  flightParamsFor,
  halfThicknessForTerminalVelocity,
  hash01,
  ignitionProbability,
  meanProjectedArea,
  oneMinusExp,
  sampleProjectedArea,
  spawnCount,
  ignitedPatchArea,
  stepBrand,
  stillGlowing,
  terminalVelocity,
} from '@sim/firebrands/brands.ts'
import type { BrandClass, BrandState, Vec3 } from '@sim/firebrands/brands.ts'

const still = (): Vec3 => [0, 0, 0]

function spawn(c: BrandClass, massKg: number): BrandState {
  const sigma = arealDensity(c.shape, c.halfThk)
  return {
    pos: [0, 0, 100],
    vel: [0, 0, 0],
    halfThk: c.halfThk,
    massFrac: 1,
    areaEq: equivalentDiameter(massKg / sigma),
    weight: 1,
    age: 0,
    shape: c.shape,
  }
}

// ---------------------------------------------------------------------------

describe('areal density and terminal velocity (§2.1, §2.2)', () => {
  it('reproduces every tabulated v_t from the half-thickness', () => {
    const vt = (id: keyof typeof BRAND_CLASSES): number => {
      const c = BRAND_CLASSES[id]
      return terminalVelocity(c.shape, c.halfThk)
    }
    // Eucalypt: Hall et al. 2015 measured 5.4 / 5.2 / 5.8 m/s and delta was SOLVED from them.
    expect(vt('eucalypt-plate')).toBeCloseTo(5.4, 2)
    expect(vt('eucalypt-cylinder')).toBeCloseTo(5.2, 2)
    expect(vt('eucalypt-ribbon')).toBeCloseTo(5.8, 2)
    // Conifer: Manzello's 4 mm Douglas-fir cylinder at rho_p = 360.
    //
    // NOTE — the spec's §2.1 table quotes 6.1 m/s for d = 4 mm. That is a transcription slip:
    // v_t scales as sqrt(d), and the d = 3 mm and d = 5 mm entries (5.4 and 7.0) both reproduce
    // exactly, so the middle entry must be 5.43*sqrt(4/3) = 6.27. Asserting the arithmetic
    // rather than the printed digit is the whole point of having this test.
    expect(vt('conifer-cylinder')).toBeCloseTo(6.27, 2)
    expect(arealDensity('cylinder', 0.0015)).toBeCloseTo(0.85, 2)
    expect(arealDensity('cylinder', 0.0025)).toBeCloseTo(1.41, 2)
  })

  it('branches sigma on shape — the 4/pi trap', () => {
    // Applying the plate form to a cylinder overstates sigma by 4/pi and v_t by sqrt(4/pi).
    const d = 0.002
    expect(arealDensity('plate', d) / arealDensity('cylinder', d)).toBeCloseTo(4 / Math.PI, 6)
    expect(terminalVelocity('plate', d) / terminalVelocity('cylinder', d)).toBeCloseTo(
      Math.sqrt((4 / Math.PI) * (SHAPES.cylinder.cd / SHAPES.plate.cd)),
      6,
    )
  })

  it('is independent of lateral extent — the one statement that matters', () => {
    const c = BRAND_CLASSES['eucalypt-ribbon']
    const small = spawn(c, 0.5e-3)
    const huge = spawn(c, 20e-3)
    expect(brandMass(huge) / brandMass(small)).toBeCloseTo(40, 6)
    // Same delta, therefore same sigma, therefore identical terminal velocity. A 10 m ribbon
    // falls no faster than a 1 cm flake of the same thickness.
    expect(terminalVelocity(small.shape, small.halfThk)).toBe(
      terminalVelocity(huge.shape, huge.halfThk),
    )
  })

  it('inverts the four Almeida (2021) measured terminal velocities', () => {
    // Spec §2.2 validation: invert sigma = v_t^2 rho_a C_D / (2g), then delta = sigma/(k rho_p).
    // Quoted thicknesses are recovered at rho_p = 360 as HALF-thickness for the plates and as
    // diameter (2*delta) for the cylinder.
    const halfMm = (shape: 'plate' | 'cylinder', v: number): number =>
      halfThicknessForTerminalVelocity(shape, v) * 1000
    // 6% relative, which is the rounding in the spec's own quoted digits, not slack.
    const near = (got: number, want: number): void =>
      expect(Math.abs(got / want - 1)).toBeLessThan(0.06)
    near(2 * halfMm('cylinder', 3.31), 1.11) // P. pinaster needle, real ~1 mm
    near(halfMm('plate', 1.69), 0.24) // Q. robur leaf, real ~0.2 mm
    near(halfMm('plate', 1.94), 0.31) // Q. suber, real ~0.3 mm
    near(halfMm('plate', 2.36), 0.46) // E. globulus, real 0.3-0.5 mm
    // C_D = 1.3 (the pre-correction plate value) would have required every leaf to be 37%
    // thicker than measured — sigma scales linearly with C_D — which is how the reference-area
    // error was found in the first place.
    const wrong = (1.69 * 1.69 * AIR_DENSITY * 1.3) / (2 * GRAVITY) / (2 * BRAND_BULK_DENSITY)
    expect(wrong / halfThicknessForTerminalVelocity('plate', 1.69)).toBeCloseTo(1.3 / 0.95, 6)
  })

  it('maps species bark to a brand class', () => {
    expect(brandClassForSpecies('decorticating-ribbon', 'broadleaf', true).id).toBe(
      'eucalypt-ribbon',
    )
    expect(brandClassForSpecies('fibrous', 'broadleaf', true).id).toBe('eucalypt-plate')
    expect(brandClassForSpecies('furrowed', 'conifer', true).id).toBe('conifer-cylinder')
    expect(brandClassForSpecies('smooth', 'grass', false).id).toBe('grass-plate')
  })
})

// ---------------------------------------------------------------------------

describe('flight integrator (§4.3)', () => {
  const c = BRAND_CLASSES['conifer-cylinder']
  const p = flightParamsFor(c, moistureFraction(0))
  const noBurn = { ...p, beta0: 0 }

  it('relaxes onto terminal velocity in still air', () => {
    let b = spawn(c, 0.2e-3)
    for (let i = 0; i < 400; i++) b = stepBrand(b, still(), 0.05, noBurn)
    // The buoyancy term g(1 - rho_a/rho_p) is retained, so the settling speed is v_t scaled by
    // sqrt(1 - rho_a/rho_p) = 0.9983. Negligible, and asserted rather than rounded away.
    const buoyant = Math.sqrt(1 - AIR_DENSITY / BRAND_BULK_DENSITY)
    expect(-b.vel[2]).toBeCloseTo(terminalVelocity(c.shape, c.halfThk) * buoyant, 2)
  })

  it('is unconditionally stable at a step 100x the drag relaxation time', () => {
    // §4.3 quotes tau = 0.004-0.017 s for the thin-plate classes in a 20 m/s plume — at or below
    // one frame — which is why explicit Euler would need substepping and this does not.
    const thin = BRAND_CLASSES['grass-plate']
    const tau = dragRelaxationTime(thin.shape, thin.halfThk, 20)
    expect(tau).toBeGreaterThan(0.004)
    expect(tau).toBeLessThan(0.017)
    let b = { ...spawn(thin, 0.02e-3), vel: [30, 0, 0] as Vec3 }
    for (let i = 0; i < 20; i++) b = stepBrand(b, [10, 0, 0], 5, { ...noBurn, beta0: 0 })
    // Explicit Euler at dt/tau ~ 100 would have exploded; this must simply track the fluid.
    expect(b.vel[0]).toBeCloseTo(10, 3)
    expect(Number.isFinite(b.pos[0])).toBe(true)
  })

  it('recovers free fall when the brand is comoving with the fluid', () => {
    // tau -> infinity: the limit is analytic but the float form is a cancellation, so this is
    // the guard on the TAU_MAX clamp and on `oneMinusExp`.
    const b0: BrandState = { ...spawn(c, 0.2e-3), vel: [5, 0, 0] }
    const b1 = stepBrand(b0, [5, 0, 0], 0.1, noBurn)
    expect(b1.vel[2]).toBeCloseTo(-GRAVITY * 0.1 * (1 - AIR_DENSITY / BRAND_BULK_DENSITY), 4)
    expect(b1.pos[2] - b0.pos[2]).toBeCloseTo(-0.5 * GRAVITY * 0.01, 3)
  })

  it('agrees with the analytic exponential for constant u', () => {
    const b0: BrandState = { ...spawn(c, 0.2e-3), vel: [0, 0, 0] }
    const u: Vec3 = [12, 0, 0]
    const tau = dragRelaxationTime(c.shape, c.halfThk, 12)
    const b1 = stepBrand(b0, u, 0.02, noBurn)
    expect(b1.vel[0]).toBeCloseTo(12 * (1 - Math.exp(-0.02 / tau)), 3)
  })

  it('oneMinusExp is accurate in both branches', () => {
    for (const h of [1e-9, 1e-5, 1e-4, 0.01, 1, 20]) {
      expect(oneMinusExp(h)).toBeCloseTo(-Math.expm1(-h), 9)
    }
  })
})

// ---------------------------------------------------------------------------

describe('mass loss and the burnout criterion (§2.4, §2.5)', () => {
  const c = BRAND_CLASSES['eucalypt-ribbon']

  it('conserves mass: massFrac is monotone, bounded, and matches the closed form', () => {
    const dEq0 = equivalentDiameter(5e-3 / arealDensity(c.shape, c.halfThk))
    let b = { ...spawn(c, 5e-3), areaEq: dEq0 }
    const p = flightParamsFor(c, moistureFraction(0))
    let prev = 1
    let prevMass = brandMass(b)
    for (let i = 0; i < 40000; i++) {
      b = stepBrand(b, still(), 0.1, p)
      expect(b.massFrac).toBeLessThanOrEqual(prev + 1e-12)
      expect(b.massFrac).toBeGreaterThanOrEqual(0)
      expect(b.halfThk).toBeGreaterThanOrEqual(0)
      const mass = brandMass(b)
      expect(mass).toBeLessThanOrEqual(prevMass + 1e-15)
      // The incremental product must telescope to the closed form (delta/delta0)(a/a0)^2.
      const closed = (b.halfThk / c.halfThk) * (b.areaEq / dEq0) ** 2
      expect(b.massFrac).toBeCloseTo(closed, 9)
      prev = b.massFrac
      prevMass = mass
      if (b.halfThk === 0) break
    }
    expect(b.halfThk).toBe(0)
    expect(b.massFrac).toBe(0)
  })

  it('burns out at the published time when falling at terminal velocity', () => {
    // beta0 = delta0/t_burnout is defined AT terminal-velocity conditions, so a brand held at
    // v_t must reach delta = 0 at t_burnout. That is the whole reason beta0 needs no
    // unmeasured constant: it comes straight from Hall's wind-tunnel number.
    for (const id of ['eucalypt-ribbon', 'eucalypt-cylinder', 'conifer-cylinder'] as const) {
      const cl = BRAND_CLASSES[id]
      const dEq = equivalentDiameter(1e-3 / arealDensity(cl.shape, cl.halfThk))
      const p = flightParamsFor(cl, moistureFraction(0))
      let b = { ...spawn(cl, 1e-3), areaEq: dEq, vel: [0, 0, -terminalVelocity(cl.shape, cl.halfThk)] as Vec3 }
      let t = 0
      const dt = cl.burnout / 2000
      while (b.halfThk > 0 && t < cl.burnout * 3) {
        b = stepBrand(b, still(), dt, p)
        t += dt
      }
      expect(t / cl.burnout).toBeGreaterThan(0.9)
      expect(t / cl.burnout).toBeLessThan(1.1)
    }
  })

  it('burns faster in the plume than at terminal velocity (Ranz-Marshall)', () => {
    const dEq = equivalentDiameter(1e-3 / arealDensity(c.shape, c.halfThk))
    const p = flightParamsFor(c, moistureFraction(0))
    const slow = stepBrand({ ...spawn(c, 1e-3), areaEq: dEq, vel: [0, 0, -5.8] }, still(), 1, p)
    const fast = stepBrand({ ...spawn(c, 1e-3), areaEq: dEq, vel: [0, 0, 25] }, still(), 1, p)
    expect(fast.halfThk).toBeLessThan(slow.halfThk)
  })

  it('kills a brand on either condition, not both', () => {
    const b = spawn(c, 1e-3)
    expect(stillGlowing(b)).toBe(true)
    expect(stillGlowing({ ...b, halfThk: 0 })).toBe(false)
    expect(stillGlowing({ ...b, massFrac: GLOW_MASS_FRACTION })).toBe(false)
    expect(stillGlowing({ ...b, massFrac: GLOW_MASS_FRACTION + 1e-6 })).toBe(true)
  })

  it('separates eucalypt ribbon from conifer in lifetime at equal terminal velocity', () => {
    // The reason eucalypt spots to kilometres. Terminal velocities within 8% of each other,
    // burnout 3.7x longer, so the ribbon flies 3.7x further for the same loft height.
    const conifer = BRAND_CLASSES['conifer-cylinder']
    const ribbon = BRAND_CLASSES['eucalypt-ribbon']
    const vRatio =
      terminalVelocity(ribbon.shape, ribbon.halfThk) /
      terminalVelocity(conifer.shape, conifer.halfThk)
    expect(Math.abs(vRatio - 1)).toBeLessThan(0.1)
    expect(ribbon.burnout / conifer.burnout).toBeGreaterThan(3)
    expect(beta0For(conifer)).toBeGreaterThan(2.5 * beta0For(ribbon))
  })
})

// ---------------------------------------------------------------------------

describe('generation (§2.1)', () => {
  it('samples a truncated power law with the analytic mean', () => {
    const c = BRAND_CLASSES['conifer-cylinder']
    const sigma = arealDensity(c.shape, c.halfThk)
    const aMin = c.massMin / sigma
    const aMax = c.massMax / sigma
    let sum = 0
    const n = 20000
    for (let i = 0; i < n; i++) {
      const a = sampleProjectedArea(hash01(i, 7), aMin, aMax)
      expect(a).toBeGreaterThanOrEqual(aMin * (1 - 1e-9))
      expect(a).toBeLessThanOrEqual(aMax * (1 + 1e-9))
      sum += a
    }
    expect(sum / n).toBeCloseTo(meanProjectedArea(aMin, aMax), 6)
  })

  it('the truncation reproduces the mean brand mass the NIST table quotes', () => {
    // §2.1 lists 0.10-0.24 g typical for W. US conifer with 3.9 g max. m-bar is NOT a physical
    // mode — Petersen & Banerjee found no defined mean — it is a consequence of where the
    // distribution is truncated, so this is a check on the truncation, not on a fitted mean.
    const c = BRAND_CLASSES['conifer-cylinder']
    const sigma = arealDensity(c.shape, c.halfThk)
    const meanMass = sigma * meanProjectedArea(c.massMin / sigma, c.massMax / sigma)
    expect(meanMass * 1000).toBeGreaterThan(0.1)
    expect(meanMass * 1000).toBeLessThan(0.24)
  })

  it('spawn count is unbiased under the stochastic remainder', () => {
    // 0.3 brands per step must average 0.3, not round to zero — over a 2048^2 grid that
    // truncation would delete most of the spotting.
    let total = 0
    const n = 50000
    for (let i = 0; i < n; i++) total += spawnCount(0.003, 100, 1, 1, 1, hash01(i, 99))
    expect(total / n).toBeCloseTo(0.3, 2)
    expect(spawnCount(0, 100, 1, 1, 1, 0.5)).toBe(0)
    expect(spawnCount(0.003, 100, 1, 1, 10, 0.99)).toBe(0) // weight 10 divides the count
  })

  it('hash01 is uniform enough and reproducible', () => {
    expect(hash01(3, 4)).toBe(hash01(3, 4))
    expect(hash01(3, 4)).not.toBe(hash01(4, 3))
    const bins = new Array<number>(10).fill(0)
    for (let i = 0; i < 100000; i++) {
      const v = hash01(i, 1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      bins[Math.floor(v * 10)] = (bins[Math.floor(v * 10)] ?? 0) + 1
    }
    for (const b of bins) expect(Math.abs(b - 10000)).toBeLessThan(600)
  })
})

// ---------------------------------------------------------------------------

describe('landing ignition (§3)', () => {
  const base = {
    massKg: 1e-3,
    receptorMoisture: moistureFraction(0.05),
    surfaceWind: 1,
    receptorBulkDensity: 30,
    flaming: false,
  }

  it('is bounded [0,1] over every input including degenerate ones', () => {
    for (const massKg of [0, 1e-12, 1e-6, 1e-3, 1, 1e6]) {
      for (const mc of [0, 0.05, 0.3, 4]) {
        for (const wind of [0, 5, 50]) {
          for (const rho of [0, 30, 500]) {
            for (const flaming of [false, true]) {
              const p = ignitionProbability({
                massKg,
                receptorMoisture: moistureFraction(mc),
                surfaceWind: wind,
                receptorBulkDensity: rho,
                flaming,
              })
              expect(Number.isFinite(p)).toBe(true)
              expect(p).toBeGreaterThanOrEqual(0)
              expect(p).toBeLessThanOrEqual(1)
            }
          }
        }
      }
    }
  })

  it('has the signs the literature is firm about', () => {
    const p = (o: Partial<typeof base>): number => ignitionProbability({ ...base, ...o })
    expect(p({ massKg: 2e-3 })).toBeGreaterThan(p({})) // b1 > 0
    expect(p({ receptorMoisture: moistureFraction(0.2) })).toBeLessThan(p({})) // b2 < 0
    expect(p({ receptorBulkDensity: 300 })).toBeLessThan(p({})) // b4 < 0
    expect(p({ flaming: true })).toBeGreaterThan(p({})) // b5 > 0
    expect(p({ surfaceWind: 8 })).toBeGreaterThan(p({})) // b3 > 0
  })

  it('reproduces the published anchors', () => {
    // Plucinski & Anderson 2008: flaming brands on fine fuels below ~10% MC ignite ~always.
    expect(
      ignitionProbability({ ...base, flaming: true, receptorMoisture: moistureFraction(0.08) }),
    ).toBeGreaterThan(0.9)
    // Ellis 2011: glowing 0.5-1.6 g stringybark ignites P. radiata litter at 2-8% MC — often,
    // not always. Anything near 1.0 here would be the model claiming more than the paper does.
    const ellis = ignitionProbability({
      ...base,
      massKg: 1.6e-3,
      receptorMoisture: moistureFraction(0.02),
    })
    expect(ellis).toBeGreaterThan(0.3)
    expect(ellis).toBeLessThan(0.95)
    // Ganteaume 2009: a wet dense bed essentially does not ignite.
    expect(
      ignitionProbability({
        ...base,
        massKg: 0.1e-3,
        receptorMoisture: moistureFraction(0.25),
        receptorBulkDensity: 200,
      }),
    ).toBeLessThan(0.02)
  })

  it('the ignited seed patch is sub-grid, which is why coalescence is needed at all', () => {
    // A 5 g brand on 0.5 kg/m2 litter at 6% MC seeds ~0.04 m2 — a 20 cm spot, well under the
    // 0.25 m2 of one surface cell and far under the ~1 m2 a self-sustaining spot fire needs.
    // Promoting every ignition draw straight to a live cell would massively over-predict.
    const patch = ignitedPatchArea(5e-3, 0.5, moistureFraction(0.06))
    expect(patch).toBeGreaterThan(0.02)
    expect(patch).toBeLessThan(0.06)
    expect(patch).toBeLessThan(0.25)
    // Monotone the right way in both arguments.
    expect(ignitedPatchArea(5e-3, 0.5, moistureFraction(0.3))).toBeLessThan(patch)
    expect(ignitedPatchArea(5e-3, 2.0, moistureFraction(0.06))).toBeLessThan(patch)
    expect(ignitedPatchArea(0, 0.5, moistureFraction(0.06))).toBe(0)
  })

  it('the default coefficients are the ones provenance describes', () => {
    expect(DEFAULT_IGNITION_COEFFS.b1).toBeGreaterThan(0)
    expect(DEFAULT_IGNITION_COEFFS.b2).toBeLessThan(0)
    expect(DEFAULT_IGNITION_COEFFS.b4).toBeLessThan(0)
  })
})
