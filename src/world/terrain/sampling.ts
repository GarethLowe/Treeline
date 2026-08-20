/**
 * Texture packing, and the CPU mirror of the GPU sampling rule.
 *
 * The acceptance criterion for this package is "CPU query matches GPU texture within
 * tolerance". That is only meaningful if there is one *stated* sampling rule which both
 * sides implement, so the rule lives here in prose and in TypeScript, and
 * `shaders/terrain/terrain_sample.wgsl` is a line-by-line transcription of the same thing.
 *
 * ## The rule
 *
 * 1. Texel `(i, j)` is the node at world `((i + 0.5) * cell, (j + 0.5) * cell)`.
 * 2. `f = worldCoord / cell - 0.5`, clamped to `[0, n-1]`; `i0 = min(floor(f), n-2)`;
 *    `t = f - i0`. This is exactly what a `clamp-to-edge` + `linear` sampler computes.
 * 3. **Height** is the bilinear blend of the four `r32float` texels.
 * 4. **Slope and aspect** are NOT blended as stored. Each of the four `rg16float` texels is
 *    first converted back to a gradient vector, the four *vectors* are blended, and slope
 *    and aspect are recomputed from the result.
 *
 * Step 4 is the whole reason this file exists. Aspect is an angle on a circle: bilinearly
 * blending 0.02 rad with 6.27 rad gives ~3.1 rad, which points due south when the true
 * answer is due north. That failure is invisible in a screenshot and lethal to any
 * slope-aspect-driven quantity — it would put a whole band of the domain's solar load and
 * slope-driven spread direction backwards along the seam. Blending the vector has no seam.
 *
 * Hardware `linear` filtering would also be usable for the height channel (the device has
 * `float32-filterable`), but it quantises the interpolation weights to a few subtexel bits,
 * so the manual `textureLoad` path is what the physics uses and what agreement is measured
 * against. The sampler path stays available for rendering, where a millimetre does not
 * matter.
 */

import { azimuthOf } from './conventions.ts'
import type { Heightfield } from './heightfield.ts'
import { f16ToF32, f32ToF16 } from './halfFloat.ts'

/**
 * Texture rows must be a multiple of 256 bytes for `copyTextureToBuffer`; both textures are
 * 4 bytes per texel, so the grid side must be a multiple of 64.
 */
export const TEXTURE_ROW_ALIGN_TEXELS = 64

export interface TerrainTexels {
  readonly n: number
  readonly cellM: number
  /** `r32float`, `n*n`. */
  readonly height: Float32Array
  /** `rg16float`, `n*n*2`: [slopeTangent, aspectRadians] per texel. */
  readonly slopeAspect: Uint16Array
}

/** Pack the heightfield's nodes into the two texture payloads. */
export function packTerrainTexels(field: Heightfield): TerrainTexels {
  const { n, cellM } = field
  if (n % TEXTURE_ROW_ALIGN_TEXELS !== 0) {
    throw new RangeError(
      `terrain grid must be a multiple of ${TEXTURE_ROW_ALIGN_TEXELS} for 256-byte row alignment, got ${n}`,
    )
  }
  const height = Float32Array.from(field.height)
  const slopeAspect = new Uint16Array(n * n * 2)
  for (let k = 0; k < n * n; k++) {
    const [slope, aspect] = field.nodeSlopeAspect(k)
    slopeAspect[2 * k] = f32ToF16(slope)
    slopeAspect[2 * k + 1] = f32ToF16(aspect)
  }
  return { n, cellM, height, slopeAspect }
}

/** Fractional texel coordinate and the clamped base index, per the rule above. */
function locate(world: number, cellM: number, n: number): { i0: number; t: number } {
  let f = world / cellM - 0.5
  if (!(f > 0)) f = 0 // also catches NaN
  else if (f > n - 1) f = n - 1
  const i0 = f >= n - 1 ? n - 2 : Math.floor(f)
  return { i0, t: f - i0 }
}

export interface TexelSample {
  readonly height: number
  readonly slopeTan: number
  readonly aspect: number
  readonly normal: readonly [number, number, number]
}

/**
 * Sample the packed texels at a world position, exactly as `terrain_sample.wgsl` does.
 *
 * This is the oracle for the GPU: if the GPU disagrees with *this*, the shader is wrong; if
 * this disagrees with `Heightfield`, the packing is wrong. Separating the two failures is
 * the point of having it.
 */
export function sampleTexels(tex: TerrainTexels, x: number, z: number): TexelSample {
  const { n, cellM, height, slopeAspect } = tex
  const cx = locate(x, cellM, n)
  const cz = locate(z, cellM, n)
  const a = cz.i0 * n + cx.i0
  const b = a + n
  const tx = cx.t
  const tz = cz.t

  const h00 = height[a] as number
  const h10 = height[a + 1] as number
  const h01 = height[b] as number
  const h11 = height[b + 1] as number
  const top = h00 + tx * (h10 - h00)
  const bot = h01 + tx * (h11 - h01)
  const hOut = top + tz * (bot - top)

  // Reconstruct the four gradient vectors, then blend the vectors.
  let gx0 = 0
  let gz0 = 0
  let gx1 = 0
  let gz1 = 0
  {
    const g00 = decodeGradient(slopeAspect, a)
    const g10 = decodeGradient(slopeAspect, a + 1)
    const g01 = decodeGradient(slopeAspect, b)
    const g11 = decodeGradient(slopeAspect, b + 1)
    gx0 = g00.x + tx * (g10.x - g00.x)
    gz0 = g00.z + tx * (g10.z - g00.z)
    gx1 = g01.x + tx * (g11.x - g01.x)
    gz1 = g01.z + tx * (g11.z - g01.z)
  }
  const gx = gx0 + tz * (gx1 - gx0)
  const gz = gz0 + tz * (gz1 - gz0)

  const slopeTan = Math.hypot(gx, gz)
  const aspect = gx === 0 && gz === 0 ? 0 : azimuthOf(-gx, -gz)
  const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1)
  return { height: hOut, slopeTan, aspect, normal: [-gx * inv, inv, -gz * inv] }
}

/**
 * `(slope, aspect) -> (dh/dx, dh/dz)`.
 *
 * Aspect is the DOWNSLOPE azimuth, so the downslope direction is `(sin a, -cos a)` and the
 * gradient — which points uphill — is `-slope` times that.
 */
function decodeGradient(slopeAspect: Uint16Array, texel: number): { x: number; z: number } {
  const slope = f16ToF32(slopeAspect[2 * texel] as number)
  const aspect = f16ToF32(slopeAspect[2 * texel + 1] as number)
  return { x: -slope * Math.sin(aspect), z: slope * Math.cos(aspect) }
}

/** Signed smallest difference between two azimuths, in `(-pi, pi]`. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  else if (d <= -Math.PI) d += 2 * Math.PI
  return d
}
