/**
 * Wall-clock budgets, run alone.
 *
 * The budget assertions in `test/` measure microseconds. The default suite runs files in
 * parallel across workers and several of this project's tests build whole worlds, so a
 * microbenchmark sharing a core with one of those measures the contention and fails for a
 * reason that has nothing to do with the code. An external review hit exactly that: two
 * failures that passed in isolation.
 *
 * So budgets are reported by `npm test` and enforced only here, where nothing else is running.
 */
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vite.config.ts'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // One worker, one file at a time. This is the whole point of the file.
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      env: { PERF_BUDGETS: '1' },
      include: ['test/**/*.test.ts'],
    },
  }),
)
