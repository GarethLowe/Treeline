/**
 * Dynamic quality controller — work package 1.1.
 *
 * The hysteresis is pure logic and is the part that can actually be wrong, so it is tested
 * exhaustively: exact dwell counts, the dead band, the asymmetry, the clamps, and — most
 * importantly — the invariant that the controller cannot reach the simulation timestep.
 * Spec §6.7: *"the controller never changes h or n_sub"*, because degrading the physics to
 * hold framerate would silently invalidate every number the HUD exports.
 */

import { describe, expect, it } from 'vitest'
import type { FrameTimings, Phase, QualityLevel } from '@contracts/gpu'
import { PHASES, QUALITY_TABLE } from '@contracts/gpu'
import {
  DOWNGRADE_FRACTION,
  DOWNGRADE_FRAMES,
  QualityController,
  UPGRADE_FRACTION,
  UPGRADE_FRAMES,
  createQualityController,
} from '@gpu/quality.ts'

const TAU = 1000 / 60

function timings(medianFrameMs: number): FrameTimings {
  const phaseMs = {} as Record<Phase, number>
  for (const p of PHASES) phaseMs[p] = 0
  return { phaseMs, medianFrameMs, submitMs: medianFrameMs, highResolution: false }
}

/** Feed `n` frames at a fixed median frame time. */
function feed(q: QualityController, ms: number, n: number): void {
  const t = timings(ms)
  for (let i = 0; i < n; i++) q.update(t)
}

const SLOW = 0.95 * TAU // above 0.92 tau
const FAST = 0.5 * TAU // below 0.75 tau
const NOMINAL = 0.85 * TAU // inside the dead band

describe('quality thresholds match spec §6.7', () => {
  it('uses 0.92 tau down / 0.75 tau up and 20 / 90 frame dwells', () => {
    expect(DOWNGRADE_FRACTION).toBe(0.92)
    expect(UPGRADE_FRACTION).toBe(0.75)
    expect(DOWNGRADE_FRAMES).toBe(20)
    expect(UPGRADE_FRAMES).toBe(90)
  })

  it('is asymmetric — recovery is 4.5x slower than degradation', () => {
    expect(UPGRADE_FRAMES / DOWNGRADE_FRAMES).toBeGreaterThan(4)
  })
})

describe('QUALITY_TABLE', () => {
  it('has one entry per level and is monotonic in q', () => {
    expect(QUALITY_TABLE).toHaveLength(6)
    for (let i = 1; i < QUALITY_TABLE.length; i++) {
      const prev = QUALITY_TABLE[i - 1]!
      const cur = QUALITY_TABLE[i]!
      expect(cur.resolutionScale).toBeGreaterThanOrEqual(prev.resolutionScale)
      expect(cur.froxelMarchSteps).toBeGreaterThan(prev.froxelMarchSteps)
      expect(cur.nearFieldParticleBudget).toBeGreaterThan(prev.nearFieldParticleBudget)
      expect(cur.radiationRays).toBeGreaterThanOrEqual(prev.radiationRays)
    }
  })

  it('floors radiation rays at 8 at every level', () => {
    // §6.7: below 8 rays the view-factor Monte Carlo estimator's variance biases crown-fire
    // initiation EARLY. A quality knob that makes the physics wrong in a *direction* is not
    // a quality knob, so this floor is load-bearing rather than a tuning choice.
    for (const s of QUALITY_TABLE) expect(s.radiationRays).toBeGreaterThanOrEqual(8)
  })

  it('exposes no simulation-timestep knob', () => {
    for (const s of QUALITY_TABLE) {
      const keys = Object.keys(s)
      expect(keys.sort()).toEqual(
        ['froxelMarchSteps', 'nearFieldParticleBudget', 'radiationRays', 'resolutionScale'],
      )
      for (const k of keys) expect(k).not.toMatch(/dt|timestep|substep|h\b/i)
    }
  })
})

describe('downgrade hysteresis', () => {
  it('holds for 19 slow frames and drops on the 20th', () => {
    const q = createQualityController()
    expect(q.level).toBe(5)
    feed(q, SLOW, DOWNGRADE_FRAMES - 1)
    expect(q.level).toBe(5)
    feed(q, SLOW, 1)
    expect(q.level).toBe(4)
  })

  it('requires the slow frames to be consecutive', () => {
    const q = createQualityController()
    feed(q, SLOW, 19)
    feed(q, NOMINAL, 1) // one frame in the dead band resets the run
    feed(q, SLOW, 19)
    expect(q.level).toBe(5)
    feed(q, SLOW, 1)
    expect(q.level).toBe(4)
  })

  it('a fast frame also breaks the slow run', () => {
    const q = createQualityController()
    feed(q, SLOW, 19)
    feed(q, FAST, 1)
    feed(q, SLOW, 19)
    expect(q.level).toBe(5)
  })

  it('walks all the way down under sustained overload and stops at 0', () => {
    const q = createQualityController()
    feed(q, 3 * TAU, DOWNGRADE_FRAMES * 20)
    expect(q.level).toBe(0)
    expect(q.settings).toEqual(QUALITY_TABLE[0])
    expect(q.isDegraded).toBe(true)
  })

  it('does not react to a frame exactly at the 0.92 tau threshold', () => {
    const q = createQualityController()
    feed(q, DOWNGRADE_FRACTION * TAU, 500)
    // Strictly greater than, per "if m > 0.92 tau". A controller that degrades at exactly
    // the threshold would sit one level below its true operating point forever.
    expect(q.level).toBe(5)
  })
})

describe('upgrade hysteresis', () => {
  it('holds for 89 fast frames and rises on the 90th', () => {
    const q = new QualityController({ initialLevel: 2 })
    feed(q, FAST, UPGRADE_FRAMES - 1)
    expect(q.level).toBe(2)
    feed(q, FAST, 1)
    expect(q.level).toBe(3)
  })

  it('clamps at 5', () => {
    const q = new QualityController({ initialLevel: 5 })
    feed(q, FAST, UPGRADE_FRAMES * 5)
    expect(q.level).toBe(5)
    expect(q.settings).toEqual(QUALITY_TABLE[5])
  })

  it('does not react to a frame exactly at the 0.75 tau threshold', () => {
    const q = new QualityController({ initialLevel: 2 })
    feed(q, UPGRADE_FRACTION * TAU, 500)
    expect(q.level).toBe(2)
  })
})

describe('the dead band is where the controller is supposed to live', () => {
  it('never moves while frames land between 0.75 and 0.92 tau', () => {
    const q = new QualityController({ initialLevel: 3 })
    for (let i = 0; i < 1000; i++) q.update(timings((0.76 + 0.15 * ((i % 7) / 7)) * TAU))
    expect(q.level).toBe(3)
    expect(q.changeCount).toBe(0)
  })
})

describe('asymmetry stops visible pumping', () => {
  it('a marginal operating point ratchets down instead of oscillating', () => {
    // Alternating blocks of slow and fast frames: the classic pumping scenario. Because
    // down needs 20 and up needs 90, a workload that is slow half the time settles low
    // rather than flickering between two resolution scales.
    const q = new QualityController({ initialLevel: 5 })
    for (let block = 0; block < 30; block++) {
      feed(q, SLOW, 25)
      feed(q, FAST, 25)
    }
    expect(q.level).toBeLessThanOrEqual(1)
    // 30 blocks x 50 frames = 1500 frames. A symmetric controller would have changed level
    // ~60 times here; the asymmetric one changes at most once per block.
    expect(q.changeCount).toBeLessThanOrEqual(30)
  })

  it('recovers a level only after a long clean run', () => {
    const q = new QualityController({ initialLevel: 2 })
    feed(q, FAST, UPGRADE_FRAMES)
    expect(q.level).toBe(3)
    expect(q.isDegraded).toBe(false)
  })
})

describe('isDegraded annotates exports made below q = 2', () => {
  it('is true at 0 and 1 and false from 2 up', () => {
    for (const level of [0, 1, 2, 3, 4, 5] as QualityLevel[]) {
      const q = new QualityController({ initialLevel: level })
      expect(q.isDegraded).toBe(level < 2)
    }
  })
})

describe('pinning', () => {
  it('disables adaptation in both directions', () => {
    const q = new QualityController({ initialLevel: 4 })
    q.pin(4)
    feed(q, 5 * TAU, 1000)
    expect(q.level).toBe(4)
    feed(q, 0.1 * TAU, 1000)
    expect(q.level).toBe(4)
  })

  it('moves to the pinned level immediately and resumes adaptation when unpinned', () => {
    const q = new QualityController({ initialLevel: 5 })
    q.pin(1)
    expect(q.level).toBe(1)
    expect(q.settings).toEqual(QUALITY_TABLE[1])
    q.pin(null)
    feed(q, FAST, UPGRADE_FRAMES)
    expect(q.level).toBe(2)
  })

  it('clears the dwell counters so an unpinned controller does not jump', () => {
    const q = new QualityController({ initialLevel: 3 })
    feed(q, SLOW, 19)
    q.pin(3)
    q.pin(null)
    feed(q, SLOW, 19)
    expect(q.level).toBe(3)
  })
})

describe('bad or absent timing data', () => {
  it('holds level on a zero median, which is what the profiler reports before it warms up', () => {
    const q = new QualityController({ initialLevel: 5 })
    feed(q, 0, 1000)
    expect(q.level).toBe(5)
  })

  it('holds level on NaN', () => {
    const q = new QualityController({ initialLevel: 5 })
    feed(q, Number.NaN, 1000)
    expect(q.level).toBe(5)
  })

  it('a zero frame in the middle of a slow run does not count as fast', () => {
    const q = new QualityController({ initialLevel: 5 })
    feed(q, SLOW, 10)
    feed(q, 0, 5)
    feed(q, SLOW, 10)
    expect(q.level).toBe(4)
  })
})

describe('structural guarantee: the controller cannot touch the physics', () => {
  it('exposes no property whose name suggests a timestep or substep count', () => {
    const q = new QualityController()
    const names = new Set<string>()
    for (
      let o: object | null = q;
      o !== null && o !== Object.prototype;
      o = Object.getPrototypeOf(o) as object | null
    ) {
      for (const k of Object.getOwnPropertyNames(o)) names.add(k)
    }
    for (const n of names) {
      expect(n, `QualityController.${n} looks like a physics knob`).not.toMatch(
        /fixeddt|timestep|substep|simtime|accumulator/i,
      )
    }
  })

  it('reports a change through onChange exactly once per level move', () => {
    const seen: QualityLevel[] = []
    const q = new QualityController({ initialLevel: 5, onChange: (level) => seen.push(level) })
    feed(q, SLOW, DOWNGRADE_FRAMES * 3)
    expect(seen).toEqual([4, 3, 2])
    expect(q.changeCount).toBe(3)
  })
})

describe('custom target frame time', () => {
  it('scales both thresholds with tau', () => {
    const q = new QualityController({ targetFrameMs: 33.33, initialLevel: 3 }) // 30 fps target
    feed(q, 20, DOWNGRADE_FRAMES * 2) // 20 ms is slow at 60 fps but fast at 30
    expect(q.level).toBe(3)
    feed(q, 20, UPGRADE_FRAMES) // 20 ms < 0.75 * 33.33 = 25 ms
    expect(q.level).toBe(4)
  })

  it('rejects a non-positive target', () => {
    expect(() => new QualityController({ targetFrameMs: 0 })).toThrow(RangeError)
  })
})
