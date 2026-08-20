/**
 * The two estimators the frame profiler is built on — work package 1.1.
 *
 * Both are pure and both are unit-tested, because the entire claim that the profiler is
 * *usable* rests on them. See docs/spec/10-webgpu-architecture.md §6.7: Chrome quantises
 * timestamp query results to 100 µs as a timing-attack mitigation, and nine of the twelve
 * simulation passes are below that. Grouping passes into phases of >= 300 µs keeps the
 * quantisation error under ~30% of a sample, and the EMA averages the remainder out —
 * quantisation error is uncorrelated with the signal, so the mean converges.
 */

/** Spec §6.7: EMA decay 0.98 over >= 120 frames. */
export const EMA_DECAY = 0.98

/**
 * Bias-corrected exponential moving average.
 *
 * The naïve form `v ← d·v + (1−d)·x` seeded with `v = 0` needs ~1/(1−d) = 50 samples
 * before it stops reading low, which is exactly the window in which the quality controller
 * would otherwise see a fictitiously fast frame and step quality *up* into a stall. So we
 * track the accumulated weight and divide by it (the Adam/`pandas.ewm(adjust=True)`
 * correction): the estimate is unbiased from the very first sample and identical to the
 * naïve form once the weight saturates.
 *
 * Effective sample count is (1+d)/(1−d) ≈ 99 at d = 0.98, so the standard error of the
 * mean is σ/√99 ≈ σ/10. With per-sample quantisation noise of 100 µs (σ ≈ 29 µs for
 * uniformly-dithered rounding) that is ~3 µs of residual error — comfortably inside the
 * "~10 µs" §6.7 claims.
 */
export class Ema {
  #raw = 0
  #weight = 0
  #count = 0

  constructor(readonly decay: number = EMA_DECAY) {
    if (!(decay >= 0 && decay < 1)) {
      throw new RangeError(`EMA decay must be in [0, 1), got ${decay}`)
    }
  }

  push(x: number): void {
    if (!Number.isFinite(x)) return
    this.#raw = this.#raw * this.decay + x
    this.#weight = this.#weight * this.decay + 1
    this.#count += 1
  }

  get value(): number {
    return this.#weight === 0 ? 0 : this.#raw / this.#weight
  }

  /** Samples seen. The estimate is only claimed converged past ~120. */
  get count(): number {
    return this.#count
  }

  reset(): void {
    this.#raw = 0
    this.#weight = 0
    this.#count = 0
  }
}

/**
 * Fixed-window running median.
 *
 * Median rather than mean because the quality controller must not react to a single
 * driver-paging spike (§6.8 pitfall 9: exceeding VRAM shows up as sporadic 10 ms frame
 * spikes with no error). A 30-frame window tolerates up to 14 outliers without moving.
 *
 * O(n log n) per query at n = 30 is ~150 ns; a heap pair would be asymptotically better
 * and measurably slower at this size.
 */
export class RunningMedian {
  readonly #ring: number[]
  #next = 0
  #filled = 0

  constructor(readonly window: number = 30) {
    if (!Number.isInteger(window) || window < 1) {
      throw new RangeError(`median window must be an integer >= 1, got ${window}`)
    }
    this.#ring = new Array<number>(window).fill(0)
  }

  push(x: number): void {
    if (!Number.isFinite(x)) return
    this.#ring[this.#next] = x
    this.#next = (this.#next + 1) % this.window
    if (this.#filled < this.window) this.#filled += 1
  }

  get count(): number {
    return this.#filled
  }

  /** Median of the samples seen so far. 0 before the first sample. */
  get value(): number {
    const n = this.#filled
    if (n === 0) return 0
    // Before the ring wraps, slots 0..n-1 are exactly the samples seen; after it wraps,
    // n === window and the slice is the whole ring. Both cases are this one expression.
    const slice = this.#ring.slice(0, n).sort((a, b) => a - b)
    const mid = n >> 1
    if ((n & 1) === 1) return slice[mid] ?? 0
    return ((slice[mid - 1] ?? 0) + (slice[mid] ?? 0)) / 2
  }

  reset(): void {
    this.#next = 0
    this.#filled = 0
    this.#ring.fill(0)
  }
}
