/**
 * WP 3.5 acceptance (spec §90 §91): "Crown initiation occurs at the correct critical surface
 * intensity for given crown base height and foliar moisture; bulk-density threshold behaviour
 * correct."
 *
 * Both halves are asserted against published worked values, plus the two things that would
 * silently break them: the FMC fraction/percent boundary, and a classification that changes
 * out of order as intensity rises.
 */

import { describe, expect, it } from 'vitest'
import { kWm, kgm3, m, moistureFraction, mps } from '@contracts/units.ts'
import type { KilowattsPerMetre, MetresPerSecond } from '@contracts/units.ts'
import {
  CRITICAL_MASS_FLOW_RATE,
  DEFAULT_CROWN_TUNING,
  classifyCrownFire,
  criticalActiveSpreadRate,
  criticalInitiationIntensity,
  criticalInitiationSpreadRate,
  crownMassFlowRate,
  envelopeWarnings,
  evaluateCrownFire,
  heatOfIgnition,
  vanWagnerCrownFractionBurned,
} from '@sim/canopy/crown/vanWagner.ts'
import type { CrownFireInput, StandCrownParams } from '@sim/canopy/crown/vanWagner.ts'

/** A boreal-conifer stand squarely inside Van Wagner's envelope. */
const STAND: StandCrownParams = {
  canopyBaseHeight: m(3),
  canopyBulkDensity: kgm3(0.2),
  foliarMoisture: moistureFraction(1.0), // 100 %
}

/**
 * Byram at fixed fuel: I = (H·w)·R. Fixing H·w lets a test sweep intensity and get the
 * matching spread rate, which is exactly the pair the surface solver exports.
 */
const HW = 8000 // kJ/m2, i.e. I in kW/m per (m/s) of spread
const rosFor = (intensity: number): MetresPerSecond => mps(intensity / HW)

const inputAt = (intensity: number, over?: Partial<CrownFireInput>): CrownFireInput => ({
  stand: STAND,
  surfaceIntensity: kWm(intensity),
  surfaceRos: rosFor(intensity),
  crownRos: rosFor(intensity),
  ...over,
})

// ---------------------------------------------------------------------------
// Initiation
// ---------------------------------------------------------------------------

describe('critical surface intensity for crown initiation (Van Wagner 1977)', () => {
  it('reproduces the Scott & Reinhardt (2001) worked example: CBH 3 m, FMC 100% -> 875 kW/m', () => {
    expect(criticalInitiationIntensity(m(3), moistureFraction(1.0))).toBeCloseTo(875.2, 1)
  })

  it('h = 460 + 25.9·FMC with FMC in PERCENT, not fraction', () => {
    // The whole unit trap in one assertion. At FMC = 100% the published h is 3050 kJ/kg.
    // Feeding the fraction straight in gives 485.9 — and then I_0 falls by a factor of 15.6,
    // which is a stand that torches at almost any intensity.
    expect(heatOfIgnition(moistureFraction(1.0))).toBeCloseTo(3050, 6)
    expect(heatOfIgnition(moistureFraction(0))).toBeCloseTo(460, 6)
    expect(criticalInitiationIntensity(m(3), moistureFraction(0))).toBeCloseTo(
      Math.pow((3 * 460) / 100, 1.5),
      6,
    )
  })

  it('scales as CBH^1.5 and rises with foliar moisture', () => {
    const a = criticalInitiationIntensity(m(2), moistureFraction(1.0))
    const b = criticalInitiationIntensity(m(4), moistureFraction(1.0))
    expect(b / a).toBeCloseTo(Math.pow(2, 1.5), 10)
    expect(criticalInitiationIntensity(m(3), moistureFraction(1.4))).toBeGreaterThan(
      criticalInitiationIntensity(m(3), moistureFraction(0.8)),
    )
  })

  it('covers the §7.7 calibration grid monotonically in both CBH and FMC', () => {
    const cbhs = [0.5, 1, 2, 3, 5, 8]
    const fmcs = [0.8, 1.0, 1.2, 1.4]
    for (const fmc of fmcs) {
      let prev = -1
      for (const cbh of cbhs) {
        const i0 = criticalInitiationIntensity(m(cbh), moistureFraction(fmc))
        expect(i0).toBeGreaterThan(prev)
        prev = i0
      }
    }
    for (const cbh of cbhs) {
      let prev = -1
      for (const fmc of fmcs) {
        const i0 = criticalInitiationIntensity(m(cbh), moistureFraction(fmc))
        expect(i0).toBeGreaterThan(prev)
        prev = i0
      }
    }
  })

  it('returns zero for vertically continuous fuel and flags it rather than pretending', () => {
    expect(criticalInitiationIntensity(m(0), moistureFraction(1.0))).toBe(0)
    const warnings = envelopeWarnings({ ...STAND, canopyBaseHeight: m(0) })
    expect(warnings.join(' ')).toMatch(/vertically continuous/)
  })

  it('honours the initiationScale tunable (the 1/100 divisor is a one-observation fit)', () => {
    const base = criticalInitiationIntensity(m(3), moistureFraction(1.0))
    const scaled = criticalInitiationIntensity(m(3), moistureFraction(1.0), {
      ...DEFAULT_CROWN_TUNING,
      initiationScale: 0.5,
    })
    expect(scaled).toBeCloseTo(base * 0.5, 10)
  })
})

describe('critical initiation spread rate', () => {
  it('is the surface ROS scaled by I_0/I_surf', () => {
    const i0 = criticalInitiationIntensity(m(3), moistureFraction(1.0))
    const r = criticalInitiationSpreadRate(i0, kWm(1750), rosFor(1750))
    expect(r).toBeCloseTo(i0 / HW, 12)
  })

  it('is infinite when there is no surface fire to scale from', () => {
    expect(criticalInitiationSpreadRate(kWm(875), kWm(0), mps(0))).toBe(Infinity)
  })
})

// ---------------------------------------------------------------------------
// Active crowning — the bulk density threshold
// ---------------------------------------------------------------------------

describe('active crowning mass-flow threshold (Van Wagner 1977)', () => {
  it('R_active = 3.0/CBD m/min: CBD 0.2 -> 15 m/min = 0.25 m/s', () => {
    expect(criticalActiveSpreadRate(kgm3(0.2))).toBeCloseTo(0.25, 12)
    expect(criticalActiveSpreadRate(kgm3(0.2)) * 60).toBeCloseTo(15, 10)
  })

  it('S_0/CBD in SI and 3.0/CBD in m/min are the same constant, across the §7.7 CBD sweep', () => {
    for (const cbd of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4]) {
      expect(criticalActiveSpreadRate(kgm3(cbd)) * 60).toBeCloseTo(3.0 / cbd, 10)
    }
  })

  it('S = R·CBD crosses S_0 exactly at R_active', () => {
    const cbd = kgm3(0.15)
    const rActive = criticalActiveSpreadRate(cbd)
    expect(crownMassFlowRate(rActive, cbd)).toBeCloseTo(CRITICAL_MASS_FLOW_RATE, 12)
    expect(crownMassFlowRate(mps(rActive * 0.999), cbd)).toBeLessThan(CRITICAL_MASS_FLOW_RATE)
    expect(crownMassFlowRate(mps(rActive * 1.001), cbd)).toBeGreaterThan(CRITICAL_MASS_FLOW_RATE)
  })

  it('a denser canopy crowns at a lower spread rate', () => {
    expect(criticalActiveSpreadRate(kgm3(0.4))).toBeLessThan(criticalActiveSpreadRate(kgm3(0.1)))
  })

  it('an empty canopy can never crown', () => {
    expect(criticalActiveSpreadRate(kgm3(0))).toBe(Infinity)
    expect(evaluateCrownFire(inputAt(1e6, { stand: { ...STAND, canopyBulkDensity: kgm3(0) } })).classification).toBe(
      'none',
    )
  })
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classification transitions in the right order as intensity rises', () => {
  const i0 = criticalInitiationIntensity(STAND.canopyBaseHeight, STAND.foliarMoisture)
  // The intensity at which R = R_active, i.e. where passive becomes active.
  const iActive = criticalActiveSpreadRate(STAND.canopyBulkDensity) * HW

  it('none below I_0', () => {
    expect(evaluateCrownFire(inputAt(i0 * 0.99)).classification).toBe('none')
  })

  it('passive (torching) at I_0, before the mass flow threshold', () => {
    expect(i0).toBeLessThan(iActive) // otherwise this stand skips torching entirely
    expect(evaluateCrownFire(inputAt(i0 * 1.01)).classification).toBe('passive')
    expect(evaluateCrownFire(inputAt(iActive * 0.99)).classification).toBe('passive')
  })

  it('active once R·CBD reaches S_0', () => {
    expect(evaluateCrownFire(inputAt(iActive * 1.01)).classification).toBe('active')
  })

  it('never goes backwards over a two-decade intensity sweep', () => {
    const order = { none: 0, passive: 1, active: 2, independent: 3 } as const
    let prev = 0
    for (let i = 0; i <= 400; i++) {
      const intensity = 20 * Math.pow(10, (2 * i) / 400) // 20 -> 2000 kW/m
      const rank = order[evaluateCrownFire(inputAt(intensity)).classification]
      expect(rank).toBeGreaterThanOrEqual(prev)
      prev = rank
    }
    expect(prev).toBe(2)
  })

  it('a zero-intensity domain is not a crown fire even when CBH is zero', () => {
    // I_0 = 0 for continuous fuel, so without the surfaceIntensity > 0 guard an unignited
    // chaparral stand would report torching everywhere.
    const stand = { ...STAND, canopyBaseHeight: m(0) }
    expect(evaluateCrownFire(inputAt(0, { stand })).classification).toBe('none')
    expect(evaluateCrownFire(inputAt(1, { stand })).classification).not.toBe('none')
  })

  it('labels independent crown fire only when the voxel field observes a burning crown', () => {
    const belowI0 = i0 * 0.5
    const fastCrown = mps(criticalActiveSpreadRate(STAND.canopyBulkDensity) * 1.2)
    // Predicted, not observed: no measured consumption -> not independent.
    expect(
      evaluateCrownFire(inputAt(belowI0, { crownRos: fastCrown })).classification,
    ).toBe('none')
    // Observed: the canopy solver reports crown fuel burning.
    expect(
      evaluateCrownFire(
        inputAt(belowI0, { crownRos: fastCrown, measuredCrownConsumedFraction: 0.4 }),
      ).classification,
    ).toBe('independent')
  })

  it('classifyCrownFire is a pure threshold pair, exercised directly', () => {
    const call = (i: number, s: number, burning = false): string =>
      classifyCrownFire(kWm(i), kWm(875), s, CRITICAL_MASS_FLOW_RATE, burning)
    expect(call(800, 0.01)).toBe('none')
    expect(call(875, 0.01)).toBe('passive') // >= is inclusive at the threshold
    expect(call(875, 0.05)).toBe('active')
    expect(call(800, 0.05)).toBe('none')
    expect(call(800, 0.05, true)).toBe('independent')
  })
})

// ---------------------------------------------------------------------------
// Crown fraction burned
// ---------------------------------------------------------------------------

describe('crown fraction burned (Van Wagner 1993 dynamic coefficient)', () => {
  /** Recover `a` from CFB, so the assertion is against the published coefficient itself. */
  const coefficient = (deltaRMPerMin: number): number => {
    const rInit = mps(1 / 60) // 1 m/min
    const rActive = mps((1 + deltaRMPerMin) / 60)
    const x = 1 / 60 // 1 m/min above initiation
    const cfb = vanWagnerCrownFractionBurned(mps(rInit + x), rInit, rActive)
    return -Math.log(1 - cfb) / (x * 60) // per m/min
  }

  it('reproduces both Scott & Reinhardt Appendix A stands', () => {
    expect(coefficient(10.74)).toBeCloseTo(0.238, 3) // jack pine
    expect(coefficient(23.69)).toBeCloseTo(0.108, 3) // mature stand
  })

  it('reaches 0.9 at 90% of the way from R_init to R_active — the 0.9 in the coefficient', () => {
    const rInit = 0.1
    const rActive = 0.4
    const at90 = rInit + 0.9 * (rActive - rInit)
    expect(vanWagnerCrownFractionBurned(mps(at90), mps(rInit), mps(rActive))).toBeCloseTo(0.9, 9)
    // And it is already past 0.9 by R_active itself: 1 - exp(-2.3026/0.9) = 0.9226.
    expect(vanWagnerCrownFractionBurned(mps(rActive), mps(rInit), mps(rActive))).toBeCloseTo(
      0.92257,
      5,
    )
  })

  it('is zero at or below the initiation spread rate, and monotone above it', () => {
    const rInit = mps(0.1)
    const rActive = mps(0.4)
    expect(vanWagnerCrownFractionBurned(mps(0.1), rInit, rActive)).toBe(0)
    expect(vanWagnerCrownFractionBurned(mps(0.05), rInit, rActive)).toBe(0)
    let prev = 0
    for (let r = 0.1; r <= 1.0; r += 0.02) {
      const cfb = vanWagnerCrownFractionBurned(mps(r), rInit, rActive)
      expect(cfb).toBeGreaterThanOrEqual(prev)
      expect(cfb).toBeLessThanOrEqual(1)
      prev = cfb
    }
  })

  it('handles the degenerate stand where R_active <= R_init without dividing by zero', () => {
    expect(vanWagnerCrownFractionBurned(mps(0.5), mps(0.4), mps(0.2))).toBe(1)
    expect(vanWagnerCrownFractionBurned(mps(0.3), mps(0.4), mps(0.2))).toBe(0)
  })

  it('is unit-invariant between m/s and m/min, because a and x scale reciprocally', () => {
    const si = vanWagnerCrownFractionBurned(mps(0.3), mps(0.1), mps(0.4))
    const perMin = vanWagnerCrownFractionBurned(mps(18), mps(6), mps(24))
    expect(si).toBeCloseTo(perMin, 12)
  })

  it('prefers the measured voxel consumption fraction over the curve, and says which it used', () => {
    const withCurve = evaluateCrownFire(inputAt(3000))
    expect(withCurve.crownFractionBurnedIsDiagnostic).toBe(true)
    const withVoxels = evaluateCrownFire(inputAt(3000, { measuredCrownConsumedFraction: 0.31 }))
    expect(withVoxels.crownFractionBurnedIsDiagnostic).toBe(false)
    expect(withVoxels.crownFractionBurned).toBe(0.31)
    // Out-of-range measurements are clamped, not trusted.
    expect(
      evaluateCrownFire(inputAt(3000, { measuredCrownConsumedFraction: 1.4 })).crownFractionBurned,
    ).toBe(1)
  })

  it('is zero for a surface fire', () => {
    expect(evaluateCrownFire(inputAt(100)).crownFractionBurned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('envelope warnings (spec §7.1 — state it in the UI)', () => {
  it('is silent inside the boreal conifer envelope', () => {
    expect(envelopeWarnings(STAND)).toHaveLength(0)
    for (const fmc of [0.95, 1.0, 1.2, 1.35]) {
      expect(envelopeWarnings({ ...STAND, foliarMoisture: moistureFraction(fmc) })).toHaveLength(0)
    }
  })

  it('flags chaparral-like stands on both counts', () => {
    const chaparral: StandCrownParams = {
      canopyBaseHeight: m(0),
      canopyBulkDensity: kgm3(1.5),
      foliarMoisture: moistureFraction(0.6),
    }
    const w = envelopeWarnings(chaparral)
    expect(w).toHaveLength(2)
    expect(w.join(' ')).toMatch(/vertically continuous/)
    expect(w.join(' ')).toMatch(/60% is outside/)
  })

  it('carries the warnings through evaluateCrownFire, where the HUD reads them', () => {
    const r = evaluateCrownFire(
      inputAt(2000, { stand: { ...STAND, foliarMoisture: moistureFraction(2.0) } }),
    )
    expect(r.envelopeWarnings.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Cost — §0.5.1 says measure, do not predict
// ---------------------------------------------------------------------------

describe('cost', () => {
  it('evaluates in well under a microsecond, so the update rate is a non-question', () => {
    const input = inputAt(2000)
    const n = 200_000
    // Warm-up, so the measurement is of steady-state JIT output rather than the interpreter.
    let sink = 0
    for (let i = 0; i < 20_000; i++) sink += evaluateCrownFire(input).crownFractionBurned
    const t0 = performance.now()
    for (let i = 0; i < n; i++) sink += evaluateCrownFire(input).crownFractionBurned
    const nsPerCall = ((performance.now() - t0) * 1e6) / n
    expect(sink).toBeGreaterThan(0)
    // Generous: the point is that even 100x this is invisible against a 16.6 ms frame at the
    // once-per-canopy-step rate this actually runs at. CI machines are slow and variable.
    expect(nsPerCall).toBeLessThan(5000)
    // eslint-disable-next-line no-console
    console.log(`evaluateCrownFire: ${nsPerCall.toFixed(0)} ns/call`)
  })
})

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe('contract', () => {
  it('the result is assignable to the frozen CrownFireState', () => {
    const r = evaluateCrownFire(inputAt(2000))
    const state: { classification: string; criticalIntensity: KilowattsPerMetre; crownFractionBurned: number } = r
    expect(state.criticalIntensity).toBeCloseTo(875.2, 1)
    expect(state.crownFractionBurned).toBeGreaterThan(0)
  })
})
