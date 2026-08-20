/**
 * The terrain surface mesh.
 *
 * NOBODY OWNS THIS. WP 1.2 produces the heightfield and its textures, WP 1.6 produces the
 * splat that shades it, WP 1.5 draws trees and grass *on* it — but no M1 package draws the
 * ground itself, so the composition layer does. That is the correct place for it: it is the
 * one piece of geometry that exists only because two packages need to meet.
 *
 * ## Shape
 *
 * A single indexed grid in world space, warped along both axes so that the inner
 * `INNER_FRACTION` of the vertices covers the 1 km domain and the outer ones stretch to a
 * skirt several kilometres out. Two reasons for the skirt rather than a hard edge at the
 * domain boundary:
 *
 *  1. The far plane is 8 km (WP 1.8 `DEFAULT_RIG_CONFIG`). Without a skirt, the world ends
 *     in a cliff into the void at 1 km and the horizon is the top of that cliff.
 *  2. `terrain_sample()` clamps to edge outside the domain, so the skirt is the domain's
 *     boundary heights extended outward — flat-ish and plausible, and *derived* rather than
 *     authored.
 *
 * ## Why not a clipmap
 *
 * A geometry clipmap would put more vertices near the camera for the same total. It also
 * introduces ring seams, per-level snapping and a per-frame instance table — three new ways
 * for the first integrated frame to be black. A static warped grid has one failure mode
 * (wrong index winding) and it is visible instantly. The vertex cost is fixed and small:
 * 769² ≈ 591 k vertices with a two-texel-fetch vertex shader. If the near-field faceting is
 * ever the limiting factor on the picture, this is the file to replace, and nothing else
 * changes.
 *
 * `gridAxisToWorld` is mirrored *exactly* by `terrainAxisToWorld` in `shaders/app/terrain.wgsl`.
 * `test/app/terrainGrid.test.ts` is the oracle for the shader.
 */

/** Fraction of each grid axis spent inside the domain. */
export const INNER_FRACTION = 0.75

/** How far the skirt reaches beyond the domain edge, in half-domains. */
export const SKIRT_REACH = 5

/** Quads per axis. 768 puts the inner cell at ~1.8 m against a 1 m heightfield. */
export const DEFAULT_GRID_QUADS = 768

/**
 * Map a normalised grid coordinate to a world coordinate.
 *
 * `t = 0` and `t = 1` are the outer skirt corners; `t = 0.5` is the domain centre. The inner
 * region is linear so the domain is sampled uniformly; the outer region is quadratic so the
 * skirt reaches far with few vertices and its first ring still matches the inner cell size
 * closely enough that the seam is not a visible density jump.
 */
export function gridAxisToWorld(t: number, domainM: number): number {
  const s = t * 2 - 1
  const a = Math.abs(s)
  const half = domainM * 0.5
  let r: number
  if (a <= INNER_FRACTION) {
    r = a / INNER_FRACTION
  } else {
    const u = (a - INNER_FRACTION) / (1 - INNER_FRACTION)
    r = 1 + SKIRT_REACH * u * u
  }
  return half + half * Math.sign(s) * r
}

/** Extent of the drawn surface, metres, for the near/far sanity check. */
export function skirtExtentM(domainM: number): number {
  return domainM * 0.5 * (1 + SKIRT_REACH)
}

/** Ground-cell size at the centre of the domain, metres. Reported in the HUD. */
export function innerCellM(quads: number, domainM: number): number {
  const step = 1 / quads
  return gridAxisToWorld(0.5 + step, domainM) - gridAxisToWorld(0.5, domainM)
}

export interface TerrainGridGeometry {
  readonly quads: number
  readonly vertsPerAxis: number
  readonly vertexCount: number
  readonly indices: Uint32Array
}

/**
 * Build the index buffer. There is no vertex buffer: the vertex shader derives its position
 * from `@builtin(vertex_index)`, which keeps 591 k vertices' worth of XZ off the bus and out
 * of VRAM, and means the grid resolution is a single constant rather than a rebuild.
 *
 * Winding is counter-clockwise when viewed from +Y (above), which with the default
 * `frontFace: 'ccw'` and `cullMode: 'back'` shows the surface from above and hides it from
 * below. If the terrain renders as a black hole from a walking camera, this winding is the
 * first thing to check.
 */
export function buildTerrainGrid(quads: number = DEFAULT_GRID_QUADS): TerrainGridGeometry {
  if (!Number.isInteger(quads) || quads < 1) {
    throw new RangeError(`terrain grid quads must be a positive integer, got ${quads}`)
  }
  const v = quads + 1
  const indices = new Uint32Array(quads * quads * 6)
  let o = 0
  for (let j = 0; j < quads; j++) {
    for (let i = 0; i < quads; i++) {
      const a = j * v + i
      const b = a + 1
      const c = a + v
      const d = c + 1
      // World is right-handed Y-up with +X east and +Z south. Looking down -Y, increasing j
      // (world +Z) runs "down the screen", so (a, c, b) is the counter-clockwise winding
      // when viewed from above.
      indices[o++] = a
      indices[o++] = c
      indices[o++] = b
      indices[o++] = b
      indices[o++] = c
      indices[o++] = d
    }
  }
  return { quads, vertsPerAxis: v, vertexCount: v * v, indices }
}

/**
 * Normalised log flow accumulation, for the splat's `drainage` input.
 *
 * WP 1.2 hands back `flowAccumM2` — upslope contributing area per node — as a plain
 * `Float32Array`, not as a texture, because nothing in that package renders. WP 1.6's
 * `splatWeights()` wants a 0..1 drainage scalar. Log-scaling is not cosmetic: contributing
 * area on a 1 km domain spans six orders of magnitude between a hillslope node and a trunk
 * valley, and a linear normalisation puts every node except the main channel at zero.
 *
 * Returns 8-bit texels; 1/255 of a smoothstep input is far below the visible threshold of
 * the resulting blend.
 */
// Uint8Array<ArrayBuffer>, not plain Uint8Array: with lib.dom's GPUAllowSharedBufferSource
// a bare Uint8Array widens to ArrayBufferLike, which includes SharedArrayBuffer and is
// rejected by writeTexture. We allocate it here, so it is always a plain ArrayBuffer.
export function packDrainageTexels(
  flowAccumM2: Float32Array,
  cellAreaM2: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(flowAccumM2.length)
  // One cell of contributing area is the floor (every node drains itself), and the top of
  // the scale is the largest value present, so the mapping adapts to the seed's own relief
  // instead of assuming a channel size.
  const floor = Math.log1p(Math.max(cellAreaM2, 1))
  let peak = floor
  for (let i = 0; i < flowAccumM2.length; i++) {
    const v = Math.log1p(Math.max(0, flowAccumM2[i] as number))
    if (v > peak) peak = v
  }
  const span = Math.max(1e-6, peak - floor)
  for (let i = 0; i < flowAccumM2.length; i++) {
    const v = Math.log1p(Math.max(0, flowAccumM2[i] as number))
    const t = Math.min(1, Math.max(0, (v - floor) / span))
    out[i] = Math.round(t * 255)
  }
  return out
}
