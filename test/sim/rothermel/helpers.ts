import type { FuelSizeClass, SpreadInputs } from '@contracts/sim.ts'
import type { MoistureFraction } from '@contracts/units.ts'
import { moistureFraction, mps, slopeTan } from '@contracts/units.ts'
import { FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { curingFraction } from '@sim/rothermel/kernel.ts'

/**
 * Scott & Burgan fuel moisture scenarios, as fractions. `D` sets dead 1/10/100-h, `L` sets live
 * herb/woody. The published table quotes these in percent; the conversion is done once, here.
 */
export const DEAD_SCENARIOS = {
  D1: [0.03, 0.04, 0.05],
  D2: [0.06, 0.07, 0.08],
  D3: [0.09, 0.1, 0.11],
  D4: [0.12, 0.13, 0.14],
} as const satisfies Record<string, readonly [number, number, number]>

export const LIVE_SCENARIOS = {
  L1: [0.3, 0.6],
  L2: [0.6, 0.9],
  L3: [0.9, 1.2],
  L4: [1.2, 1.5],
} as const satisfies Record<string, readonly [number, number]>

export function moisture(
  dead: readonly [number, number, number],
  live: readonly [number, number],
): Record<FuelSizeClass, MoistureFraction> {
  return {
    dead1h: moistureFraction(dead[0]),
    dead10h: moistureFraction(dead[1]),
    dead100h: moistureFraction(dead[2]),
    liveHerb: moistureFraction(live[0]),
    liveWoody: moistureFraction(live[1]),
  }
}

export interface CaseOptions {
  readonly dead?: readonly [number, number, number]
  readonly live?: readonly [number, number]
  /** Midflame wind, m/s. */
  readonly wind?: number
  /** Slope as a tangent. */
  readonly slope?: number
  /** Overrides the cure fraction derived from live herbaceous moisture. */
  readonly cured?: number
}

/** Builds `SpreadInputs` for a fuel code, defaulting to the D2L2 scenario, calm and flat. */
export function makeCase(code: string, o: CaseOptions = {}): SpreadInputs {
  const dead = o.dead ?? DEAD_SCENARIOS.D2
  const live = o.live ?? LIVE_SCENARIOS.L2
  return {
    fuel: FUEL_MODELS.get(code),
    moisture: moisture(dead, live),
    midflameWind: mps(o.wind ?? 0),
    slope: slopeTan(o.slope ?? 0),
    cured: o.cured ?? curingFraction(moistureFraction(live[0])),
  }
}

/** 5 mi/h in m/s — the wind of the spec §4.2 worked example. 440 ft/min exactly. */
export const FIVE_MPH_MPS = (440 * 0.3048) / 60
