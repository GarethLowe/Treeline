/**
 * WP 3.3 — the transport solve. Pure TypeScript; this is the oracle for `gather.wgsl`.
 *
 * ## What is computed
 *
 * For a receiving voxel at **x**, the spherically integrated incident irradiance
 *
 *   G(x) = integral over 4*pi of L(x, omega) d omega     [W m^-2]
 *
 * which is what §7.4's absorbed source `q''' = kappa*(G - 4*sigma*T_s^4)` consumes. For a
 * point emitter of power P at range r behind transmittance tau,
 *
 *   G = P * tau / (4*pi*r^2)
 *
 * and this form is **exactly** energy conserving in the continuum: integrating the absorbed
 * power kappa*G over all space in a uniform medium gives
 *   integral of kappa * P * exp(-kappa*r)/(4*pi*r^2) * 4*pi*r^2 dr  =  P.
 * Every joule the emitter releases is absorbed somewhere and no joule is invented. That is
 * the property `energy.test.ts` asserts numerically, and it is the reason this formulation
 * was preferred over a surface-to-surface view-factor sum, which conserves energy only after
 * the cos(theta_2) receiver term that a *volume* receiver does not have.
 *
 * ## The three approximations, and the direction each errs
 *
 * Every one of them loses flux. None can create it. That matters more than the magnitudes:
 * §6.7 warns that a noisy estimator biases crown initiation EARLY, which is the unsafe
 * direction because it manufactures crown fire that is not there. This estimator is biased
 * LATE.
 *
 * 1. **Finite-emitter softening.** A 16 m bin of emitters is a point source with a softening
 *    radius `a`: r^2 -> r^2 + a^2. Deficit 5% at r = 5a, 1.3% at 10a, and it grows without
 *    bound as r -> 0. With a ~ 4.6 m for a front segment filling a bin: 5% at 23 m, >20%
 *    inside 10 m. Accepted because §7.5's own worked numbers put convection two to three
 *    orders of magnitude above radiation inside 10 m.
 * 2. **Top-N ray budget with a path-corrected tail.** Only the `rayCount` brightest clusters
 *    get a real transmittance march. The rest are added back at `tauBar^(rTail/rTop)`, where
 *    tauBar is the power-weighted mean transmittance of the marched set and the exponent is
 *    the ratio of mean ranges. Since the unmarched tail is by construction dimmer and
 *    farther, the exponent is >= 1 and the estimate is <= tauBar. Without the exponent the
 *    tail *could* be over-estimated; with it, it cannot.
 * 3. **4 m extinction quadrature.** 16-tap midpoint rule on a trilinearly filtered 4 m field.
 *    Averaging kappa over 4 m under-shadows thin gaps — the standard voxel-cone-tracing
 *    trade (Crassin et al. 2011), which §7.4 already accepts for the recommended pipeline.
 *    Under-shadowing is the one term that could *raise* G, bounded by exp(-kappa_gap*L)
 *    versus exp(-kappa_mean*L); for a 2 m gap in a kappa = 0.6 canopy it is at most 3.3%.
 *
 * Net: bounded, and dominated by a one-sided deficit.
 */

import { EMIT_CLUSTER_CAP, MIN_RAY_COUNT, RAY_TAPS } from './layout.ts'
import type { RadCluster } from './emitters.ts'

// ---------------------------------------------------------------------------
// The extinction field
// ---------------------------------------------------------------------------

/**
 * A dense scalar field of kappa on the 4 m radiation grid. Deliberately small: at
 * 256x256x32 x f16 it is 4.19 MB and stays resident in the 4070 Laptop's 32 MB L2, which is
 * what makes the march sampler-bound rather than DRAM-bound. See `budget.test.ts`.
 *
 * Static after the world build (§7.2 pool B), so there is no per-step rasterisation and no
 * mip chain — two whole passes the §7.4 pipeline needs and this one does not.
 */
export interface ExtinctionField {
  readonly ni: number
  readonly nj: number
  readonly nk: number
  readonly cellM: number
  readonly originX: number
  readonly originY: number
  readonly originZ: number
  /** kappa in m^-1, indexed i + j*ni + k*ni*nj. */
  readonly kappa: Float32Array
}

export function emptyExtinctionField(
  ni: number,
  nj: number,
  nk: number,
  cellM: number,
  originX = 0,
  originY = 0,
  originZ = 0,
): ExtinctionField {
  return { ni, nj, nk, cellM, originX, originY, originZ, kappa: new Float32Array(ni * nj * nk) }
}

/**
 * Trilinear sample with clamp-to-edge, mirroring a `textureSampleLevel` on a 3D texture with
 * a linear filter and clamp addressing. Outside the grid horizontally this clamps (terrain
 * continues); above the grid it clamps too, and the top layer is empty air in any sane world
 * build, so clamping there is the same as returning zero.
 */
export function sampleExtinction(f: ExtinctionField, x: number, y: number, z: number): number {
  const fi = (x - f.originX) / f.cellM - 0.5
  const fj = (z - f.originZ) / f.cellM - 0.5
  const fk = (y - f.originY) / f.cellM - 0.5
  const i0 = Math.floor(fi)
  const j0 = Math.floor(fj)
  const k0 = Math.floor(fk)
  const tx = fi - i0
  const ty = fj - j0
  const tz = fk - k0
  let acc = 0
  for (let dk = 0; dk < 2; dk++) {
    const wk = dk === 0 ? 1 - tz : tz
    if (wk === 0) continue
    const k = clampIdx(k0 + dk, f.nk)
    for (let dj = 0; dj < 2; dj++) {
      const wj = dj === 0 ? 1 - ty : ty
      if (wj === 0) continue
      const j = clampIdx(j0 + dj, f.nj)
      for (let di = 0; di < 2; di++) {
        const wi = di === 0 ? 1 - tx : tx
        if (wi === 0) continue
        const i = clampIdx(i0 + di, f.ni)
        acc += wi * wj * wk * f.kappa[i + j * f.ni + k * f.ni * f.nj]!
      }
    }
  }
  return acc
}

function clampIdx(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v
}

/**
 * Build the 4 m extinction field by averaging the 2 m canopy LAD over each 2x2x2 group and
 * applying §7.3's `kappa = G * Omega_c * LAD`. Oracle for `extinction.wgsl`.
 *
 * Averaging LAD and then taking kappa is the same as averaging kappa, because §7.3's
 * relation is linear — no Jensen error, unlike averaging transmittance would give.
 *
 * `lad(i, j, k)` reads the canopy grid at 2 m; `clumping(i, j, k)` returns Omega_c there,
 * which varies by species (§7.3: 0.4-0.8 conifer, ~0.9 broadleaf). Smoke is deliberately not
 * included: plume soot does absorb IR, but the plume field belongs to WP 3.4 and coupling it
 * here would make the "static after build" property — the thing that removes an entire
 * per-step rasterisation pass — untrue. Recorded as an accepted omission in `provenance.ts`.
 */
export function buildExtinctionField(
  out: ExtinctionField,
  lad: (i: number, j: number, k: number) => number,
  clumping: (i: number, j: number, k: number) => number,
  projection = 0.5,
): ExtinctionField {
  for (let k = 0; k < out.nk; k++) {
    for (let j = 0; j < out.nj; j++) {
      for (let i = 0; i < out.ni; i++) {
        let sum = 0
        for (let dk = 0; dk < 2; dk++)
          for (let dj = 0; dj < 2; dj++)
            for (let di = 0; di < 2; di++) {
              const vi = i * 2 + di
              const vj = j * 2 + dj
              const vk = k * 2 + dk
              sum += projection * clumping(vi, vj, vk) * Math.max(0, lad(vi, vj, vk))
            }
        out.kappa[i + j * out.ni + k * out.ni * out.nj] = sum / 8
      }
    }
  }
  return out
}

/**
 * Beer-Lambert transmittance along the segment from `a` to `b`.
 *
 * Evenly spaced midpoint quadrature: every ray costs exactly `taps` samples regardless of
 * length, which keeps the shader's cost uniform across the wavefront (no divergent trip
 * counts) and makes the pass's sampler load exactly rayCount*taps per receiver.
 */
export function transmittance(
  f: ExtinctionField,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  taps: number = RAY_TAPS,
): number {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const len = Math.hypot(dx, dy, dz)
  if (len <= 0 || taps <= 0) return 1
  let sum = 0
  for (let n = 0; n < taps; n++) {
    const t = (n + 0.5) / taps
    sum += sampleExtinction(f, ax + dx * t, ay + dy * t, az + dz * t)
  }
  return Math.exp(-(sum * len) / taps)
}

// ---------------------------------------------------------------------------
// The gather
// ---------------------------------------------------------------------------

export interface GatherOptions {
  /** Rays per receiver. The quality controller's one physics knob; floored at 8 (§6.7). */
  readonly rayCount: number
  readonly taps: number
}

export const DEFAULT_GATHER_OPTIONS: GatherOptions = {
  rayCount: MIN_RAY_COUNT,
  taps: RAY_TAPS,
}

export interface GatherResult {
  /** Spherically integrated irradiance, W m^-2. */
  readonly irradiance: number
  /** Unoccluded (tau = 1) irradiance. The strict upper bound on `irradiance`. */
  readonly unoccluded: number
  /** Clusters actually marched. */
  readonly marched: number
  /** Extinction samples taken. `marched * taps`; what `budget.test.ts` costs the pass from. */
  readonly taps: number
  /** Clusters examined by the selection scan — the pass's other cost driver. */
  readonly scanned: number
  /**
   * Times a candidate displaced the weakest kept cluster, each costing an `n`-wide rescan.
   * Counted rather than assumed because the clusters arrive in grid-scan order, not random
   * order, and the expected-case argument for insertion selection assumes the latter.
   */
  readonly rescans: number
}

/**
 * Next-event-estimation gather at one receiver.
 *
 * Structure mirrors the WGSL exactly, including the min-tracked top-N selection, because the
 * two are compared cluster-for-cluster in `shaders.test.ts`'s constant checks and value-for-
 * value once a device is available.
 */
export function gatherIrradiance(
  px: number,
  py: number,
  pz: number,
  clusters: readonly RadCluster[],
  field: ExtinctionField,
  opts: GatherOptions = DEFAULT_GATHER_OPTIONS,
): GatherResult {
  const n = Math.max(1, Math.min(opts.rayCount, EMIT_CLUSTER_CAP))
  const bestPhi = new Float64Array(n)
  const bestIdx = new Int32Array(n).fill(-1)
  let minSlot = 0

  let sumAll = 0
  let sumAllR = 0
  let scanned = 0
  let rescans = 0

  for (let c = 0; c < clusters.length; c++) {
    const cl = clusters[c]!
    scanned++
    if (!(cl.powerW > 0)) continue
    const dx = cl.x - px
    const dy = cl.y - py
    const dz = cl.z - pz
    const r2 = dx * dx + dy * dy + dz * dz
    const phi = cl.powerW / (4 * Math.PI * (r2 + cl.a2))
    sumAll += phi
    sumAllR += phi * Math.sqrt(r2)
    if (phi > bestPhi[minSlot]!) {
      rescans++
      bestPhi[minSlot] = phi
      bestIdx[minSlot] = c
      // Rescan for the new weakest slot. Runs only on an improvement, so the expected cost
      // over a 512-cluster list is ~8*ln(512/8) compares, not 512*n.
      let mv = bestPhi[0]!
      let ms = 0
      for (let s = 1; s < n; s++) {
        if (bestPhi[s]! < mv) {
          mv = bestPhi[s]!
          ms = s
        }
      }
      minSlot = ms
    }
  }

  let gTop = 0
  let sumTop = 0
  let sumTopR = 0
  let marched = 0
  for (let s = 0; s < n; s++) {
    const c = bestIdx[s]!
    if (c < 0) continue
    const cl = clusters[c]!
    const phi = bestPhi[s]!
    const tau = transmittance(field, px, py, pz, cl.x, cl.y, cl.z, opts.taps)
    gTop += phi * tau
    sumTop += phi
    sumTopR += phi * Math.hypot(cl.x - px, cl.y - py, cl.z - pz)
    marched++
  }

  let irradiance = gTop
  const tailPhi = sumAll - sumTop
  if (tailPhi > 0 && sumTop > 0) {
    const tauBar = Math.min(1, gTop / sumTop)
    const rTop = sumTopR / sumTop
    const rTail = (sumAllR - sumTopR) / tailPhi
    // Beer-Lambert is exponential in path length, so extrapolate the marched set's mean
    // transmittance along the tail's longer mean path. exponent >= 1 => tauTail <= tauBar.
    const exponent = rTop > 0 ? Math.max(1, rTail / rTop) : 1
    const tauTail = tauBar > 0 ? Math.pow(tauBar, exponent) : 0
    irradiance += tailPhi * tauTail
  }

  return { irradiance, unoccluded: sumAll, marched, taps: marched * opts.taps, scanned, rescans }
}
