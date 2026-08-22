/**
 * Runtime assembly — work package 1.1.
 *
 * The individual pieces are tested next door; this checks that wiring them together
 * preserves the one invariant that spans all of them: **quality scaling never changes the
 * simulation timestep or the substep count** (spec §6.5, §6.7). It is an invariant about a
 * *composition*, so it can only be tested on the composition.
 */

import { describe, expect, it } from 'vitest'
import type { QualitySettings } from '@contracts/gpu.ts'
import type { Seconds } from '@contracts/units.ts'
import { Device } from '@core/device.ts'
import { DEFAULT_FIXED_DT, type FrameScheduler } from '@core/frame-loop.ts'
import { Runtime } from '@core/runtime.ts'
import { FakeDevice } from './fake-webgpu.ts'

class ManualScheduler implements FrameScheduler {
  #cb: ((t: number) => void) | null = null
  #handle = 0
  request(cb: (timestampMs: number) => void): number {
    this.#cb = cb
    return ++this.#handle
  }
  cancel(): void {
    this.#cb = null
  }
  fire(timestampMs: number): void {
    const cb = this.#cb
    if (!cb) throw new Error('no frame armed')
    this.#cb = null
    cb(timestampMs)
  }
}

function makeRuntime(): { runtime: Runtime; fake: FakeDevice; scheduler: ManualScheduler } {
  const fake = new FakeDevice({ features: ['timestamp-query'] })
  const device = new Device({
    device: fake.asDevice(),
    context: {} as GPUCanvasContext,
    canvasFormat: 'bgra8unorm' as GPUTextureFormat,
    report: {
      vendor: 'nvidia',
      architecture: 'ada-lovelace',
      device: '',
      description: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      looksIntegrated: false,
      grantedFeatures: ['timestamp-query'],
      limitShortfalls: [],
    },
  })
  const scheduler = new ManualScheduler()
  const runtime = new Runtime(device, { loop: { scheduler, maxSubstepsPerFrame: 8 } })
  return { runtime, fake, scheduler }
}

describe('frame orchestration', () => {
  it('encodes one command buffer per frame and submits it', () => {
    const { runtime, fake, scheduler } = makeRuntime()
    runtime.start(
      () => {},
      ({ encoder, scheduler: passes }) => {
        passes.compute(encoder, 'surface', 'spread', () => {})
      },
    )
    scheduler.fire(1000)
    scheduler.fire(1025)
    expect(fake.encoders).toHaveLength(2)
    expect(fake.queue.submits).toHaveLength(2)
    for (const e of fake.encoders) expect(e.finished).toBe(true)
    runtime.stop()
  })

  it('runs a deterministic number of substeps and renders once per frame', () => {
    const { runtime, scheduler } = makeRuntime()
    const steps: Seconds[] = []
    let renders = 0
    runtime.start(
      (dt) => steps.push(dt),
      () => {
        renders += 1
      },
    )
    scheduler.fire(1000)
    // Enough wall time to be worth a countable number of substeps at whatever the shipping
    // cadence is. Derived rather than hand-written: this test is about the orchestration
    // being deterministic, not about the value of h, and it went red for the wrong reason
    // when h moved 1/120 -> 1/30.
    const frameMs = DEFAULT_FIXED_DT * 3 * 1000
    scheduler.fire(1000 + frameMs)
    expect(steps).toHaveLength(3)
    expect(renders).toBe(2)
    for (const dt of steps) expect(dt).toBe(DEFAULT_FIXED_DT)
    runtime.stop()
  })

  it('hands the current quality settings and the interpolation alpha to the frame callback', () => {
    const { runtime, scheduler } = makeRuntime()
    const seen: { alpha: number; quality: QualitySettings }[] = []
    runtime.start(
      () => {},
      ({ alpha, quality }) => seen.push({ alpha, quality }),
    )
    scheduler.fire(1000)
    scheduler.fire(1010)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.quality).toBe(runtime.quality.settings)
    expect(seen[1]!.alpha).toBeGreaterThanOrEqual(0)
    expect(seen[1]!.alpha).toBeLessThan(1)
    runtime.stop()
  })
})

describe('the invariant that spans the whole package', () => {
  it('degrading quality to level 0 changes no physics quantity whatsoever', () => {
    const { runtime, scheduler } = makeRuntime()
    const stepsAtFull: Seconds[] = []
    runtime.start(
      (dt) => stepsAtFull.push(dt),
      () => {},
    )
    // Two equal intervals, each worth a whole number of substeps at the shipping cadence, so
    // the "quality changed nothing" comparison is between two identical amounts of physics.
    const intervalMs = DEFAULT_FIXED_DT * 6 * 1000
    scheduler.fire(1000)
    scheduler.fire(1000 + intervalMs)
    const dtBefore = runtime.loop.fixedDt
    const maxSubBefore = runtime.loop.maxSubstepsPerFrame
    const simBefore = runtime.loop.simTime

    runtime.quality.pin(0)
    expect(runtime.quality.settings.resolutionScale).toBe(0.6)
    expect(runtime.quality.isDegraded).toBe(true)

    const countBefore = stepsAtFull.length
    scheduler.fire(1000 + intervalMs * 2)
    expect(runtime.loop.fixedDt).toBe(dtBefore)
    expect(runtime.loop.maxSubstepsPerFrame).toBe(maxSubBefore)
    // Six substeps' worth of wall time is six substeps whether we render at 0.6 scale or 1.0.
    expect(stepsAtFull.length - countBefore).toBe(6)
    expect(runtime.loop.simTime - simBefore).toBeCloseTo(6 * DEFAULT_FIXED_DT, 12)
    for (const dt of stepsAtFull) expect(dt).toBe(DEFAULT_FIXED_DT)
    runtime.stop()
  })

  it('radiation ray count never drops below 8, even pinned to the floor', () => {
    const { runtime } = makeRuntime()
    for (const level of [0, 1, 2, 3, 4, 5] as const) {
      runtime.quality.pin(level)
      expect(runtime.quality.settings.radiationRays).toBeGreaterThanOrEqual(8)
    }
  })
})

describe('teardown', () => {
  it('stops the loop, destroys the profiler and destroys the device', () => {
    const { runtime, fake } = makeRuntime()
    runtime.start(
      () => {},
      () => {},
    )
    runtime.destroy()
    expect(runtime.loop.running).toBe(false)
    expect(fake.destroyed).toBe(true)
    for (const b of fake.buffers) expect(b.destroyed).toBe(true)
  })
})
