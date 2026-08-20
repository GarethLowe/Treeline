/**
 * The harness has to be able to fail, or it proves nothing. These check that it does:
 * that a drifted baseline is caught, that a blown tolerance is caught, and that structural
 * and baseline cases cannot promote a model to `validated`.
 */

import { describe, expect, it } from 'vitest'

import type { BenchmarkCase } from '@sim/validation/cases'
import {
  deviationPct,
  missingBaselines,
  modelCoverage,
  recordBaselines,
  runCases,
  validatedModelIds,
} from '@sim/validation/harness'

const citation = { ref: 'test', full: 'test', locator: 'test' }

const mkCase = (
  id: string,
  source: BenchmarkCase['source'],
  value: number,
  expected: number | null,
  tolerancePct = 1,
  modelId = 'm',
): BenchmarkCase => ({
  id,
  modelId,
  quantity: id,
  unit: '-',
  expected,
  tolerancePct,
  source,
  citation,
  run: () => value,
})

describe('deviationPct', () => {
  it('is signed and relative', () => {
    expect(deviationPct(110, 100)).toBeCloseTo(10, 9)
    expect(deviationPct(90, 100)).toBeCloseTo(-10, 9)
  })

  it('compares against zero absolutely, since a relative deviation from zero is useless', () => {
    expect(deviationPct(0, 0)).toBe(0)
    expect(deviationPct(1e-9, 0)).toBe(Number.POSITIVE_INFINITY)
  })

  it('treats a non-finite result as an infinite deviation rather than silently passing', () => {
    expect(deviationPct(Number.NaN, 100)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('runCases', () => {
  it('fails a case that blows its published tolerance', () => {
    const [r] = runCases([mkCase('a', 'published', 102, 100, 1)], { a: 102 })
    expect(r?.pass).toBe(false)
    expect(r?.deviationPct).toBeCloseTo(2, 9)
  })

  it('fails a baseline-only case that has drifted, even with no published expectation', () => {
    const [r] = runCases([mkCase('a', 'baseline', 101, null)], { a: 100 })
    expect(r?.pass).toBe(false)
    expect(r?.baselineDeviationPct).toBeCloseTo(1, 9)
    expect(r?.deviationPct).toBeNull()
  })

  it('passes a baseline-only case inside the drift band', () => {
    const [r] = runCases([mkCase('a', 'baseline', 100.4, null)], { a: 100 })
    expect(r?.pass).toBe(true)
  })

  it('reports cases with no baseline so a new case cannot slip in unrecorded', () => {
    const results = runCases([mkCase('a', 'baseline', 1, null)], {})
    expect(missingBaselines(results)).toEqual(['a'])
    expect(recordBaselines(results)).toEqual({ a: 1 })
  })
})

describe('modelCoverage', () => {
  it('does not validate a model that only has structural cases', () => {
    const results = runCases([mkCase('a', 'structural', 1, 1)], { a: 1 })
    expect(validatedModelIds(results)).toEqual([])
    expect(modelCoverage(results)[0]?.structuralCases).toBe(1)
  })

  it('does not validate a model that only has baselines', () => {
    const results = runCases([mkCase('a', 'baseline', 1, null)], { a: 1 })
    expect(validatedModelIds(results)).toEqual([])
  })

  it('validates a model with a passing published case', () => {
    const results = runCases([mkCase('a', 'published', 1, 1)], { a: 1 })
    expect(validatedModelIds(results)).toEqual(['m'])
  })

  it('revokes validation when any of the model’s cases fails', () => {
    const results = runCases(
      [mkCase('a', 'published', 1, 1), mkCase('b', 'published', 2, 1)],
      { a: 1, b: 2 },
    )
    expect(validatedModelIds(results)).toEqual([])
    expect(modelCoverage(results)[0]?.failing).toEqual(['b'])
  })

  it('quotes the worst tolerance among a model’s published cases', () => {
    const results = runCases(
      [mkCase('a', 'published', 1, 1, 1), mkCase('b', 'published', 1, 1, 10)],
      { a: 1, b: 1 },
    )
    expect(modelCoverage(results)[0]?.tolerancePct).toBe(10)
  })
})
