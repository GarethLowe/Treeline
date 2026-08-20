/**
 * The deterministic camera path — work package 3.7.
 *
 * A benchmark is only comparable if every run draws the same thing. Two properties matter
 * and both are here rather than in the driver, so they can be tested without a GPU:
 *
 * 1. **The path is a pure function of a virtual clock**, not of wall time. The driver
 *    advances that clock by a FIXED {@link PATH_DT} per rendered frame, so a quality level
 *    that runs at 30 fps renders exactly the same poses in the same order as one that runs
 *    at 120 fps. Driving it from wall time would make a slow level cover more of the path
 *    than a fast one, and the levels would not be comparable — which is the whole point of
 *    the sweep.
 * 2. **One cycle covers the work that actually costs.** Ground level inside the canopy is
 *    where foliage overdraw and grass density hurt; 180 m up is where the instance count in
 *    the frustum peaks. The path alternates between them twice per cycle and turns through
 *    three full revolutions, so no single azimuth or altitude dominates the sample.
 *
 * Pure module. No DOM, no GPU.
 */

import type { Radians } from '@contracts/units.ts'
import { rad } from '@contracts/units.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'

/** Virtual seconds per rendered frame. Fixed, so the pose sequence is frame-rate invariant. */
export const PATH_DT = 1 / 60

/** Seconds of virtual time for one full circuit. */
export const PATH_CYCLE_SECONDS = 40

/** Horizontal excursion from the domain centre. Keeps the path clear of the edges. */
const RADIUS_M = 0.38 * DOMAIN_SIZE_M

/** Eye height above ground at the low point — inside the canopy, worst case for foliage. */
export const MIN_AGL_M = 2

/** Eye height above ground at the high point — most instances in frustum. */
export const MAX_AGL_M = 180

export interface BenchPose {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: Radians
  readonly pitch: Radians
  /** 0 at ground level, 1 at maximum altitude. Recorded so a sample can be attributed. */
  readonly altitudeFraction: number
}

/**
 * Pose at virtual time `t` seconds.
 *
 * `groundY` is the terrain height query; the path holds a height *above ground*, because
 * holding an absolute altitude would bury the camera in a hill on hilly seeds and the
 * ground-level segment would silently stop measuring what it is there to measure.
 */
export function benchPose(t: number, groundY: (x: number, z: number) => number): BenchPose {
  const u = ((t % PATH_CYCLE_SECONDS) + PATH_CYCLE_SECONDS) % PATH_CYCLE_SECONDS / PATH_CYCLE_SECONDS
  const c = DOMAIN_SIZE_M / 2

  // Lissajous 1:2. Closed, so pose(0) === pose(PATH_CYCLE_SECONDS) and repeat cycles are
  // continuous — a jump would show up as a one-frame spike in every level's p95.
  const x = c + RADIUS_M * Math.sin(2 * Math.PI * u)
  const z = c + RADIUS_M * Math.sin(4 * Math.PI * u + Math.PI / 4)

  // Two altitude sweeps per cycle, starting and ending on the ground.
  const a = 0.5 - 0.5 * Math.cos(4 * Math.PI * u)
  const y = groundY(x, z) + MIN_AGL_M + (MAX_AGL_M - MIN_AGL_M) * a

  // Three revolutions per cycle: an integer, so yaw is also continuous across the wrap.
  const yaw = 2 * Math.PI * 3 * u
  // Look down as it climbs. At 180 m a level camera sees mostly sky, which is free.
  const pitch = -0.55 * a

  return { x, y, z, yaw: rad(yaw), pitch: rad(pitch), altitudeFraction: a }
}
