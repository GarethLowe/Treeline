/**
 * Surface fire simulation contracts. See docs/spec/20-surface-spread.md.
 *
 * FROZEN for M2. Do not edit during fan-out.
 *
 * Two things in here are load-bearing and easy to get wrong:
 *
 * 1. **Moisture is a fraction, never a percent** (spec §0.6). Published fuel tables quote
 *    moisture of extinction as 15/20/25/35; those are percentages and must be converted at
 *    the parse boundary. A stray x100 either zeroes the moisture damping (nothing burns) or
 *    drives it to unity (everything burns), and no single-fuel-model test catches it.
 *
 * 2. **Rothermel's coefficients are dimensional fits in BTU-lb-ft-min.** State is stored in
 *    SI; the kernel converts at its own boundary and back. Do not "modernise" the
 *    coefficients — every published cross-check against BEHAVE breaks if you do.
 */

import type {
  KgPerSquareMetre,
  KilowattsPerMetre,
  KilowattsPerSquareMetre,
  KilojoulesPerKg,
  Metres,
  MetresPerSecond,
  MoistureFraction,
  PerMetre,
  Radians,
  Seconds,
  SlopeTangent,
} from './units.ts'

// ---------------------------------------------------------------------------
// Fuel models
// ---------------------------------------------------------------------------

/** Anderson (1982) 13, Scott & Burgan (2005) 40, and the project's UK set share one schema. */
export type FuelSizeClass = 'dead1h' | 'dead10h' | 'dead100h' | 'liveHerb' | 'liveWoody'

export const FUEL_SIZE_CLASSES: readonly FuelSizeClass[] = [
  'dead1h',
  'dead10h',
  'dead100h',
  'liveHerb',
  'liveWoody',
]

/**
 * `dynamic` models transfer live herbaceous load to the dead 1-h class as the grass cures
 * (Scott & Burgan 2005). `static` models do not. Getting this wrong makes grassland fires
 * insensitive to curing, which is most of what drives them.
 */
export type FuelModelType = 'static' | 'dynamic'

export interface FuelModel {
  /** e.g. 'GR2', 'SH7', 'TL8', 'UK-CALLUNA-MATURE'. */
  readonly code: string
  readonly name: string
  readonly type: FuelModelType
  /** Oven-dry load per size class. */
  readonly load: Readonly<Record<FuelSizeClass, KgPerSquareMetre>>
  /** Surface-area-to-volume ratio per size class. 10-h and 100-h are constants across S&B. */
  readonly sav: Readonly<Record<FuelSizeClass, PerMetre>>
  /** Fuel bed depth. */
  readonly depth: Metres
  /** Dead fuel moisture of extinction. FRACTION — published tables give percent. */
  readonly moistureOfExtinctionDead: MoistureFraction
  /** Low heat of combustion. 8000 BTU/lb for most S&B; chaparral fines are 9000. */
  readonly heatContent: KilojoulesPerKg
}

// ---------------------------------------------------------------------------
// Rothermel — the pure kernel (WP 2.1), which is the oracle for the WGSL port (WP 2.2)
// ---------------------------------------------------------------------------

export interface SpreadInputs {
  readonly fuel: FuelModel
  /** Per-class moisture. FRACTION. */
  readonly moisture: Readonly<Record<FuelSizeClass, MoistureFraction>>
  /** MIDFLAME wind speed, already adjusted from the 10 m reference by the WAF. */
  readonly midflameWind: MetresPerSecond
  /** Upslope-positive. Rothermel's slope factor uses tan². */
  readonly slope: SlopeTangent
  /**
   * Curing fraction for dynamic models, 0 = fully green, 1 = fully cured. Derived from
   * live herbaceous moisture, not set independently — see spec §4.3.
   */
  readonly cured: number
}

export interface SpreadOutputs {
  /** Head-fire rate of spread, no-wind-no-slope rate, and the factors, all exposed for testing. */
  readonly rateOfSpread: MetresPerSecond
  readonly noWindNoSlopeRate: MetresPerSecond
  readonly reactionIntensity: KilowattsPerSquareMetre
  readonly windFactor: number
  readonly slopeFactor: number
  /** Effective midflame wind — what the §4.5 wind limit acts on, if enabled. */
  readonly effectiveWind: MetresPerSecond
  readonly firelineIntensity: KilowattsPerMetre
  readonly flameLength: Metres
  /** Flaming residence time, drives the burnout curve. */
  readonly residenceTime: Seconds
  /** Length-to-breadth ratio of the fire ellipse. */
  readonly lengthToBreadth: number
  /** True when the fuel bed cannot carry fire (moisture at or above extinction). */
  readonly extinguished: boolean
}

// ---------------------------------------------------------------------------
// Surface grid state (WP 2.2)
// ---------------------------------------------------------------------------

/**
 * Grid dimensions live in `world.ts` (`SURFACE_CELLS`, `SURFACE_CELL_M`) — one definition,
 * because the terrain, vegetation and fire grids must agree by construction rather than by
 * two constants that happen to match today.
 */
export { SURFACE_CELLS, SURFACE_CELL_M } from './world.ts'

/** Cell lifecycle. `burning` cells are the active set the solver dispatches over. */
export const CELL_UNBURNT = 0
export const CELL_BURNING = 1
export const CELL_BURNT = 2
export type CellState = typeof CELL_UNBURNT | typeof CELL_BURNING | typeof CELL_BURNT

/**
 * Byte layout of the per-cell packed state. Spec §4.3 quotes ~113 MB for this and flags it
 * as unreconciled; the authoritative number is whatever this layout multiplies out to, and
 * WP 2.2 must re-derive and record it. State MB vs MiB explicitly.
 */
export const SURFACE_STATE_BYTES_PER_CELL = 12 as const

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export type IgnitionShape =
  | { readonly kind: 'point'; readonly x: Metres; readonly z: Metres; readonly radius: Metres }
  | { readonly kind: 'line'; readonly x0: Metres; readonly z0: Metres; readonly x1: Metres; readonly z1: Metres; readonly width: Metres }
  | { readonly kind: 'ring'; readonly x: Metres; readonly z: Metres; readonly radius: Metres; readonly width: Metres }

/** What the solver needs from the weather module each step. Stubbed until M5. */
export interface SurfaceWeather {
  readonly midflameWind: MetresPerSecond
  readonly windDirection: Radians
  readonly moisture: Readonly<Record<FuelSizeClass, MoistureFraction>>
}

/**
 * Fields the renderer, the canopy module (M3) and the measurement HUD (M6) all read.
 * Exposed as textures because every consumer is on the GPU.
 */
export interface IFireOutputs {
  /** Per-cell state enum, r8uint. */
  readonly stateTexture: GPUTexture
  /** Fireline intensity, r16float, kW/m. Feeds Van Wagner crown initiation at M3. */
  readonly intensityTexture: GPUTexture
  /** Time of arrival, r32float, seconds. Written with atomicMin so it is order-independent. */
  readonly arrivalTimeTexture: GPUTexture
  /** Fraction of the cell's fuel consumed, r8unorm. Drives char/ash materials. */
  readonly consumedTexture: GPUTexture
  /** Aggregates for the HUD and CSV export. */
  readonly burntAreaM2: number
  readonly perimeterM: number
  readonly maxFirelineIntensity: KilowattsPerMetre
}

// ---------------------------------------------------------------------------
// Canopy, crown fire and firebrands (M3)
// ---------------------------------------------------------------------------

/** 512x512x64 at 2 m, sparse. See docs/spec/30-canopy-heat-crown.md §7.2. */
export const CANOPY_N_XY = 512
export const CANOPY_N_Z = 64
export const CANOPY_CELL_M_3D = 2

/**
 * Largest simulated step any subsystem integrates in one go, seconds.
 *
 * `timeScale` multiplies the amount of simulated time a frame covers. `FireSim.step` has
 * always spent that as SUBSTEPS of the frame's own dt, so the surface solver's answer does not
 * depend on how fast the clock is running. The canopy and the smoke field took the whole
 * interval in a single step instead, so at the default 8x they integrated at 0.27 s where the
 * fire driving them integrated at 0.033 s, and at 16x more than half a second. Same total time,
 * different answer.
 *
 * 1/30 s is the frame dt those solvers were written against, so this is not a new tuning
 * parameter — it is the number that makes all three subsystems step on one clock.
 */
export const MAX_SIM_SUBSTEP_S = 1 / 30

/**
 * Per-voxel canopy state. Packed; WP 3.1 owns the byte layout and must record the measured
 * footprint, because the spec's brick-pool sizing carries an open question — it was sized
 * from VOXEL occupancy while allocation happens at whole-brick granularity, so a thin
 * terrain-following canopy band may overflow rather than have headroom.
 */
export interface CanopyVoxel {
  readonly dryMass: KgPerSquareMetre
  readonly moisture: MoistureFraction
  readonly temperatureK: number
  readonly charFraction: number
  /** Leaf area density, m2/m3 — drives Beer-Lambert extinction for radiative transfer. */
  readonly leafAreaDensity: number
}

export type CrownFireClass = 'none' | 'passive' | 'active' | 'independent'

export interface CrownFireState {
  readonly classification: CrownFireClass
  /** Van Wagner critical surface intensity for crown initiation, kW/m. */
  readonly criticalIntensity: KilowattsPerMetre
  /** Fraction of crown fuel consumed, 0-1. */
  readonly crownFractionBurned: number
}

/** One airborne firebrand. WP 3.6 owns the GPU buffer layout. */
export interface FirebrandStats {
  readonly airborne: number
  readonly landed: number
  readonly ignitionsCaused: number
  readonly maxSpotDistanceM: Metres
}

