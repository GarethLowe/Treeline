/**
 * Heightfield synthesis — the noise stage, before water touches it.
 *
 * The shape budget for a 1 km x 1 km domain: two to four major ridge/valley systems, so
 * that a fire run has real windward and lee aspects to work with rather than a texture of
 * bumps. That fixes the lowest noise wavelength at a few hundred metres.
 *
 * Three things make it read as terrain rather than as noise:
 *
 * 1. **Ridged multifractal, blended in by relief.** Plain fBm is symmetric — its peaks look
 *    like its pits — and real orogenic terrain is not: crests are sharp, valley floors are
 *    broad and smooth. Musgrave's ridged form is asymmetric in exactly that way. At low
 *    relief it is faded out, because rolling downland genuinely is closer to symmetric fBm.
 * 2. **Domain warping.** Displacing the sample point by a vector fBm before evaluating the
 *    base field shears and folds the ridge lines, which is what stops the ridges from
 *    running as parallel isotropic blobs.
 * 3. **Anisotropy along `ridgeBearing`.** The sample frame is rotated to the requested
 *    bearing and compressed along it, so features are ~2.4x longer along the bearing than
 *    across it. This is what makes `ridgeBearing` an actual control rather than decoration:
 *    a test case that needs a north-facing lee slope can ask for one.
 *
 * The field is then rescaled so its robust vertical span (1st to 99th percentile) equals a
 * relief-derived target. Normalising by a *percentile* span rather than min-to-max keeps a
 * single freak peak from silently flattening the rest of the domain, and it makes the
 * relief -> slope relationship a property of the design rather than of the seed.
 */

import { smoothstep } from '../../math.ts'
import type { TerrainParams } from '@contracts/world'
import { directionOf } from './conventions.ts'
import { fbm2, ridged2, warp2, type FbmConfig } from './noise.ts'
import type { Heightfield } from './heightfield.ts'

/**
 * Wavelength of the lowest noise octave, metres. 430 m over a 1024 m domain puts roughly
 * 2.4 primary ridge systems across it.
 */
const BASE_FEATURE_M = 430

/**
 * Along-bearing coordinate compression. Features become 1/0.42 ~ 2.4x longer along
 * `ridgeBearing` than across it — pronounced enough to be measurable in a test, mild enough
 * not to look extruded.
 */
const RIDGE_ANISOTROPY = 0.42

/**
 * `gain: 0.44` rather than the textbook 0.5 is the single most consequential number in this
 * file. An octave's contribution to *slope* is its amplitude divided by its wavelength,
 * which scales as `(gain * lacunarity)^k`. At `gain = 0.5, lacunarity = 2` that product is
 * exactly 1, so **every octave contributes equally to slope** and the mean slope grows
 * without bound as octaves are added — the field is self-similar (Hurst exponent 1) and has
 * no characteristic steepness at all. The visible result is a landscape whose slope
 * statistics are an artefact of the octave count rather than of `relief`.
 *
 * At 0.44 the product is 0.88, the series converges, and the surface has a well-defined
 * roughness (H ~ 1.18), so `relief` controls slope — which is the parameter's whole
 * contract — and detail octaves add detail rather than steepness.
 */
const FBM_GAIN = 0.44
const FBM_LACUNARITY = 2.0
/** Hard ceiling on octaves; the band limit below usually binds first. */
const MAX_OCTAVES = 9
/**
 * Shortest wavelength kept, in node spacings. Below ~3 nodes per wavelength the octave is
 * past Nyquist and aliases: it stops being terrain and becomes grid-dependent hash noise,
 * with slope statistics that shift when the grid resolution changes. Band-limiting costs
 * ~4% of the total slope (the tail of a converging series) and buys slope statistics that
 * are a property of `relief` at any resolution.
 */
const MIN_WAVELENGTH_NODES = 3

/** The warp field is deliberately smooth: high-frequency warp is just noise on noise. */
const WARP_FBM: FbmConfig = { octaves: 4, lacunarity: 2.0, gain: 0.5 }

function mainFbmFor(cellM: number): FbmConfig {
  const wavelengths = BASE_FEATURE_M / Math.max(1e-6, MIN_WAVELENGTH_NODES * cellM)
  const octaves = Math.max(1, Math.min(MAX_OCTAVES, Math.floor(Math.log2(wavelengths)) + 1))
  return { octaves, lacunarity: FBM_LACUNARITY, gain: FBM_GAIN }
}


/**
 * Target vertical span (p01..p99) in metres for a relief setting.
 *
 * Calibrated against the slope statistics it produces, not against how the number reads:
 *
 * Measured on the 1024-node grid at `drainageStrength = 0.7`, seed 12345, after erosion and
 * incision — i.e. the numbers the finished field actually has, not the noise's:
 *
 * | relief | span | median slope | mean | p90 | |
 * |---|---|---|---|---|---|
 * | 0.00 | 6 m | 0.014 (0.8 deg) | 0.015 | 0.03 | Flat control case — the slope term is negligible, which is what a benchmark run wants. |
 * | 0.25 | 35 m | 0.086 (4.9 deg) | 0.10 | 0.17 | Gentle downland. |
 * | 0.50 | 99 m | 0.252 (14 deg) | 0.32 | 0.71 | Rolling hill country. |
 * | 0.75 | 176 m | 0.419 (23 deg) | 0.58 | 1.41 | Steep forested slopes. |
 * | 1.00 | 260 m | 0.691 (35 deg) | 0.95 | 2.31 | Mountainous. The median lands right at the 0.7 clamp Rothermel's slope factor carries (spec §20 §4), so much of the domain is at or past the edge of that model's validated envelope — deliberately, because that is where the interesting runs are, and the clamp is what keeps the answer honest there. |
 *
 * The exponent 1.5 makes the low end change slowly, so the first quarter of the range is
 * usable for gentle country instead of jumping straight to hills.
 */
export function reliefSpanM(relief: number): number {
  const r = Math.min(1, Math.max(0, relief))
  return 6 + 200 * r ** 1.5
}

/** Relief-derived constants plus the rotated sampling frame. Precomputed once per field. */
export interface SynthKernel {
  readonly seed: number
  /** Unit vector along the ridge bearing, world (x, z). */
  readonly alongX: number
  readonly alongZ: number
  /** Unit vector across it. */
  readonly acrossX: number
  readonly acrossZ: number
  readonly invFeature: number
  readonly anisotropy: number
  /** 0 = pure fBm (rolling), 1 = pure ridged multifractal (mountainous). */
  readonly ridgeWeight: number
  readonly sharpness: number
  readonly warpStrength: number
  readonly spanM: number
  /** Band-limited to the node spacing; see `mainFbmFor`. */
  readonly fbm: FbmConfig
}

/**
 * Precompute the relief-derived constants and the rotated sampling frame.
 *
 * `cellM` is the node spacing the field will be evaluated on. It only sets the octave band
 * limit, so a coarser grid produces the same landform with less detail rather than a
 * different landform.
 */
export function makeSynthKernel(params: TerrainParams, seed: number, cellM: number): SynthKernel {
  const relief = Math.min(1, Math.max(0, params.relief))
  const [ax, az] = directionOf(params.ridgeBearing)
  return {
    fbm: mainFbmFor(cellM),
    seed: seed | 0,
    alongX: ax,
    alongZ: az,
    // Rotate the along-bearing vector by +90 degrees in the x/z plane.
    acrossX: -az,
    acrossZ: ax,
    invFeature: 1 / BASE_FEATURE_M,
    anisotropy: RIDGE_ANISOTROPY,
    ridgeWeight: smoothstep(0.1, 0.85, relief),
    sharpness: 1.0 + 1.4 * relief,
    warpStrength: 0.15 + 0.55 * relief,
    spanM: reliefSpanM(relief),
  }
}

const warped = { x: 0, z: 0 }

/**
 * Raw synthesised elevation at a world position, in arbitrary units centred near zero.
 * Pure: depends only on its arguments, so grid order never affects the result.
 */
export function synthAt(x: number, z: number, k: SynthKernel): number {
  // Rotate into the ridge frame and compress along the bearing.
  const u = (x * k.alongX + z * k.alongZ) * k.invFeature * k.anisotropy
  const v = (x * k.acrossX + z * k.acrossZ) * k.invFeature

  warp2(u, v, (k.seed ^ 0x2545f491) | 0, k.warpStrength, WARP_FBM, warped)

  // Ridged term: [0, 1] with crests at 1. Re-centred so the blend does not shift the mean.
  const ridge = (ridged2(warped.x, warped.z, k.seed, k.fbm, k.sharpness) - 0.42) * 2
  // Rolling term: [-1, 1]. Offset in lattice space so it does not share cells with the ridge.
  const rolling = fbm2(warped.x + 11.3, warped.z - 7.1, (k.seed ^ 0x51ed270b) | 0, k.fbm)

  return k.ridgeWeight * ridge + (1 - k.ridgeWeight) * rolling
}

/** Fill every node of the field with raw synthesised elevation. */
export function synthesize(field: Heightfield, k: SynthKernel): void {
  const { n, height } = field
  for (let j = 0; j < n; j++) {
    const z = field.nodeZ(j)
    const row = j * n
    for (let i = 0; i < n; i++) {
      height[row + i] = synthAt(field.nodeX(i), z, k)
    }
  }
}

/**
 * Rescale in place so the p01..p99 span equals `spanM`, then shift so the mean elevation is
 * `baseElevationM`.
 *
 * A degenerate field (constant, which only happens for a pathological seed) is left flat at
 * the base elevation rather than being divided by zero.
 */
export function normaliseToSpan(field: Heightfield, spanM: number, baseElevationM: number): void {
  const { height } = field
  const count = height.length
  const sorted = Float64Array.from(height)
  sorted.sort()
  const p01 = sorted[Math.floor(0.01 * (count - 1))] as number
  const p99 = sorted[Math.floor(0.99 * (count - 1))] as number
  const raw = p99 - p01
  const scale = raw > 1e-12 ? spanM / raw : 0

  let sum = 0
  for (let k = 0; k < count; k++) {
    const v = (height[k] as number) * scale
    height[k] = v
    sum += v
  }
  const shift = baseElevationM - sum / count
  for (let k = 0; k < count; k++) height[k] = (height[k] as number) + shift
}
