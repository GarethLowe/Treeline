/**
 * Wall-clock budgets, measured always and enforced only when asked.
 *
 * These assertions used to fail in the default suite for a reason that had nothing to do with
 * the code: Vitest runs files in parallel across workers, several of this project's tests are
 * CPU-heavy (the occupancy sweeps build whole worlds), and a microbenchmark sharing a core
 * with them measures the contention rather than the function. An external review hit exactly
 * that — two failures that passed in isolation at 59.4 µs and 343 ns.
 *
 * A test that fails depending on what else is running teaches people to ignore failures, which
 * costs far more than the budget protects. So the measurement still runs and still prints on
 * every suite — a regression is visible in the log — and the assertion is only made when
 * `PERF_BUDGETS=1`, which `npm run bench:cpu` sets while pinning Vitest to a single worker.
 */

import { expect } from 'vitest'

/** True when budgets are being enforced rather than merely reported. */
export const ENFORCING = process.env['PERF_BUDGETS'] === '1'

/**
 * Report `measured` against `budget`, and assert only under `npm run bench:cpu`.
 *
 * `label` and `unit` are for the log line, which is the point of this in the default suite:
 * the number is there to be read even when nothing fails on it.
 */
export function expectWithinBudget(
  label: string,
  measured: number,
  budget: number,
  unit: string,
): void {
  const over = measured > budget
  const note = ENFORCING ? '' : over ? '  <- OVER BUDGET (not enforced here)' : ''
  // eslint-disable-next-line no-console
  console.log(`${label}: ${measured.toFixed(measured < 10 ? 3 : 1)} ${unit} / ${budget} ${unit}${note}`)
  if (ENFORCING) {
    expect(measured, `${label} exceeded its budget`).toBeLessThan(budget)
  }
}
