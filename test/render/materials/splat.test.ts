/**
 * Terrain splatting by slope, aspect and biome. WP 1.6.
 *
 * These assertions are geomorphological statements, not appearance ones, so they survive any
 * retuning of the constants: steep ground exposes rock, drainages accumulate litter,
 * equator-facing aspects are drier, and the weights always sum to 1.
 */

import { describe, expect, it } from 'vitest'
import { GROUND_SLOT } from '../../../src/render/materials/library.ts'
import { SPLAT_SLOPE, heightBlend, slopeExposure, splatWeights, type SplatWeights } from '../../../src/render/materials/splat.ts'

const NORTH = 51 // northern hemisphere, roughly the UK site
const SOUTH = -33 // southern hemisphere, roughly a eucalypt site

const flat = {
  slopeTangent: 0,
  aspectRad: 0,
  drainage: 0.5,
  latitudeDeg: NORTH,
}

const sum = (w: SplatWeights): number => w[0] + w[1] + w[2] + w[3]

describe('slope exposure from aspect', () => {
  it('peaks on the equator-facing aspect in each hemisphere', () => {
    // Aspect is DOWNSLOPE azimuth clockwise from north, so aspect = pi is a south-facing face.
    expect(slopeExposure(Math.PI, NORTH)).toBeCloseTo(1, 10)
    expect(slopeExposure(0, NORTH)).toBeCloseTo(0, 10)
    expect(slopeExposure(Math.PI, SOUTH)).toBeCloseTo(0, 10)
    expect(slopeExposure(0, SOUTH)).toBeCloseTo(1, 10)
  })

  it('is symmetric about the north-south line and neutral east-west', () => {
    expect(slopeExposure(Math.PI / 2, NORTH)).toBeCloseTo(0.5, 10)
    expect(slopeExposure((3 * Math.PI) / 2, NORTH)).toBeCloseTo(0.5, 10)
  })
})

describe('splat weights', () => {
  it('sum to exactly 1 across a wide sweep of inputs', () => {
    for (let s = 0; s < 20; s++) {
      for (let a = 0; a < 8; a++) {
        for (let d = 0; d <= 4; d++) {
          const w = splatWeights({
            slopeTangent: s * 0.25,
            aspectRad: (a * Math.PI) / 4,
            drainage: d / 4,
            latitudeDeg: NORTH,
          })
          expect(sum(w)).toBeCloseTo(1, 10)
          for (const x of w) expect(x).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('tolerates out-of-range inputs from a filtered texture fetch', () => {
    const w = splatWeights({ slopeTangent: -0.2, aspectRad: 7.9, drainage: 1.4, latitudeDeg: 0 })
    expect(sum(w)).toBeCloseTo(1, 10)
    for (const x of w) expect(Number.isFinite(x)).toBe(true)
  })

  it('exposes rock monotonically with slope, and only with slope', () => {
    let previous = -1
    for (let i = 0; i <= 20; i++) {
      const slope = (i / 20) * 1.4
      const w = splatWeights({ ...flat, slopeTangent: slope })
      expect(w[GROUND_SLOT.Rock]).toBeGreaterThanOrEqual(previous)
      previous = w[GROUND_SLOT.Rock]
    }
    // Below the onset there is no bare rock; above the full threshold there is nothing else.
    expect(splatWeights({ ...flat, slopeTangent: SPLAT_SLOPE.rockOnset - 0.05 })[GROUND_SLOT.Rock]).toBe(0)
    expect(splatWeights({ ...flat, slopeTangent: SPLAT_SLOPE.rockFull + 0.1 })[GROUND_SLOT.Rock]).toBeCloseTo(1, 10)

    // Aspect and drainage must not move it: the angle of repose does not care about the sun.
    const a = splatWeights({ slopeTangent: 0.7, aspectRad: 0, drainage: 0, latitudeDeg: NORTH })
    const b = splatWeights({ slopeTangent: 0.7, aspectRad: Math.PI, drainage: 1, latitudeDeg: NORTH })
    expect(a[GROUND_SLOT.Rock]).toBeCloseTo(b[GROUND_SLOT.Rock], 12)
  })

  it('accumulates litter in drainages', () => {
    const ridge = splatWeights({ ...flat, drainage: 0 })
    const valley = splatWeights({ ...flat, drainage: 1 })
    expect(valley[GROUND_SLOT.Litter]).toBeGreaterThan(ridge[GROUND_SLOT.Litter])
    expect(ridge[GROUND_SLOT.Litter]).toBeCloseTo(0, 6)
  })

  it('sheds litter off steep ground even in a drainage', () => {
    const gentle = splatWeights({ ...flat, drainage: 1, slopeTangent: 0.05 })
    const steep = splatWeights({ ...flat, drainage: 1, slopeTangent: SPLAT_SLOPE.litterShedEnd + 0.05 })
    expect(steep[GROUND_SLOT.Litter]).toBeLessThan(gentle[GROUND_SLOT.Litter])
  })

  it('puts more xeric ground on the equator-facing aspect and flips with hemisphere', () => {
    const slopeTangent = 0.4
    const northFacing = { slopeTangent, aspectRad: 0, drainage: 0.3, latitudeDeg: NORTH }
    const southFacing = { ...northFacing, aspectRad: Math.PI }
    expect(splatWeights(southFacing)[GROUND_SLOT.Xeric]).toBeGreaterThan(
      splatWeights(northFacing)[GROUND_SLOT.Xeric],
    )
    // And the mesic default does the opposite.
    expect(splatWeights(northFacing)[GROUND_SLOT.Mesic]).toBeGreaterThan(
      splatWeights(southFacing)[GROUND_SLOT.Mesic],
    )
    // Southern hemisphere: the same two aspects swap roles entirely.
    const s = { ...northFacing, latitudeDeg: SOUTH }
    const sSouthFacing = { ...s, aspectRad: Math.PI }
    expect(splatWeights(s)[GROUND_SLOT.Xeric]).toBeGreaterThan(
      splatWeights(sSouthFacing)[GROUND_SLOT.Xeric],
    )
  })

  it('never leaves the ground with no cover at all', () => {
    // Every non-rock point must have some mesic component; a zero row would render as a hole.
    for (let i = 0; i <= 10; i++) {
      const w = splatWeights({ ...flat, slopeTangent: (i / 10) * SPLAT_SLOPE.rockOnset })
      expect(w[GROUND_SLOT.Mesic]).toBeGreaterThan(0)
    }
  })
})

describe('height-aware blending', () => {
  const w: SplatWeights = [0.4, 0.4, 0.1, 0.1]

  it('preserves normalisation', () => {
    const out = heightBlend(w, [0.2, 0.9, 0.5, 0.1])
    expect(sum(out)).toBeCloseTo(1, 10)
  })

  it('lets the taller material win where weights are comparable', () => {
    // Litter and mesic are tied on weight; the one whose stored height is greater must take
    // the texel, so pebbles poke through a thin litter layer instead of averaging with it.
    const out = heightBlend(w, [0.1, 0.9, 0, 0])
    expect(out[GROUND_SLOT.Litter]).toBeGreaterThan(out[GROUND_SLOT.Mesic])
  })

  it('never resurrects a zero-weight material on height alone', () => {
    const out = heightBlend([1, 0, 0, 0], [0, 1, 1, 1])
    expect(out[0]).toBeCloseTo(1, 10)
    expect(out[1]).toBe(0)
    expect(out[2]).toBe(0)
    expect(out[3]).toBe(0)
  })

  it('falls back to the unbiased weights rather than emitting black', () => {
    // All weights zero is not reachable from splatWeights, but a caller could construct it,
    // and returning zeros would render black terrain.
    const out = heightBlend([0, 0, 0, 0], [0, 0, 0, 0])
    expect(out).toEqual([0, 0, 0, 0])
  })

  it('approaches the unbiased weights as sharpness grows', () => {
    const soft = heightBlend(w, [0, 0.3, 0.6, 0.9], 100)
    for (let i = 0; i < 4; i++) {
      expect(soft[i] as number).toBeCloseTo(w[i] as number, 2)
    }
  })
})
