/**
 * Deterministic hashing and pseudo-random streams for world generation.
 *
 * Two distinct needs, and conflating them is a bug:
 *
 * 1. A **stream** for sequential decisions during placement (candidate positions, accept /
 *    reject). Order-dependent by nature.
 * 2. A **hash** for per-object parameters, so that a stem standing at a given position gets
 *    the same age, size and mesh seed no matter what order the placement loop happened to
 *    visit it in. `Stem.seed` in the contract exists precisely for this ("so a stem's mesh
 *    is reproducible independent of iteration order"), and it only holds if the per-stem
 *    parameters are hashed from position rather than drawn from the placement stream.
 *
 * Everything here is integer-exact 32-bit arithmetic via `Math.imul`, so results are
 * identical on every JS engine — no floating-point accumulation, no platform drift.
 */

export type Rng = () => number

/**
 * 32-bit integer avalanche. Stafford's variant 13 of the MurmurHash3 finaliser, as
 * published in the public-domain `hash-prospector` survey; chosen because its avalanche
 * bias is ~0.10 %, i.e. a single-bit input change decorrelates the whole output word.
 */
export function mix32(v: number): number {
  let x = v | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

const K1 = 0x9e3779b1 | 0 // 2^32 / golden ratio
const K2 = 0x85ebca77 | 0
const K3 = 0xc2b2ae3d | 0

export function hash1(seed: number, a: number): number {
  return mix32((seed | 0) ^ Math.imul(a | 0, K1))
}

export function hash2(seed: number, a: number, b: number): number {
  return mix32(mix32((seed | 0) ^ Math.imul(a | 0, K1)) ^ Math.imul(b | 0, K2))
}

export function hash3(seed: number, a: number, b: number, c: number): number {
  return mix32(hash2(seed, a, b) ^ Math.imul(c | 0, K3))
}

/** Hash to the unit interval [0, 1). */
export function hashUnit(h: number): number {
  return (h >>> 0) / 4294967296
}

/**
 * mulberry32. Period 2^32, passes PractRand to 256 MB — far beyond anything world
 * generation asks of it, and it is four integer ops, so it costs nothing in the
 * dart-throwing inner loop.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Inverse CDF of the symmetric triangular distribution on [0, 1] (mean 0.5, variance 1/24).
 *
 * Used wherever a "typical individual with variation" draw is wanted. Triangular rather
 * than uniform because tree size within a cohort is unimodal, and triangular rather than
 * normal because it has compact support — a species' declared size range is a range, not a
 * standard deviation, and a Gaussian tail would put stems outside it.
 */
export function triangularQuantile(p: number): number {
  const u = p < 0 ? 0 : p > 1 ? 1 : p
  return u < 0.5 ? Math.sqrt(u * 0.5) : 1 - Math.sqrt((1 - u) * 0.5)
}

/** Box–Muller. Returns one standard normal deviate from two uniforms. */
export function normalFrom(u1: number, u2: number): number {
  const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12)))
  return r * Math.cos(2 * Math.PI * u2)
}

/**
 * Deterministic stratified quantile nodes: the midpoints of `n` equal-probability bins.
 *
 * These are what turns a Monte-Carlo sampler into a quadrature rule. The expected-value
 * predictors in `allometry.ts` evaluate exactly the same functions the sampler evaluates,
 * but at these nodes instead of at random draws — so the predictor is the infinite-sample
 * limit of the sampler, and comparing the two is a genuine unbiasedness test rather than a
 * tautology.
 */
export function quantileNodes(n: number): Float64Array {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = (i + 0.5) / n
  return out
}
