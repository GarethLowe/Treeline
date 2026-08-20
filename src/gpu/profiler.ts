/**
 * GPU frame profiler — work package 1.1.
 *
 * Implements `IFrameProfiler` from `@contracts/gpu`. See
 * docs/spec/10-webgpu-architecture.md §6.7.
 *
 * Three things make this more than a `beginComputePass` wrapper:
 *
 * 1. **Phase grouping.** Chrome quantises timestamp query results to 100 µs as a
 *    timing-attack mitigation, and nine of the twelve simulation passes are below that. A
 *    per-pass number from a shipping build is therefore *noise*, not a measurement. Passes
 *    are timed individually but only ever *reported* summed into the five phases of
 *    `PHASES`, each of which is >= 300 µs, so quantisation is <= 30% of a sample.
 * 2. **EMA over >= 120 frames, decay 0.98.** The quantisation error is uncorrelated with
 *    the signal, so its mean converges (see `statistics.ts` for the error budget).
 * 3. **A 3-deep MAP_READ staging ring, read behind the write head.** `mapAsync` is never
 *    called on a buffer touched by the frame currently being encoded. A buffer written on
 *    frame *n* is mapped no earlier than frame *n*+1 and is not reused before frame *n*+3.
 *
 * And `device.queue.onSubmittedWorkDone()` gives a CPU-timeline wall clock for the whole
 * submit: cheap, always available even without `timestamp-query`, and the ground truth the
 * quality controller falls back to.
 */

import type { FrameTimings, IFrameProfiler, Phase } from '@contracts/gpu'
import { PHASES } from '@contracts/gpu'
import { EMA_DECAY, Ema, RunningMedian } from './statistics.ts'

/**
 * Timed passes per frame. Spec §6.3 has 12 simulation passes at up to 4 substeps plus the
 * renderer's passes.
 *
 * Raised from 64 on 2026-08-19, when `gpu/attribution.ts` brought the fire solver, the
 * foliage cull and the environment prefilter inside the profiler for the first time. The
 * solver encodes two passes per substep and the HUD's time-scale control multiplies the
 * substep count by up to 16, so 64 overflowed immediately and every phase total read low.
 * 256 passes is 512 queries — 4 KiB of resolve buffer, which is not a meaningful allocation.
 */
export const MAX_TIMED_PASSES = 256

/** Ring depth. §6.7: "a 3-deep ring of MAP_READ staging buffers ... read frame n−3". */
const RING_DEPTH = 3

const BYTES_PER_QUERY = 8 // u64 nanoseconds
const NS_PER_MS = 1e6
/** Chrome's timing-attack mitigation snaps timestamps to this grid. See highResolution. */
const QUANTUM_NS = 100_000n

type EntryState = 'idle' | 'written' | 'mapping'

interface RingEntry {
  readonly buffer: GPUBuffer
  state: EntryState
  /** Profiler frame index the copy into this buffer was encoded on. */
  writtenFrame: number
  /** Phase of each timed pass slot in that frame, in slot order. */
  phases: Phase[]
  /** Debug label of each timed pass slot, parallel to `phases`. */
  labels: string[]
}

export interface FrameProfilerOptions {
  /**
   * Force timestamp queries on or off. Defaults to whether the device was granted
   * `timestamp-query`; without it the profiler still reports `submitMs` and drives the
   * quality controller from the wall clock.
   */
  readonly timestamps?: boolean
  /**
   * True in a dev build launched with `chrome://flags/#enable-webgpu-developer-features`,
   * which removes the 100 µs quantisation. Per-pass figures are only trustworthy then, and
   * every per-pass µs number in spec §6.3 must be measured this way. Default false.
   */
  readonly highResolution?: boolean
  /** EMA decay. Default 0.98 (spec §6.7). */
  readonly emaDecay?: number
  /** Whole-frame median window. Default 30 frames (spec §6.7). */
  readonly medianWindow?: number
  /** Max timed passes per frame. Default {@link MAX_TIMED_PASSES}. */
  readonly maxPasses?: number
  /** Injected clock, milliseconds. Defaults to `performance.now`. */
  readonly now?: () => number
}

/** Per-pass detail. Only meaningful in a dev build; see `highResolution`. */
export interface PassSample {
  readonly label: string
  readonly phase: Phase
  readonly ms: number
}

function zeroPhases(): Record<Phase, number> {
  const out = {} as Record<Phase, number>
  for (const p of PHASES) out[p] = 0
  return out
}

export class FrameProfiler implements IFrameProfiler {
  readonly device: GPUDevice
  readonly enabled: boolean
  readonly maxPasses: number

  readonly #querySet: GPUQuerySet | null
  readonly #resolveBuffer: GPUBuffer | null
  readonly #ring: RingEntry[] = []
  readonly #now: () => number

  /** Phase of each slot used in the frame currently being encoded. */
  #slotPhases: Phase[] = []
  #slotLabels: string[] = []
  #overflowWarned = false
  #frame = 0
  #destroyed = false

  readonly #phaseEma: Record<Phase, Ema>
  readonly #frameMedian: RunningMedian
  readonly #submitMedian: RunningMedian
  #lastSubmitMs = 0
  #lastPhaseMs: Record<Phase, number> = zeroPhases()
  #lastPasses: PassSample[] = []
  #gpuSamplesSeen = 0
  #droppedSamples = 0
  readonly #highResolution: boolean
  /** Set once a timestamp is observed off the 100 us grid — see resolve(). */
  #highResolutionDetected = false

  constructor(device: GPUDevice, options: FrameProfilerOptions = {}) {
    this.device = device
    this.maxPasses = options.maxPasses ?? MAX_TIMED_PASSES
    this.#highResolution = options.highResolution ?? false
    this.#now = options.now ?? (() => performance.now())
    this.#frameMedian = new RunningMedian(options.medianWindow ?? 30)
    this.#submitMedian = new RunningMedian(options.medianWindow ?? 30)

    const decay = options.emaDecay ?? EMA_DECAY
    const emas = {} as Record<Phase, Ema>
    for (const p of PHASES) emas[p] = new Ema(decay)
    this.#phaseEma = emas

    const want = options.timestamps ?? device.features.has('timestamp-query')
    this.enabled = want

    if (!want) {
      this.#querySet = null
      this.#resolveBuffer = null
      return
    }

    const queryCount = this.maxPasses * 2
    this.#querySet = device.createQuerySet({
      label: 'profiler:timestamps',
      type: 'timestamp',
      count: queryCount,
    })
    this.#resolveBuffer = device.createBuffer({
      label: 'profiler:resolve',
      size: queryCount * BYTES_PER_QUERY,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    })
    for (let i = 0; i < RING_DEPTH; i++) {
      this.#ring.push({
        buffer: device.createBuffer({
          label: `profiler:staging${i}`,
          size: queryCount * BYTES_PER_QUERY,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        state: 'idle',
        writtenFrame: -1,
        phases: [],
        labels: [],
      })
    }
  }

  // -- IFrameProfiler ------------------------------------------------------

  beginComputePass(
    encoder: GPUCommandEncoder,
    phase: Phase,
    label: string,
  ): GPUComputePassEncoder {
    const slot = this.#claimSlot(phase, label)
    const desc: GPUComputePassDescriptor = { label }
    if (slot !== null && this.#querySet) {
      return encoder.beginComputePass({
        ...desc,
        timestampWrites: {
          querySet: this.#querySet,
          beginningOfPassWriteIndex: slot * 2,
          endOfPassWriteIndex: slot * 2 + 1,
        },
      })
    }
    return encoder.beginComputePass(desc)
  }

  beginRenderPass(
    encoder: GPUCommandEncoder,
    phase: Phase,
    label: string,
    desc: GPURenderPassDescriptor,
  ): GPURenderPassEncoder {
    const slot = this.#claimSlot(phase, label)
    if (slot !== null && this.#querySet) {
      return encoder.beginRenderPass({
        ...desc,
        label,
        timestampWrites: {
          querySet: this.#querySet,
          beginningOfPassWriteIndex: slot * 2,
          endOfPassWriteIndex: slot * 2 + 1,
        },
      })
    }
    return encoder.beginRenderPass({ ...desc, label })
  }

  /**
   * Call once per frame after encoding and immediately before `queue.submit()`.
   *
   * Order inside this method is load-bearing. Entries written on *earlier* frames are
   * promoted to `mapping` first, which guarantees the entry chosen to receive *this*
   * frame's copy is not one we are about to map. That is the §6.7 rule — never `mapAsync`
   * a buffer touched this frame — expressed as a state machine rather than as a comment.
   */
  resolve(encoder: GPUCommandEncoder): void {
    const frame = this.#frame
    this.#frame += 1
    const used = this.#slotPhases.length
    const phases = this.#slotPhases
    const labels = this.#slotLabels
    this.#slotPhases = []
    this.#slotLabels = []

    if (this.#destroyed || !this.#querySet || !this.#resolveBuffer) return

    // 1. Anything written on a previous frame has been submitted by now; start its map.
    //    This runs even on a frame with no timed passes, or a ring entry written just
    //    before an idle stretch would sit un-mapped and out of rotation forever.
    for (const entry of this.#ring) {
      if (entry.state === 'written' && entry.writtenFrame < frame) {
        entry.state = 'mapping'
        this.#startMap(entry)
      }
    }

    if (used === 0) return

    // 2. Resolve into the persistent resolve buffer — always safe, it is never mapped.
    encoder.resolveQuerySet(this.#querySet, 0, used * 2, this.#resolveBuffer, 0)

    // 3. Copy into an idle staging buffer, if one has come back around.
    const entry = this.#ring.find((e) => e.state === 'idle')
    if (!entry) {
      // All three are still in flight: the GPU is more than three frames behind, or a map
      // has not completed. Dropping the sample is correct — stalling to wait for a mapping
      // would make the profiler itself the thing being measured.
      this.#droppedSamples += 1
      return
    }
    encoder.copyBufferToBuffer(
      this.#resolveBuffer,
      0,
      entry.buffer,
      0,
      used * 2 * BYTES_PER_QUERY,
    )
    entry.state = 'written'
    entry.writtenFrame = frame
    entry.phases = phases
    entry.labels = labels
  }

  get timings(): FrameTimings {
    const phaseMs = {} as Record<Phase, number>
    for (const p of PHASES) phaseMs[p] = this.#phaseEma[p].value
    return {
      phaseMs,
      medianFrameMs: this.medianFrameMs,
      submitMs: this.#lastSubmitMs,
      highResolution: this.#highResolution || this.#highResolutionDetected,
    }
  }

  // -- Beyond the contract -------------------------------------------------

  /**
   * Whole-frame GPU time, 30-frame median.
   *
   * Uses the GPU timestamp span once samples are arriving, and the `onSubmittedWorkDone()`
   * wall clock until then (and permanently, when `timestamp-query` was not granted). The
   * wall clock is the ground truth §6.7 names; the GPU span is preferred when available
   * because it excludes CPU-side queue latency that the quality controller cannot fix by
   * lowering quality.
   */
  get medianFrameMs(): number {
    return this.#frameMedian.count > 0 ? this.#frameMedian.value : this.#submitMedian.value
  }

  /** Median of the submit wall clock alone. Always available. */
  get medianSubmitMs(): number {
    return this.#submitMedian.value
  }

  /** Per-pass detail from the most recent readback. Only trust it in a dev build. */
  get lastPasses(): readonly PassSample[] {
    return this.#lastPasses
  }

  /** Instantaneous (un-EMA'd) phase totals from the most recent readback. */
  get lastPhaseMs(): Readonly<Record<Phase, number>> {
    return this.#lastPhaseMs
  }

  /** Frames whose timestamps could not be staged because the ring was saturated. */
  get droppedSamples(): number {
    return this.#droppedSamples
  }

  /** GPU timestamp readbacks successfully consumed. */
  get gpuSamplesSeen(): number {
    return this.#gpuSamplesSeen
  }

  /**
   * Call immediately after `queue.submit()`. Starts the `onSubmittedWorkDone()` wall-clock
   * measurement for this submit. Cheap, and the only timing available on a device without
   * `timestamp-query`.
   */
  markSubmit(): void {
    if (this.#destroyed) return
    const t0 = this.#now()
    void this.device.queue.onSubmittedWorkDone().then(
      () => {
        if (this.#destroyed) return
        const ms = this.#now() - t0
        this.#lastSubmitMs = ms
        this.#submitMedian.push(ms)
      },
      () => {
        // Device lost; the loss handler owns the recovery, nothing to do here.
      },
    )
  }

  /**
   * Feed a set of timestamps directly. Exists so the readback path can be exercised
   * without a GPU, and so a future replay harness can drive the estimators.
   */
  ingest(timestampsNs: BigUint64Array, phases: readonly Phase[], labels: readonly string[]): void {
    const totals = zeroPhases()
    const passes: PassSample[] = []
    let minBegin = Number.POSITIVE_INFINITY
    let maxEnd = Number.NEGATIVE_INFINITY
    let any = false

    for (let i = 0; i < phases.length; i++) {
      const begin = timestampsNs[i * 2]
      const end = timestampsNs[i * 2 + 1]
      const phase = phases[i]
      if (begin === undefined || end === undefined || phase === undefined) continue
      // A pass that was encoded but never executed (an indirect dispatch skipped for zero
      // workgroups, or a query the driver declined to write) leaves its slot at zero or
      // non-monotonic. Discarding it is right: counting it as 0 ms would drag the EMA down
      // and hand the quality controller a fictitious headroom.
      if (end <= begin) continue
      // Detect whether Chrome is quantising timestamps, rather than being told.
      //
      // With the timing-attack mitigation active every timestamp lands exactly on a 100 us
      // grid, so a single value with a non-zero remainder proves quantisation is OFF and
      // per-pass numbers are real. There is no API for this; the flag was previously a
      // constructor option nobody ever set, so the HUD always claimed "not a dev build"
      // even when Chrome's WebGPU developer features were enabled.
      if (!this.#highResolutionDetected) {
        if (begin % QUANTUM_NS !== 0n || end % QUANTUM_NS !== 0n) {
          this.#highResolutionDetected = true
        }
      }
      const ms = Number(end - begin) / NS_PER_MS
      totals[phase] += ms
      passes.push({ label: labels[i] ?? '(unlabelled)', phase, ms })
      const b = Number(begin)
      const e = Number(end)
      if (b < minBegin) minBegin = b
      if (e > maxEnd) maxEnd = e
      any = true
    }

    if (!any) return

    for (const p of PHASES) this.#phaseEma[p].push(totals[p])
    // Span, not sum: passes on the same queue can only be reported as a wall interval, and
    // the gaps between them are real GPU time the frame budget has to pay for.
    this.#frameMedian.push((maxEnd - minBegin) / NS_PER_MS)
    this.#lastPhaseMs = totals
    this.#lastPasses = passes
    this.#gpuSamplesSeen += 1
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#querySet?.destroy()
    this.#resolveBuffer?.destroy()
    for (const e of this.#ring) {
      // A buffer that is mid-mapAsync must not be destroyed until the map settles; the
      // rejection is swallowed in #startMap, and destroy() on an already-destroyed device
      // is a no-op, so this is safe in both orders.
      e.buffer.destroy()
      e.state = 'idle'
    }
  }

  // -- internals -----------------------------------------------------------

  #claimSlot(phase: Phase, label: string): number | null {
    if (!this.enabled || this.#destroyed || !this.#querySet) return null
    const slot = this.#slotPhases.length
    if (slot >= this.maxPasses) {
      if (!this.#overflowWarned) {
        this.#overflowWarned = true
        console.warn(
          `[profiler] more than ${this.maxPasses} timed passes in one frame; the excess ` +
            `is untimed and phase totals will read low. Raise FrameProfilerOptions.maxPasses.`,
        )
      }
      return null
    }
    this.#slotPhases.push(phase)
    this.#slotLabels.push(label)
    return slot
  }

  #startMap(entry: RingEntry): void {
    const used = entry.phases.length
    const byteLength = used * 2 * BYTES_PER_QUERY
    void entry.buffer.mapAsync(GPUMapMode.READ, 0, byteLength).then(
      () => {
        if (this.#destroyed) return
        try {
          const copy = new BigUint64Array(entry.buffer.getMappedRange(0, byteLength).slice(0))
          this.ingest(copy, entry.phases, entry.labels)
        } finally {
          entry.buffer.unmap()
          entry.state = 'idle'
        }
      },
      () => {
        // Rejects when the device is lost or the buffer destroyed. Leave the entry out of
        // rotation rather than risk an unmap on a dead buffer.
        entry.state = 'idle'
      },
    )
  }
}

/** Convenience constructor mirroring the other factories in this package. */
export function createFrameProfiler(
  device: GPUDevice,
  options: FrameProfilerOptions = {},
): FrameProfiler {
  return new FrameProfiler(device, options)
}
