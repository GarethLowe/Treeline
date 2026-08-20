/**
 * Sample statistics and the markdown report — work package 3.7.
 *
 * Everything in here is pure, so the report format is CLI-testable and the one part of the
 * benchmark that could quietly lie — the arithmetic — is covered without a GPU.
 *
 * Two honesty rules are encoded rather than left to the reader:
 *
 * - **An integrated adapter poisons the whole report.** `looksIntegrated` puts a banner at
 *   the top and the word "INVALID" in every verdict. The project has already been caught
 *   once by a ~10x iGPU number read as a real result (spec §0.4, §6.8 pitfall 1); a
 *   benchmark that can be misread the same way is worse than no benchmark.
 * - **Per-pass microseconds are not claimed.** Chrome quantises timestamp results to 100 us,
 *   so `src/gpu/profiler.ts` groups passes into five phases and EMAs them. The report says
 *   so, reports phases only, and marks whether the run had `highResolution` timestamps.
 */

import type { AdapterReport, Phase, QualityLevel } from '@contracts/gpu.ts'
import { PHASES } from '@contracts/gpu.ts'

/** 60 fps. The number every verdict is measured against. */
export const FRAME_BUDGET_MS = 1000 / 60

/**
 * Tolerances on the rAF interval, because rAF is vsync-locked and therefore quantised.
 *
 * On a 60 Hz display a frame that finishes in 4 ms and one that finishes in 15 ms both
 * present at 16.67 ms, with jitter of a few tenths either side. Comparing a jittering 16.7
 * against a hard 16.67 would report a perfectly healthy level as "does not fit", and a
 * single missed vsync (which costs a whole 16.67 ms, not a millisecond) would drag any p95
 * over the line. So: 5% on the mean, 25% on the p95 — the p95 band is wider because it is
 * one missed vsync in twenty frames, which is a real but not disqualifying hitch.
 *
 * The consequence, stated because it is the accepted error of this harness: **the rAF row
 * cannot resolve any cost below the display refresh interval.** Two quality levels that
 * both finish early read identically there. The `all phases` and `submit wall clock` rows
 * are not vsync-locked and are what discriminates below the refresh interval.
 */
export const MEAN_TOLERANCE = 1.05
export const P95_TOLERANCE = 1.25

/** One rendered frame of the measurement phase. */
export interface BenchSample {
  readonly level: QualityLevel
  /** Presented frame interval, rAF to rAF. The frame rate the user actually sees. */
  readonly rafDeltaMs: number
  /**
   * `queue.onSubmittedWorkDone()` wall clock for a recent submit. Always available, even
   * without `timestamp-query`. Includes queue latency the GPU timestamps exclude.
   */
  readonly submitMs: number
  /**
   * Instantaneous per-phase GPU totals from a timestamp readback, or null on a frame where
   * no new readback landed. Null rather than a repeat of the previous value: counting the
   * same readback twice would narrow the percentile spread for free.
   */
  readonly phaseMs: Readonly<Record<Phase, number>> | null
  /** 0 at ground level, 1 at the top of the altitude sweep. */
  readonly altitudeFraction: number
}

export interface BenchMeta {
  readonly adapter: AdapterReport
  /** True when the profiler was granted `timestamp-query`. Without it phases are all zero. */
  readonly timestamps: boolean
  /** True only in a dev build with WebGPU developer features; per-pass numbers need it. */
  readonly highResolution: boolean
  readonly seed: number
  readonly biome: string
  readonly canvasWidth: number
  readonly canvasHeight: number
  readonly warmupFrames: number
  readonly measureFrames: number
  readonly userAgent: string
  readonly startedAt: string
  readonly devicePixelRatio: number
}

export interface BenchRun {
  readonly meta: BenchMeta
  readonly samples: readonly BenchSample[]
  /** CPU world-generation stage timings, if the run collected them. */
  readonly worldGen?: readonly { readonly stage: string; readonly ms: number; readonly note: string }[]
}

export type Verdict = 'fits' | 'marginal' | 'does not fit'

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  let sum = 0
  for (const x of xs) sum += x
  return sum / xs.length
}

/**
 * Nearest-rank p95. No interpolation: with 240 samples the difference is under a tenth of a
 * millisecond and an interpolated percentile is harder to reason about than an actual
 * observed frame.
 */
export function p95(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))
  return sorted[idx] as number
}

/**
 * Three states, not two.
 *
 * A level whose mean fits but whose p95 does not is the interesting case: it holds 60 fps
 * most of the time and drops frames on the expensive part of the camera path. Collapsing it
 * into "fits" hides exactly the thing a frame-budget benchmark exists to find.
 */
export function verdictFor(meanMs: number, p95Ms: number, budgetMs = FRAME_BUDGET_MS): Verdict {
  if (meanMs > budgetMs * MEAN_TOLERANCE) return 'does not fit'
  if (p95Ms > budgetMs * P95_TOLERANCE) return 'marginal'
  return 'fits'
}

export interface PhaseRow {
  readonly label: string
  readonly meanMs: number
  readonly p95Ms: number
  readonly budgetFraction: number
  readonly sampleCount: number
}

export interface LevelSummary {
  readonly level: QualityLevel
  readonly rows: readonly PhaseRow[]
  readonly frameMeanMs: number
  readonly frameP95Ms: number
  readonly verdict: Verdict
  readonly fps: number
  readonly sampleCount: number
}

function row(label: string, xs: readonly number[], budgetMs: number): PhaseRow {
  const m = mean(xs)
  return { label, meanMs: m, p95Ms: p95(xs), budgetFraction: m / budgetMs, sampleCount: xs.length }
}

export function summariseLevel(
  level: QualityLevel,
  samples: readonly BenchSample[],
  budgetMs = FRAME_BUDGET_MS,
): LevelSummary {
  const own = samples.filter((s) => s.level === level)
  const withPhases = own.filter((s) => s.phaseMs !== null)

  const rows: PhaseRow[] = []
  const phaseTotals: number[] = withPhases.map((s) => {
    let total = 0
    for (const p of PHASES) total += (s.phaseMs as Record<Phase, number>)[p]
    return total
  })
  for (const p of PHASES) {
    rows.push(row(p, withPhases.map((s) => (s.phaseMs as Record<Phase, number>)[p]), budgetMs))
  }
  rows.push(row('**all phases (GPU)**', phaseTotals, budgetMs))

  const raf = own.map((s) => s.rafDeltaMs)
  const submit = own.map((s) => s.submitMs).filter((v) => v > 0)
  rows.push(row('**submit wall clock**', submit, budgetMs))
  rows.push(row('**frame (rAF interval)**', raf, budgetMs))

  const frameMeanMs = mean(raf)
  const frameP95Ms = p95(raf)
  return {
    level,
    rows,
    frameMeanMs,
    frameP95Ms,
    verdict: verdictFor(frameMeanMs, frameP95Ms, budgetMs),
    fps: frameMeanMs > 0 ? 1000 / frameMeanMs : 0,
    sampleCount: own.length,
  }
}

export function summarise(run: BenchRun, budgetMs = FRAME_BUDGET_MS): LevelSummary[] {
  const levels = [...new Set(run.samples.map((s) => s.level))].sort((a, b) => a - b)
  return levels.map((l) => summariseLevel(l, run.samples, budgetMs))
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const f2 = (v: number): string => v.toFixed(2)
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`

function adapterName(a: AdapterReport): string {
  return (
    [a.vendor, a.architecture, a.device].filter((s) => s.length > 0).join(' / ') ||
    a.description ||
    '(unreported)'
  )
}

/** The copy-pasteable result. */
export function formatMarkdown(run: BenchRun, budgetMs = FRAME_BUDGET_MS): string {
  const { meta } = run
  const out: string[] = []
  const invalid = meta.adapter.looksIntegrated

  out.push('# ForestFire frame benchmark')
  out.push('')

  if (invalid) {
    out.push('> # !! INTEGRATED GPU — THIS IS NOT A RESULT !!')
    out.push('>')
    out.push(
      `> WebGPU selected \`${adapterName(meta.adapter)}\`, which looks integrated. On this class ` +
        'of machine that is roughly one eighth of the compute and one quarter of the memory ' +
        'bandwidth of the discrete part, so every number below is off by around an order of ' +
        'magnitude. **Do not record these figures anywhere, and do not trade accuracy against ' +
        'them (spec §0.5.1).** Fix the adapter selection and re-run: chrome://flags → ' +
        '`#force-high-performance-gpu` → Enabled, then relaunch.',
    )
    out.push('')
  }

  out.push('| | |')
  out.push('|---|---|')
  out.push(`| Adapter | ${adapterName(meta.adapter)}${invalid ? ' — **INTEGRATED, INVALID**' : ''} |`)
  out.push(`| Description | ${meta.adapter.description || '(none)'} |`)
  out.push(`| Timestamp queries | ${meta.timestamps ? 'granted' : '**not granted — phases unavailable**'} |`)
  out.push(`| Timestamp resolution | ${meta.highResolution ? 'high (dev build)' : 'quantised to 100 µs'} |`)
  out.push(`| Backbuffer | ${meta.canvasWidth} × ${meta.canvasHeight} (dpr ${meta.devicePixelRatio}) |`)
  out.push(`| World | seed ${meta.seed}, ${meta.biome} |`)
  out.push(`| Per level | ${meta.warmupFrames} warmup + ${meta.measureFrames} measured frames |`)
  out.push(`| Budget | ${f2(budgetMs)} ms (60 fps) |`)
  out.push(`| Run at | ${meta.startedAt} |`)
  out.push('')
  out.push(
    '**Read the phase rows as phases, not passes.** Chrome quantises timestamp query results ' +
      'to 100 µs, so `src/gpu/profiler.ts` times passes individually but only reports them ' +
      'summed into five phases of >= 300 µs, EMA-smoothed. Per-pass microseconds from a ' +
      'shipping build are noise. The `submit wall clock` row is `queue.onSubmittedWorkDone()` ' +
      'and is the always-available ground truth; it includes queue latency the GPU timestamps ' +
      'exclude, so it reads higher than `all phases`.',
  )
  out.push('')
  out.push(
    '**The `frame (rAF interval)` row is vsync-locked and cannot resolve anything faster than ' +
      'the display refresh.** Two levels that both finish early read identically there — look ' +
      'at `all phases` and `submit wall clock` for the real headroom and for where the cost ' +
      `moved. Verdicts allow ${((MEAN_TOLERANCE - 1) * 100).toFixed(0)}% jitter on the mean and ` +
      `${((P95_TOLERANCE - 1) * 100).toFixed(0)}% on the p95 for the same reason: a single ` +
      'missed vsync costs a whole refresh interval, not a millisecond.',
  )
  out.push('')

  const summaries = summarise(run, budgetMs)
  for (const s of summaries) {
    out.push(`## Quality ${s.level}`)
    out.push('')
    out.push('| Phase | mean ms | p95 ms | % of budget |')
    out.push('|---|---:|---:|---:|')
    for (const r of s.rows) {
      const value =
        r.sampleCount === 0
          ? '| — | — | — |'
          : `| ${f2(r.meanMs)} | ${f2(r.p95Ms)} | ${pct(r.budgetFraction)} |`
      out.push(`| ${r.label} ${value}`)
    }
    out.push('')
    out.push(
      `**Verdict: ${invalid ? 'INVALID (iGPU)' : s.verdict.toUpperCase()}** — ` +
        `${f2(s.frameMeanMs)} ms mean (${s.fps.toFixed(1)} fps), ${f2(s.frameP95Ms)} ms p95, ` +
        `over ${s.sampleCount} frames.`,
    )
    out.push('')
  }

  const best = [...summaries].reverse().find((s) => s.verdict === 'fits')
  out.push('## Where 60 fps lands')
  out.push('')
  if (invalid) {
    out.push('Unknown — the run was on an integrated adapter. Re-run on the discrete GPU.')
  } else if (best === undefined) {
    out.push('**No quality level holds 60 fps at the 95th percentile.** Lowest tested level was ' +
      `quality ${summaries[0]?.level ?? 0} at ${f2(summaries[0]?.frameMeanMs ?? 0)} ms mean.`)
  } else {
    out.push(
      `**Quality ${best.level} is the highest level that fits** — ${f2(best.frameMeanMs)} ms mean, ` +
        `${f2(best.frameP95Ms)} ms p95, against a ${f2(budgetMs)} ms budget.`,
    )
  }
  out.push('')

  if (run.worldGen !== undefined && run.worldGen.length > 0) {
    out.push('## CPU world generation')
    out.push('')
    out.push('| Stage | ms | note |')
    out.push('|---|---:|---|')
    let total = 0
    for (const s of run.worldGen) {
      total += s.ms
      out.push(`| ${s.stage} | ${s.ms.toFixed(0)} | ${s.note} |`)
    }
    out.push(`| **total** | **${total.toFixed(0)}** | |`)
    out.push('')
  }

  return out.join('\n')
}
