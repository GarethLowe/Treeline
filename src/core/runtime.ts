/**
 * Runtime assembly — work package 1.1.
 *
 * Wires the four pieces of the frame infrastructure together in the one order that is
 * correct, so no caller has to rediscover it:
 *
 *   device → profiler → pass scheduler → frame loop → quality controller
 *
 * The loop calls `onStep` a fixed number of times per frame and `onRender` once. The
 * quality controller is updated once per rendered frame from the profiler's timings, and
 * is structurally unable to reach the loop: it is handed `FrameTimings` and returns
 * `QualitySettings`, and there is no path from either to `fixedDt` or the substep count
 * (spec §6.5, §6.7).
 */

import type { QualitySettings } from '@contracts/gpu.ts'
import type { Seconds } from '@contracts/units.ts'
import { FrameProfiler } from '@gpu/profiler.ts'
import type { FrameProfilerOptions } from '@gpu/profiler.ts'
import { PassScheduler } from '@gpu/pass-scheduler.ts'
import { QualityController } from '@gpu/quality.ts'
import type { QualityControllerOptions } from '@gpu/quality.ts'
import type { Device } from './device.ts'
import { FrameLoop } from './frame-loop.ts'
import type { FrameLoopOptions } from './frame-loop.ts'

export interface RuntimeOptions {
  readonly loop?: FrameLoopOptions
  readonly profiler?: FrameProfilerOptions
  readonly quality?: QualityControllerOptions
}

export interface FrameContext {
  readonly encoder: GPUCommandEncoder
  readonly scheduler: PassScheduler
  /** Accumulator residue as a fraction of the fixed step, for froxel interpolation. */
  readonly alpha: number
  readonly quality: QualitySettings
}

export class Runtime {
  readonly device: Device
  readonly profiler: FrameProfiler
  readonly scheduler: PassScheduler
  readonly loop: FrameLoop
  readonly quality: QualityController

  constructor(device: Device, options: RuntimeOptions = {}) {
    this.device = device
    this.profiler = new FrameProfiler(device.device, options.profiler ?? {})
    this.scheduler = new PassScheduler({
      device: device.device,
      profiler: this.profiler,
      onSubmit: () => this.profiler.markSubmit(),
    })
    this.loop = new FrameLoop(options.loop ?? {})
    this.quality = new QualityController(options.quality ?? {})
  }

  /**
   * Start the frame loop.
   *
   * @param onStep  one fixed simulation substep. Never called a variable number of times
   *                *per unit of simulated time* — only per frame.
   * @param onFrame encode one rendered frame. The encoder is created, the profiler
   *                resolved and the work submitted around it.
   */
  start(onStep: (dt: Seconds) => void, onFrame: (ctx: FrameContext) => void): void {
    this.loop.start(onStep, (alpha) => {
      // Quality is updated before encoding so this frame's passes see the new settings;
      // the timings it reads are from frame n-3 or so, which is exactly the latency the
      // hysteresis dwell counts are chosen to swamp.
      this.quality.update(this.profiler.timings)
      const encoder = this.scheduler.beginFrame(`frame${this.loop.frameIndex}`)
      onFrame({
        encoder,
        scheduler: this.scheduler,
        alpha,
        quality: this.quality.settings,
      })
      this.scheduler.endFrame(encoder)
    })
  }

  stop(): void {
    this.loop.stop()
  }

  destroy(): void {
    this.loop.stop()
    this.profiler.destroy()
    this.device.destroy()
  }
}
