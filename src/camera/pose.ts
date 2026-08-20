/** Shared pose type for the two camera controllers. WP 1.8. */

import type { Vec3 } from './math.ts'

/**
 * A roll-free camera pose. Orientation is (yaw, pitch) rather than a quaternion on
 * purpose: a quaternion can accumulate roll from repeated look deltas, and a tilted
 * horizon in a first-person walker reads as a bug every time.
 */
export interface CameraPose {
  /** Eye position, world metres. */
  readonly position: Vec3
  /** Compass azimuth clockwise from north; north = -Z, east = +X. */
  readonly yaw: number
  /** Elevation above the horizon, clamped to +/- (PI/2 - epsilon). */
  readonly pitch: number
}
