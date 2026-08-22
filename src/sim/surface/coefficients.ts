/**
 * The §4.3 critical optimisation, made concrete.
 *
 * Every σ-dependent coefficient — `β_op`, `A`, `Γ′_max`, `ξ`, `C`, `B`, `E`, `ε`, `η_s`,
 * `t_r`, and Albini's size-class weights — depends only on the fuel model, never on the cell.
 * They are evaluated here, on the CPU, once at load, and uploaded as a read-only storage
 * buffer. The shader does no `exp`, no size-class binning and no surface-area weighting.
 *
 * **Dynamic models shift σ with curing**, because the transferred herbaceous load carries
 * `σ_herb` rather than `σ_1h`. So the table is a 16-entry LUT over cure fraction per model,
 * and the shader lerps. Static models get 16 identical entries — which costs 15 × 128 B per
 * model (≈ 80 KB across the whole table) and buys a shader with no branch on model type at
 * all: `cure` is computed unconditionally from live herbaceous moisture and the lerp is a
 * no-op where it does not apply.
 *
 * Uniform vs storage: the assignment says "uniform array", but at 53 models × 16 bins × 128 B
 * the table is ~108 KB and `maxUniformBufferBindingSize` defaults to 64 KiB. It is bound as a
 * read-only storage buffer instead. Access is fully broadcast — every thread in a workgroup
 * reads the same record whenever the fuel map is locally uniform, which it is everywhere
 * except at biome boundaries — so it lands in the same caches a uniform would.
 */

import { buildCoefficients } from './rothermel.ts'
import type { RothermelCoefficients } from './rothermel.ts'
import type { FuelModelTable } from '@sim/rothermel/fuelModels.ts'
import { NON_BURNABLE_ID } from '@sim/rothermel/fuelModels.ts'

/** Cure bins per fuel model. 16 gives 6.7% resolution in cure, well under the noise in it. */
export const CURE_BINS = 16
/** vec4 count per record. Power of two so the stride is cache-line friendly. */
export const COEFF_VEC4S = 8
export const COEFF_FLOATS = COEFF_VEC4S * 4
export const COEFF_BYTES = COEFF_FLOATS * 4

export interface CoefficientLut {
  /** Ready to `writeBuffer` into a read-only storage buffer. */
  readonly data: Float32Array<ArrayBuffer>
  /** `fuelModelId` byte value → fuel model code. Index 0 is the non-burnable record. */
  readonly order: readonly string[]
  /** Number of (model, cureBin) records. */
  readonly recordCount: number
  readonly byteLength: number
  /** CPU-side mirror, so the oracle can read exactly what the GPU reads. */
  readonly records: readonly RothermelCoefficients[]
}

/** Where `fuelModelId` = id and cure ∈ [0,1] lands in the table. */
export const lutIndex = (fuelModelId: number, bin: number): number => fuelModelId * CURE_BINS + bin

/** Everything zero: `R = 0`, no divide by zero. `fuelModelId = 0` maps here. */
const NON_BURNABLE: RothermelCoefficients = {
  gammaEtaS: 0,
  wnDeadH: 0,
  wnLiveH: 0,
  xiOverRhoB: 0,
  kHeat: [0, 0, 0, 0, 0],
  kHeatQ0: 1,
  mxDead: 1,
  mxLiveW: 0,
  fDead: [0, 0, 0],
  fLive: [0, 0],
  wpDead: [0, 0, 0],
  windC: 0,
  windB: 1,
  windInvB: 1,
  slopeK: 0,
  residenceSeconds: 1,
  savFt: 1,
  beta: 0,
  betaRatio: 0,
  rhoB: 1,
  reactionVelocity: 0,
  xi: 0,
}

/** Pack one record. **Must match `FuelCoeff` in shaders/sim/surface/common.wgsl.** */
export function packCoefficients(c: RothermelCoefficients, out: Float32Array, at: number): void {
  out[at + 0] = c.gammaEtaS
  out[at + 1] = c.wnDeadH
  out[at + 2] = c.wnLiveH
  out[at + 3] = c.xiOverRhoB

  out[at + 4] = c.kHeat[0]
  out[at + 5] = c.kHeat[1]
  out[at + 6] = c.kHeat[2]
  out[at + 7] = c.kHeat[3]

  out[at + 8] = c.kHeat[4]
  out[at + 9] = c.kHeatQ0
  out[at + 10] = c.mxDead
  out[at + 11] = c.mxLiveW

  out[at + 12] = c.fDead[0]
  out[at + 13] = c.fDead[1]
  out[at + 14] = c.fDead[2]
  out[at + 15] = c.fLive[0]

  out[at + 16] = c.fLive[1]
  out[at + 17] = c.wpDead[0]
  out[at + 18] = c.wpDead[1]
  out[at + 19] = c.wpDead[2]

  out[at + 20] = c.windC
  out[at + 21] = c.windB
  out[at + 22] = c.windInvB
  out[at + 23] = c.slopeK

  out[at + 24] = c.residenceSeconds
  out[at + 25] = c.savFt
  out[at + 26] = 0
  out[at + 27] = 0
  // 28..31 reserved — keeps the stride at 128 B and leaves room for WP 2.4's burnout
  // timescales without changing the binding layout.
}

/**
 * Build the whole table. `order` is the meaning of the `fuelModelId` byte in the packed cell
 * state, so it must be stable for a given world — it is derived from `table.codes`, which
 * WP 2.1 will supply in a fixed order.
 */
export function buildCoefficientLut(table: FuelModelTable): CoefficientLut {
  const order = ['<non-burnable>', ...table.codes]
  const recordCount = order.length * CURE_BINS
  const data = new Float32Array(recordCount * COEFF_FLOATS)
  const records: RothermelCoefficients[] = new Array(recordCount)

  for (let id = 0; id < order.length; id++) {
    for (let bin = 0; bin < CURE_BINS; bin++) {
      const cure = bin / (CURE_BINS - 1)
      const c =
        id === NON_BURNABLE_ID ? NON_BURNABLE : buildCoefficients(table.get(order[id]!), cure)
      const at = lutIndex(id, bin)
      records[at] = c
      packCoefficients(c, data, at * COEFF_FLOATS)
    }
  }

  return { data, order, recordCount, byteLength: data.byteLength, records }
}

/**
 * The CPU mirror of the shader's LUT fetch: pick the two bracketing cure bins and lerp.
 *
 * This is what makes the GPU test meaningful — the oracle must interpolate the same way the
 * shader does, or every dynamic-model comparison fails on the interpolation rather than on
 * the physics. Static models have identical bins, so the lerp is exact for them regardless.
 */
export function sampleLut(lut: CoefficientLut, fuelModelId: number, cure: number): RothermelCoefficients {
  const t = Math.min(1, Math.max(0, cure)) * (CURE_BINS - 1)
  const i0 = Math.min(CURE_BINS - 2, Math.floor(t))
  const f = Math.min(1, Math.max(0, t - i0))
  const a = lut.records[lutIndex(fuelModelId, i0)]!
  const b = lut.records[lutIndex(fuelModelId, i0 + 1)]!
  const mix = (x: number, y: number) => x + (y - x) * f
  return {
    gammaEtaS: mix(a.gammaEtaS, b.gammaEtaS),
    wnDeadH: mix(a.wnDeadH, b.wnDeadH),
    wnLiveH: mix(a.wnLiveH, b.wnLiveH),
    xiOverRhoB: mix(a.xiOverRhoB, b.xiOverRhoB),
    kHeat: [
      mix(a.kHeat[0], b.kHeat[0]),
      mix(a.kHeat[1], b.kHeat[1]),
      mix(a.kHeat[2], b.kHeat[2]),
      mix(a.kHeat[3], b.kHeat[3]),
      mix(a.kHeat[4], b.kHeat[4]),
    ],
    kHeatQ0: mix(a.kHeatQ0, b.kHeatQ0),
    mxDead: mix(a.mxDead, b.mxDead),
    mxLiveW: mix(a.mxLiveW, b.mxLiveW),
    fDead: [mix(a.fDead[0], b.fDead[0]), mix(a.fDead[1], b.fDead[1]), mix(a.fDead[2], b.fDead[2])],
    fLive: [mix(a.fLive[0], b.fLive[0]), mix(a.fLive[1], b.fLive[1])],
    wpDead: [
      mix(a.wpDead[0], b.wpDead[0]),
      mix(a.wpDead[1], b.wpDead[1]),
      mix(a.wpDead[2], b.wpDead[2]),
    ],
    windC: mix(a.windC, b.windC),
    windB: mix(a.windB, b.windB),
    windInvB: mix(a.windInvB, b.windInvB),
    slopeK: mix(a.slopeK, b.slopeK),
    residenceSeconds: mix(a.residenceSeconds, b.residenceSeconds),
    savFt: mix(a.savFt, b.savFt),
    beta: mix(a.beta, b.beta),
    betaRatio: mix(a.betaRatio, b.betaRatio),
    rhoB: mix(a.rhoB, b.rhoB),
    reactionVelocity: mix(a.reactionVelocity, b.reactionVelocity),
    xi: mix(a.xi, b.xi),
  }
}
