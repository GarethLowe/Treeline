import { describe, expect, it } from 'vitest'
import { mps, s } from '@contracts/units'
import {
  CFL,
  DT_MAX_S,
  DT_MIN_S,
  MAX_SUBSTEPS,
  RMAX_SAFETY,
  cflTimestep,
  substepPlan,
} from '@sim/propagation/timestep'

const CELL = 0.5

describe('CFL timestep — spec §4.8', () => {
  it('reproduces the published regime table', () => {
    // Spec §4.8 quotes dt_max for CFL*dx/R_max with no safety factor; this implementation
    // additionally divides by 1.25 to absorb one frame of staleness in the R_max readback,
    // so the assertion is against the spec figure divided by that factor.
    const table: readonly [number, number][] = [
      [0.02, 10], // timber litter TL2/TL5
      [0.15, 1.3], // conifer understorey TU5
      [1.0, 0.2], // chaparral SH7 at 30 km/h
      [3.0, 0.067], // grass head fire GR4 at 40 km/h
      [5.0, 0.04], // design ceiling, extreme grass
    ]
    for (const [rate, specDt] of table) {
      const bare = (CFL * CELL) / rate
      // The spec prints these to two significant figures.
      expect(Math.abs(bare - specDt) / specDt).toBeLessThan(0.03)
      const got = cflTimestep(mps(rate), CELL)
      expect(got).toBeCloseTo(Math.min(bare / RMAX_SAFETY, DT_MAX_S), 6)
    }
  })

  it('clamps to the 5 ms / 250 ms window', () => {
    expect(cflTimestep(mps(1e6), CELL)).toBe(DT_MIN_S)
    expect(cflTimestep(mps(0), CELL)).toBe(DT_MAX_S)
    expect(cflTimestep(mps(1e-9), CELL)).toBe(DT_MAX_S)
  })

  it('never grows dt when the rate grows', () => {
    let prev = Number.POSITIVE_INFINITY
    for (let r = 0.01; r < 6; r += 0.01) {
      const dt = cflTimestep(mps(r), CELL)
      expect(dt).toBeLessThanOrEqual(prev + 1e-15)
      prev = dt
    }
  })
})

describe('substep plan', () => {
  it('lands exactly on the frame step when it can', () => {
    const plan = substepPlan(s(1 / 30), mps(0.15), CELL)
    expect(plan.substeps).toBeGreaterThan(0)
    expect(plan.simulated).toBeCloseTo(1 / 30, 9)
    expect(plan.capped).toBe(false)
    expect(plan.dt).toBeLessThanOrEqual(cflTimestep(mps(0.15), CELL) + 1e-12)
  })

  it('drops simulated time rather than stretching dt past CFL', () => {
    // Extreme grass, 10x time acceleration: more substeps are wanted than the cap allows.
    const frame = s(2.0)
    const plan = substepPlan(frame, mps(5), CELL)
    expect(plan.capped).toBe(true)
    expect(plan.substeps).toBe(MAX_SUBSTEPS)
    expect(plan.simulated).toBeLessThan(frame)
    // The hard rule from §4.8: never silently exceed CFL.
    expect(plan.dt).toBeLessThanOrEqual(cflTimestep(mps(5), CELL) + 1e-12)
  })

  it('does nothing on a zero-length frame', () => {
    const plan = substepPlan(s(0), mps(1), CELL)
    expect(plan.substeps).toBe(0)
    expect(plan.simulated).toBe(0)
  })

  it('always satisfies CFL, across the whole 250x rate span', () => {
    for (const rate of [0.02, 0.15, 1, 3, 5]) {
      for (const frame of [1 / 120, 1 / 60, 1 / 30, 0.5, 2]) {
        const plan = substepPlan(s(frame), mps(rate), CELL)
        if (plan.substeps === 0) continue
        expect((plan.dt * rate) / CELL).toBeLessThanOrEqual(CFL + 1e-9)
        expect(plan.substeps).toBeLessThanOrEqual(MAX_SUBSTEPS)
      }
    }
  })
})
