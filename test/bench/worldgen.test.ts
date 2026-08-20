/**
 * The world-generation benchmark is CPU-only by construction — WP 1.2 exposes a device-free
 * terrain generator and neither vegetation placement nor tree meshing touches the GPU — so
 * it runs here, on the CLI, exactly as it does in the browser.
 *
 * Run small: a 200 m domain at 128 nodes with a handful of erosion droplets. The point is
 * that the harness reports every stage in order with a real duration, not that it
 * reproduces the 9 s figure.
 */

import { describe, expect, it } from 'vitest'
import { benchWorldGen } from '../../src/bench/worldgen.ts'

const small = {
  seed: 1337,
  biome: 'western-us-conifer',
  sizeM: 200,
  gridN: 128,
  maxMeshes: 4,
  droplets: 0,
} as const

describe('benchWorldGen', () => {
  it('reports every stage, in execution order, with a non-negative duration', () => {
    const r = benchWorldGen(small)
    expect(r.stages.map((s) => s.stage)).toEqual([
      'terrain',
      'vegetation',
      'mesh-key scan',
      'tree geometry',
    ])
    for (const s of r.stages) expect(s.ms).toBeGreaterThanOrEqual(0)
    expect(r.totalMs).toBeCloseTo(
      r.stages.reduce((a, s) => a + s.ms, 0),
      6,
    )
  })

  it('carries WP 1.2\'s own sub-stage split through, since that is where the seconds are', () => {
    const [terrain] = benchWorldGen(small).stages
    expect(terrain?.note).toMatch(/\d+² nodes/)
  })

  it('caps the meshes it generates so a dense biome cannot take minutes', () => {
    const [, , , trees] = benchWorldGen({ ...small, maxMeshes: 2 }).stages
    expect(trees?.note).toMatch(/^2 of \d+ meshes generated/)
  })

  it('averages across repeats rather than summing them', () => {
    const clock = fakeClock([0, 10, 20, 30, 40, 100, 130, 160, 190, 220])
    const one = benchWorldGen({ ...small, now: fakeClock([0, 10, 20, 30, 40]) })
    const two = benchWorldGen({ ...small, repeats: 2, now: clock })
    // Run 1 stages are 10 ms each; run 2 stages are 30 ms each; the mean is 20.
    expect(one.stages.every((s) => s.ms === 10)).toBe(true)
    expect(two.stages.every((s) => s.ms === 20)).toBe(true)
  })
})

/** Hands out a fixed sequence of timestamps, then holds the last one. */
function fakeClock(values: readonly number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] as number
}
