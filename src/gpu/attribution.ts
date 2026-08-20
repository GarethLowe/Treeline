/**
 * Encoder attribution — the fix for "every phase reads 0.000 ms except render".
 *
 * `PassScheduler` can only time passes that go through it. Three subsystems open their own:
 * `FireSim.step` (on its own encoder and its own submission, deliberately — see main.ts),
 * `IFoliageRenderer.cull`, and `IEnvironmentLighting.update`. All three take a
 * `GPUCommandEncoder` and call `beginComputePass` on it directly, because their contracts
 * were frozen before the profiler existed and none of them may import it.
 *
 * Rather than widen three contracts, wrap the encoder. The proxy intercepts exactly the two
 * pass-opening methods and routes them through the profiler under a fixed phase; everything
 * else forwards to the real encoder bound to itself. The subsystem is unchanged and unaware.
 *
 * Only wrap an encoder whose frame ends in `PassScheduler.endFrame` (or one submitted before
 * such an encoder in the same frame). Timestamps live in a shared query set and are resolved
 * by that call; slots written after the last resolve of a frame are read on the next one.
 * `FireSim.selfTest` deliberately does NOT wrap, since it submits hundreds of encoders with
 * no resolve between them and would exhaust the 64-slot budget.
 */

import type { IFrameProfiler, Phase } from '@contracts/gpu'

export type PassOpener = Pick<IFrameProfiler, 'beginComputePass' | 'beginRenderPass'>

export function attributeEncoder(
  encoder: GPUCommandEncoder,
  profiler: PassOpener,
  phase: Phase,
): GPUCommandEncoder {
  return new Proxy(encoder, {
    get(target, prop) {
      if (prop === 'beginComputePass') {
        return (desc?: GPUComputePassDescriptor): GPUComputePassEncoder =>
          profiler.beginComputePass(target, phase, desc?.label ?? `${phase}:compute`)
      }
      if (prop === 'beginRenderPass') {
        return (desc: GPURenderPassDescriptor): GPURenderPassEncoder =>
          profiler.beginRenderPass(target, phase, desc.label ?? `${phase}:render`, desc)
      }
      const value = Reflect.get(target, prop, target) as unknown
      // Bind to the real encoder: Dawn checks receiver identity and a bare Proxy fails it.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
