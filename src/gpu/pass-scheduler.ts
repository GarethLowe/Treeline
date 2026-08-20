/**
 * Pass scheduler — work package 1.1.
 *
 * A thin wrapper over `encoder.beginComputePass` / `beginRenderPass` that attaches profiler
 * attribution and debug labels, and that cannot leave a pass un-ended.
 *
 * Deliberately thin. Spec §6.3 is explicit that *pass count is the thing to minimise* —
 * WebGPU infers dependencies per pass, consecutive compute passes on one queue are
 * conservatively serialised, and each boundary costs a full barrier plus ~2–5 µs of Dawn
 * encoding. A scheduler that invited callers to declare one pass per kernel would make the
 * expensive thing look free. So this offers exactly two things: a scope that ends the pass
 * for you, and a `multi` form that issues several independent dispatches inside *one* pass,
 * which is the only lever §6.3 identifies for real overlap.
 *
 * Three properties are worth stating because they are easy to lose later:
 *
 * - `end()` runs in a `finally`, so an exception thrown while encoding does not cascade
 *   into an "unfinished pass" validation error that hides the original throw.
 * - Every pass carries a debug label of the form `phase:name`, which is what a PIX or
 *   Nsight capture shows. §6.3's open question — whether Dawn actually leaves independent
 *   dispatches in one pass unfenced — can only be settled by reading such a capture.
 * - `endFrame` resolves the profiler *before* submitting and marks the submit *after*, in
 *   that order. Both are required by §6.7 and neither is obvious from the call sites.
 */

import type { IFrameProfiler, Phase } from '@contracts/gpu'

/** The subset of the profiler the scheduler needs; keeps it usable with a null profiler. */
export type PassProfiler = Pick<IFrameProfiler, 'beginComputePass' | 'beginRenderPass' | 'resolve'>

/** A profiler that measures nothing, for bring-up and for tests that do not care. */
export const NULL_PASS_PROFILER: PassProfiler = {
  beginComputePass: (encoder, _phase, label) => encoder.beginComputePass({ label }),
  beginRenderPass: (encoder, _phase, label, desc) => encoder.beginRenderPass({ ...desc, label }),
  resolve: () => {},
}

export interface PassSchedulerOptions {
  readonly device: GPUDevice
  readonly profiler?: PassProfiler
  /** Called right after `queue.submit()`; wire this to `FrameProfiler.markSubmit`. */
  readonly onSubmit?: () => void
}

export class PassScheduler {
  readonly device: GPUDevice
  readonly profiler: PassProfiler
  readonly #onSubmit: (() => void) | undefined

  #passCount = 0

  constructor(options: PassSchedulerOptions) {
    this.device = options.device
    this.profiler = options.profiler ?? NULL_PASS_PROFILER
    this.#onSubmit = options.onSubmit
  }

  /** Timed passes encoded since construction. Sanity check against the §6.3 pass budget. */
  get passCount(): number {
    return this.#passCount
  }

  beginFrame(label = 'frame'): GPUCommandEncoder {
    return this.device.createCommandEncoder({ label })
  }

  /**
   * Encode one compute pass attributed to `phase`. The pass is ended for you.
   *
   * @returns whatever `body` returns, so a caller can hand back e.g. a dispatch count.
   */
  compute<T>(
    encoder: GPUCommandEncoder,
    phase: Phase,
    name: string,
    body: (pass: GPUComputePassEncoder) => T,
  ): T {
    const pass = this.profiler.beginComputePass(encoder, phase, `${phase}:${name}`)
    this.#passCount += 1
    try {
      return body(pass)
    } finally {
      pass.end()
    }
  }

  /**
   * Encode several independent workloads inside a *single* compute pass.
   *
   * This is the §6.3 overlap lever: WebGPU has no barrier API, so the only way to let two
   * independent kernels run concurrently is to put them in one pass with no intervening
   * bind-group change on a shared resource. Use it only for workloads that are genuinely
   * independent within the substep (P5 wind and P2 surface spread are the worked example);
   * a true read-after-write hazard needs its own pass and will be silently wrong here.
   */
  computeMulti(
    encoder: GPUCommandEncoder,
    phase: Phase,
    name: string,
    bodies: readonly ((pass: GPUComputePassEncoder) => void)[],
  ): void {
    this.compute(encoder, phase, name, (pass) => {
      for (const body of bodies) body(pass)
    })
  }

  render<T>(
    encoder: GPUCommandEncoder,
    phase: Phase,
    name: string,
    desc: GPURenderPassDescriptor,
    body: (pass: GPURenderPassEncoder) => T,
  ): T {
    const pass = this.profiler.beginRenderPass(encoder, phase, `${phase}:${name}`, desc)
    this.#passCount += 1
    try {
      return body(pass)
    } finally {
      pass.end()
    }
  }

  /** Bracket a group of passes in a capture-tool debug group. */
  group<T>(encoder: GPUCommandEncoder, label: string, body: () => T): T {
    encoder.pushDebugGroup(label)
    try {
      return body()
    } finally {
      encoder.popDebugGroup()
    }
  }

  /**
   * Resolve the profiler, finish the encoder, submit, and start the submit wall clock.
   *
   * Order matters: `resolve()` must be encoded into this frame's encoder before `finish()`,
   * and `onSubmit()` must run after `submit()` so `onSubmittedWorkDone()` is chained on the
   * work we just queued.
   */
  endFrame(encoder: GPUCommandEncoder): void {
    this.profiler.resolve(encoder)
    this.device.queue.submit([encoder.finish()])
    this.#onSubmit?.()
  }
}

export function createPassScheduler(options: PassSchedulerOptions): PassScheduler {
  return new PassScheduler(options)
}
