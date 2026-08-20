/**
 * WP 2.5 — the automated validation suite. `npm run validate`.
 *
 * This is the file that converts "physically accurate" from a claim into something a build
 * can check. Three things happen here and each fails the build on its own:
 *
 *  1. **Published benchmarks.** Every case with an expected value from an obtainable source
 *     must land inside its stated tolerance. The §4.2 GR2 D2L2 anchor is the load-bearing one.
 *  2. **Regression against recorded baselines.** Every case, published or not, is compared
 *     against `baselines.json` at ±0.5%. This is what catches a 3% drift while it is still 3%.
 *  3. **Provenance honesty (§0.7.3).** A model may claim `validated` only if a published case
 *     here asserts it and passes. The expected set is written out literally below, so
 *     widening the claim requires editing this file on purpose.
 *
 * The deviation table is printed at the end of the run — expected vs actual vs % error per
 * benchmark, not pass/fail.
 *
 * Re-record baselines deliberately, never reflexively:  UPDATE_BASELINES=1 npm run validate
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'

import { BENCHMARK_CASES } from '@sim/validation/cases'
import {
  BASELINE_TOLERANCE_PCT,
  type Baselines,
  formatReport,
  missingBaselines,
  modelCoverage,
  recordBaselines,
  runCases,
  validatedModelIds,
} from '@sim/validation/harness'
import { MODELS } from '../../src/provenance.ts'

const BASELINE_PATH = new URL('./baselines.json', import.meta.url)
const UPDATE = process.env['UPDATE_BASELINES'] === '1'

const baselines: Baselines = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baselines)
  : {}

const results = runCases(BENCHMARK_CASES, baselines)

afterAll(() => {
  console.log(formatReport(results))
  if (UPDATE) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(recordBaselines(results), null, 2)}\n`, 'utf8')
    console.log(`\nRe-recorded ${results.length} baselines to ${BASELINE_PATH.pathname}`)
  }
})

/**
 * The set of models this suite actually validates. Anything not listed here may not carry
 * `status: 'validated'` in a provenance block, however good it looks.
 *
 * Notably absent, and deliberately so:
 *  - `anderson-1983-lb`   — §4.6 OPEN QUESTION, exponents untraced, two reference
 *                           implementations disagree with the spec and with each other.
 *  - `cheney-1998-grass`  — the spec transcribes the closure but no published ROS datum for
 *                           it, so only its internal continuity is checked here.
 */
const EXPECTED_VALIDATED = [
  'anderson-1969-residence',
  'byram-1959-flame-length',
  'byram-1959-intensity',
  // Added 2026-08-20 with the swap to the shipping kernel: the Albini & Baughman WAF anchors
  // used to live only in a unit test, which §0.7.3 does not accept as conferring `validated`.
  'midflame-waf',
  'rothermel-surface',
  'rothermel-wind-limit',
] as const

describe('published benchmarks', () => {
  for (const r of results.filter((x) => x.source === 'published')) {
    it(`${r.id} — ${r.quantity} [${r.unit}]`, () => {
      expect(r.expected).not.toBeNull()
      const dev = r.deviationPct ?? Number.POSITIVE_INFINITY
      expect(
        Math.abs(dev),
        `${r.id}: expected ${r.expected} ${r.unit}, got ${r.actual.toPrecision(6)} ` +
          `(${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%, tolerance ±${r.tolerancePct}%)` +
          (r.note === undefined ? '' : `\n  note: ${r.note}`),
      ).toBeLessThanOrEqual(r.tolerancePct)
    })
  }
})

describe('structural checks', () => {
  for (const r of results.filter((x) => x.source === 'structural')) {
    it(`${r.id} — ${r.quantity}`, () => {
      const dev = r.deviationPct ?? Number.POSITIVE_INFINITY
      expect(
        Math.abs(dev),
        `${r.id}: expected ${r.expected}, got ${r.actual.toPrecision(6)} (${dev.toFixed(2)}%)`,
      ).toBeLessThanOrEqual(r.tolerancePct)
    })
  }
})

describe('regression against recorded baselines', () => {
  it('every case has a recorded baseline', () => {
    const missing = missingBaselines(results)
    expect(
      UPDATE ? [] : missing,
      `${missing.length} case(s) have no baseline. If these are new, re-record deliberately:\n` +
        `  UPDATE_BASELINES=1 npm run validate\n  ${missing.slice(0, 12).join('\n  ')}`,
    ).toEqual([])
  })

  const drifted = results.filter(
    (r) => r.baselineDeviationPct !== null && Math.abs(r.baselineDeviationPct) > BASELINE_TOLERANCE_PCT,
  )

  it(`no case drifts more than ±${BASELINE_TOLERANCE_PCT}% from its baseline`, () => {
    expect(
      UPDATE ? [] : drifted.map((r) => `${r.id}: ${(r.baselineDeviationPct ?? 0).toFixed(3)}%`),
      'Physics changed. If the change is intended and correct, re-record with UPDATE_BASELINES=1 ' +
        'and say in the commit message what moved and why.',
    ).toEqual([])
  })
})

describe('validation coverage (§0.7.3)', () => {
  it('validates exactly the models it claims to', () => {
    expect(validatedModelIds(results)).toEqual([...EXPECTED_VALIDATED])
  })

  it('no provenance block claims `validated` without a passing published case here', () => {
    const validated = new Set(validatedModelIds(results))
    // Scoped to models this suite actually carries cases for. It cannot speak for models
    // validated elsewhere against their own published anchors — solar position against an
    // ephemeris, blackbody colour against CIE illuminant A — and complaining about those would
    // push a correct claim into `calibrated` to silence a test that was never their arbiter.
    const covered = new Set(results.map((r) => r.modelId))
    const overclaiming = MODELS.filter(
      (m) => m.status === 'validated' && covered.has(m.id) && !validated.has(m.id),
    ).map((m) => m.id)
    expect(
      overclaiming,
      'A model claims `validated` but nothing in test/validation/ asserts it. Either add a ' +
        'published benchmark case or downgrade the status to `calibrated`.',
    ).toEqual([])
  })

  it('every `validated` model states the tolerance it was validated at', () => {
    for (const c of modelCoverage(results).filter((x) => x.validated)) {
      expect(c.tolerancePct, `${c.modelId} has a published case with a zero tolerance`).toBeGreaterThan(0)
    }
  })

  it('models with only structural or baseline cases are not reported as validated', () => {
    const cov = modelCoverage(results)
    for (const id of ['anderson-1983-lb', 'cheney-1998-grass']) {
      const c = cov.find((x) => x.modelId === id)
      expect(c, `${id} should appear in the coverage report`).toBeDefined()
      expect(c?.validated, `${id} must not be reported as validated`).toBe(false)
    }
  })
})
