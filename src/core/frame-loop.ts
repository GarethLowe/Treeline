/**
 * Fixed-timestep frame loop — work package 1.1.
 *
 * Implements `IFrameLoop` from `@contracts/gpu`. See docs/spec/10-webgpu-architecture.md
 * §6.5 (decoupled timesteps and determinism).
 *
 * The simulation advances only in whole increments of a fixed step *h*; the render rate is
 * whatever the display and the GPU can manage. Physics accuracy must not degrade when
 * frames get expensive — frames are dropped, steps are not — and the quality controller
 * (§6.7) is forbidden from touching *h* or the substep count for the same reason: the
 * measurement HUD exports numbers that would silently stop meaning anything.
 *
 *   A ← min(A + Δt_wall · r, A_max)
 *   n_sub = ⌊A / h⌋
 *   A ← A − n_sub · h
 *
 * with A the accumulator, r the time-lapse rate and A_max = maxSubstepsPerFrame · h the
 * spiral-of-death clamp. Simulated time beyond A_max is *dropped and reported*, never
 * compounded into the next frame — a stall that compounds turns one 200 ms hitch into a
 * permanently over-subscribed loop.
 */

import type { Seconds } from '@contracts/units'
import { s as seconds } from '@contracts/units'

/**
 * Base substep: h = 1/30 s = 33.3 ms.
 *
 * Spec §6.3 wrote 1/120 s, and the revised overview asks for 2-10 Hz on a 0.5 m grid;
 * `sim/canopy/radiation/layout.ts` has recorded the gap as "sixteen times what §7.4 asks for"
 * for some time. It was left alone because nobody had measured what it bought.
 *
 * Now measured, by `probeClockEquivalence` on a real GPU: the same ignition run to 30 s of
 * simulated time gives 2013 m2 burnt at 1/30 s against 2019 m2 at 1/120 s — **0.3 % apart for
 * four times the work**. CFL is not close either; SB4 at 6 m/s spreads 1.23 m/s, so a 1/30 s
 * step moves the front 0.041 m across 0.5 m cells.
 *
 * This matters more than it did: substepping the canopy and the smoke onto the fire's clock
 * made cadence the dominant cost at high time scales, where it multiplies. Still three times
 * finer than the overview's upper bound, so there is room left if it is ever wanted.
 *
 * The probe prints the 1/30-vs-1/120 comparison on every `?debug` run, so this stays a
 * measured choice rather than a number someone once wrote down.
 */
export const DEFAULT_FIXED_DT = 1 / 30

/** A_max = 4h = 33.3 ms, per spec §6.5. */
export const DEFAULT_MAX_SUBSTEPS = 4

/** Injection seam so the loop can be driven by a fake clock in tests. */
export interface FrameScheduler {
  /** Schedule `cb`, which receives a monotonic timestamp in milliseconds. */
  request(cb: (timestampMs: number) => void): number
  cancel(handle: number): void
}

const rafScheduler: FrameScheduler = {
  request: (cb) => {
    if (typeof requestAnimationFrame !== 'function') {
      throw new Error(
        'FrameLoop.start() needs requestAnimationFrame. Pass a FrameScheduler explicitly ' +
          'when running outside a browser document.',
      )
    }
    return requestAnimationFrame(cb)
  },
  cancel: (h) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h)
  },
}

export interface FrameLoopOptions {
  /** Fixed simulation timestep in seconds. Default 1/120. */
  readonly fixedDt?: number
  /** Default 4, giving A_max = 4h = 33.3 ms. */
  readonly maxSubstepsPerFrame?: number
  /** Wall-clock multiplier; 1 = real time, up to ~60 for multi-hour runs. Default 1. */
  readonly timeScale?: number
  /** Start paused. Default false. */
  readonly paused?: boolean
  /**
   * Hard cap on a single frame's raw wall delta, in seconds, applied *before* timeScale.
   * A backgrounded tab produces multi-second deltas; without this a `timeScale` of 60
   * would turn one tab switch into an hour of dropped simulated time in the report.
   * Default 0.25 s.
   */
  readonly maxWallDeltaSeconds?: number
  /** Defaults to `requestAnimationFrame`. */
  readonly scheduler?: FrameScheduler
  /**
   * Called when the accumulator clamp discards simulated time, with the amount discarded.
   * The HUD surfaces this: dropped simulated time is a visible honesty requirement of
   * §6.5, not an internal detail.
   */
  readonly onTimeDropped?: (dropped: Seconds) => void
}

type StepFn = (dt: Seconds) => void
type RenderFn = (alpha: number) => void

export class FrameLoop {
  readonly fixedDt: Seconds
  readonly maxSubstepsPerFrame: number

  #simTime = 0
  #frameIndex = 0
  #accumulator = 0
  #timeScale: number
  #paused: boolean
  #droppedSimTime = 0
  #lastSubstepCount = 0
  #wallTime = 0

  readonly #maxWallDelta: number
  readonly #scheduler: FrameScheduler
  readonly #onTimeDropped: ((dropped: Seconds) => void) | undefined

  #onStep: StepFn | null = null
  #onRender: RenderFn | null = null
  #handle: number | null = null
  #lastTimestampMs: number | null = null

  constructor(options: FrameLoopOptions = {}) {
    const dt = options.fixedDt ?? DEFAULT_FIXED_DT
    if (!(dt > 0) || !Number.isFinite(dt)) {
      throw new RangeError(`fixedDt must be a positive finite number of seconds, got ${dt}`)
    }
    const maxSub = options.maxSubstepsPerFrame ?? DEFAULT_MAX_SUBSTEPS
    if (!Number.isInteger(maxSub) || maxSub < 1) {
      throw new RangeError(`maxSubstepsPerFrame must be an integer >= 1, got ${maxSub}`)
    }
    this.fixedDt = seconds(dt)
    this.maxSubstepsPerFrame = maxSub
    this.#timeScale = options.timeScale ?? 1
    this.#paused = options.paused ?? false
    this.#maxWallDelta = options.maxWallDeltaSeconds ?? 0.25
    this.#scheduler = options.scheduler ?? rafScheduler
    this.#onTimeDropped = options.onTimeDropped
  }

  // -- IFrameLoop ----------------------------------------------------------

  get simTime(): Seconds {
    return seconds(this.#simTime)
  }

  get frameIndex(): number {
    return this.#frameIndex
  }

  get timeScale(): number {
    return this.#timeScale
  }

  set timeScale(v: number) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`timeScale must be a finite number >= 0, got ${v}`)
    }
    this.#timeScale = v
  }

  get paused(): boolean {
    return this.#paused
  }

  set paused(v: boolean) {
    this.#paused = v
  }

  start(onStep: StepFn, onRender: RenderFn): void {
    if (this.#handle !== null) throw new Error('FrameLoop is already running')
    this.#onStep = onStep
    this.#onRender = onRender
    this.#lastTimestampMs = null
    this.#schedule()
  }

  stop(): void {
    if (this.#handle !== null) {
      this.#scheduler.cancel(this.#handle)
      this.#handle = null
    }
    this.#onStep = null
    this.#onRender = null
    this.#lastTimestampMs = null
  }

  get running(): boolean {
    return this.#handle !== null
  }

  // -- Diagnostics (beyond the contract; read by the HUD) -------------------

  /** Accumulator residue, seconds. `alpha` is this divided by `fixedDt`. */
  get accumulator(): Seconds {
    return seconds(this.#accumulator)
  }

  /** Substeps run on the most recent frame. */
  get lastSubstepCount(): number {
    return this.#lastSubstepCount
  }

  /** Total simulated seconds discarded by the spiral-of-death clamp since start. */
  get droppedSimTime(): Seconds {
    return seconds(this.#droppedSimTime)
  }

  /** Wall-clock seconds elapsed across ticks, tracked separately from `simTime` (§0.6.5). */
  get wallTime(): Seconds {
    return seconds(this.#wallTime)
  }

  // -- The tick ------------------------------------------------------------

  /**
   * Advance one frame. Public so tests can drive the loop from a fake clock without
   * `requestAnimationFrame`; `start()` wires this to the scheduler.
   *
   * @param timestampMs monotonic clock reading, milliseconds (rAF's argument).
   */
  tick(timestampMs: number): void {
    const previous = this.#lastTimestampMs
    this.#lastTimestampMs = timestampMs

    // The first tick has no previous timestamp, so it has no wall delta. Treating it as
    // zero (rather than as time since page load) is what keeps a slow first frame from
    // immediately tripping the spiral clamp.
    let wallDt = previous === null ? 0 : (timestampMs - previous) / 1000
    if (!Number.isFinite(wallDt) || wallDt < 0) wallDt = 0
    if (wallDt > this.#maxWallDelta) wallDt = this.#maxWallDelta
    this.#wallTime += wallDt

    this.#frameIndex += 1
    this.#lastSubstepCount = 0

    if (!this.#paused) {
      const h = this.fixedDt
      const aMax = this.maxSubstepsPerFrame * h
      this.#accumulator += wallDt * this.#timeScale
      if (this.#accumulator > aMax) {
        const dropped = this.#accumulator - aMax
        this.#accumulator = aMax
        this.#droppedSimTime += dropped
        this.#onTimeDropped?.(seconds(dropped))
      }

      const n = Math.floor(this.#accumulator / h)
      this.#lastSubstepCount = n
      const step = this.#onStep
      for (let i = 0; i < n; i++) {
        // simTime is advanced *before* the callback so a step handler that reads
        // loop.simTime sees the time at the end of the step it is computing.
        this.#simTime += h
        step?.(h)
      }
      // Subtracting n·h rather than repeatedly subtracting h keeps the residue exact to
      // one rounding, which matters at timeScale 60 where the loop runs for hours.
      this.#accumulator -= n * h
      if (this.#accumulator < 0) this.#accumulator = 0
    }

    const alpha = this.#accumulator / this.fixedDt
    this.#onRender?.(alpha)
  }

  #schedule(): void {
    this.#handle = this.#scheduler.request((t) => {
      // Re-arm before running the frame body: an exception thrown by a step or render
      // handler then propagates to the window error handler (where it is visible) instead
      // of silently leaving the loop un-armed and the application apparently frozen.
      this.#handle = null
      if (this.#onStep === null && this.#onRender === null) return
      this.#schedule()
      this.tick(t)
    })
  }
}
