/**
 * The benchmark harness — WP 2.5.
 *
 * Deliberately dumb: run every case, record what it produced, compare against (a) the
 * published expectation where one exists and (b) the recorded baseline in every case.
 * Deviation is reported as a percentage per benchmark, not as a boolean, because a 3% drift
 * that is invisible until it is a 30% drift is exactly the failure mode this package exists
 * to prevent.
 */

import type { BenchmarkCase, CaseSource } from './cases'

export interface CaseResult {
  readonly id: string
  readonly modelId: string
  readonly quantity: string
  readonly unit: string
  readonly source: CaseSource
  readonly actual: number
  readonly expected: number | null
  readonly tolerancePct: number
  /** Signed, percent. `null` when there is no published expectation. */
  readonly deviationPct: number | null
  /** Signed, percent, against `baselines.json`. `null` when the case has no baseline yet. */
  readonly baselineDeviationPct: number | null
  readonly pass: boolean
  readonly note: string | undefined
}

export type Baselines = Readonly<Record<string, number>>

/** Baseline drift beyond this fails the build even when the case has no published anchor. */
export const BASELINE_TOLERANCE_PCT = 0.5

/**
 * Signed relative deviation in percent. Zero expectations are compared absolutely, because
 * a relative deviation from zero is either 0 or infinite and neither is informative.
 */
export function deviationPct(actual: number, expected: number): number {
  if (!Number.isFinite(actual)) return Number.POSITIVE_INFINITY
  if (expected === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY
  return ((actual - expected) / Math.abs(expected)) * 100
}

export function runCases(cases: readonly BenchmarkCase[], baselines: Baselines): CaseResult[] {
  return cases.map((c) => {
    const actual = c.run()
    const dev = c.expected === null ? null : deviationPct(actual, c.expected)
    const base = baselines[c.id]
    const baseDev = base === undefined ? null : deviationPct(actual, base)
    const publishedOk = dev === null || Math.abs(dev) <= c.tolerancePct
    const baselineOk = baseDev === null || Math.abs(baseDev) <= BASELINE_TOLERANCE_PCT
    return {
      id: c.id,
      modelId: c.modelId,
      quantity: c.quantity,
      unit: c.unit,
      source: c.source,
      actual,
      expected: c.expected,
      tolerancePct: c.tolerancePct,
      deviationPct: dev,
      baselineDeviationPct: baseDev,
      pass: publishedOk && baselineOk,
      note: c.note,
    }
  })
}

/** Cases whose baseline is missing — the build should refuse rather than silently pass. */
export const missingBaselines = (results: readonly CaseResult[]): string[] =>
  results.filter((r) => r.baselineDeviationPct === null).map((r) => r.id)

export const recordBaselines = (results: readonly CaseResult[]): Baselines =>
  Object.fromEntries(results.map((r) => [r.id, r.actual]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))

// ---------------------------------------------------------------------------
// §0.7.3: what this suite actually validates
// ---------------------------------------------------------------------------

export interface ModelCoverage {
  readonly modelId: string
  readonly publishedCases: number
  readonly structuralCases: number
  readonly baselineCases: number
  readonly failing: readonly string[]
  /** True only if there is at least one PASSING published case and no failing one. */
  readonly validated: boolean
  /** Worst tolerance among the published cases — the honest number to quote. */
  readonly tolerancePct: number
}

/**
 * The anti-over-claim mechanism required by §0.7.3: a model may claim `validated` only if a
 * test here asserts it. Structural and baseline cases confer nothing, however many there are.
 *
 * M6's export/HUD layer should gate `status: 'validated'` on this rather than on a hand-typed
 * provenance block, so the claim cannot drift away from the evidence.
 */
export function modelCoverage(results: readonly CaseResult[]): ModelCoverage[] {
  const ids = [...new Set(results.map((r) => r.modelId))].sort()
  return ids.map((modelId) => {
    const mine = results.filter((r) => r.modelId === modelId)
    const pub = mine.filter((r) => r.source === 'published')
    const failing = mine.filter((r) => !r.pass).map((r) => r.id)
    const pubFailing = pub.filter((r) => !r.pass)
    return {
      modelId,
      publishedCases: pub.length,
      structuralCases: mine.filter((r) => r.source === 'structural').length,
      baselineCases: mine.filter((r) => r.source === 'baseline').length,
      failing,
      validated: pub.length > 0 && pubFailing.length === 0,
      tolerancePct: pub.reduce((worst, r) => Math.max(worst, r.tolerancePct), 0),
    }
  })
}

export const validatedModelIds = (results: readonly CaseResult[]): string[] =>
  modelCoverage(results)
    .filter((c) => c.validated)
    .map((c) => c.modelId)

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const sig = (v: number): string => {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1000 || a < 0.001) return v.toExponential(4)
  return v.toPrecision(6).replace(/\.?0+$/, '')
}

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)

/** Markdown deviation table. Baseline rows are folded into a summary unless they drifted. */
export function formatReport(results: readonly CaseResult[]): string {
  const anchored = results.filter((r) => r.source !== 'baseline')
  const drifted = results.filter((r) => r.source === 'baseline' && !r.pass)

  const rows = [...anchored, ...drifted].map((r) =>
    [
      r.id,
      r.source,
      r.quantity,
      r.unit,
      r.expected === null ? '—' : sig(r.expected),
      sig(r.actual),
      pct(r.deviationPct),
      r.expected === null ? '—' : `±${r.tolerancePct}%`,
      pct(r.baselineDeviationPct),
      r.pass ? 'pass' : 'FAIL',
    ].join(' | '),
  )

  const header = [
    '| case | kind | quantity | unit | expected | actual | dev | tol | vs baseline | |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]

  const coverage = modelCoverage(results)
  const covLines = coverage.map(
    (c) =>
      `| ${c.modelId} | ${c.validated ? '**validated by this suite**' : 'not validated here'} | ` +
      `${c.publishedCases} published / ${c.structuralCases} structural / ${c.baselineCases} baseline | ` +
      `${c.publishedCases > 0 ? `worst tol ±${c.tolerancePct}%` : '—'} |`,
  )

  const baselineCount = results.filter((r) => r.source === 'baseline').length
  const failed = results.filter((r) => !r.pass).length

  return [
    '',
    '## Benchmark deviation report',
    '',
    ...header,
    ...rows.map((r) => `| ${r} |`),
    '',
    `${baselineCount} characterisation baselines checked at ±${BASELINE_TOLERANCE_PCT}% (only drifted rows listed above).`,
    `${results.length} cases total, ${failed} failing.`,
    '',
    '## Validation coverage (§0.7.3)',
    '',
    '| model | status conferred by this suite | cases | tolerance |',
    '|---|---|---|---|',
    ...covLines,
    '',
    'Only `published` cases confer `validated`. Structural cases guard transcription; baseline',
    'cases guard regression. Neither is evidence a model reproduces reality.',
    '',
  ].join('\n')
}
