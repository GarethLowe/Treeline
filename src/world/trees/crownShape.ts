/**
 * Crown envelope and the vertical distribution of foliar mass (WP 1.4, spec §7.5 steps 2-4).
 *
 * This is the module that turns four physical numbers — height, crown base height, crown
 * radius, crown bulk density — into a *target field* that the skeleton grows into. The chain
 * is deliberately one-way:
 *
 *     CBH, H, CD  ->  crown envelope R(t)      (this file)
 *     R(t)        ->  crown volume V_c         (this file)
 *     CBD * V_c   ->  foliar biomass W_f       (this file)
 *     W_f, w(t)   ->  attractor field          (this file)
 *     attractors  ->  branches and foliage     (spaceColonisation.ts, foliage.ts)
 *     geometry    ->  measured CBH, W_f, CBD   (measure.ts)
 *
 * The last step is an independent measurement of the generated triangles, and the acceptance
 * test asserts it agrees with the first step's inputs within 10%. Nothing is copied across.
 */

import type { FormParams } from './speciesForm.ts'
import type { Rng } from './rng.ts'

/**
 * Crown radius at relative crown height `t` in [0, 1], as a fraction of the maximum crown
 * radius. Piecewise power curves: rises from `gBase` at the crown base to 1 at `tPeak`, then
 * falls to `gTop` at the crown top.
 *
 * Both ends are deliberately non-zero. A crown that tapers to a mathematical point at its
 * base cannot carry foliage there, and then the *measured* crown base drifts upward away
 * from the crown base height the Van Wagner criterion is going to consume. Real crowns have
 * a finite width at the lowest live whorl; so does this one.
 */
export function crownRadiusFrac(f: FormParams, t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t
  if (u <= f.tPeak) {
    const a = f.tPeak <= 0 ? 1 : u / f.tPeak
    return f.gBase + (1 - f.gBase) * Math.pow(a, f.pLow)
  }
  const a = f.tPeak >= 1 ? 1 : (1 - u) / (1 - f.tPeak)
  return f.gTop + (1 - f.gTop) * Math.pow(a, f.pHigh)
}

/**
 * Crown cross-sectional area at relative height t, as a fraction of pi * rMax^2.
 * This is s(z) of spec §7.5 step 2.
 */
export function crownAreaFrac(f: FormParams, t: number): number {
  const g = crownRadiusFrac(f, t)
  return g * g
}

/**
 * Crown volume, m3. V_c = integral over [CBH, H] of A(z) dz, with A(z) = pi rMax^2 s(z).
 * Composite Simpson over `segments` (even) intervals — the profile is smooth apart from the
 * knot at tPeak, and 256 intervals puts the quadrature error far below the measurement
 * noise it is compared against.
 */
export function crownVolumeM3(f: FormParams, crownRadiusM: number, crownDepthM: number, segments = 256): number {
  const n = segments % 2 === 0 ? segments : segments + 1
  const h = 1 / n
  let acc = crownAreaFrac(f, 0) + crownAreaFrac(f, 1)
  for (let i = 1; i < n; i++) {
    acc += (i % 2 === 1 ? 4 : 2) * crownAreaFrac(f, i * h)
  }
  const integral = (acc * h) / 3
  return Math.PI * crownRadiusM * crownRadiusM * crownDepthM * integral
}

/** Unnormalised Beta(a, b) density, the species vertical foliage weighting w(t). */
export function verticalWeight(f: FormParams, t: number): number {
  const u = t <= 0 ? 1e-6 : t >= 1 ? 1 - 1e-6 : t
  return Math.pow(u, f.wAlpha - 1) * Math.pow(1 - u, f.wBeta - 1)
}

/**
 * Tabulated inverse CDF of w(t), for sampling attractor heights. Built once per tree and
 * reused; sampling is then a binary search plus a lerp.
 */
export class VerticalMassProfile {
  /** cdf[i] is the cumulative mass fraction below t = i / (n-1). */
  private readonly cdf: Float64Array
  private readonly n: number

  constructor(f: FormParams, samples = 512) {
    this.n = samples
    const pdf = new Float64Array(samples)
    for (let i = 0; i < samples; i++) pdf[i] = verticalWeight(f, i / (samples - 1))
    const cdf = new Float64Array(samples)
    let acc = 0
    for (let i = 1; i < samples; i++) {
      // Trapezoid between successive samples.
      acc += 0.5 * (pdf[i]! + pdf[i - 1]!)
      cdf[i] = acc
    }
    const total = cdf[samples - 1]!
    for (let i = 0; i < samples; i++) cdf[i] = total > 0 ? cdf[i]! / total : i / (samples - 1)
    this.cdf = cdf
  }

  /** Map a uniform u in [0,1) to a relative crown height t distributed as w(t). */
  sample(u: number): number {
    const c = this.cdf
    let lo = 0
    let hi = this.n - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (c[mid]! <= u) lo = mid
      else hi = mid
    }
    const c0 = c[lo]!
    const c1 = c[hi]!
    const frac = c1 > c0 ? (u - c0) / (c1 - c0) : 0
    return (lo + frac) / (this.n - 1)
  }
}

/** One attractor point of the space-colonisation field (spec §7.5 step 4). */
export interface AttractorField {
  /** Interleaved xyz, length 3*count. Tree-local coordinates, origin at the stem base. */
  readonly positions: Float64Array
  /** Relative crown height t in [0,1] of each point, length `count`. */
  readonly relHeights: Float64Array
  readonly count: number
  /** Foliar mass each attractor stands for, kg. m_att = W_f / N_tot. */
  readonly massPerAttractorKg: number
  /** Total foliar biomass the field represents, kg. */
  readonly totalFoliarMassKg: number
  /** The crown volume the mass was derived over, m3. */
  readonly crownVolumeM3: number
}

export interface CrownSpec {
  /** Total tree height above the stem base, m. */
  readonly heightM: number
  /** Height above the stem base of the lowest live foliage, m. */
  readonly crownBaseM: number
  /** Maximum crown radius, m. */
  readonly crownRadiusM: number
  /** Declared crown bulk density, kg/m3, averaged over the crown volume. */
  readonly crownBulkDensityKgM3: number
}

/** Crown depth, m — the vertical extent over which foliage exists. */
export function crownDepthM(crown: CrownSpec): number {
  return Math.max(0.02, crown.heightM - crown.crownBaseM)
}

/**
 * The target per-tree crown bulk density at relative crown height `t`, kg/m3.
 * CBD(t) = W_f * w(t) / A(t), spec §7.5 step 3. Exposed so the vertical profile of the
 * *generated* geometry can be checked against the profile the crown-fire model will read,
 * not just the crown-averaged scalar.
 */
export function targetBulkDensityAt(f: FormParams, crown: CrownSpec, t: number): number {
  const depth = crownDepthM(crown)
  const volume = crownVolumeM3(f, crown.crownRadiusM, depth)
  const totalMass = crown.crownBulkDensityKgM3 * volume

  // Normalise w over [0,1] once, by the same Simpson rule the volume uses.
  const n = 256
  const h = 1 / n
  let acc = verticalWeight(f, 0) + verticalWeight(f, 1)
  for (let i = 1; i < n; i++) acc += (i % 2 === 1 ? 4 : 2) * verticalWeight(f, i * h)
  const wNorm = (acc * h) / 3

  const area = Math.PI * crown.crownRadiusM * crown.crownRadiusM * crownAreaFrac(f, t)
  if (area <= 0) return 0
  // w is a density per unit *relative* height, so dividing by depth converts to per metre.
  return (totalMass * (verticalWeight(f, t) / wNorm)) / (area * depth)
}

/**
 * Sample the attractor field: `count` equal-mass points distributed as the target bulk
 * density field, inside the declared crown envelope.
 *
 * Two properties are load-bearing for the acceptance test and are worth stating plainly:
 *
 * 1. **Stratification is endpoint-pinned.** Sample i takes the (i/(n-1))-quantile of the
 *    mass CDF, with jitter only on the interior. So there is always a point at t = 0 (the
 *    lowest live whorl, at the declared crown base height) and one at t = 1 (the leader
 *    tip). Pure random sampling leaves a gap at both ends that scales with 1/n, and at the
 *    bottom that gap is a direct, seed-dependent bias in the measured crown base height —
 *    which is the number Van Wagner's criterion consumes.
 * 2. **No inset.** Points sit on the declared envelope. Foliage geometry is clamped to the
 *    envelope at placement time in `foliage.ts`, where the element's actual half-extents
 *    are known; doing it here with a guessed mean extent is strictly worse.
 */
export function sampleAttractorField(
  f: FormParams,
  crown: CrownSpec,
  rng: Rng,
  count: number,
): AttractorField {
  const depth = crownDepthM(crown)
  const volume = crownVolumeM3(f, crown.crownRadiusM, depth)
  const totalMass = crown.crownBulkDensityKgM3 * volume

  const profile = new VerticalMassProfile(f)
  const n = Math.max(16, Math.floor(count))
  const positions = new Float64Array(n * 3)
  const relHeights = new Float64Array(n)
  const span = n - 1

  for (let i = 0; i < n; i++) {
    // Jitter inside the stratum, except at the two ends which stay pinned.
    const jitter = i === 0 || i === span ? 0 : 0.8 * (rng.next() - 0.5)
    const u = Math.min(1, Math.max(0, (i + jitter) / span))
    const t = profile.sample(u)
    const rMax = Math.max(1e-4, crown.crownRadiusM * crownRadiusFrac(f, t))
    // sqrt for area-uniform sampling of the disc: without it the crown is hollow-looking
    // and, worse, the mass piles onto the axis and the measured bulk density comes out high.
    const r = rMax * Math.sqrt(rng.next())
    const th = rng.next() * 2 * Math.PI
    positions[i * 3] = r * Math.cos(th)
    positions[i * 3 + 1] = crown.crownBaseM + t * depth
    positions[i * 3 + 2] = r * Math.sin(th)
    relHeights[i] = t
  }

  return {
    positions,
    relHeights,
    count: n,
    massPerAttractorKg: totalMass / n,
    totalFoliarMassKg: totalMass,
    crownVolumeM3: volume,
  }
}
