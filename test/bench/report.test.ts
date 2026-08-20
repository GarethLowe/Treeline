/**
 * The report is the deliverable, so its arithmetic and its honesty rules are the parts most
 * worth pinning down: a percentile that is quietly a mean, or a run on the iGPU that does
 * not say so, would both produce a confident wrong number that spec §0.5.1 then licenses
 * someone to trade accuracy against.
 */

import { describe, expect, it } from 'vitest'
import type { AdapterReport, Phase, QualityLevel } from '@contracts/gpu.ts'
import { PHASES } from '@contracts/gpu.ts'
import type { BenchMeta, BenchRun, BenchSample } from '../../src/bench/report.ts'
import {
  FRAME_BUDGET_MS,
  formatMarkdown,
  mean,
  p95,
  summariseLevel,
  verdictFor,
} from '../../src/bench/report.ts'

function adapter(looksIntegrated: boolean): AdapterReport {
  return {
    vendor: looksIntegrated ? 'intel' : 'nvidia',
    architecture: looksIntegrated ? 'gen-12lp' : 'ada',
    device: '',
    description: looksIntegrated ? 'Intel UHD Graphics' : 'NVIDIA GeForce RTX 4070 Laptop GPU',
    looksIntegrated,
    grantedFeatures: ['timestamp-query'],
    limitShortfalls: [],
  }
}

function meta(looksIntegrated = false): BenchMeta {
  return {
    adapter: adapter(looksIntegrated),
    timestamps: true,
    highResolution: false,
    seed: 1337,
    biome: 'western-us-conifer',
    canvasWidth: 2560,
    canvasHeight: 1440,
    warmupFrames: 150,
    measureFrames: 240,
    userAgent: 'test',
    startedAt: '2026-08-19T00:00:00.000Z',
    devicePixelRatio: 1,
  }
}

function phases(value: number): Record<Phase, number> {
  const out = {} as Record<Phase, number>
  for (const p of PHASES) out[p] = value
  return out
}

function samples(level: QualityLevel, frameMs: readonly number[], withPhases = true): BenchSample[] {
  return frameMs.map((ms, i) => ({
    level,
    rafDeltaMs: ms,
    submitMs: ms * 0.8,
    phaseMs: withPhases && i % 2 === 0 ? phases(ms / PHASES.length) : null,
    altitudeFraction: 0.5,
  }))
}

describe('statistics', () => {
  it('means an empty sample to zero rather than NaN', () => {
    expect(mean([])).toBe(0)
    expect(p95([])).toBe(0)
  })

  it('p95 is nearest-rank, not a mean', () => {
    // 1..100: ceil(0.95 * 100) = 95 -> the 95th smallest value.
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(p95(xs)).toBe(95)
    expect(p95([5])).toBe(5)
    // Order must not matter.
    expect(p95([...xs].reverse())).toBe(95)
  })

  it('picks a real observed value, so a hitch the mean hides is visible', () => {
    // Nearest-rank on 20 samples is the 19th, so a single outlier in twenty is still below
    // the p95 and two are not. That is the intended behaviour: p95 is "how bad is a bad
    // frame", not "what is the worst frame".
    const one = [...Array.from({ length: 19 }, () => 10), 40]
    const two = [...Array.from({ length: 18 }, () => 10), 40, 40]
    expect(mean(one)).toBeCloseTo(11.5, 6)
    expect(p95(one)).toBe(10)
    expect(mean(two)).toBeCloseTo(13, 6)
    expect(p95(two)).toBe(40)
  })
})

describe('verdictFor', () => {
  it('separates a level that holds 60 fps from one that only averages it', () => {
    expect(verdictFor(10, 14)).toBe('fits')
    expect(verdictFor(14, 22)).toBe('marginal')
    expect(verdictFor(20, 25)).toBe('does not fit')
  })

  it('treats the budget itself as fitting', () => {
    expect(verdictFor(FRAME_BUDGET_MS, FRAME_BUDGET_MS)).toBe('fits')
  })

  it('does not fail a healthy vsync-locked level on jitter', () => {
    // A level rendering comfortably inside the budget on a 60 Hz display still reports rAF
    // intervals scattered a few tenths either side of 16.67. Without tolerance every such
    // level reads "does not fit", which is the exact false negative that would send someone
    // cutting accuracy for no reason (spec §0.5.1).
    expect(verdictFor(16.72, 17.4)).toBe('fits')
  })

  it('still fails a level that misses vsync often', () => {
    // Missing one vsync in three: mean lands near 22 ms, well past the 5% tolerance.
    expect(verdictFor(22, 33.3)).toBe('does not fit')
  })
})

describe('summariseLevel', () => {
  it('counts only frames that carried a fresh timestamp readback in the phase rows', () => {
    const s = summariseLevel(3, samples(3, [10, 12, 14, 16]))
    const surface = s.rows.find((r) => r.label === 'surface')
    const frame = s.rows.find((r) => r.label === '**frame (rAF interval)**')
    expect(surface?.sampleCount).toBe(2) // every other sample carried phases
    expect(frame?.sampleCount).toBe(4)
  })

  it('reports the rAF interval as the frame time and derives fps from it', () => {
    const s = summariseLevel(5, samples(5, [16, 16, 16, 16]))
    expect(s.frameMeanMs).toBeCloseTo(16, 6)
    expect(s.fps).toBeCloseTo(62.5, 3)
    expect(s.verdict).toBe('fits')
  })

  it('sums the five phases into an all-phases row', () => {
    const s = summariseLevel(2, samples(2, [10, 10]))
    const all = s.rows.find((r) => r.label === '**all phases (GPU)**')
    expect(all?.meanMs).toBeCloseTo(10, 6)
  })

  it('ignores samples belonging to other levels', () => {
    const mixed = [...samples(0, [30, 30]), ...samples(5, [8, 8])]
    expect(summariseLevel(5, mixed).frameMeanMs).toBeCloseTo(8, 6)
    expect(summariseLevel(0, mixed).frameMeanMs).toBeCloseTo(30, 6)
  })

  it('survives a device with no timestamp-query at all', () => {
    const s = summariseLevel(4, samples(4, [12, 12], false))
    expect(s.rows.find((r) => r.label === 'canopy')?.sampleCount).toBe(0)
    expect(s.frameMeanMs).toBeCloseTo(12, 6)
  })
})

describe('formatMarkdown', () => {
  const run = (integrated: boolean): BenchRun => ({
    meta: meta(integrated),
    samples: [...samples(0, [8, 9, 8]), ...samples(5, [20, 21, 30])],
  })

  it('shouts when the adapter is integrated and marks every verdict invalid', () => {
    const md = formatMarkdown(run(true))
    expect(md).toContain('INTEGRATED GPU — THIS IS NOT A RESULT')
    expect(md).toContain('force-high-performance-gpu')
    expect(md).not.toContain('**Verdict: FITS**')
    expect(md).toContain('INVALID')
  })

  it('says nothing about integrated adapters on a discrete run', () => {
    const md = formatMarkdown(run(false))
    expect(md).not.toContain('NOT A RESULT')
    expect(md).toContain('RTX 4070')
  })

  it('emits one table per level with the four required columns', () => {
    const md = formatMarkdown(run(false))
    expect(md).toContain('## Quality 0')
    expect(md).toContain('## Quality 5')
    expect(md).toContain('| Phase | mean ms | p95 ms | % of budget |')
    for (const p of PHASES) expect(md).toContain(`| ${p} |`)
  })

  it('names the highest level that fits', () => {
    const md = formatMarkdown(run(false))
    expect(md).toContain('**Quality 0 is the highest level that fits**')
  })

  it('says so when nothing fits, rather than picking the least bad level', () => {
    const md = formatMarkdown({ meta: meta(), samples: samples(3, [40, 41, 42]) })
    expect(md).toContain('No quality level holds 60 fps')
  })

  it('always states the 100 us quantisation caveat', () => {
    expect(formatMarkdown(run(false))).toContain('100 µs')
  })

  it('includes the world-generation table only when there is one', () => {
    expect(formatMarkdown(run(false))).not.toContain('## CPU world generation')
    const withGen = formatMarkdown({
      ...run(false),
      worldGen: [{ stage: 'terrain', ms: 4200, note: '1024² nodes' }],
    })
    expect(withGen).toContain('## CPU world generation')
    expect(withGen).toContain('| terrain | 4200 |')
  })
})
