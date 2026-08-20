/**
 * Deterministic, tileable procedural noise. WP 1.6.
 *
 * Every function here is mirrored **exactly** in `shaders/materials/noise.wgsl`. That is the
 * point of the file: the CPU generator is the oracle for the compute-shader generator, so
 * the two must produce bit-comparable structure. Two rules keep them in step:
 *
 *   1. All hashing is integer. `Math.imul` reproduces WGSL's wrapping `u32` multiply exactly;
 *      `>>> 0` reproduces `u32` truncation. Nothing here depends on f64 vs f32 rounding for
 *      its *structure* — floats only carry the interpolation, where a 1e-7 difference is
 *      invisible in an 8-bit texel.
 *   2. All noise is **periodic on an integer lattice**. A material texture that does not tile
 *      seamlessly is useless for terrain and bark, and periodicity is a property of the
 *      lattice indices, so it has to be built in rather than bolted on with a mirror trick.
 *
 * The lattice periods are given separately in u and v. That is not a generalisation for its
 * own sake: bark is strongly anisotropic (fissures run along the trunk), and expressing that
 * as unequal lattice periods gives correct tiling for free, where scaling the input
 * coordinates would break it.
 */

const imul = Math.imul

/**
 * Integer avalanche hash (Wellons' `lowbias32`). Chosen over the usual
 * `fract(sin(dot(...)) * 43758.5453)` because that one has visible structure, is not stable
 * across GPUs (it depends on `sin` precision), and cannot be reproduced on the CPU.
 */
export function hashU32(x: number): number {
  let h = x >>> 0
  h ^= h >>> 16
  h = imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  h = imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** Hash a 2D integer lattice coordinate with a seed. */
export function hash2i(ix: number, iy: number, seed: number): number {
  const a = imul(ix >>> 0, 0x27d4eb2d) >>> 0
  const b = imul(iy >>> 0, 0x165667b1) >>> 0
  const c = imul(seed >>> 0, 0x9e3779b1) >>> 0
  return hashU32((a ^ b ^ c) >>> 0)
}

/** Hash a 2D lattice coordinate to a second independent stream (for a second attribute). */
export function hash2iAlt(ix: number, iy: number, seed: number): number {
  return hashU32((hash2i(ix, iy, seed) ^ 0x85ebca6b) >>> 0)
}

/** u32 -> [0, 1). Uses the top 24 bits, which are the well-mixed ones. */
export function u32ToUnit(h: number): number {
  return (h >>> 8) * (1 / 16777216)
}

/** Positive modulo. `-1 % 8` is `-1` in both JS and WGSL; the lattice needs `7`. */
export function wrapI(i: number, period: number): number {
  const m = i % period
  return m < 0 ? m + period : m
}

/** Quintic smoothstep (Perlin's improved fade). C2 continuous, so normals stay smooth. */
export function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const d = edge1 - edge0
  // A zero-width edge would divide by zero; degrade to a step rather than emit NaN.
  if (Math.abs(d) < 1e-9) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / d)
  return t * t * (3 - 2 * t)
}

/**
 * Value noise on a `px` x `py` lattice over the unit square, seamlessly periodic.
 * `u`, `v` are in [0, 1) (values outside are handled by the lattice wrap).
 * Result in [0, 1].
 */
export function valueNoise2P(u: number, v: number, px: number, py: number, seed: number): number {
  const x = u * px
  const y = v * py
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = fade(x - x0)
  const fy = fade(y - y0)
  const ix0 = wrapI(x0, px)
  const iy0 = wrapI(y0, py)
  const ix1 = wrapI(x0 + 1, px)
  const iy1 = wrapI(y0 + 1, py)
  const n00 = u32ToUnit(hash2i(ix0, iy0, seed))
  const n10 = u32ToUnit(hash2i(ix1, iy0, seed))
  const n01 = u32ToUnit(hash2i(ix0, iy1, seed))
  const n11 = u32ToUnit(hash2i(ix1, iy1, seed))
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fy)
}

/**
 * Fractal Brownian motion over periodic value noise. Lacunarity is fixed at 2 so that each
 * octave's lattice period is an integer multiple of the base — which is what keeps the sum
 * periodic. A non-integer lacunarity would produce a beautiful noise field that does not tile.
 *
 * Returned normalised to [0, 1].
 */
export function fbm2P(
  u: number,
  v: number,
  px: number,
  py: number,
  seed: number,
  octaves: number,
  gain = 0.5,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let sx = px
  let sy = py
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2P(u, v, sx, sy, (seed + imul(i, 131)) >>> 0)
    norm += amp
    amp *= gain
    sx *= 2
    sy *= 2
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Ridged fbm: `1 - |2n - 1|`, raised to a sharpening power. Produces creases rather than
 * blobs, which is what bark fissures and rock fractures actually look like.
 */
export function ridged2P(
  u: number,
  v: number,
  px: number,
  py: number,
  seed: number,
  octaves: number,
  sharpness = 2,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let sx = px
  let sy = py
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2P(u, v, sx, sy, (seed + imul(i, 131)) >>> 0)
    const r = 1 - Math.abs(2 * n - 1)
    sum += amp * Math.pow(r, sharpness)
    norm += amp
    amp *= 0.5
    sx *= 2
    sy *= 2
  }
  return norm > 0 ? sum / norm : 0
}

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  readonly f1: number
  /** Distance to the second nearest. `f2 - f1` is the cell-boundary distance field. */
  readonly f2: number
  /** Hash of the nearest cell — a stable per-cell id for tinting and orientation. */
  readonly cell: number
}

/**
 * Periodic Worley (cellular) noise on a `px` x `py` cell grid over the unit square.
 *
 * `f2 - f1` is the thing this project actually wants: it is ~0 exactly on a cell boundary
 * and grows toward cell interiors, which is a bark furrow, a rock fracture and an alligator
 * char crack all at once. §7.6 specifies the crack field as precisely this (Worley distance
 * plus cell id).
 */
export function worley2P(
  u: number,
  v: number,
  px: number,
  py: number,
  seed: number,
): WorleyResult {
  const x = u * px
  const y = v * py
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  let f1 = 1e9
  let f2 = 1e9
  let cell = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx
      const gy = cy + dy
      const wx = wrapI(gx, px)
      const wy = wrapI(gy, py)
      const h = hash2i(wx, wy, seed)
      const h2 = hash2iAlt(wx, wy, seed)
      // Feature point jittered inside its cell. The 0.1 inset keeps points off the exact
      // boundary, where f2-f1 would otherwise be identically zero along a whole edge.
      const fxp = gx + 0.1 + 0.8 * u32ToUnit(h)
      const fyp = gy + 0.1 + 0.8 * u32ToUnit(h2)
      const ddx = fxp - x
      const ddy = fyp - y
      const d = Math.sqrt(ddx * ddx + ddy * ddy)
      if (d < f1) {
        f2 = f1
        f1 = d
        cell = h
      } else if (d < f2) {
        f2 = d
      }
    }
  }
  return { f1, f2, cell }
}

/**
 * Two-octave domain warp. Displaces the sample point by a low-frequency noise field, which
 * turns regular lattice structure into something organic. Kept periodic by warping with
 * periodic noise and by expressing the offset in unit-square coordinates.
 */
export function warp2P(
  u: number,
  v: number,
  px: number,
  py: number,
  seed: number,
  amount: number,
): readonly [number, number] {
  const wu = valueNoise2P(u, v, px, py, seed) - 0.5
  const wv = valueNoise2P(u, v, px, py, (seed ^ 0x51ed270b) >>> 0) - 0.5
  return [u + (amount * wu) / px, v + (amount * wv) / py]
}

/** Rotate a 2D vector. Used to orient per-cell elements (leaves, litter pieces). */
export function rotate2(x: number, y: number, angle: number): readonly [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [c * x - s * y, s * x + c * y]
}
