/**
 * WP 3.3 — turning fire state into the clustered emitter list the gather reads.
 *
 * Two emitter kinds, one representation:
 *
 * - **Surface flame panels.** Each active 0.5 m surface cell becomes a wind-tilted flame
 *   sheet of height L_f (Byram) and width `dx`, radiating eps_f*sigma*T_f^4 (§7.3, §7.4).
 * - **Flaming canopy voxels.** A 2 m voxel radiating from its own optical depth (§7.3),
 *   which is what gives crown-to-crown coupling — §7.7 calibration step 4.
 *
 * Both reduce to an isotropic point source of total power W at a position. **Isotropic is
 * deliberate, and the forward bias is not lost.** A flame sheet radiates symmetrically about
 * its own plane, so its L1 directional moment is zero to begin with; the reason a tilted
 * flame preheats forward is that its radiating mass is physically *displaced downwind and
 * up*, which we capture exactly by placing the emitter at the flame's mid-height along the
 * tilted axis rather than at the ground. That is geometrically true, costs one `mix`, and
 * removes three floats per cluster and a dot product per receiver-cluster pair.
 *
 * Clustering is a plain 16 m bin (see `layout.ts` for why 16 m). Each bin keeps its
 * power-weighted centroid and the power-weighted mean square spread `a^2` about that
 * centroid, which is what softens the point source back to a finite emitter in the gather.
 * `a^2` is a variance, so bins compose by the standard decomposition and an isolated single
 * emitter gets `a^2` equal to its own extent — an isolated torching tree stays a compact
 * source rather than being smeared to the bin size.
 */

import { flameLength } from '@sim/rothermel/kernel.ts'
import type { KilowattsPerMetre, Kelvin, Metres, PerMetre, Radians } from '@contracts/units'
import { m } from '@contracts/units'
import {
  DEFAULT_FLAME_ABSORPTION,
  DEFAULT_FLAME_TEMPERATURE_K,
  MAX_RADIANT_FRACTION,
  blackbodyEmissivePower,
  flameEmissivity,
  volumeEmitterPower,
} from './optics.ts'
import {
  EMIT_CELL_M,
  EMIT_CLUSTER_CAP,
  EMIT_NI,
  EMIT_NJ,
  EMIT_NK,
  A2_MIN,
  OVERFLOW_A2,
  OVERFLOW_CENTRE_X,
  OVERFLOW_CENTRE_Y,
  OVERFLOW_CENTRE_Z,
  OVERFLOW_POWER_SHIFT,
  POSITION_BIAS_M,
  POSITION_FIXED_SCALE,
  POWER_FIXED_SCALE,
} from './layout.ts'

/** An emitter reduced to what the gather needs. World coords, +y up. */
export interface EmitterSample {
  readonly x: number
  readonly y: number
  readonly z: number
  /** Total radiant power into 4*pi steradians, W. */
  readonly powerW: number
  /** RMS radius of this emitter about its own centroid, m. Keeps small sources compact. */
  readonly radiusM: number
}

/** One compacted cluster. Mirrors the 32 B GPU record: vec4(x,y,z,P) + vec4(a2, pad). */
export interface RadCluster {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly powerW: number
  /** Power-weighted mean square spread about the centroid, m^2. Softens the 1/r^2 pole. */
  readonly a2: number
}

// ---------------------------------------------------------------------------
// Surface flame panels
// ---------------------------------------------------------------------------

export interface SurfaceFlameInput {
  /** Cell centre on the ground, world m. */
  readonly x: number
  readonly z: number
  readonly groundY: number
  /** Byram fireline intensity of this cell, kW/m. Comes from `IFireOutputs.intensityTexture`. */
  readonly intensity: KilowattsPerMetre
  /** Surface cell size, m. 0.5 on the project grid. */
  readonly cellM: Metres
  /**
   * Flame depth D = R * t_r, m. §7.3's eps_f = 1 - exp(-k_f*D) needs it.
   *
   * **`IFireOutputs` exposes neither rate of spread nor residence time**, only intensity,
   * state, arrival time and consumed fraction, so at present this must be supplied by the
   * caller or left at `DEFAULT_FLAME_DEPTH_M`. The default is an engineering estimate and is
   * recorded as such in `provenance.ts`. It is not free of consequence but it is bounded:
   * only the product k_f*D enters, and k_f is §7.7's calibration knob #1, so a systematic
   * bias in D is absorbed by the fit rather than left in the physics.
   */
  readonly flameDepth?: Metres
  /** Flame tilt from vertical, radians. 0 = upright. From the meteorology module at M5. */
  readonly tilt: Radians
  /** Direction the flame leans, radians, world x-z plane (0 = +x). */
  readonly heading: Radians
}

/** §7.3's k_f is uncertain to a factor of 5; D at least is order-1 for a surface fire. */
export const DEFAULT_FLAME_DEPTH_M = m(1.0)

export interface FlameOptics {
  readonly flameAbsorption: PerMetre
  readonly flameTemperature: Kelvin
}

export const DEFAULT_FLAME_OPTICS: FlameOptics = {
  flameAbsorption: DEFAULT_FLAME_ABSORPTION,
  flameTemperature: DEFAULT_FLAME_TEMPERATURE_K,
}

/**
 * One active surface cell -> one point emitter at the flame's radiative mid-height.
 *
 * Power is the single-sided panel `eps_f * sigma * T_f^4 * (L_f * dx)`. Single-sided because
 * the downward face radiates into ground and already-burnt fuel; the canopy only ever sees
 * the upper/forward face. It is then clamped to `MAX_RADIANT_FRACTION * I_B * dx`, which is
 * the guard that stops a bad D or L_f from letting the model radiate more energy than the
 * fire releases. Sanity check at §7.1's worked point (I = 875 kW/m, L_f = 1.75 m, D = 1.5 m):
 * the panel gives 288 kW per metre of front, a radiant fraction of 0.33 — inside the
 * measured 0.15-0.35 band, so the clamp does not bind on plausible inputs.
 */
export function surfaceFlameEmitter(
  cell: SurfaceFlameInput,
  optics: FlameOptics = DEFAULT_FLAME_OPTICS,
): EmitterSample {
  const lf = flameLength(cell.intensity)
  const depth = cell.flameDepth ?? DEFAULT_FLAME_DEPTH_M
  const eps = flameEmissivity(depth, optics.flameAbsorption)
  const panel = eps * blackbodyEmissivePower(optics.flameTemperature) * lf * cell.cellM
  // I_B is kW per metre of front; a cell contributes `cellM` metres of front.
  const cap = MAX_RADIANT_FRACTION * cell.intensity * 1000 * cell.cellM
  const powerW = Math.min(panel, Math.max(0, cap))

  // Radiative centroid: half way up the tilted flame axis. This is the whole of the
  // downwind-preheating asymmetry, and it is free.
  const half = 0.5 * lf
  const sinT = Math.sin(cell.tilt)
  return {
    x: cell.x + half * sinT * Math.cos(cell.heading),
    y: cell.groundY + half * Math.cos(cell.tilt),
    z: cell.z + half * sinT * Math.sin(cell.heading),
    powerW,
    // RMS radius of a uniform L_f by dx rectangle about its centre.
    radiusM: Math.sqrt((lf * lf + cell.cellM * cell.cellM) / 12),
  }
}

/**
 * One flaming canopy voxel -> one point emitter at its centre. `kappa` is the voxel's own
 * §7.3 extinction, so an optically thin crown emits proportionally less than a dense one.
 */
export function canopyVoxelEmitter(
  x: number,
  y: number,
  z: number,
  kappa: PerMetre,
  temperature: Kelvin,
  cellM: Metres,
): EmitterSample {
  return {
    x,
    y,
    z,
    powerW: volumeEmitterPower(kappa, temperature, cellM),
    // RMS radius of a uniform cube of side s about its centre: 3*(s^2/12) -> s/2.
    radiusM: cellM / 2,
  }
}

// ---------------------------------------------------------------------------
// Fixed-point mirror of the GPU scatter
// ---------------------------------------------------------------------------

/** u32 ceiling. The scatter saturates rather than wrapping; wrapping would create energy. */
const U32_MAX = 0xffffffff

/**
 * Quantise a power into the u32 fixed-point units the WGSL atomics use (100 W per unit).
 * Saturating here, so a pathological single emitter can only under-report; the *sum* has no
 * such guard on the GPU (`atomicAdd` wraps) and is protected by headroom instead — see
 * `POWER_FIXED_SCALE`. `Math.round` matches WGSL's `u32(x + 0.5)` for non-negative x.
 */
export function quantisePower(powerW: number): number {
  if (!(powerW > 0)) return 0
  return Math.min(U32_MAX, Math.round(powerW * POWER_FIXED_SCALE))
}

/** Inverse of `quantisePower`. */
export function dequantisePower(q: number): number {
  return q / POWER_FIXED_SCALE
}

/**
 * Largest bin power, in u32 units, before the first-moment slot can wrap. `atomicAdd` in
 * WGSL wraps rather than saturating, and a wrapped moment would put a cluster in the wrong
 * place with the wrong power, so this bound is the thing the fixed-point scales are chosen
 * against and `emitters.test.ts` asserts it against a reasoned worst-case bin.
 */
export const BIN_POWER_UNITS_LIMIT = Math.floor(
  U32_MAX / (2 * POSITION_BIAS_M * POSITION_FIXED_SCALE),
)

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export interface ClusterOptions {
  /** World coords of grid cell (0,0,0)'s minimum corner. */
  readonly originX: number
  readonly originY: number
  readonly originZ: number
  readonly cellM: number
  readonly ni: number
  readonly nj: number
  readonly nk: number
  readonly cap: number
  /** Bins below this u32 power weight go to the catch-all. Retuned per step; see below. */
  readonly minBinUnits: number
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  originX: 0,
  originY: 0,
  originZ: 0,
  cellM: EMIT_CELL_M,
  ni: EMIT_NI,
  nj: EMIT_NJ,
  nk: EMIT_NK,
  cap: EMIT_CLUSTER_CAP,
  minBinUnits: 1,
}

export interface ClusterResult {
  readonly clusters: readonly RadCluster[]
  /** Bins that did not fit the cap and were folded into the last (catch-all) cluster. */
  readonly overflowBins: number
  /** Emitters that fell outside the grid and were dropped. Should be 0 in a valid world. */
  readonly outOfBounds: number
  /** Sum of quantised emitter power, W. The gather's total can never exceed this. */
  readonly totalPowerW: number
  /** Largest bin weight reached, u32 units. Compare against `BIN_POWER_UNITS_LIMIT`. */
  readonly peakBinUnits: number
  /** `minBinUnits` for the next step, from the same controller `finalise()` runs. */
  readonly nextMinBinUnits: number
}

/** The five u32 slots of one emitter grid bin, exactly as the WGSL atomics hold them. */
export interface BinAccum {
  power: number
  mx: number
  my: number
  mz: number
  m2: number
}

/**
 * Bin emitters into `cellM` cells, then compact. **This is the exact CPU oracle for
 * `clusters.wgsl`** — it runs the same u32 fixed-point arithmetic the GPU atomics do, so a
 * scale that overflows or a decode that is off by the bias fails here, on the CLI, rather
 * than as a misplaced hot spot on a device nobody is profiling.
 *
 * Moments are taken about the *bin centre*, not the origin: that is what keeps the operands
 * small enough for u32, and the centroid comes back out by the parallel-axis theorem.
 *
 * Overflow past `cap` folds the surplus bins into one catch-all cluster carrying their
 * combined power, centroid and spread. Energy is conserved exactly; what is lost is the
 * *structure* of the surplus, and because the catch-all's `a^2` spans many bins its softened
 * flux is an under-estimate. One-sided in the safe direction, like everything else here.
 */
export function buildClusters(
  samples: Iterable<EmitterSample>,
  opts: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): ClusterResult {
  const bins = new Map<number, BinAccum>()
  let outOfBounds = 0
  let totalPowerW = 0
  let peakBinUnits = 0

  for (const s of samples) {
    const q = quantisePower(s.powerW)
    if (q <= 0) continue
    const i = Math.floor((s.x - opts.originX) / opts.cellM)
    const j = Math.floor((s.z - opts.originZ) / opts.cellM)
    const k = Math.floor((s.y - opts.originY) / opts.cellM)
    if (i < 0 || j < 0 || k < 0 || i >= opts.ni || j >= opts.nj || k >= opts.nk) {
      outOfBounds++
      continue
    }
    totalPowerW += dequantisePower(q)
    const key = i + j * opts.ni + k * opts.ni * opts.nj
    let b = bins.get(key)
    if (b === undefined) {
      b = { power: 0, mx: 0, my: 0, mz: 0, m2: 0 }
      bins.set(key, b)
    }
    const c = binCentre(key, opts)
    const dx = s.x - c.x
    const dy = s.y - c.y
    const dz = s.z - c.z
    b.power += q
    b.mx += q * posUnits(dx)
    b.my += q * posUnits(dy)
    b.mz += q * posUnits(dz)
    b.m2 += q * Math.round(dx * dx + dy * dy + dz * dz + s.radiusM * s.radiusM)
    if (b.power > peakBinUnits) peakBinUnits = b.power
  }

  // Grid-scan order: what the GPU compaction produces modulo atomic arrival. The gather is
  // order-independent, so this only matters for reproducible tests and for which bins land
  // in the overflow catch-all.
  const keys = [...bins.keys()].sort((x, y) => x - y)
  const clusters: RadCluster[] = []
  let overflowBins = 0
  let overflowUnits = 0
  for (const key of keys) {
    const b = bins.get(key)!
    if (b.power >= opts.minBinUnits && clusters.length < opts.cap - 1) {
      clusters.push(decodeBin(b, binCentre(key, opts)))
    } else {
      overflowBins++
      overflowUnits += b.power >> OVERFLOW_POWER_SHIFT
    }
  }
  if (overflowBins > 0 && overflowUnits > 0) {
    clusters.push({
      x: OVERFLOW_CENTRE_X,
      y: OVERFLOW_CENTRE_Y,
      z: OVERFLOW_CENTRE_Z,
      powerW: dequantisePower(overflowUnits * 2 ** OVERFLOW_POWER_SHIFT),
      a2: OVERFLOW_A2,
    })
  }

  let nextMinBinUnits = Math.max(1, opts.minBinUnits)
  if (overflowBins > 0) nextMinBinUnits *= 2
  else if (clusters.length * 2 < opts.cap) nextMinBinUnits = Math.max(1, nextMinBinUnits / 2)

  return {
    clusters,
    overflowBins,
    outOfBounds,
    totalPowerW,
    peakBinUnits,
    nextMinBinUnits,
  }
}

/** Bias-and-scale a bin-relative offset into the non-negative u32 the WGSL atomics take. */
function posUnits(offsetM: number): number {
  return Math.round((offsetM + POSITION_BIAS_M) * POSITION_FIXED_SCALE)
}

function binCentre(key: number, o: ClusterOptions): { x: number; y: number; z: number } {
  const i = key % o.ni
  const j = Math.floor(key / o.ni) % o.nj
  const k = Math.floor(key / (o.ni * o.nj))
  return {
    x: o.originX + (i + 0.5) * o.cellM,
    y: o.originY + (k + 0.5) * o.cellM,
    z: o.originZ + (j + 0.5) * o.cellM,
  }
}

/** Fixed-point bin -> cluster. Mirrors `decodeBin` in clusters.wgsl exactly. */
export function decodeBin(b: BinAccum, centre: { x: number; y: number; z: number }): RadCluster {
  const inv = 1 / b.power
  const dx = (b.mx * inv) / POSITION_FIXED_SCALE - POSITION_BIAS_M
  const dy = (b.my * inv) / POSITION_FIXED_SCALE - POSITION_BIAS_M
  const dz = (b.mz * inv) / POSITION_FIXED_SCALE - POSITION_BIAS_M
  // Parallel axis: Var about the centroid = E[r^2 about the bin centre] - |centroid offset|^2.
  const a2 = b.m2 * inv - (dx * dx + dy * dy + dz * dz)
  return {
    x: centre.x + dx,
    y: centre.y + dy,
    z: centre.z + dz,
    powerW: dequantisePower(b.power),
    a2: Math.max(A2_MIN, a2),
  }
}
