/**
 * Deterministic pseudo-randomness for terrain generation.
 *
 * No dependencies, no `Math.random`, no time or iteration-order sensitivity: the whole
 * point is that a seed reproduces a world byte for byte. Everything here is integer
 * arithmetic in the 32-bit domain via `Math.imul`, so it is exactly reproducible across
 * engines and platforms.
 */

/** SplitMix32 finaliser. Good avalanche for a single 32-bit input. */
export function hashU32(x: number): number {
  let z = (x + 0x9e3779b9) | 0
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
  return (z ^ (z >>> 15)) >>> 0
}

/** Hash three 32-bit words into one. Used for lattice-point gradients in the noise. */
export function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d)
  h = (h ^ Math.imul(y | 0, 0x85ebca6b)) | 0
  h = (h ^ Math.imul(z | 0, 0xc2b2ae35)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * SplitMix32 sequential generator. Small state, no warm-up needed, and — unlike an LCG —
 * every low bit is usable, which matters because the droplet sampler takes coordinates
 * from the low half of the word.
 */
export class Rng {
  private state: number
  /** Immutable, so `fork` does not depend on how many draws have already been taken. */
  private readonly root: number

  constructor(seed: number) {
    // Fold the seed so that adjacent seeds do not produce correlated first draws.
    this.root = hashU32(seed | 0) | 0
    this.state = this.root | 0
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    this.state = (this.state + 0x9e3779b9) | 0
    let z = this.state
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return (z ^ (z >>> 15)) >>> 0
  }

  /** Uniform in [0, 1). 24 bits of mantissa, which is all a float32 field can carry. */
  nextFloat(): number {
    return (this.nextU32() >>> 8) * 2 ** -24
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.nextFloat()
  }

  /**
   * Derive an independent named sub-stream. Keyed off the immutable root, so inserting a
   * generation stage that draws from the parent cannot silently reshuffle another stage.
   */
  fork(tag: number): Rng {
    return new Rng(hash3(this.root, tag, 0x5bf03635) | 0)
  }
}
