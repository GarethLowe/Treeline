/**
 * Fixed-timestep frame loop — work package 1.1.
 *
 * Driven entirely by a fake clock, because the property that matters is precisely the one a
 * real clock destroys: *frame-rate independence*. Spec §6.5 requires that the same wall
 * interval produce the same simulated time and the same number of substeps regardless of
 * how the frames fell, and that a stall drop simulated time rather than compound it.
 *
 * Where a test needs an exact step count it uses frame deltas that are exact in binary
 * (12.5 / 25 / 50 ms), so the assertion is about the accumulator algorithm and not about
 * whether 1/60 s happens to round up or down in IEEE-754. The 60 fps cases that cannot be
 * exact say so and assert within one step.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Seconds } from '@contracts/units'
import {
  DEFAULT_FIXED_DT,
  DEFAULT_MAX_SUBSTEPS,
  FrameLoop,
  type FrameLoopOptions,
  type FrameScheduler,
} from '@core/frame-loop.ts'

const H = DEFAULT_FIXED_DT // 1/120 s

/** A scheduler that runs frames only when the test says so. */
class FakeScheduler implements FrameScheduler {
  #next = 1
  #callbacks = new Map<number, (t: number) => void>()
  cancelled: number[] = []

  request(cb: (timestampMs: number) => void): number {
    const handle = this.#next++
    this.#callbacks.set(handle, cb)
    return handle
  }

  cancel(handle: number): void {
    this.cancelled.push(handle)
    this.#callbacks.delete(handle)
  }

  get armed(): boolean {
    return this.#callbacks.size > 0
  }

  /** Fire the single armed callback with a timestamp. */
  fire(timestampMs: number): void {
    const entry = [...this.#callbacks.entries()][0]
    if (entry === undefined) throw new Error('no frame armed')
    this.#callbacks.delete(entry[0])
    entry[1](timestampMs)
  }
}

interface Harness {
  readonly loop: FrameLoop
  readonly steps: number[]
  readonly alphas: number[]
  /** Advance the loop by `ms` of wall clock. */
  advance(ms: number): void
}

function harness(options: FrameLoopOptions = {}): Harness {
  const loop = new FrameLoop({ scheduler: new FakeScheduler(), ...options })
  const steps: number[] = []
  const alphas: number[] = []
  let t = 1000 // start at a non-zero clock, as rAF does
  loop.start(
    (dt: Seconds) => steps.push(dt),
    (alpha: number) => alphas.push(alpha),
  )
  return {
    loop,
    steps,
    alphas,
    advance(ms: number): void {
      t += ms
      loop.tick(t)
    },
  }
}

describe('construction', () => {
  it('defaults to h = 1/120 s and A_max = 4h, per spec §6.3 and §6.5', () => {
    const loop = new FrameLoop()
    expect(loop.fixedDt).toBeCloseTo(1 / 120, 15)
    expect(loop.maxSubstepsPerFrame).toBe(4)
    expect(DEFAULT_MAX_SUBSTEPS * DEFAULT_FIXED_DT).toBeCloseTo(0.03333, 5)
  })

  it('rejects a non-positive step or a fractional substep cap', () => {
    expect(() => new FrameLoop({ fixedDt: 0 })).toThrow(RangeError)
    expect(() => new FrameLoop({ fixedDt: -1 })).toThrow(RangeError)
    expect(() => new FrameLoop({ maxSubstepsPerFrame: 1.5 })).toThrow(RangeError)
    expect(() => new FrameLoop({ maxSubstepsPerFrame: 0 })).toThrow(RangeError)
  })

  it('starts at zero simulated time and frame index', () => {
    const loop = new FrameLoop()
    expect(loop.simTime).toBe(0)
    expect(loop.frameIndex).toBe(0)
    expect(loop.accumulator).toBe(0)
  })
})

describe('the accumulator', () => {
  it('runs no substep on the first frame — there is no wall delta yet', () => {
    const h = harness()
    h.advance(0)
    expect(h.steps).toHaveLength(0)
    expect(h.loop.frameIndex).toBe(1)
    // A first frame charged with time-since-page-load would immediately trip the spiral
    // clamp and report dropped simulated time before the sim has started.
    expect(h.loop.droppedSimTime).toBe(0)
  })

  it('runs a deterministic 3 substeps per 25 ms frame', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 60; i++) h.advance(25)
    expect(h.steps).toHaveLength(180) // 1.5 s / (1/120 s)
    expect(h.loop.simTime).toBeCloseTo(1.5, 9)
  })

  it('runs about two substeps per frame at 60 fps', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 60; i++) h.advance(1000 / 60)
    // 1/60 s is not exact in binary, so the 120th step may land on either side of the last
    // frame boundary. Anything outside +/-1 is an accumulator bug, not rounding.
    expect(h.steps.length).toBeGreaterThanOrEqual(119)
    expect(h.steps.length).toBeLessThanOrEqual(120)
    expect(h.loop.simTime).toBeCloseTo(1.0, 2)
  })

  it('every step is exactly the fixed dt — never a variable one', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 40; i++) h.advance(7 + (i % 5) * 3) // jittery frame times
    expect(h.steps.length).toBeGreaterThan(0)
    for (const dt of h.steps) expect(dt).toBe(H)
  })

  it('carries the residue: three 4 ms frames produce one 8.33 ms step', () => {
    const h = harness()
    h.advance(0)
    h.advance(4)
    expect(h.steps).toHaveLength(0)
    expect(h.loop.accumulator).toBeCloseTo(0.004, 9)
    h.advance(4)
    expect(h.steps).toHaveLength(0)
    h.advance(4)
    expect(h.steps).toHaveLength(1)
    expect(h.loop.accumulator).toBeCloseTo(0.012 - H, 9)
  })

  it('simTime equals the number of steps times h, exactly', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 500; i++) h.advance(13.7)
    expect(h.loop.simTime).toBeCloseTo(h.steps.length * H, 9)
  })

  it('keeps alpha in [0, 1) so the froxel interpolation never extrapolates', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 200; i++) {
      h.advance(1 + (i % 23))
      const alpha = h.alphas[h.alphas.length - 1]
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('renders exactly once per frame regardless of substep count', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 25; i++) h.advance(30)
    expect(h.alphas).toHaveLength(26)
  })
})

describe('frame-rate independence (spec §6.5)', () => {
  it('12.5, 25 and 50 ms frame rates all reach the same simulated time', () => {
    const opts = { maxSubstepsPerFrame: 8 } as const
    const fast = harness(opts) // 80 fps
    const mid = harness(opts) // 40 fps
    const slow = harness(opts) // 20 fps
    fast.advance(0)
    mid.advance(0)
    slow.advance(0)
    for (let i = 0; i < 120; i++) fast.advance(12.5)
    for (let i = 0; i < 60; i++) mid.advance(25)
    for (let i = 0; i < 30; i++) slow.advance(50)

    expect(fast.steps).toHaveLength(180)
    expect(mid.steps).toHaveLength(180)
    expect(slow.steps).toHaveLength(180)
    expect(fast.loop.simTime).toBeCloseTo(slow.loop.simTime, 12)
    expect(mid.loop.simTime).toBeCloseTo(slow.loop.simTime, 12)
    for (const h of [fast, mid, slow]) expect(h.loop.droppedSimTime).toBe(0)
  })

  it('a variable frame rate reaches the same place as a steady one', () => {
    const steady = harness({ maxSubstepsPerFrame: 8 })
    const jittery = harness({ maxSubstepsPerFrame: 8 })
    steady.advance(0)
    jittery.advance(0)
    for (let i = 0; i < 60; i++) steady.advance(25)
    // Same 1.5 s of wall time (30 x 10 ms + 30 x 40 ms), delivered in wildly uneven frames.
    for (let i = 0; i < 60; i++) jittery.advance(i % 2 === 0 ? 10 : 40)
    expect(jittery.loop.simTime).toBeCloseTo(steady.loop.simTime, 9)
    expect(jittery.steps.length).toBe(steady.steps.length)
  })
})

describe('the spiral-of-death clamp', () => {
  it('caps a stalled frame at maxSubstepsPerFrame and reports the dropped time', () => {
    const dropped: number[] = []
    const h = harness({ onTimeDropped: (d) => dropped.push(d) })
    h.advance(0)
    h.advance(200) // a 200 ms hitch
    expect(h.steps).toHaveLength(DEFAULT_MAX_SUBSTEPS)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toBeCloseTo(0.2 - DEFAULT_MAX_SUBSTEPS * H, 9)
    expect(h.loop.droppedSimTime).toBeCloseTo(0.2 - DEFAULT_MAX_SUBSTEPS * H, 12)
  })

  it('does not compound: the frame after a stall is normal again', () => {
    const h = harness()
    h.advance(0)
    h.advance(500)
    const afterStall = h.steps.length
    h.advance(25)
    // 25 ms of new wall time on a drained accumulator is three steps, not a catch-up burst.
    // A loop that banked the stall would run four here, and four again, forever.
    expect(h.steps.length - afterStall).toBe(3)
  })

  it('a backgrounded tab producing a multi-second delta does not explode the report', () => {
    const h = harness({ timeScale: 60 })
    h.advance(0)
    h.advance(30_000) // 30 s in one callback, as a restored tab delivers
    // maxWallDeltaSeconds (0.25 s) is applied *before* timeScale, so the worst case is
    // 0.25 x 60 = 15 s of dropped sim time, not 30 x 60 = 1800 s.
    expect(h.loop.droppedSimTime).toBeLessThan(15)
    expect(h.steps).toHaveLength(DEFAULT_MAX_SUBSTEPS)
  })

  it('a larger substep cap absorbs a bigger hitch without dropping time', () => {
    const h = harness({ maxSubstepsPerFrame: 32 })
    h.advance(0)
    h.advance(200)
    expect(h.steps).toHaveLength(24) // 0.2 s / (1/120 s)
    expect(h.loop.droppedSimTime).toBe(0)
  })
})

describe('timeScale', () => {
  it('multiplies simulated time without changing the step size', () => {
    const h = harness({ timeScale: 4, maxSubstepsPerFrame: 64 })
    h.advance(0)
    for (let i = 0; i < 60; i++) h.advance(25)
    expect(h.loop.simTime).toBeCloseTo(6.0, 6) // 1.5 s of wall x 4
    for (const dt of h.steps) expect(dt).toBe(H)
    expect(h.loop.fixedDt).toBe(H)
  })

  it('at zero, wall time advances but simulated time does not', () => {
    const h = harness({ timeScale: 0 })
    h.advance(0)
    for (let i = 0; i < 30; i++) h.advance(16)
    expect(h.steps).toHaveLength(0)
    expect(h.loop.simTime).toBe(0)
    expect(h.loop.wallTime).toBeCloseTo(0.48, 6)
  })

  it('is settable at runtime and rejects negative or non-finite values', () => {
    const loop = new FrameLoop()
    loop.timeScale = 60
    expect(loop.timeScale).toBe(60)
    expect(() => {
      loop.timeScale = -1
    }).toThrow(RangeError)
    expect(() => {
      loop.timeScale = Number.NaN
    }).toThrow(RangeError)
  })
})

describe('paused', () => {
  it('freezes simulated time and the accumulator but keeps rendering', () => {
    const h = harness()
    h.advance(0)
    for (let i = 0; i < 10; i++) h.advance(16)
    const simAtPause = h.loop.simTime
    const stepsAtPause = h.steps.length
    h.loop.paused = true
    for (let i = 0; i < 10; i++) h.advance(16)
    expect(h.loop.simTime).toBe(simAtPause)
    expect(h.steps).toHaveLength(stepsAtPause)
    expect(h.alphas).toHaveLength(21)
    // Wall time keeps running: the two clocks are separate by §0.6 rule 5.
    expect(h.loop.wallTime).toBeCloseTo(0.32, 6)
  })

  it('does not bank paused wall time and release it on resume', () => {
    const h = harness()
    h.advance(0)
    h.loop.paused = true
    for (let i = 0; i < 60; i++) h.advance(16)
    h.loop.paused = false
    h.advance(25)
    expect(h.steps).toHaveLength(3)
  })
})

describe('start / stop', () => {
  it('arms the scheduler, re-arms each frame, and cancels on stop', () => {
    const scheduler = new FakeScheduler()
    const loop = new FrameLoop({ scheduler })
    const onStep = vi.fn()
    const onRender = vi.fn()
    loop.start(onStep, onRender)
    expect(scheduler.armed).toBe(true)
    scheduler.fire(0)
    scheduler.fire(100)
    expect(loop.frameIndex).toBe(2)
    expect(onRender).toHaveBeenCalledTimes(2)
    expect(scheduler.armed).toBe(true)
    loop.stop()
    expect(scheduler.armed).toBe(false)
    expect(loop.running).toBe(false)
  })

  it('refuses to start twice', () => {
    const scheduler = new FakeScheduler()
    const loop = new FrameLoop({ scheduler })
    loop.start(
      () => {},
      () => {},
    )
    expect(() =>
      loop.start(
        () => {},
        () => {},
      ),
    ).toThrow(/already running/)
  })

  it('stays armed when a handler throws, so one bad frame does not freeze the app', () => {
    const scheduler = new FakeScheduler()
    const loop = new FrameLoop({ scheduler })
    loop.start(
      () => {},
      () => {
        throw new Error('render blew up')
      },
    )
    expect(() => scheduler.fire(0)).toThrow('render blew up')
    expect(scheduler.armed).toBe(true)
  })

  it('lets a step handler stop the loop from inside a frame', () => {
    const scheduler = new FakeScheduler()
    const loop = new FrameLoop({ scheduler })
    loop.start(
      () => loop.stop(),
      () => {},
    )
    scheduler.fire(0)
    scheduler.fire(50)
    expect(loop.running).toBe(false)
    expect(scheduler.armed).toBe(false)
  })
})

describe('clock hygiene', () => {
  it('ignores a backwards timestamp instead of running negative time', () => {
    const loop = new FrameLoop()
    loop.tick(1000)
    loop.tick(900)
    expect(loop.simTime).toBe(0)
    expect(loop.wallTime).toBe(0)
  })

  it('tracks wall time separately from simulated time (§0.6 rule 5)', () => {
    const h = harness({ timeScale: 10, maxSubstepsPerFrame: 64 })
    h.advance(0)
    for (let i = 0; i < 60; i++) h.advance(25)
    expect(h.loop.wallTime).toBeCloseTo(1.5, 9)
    expect(h.loop.simTime).toBeCloseTo(15.0, 6)
  })

  it('reports the substep count of the most recent frame', () => {
    const h = harness()
    h.advance(0)
    h.advance(25)
    expect(h.loop.lastSubstepCount).toBe(3)
    h.advance(1)
    expect(h.loop.lastSubstepCount).toBe(0)
  })
})

describe('accumulator precision over a long run', () => {
  it('does not drift after an hour of simulated time at timeScale 60', () => {
    const h = harness({ timeScale: 60, maxSubstepsPerFrame: 8 })
    h.advance(0)
    // 8 substeps/frame x 1/120 s = 66.7 ms of sim per frame; at timeScale 60 a 25 ms frame
    // asks for 1.5 s, so this run is clamp-limited by construction — the case where a naive
    // repeated-subtraction accumulator accumulates rounding error fastest.
    for (let i = 0; i < 3600; i++) h.advance(25)
    expect(h.steps).toHaveLength(3600 * 8)
    expect(h.loop.simTime).toBeCloseTo(h.steps.length * H, 6)
    expect(h.loop.accumulator).toBeGreaterThanOrEqual(0)
    expect(h.loop.accumulator).toBeLessThan(H)
  })
})
