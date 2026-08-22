/**
 * The culling and LOD mathematics, in TypeScript.
 *
 * This file is the **normative reference** for what the cull compute shader does. The WGSL
 * in `shaders/foliage/cull.wgsl` is a transliteration of these functions, and
 * `cullOracle.ts` composes them into a whole-pass simulation the GPU output is compared
 * against. Keeping the arithmetic here rather than only in WGSL is what makes any of this
 * testable without a device — and a cull bug is otherwise invisible, because a frustum sign
 * error produces an empty world with no error message at all.
 *
 * CONVENTIONS (see also math/mat4.ts):
 *   - Column-major matrices, `clip = M * vec4(p, 1)`.
 *   - WebGPU clip space: x,y in [-w, w], z in [0, w].
 *   - A plane is `(nx, ny, nz, d)` with `dot(n, p) + d >= 0` meaning INSIDE. Normals point
 *     into the frustum and are unit length after extraction.
 */

/** Plane order in the packed array. Matches `FrameUniform.frustum` in layout.ts. */
export const PLANE_LEFT = 0
export const PLANE_RIGHT = 1
export const PLANE_BOTTOM = 2
export const PLANE_TOP = 3
export const PLANE_NEAR = 4
export const PLANE_FAR = 5
export const PLANE_COUNT = 6
export const PLANE_FLOATS = PLANE_COUNT * 4

// Plane extraction lives in `camera/math.ts` and is re-exported here so the cull path and the
// camera rig cannot disagree.
//
// This file used to carry its own copy. Same derivation, same packed layout — but it hard-coded
// the NON-reversed-Z near/far assignment (`near = row2`, `far = row3 - row2`) while the renderer
// ships `REVERSED_Z = true`. Under reversed-Z those two planes are swapped, so the foliage
// culler's near and far planes were inverted and neither rejected anything: trees behind the
// camera were being submitted. Side planes were correct, which is why it looked fine.
export { extractFrustumPlanes } from '../../camera/math.ts'

/** Signed distance from a point to plane `i`. Positive is inside. */
export function planeDistance(
  planes: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
): number {
  return planes[i * 4]! * x + planes[i * 4 + 1]! * y + planes[i * 4 + 2]! * z + planes[i * 4 + 3]!
}

/**
 * Conservative sphere-frustum test. A sphere is rejected only if it is entirely outside a
 * single plane, so it over-accepts near the edges — which is the correct direction to err:
 * a false accept costs a few wasted vertices, a false reject deletes a tree.
 */
export function sphereInFrustum(
  planes: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): boolean {
  for (let i = 0; i < PLANE_COUNT; i++) {
    if (planeDistance(planes, i, cx, cy, cz) < -radius) return false
  }
  return true
}

/**
 * Pixels of screen height per metre of world height, at one metre of view distance.
 *
 * `viewportHeightPx * resolutionScale / (2 * tan(fov/2))`. Precomputed on the CPU so the
 * shader's projected-height calculation is a single divide, and so that LOD distances move
 * correctly when the quality controller changes `resolutionScale` — a half-resolution frame
 * genuinely should take coarser LODs at the same distance.
 */
export function pixelsPerMetreAtUnitDepth(
  viewportHeightPx: number,
  resolutionScale: number,
  verticalFovRad: number,
): number {
  const t = Math.tan(verticalFovRad / 2)
  if (!(t > 0) || !Number.isFinite(t)) return 0
  return (viewportHeightPx * resolutionScale) / (2 * t)
}

/** Projected screen height in pixels of a `heightM`-tall object at `distanceM`. */
export function projectedHeightPx(
  heightM: number,
  distanceM: number,
  pixelsPerMetre: number,
): number {
  // Clamp rather than divide by zero: an instance the camera is standing inside should take
  // LOD 0, not produce Infinity and then NaN through the fade weights.
  const d = Math.max(distanceM, 1e-3)
  return (heightM * pixelsPerMetre) / d
}

/**
 * LOD index for a projected height, against thresholds in DESCENDING pixel order.
 * `lod = count of thresholds the object is smaller than`, clamped to the chain length.
 */
export function selectLod(heightPx: number, thresholdsPx: readonly number[]): number {
  let lod = 0
  for (let i = 0; i < thresholdsPx.length; i++) {
    if (heightPx < thresholdsPx[i]!) lod = i + 1
    else break
  }
  return lod
}

export interface LodRecord {
  readonly lod: number
  /** Dither weight in [0,1]. Weights of the records for one instance sum to 1. */
  readonly weight: number
}

/**
 * LOD selection with cross-fade.
 *
 * Inside a window of relative width `fadeFraction` centred on a threshold, the instance is
 * emitted into BOTH adjacent LOD buckets with complementary weights, and the fragment shader
 * dithers against that weight. Two draws of the same tree for a few metres of camera travel
 * is much cheaper than the pop it removes, and unlike a geometric blend it needs no sorting.
 *
 * Returns 1 or 2 records, finer LOD first.
 */
export function selectLodWithFade(
  heightPx: number,
  thresholdsPx: readonly number[],
  fadeFraction: number,
): LodRecord[] {
  const lod = selectLod(heightPx, thresholdsPx)
  if (fadeFraction <= 0) return [{ lod, weight: 1 }]

  // The boundary this instance might be straddling is the one between `lod-1`/`lod`
  // (instance just crossed into the coarser side) or `lod`/`lod+1`.
  for (const boundary of [lod - 1, lod]) {
    if (boundary < 0 || boundary >= thresholdsPx.length) continue
    const t = thresholdsPx[boundary]!
    const halfWidth = (t * fadeFraction) / 2
    if (halfWidth <= 0) continue
    if (heightPx > t - halfWidth && heightPx < t + halfWidth) {
      // w = 1 at the top of the window (fully the finer LOD), 0 at the bottom.
      const w = (heightPx - (t - halfWidth)) / (2 * halfWidth)
      const fine = Math.min(Math.max(w, 0), 1)
      if (fine >= 1) return [{ lod: boundary, weight: 1 }]
      if (fine <= 0) return [{ lod: boundary + 1, weight: 1 }]
      return [
        { lod: boundary, weight: fine },
        { lod: boundary + 1, weight: 1 - fine },
      ]
    }
  }
  return [{ lod, weight: 1 }]
}

/**
 * Bucket index for a (mesh, LOD) pair. One indirect draw is issued per bucket, so this
 * ordering is also the draw order and must agree exactly with the WGSL.
 */
export function bucketIndex(meshId: number, lod: number, lodCount: number): number {
  return meshId * lodCount + lod
}
