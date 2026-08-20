/**
 * Buffer layout and dispatch bookkeeping shared by `system.ts` (GPU) and the tests — WP 3.6.
 *
 * Pure, so the exact bytes the GPU will read are unit-testable without a device. M1 lost four
 * bugs to device-only code paths; a 48-byte struct with a packed nibble field is precisely the
 * kind of thing that goes wrong silently.
 */

import type { BrandClass, BrandShape } from './brands.ts'
import { SHAPES, SHAPE_BY_CODE, arealDensity, beta0For } from './brands.ts'

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * 2¹⁷ slots × 64 B = 8.4 MB, against an 8 GB budget. Irrelevant, so it is not a tunable.
 *
 * 64 B and not §4.1's 48 B: the frozen contract publishes `FirebrandStats.maxSpotDistanceM`,
 * which needs each brand's spawn XY, and the 48 B layout has nowhere to put it. Rounding the
 * struct to 64 B costs 2.1 MB of VRAM and 4 MB/s of bandwidth at the solver rate — both far
 * below anything measurable — where the alternative was dropping a field the contract requires.
 */
export const BRAND_POOL = 131072
export const BRAND_STRIDE_BYTES = 64
export const BRAND_STRIDE_F32 = BRAND_STRIDE_BYTES / 4
export const BRAND_POOL_BYTES = BRAND_POOL * BRAND_STRIDE_BYTES

export const INTEGRATE_WORKGROUP = 256
/**
 * Emitters are capped so the whole spawn stage — count, exclusive scan, and the scatter —
 * fits in ONE workgroup and therefore ONE dispatch. See the cost note in `system.ts`: the
 * measured bound on this pass is per-dispatch overhead, not per-brand work, so collapsing
 * three scan dispatches into one is worth far more than any amount of arithmetic tuning.
 */
export const MAX_EMITTERS = 4096
export const SPAWN_WORKGROUP = 256
export const EMITTERS_PER_THREAD = MAX_EMITTERS / SPAWN_WORKGROUP

/** `f32` fields per emitter record: pos.xyz, massLossRate, classIndex, yieldMul, 2 pad. */
export const EMITTER_STRIDE_F32 = 8
export const EMITTER_STRIDE_BYTES = EMITTER_STRIDE_F32 * 4

/** `f32` fields per brand-class record; must match `struct BrandClass` in the shader. */
export const CLASS_STRIDE_F32 = 8

// ---------------------------------------------------------------------------
// `Brand.packed` — shape:4 | fuel:4 | biome:4 | flags:4 | rngSeed:16
// ---------------------------------------------------------------------------

export const FLAG_ALIVE = 0x1
export const FLAG_FLAMING = 0x2
export const FLAG_LANDED = 0x4
export const FLAG_EXITED_DOMAIN = 0x8

export interface PackedFields {
  readonly shape: BrandShape
  readonly fuel: number
  readonly biome: number
  readonly flags: number
  readonly rngSeed: number
}

export function packBrandBits(f: PackedFields): number {
  const nib = (v: number): number => v & 0xf
  return (
    ((nib(SHAPES[f.shape].code) |
      (nib(f.fuel) << 4) |
      (nib(f.biome) << 8) |
      (nib(f.flags) << 12) |
      ((f.rngSeed & 0xffff) << 16)) >>>
      0)
  )
}

export function unpackBrandBits(p: number): PackedFields {
  const code = p & 0xf
  return {
    shape: SHAPE_BY_CODE[code] ?? 'plate',
    fuel: (p >>> 4) & 0xf,
    biome: (p >>> 8) & 0xf,
    flags: (p >>> 12) & 0xf,
    rngSeed: (p >>> 16) & 0xffff,
  }
}

export const isAliveBits = (p: number): boolean => (((p >>> 12) & 0xf) & FLAG_ALIVE) !== 0

// ---------------------------------------------------------------------------
// Class table
// ---------------------------------------------------------------------------

/**
 * Pack the §2.1 brand-class table for the shader.
 *
 * σ and β₀ are precomputed here rather than in WGSL, per §0.5.1: a published constant costs
 * the same right as wrong, and doing the k_shape branch once on the CPU removes it from the
 * per-brand inner loop entirely. `aMin`/`aMax` are the power-law truncation converted from the
 * table's masses to projected AREAS, which is the quantity the −2 exponent applies to.
 */
export function packBrandClasses(classes: readonly BrandClass[]): Float32Array {
  if (classes.length === 0) throw new Error('packBrandClasses: empty table')
  if (classes.length > 16) throw new Error('packBrandClasses: class index is a 4-bit nibble')
  const out = new Float32Array(classes.length * CLASS_STRIDE_F32)
  classes.forEach((c, i) => {
    const sigma = arealDensity(c.shape, c.halfThk)
    const base = i * CLASS_STRIDE_F32
    out[base + 0] = c.halfThk
    out[base + 1] = sigma
    out[base + 2] = SHAPES[c.shape].cd
    out[base + 3] = beta0For(c)
    out[base + 4] = c.massMin / sigma // A_min, m²
    out[base + 5] = c.massMax / sigma // A_max, m²
    out[base + 6] = c.brandsPerKg
    out[base + 7] = SHAPES[c.shape].code
  })
  return out
}

// ---------------------------------------------------------------------------
// Ring allocation and population control (§4.2)
// ---------------------------------------------------------------------------

/**
 * Slot for the k-th brand of an emitter whose exclusive-scan base is `base`.
 *
 * We allocate from a ring rather than from a free list. The free list plus alive-compaction
 * that §4.2 describes costs six extra dispatches and two 0.5 MB buffers to save work in a pass
 * whose cost is not per-brand — so it buys nothing here and is not implemented. The ring is
 * equally deterministic (no atomics, prefix-sum offsets only) and the wrap is bounded by the
 * population control below.
 */
export const ringIndex = (cursor: number, base: number, k: number): number =>
  (cursor + base + k) % BRAND_POOL

export interface PopulationControl {
  /** Multiplicity to stamp on brands spawned this step. */
  readonly weight: number
  /** Brands actually spawned. */
  readonly spawn: number
}

/**
 * §4.2: when demand exceeds the pool we do not grow the pool and we do not drop the fire's
 * brand flux on the floor. We double the super-particle weight and halve the count, repeatedly,
 * until it fits. Cost stays flat; statistical resolution degrades gracefully. This is what keeps
 * a Black Saturday-scale dense-spotting scenario from falling off a cliff.
 */
export function populationControl(demand: number, capacity: number, weight = 1): PopulationControl {
  let w = Math.max(1, weight)
  let n = Math.max(0, Math.floor(demand))
  const cap = Math.max(0, Math.floor(capacity))
  // 24 doublings takes any demand representable in f32 counts under any positive capacity.
  for (let i = 0; i < 24 && n > cap; i++) {
    w *= 2
    n = Math.floor(n / 2)
  }
  return { weight: w, spawn: Math.min(n, cap) }
}

// ---------------------------------------------------------------------------
// Indirect dispatch
// ---------------------------------------------------------------------------

/**
 * Clamp for `dispatchWorkgroupsIndirect`.
 *
 * **Not defensive programming.** Per WebGPU §16.1.2 an indirect workgroup count exceeding
 * `maxComputeWorkgroupsPerDimension` causes the dispatch to be *silently skipped in its
 * entirety* on the queue timeline — not clamped, not an error, no validation at encode time.
 * The symptom is brands that stop moving, with nothing in the console. The shader that writes
 * the args applies the identical `min`; this is its CPU mirror and the thing the test asserts.
 */
export function clampIndirectWorkgroups(workgroups: number, maxPerDim: number): number {
  if (!Number.isFinite(workgroups) || workgroups <= 0) return 0
  return Math.min(Math.floor(workgroups), Math.max(1, Math.floor(maxPerDim)))
}

/** Workgroups needed to cover the used prefix of the ring, clamped to the pool. */
export function integrateWorkgroups(highWater: number, maxPerDim: number): number {
  const slots = Math.min(Math.max(0, Math.floor(highWater)), BRAND_POOL)
  return clampIndirectWorkgroups(Math.ceil(slots / INTEGRATE_WORKGROUP), maxPerDim)
}
