/**
 * WP 3.3 — canopy radiative transfer. Grid sizes, formats, rates and quality tiers.
 *
 * Every number the WGSL and the TypeScript oracle must agree on is defined here once and
 * emitted into the shader prelude by `shaders.ts`, so there is no second copy to drift.
 *
 * ## Why this is not the pipeline spec §7.4 recommends
 *
 * §7.4 recommends cone-traced gathering into an L1 SH volume: rasterise emission AND
 * extinction into a 256x256x32 pair-texture, build 5 mips, march 8 jittered cones per cell,
 * project to 4 SH coefficients, then add an analytic near-field panel term. We ship a
 * cheaper scheme — **next-event estimation against a clustered emitter list** — because in
 * this problem the cone tracer's one advantage does not apply:
 *
 * - Cone tracing's selling point is that cost is independent of emitter count. Our emitters
 *   are already compacted by the surface active set (WP 2.3) into a few thousand cells and
 *   bin down to a few hundred 16 m clusters, so that independence buys nothing.
 * - A cone that must *find* the flame by sampling the sphere carries emitter-finding
 *   variance. That is exactly the variance §6.7 warns biases crown initiation EARLY at low
 *   ray counts. In NEE every ray is aimed at a real emitter, so there is no such variance;
 *   the residual error is a one-sided *deficit* (see `gather.ts`), which biases initiation
 *   LATE — the safe direction.
 * - It removes three things entirely: the emission rasterisation, the mip-chain build (the
 *   extinction field is static, §7.2 pool B), and the separate near-field analytic panel
 *   pass. It also drops the SH volume from 4 coefficients to 1, which §7.3's own spherical
 *   leaf-angle assumption (G = 0.5, no receiver anisotropy) already justifies.
 *
 * VRAM: extinction 4.19 MB + irradiance 4.19 MB + cluster list 32 KB + emitter accumulation
 * grid 0.65 MB = **9.1 MB**, against §7.2's 33.6 MB (double-buffered SH) + 9.6 MB (mipped
 * pair pyramid) = 43.2 MB for the recommended pipeline. Saves ~34 MB.
 *
 * See `provenance.ts` for the accepted-error record and `gather.ts` for the bounds.
 */

import { CANOPY_CELL_M_3D, CANOPY_N_XY, CANOPY_N_Z } from '@contracts/sim'

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * Radiation works at half the canopy resolution: 4 m, matching §7.4 step 1. Two fields live
 * on it — extinction (input, static) and irradiance (output).
 *
 * The size is chosen so both fields stay resident in the 4070 Laptop's 32 MB L2. That is the
 * single decision that makes this pass sampler-bound rather than bandwidth-bound, which is
 * the bound the §6.3 open question asks us to identify. See `test/.../budget.test.ts`.
 */
/**
 * Axis convention, stated because the contract mixes two: `IgnitionShape` uses `x`/`z` for
 * the ground plane, so **world +y is up**, while `CANOPY_N_XY`/`CANOPY_N_Z` names the
 * vertical axis "Z". Everything in this module uses grid indices `(i, j, k)` with `i`,`j`
 * horizontal (world x, z) and `k` vertical (world y). Linear index = i + j*NI + k*NI*NJ.
 */
export const RAD_CELL_M = CANOPY_CELL_M_3D * 2
export const RAD_NI = CANOPY_N_XY / 2
export const RAD_NJ = CANOPY_N_XY / 2
export const RAD_NK = CANOPY_N_Z / 2
export const RAD_CELL_COUNT = RAD_NI * RAD_NJ * RAD_NK

/** m of world covered by the radiation grid: horizontal x, horizontal z, vertical y. */
export const RAD_EXTENT_X = RAD_NI * RAD_CELL_M
export const RAD_EXTENT_Z = RAD_NJ * RAD_CELL_M
export const RAD_EXTENT_Y = RAD_NK * RAD_CELL_M

/**
 * `r16float` for both. Extinction is 0..~5 m^-1 and irradiance is stored in **kW m^-2**, not
 * W m^-2, so it cannot overflow f16: a flame surface is 117.6 kW m^-2 against an f16 maximum
 * of 65504, six hundred times the headroom, at 0.05% relative precision. Storing W m^-2
 * would overflow at the flame sheet. Both formats need `texture-formats-tier1` for the
 * write-only storage binding, which the target adapter has.
 */
export const RAD_TEXTURE_FORMAT = 'r16float' as const

/** One brick (WP 3.1, 8^3 voxels = 16 m) is exactly 4^3 = 64 radiation cells. */
export const RAD_CELLS_PER_BRICK_AXIS = 4
export const GATHER_WORKGROUP = RAD_CELLS_PER_BRICK_AXIS ** 3

// ---------------------------------------------------------------------------
// Emitter clustering
// ---------------------------------------------------------------------------

/**
 * Emitters bin into 16 m cells — the same 64x64x8 = 32768 grid as §7.2's brick indirection.
 *
 * 16 m is the coarsest bin whose finite-size error is negligible where radiation actually
 * governs. Binning replaces a cluster of emitters by a point source with a softening radius
 * `a` (their power-weighted RMS spread), so irradiance goes as P/(4*pi*(r^2 + a^2)) instead
 * of P/(4*pi*r^2). With a ~ 4.6 m for a front segment filling one bin the deficit is 5% at
 * 23 m, 1.3% at 46 m, and exact beyond. Inside ~10 m it exceeds 20% — and that is accepted,
 * because §7.5's own worked numbers put convective heating two to three orders of magnitude
 * above radiative heating in the near field (0.9 s to ignition immersed in plume gas versus
 * 470 s radiatively at 20 m). Radiation's job here is the drying front over minutes at
 * 20-100 m; the near field is convection's, and that is WP 3.4's.
 */
export const EMIT_CELL_M = 16
export const EMIT_NI = Math.round(RAD_EXTENT_X / EMIT_CELL_M)
export const EMIT_NJ = Math.round(RAD_EXTENT_Z / EMIT_CELL_M)
export const EMIT_NK = Math.round(RAD_EXTENT_Y / EMIT_CELL_M)
export const EMIT_GRID_CELLS = EMIT_NI * EMIT_NJ * EMIT_NK

/**
 * Cap on the compacted cluster list. Every receiver scans the whole list, so this is the
 * receiver's inner-loop trip count and the pass's ALU driver.
 *
 * 1024, and it was 512 until `budget.test.ts` measured the real thing: a 2 km perimeter with
 * a band of flaming crown behind it produces **417 bins**, not the ~125 that dividing 2000 m
 * by 16 m suggests. A curved front crossing a 16 m grid clips far more cells than its length
 * implies, and the crown band is a volume rather than a curve. 512 would have run at 81% of
 * capacity on an ordinary mature fire.
 *
 * Doubling it is close to free because the pass is sampler-bound, not ALU-bound: the scan
 * roughly doubles the ALU term while the binding sampler term does not move at all. On
 * overflow the excess power is folded into one far-field catch-all cluster (see
 * `emitters.ts`) rather than dropped, so energy is conserved and the error stays bounded.
 */
export const EMIT_CLUSTER_CAP = 1024

/**
 * Fixed-point scales for the emitter scatter. Core WGSL has no float atomics (§6.8 pitfall 3)
 * and `atomicAdd` **wraps** rather than saturating, so the headroom below is load-bearing:
 * an overflow does not error, it silently creates energy. `emitters.test.ts` asserts it.
 *
 * Worst-case bin, reasoned: a 16 m bin holds 32x32 = 1024 surface cells; at an extreme
 * 10 MW/m fireline intensity a 0.5 m cell's panel is ~272 kW, so 0.28 GW of surface. It also
 * holds 8^3 = 512 fully flaming 2 m canopy voxels at ~1.55 MW, so 0.79 GW of crown. Total
 * ~1.1e9 W.
 *
 * `POWER_FIXED_SCALE` = 0.005 u32 units per watt (1 unit = 200 W). The power slot itself has
 * enormous headroom at that scale; the binding slot is the second moment below, and
 * `emitters.test.ts` computes the worst-case bin from the real emitter functions rather than
 * from this paragraph, so the margin is checked rather than asserted.
 */
export const POWER_FIXED_SCALE = 0.005

/**
 * First position moments accumulate as power-weighted offsets from the bin centre, biased by
 * +EMIT_CELL_M/2 so they stay non-negative, at `POSITION_FIXED_SCALE` units per metre.
 * Range [0, 16] m * 4 = 64, and 0.25 m resolution on the centroid of a 16 m bin.
 */
export const POSITION_BIAS_M = EMIT_CELL_M / 2
export const POSITION_FIXED_SCALE = 4

/**
 * The second moment slot accumulates `P * round(r'^2)` with r'^2 up to (8*sqrt(3))^2 = 192.
 * It is the tightest of the five and it is what sets `POWER_FIXED_SCALE`: the reasoned
 * worst-case bin is 5.2e6 units, so the moment reaches 9.9e8 against a u32 ceiling of
 * 4.29e9 — 4.3x headroom. Its 1 m^2 resolution is too coarse for a single small emitter's
 * own extent, which `A2_MIN` covers instead.
 */

/**
 * Floor on a cluster's softening radius squared, m^2. Set to (RAD_CELL_M/2)^2 = 4: the
 * receiver is a 4 m cell, so an emitter sharper than half a cell carries no information the
 * grid can hold, and the standard regularisation is to stop resolving it. Flooring *softens*,
 * so it can only lose flux — the same one-sided direction as everything else in this package,
 * and it is why a weak emitter whose true extent quantises to zero cannot become a hot point
 * source that invents near-field flux.
 */
export const A2_MIN = (RAD_CELL_M / 2) ** 2

/** u32 slots per emitter grid cell: power, sum(P*dx'), sum(P*dy'), sum(P*dz'), sum(P*r'^2). */
export const EMIT_SLOTS = 5

/** Workgroup size for the scatter and compact dispatches. */
export const CLUSTER_WORKGROUP = 64

/**
 * Overflow catch-all. When more bins clear the threshold than the cap can hold, the surplus
 * keeps only its **power** and is placed at the domain centre with the domain's own second
 * moment: "the rest of the fire, smeared over the whole world".
 *
 * That is deliberately crude and it is the right crudeness. The threshold controller in
 * `clusters.wgsl` guarantees the surplus is the *weakest* bins, and smearing them over a
 * kilometre turns them into a near-uniform ambient term that cannot masquerade as a nearby
 * hot source. Keeping their centroid instead would need four more atomics carrying
 * domain-sized moment arms — which is precisely the arithmetic that wraps.
 *
 * a^2 is the second moment of a uniform box: (Lx^2 + Ly^2 + Lz^2)/12.
 *
 * The power accumulator is right-shifted by `OVERFLOW_POWER_SHIFT` before summing, because
 * the absolute worst case is every one of the 32768 bins overflowing at once, which at the
 * unshifted scale is 1.7e11 units against a u32 ceiling of 4.29e9. A shift of 8 brings that
 * to 6.7e8 with 6x to spare. The cost is 2^8 = 256 units = 51 kW of rounding per overflow
 * bin, always downwards — a deficit, on bins the threshold controller has already identified
 * as the weakest present.
 */
export const OVERFLOW_POWER_SHIFT = 8
export const OVERFLOW_CENTRE_X = RAD_EXTENT_X / 2
export const OVERFLOW_CENTRE_Y = RAD_EXTENT_Y / 2
export const OVERFLOW_CENTRE_Z = RAD_EXTENT_Z / 2
export const OVERFLOW_A2 =
  (RAD_EXTENT_X ** 2 + RAD_EXTENT_Y ** 2 + RAD_EXTENT_Z ** 2) / 12

/** u32 slots of the cluster-build state buffer: count, overflowBins, overflowPower, threshold. */
export const CLUSTER_STATE_SLOTS = 4

// ---------------------------------------------------------------------------
// Rays, taps and rate
// ---------------------------------------------------------------------------

/**
 * Ray count per quality level q in 0..5, from §6.7. **Floored at 8** — the controller's one
 * physics-adjacent knob, and it may not go below this.
 */
export const RAY_COUNTS: readonly number[] = [8, 8, 16, 16, 32, 32]
export const MIN_RAY_COUNT = 8

/**
 * Transmittance quadrature taps per ray: midpoint rule, evenly spaced along the segment,
 * trilinearly filtered from the 4 m extinction field. 16 matches §6.3's assumed ray budget.
 * Fixed, not a quality knob — halving it would save less than the sampler cost of one extra
 * ray while doubling the quadrature error on long paths.
 */
export const RAY_TAPS = 16

/**
 * Radiation field update rate, Hz. §7.4 says every 4th 30 Hz canopy step; we keep that.
 *
 * Staleness error: the field is at most 133 ms old. The fastest thing it must track is the
 * front's own motion, and at §0.5.1's extreme 1 m s^-1 head fire that is 0.133 m of emitter
 * displacement, i.e. dG/G = 2*dr/r = 1.3% at 20 m and 5.3% at 5 m. At a typical 0.05 m s^-1
 * it is 0.07% and 0.27%. Against a radiative preheating timescale of 10^2-10^3 s (§7.5) this
 * is nothing.
 *
 * Note this contradicts §6.3's pass table, which schedules `canopyRadiation` at rate 1/1 on
 * a 1/120 s substep — 120 Hz, sixteen times what §7.4 asks for. See `contract_issues`.
 */
export const RAD_UPDATE_HZ = 7.5
export const RAD_UPDATE_INTERVAL_S = 1 / RAD_UPDATE_HZ

/**
 * §7.4's temporal blend `G <- G + alpha*(G_new - G)` at alpha = 0.35 is **not implemented**,
 * and that is a decision rather than an omission.
 *
 * The blend exists to denoise a stochastic cone gather. Next-event estimation has no
 * emitter-finding noise, so it would buy only smoothing of the top-N selection flipping as
 * the front moves — and the tail correction already covers exactly the cluster that drops
 * out. The price would be a first-order lag of tau = 133 ms / 0.35 = 0.38 s, which is
 * *larger* than the staleness it would hide (0.38 m of front displacement at 1 m s^-1 versus
 * 0.13 m), plus a second 4.19 MB texture to ping-pong against, plus a `read_write` storage
 * texture, which is a non-core WGSL language feature.
 *
 * If a real run shows flicker, it is one `mix` and one texture. Until it does, this is dead
 * weight in the hottest pass in the milestone.
 */
export const TEMPORAL_BLEND_IMPLEMENTED = false
