/**
 * The estimators behind the frame profiler — work package 1.1.
 *
 * These tests exist to check the one claim that makes the profiler usable at all. Chrome
 * quantises timestamp query results to 100 µs as a timing-attack mitigation (spec §6.7),
 * which is larger than nine of the twelve simulation passes. The architecture's answer is
 * two-part: group passes into phases of >= 300 µs so quantisation is <= ~30% of a single
 * sample, and EMA over >= 120 frames with decay 0.98 so the remaining error averages out.
 *
 * If that second claim is false, every per-phase number the HUD shows is noise and the
 * quality controller is steering on garbage. So it is tested against a simulated quantiser
 * rather than asserted in a comment.
 */

import { describe, expect, it } from 'vitest'
import { EMA_DECAY, Ema, RunningMedian } from '@gpu/statistics.ts'
import { mulberry32 } from './fake-webgpu.ts'

/** Chrome's mitigation, as applied to each timestamp value independently. */
const CHROME_QUANTUM_NS = 100_000
const quantise = (ns: number, quantum = CHROME_QUANTUM_NS): number =>
  Math.floor(ns / quantum) * quantum

/**
 * One frame's worth of observed pass duration: the difference of two independently
 * quantised timestamps, with the pass beginning at an arbitrary point in the quantisation
 * grid. This is the actual error process, not additive white noise — the error takes only
 * two values and is fully determined by where the pass starts, which is why it is worth
 * simulating rather than modelling.
 */
function quantisedDurationNs(trueDurationNs: number, startPhaseNs: number): number {
  const begin = quantise(startPhaseNs)
  const end = quantise(startPhaseNs + trueDurationNs)
  return end - begin
}

describe('Ema — bias-corrected exponential moving average', () => {
  it('reads the first sample exactly, with no zero-seeded warm-up bias', () => {
    const ema = new Ema()
    ema.push(7.5)
    // The naive form seeded at zero would report 0.15 here and take ~50 frames to recover,
    // which is exactly the window in which the quality controller would see fictitious
    // headroom and step quality up into a stall.
    expect(ema.value).toBeCloseTo(7.5, 12)
  })

  it('converges to a constant and reports 0 before any sample', () => {
    const ema = new Ema()
    expect(ema.value).toBe(0)
    for (let i = 0; i < 200; i++) ema.push(4)
    expect(ema.value).toBeCloseTo(4, 9)
    expect(ema.count).toBe(200)
  })

  it('ignores non-finite samples rather than poisoning the estimate', () => {
    const ema = new Ema()
    ema.push(2)
    ema.push(Number.NaN)
    ema.push(Number.POSITIVE_INFINITY)
    expect(ema.value).toBeCloseTo(2, 12)
    expect(ema.count).toBe(1)
  })

  it('tracks a step change within a few time constants', () => {
    const ema = new Ema()
    for (let i = 0; i < 300; i++) ema.push(4)
    for (let i = 0; i < 300; i++) ema.push(12)
    // The time constant is 1/(1 - 0.98) = 50 samples, so 300 samples leaves 0.98^300 of the
    // old level: about 0.2% of the 8 ms step, or 19 us. That lag is the price of the noise
    // rejection the quantisation tests below depend on, and 300 frames is 5 s at 60 fps.
    expect(ema.value).toBeCloseTo(12, 1)
    for (let i = 0; i < 600; i++) ema.push(12)
    expect(ema.value).toBeCloseTo(12, 5)
  })

  it('rejects a decay outside [0, 1)', () => {
    expect(() => new Ema(1)).toThrow(RangeError)
    expect(() => new Ema(-0.1)).toThrow(RangeError)
    expect(EMA_DECAY).toBe(0.98)
  })

  it('resets to the pre-sample state', () => {
    const ema = new Ema()
    ema.push(5)
    ema.reset()
    expect(ema.value).toBe(0)
    expect(ema.count).toBe(0)
  })
})

describe('EMA convergence under simulated 100 us timestamp quantisation', () => {
  /**
   * The core claim of spec §6.7: with phases of >= 300 µs, the EMA mean converges to within
   * ~10 µs of the truth even though every individual sample is off by up to a full 100 µs
   * quantum.
   */
  it('recovers a 420 us phase to within 10 us after 120 frames', () => {
    const rng = mulberry32(0x5eed)
    const trueMs = 0.42
    const ema = new Ema()

    let worstSampleErrorNs = 0
    for (let frame = 0; frame < 120; frame++) {
      // The pass starts at an arbitrary point in the quantisation grid each frame; that
      // uniformity is what makes the error zero-mean, and it is real — GPU work does not
      // begin on a 100 µs boundary.
      const startPhaseNs = rng() * 1e9
      const observedNs = quantisedDurationNs(trueMs * 1e6, startPhaseNs)
      worstSampleErrorNs = Math.max(worstSampleErrorNs, Math.abs(observedNs - trueMs * 1e6))
      ema.push(observedNs / 1e6)
    }

    // Individual samples really are bad: a single frame's reading can be off by a whole
    // quantum, i.e. ~24% of a 420 µs phase. This is the number that makes per-pass timing
    // in a shipping build meaningless.
    expect(worstSampleErrorNs).toBeGreaterThan(50_000)
    // The mean is not: 120 frames is barely more than one time constant of the EMA, and it
    // is already inside the ~10 µs §6.7 claims — two orders of magnitude better than any
    // single sample.
    expect(Math.abs(ema.value - trueMs) * 1000).toBeLessThan(10)
  })

  it('holds across phase durations from 300 us to 4 ms and many seeds', () => {
    for (const trueMs of [0.3, 0.42, 0.9, 1.7, 4.0]) {
      for (const seed of [1, 7, 12345, 0xbeef]) {
        const rng = mulberry32(seed)
        const ema = new Ema()
        for (let frame = 0; frame < 400; frame++) {
          ema.push(quantisedDurationNs(trueMs * 1e6, rng() * 1e9) / 1e6)
        }
        const errUs = Math.abs(ema.value - trueMs) * 1000
        expect(
          errUs,
          `phase ${trueMs} ms, seed ${seed}: EMA off by ${errUs.toFixed(1)} us`,
        ).toBeLessThan(15)
      }
    }
  })

  it('shows why phases must be >= 300 us: a 40 us pass is unrecoverable per-sample', () => {
    const rng = mulberry32(99)
    const trueMs = 0.04 // a typical single sim pass, well under the quantum
    let zeroReadings = 0
    for (let i = 0; i < 200; i++) {
      if (quantisedDurationNs(trueMs * 1e6, rng() * 1e9) === 0) zeroReadings += 1
    }
    // A sub-quantum pass reads as exactly 0 most of the time and as a full 100 µs otherwise
    // — a 2.5x overstatement. No amount of averaging makes the *per-sample* number usable,
    // which is precisely why passes are grouped into phases before they are reported.
    expect(zeroReadings).toBeGreaterThan(120)
  })

  it('quantisation error stays within one quantum, so a 300 us phase is <= ~33% off', () => {
    const rng = mulberry32(4242)
    const trueNs = 300_000
    for (let i = 0; i < 500; i++) {
      const err = Math.abs(quantisedDurationNs(trueNs, rng() * 1e9) - trueNs)
      expect(err).toBeLessThanOrEqual(CHROME_QUANTUM_NS)
    }
  })
})

describe('RunningMedian', () => {
  it('reports 0 before any sample and the value itself after one', () => {
    const med = new RunningMedian(30)
    expect(med.value).toBe(0)
    med.push(3)
    expect(med.value).toBe(3)
  })

  it('is exact for odd and even partial fills', () => {
    const med = new RunningMedian(30)
    for (const v of [5, 1, 3]) med.push(v)
    expect(med.value).toBe(3)
    med.push(9)
    expect(med.value).toBe(4) // (3 + 5) / 2
  })

  it('ignores a single 10 ms driver-paging spike', () => {
    // Spec §6.8 pitfall 9: exceeding VRAM shows up as sporadic 10 ms frame spikes with no
    // error. The quality controller must not drop a level because of one of them.
    const med = new RunningMedian(30)
    for (let i = 0; i < 29; i++) med.push(8)
    med.push(18)
    expect(med.value).toBe(8)
  })

  it('follows a sustained regression once it fills half the window', () => {
    const med = new RunningMedian(30)
    for (let i = 0; i < 30; i++) med.push(8)
    for (let i = 0; i < 16; i++) med.push(20)
    expect(med.value).toBe(20)
  })

  it('evicts oldest samples when the ring wraps', () => {
    const med = new RunningMedian(5)
    for (const v of [1, 2, 3, 4, 5]) med.push(v)
    expect(med.value).toBe(3)
    for (const v of [100, 100, 100]) med.push(v)
    // Window is now [4, 5, 100, 100, 100].
    expect(med.value).toBe(100)
    expect(med.count).toBe(5)
  })

  it('rejects a non-integer or non-positive window', () => {
    expect(() => new RunningMedian(0)).toThrow(RangeError)
    expect(() => new RunningMedian(2.5)).toThrow(RangeError)
  })
})
