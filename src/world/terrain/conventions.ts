/**
 * Terrain conventions — work package 1.2.
 *
 * ## Coordinate frame
 *
 * `src/contracts/` declares `aspectAt()` as "downslope azimuth, radians clockwise from
 * north" and `SolarState.azimuth` the same way, but it never says which world axis points
 * north. That is a gap: an azimuth convention without an axis convention is not a
 * convention. This package therefore fixes one and states it loudly, and the gap is
 * reported to the integrator.
 *
 * **The frame is right-handed, Y-up, geographically oriented:**
 *
 * ```
 *   +x = East        +y = Up        +z = South   (because East x Up = South)
 *   north = -z       west  = -x
 * ```
 *
 * This is the only assignment that is simultaneously right-handed, Y-up (which the
 * `CameraState` matrices in `@contracts/render` assume), and geographically consistent, so
 * a compass azimuth converts to a direction vector with no sign fudge:
 *
 * ```
 *   azimuth a  ->  direction (sin a, -cos a)   in (x, z)
 *   direction (vx, vz)  ->  azimuth atan2(vx, -vz)
 * ```
 *
 * ## Grid layout
 *
 * The heightfield is a square grid of `n x n` **node samples** using the texel-centre
 * convention, so that a `clamp-to-edge` + `linear` GPU sampler fed `uv = worldXZ / domain`
 * reproduces the CPU bilinear query exactly:
 *
 * ```
 *   cell    = domainM / n
 *   node i  is at world coordinate (i + 0.5) * cell
 *   u       = x / domainM         (so u = (i + 0.5) / n at node i)
 * ```
 *
 * Rows of the texture run along +z: texel (i, j) is node (x = i, z = j). Positions in the
 * outer half-cell margin clamp to the edge nodes, exactly as `clamp-to-edge` does.
 *
 * ## Height, slope and aspect are one surface, not three fields
 *
 * `ITerrainField.heightAt` is contractually "bilinear between samples", so the *definition*
 * of the terrain surface is the piecewise-bilinear interpolant of the node heights. The
 * gradient is derived from that same definition rather than measured off the height
 * texture by a shader's finite differences:
 *
 * 1. At each node the gradient is the exact derivative of the bilinear surface, averaged
 *    over the four patches meeting at that node — which is the central difference
 *    `(h[i+1] - h[i-1]) / (x[i+1] - x[i-1])`, one-sided at the domain edge.
 * 2. Between nodes the gradient is the bilinear interpolant of those node gradients.
 *
 * Both CPU queries and the GPU helper in `shaders/terrain/terrain_sample.wgsl` evaluate
 * step 2 on the *gradient vector*, never on the aspect angle, because bilinearly
 * interpolating an angle across the 0 / 2*pi seam at due north produces a garbage aspect
 * pointing south. The slope/aspect texture stores `(tan(slope), aspect)` per the contract;
 * consumers must reconstruct the vector before interpolating. See `terrain_sample.wgsl`.
 */

import { DOMAIN_SIZE_M } from '@contracts/world'

/**
 * Heightfield resolution. 1024 nodes over 1024 m = 1 m spacing.
 *
 * Not 2048 (the surface-solver resolution): there is no terrain information below a few
 * metres — the noise has no content there and hydraulic erosion at 0.5 m would need ~4x
 * the droplets to say the same thing — and the surface solver samples the terrain
 * bilinearly anyway. 1 m keeps generation inside its few-seconds budget and both textures
 * at 4 MiB each.
 */
export const TERRAIN_GRID_N = 1024

/** Node spacing in metres for the default grid. */
export const TERRAIN_CELL_M = DOMAIN_SIZE_M / TERRAIN_GRID_N

/** 8-neighbour offsets, in the order used by every neighbour loop in this package. */
export const NEIGHBOUR_DX = [1, 1, 0, -1, -1, -1, 0, 1] as const
export const NEIGHBOUR_DZ = [0, 1, 1, 1, 0, -1, -1, -1] as const
/** Centre-to-centre distance in cells for each of the 8 neighbours. */
export const NEIGHBOUR_DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2] as const

/** Compass azimuth (clockwise from north) of a horizontal direction in world (x, z). */
export function azimuthOf(vx: number, vz: number): number {
  const a = Math.atan2(vx, -vz)
  return a < 0 ? a + 2 * Math.PI : a
}

/** Unit horizontal direction for a compass azimuth, as world (x, z). */
export function directionOf(azimuth: number): readonly [number, number] {
  return [Math.sin(azimuth), -Math.cos(azimuth)]
}
