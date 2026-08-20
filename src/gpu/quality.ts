/**
 * Dynamic quality controller — work package 1.1.
 *
 * Implements `IQualityController` from `@contracts/gpu`. See
 * docs/spec/10-webgpu-architecture.md §6.7.
 *
 *   m = 30-frame median GPU frame time (ms), τ = 16.67 ms
 *   if m > 0.92τ for 20 consecutive frames  → q ← q − 1
 *   if m < 0.75τ for 90 consecutive frames  → q ← q + 1
 *
 * The asymmetry is the whole point. A symmetric controller sitting at a marginal operating
 * point oscillates across the threshold every few frames, and a resolution scale that
 * changes every few frames is far more visible than one that is simply lower. Fast down,
 * slow up.
 *
 * **The controller must never change the simulation timestep or the substep count.** There
 * is deliberately no API here through which it could: it owns `QualitySettings` and
 * nothing else. Degrading the physics to hold framerate would silently invalidate every
 * number the measurement HUD exports, which is the one failure this project cannot afford
 * — a slower frame is visible, a quietly wrong rate of spread is not.
 */

import type { FrameTimings, QualityLevel, QualitySettings } from '@contracts/gpu'
import { QUALITY_TABLE } from '@contracts/gpu'

/** 60 fps. */
export const DEFAULT_TARGET_FRAME_MS = 1000 / 60

/** Spec §6.7 thresholds and dwell counts. */
export const DOWNGRADE_FRACTION = 0.92
export const UPGRADE_FRACTION = 0.75
export const DOWNGRADE_FRAMES = 20
export const UPGRADE_FRAMES = 90

export const MIN_QUALITY: QualityLevel = 0
export const MAX_QUALITY: QualityLevel = 5

export interface QualityControllerOptions {
  /** τ, milliseconds. Default 16.67 (60 fps). */
  readonly targetFrameMs?: number
  /** Starting level. Default 5 (full). */
  readonly initialLevel?: QualityLevel
  /** Called on every level change, for the HUD and for the export annotation. */
  readonly onChange?: (level: QualityLevel, settings: QualitySettings) => void
  /** Override the dwell counts. Exposed for tests; do not tune these in shipping code. */
  readonly downgradeFrames?: number
  readonly upgradeFrames?: number
}

function settingsFor(level: QualityLevel): QualitySettings {
  const s = QUALITY_TABLE[level]
  if (s === undefined) {
    throw new RangeError(`quality level ${level} is outside QUALITY_TABLE`)
  }
  return s
}

export class QualityController {
  readonly targetFrameMs: number

  #level: QualityLevel
  #settings: QualitySettings
  #pinned: QualityLevel | null = null
  #framesAbove = 0
  #framesBelow = 0
  #changes = 0

  readonly #downgradeFrames: number
  readonly #upgradeFrames: number
  readonly #onChange: ((level: QualityLevel, settings: QualitySettings) => void) | undefined

  constructor(options: QualityControllerOptions = {}) {
    this.targetFrameMs = options.targetFrameMs ?? DEFAULT_TARGET_FRAME_MS
    if (!(this.targetFrameMs > 0)) {
      throw new RangeError(`targetFrameMs must be positive, got ${this.targetFrameMs}`)
    }
    this.#level = options.initialLevel ?? MAX_QUALITY
    this.#settings = settingsFor(this.#level)
    this.#downgradeFrames = options.downgradeFrames ?? DOWNGRADE_FRAMES
    this.#upgradeFrames = options.upgradeFrames ?? UPGRADE_FRAMES
    this.#onChange = options.onChange
  }

  // -- IQualityController --------------------------------------------------

  get level(): QualityLevel {
    return this.#level
  }

  get settings(): QualitySettings {
    return this.#settings
  }

  get isDegraded(): boolean {
    return this.#level < 2
  }

  update(timings: FrameTimings): void {
    if (this.#pinned !== null) return

    const m = timings.medianFrameMs
    // Before the median window has any samples the profiler reports 0, which would look
    // like enormous headroom and ramp quality up into a stall. Treat a non-positive
    // reading as "no information" and hold both counters.
    if (!Number.isFinite(m) || m <= 0) return

    const downThreshold = DOWNGRADE_FRACTION * this.targetFrameMs
    const upThreshold = UPGRADE_FRACTION * this.targetFrameMs

    if (m > downThreshold) {
      this.#framesAbove += 1
      this.#framesBelow = 0
    } else if (m < upThreshold) {
      this.#framesBelow += 1
      this.#framesAbove = 0
    } else {
      // The dead band between 0.75τ and 0.92τ is the intended operating point. A frame
      // landing in it breaks *both* runs: "20 consecutive frames" means consecutive.
      this.#framesAbove = 0
      this.#framesBelow = 0
    }

    if (this.#framesAbove >= this.#downgradeFrames) {
      this.#framesAbove = 0
      this.#framesBelow = 0
      if (this.#level > MIN_QUALITY) this.#setLevel((this.#level - 1) as QualityLevel)
    } else if (this.#framesBelow >= this.#upgradeFrames) {
      this.#framesAbove = 0
      this.#framesBelow = 0
      if (this.#level < MAX_QUALITY) this.#setLevel((this.#level + 1) as QualityLevel)
    }
  }

  /**
   * Pin the level, disabling adaptation. Every measurement run pins, because a run whose
   * radiation ray count moved partway through is not comparable with one that did not.
   */
  pin(level: QualityLevel | null): void {
    this.#pinned = level
    this.#framesAbove = 0
    this.#framesBelow = 0
    if (level !== null && level !== this.#level) this.#setLevel(level)
  }

  // -- Beyond the contract -------------------------------------------------

  get pinnedLevel(): QualityLevel | null {
    return this.#pinned
  }

  /** Consecutive frames above 0.92τ. Exposed for the HUD's "about to degrade" indicator. */
  get framesAboveThreshold(): number {
    return this.#framesAbove
  }

  get framesBelowThreshold(): number {
    return this.#framesBelow
  }

  /** Level changes since construction. A high rate here means the thresholds are wrong. */
  get changeCount(): number {
    return this.#changes
  }

  #setLevel(level: QualityLevel): void {
    this.#level = level
    this.#settings = settingsFor(level)
    this.#changes += 1
    this.#onChange?.(level, this.#settings)
  }
}

export function createQualityController(
  options: QualityControllerOptions = {},
): QualityController {
  return new QualityController(options)
}
