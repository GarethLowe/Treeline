/**
 * The camera path is the thing that makes two benchmark runs comparable. If it drifts with
 * frame rate, or leaves the domain, or jumps at the cycle wrap, every number the harness
 * produces is against a different scene and the sweep means nothing. So it is tested.
 */

import { describe, expect, it } from 'vitest'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import {
  MAX_AGL_M,
  MIN_AGL_M,
  PATH_CYCLE_SECONDS,
  PATH_DT,
  benchPose,
} from '../../src/bench/path.ts'

/** A ridge and a valley, so the above-ground check is not trivially satisfied by a plane. */
const hilly = (x: number, z: number): number => 120 + 60 * Math.sin(x / 90) * Math.cos(z / 70)

describe('benchPose', () => {
  it('is deterministic', () => {
    for (const t of [0, 1, 7.5, 39.9]) {
      expect(benchPose(t, hilly)).toEqual(benchPose(t, hilly))
    }
  })

  it('stays inside the domain with a margin', () => {
    for (let i = 0; i < 2000; i++) {
      const p = benchPose(i * 0.02, hilly)
      expect(p.x).toBeGreaterThan(50)
      expect(p.x).toBeLessThan(DOMAIN_SIZE_M - 50)
      expect(p.z).toBeGreaterThan(50)
      expect(p.z).toBeLessThan(DOMAIN_SIZE_M - 50)
    }
  })

  it('holds height above ground, never absolute altitude', () => {
    for (let i = 0; i < 2000; i++) {
      const p = benchPose(i * 0.02, hilly)
      const agl = p.y - hilly(p.x, p.z)
      expect(agl).toBeGreaterThanOrEqual(MIN_AGL_M - 1e-9)
      expect(agl).toBeLessThanOrEqual(MAX_AGL_M + 1e-9)
    }
  })

  it('visits both ends of the altitude sweep', () => {
    let low = false
    let high = false
    for (let i = 0; i < 2400; i++) {
      const a = benchPose(i * PATH_DT, hilly).altitudeFraction
      if (a < 0.02) low = true
      if (a > 0.98) high = true
    }
    expect(low).toBe(true)
    expect(high).toBe(true)
  })

  it('is continuous across the cycle wrap', () => {
    const end = benchPose(PATH_CYCLE_SECONDS - 1e-6, hilly)
    const start = benchPose(0, hilly)
    expect(end.x).toBeCloseTo(start.x, 3)
    expect(end.z).toBeCloseTo(start.z, 3)
    expect(end.y).toBeCloseTo(start.y, 3)
    expect(end.altitudeFraction).toBeCloseTo(start.altitudeFraction, 6)
    // Yaw wraps through an integer number of revolutions, so the delta is a whole 2π.
    const dYaw = ((end.yaw as number) - (start.yaw as number)) / (2 * Math.PI)
    expect(Math.abs(dYaw - Math.round(dYaw))).toBeLessThan(1e-5)
  })

  it('handles negative and multi-cycle times identically to the first cycle', () => {
    const a = benchPose(3.25, hilly)
    const b = benchPose(3.25 + 3 * PATH_CYCLE_SECONDS, hilly)
    const c = benchPose(3.25 - 2 * PATH_CYCLE_SECONDS, hilly)
    expect(b.x).toBeCloseTo(a.x, 6)
    expect(c.x).toBeCloseTo(a.x, 6)
    expect(b.altitudeFraction).toBeCloseTo(a.altitudeFraction, 6)
  })

  it('produces the same pose sequence regardless of how long each frame took', () => {
    // This is the property the whole sweep rests on: the driver indexes the path by frame
    // number times a FIXED dt, so a 30 fps level and a 120 fps level render identical poses.
    const seq = (n: number): number[] =>
      Array.from({ length: n }, (_, i) => benchPose(i * PATH_DT, hilly).x)
    expect(seq(50)).toEqual(seq(120).slice(0, 50))
  })
})
