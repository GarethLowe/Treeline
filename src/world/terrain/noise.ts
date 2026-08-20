/**
 * Deterministic procedural noise — written from scratch, no dependencies.
 *
 * 2D gradient (Perlin) noise on an integer lattice with hashed gradients, plus the two
 * fractal stacks the terrain uses: ordinary fBm for rolling ground, and Musgrave's ridged
 * multifractal for the sharp crest-and-gully structure that reads as mountains.
 *
 * Everything is pure and stateless: `perlin2(x, z, seed)` depends only on its arguments,
 * so any evaluation order — grid scan, droplet walk, unit test — gives the same field.
 */

import { hash3 } from './rng.ts'

// ---------------------------------------------------------------------------
// Lattice gradients
// ---------------------------------------------------------------------------

const GRAD_COUNT = 256
const GRAD_MASK = GRAD_COUNT - 1
const GRAD_X = new Float64Array(GRAD_COUNT)
const GRAD_Z = new Float64Array(GRAD_COUNT)
for (let i = 0; i < GRAD_COUNT; i++) {
  // Offset by half a step so no gradient lands exactly on an axis; axis-aligned gradients
  // are what produce the visible grid-cross artefact in naive Perlin implementations.
  const a = (2 * Math.PI * (i + 0.5)) / GRAD_COUNT
  GRAD_X[i] = Math.cos(a)
  GRAD_Z[i] = Math.sin(a)
}

/** Quintic fade, 6t^5 - 15t^4 + 10t^3. C2 continuous, so the field has no visible seams. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function dotGrad(ix: number, iz: number, dx: number, dz: number, seed: number): number {
  const g = hash3(ix, iz, seed) & GRAD_MASK
  return (GRAD_X[g] as number) * dx + (GRAD_Z[g] as number) * dz
}

/**
 * 2D gradient noise. Raw Perlin peaks at +/- sqrt(2)/2, so the result is scaled to land in
 * roughly [-1, 1] — worth doing once here rather than carrying an unexplained 0.707 through
 * every amplitude in the terrain code.
 */
const PERLIN_NORM = Math.SQRT2

export function perlin2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const u = fade(fx)
  const v = fade(fz)

  const n00 = dotGrad(ix, iz, fx, fz, seed)
  const n10 = dotGrad(ix + 1, iz, fx - 1, fz, seed)
  const n01 = dotGrad(ix, iz + 1, fx, fz - 1, seed)
  const n11 = dotGrad(ix + 1, iz + 1, fx - 1, fz - 1, seed)

  const a = n00 + u * (n10 - n00)
  const b = n01 + u * (n11 - n01)
  return (a + v * (b - a)) * PERLIN_NORM
}

// ---------------------------------------------------------------------------
// Fractal stacks
// ---------------------------------------------------------------------------

export interface FbmConfig {
  readonly octaves: number
  readonly lacunarity: number
  readonly gain: number
}

export const DEFAULT_FBM: FbmConfig = { octaves: 8, lacunarity: 2.0, gain: 0.5 }

/**
 * Fractional Brownian motion. Amplitude-normalised, so the result stays in roughly
 * [-1, 1] regardless of octave count and a change to `octaves` alters detail, not scale.
 */
export function fbm2(x: number, z: number, seed: number, cfg: FbmConfig = DEFAULT_FBM): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let fx = x
  let fz = z
  for (let o = 0; o < cfg.octaves; o++) {
    sum += amp * perlin2(fx, fz, (seed + o * 0x9e37) | 0)
    norm += amp
    amp *= cfg.gain
    fx *= cfg.lacunarity
    fz *= cfg.lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Ridged multifractal (Musgrave 1998, *Texturing & Modeling* ch. 16), in the usual
 * `1 - |noise|` squared form with the successive-octave weighting that concentrates detail
 * on the ridges and leaves the valley floors smooth. Returns roughly [0, 1] with crests at 1.
 *
 * `sharpness` is Musgrave's octave weight gain: higher values make the crests narrower.
 */
export function ridged2(
  x: number,
  z: number,
  seed: number,
  cfg: FbmConfig = DEFAULT_FBM,
  sharpness = 1.6,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let weight = 1
  let fx = x
  let fz = z
  for (let o = 0; o < cfg.octaves; o++) {
    let signal = 1 - Math.abs(perlin2(fx, fz, (seed + o * 0x9e37) | 0))
    signal *= signal
    signal *= weight
    weight = signal * sharpness
    if (weight > 1) weight = 1
    else if (weight < 0) weight = 0
    sum += amp * signal
    norm += amp
    amp *= cfg.gain
    fx *= cfg.lacunarity
    fz *= cfg.lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Domain warp: displace the sample point by a vector-valued fBm before evaluating the base
 * field. This is what turns the isotropic blobs of plain fBm into the sheared, folded,
 * anastomosing ridge structure real orogeny produces. Two decorrelated fBm channels, offset
 * far enough apart in lattice space that they do not share lattice cells.
 */
export function warp2(
  x: number,
  z: number,
  seed: number,
  strength: number,
  cfg: FbmConfig,
  out: { x: number; z: number },
): void {
  const wx = fbm2(x, z, (seed ^ 0x1b873593) | 0, cfg)
  const wz = fbm2(x + 137.13, z - 91.77, (seed ^ 0x6f4a7c15) | 0, cfg)
  out.x = x + strength * wx
  out.z = z + strength * wz
}
