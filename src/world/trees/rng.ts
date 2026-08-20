/**
 * Deterministic pseudo-random numbers for tree generation (WP 1.4).
 *
 * Every tree must be reproducible from (speciesId, quantised parameters, variant) alone —
 * independent of iteration order, of how many trees were generated before it, and of which
 * thread built it. So no global state: every generator carries its own 32-bit stream, and
 * streams are derived by hashing rather than by sequential splitting.
 */

/** mulberry32 — small, fast, and passes gjrand's smallcrush; ample for geometry jitter. */
export class Rng {
  private state: number

  constructor(seed: number) {
    // 0 is a legal mulberry32 state but a poor one to hand out; nudge it off the origin.
    this.state = (seed >>> 0) === 0 ? 0x9e3779b9 : seed >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n))
  }

  /** Standard normal, Box–Muller. Two uniforms in, one normal out (the second is discarded
   *  deliberately: caching it would make the stream depend on call parity). */
  gaussian(): number {
    const u1 = Math.max(1e-12, this.next())
    const u2 = this.next()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }

  /** Gaussian clamped to +/- `sigmas`, so a tail sample cannot produce absurd geometry. */
  clampedGaussian(sigmas = 2.5): number {
    const g = this.gaussian()
    return g < -sigmas ? -sigmas : g > sigmas ? sigmas : g
  }

  /** A uniformly distributed direction on the unit sphere. */
  unitVector(): [number, number, number] {
    const z = this.range(-1, 1)
    const phi = this.range(0, 2 * Math.PI)
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    return [r * Math.cos(phi), z, r * Math.sin(phi)]
  }
}

/** FNV-1a over UTF-16 code units. Stable across runs and platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Combine two seeds into a well-mixed third. splitmix32 finaliser. */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) >>> 0
}
