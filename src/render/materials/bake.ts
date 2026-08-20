/**
 * CPU material baker. WP 1.6.
 *
 * Two jobs, and it is worth being explicit that they are different:
 *
 *  1. **Oracle.** It evaluates the same `patterns.ts` recipe the WGSL generator evaluates, so
 *     a readback of the GPU-generated array can be compared against it texel for texel. That
 *     is the only way to test a compute-shader generator without eyeballing a screenshot.
 *  2. **Fallback path.** It produces a complete, correct material set with no compute
 *     support at all, uploaded with `queue.writeTexture`. Slow (seconds, single-threaded)
 *     but it is a real path, not a placeholder.
 *
 * ## Where the correctness actually lives
 *
 * **Mip reduction of the albedo array averages in LINEAR space.** Averaging the stored sRGB
 * bytes is wrong, and it is wrong in a direction that reads as a feature: distant foliage
 * comes out too dark, which looks like aerial perspective. The error is largest exactly where
 * a 4x downsample crosses a high-contrast edge — a needle silhouette, i.e. every foliage
 * texel in the mid-distance. Normal, ORM and alpha are linear data and average directly.
 *
 * **Normals are computed by central difference at texel spacing**, not supersampled. Central
 * differencing at the texel scale already band-limits the height field to the texel Nyquist;
 * supersampling the normal on top of that would smooth twice and flatten the relief.
 *
 * **Normal mips average as vectors and renormalise.** Averaging the encoded bytes and not
 * renormalising shortens the vector, which reads as a roughness change with distance rather
 * than as a normal-map bug.
 */

import type { PatternParams } from './patterns.ts'
import {
  type BurnStage,
  CRACK_GRADIENT_SCALE,
  crackField,
  patternHeight,
  samplePattern,
} from './patterns.ts'
import { clamp01 } from './noise.ts'
import { encodeU8, linearToSrgb, srgbU8ToLinearFast, srgbToLinear, linearToSrgbU8 } from './srgb.ts'
import type { MaterialArrayKind } from './arrays.ts'

/**
 * One baked mip level: tightly packed RGBA8, row-major, `size * size * 4` bytes.
 *
 * The `Uint8Array<ArrayBuffer>` type argument is not pedantry: `GPUQueue.writeTexture`
 * rejects a view over a `SharedArrayBuffer`, and an unparameterised `Uint8Array` widens to
 * include one.
 */
export interface BakedLevel {
  readonly size: number
  readonly data: Uint8Array<ArrayBuffer>
}

export interface BakedLayer {
  readonly albedo: readonly BakedLevel[]
  readonly normal: readonly BakedLevel[]
  readonly orm: readonly BakedLevel[]
}

// ---------------------------------------------------------------------------
// Mip 0
// ---------------------------------------------------------------------------

/**
 * Bake mip 0 of one array layer: one material at one burn stage.
 *
 * Returns the three arrays' base levels. `superSamples` is the NxN grid averaged per texel;
 * 1 disables it (used by tests that want to compare a single analytic sample).
 */
export function bakeLayerBase(
  p: PatternParams,
  stage: BurnStage,
  size: number,
  superSamples: number,
): { albedo: BakedLevel; normal: BakedLevel; orm: BakedLevel } {
  const albedo = new Uint8Array(size * size * 4)
  const normal = new Uint8Array(size * size * 4)
  const orm = new Uint8Array(size * size * 4)

  const ss = Math.max(1, Math.floor(superSamples))
  const ssInv = 1 / (ss * ss)
  const texel = 1 / size
  // Central-difference step: one texel in UV, converted to metres for the slope.
  const dUV = texel
  const dM = p.tileSizeM * dUV
  const relief = Math.max(1e-9, p.reliefM)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // --- shade, supersampled, accumulated in LINEAR space ---
      let ar = 0
      let ag = 0
      let ab = 0
      let aa = 0
      let occ = 0
      let rough = 0
      let metal = 0
      let detail = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) * texel
          const v = (y + (sy + 0.5) / ss) * texel
          const s = samplePattern(p, u, v, stage)
          ar += s.albedo[0]
          ag += s.albedo[1]
          ab += s.albedo[2]
          aa += s.alpha
          occ += s.occlusion
          rough += s.roughness
          metal += s.metallic
          detail += s.detail
        }
      }
      ar *= ssInv
      ag *= ssInv
      ab *= ssInv
      aa *= ssInv
      occ *= ssInv
      rough *= ssInv
      metal *= ssInv
      detail *= ssInv

      const i = (y * size + x) * 4
      // RGB sRGB-encoded (the hardware decodes it on sample); ALPHA STAYS LINEAR.
      albedo[i] = linearToSrgbU8(ar)
      albedo[i + 1] = linearToSrgbU8(ag)
      albedo[i + 2] = linearToSrgbU8(ab)
      albedo[i + 3] = encodeU8(aa)

      // --- normal, from central differences on the height field ---
      const u0 = (x + 0.5) * texel
      const v0 = (y + 0.5) * texel
      const hL = patternHeight(p, u0 - dUV, v0, stage)
      const hR = patternHeight(p, u0 + dUV, v0, stage)
      const hD = patternHeight(p, u0, v0 - dUV, stage)
      const hU = patternHeight(p, u0, v0 + dUV, stage)
      const hC = patternHeight(p, u0, v0, stage)
      // Tangent-space normal of z = h(x,y): n = normalize(-dh/dx, -dh/dy, 1).
      const nx = -(hR - hL) / (2 * dM)
      const ny = -(hU - hD) / (2 * dM)
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      normal[i] = encodeU8(clamp01(nx * inv * 0.5 + 0.5))
      normal[i + 1] = encodeU8(clamp01(ny * inv * 0.5 + 0.5))
      // B carries height in units of the material's declared relief, so the shader can
      // recover metres by multiplying by `reliefM` from the material table.
      normal[i + 2] = encodeU8(clamp01(hC / relief))
      normal[i + 3] = 255

      orm[i] = encodeU8(clamp01(occ))
      orm[i + 1] = encodeU8(clamp01(rough))
      orm[i + 2] = encodeU8(clamp01(metal))
      // Burn susceptibility: raised, exposed structure chars first. Reusing `detail` (which
      // is constructed mean-0.5) means the burn front breaks up along the material's own
      // features rather than along an unrelated noise field, which is what stops a charring
      // trunk from looking like it has a decal on it.
      orm[i + 3] = encodeU8(clamp01(detail))
    }
  }

  return {
    albedo: { size, data: albedo },
    normal: { size, data: normal },
    orm: { size, data: orm },
  }
}

// ---------------------------------------------------------------------------
// Mip reduction
// ---------------------------------------------------------------------------

/** How a given array's channels must be averaged. */
export type ReduceMode = 'srgb-rgb-linear-a' | 'normal' | 'linear'

export function reduceModeFor(kind: MaterialArrayKind): ReduceMode {
  switch (kind) {
    case 'albedo':
      return 'srgb-rgb-linear-a'
    case 'normal':
      return 'normal'
    default:
      return 'linear'
  }
}

/**
 * Reduce one level to the next by a 2x2 box filter, in the correct space for the data.
 *
 * The `srgb-rgb-linear-a` case is the one that matters: decode each of the four RGB samples
 * to linear, average, re-encode. Alpha bypasses the transfer function entirely.
 */
export function reduceLevel(level: BakedLevel, mode: ReduceMode): BakedLevel {
  const src = level.data
  const sw = level.size
  const dw = Math.max(1, sw >> 1)
  const dst = new Uint8Array(dw * dw * 4)
  // A 1x1 source cannot be halved; carry it through unchanged.
  if (sw === 1) {
    dst.set(src.subarray(0, 4))
    return { size: 1, data: dst }
  }

  for (let y = 0; y < dw; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4
      const i00 = ((y * 2) * sw + x * 2) * 4
      const i10 = ((y * 2) * sw + x * 2 + 1) * 4
      const i01 = ((y * 2 + 1) * sw + x * 2) * 4
      const i11 = ((y * 2 + 1) * sw + x * 2 + 1) * 4
      const idx = [i00, i10, i01, i11]

      if (mode === 'srgb-rgb-linear-a') {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (const i of idx) {
          r += srgbU8ToLinearFast(src[i] as number)
          g += srgbU8ToLinearFast(src[i + 1] as number)
          b += srgbU8ToLinearFast(src[i + 2] as number)
          a += (src[i + 3] as number) / 255
        }
        dst[o] = encodeU8(linearToSrgb(r * 0.25))
        dst[o + 1] = encodeU8(linearToSrgb(g * 0.25))
        dst[o + 2] = encodeU8(linearToSrgb(b * 0.25))
        dst[o + 3] = encodeU8(a * 0.25)
      } else if (mode === 'normal') {
        let nx = 0
        let ny = 0
        let nz = 0
        let h = 0
        let w = 0
        for (const i of idx) {
          const ex = (src[i] as number) / 255 * 2 - 1
          const ey = (src[i + 1] as number) / 255 * 2 - 1
          const ez = Math.sqrt(Math.max(0, 1 - ex * ex - ey * ey))
          nx += ex
          ny += ey
          nz += ez
          h += (src[i + 2] as number) / 255
          w += (src[i + 3] as number) / 255
        }
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        // A perfectly opposed 2x2 (a knife-edge crease) sums to zero. Emitting a flat normal
        // there is right: at this mip the crease is below the sampling rate.
        const s = len > 1e-6 ? 1 / len : 0
        dst[o] = encodeU8(clamp01((nx * s) * 0.5 + 0.5))
        dst[o + 1] = encodeU8(clamp01((ny * s) * 0.5 + 0.5))
        dst[o + 2] = encodeU8(clamp01(h * 0.25))
        dst[o + 3] = encodeU8(clamp01(w * 0.25))
      } else {
        for (let c = 0; c < 4; c++) {
          let acc = 0
          for (const i of idx) acc += src[i + c] as number
          dst[o + c] = Math.round(acc * 0.25)
        }
      }
    }
  }
  return { size: dw, data: dst }
}

/** Build the full chain from a base level. `levels` counts the base. */
export function buildMipChain(base: BakedLevel, levels: number, mode: ReduceMode): BakedLevel[] {
  const chain: BakedLevel[] = [base]
  let cur = base
  for (let i = 1; i < levels; i++) {
    cur = reduceLevel(cur, mode)
    chain.push(cur)
  }
  return chain
}

/** Bake one complete array layer, all three maps, all mips. */
export function bakeLayer(
  p: PatternParams,
  stage: BurnStage,
  size: number,
  superSamples: number,
  mipLevels: number,
): BakedLayer {
  const base = bakeLayerBase(p, stage, size, superSamples)
  return {
    albedo: buildMipChain(base.albedo, mipLevels, 'srgb-rgb-linear-a'),
    normal: buildMipChain(base.normal, mipLevels, 'normal'),
    orm: buildMipChain(base.orm, mipLevels, 'linear'),
  }
}

// ---------------------------------------------------------------------------
// Crack field
// ---------------------------------------------------------------------------

/**
 * The one shared alligator-crack field (§7.6), mirroring `shaders/materials/crack.wgsl`.
 *
 * R = normalised Worley boundary distance D, G = cell id, B = dD/du, A = dD/dv (both scaled
 * by `CRACK_GRADIENT_SCALE` and remapped to [0,1]). Linear data throughout — no sRGB
 * anywhere near it.
 */
export function bakeCrackField(size: number, period: number, seed: number, mipLevels: number): BakedLevel[] {
  const data = new Uint8Array(size * size * 4)
  const texel = 1 / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * texel
      const v = (y + 0.5) * texel
      const [d, cell] = crackField(u, v, period, seed)
      const dL = crackField(u - texel, v, period, seed)[0]
      const dR = crackField(u + texel, v, period, seed)[0]
      const dD = crackField(u, v - texel, period, seed)[0]
      const dU = crackField(u, v + texel, period, seed)[0]
      const gu = (dR - dL) / (2 * texel)
      const gv = (dU - dD) / (2 * texel)
      const i = (y * size + x) * 4
      data[i] = encodeU8(d)
      data[i + 1] = encodeU8(cell)
      data[i + 2] = encodeU8(clamp01(gu * CRACK_GRADIENT_SCALE * 0.5 + 0.5))
      data[i + 3] = encodeU8(clamp01(gv * CRACK_GRADIENT_SCALE * 0.5 + 0.5))
    }
  }
  return buildMipChain({ size, data }, mipLevels, 'linear')
}

// ---------------------------------------------------------------------------
// Reference sampling — used by the sRGB verification test
// ---------------------------------------------------------------------------

/**
 * Decode a baked albedo texel the way the GPU will: sRGB-decode RGB, leave alpha alone.
 *
 * Exported because the single most valuable assertion in this package is "the linear colour
 * that comes back out of the texture is the linear colour the recipe put in", and that round
 * trip has to be expressible in a test without a GPU.
 */
export function decodeAlbedoTexel(level: BakedLevel, x: number, y: number): [number, number, number, number] {
  const i = (y * level.size + x) * 4
  return [
    srgbToLinear((level.data[i] as number) / 255),
    srgbToLinear((level.data[i + 1] as number) / 255),
    srgbToLinear((level.data[i + 2] as number) / 255),
    (level.data[i + 3] as number) / 255,
  ]
}

/** Decode a baked linear (normal/ORM/crack) texel: straight through, no transfer function. */
export function decodeLinearTexel(level: BakedLevel, x: number, y: number): [number, number, number, number] {
  const i = (y * level.size + x) * 4
  return [
    (level.data[i] as number) / 255,
    (level.data[i + 1] as number) / 255,
    (level.data[i + 2] as number) / 255,
    (level.data[i + 3] as number) / 255,
  ]
}

/** Mean linear albedo of a baked level. The burn-target assertions are means, not texels. */
export function meanLinearAlbedo(level: BakedLevel): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  const n = level.size * level.size
  for (let i = 0; i < n; i++) {
    const o = i * 4
    r += srgbU8ToLinearFast(level.data[o] as number)
    g += srgbU8ToLinearFast(level.data[o + 1] as number)
    b += srgbU8ToLinearFast(level.data[o + 2] as number)
  }
  return [r / n, g / n, b / n]
}

/** Mean of one linear channel of a baked level. */
export function meanChannel(level: BakedLevel, channel: 0 | 1 | 2 | 3): number {
  let acc = 0
  const n = level.size * level.size
  for (let i = 0; i < n; i++) acc += level.data[i * 4 + channel] as number
  return acc / n / 255
}
