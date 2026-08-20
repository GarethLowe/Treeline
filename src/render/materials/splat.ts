/**
 * Terrain splatting by slope, aspect and biome. WP 1.6.
 *
 * Four ground materials are blended per texel. Which four comes from the biome
 * (`BiomeParams.groundMaterials`, in the fixed slot order declared in `library.ts`); how much
 * of each comes from the terrain, and only from the terrain — there is no authored splat map
 * anywhere in this project, because a hand-painted one would drift out of agreement with the
 * heightfield the moment the seed changes.
 *
 * The three rules, which are geomorphology rather than art direction:
 *
 *  - **Steep ground is bare.** Soil and litter cannot rest above the angle of repose, so rock
 *    exposure is a function of slope alone. Nothing else moves it.
 *  - **Litter collects in drainages and washes off slopes.** Litter follows flow accumulation
 *    (which WP 1.2's terrain provides) and is suppressed by gradient.
 *  - **Equator-facing aspects are drier.** Direct-beam load on a slope is what makes a
 *    south-facing hillside in the northern hemisphere carry different ground cover from the
 *    north-facing one across the same draw. At M5 the SAME aspect term drives fuel moisture,
 *    which is why the picture and the physics will agree without being made to.
 *
 * ## Normalisation
 *
 * The weights sum to exactly 1 by construction, not by a final divide-by-sum that could
 * divide by zero. `rock` takes its share off the top; the remaining `1 - rock` is divided
 * among the other three in proportion to affinities whose sum has a hard positive floor. A
 * splat that does not sum to 1 darkens or brightens the terrain in bands, which reads as a
 * lighting bug and gets chased for a day.
 *
 * This module is a pure function, mirrored exactly by `shaders/materials/splat.wgsl`. That is
 * the point: the CPU version is unit-testable and is the oracle for the shader.
 */

import { clamp01, smoothstep } from './noise.ts'
import { GROUND_SLOT_COUNT } from './library.ts'

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Slope thresholds, stored as TANGENTS because that is what `ITerrainField.slopeAt` returns
 * and what the spread model consumes (spec §0.6 rule 4). Converting to degrees to compare and
 * back is the sort of thing that silently introduces a radians/degrees error.
 */
export const SPLAT_SLOPE = {
  /** Below this, rock is fully covered. tan 25 degrees. */
  rockOnset: Math.tan((25 * Math.PI) / 180),
  /** Above this, ground cover is gone. tan 45 degrees — the usual angle of repose for soil. */
  rockFull: Math.tan((45 * Math.PI) / 180),
  /** Litter starts to shed. tan 15 degrees. */
  litterShedStart: Math.tan((15 * Math.PI) / 180),
  /** Litter is gone. tan 35 degrees. */
  litterShedEnd: Math.tan((35 * Math.PI) / 180),
  /** Where slope alone starts drying ground out (drainage is faster). tan 10 degrees. */
  dryStart: Math.tan((10 * Math.PI) / 180),
  /** Fully drained. tan 30 degrees. */
  dryEnd: Math.tan((30 * Math.PI) / 180),
} as const

// ---------------------------------------------------------------------------
// Aspect
// ---------------------------------------------------------------------------

/**
 * Solar exposure of a slope from its aspect, 0 (pole-facing, shaded) to 1 (equator-facing).
 *
 * Aspect is the DOWNSLOPE azimuth in radians clockwise from north (contract `ITerrainField`).
 * In the northern hemisphere a downslope azimuth of pi points south, so the slope face points
 * south and receives the most beam. `(1 - cos a) / 2` maps that to 1 with a cosine falloff
 * either side, which is the correct first-order shape: beam load on a tilted plane goes as
 * the cosine of the incidence angle, and the azimuth term enters through that cosine.
 *
 * In the southern hemisphere the sun is to the north, so it flips. Latitude 0 is treated as
 * northern; at the equator the term is nearly meaningless anyway (the sun crosses both ways
 * across the year), and the alternative — a discontinuity at the equator — would be worse.
 */
export function slopeExposure(aspectRad: number, latitudeDeg: number): number {
  const north = latitudeDeg >= 0
  const e = (1 - Math.cos(aspectRad)) * 0.5
  return north ? e : 1 - e
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export interface SplatInput {
  /** Slope as a tangent. Same quantity `ITerrainField.slopeAt` returns. */
  readonly slopeTangent: number
  /** Downslope azimuth, radians clockwise from north. */
  readonly aspectRad: number
  /**
   * Normalised flow accumulation, 0 (ridge) to 1 (valley floor). WP 1.2 carves drainages, so
   * this is available; where it is not yet wired, 0.5 is the neutral value and the splat
   * degrades to slope-and-aspect only rather than to something wrong.
   */
  readonly drainage: number
  /** Site latitude, degrees. Sets which way "equator-facing" points. */
  readonly latitudeDeg: number
}

/** Weights per ground slot, in `GROUND_SLOT` order. Sums to 1. */
export type SplatWeights = readonly [number, number, number, number]

/**
 * Ground cover weights for one point.
 *
 * Pure, branchless-friendly, and mirrored in WGSL. Every clamp here exists because the inputs
 * come from a texture fetch that can be a hair outside its nominal range after filtering.
 */
export function splatWeights(input: SplatInput): SplatWeights {
  const slope = Math.max(0, input.slopeTangent)
  const drainage = clamp01(input.drainage)
  const exposure = clamp01(slopeExposure(input.aspectRad, input.latitudeDeg))

  // Rock takes its share off the top. Slope, and nothing else.
  const rock = smoothstep(SPLAT_SLOPE.rockOnset, SPLAT_SLOPE.rockFull, slope)
  const rest = 1 - rock

  // Litter: accumulates where water collects, sheds where the ground tips, and decays a
  // little on the hot aspect where it decomposes and burns off faster.
  const litterAffinity =
    smoothstep(0.15, 0.8, drainage) *
    (1 - smoothstep(SPLAT_SLOPE.litterShedStart, SPLAT_SLOPE.litterShedEnd, slope)) *
    (1 - 0.35 * exposure)

  // Xeric ground: sun-exposed, and better drained the steeper it gets.
  const xericAffinity = exposure * (0.3 + 0.7 * smoothstep(SPLAT_SLOPE.dryStart, SPLAT_SLOPE.dryEnd, slope))

  // Mesic ground is the default. The 0.35 floor is what guarantees a positive denominator,
  // and it is physical: some cover of the mesic type exists everywhere that is not rock.
  const mesicAffinity =
    0.35 + 0.65 * (1 - exposure) * (1 - smoothstep(SPLAT_SLOPE.dryStart, SPLAT_SLOPE.dryEnd, slope))

  const sum = litterAffinity + xericAffinity + mesicAffinity
  const k = rest / sum

  return [mesicAffinity * k, litterAffinity * k, xericAffinity * k, rock]
}

/**
 * Height-aware blend of the splat weights.
 *
 * Straight linear blending of four albedos across a terrain reads as mud: the boundary
 * between gravel and litter becomes a soft 3 m gradient that exists nowhere in nature. The
 * standard fix is to bias the blend by each material's stored height so the taller feature
 * wins locally — pebbles poke through a thin litter layer instead of averaging with it.
 *
 * `heights` are the B channel of the normal array, i.e. height in units of each material's
 * own relief. `sharpness` in texels of transition: 0.02 is a hard, gravelly boundary, 0.2 is
 * a soft one.
 */
export function heightBlend(
  weights: SplatWeights,
  heights: readonly [number, number, number, number],
  sharpness = 0.08,
): SplatWeights {
  let maxBias = -Infinity
  const bias: number[] = []
  for (let i = 0; i < GROUND_SLOT_COUNT; i++) {
    // A zero-weight material must not be able to win on height alone.
    const w = weights[i] as number
    const b = w > 0 ? (heights[i] as number) + w : -Infinity
    bias.push(b)
    if (b > maxBias) maxBias = b
  }
  const eps = Math.max(1e-4, sharpness)
  let sum = 0
  const out: number[] = []
  for (let i = 0; i < GROUND_SLOT_COUNT; i++) {
    const b = bias[i] as number
    const v = b === -Infinity ? 0 : Math.max(0, b - (maxBias - eps)) * (weights[i] as number)
    out.push(v)
    sum += v
  }
  // Degenerate case: every candidate fell outside the epsilon window. Fall back to the
  // unbiased weights rather than emitting zeros, which would render a black terrain.
  if (sum <= 0) return weights
  return [
    (out[0] as number) / sum,
    (out[1] as number) / sum,
    (out[2] as number) / sum,
    (out[3] as number) / sum,
  ]
}
