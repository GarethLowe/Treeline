/**
 * Pass scheduler and runtime assembly — work package 1.1.
 *
 * The scheduler is thin on purpose (spec §6.3: pass count is the thing to minimise), so
 * there are only four things to check, and all four are things that go wrong silently:
 * labels reach the capture tool, a pass is ended even when encoding throws, `computeMulti`
 * really does produce *one* pass rather than several, and `endFrame` does resolve → finish
 * → submit → markSubmit in that order.
 */

import { describe, expect, it } from 'vitest'
import type { Phase } from '@contracts/gpu'
import { NULL_PASS_PROFILER, PassScheduler, createPassScheduler } from '@gpu/pass-scheduler.ts'
import { createFrameProfiler } from '@gpu/profiler.ts'
import { QualityController } from '@gpu/quality.ts'
import { FakeDevice } from './fake-webgpu.ts'

function scheduler(device: FakeDevice, withProfiler = false): PassScheduler {
  return createPassScheduler({
    device: device.asDevice(),
    ...(withProfiler ? { profiler: createFrameProfiler(device.asDevice()) } : {}),
  })
}

describe('labels', () => {
  it('labels every pass phase:name so a PIX or Nsight capture is readable', () => {
    const device = new FakeDevice({ features: ['timestamp-query'] })
    const sched = scheduler(device, true)
    const encoder = sched.beginFrame('frame7')
    sched.compute(encoder, 'surface', 'spread', () => {})
    sched.render(
      encoder,
      'render',
      'forward',
      { colorAttachments: [] } as unknown as GPURenderPassDescriptor,
      () => {},
    )
    const fake = device.encoders[0]!
    expect(fake.label).toBe('frame7')
    expect(fake.passes.map((p) => p.label)).toEqual(['surface:spread', 'render:forward'])
  })

  it('nests debug groups and always pops them', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    sched.group(encoder, 'substep0', () => {
      sched.compute(encoder, 'surface', 'spread', () => {})
    })
    const fake = device.encoders[0]!
    expect(fake.debugGroups).toEqual(['substep0'])
    expect(fake.debugGroupStack).toHaveLength(0)
    expect(() => fake.finish()).not.toThrow()
  })

  it('pops the debug group even when the body throws', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    expect(() =>
      sched.group(encoder, 'substep0', () => {
        throw new Error('encode failed')
      }),
    ).toThrow('encode failed')
    expect(device.encoders[0]!.debugGroupStack).toHaveLength(0)
  })
})

describe('pass lifetime', () => {
  it('ends the pass for you', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    sched.compute(encoder, 'surface', 'spread', () => {})
    expect(device.encoders[0]!.openPasses.every((p) => p.ended)).toBe(true)
  })

  it('ends the pass even when the body throws, so the original error is what surfaces', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    expect(() =>
      sched.compute(encoder, 'surface', 'spread', () => {
        throw new Error('bad bind group')
      }),
    ).toThrow('bad bind group')
    // Without the finally, finish() would raise "unfinished pass" and bury the real cause.
    expect(device.encoders[0]!.openPasses[0]!.ended).toBe(true)
    expect(() => device.encoders[0]!.finish()).not.toThrow()
  })

  it('returns whatever the body returns', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    expect(sched.compute(encoder, 'brands', 'integrate', () => 42)).toBe(42)
  })
})

describe('computeMulti is the §6.3 overlap lever', () => {
  it('issues several independent workloads inside exactly one pass', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    const order: string[] = []
    sched.computeMulti(encoder, 'fluid', 'wind+spread', [
      () => order.push('wind'),
      () => order.push('spread'),
    ])
    // One pass, not two: each extra pass boundary is a full barrier plus ~2-5 us of Dawn
    // encoding, and merging is the only lever the architecture identifies for real overlap.
    expect(device.encoders[0]!.passes).toHaveLength(1)
    expect(device.encoders[0]!.passes[0]!.label).toBe('fluid:wind+spread')
    expect(order).toEqual(['wind', 'spread'])
    expect(sched.passCount).toBe(1)
  })
})

describe('frame submission order', () => {
  it('resolves the profiler, finishes, submits, then starts the submit clock', () => {
    const device = new FakeDevice()
    const events: string[] = []
    const profiler = {
      beginComputePass: (e: GPUCommandEncoder, _p: Phase, label: string) =>
        e.beginComputePass({ label }),
      beginRenderPass: (e: GPUCommandEncoder, _p: Phase, label: string, d: GPURenderPassDescriptor) =>
        e.beginRenderPass({ ...d, label }),
      resolve: () => events.push('resolve'),
    }
    const sched = new PassScheduler({
      device: device.asDevice(),
      profiler,
      onSubmit: () => events.push('markSubmit'),
    })
    const encoder = sched.beginFrame()
    sched.compute(encoder, 'surface', 'spread', () => {})
    sched.endFrame(encoder)
    expect(events).toEqual(['resolve', 'markSubmit'])
    expect(device.queue.submits).toHaveLength(1)
    expect(device.encoders[0]!.finished).toBe(true)
  })

  it('works with the null profiler, which measures nothing and breaks nothing', () => {
    const device = new FakeDevice()
    const sched = new PassScheduler({ device: device.asDevice(), profiler: NULL_PASS_PROFILER })
    const encoder = sched.beginFrame()
    sched.compute(encoder, 'canopy', 'thermal', () => {})
    sched.endFrame(encoder)
    expect(device.encoders[0]!.passes[0]!.timed).toBe(false)
    expect(device.encoders[0]!.passes[0]!.label).toBe('canopy:thermal')
    expect(device.queue.submits).toHaveLength(1)
  })

  it('counts passes so the §6.3 budget can be checked against reality', () => {
    const device = new FakeDevice()
    const sched = scheduler(device)
    const encoder = sched.beginFrame()
    for (let i = 0; i < 12; i++) sched.compute(encoder, 'surface', `p${i}`, () => {})
    expect(sched.passCount).toBe(12)
  })
})

describe('the quality controller cannot reach the pass schedule', () => {
  it('drives only render-side knobs, never the number of substeps encoded', () => {
    // A structural check on the assembly this package ships: the settings object the
    // scheduler's callers read has four fields, none of which is a substep count. Spec
    // §6.7 makes this a hard requirement, and the failure it prevents is invisible —
    // physics quietly degraded to hold framerate, with the HUD still exporting numbers.
    const q = new QualityController()
    const before = Object.keys(q.settings)
    q.pin(0)
    expect(before).toHaveLength(4)
    expect(before).toContain('resolutionScale')
    expect(Object.keys(q.settings)).toEqual(before)
    expect(before).not.toContain('substeps')
  })
})
