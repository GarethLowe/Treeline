/**
 * GPU frame profiler — work package 1.1.
 *
 * Run against the in-package WebGPU fake, which is enough to check everything that is
 * bookkeeping rather than silicon:
 *
 * - passes are attributed to the five phases of `PHASES` and reported summed per phase,
 *   never per pass (spec §6.7, phase grouping);
 * - the staging ring is 3 deep and a buffer written this frame is never `mapAsync`-ed this
 *   frame — the rule §6.7 states and that is otherwise invisible until it throws in Chrome;
 * - the ring saturating drops a sample instead of stalling the frame;
 * - `submitMs` from `onSubmittedWorkDone()` is always available, including on a device that
 *   was never granted `timestamp-query`, because it is the ground truth the quality
 *   controller reads.
 */

import { describe, expect, it } from 'vitest'
import type { Phase } from '@contracts/gpu'
import { PHASES } from '@contracts/gpu'
import { FrameProfiler, createFrameProfiler } from '@gpu/profiler.ts'
import { FakeDevice, flushMicrotasks, mulberry32 } from './fake-webgpu.ts'

const US = 1000 // ns per microsecond

/** Build a timestamp script: pass i occupies queries 2i (begin) and 2i+1 (end). */
function script(passDurationsUs: readonly number[], gapUs = 5): BigUint64Array {
  const out = new BigUint64Array(passDurationsUs.length * 2)
  let t = 1_000_000 // an arbitrary non-zero GPU clock origin, ns
  passDurationsUs.forEach((durUs, i) => {
    out[i * 2] = BigInt(t)
    t += durUs * US
    out[i * 2 + 1] = BigInt(t)
    t += gapUs * US
  })
  return out
}

interface Frame {
  readonly phases: readonly Phase[]
  readonly durationsUs: readonly number[]
}

/** Encode, resolve, submit and let the readback settle for one frame. */
async function runFrame(device: FakeDevice, profiler: FrameProfiler, frame: Frame): Promise<void> {
  device.scriptedTimestamps = script(frame.durationsUs)
  const encoder = device.createCommandEncoder({ label: 'frame' })
  frame.phases.forEach((phase, i) => {
    const pass = profiler.beginComputePass(
      encoder as unknown as GPUCommandEncoder,
      phase,
      `${phase}:pass${i}`,
    )
    pass.end()
  })
  profiler.resolve(encoder as unknown as GPUCommandEncoder)
  encoder.finish()
  device.queue.submit([])
  profiler.markSubmit()
  await flushMicrotasks()
}

function deviceWithTimestamps(): FakeDevice {
  return new FakeDevice({ features: ['timestamp-query'] })
}

describe('construction', () => {
  it('allocates one query set, one resolve buffer and a 3-deep staging ring', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice(), { maxPasses: 8 })
    expect(profiler.enabled).toBe(true)
    expect(device.querySets).toHaveLength(1)
    expect(device.querySets[0]!.type).toBe('timestamp')
    expect(device.querySets[0]!.count).toBe(16) // 2 queries per pass
    // 1 resolve + 3 staging.
    expect(device.buffers).toHaveLength(4)
    const staging = device.buffers.filter((b) => b.label.startsWith('profiler:staging'))
    expect(staging).toHaveLength(3)
    for (const b of staging) {
      expect(b.usage & GPUBufferUsage.MAP_READ).toBeTruthy()
      expect(b.usage & GPUBufferUsage.COPY_DST).toBeTruthy()
    }
  })

  it('allocates nothing when timestamp-query was not granted', () => {
    const device = new FakeDevice({ features: [] })
    const profiler = createFrameProfiler(device.asDevice())
    expect(profiler.enabled).toBe(false)
    expect(device.querySets).toHaveLength(0)
    expect(device.buffers).toHaveLength(0)
  })

  it('reports highResolution only when the dev-build flag is set', () => {
    const device = deviceWithTimestamps()
    expect(createFrameProfiler(device.asDevice()).timings.highResolution).toBe(false)
    expect(
      createFrameProfiler(device.asDevice(), { highResolution: true }).timings.highResolution,
    ).toBe(true)
  })
})

describe('pass attribution', () => {
  it('attaches timestampWrites with the right query indices and a debug label', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    const encoder = device.createCommandEncoder({})
    profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'surface', 'spread').end()
    profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'canopy', 'radiation').end()
    expect(encoder.passes).toEqual([
      { kind: 'compute', label: 'spread', timed: true, beginIndex: 0, endIndex: 1 },
      { kind: 'compute', label: 'radiation', timed: true, beginIndex: 2, endIndex: 3 },
    ])
  })

  it('labels and times render passes too', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    const encoder = device.createCommandEncoder({})
    profiler
      .beginRenderPass(
        encoder as unknown as GPUCommandEncoder,
        'render',
        'forward',
        { colorAttachments: [] } as unknown as GPURenderPassDescriptor,
      )
      .end()
    expect(encoder.passes[0]).toMatchObject({ kind: 'render', label: 'forward', timed: true })
  })

  it('stops timing past maxPasses instead of writing out of range', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice(), { maxPasses: 2 })
    const encoder = device.createCommandEncoder({})
    for (let i = 0; i < 4; i++) {
      profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'surface', `p${i}`).end()
    }
    expect(encoder.passes.filter((p) => p.timed)).toHaveLength(2)
    expect(encoder.passes.filter((p) => !p.timed)).toHaveLength(2)
    // Out-of-range query indices would be a validation error that kills the whole frame,
    // so overflowing must degrade to untimed rather than to broken.
    for (const p of encoder.passes) {
      if (p.beginIndex !== undefined) expect(p.beginIndex).toBeLessThan(4)
    }
  })

  it('does not time anything on a device without timestamp-query', () => {
    const device = new FakeDevice({ features: [] })
    const profiler = createFrameProfiler(device.asDevice())
    const encoder = device.createCommandEncoder({})
    profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'surface', 'spread').end()
    expect(encoder.passes[0]?.timed).toBe(false)
  })
})

describe('readback and phase grouping', () => {
  it('sums passes into their phase and leaves untouched phases at zero', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    const frame: Frame = {
      phases: ['surface', 'surface', 'canopy', 'render'],
      durationsUs: [200, 150, 400, 6000],
    }
    // Three frames: the copy lands on frame n, the map starts on n+1, so timings appear by
    // the third frame at the latest.
    for (let i = 0; i < 3; i++) await runFrame(device, profiler, frame)

    expect(profiler.gpuSamplesSeen).toBeGreaterThan(0)
    expect(profiler.lastPhaseMs.surface).toBeCloseTo(0.35, 6) // 200 + 150 us
    expect(profiler.lastPhaseMs.canopy).toBeCloseTo(0.4, 6)
    expect(profiler.lastPhaseMs.render).toBeCloseTo(6.0, 6)
    expect(profiler.lastPhaseMs.fluid).toBe(0)
    expect(profiler.lastPhaseMs.brands).toBe(0)
  })

  it('reports per-phase EMAs through the contract surface', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    const frame: Frame = { phases: ['surface', 'canopy'], durationsUs: [400, 900] }
    for (let i = 0; i < 40; i++) await runFrame(device, profiler, frame)
    const t = profiler.timings
    expect(Object.keys(t.phaseMs).sort()).toEqual([...PHASES].sort())
    expect(t.phaseMs.surface).toBeCloseTo(0.4, 3)
    expect(t.phaseMs.canopy).toBeCloseTo(0.9, 3)
  })

  it('keeps per-pass detail available for dev builds', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice(), { highResolution: true })
    const frame: Frame = { phases: ['surface', 'brands'], durationsUs: [700, 300] }
    for (let i = 0; i < 3; i++) await runFrame(device, profiler, frame)
    expect(profiler.lastPasses.map((p) => p.label)).toEqual(['surface:pass0', 'brands:pass1'])
    expect(profiler.lastPasses[0]?.ms).toBeCloseTo(0.7, 6)
  })

  it('measures whole-frame GPU time as a span, so inter-pass gaps are counted', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    // Three 1 ms passes separated by 5 us gaps: sum is 3.0 ms, span is 3.010 ms. The frame
    // budget pays for the gaps, so the controller must see the span.
    const frame: Frame = { phases: ['surface', 'canopy', 'render'], durationsUs: [1000, 1000, 1000] }
    for (let i = 0; i < 5; i++) await runFrame(device, profiler, frame)
    expect(profiler.medianFrameMs).toBeCloseTo(3.01, 6)
  })

  it('discards a pass whose timestamps are not monotonic', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    // A pass whose indirect dispatch was skipped for zero workgroups can leave its query
    // slot unwritten. Counting that as 0 ms would hand the quality controller fictitious
    // headroom, so it is dropped instead.
    const ts = new BigUint64Array([100n, 0n, 1_000_000n, 1_400_000n])
    profiler.ingest(ts, ['surface', 'canopy'], ['skipped', 'real'])
    expect(profiler.lastPhaseMs.surface).toBe(0)
    expect(profiler.lastPhaseMs.canopy).toBeCloseTo(0.4, 6)
    expect(profiler.lastPasses).toHaveLength(1)
  })

  it('ignores a frame in which nothing was timed at all', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    profiler.ingest(new BigUint64Array([5n, 5n]), ['surface'], ['nothing'])
    expect(profiler.gpuSamplesSeen).toBe(0)
    expect(profiler.timings.phaseMs.surface).toBe(0)
  })
})

describe('the 3-deep staging ring (spec §6.7)', () => {
  it('never maps a buffer that was written during the frame being encoded', async () => {
    const device = deviceWithTimestamps()
    device.mapGate.auto = false // hold every map open so we can inspect the state
    const profiler = createFrameProfiler(device.asDevice())
    const staging = device.buffers.filter((b) => b.label.startsWith('profiler:staging'))
    const frame: Frame = { phases: ['surface'], durationsUs: [500] }

    await runFrame(device, profiler, frame) // frame 0 writes staging0
    expect(staging[0]!.mapRequests).toBe(0) // not mapped on the frame that wrote it
    await runFrame(device, profiler, frame) // frame 1 maps staging0, writes staging1
    expect(staging[0]!.mapRequests).toBe(1)
    expect(staging[1]!.mapRequests).toBe(0)
    await runFrame(device, profiler, frame)
    expect(staging[1]!.mapRequests).toBe(1)
    expect(staging[2]!.mapRequests).toBe(0)
  })

  it('drops the sample rather than stalling when all three buffers are in flight', async () => {
    const device = deviceWithTimestamps()
    device.mapGate.auto = false
    const profiler = createFrameProfiler(device.asDevice())
    const frame: Frame = { phases: ['surface'], durationsUs: [500] }
    for (let i = 0; i < 6; i++) await runFrame(device, profiler, frame)
    // Three buffers written, none returned: from the fourth frame on the profiler has
    // nowhere to copy. Waiting for a map would make the profiler the thing being measured.
    expect(profiler.droppedSamples).toBeGreaterThan(0)
    expect(profiler.gpuSamplesSeen).toBe(0)

    // Once the maps complete the ring recovers and samples flow again.
    device.mapGate.flush()
    await flushMicrotasks()
    expect(profiler.gpuSamplesSeen).toBeGreaterThan(0)
    const before = profiler.droppedSamples
    device.mapGate.auto = true
    for (let i = 0; i < 3; i++) await runFrame(device, profiler, frame)
    expect(profiler.droppedSamples).toBe(before)
  })

  it('copies only the bytes actually used, not the whole query set', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice(), { maxPasses: 64 })
    const encoder = device.createCommandEncoder({})
    device.scriptedTimestamps = script([100, 100])
    profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'surface', 'a').end()
    profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'surface', 'b').end()
    profiler.resolve(encoder as unknown as GPUCommandEncoder)
    expect(encoder.copies).toEqual([
      { src: 'profiler:resolve', dst: 'profiler:staging0', size: 2 * 2 * 8 },
    ])
    expect(encoder.resolveCalls).toBe(1)
  })

  it('does not resolve or copy on a frame with no timed passes', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    const encoder = device.createCommandEncoder({})
    profiler.resolve(encoder as unknown as GPUCommandEncoder)
    expect(encoder.resolveCalls).toBe(0)
    expect(encoder.copies).toHaveLength(0)
  })

  it('still drains a pending entry on an idle frame', async () => {
    const device = deviceWithTimestamps()
    device.mapGate.auto = false
    const profiler = createFrameProfiler(device.asDevice())
    await runFrame(device, profiler, { phases: ['surface'], durationsUs: [500] })
    // A frame with nothing timed must not leave the previous frame's buffer out of
    // rotation forever, which is what an early return before the promotion step would do.
    const idle = device.createCommandEncoder({})
    profiler.resolve(idle as unknown as GPUCommandEncoder)
    expect(device.mapGate.pendingCount).toBe(1)
  })
})

describe('submit wall clock', () => {
  it('records submitMs from onSubmittedWorkDone even without timestamp-query', async () => {
    const device = new FakeDevice({ features: [] })
    let clock = 0
    const profiler = createFrameProfiler(device.asDevice(), { now: () => clock })
    for (let i = 0; i < 5; i++) {
      clock = i * 100
      profiler.markSubmit()
      clock = i * 100 + 7 // 7 ms of GPU work
      await flushMicrotasks()
    }
    expect(profiler.timings.submitMs).toBeCloseTo(7, 6)
    expect(profiler.medianSubmitMs).toBeCloseTo(7, 6)
    // With no GPU timestamps the wall clock is what the quality controller steers on.
    expect(profiler.medianFrameMs).toBeCloseTo(7, 6)
  })

  it('prefers the GPU span once timestamps are arriving', async () => {
    const device = deviceWithTimestamps()
    device.queue.workDoneGate.auto = false // hold the submit clock open until we say so
    let clock = 0
    const profiler = createFrameProfiler(device.asDevice(), { now: () => clock })
    const frame: Frame = { phases: ['surface'], durationsUs: [2000] }
    for (let i = 0; i < 5; i++) {
      clock = i * 100
      await runFrame(device, profiler, frame)
      clock = i * 100 + 20 // CPU-side queue latency the controller cannot fix
      device.queue.workDoneGate.flush()
      await flushMicrotasks()
    }
    expect(profiler.medianFrameMs).toBeCloseTo(2.0, 6)
    expect(profiler.timings.submitMs).toBeGreaterThan(2.0)
  })
})

describe('EMA behaviour end to end under quantisation', () => {
  it('converges on the true phase cost from quantised samples', async () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    const rng = mulberry32(31337)
    const trueUs = 850
    for (let frame = 0; frame < 300; frame++) {
      // Chrome quantises each timestamp to 100 us; model that here by snapping the scripted
      // begin/end onto the 100 us grid with a random sub-quantum offset per frame.
      const offset = Math.floor(rng() * 100) * US
      const begin = Math.floor((1_000_000 + offset) / (100 * US)) * (100 * US)
      const end = Math.floor((1_000_000 + offset + trueUs * US) / (100 * US)) * (100 * US)
      profiler.ingest(
        new BigUint64Array([BigInt(begin), BigInt(end)]),
        ['canopy'],
        ['canopy:radiation'],
      )
    }
    const errUs = Math.abs(profiler.timings.phaseMs.canopy - trueUs / 1000) * 1000
    expect(errUs, `EMA off by ${errUs.toFixed(1)} us`).toBeLessThan(20)
  })
})

describe('destroy', () => {
  it('releases the query set and every staging buffer, and is idempotent', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    profiler.destroy()
    profiler.destroy()
    expect(device.querySets[0]!.destroyed).toBe(true)
    for (const b of device.buffers) expect(b.destroyed).toBe(true)
  })

  it('stops timing passes after destroy rather than touching a dead query set', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    profiler.destroy()
    const encoder = device.createCommandEncoder({})
    profiler.beginComputePass(encoder as unknown as GPUCommandEncoder, 'surface', 'after').end()
    expect(encoder.passes[0]?.timed).toBe(false)
  })

  it('is a FrameProfiler instance satisfying the contract shape', () => {
    const device = deviceWithTimestamps()
    const profiler = createFrameProfiler(device.asDevice())
    expect(profiler).toBeInstanceOf(FrameProfiler)
    const t = profiler.timings
    expect(typeof t.medianFrameMs).toBe('number')
    expect(typeof t.submitMs).toBe('number')
    expect(typeof t.highResolution).toBe('boolean')
    for (const p of PHASES) expect(typeof t.phaseMs[p]).toBe('number')
  })
})
