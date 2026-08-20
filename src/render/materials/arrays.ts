/**
 * Texture-array layout and VRAM accounting. WP 1.6.
 *
 * Three 2D arrays share one layer index space: albedo, normal, packed ORM. One bind group
 * serves the whole world, so a foliage pass drawing 80 k instances of a dozen materials
 * never rebinds.
 *
 * ## The sRGB decision, which is the one that silently ruins a PBR pipeline
 *
 * Albedo is sRGB-ENCODED; normal and ORM are LINEAR. That is not a preference, it is what
 * the data means: albedo is a colour, so it wants the perceptual bit distribution the sRGB
 * curve buys (8 bits of encoded sRGB ~ 12 bits of linear near black, which is where char and
 * ash live); a roughness or an occlusion is a scalar with no colour semantics at all, and
 * pushing it through a colour transfer function makes it wrong by up to 2.3x in the midtones.
 *
 * The implementation detail that makes this work with a COMPUTE generator: WebGPU has no
 * `rgba8unorm-srgb` storage-texture format — sRGB formats cannot be storage-bound at all. So
 * the albedo array is created as plain `rgba8unorm` with `viewFormats: ['rgba8unorm-srgb']`:
 *
 *   - the generator writes through an `rgba8unorm` STORAGE view and sRGB-encodes in the
 *     shader, so the bytes stored are encoded values;
 *   - every consumer samples through the `rgba8unorm-srgb` TEXTURE view, so the hardware
 *     decodes for free and the shader receives linear.
 *
 * Both views alias the same memory. This is core WebGPU (srgb reinterpretation is explicitly
 * permitted between a format and its `-srgb` counterpart) and needs no optional feature.
 *
 * The alpha channel is NEVER sRGB. The transfer function is defined on the three colour
 * channels only, and hardware sRGB texture formats leave alpha linear. Encoding alpha through
 * the curve moves every foliage alpha-test cutout, which reads as "the LOD changed the
 * silhouette" rather than as a colour-space bug.
 *
 * ## Budget
 *
 * Spec §10 §6.2 allows ~500 MiB for the material set. The default here (512^2 base, full mip
 * chain, 45 layers, three `rgba8unorm` arrays) costs ~180 MiB, so the procedural set fits
 * with room for the eventual CC0 ingest to go wider. Nothing in this file guesses: `bytesUsed`
 * is summed from the same descriptors the textures are created from.
 */

import type { MaterialPacking } from './library.ts'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MaterialArrayConfig {
  /** Base mip resolution, square, power of two. */
  readonly size: number
  /** Number of mip levels. Defaults to the full chain down to 1x1. */
  readonly mipLevels: number
  /**
   * NxN supersamples per texel when generating mip 0. Procedural patterns are analytically
   * infinite-frequency (a Worley boundary is a step), so point-sampling mip 0 aliases
   * visibly. Averaging in LINEAR space is what makes this correct, not just softer.
   */
  readonly superSamples: number
  /** Resolution of the shared alligator-crack field (§7.6). One texture, whole world. */
  readonly crackSize: number
  /** Worley cell count across the crack field. Sets crack size relative to its tiling. */
  readonly crackPeriod: number
  /** World size of one crack-field tile, metres. */
  readonly crackTileSizeM: number
}

export const DEFAULT_MATERIAL_ARRAY_CONFIG: MaterialArrayConfig = {
  size: 512,
  mipLevels: mipChainLength(512),
  superSamples: 2,
  crackSize: 512,
  crackPeriod: 24,
  crackTileSizeM: 0.5,
}

/** Full mip chain length for a square texture. `512 -> 10`. */
export function mipChainLength(size: number): number {
  if (size < 1 || (size & (size - 1)) !== 0) throw new Error(`size must be a power of two, got ${size}`)
  return Math.log2(size) + 1
}

// ---------------------------------------------------------------------------
// Byte accounting
// ---------------------------------------------------------------------------

/** Bytes per texel. Every array in this system is 8-bit RGBA. */
export const BYTES_PER_TEXEL = 4

/**
 * Bytes for one square mip chain, one layer.
 *
 * Deliberately a loop over levels rather than the `4/3` closed form: the closed form is only
 * exact for a full chain down to 1x1, and this is also called for partial chains.
 */
export function mipChainBytes(size: number, mipLevels: number, bytesPerTexel = BYTES_PER_TEXEL): number {
  let total = 0
  for (let level = 0; level < mipLevels; level++) {
    const d = Math.max(1, size >> level)
    total += d * d * bytesPerTexel
  }
  return total
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Which of the three arrays a texture is. */
export type MaterialArrayKind = 'albedo' | 'normal' | 'orm' | 'crack'

/**
 * One texture's full description, including the exact bytes it will occupy. Produced before
 * any GPU object exists, so it is unit-testable and so `bytesUsed` cannot drift from the
 * allocation it claims to describe.
 */
export interface MaterialTexturePlan {
  readonly kind: MaterialArrayKind
  readonly label: string
  /** Storage format. Never `-srgb`: sRGB formats cannot be storage-bound. */
  readonly format: GPUTextureFormat
  /** Format the sampling view uses. Differs from `format` only for albedo. */
  readonly sampleFormat: GPUTextureFormat
  readonly width: number
  readonly height: number
  readonly layers: number
  readonly mipLevels: number
  readonly bytes: number
  /** True when the sampling view decodes sRGB. Exactly one plan has this set. */
  readonly srgb: boolean
}

export interface MaterialArrayPlan {
  readonly config: MaterialArrayConfig
  readonly layerCount: number
  readonly textures: readonly MaterialTexturePlan[]
  /** Sum over `textures[].bytes`. The number reported to the VRAM budget. */
  readonly bytesUsed: number
}

/**
 * Shader-side material table layout. Must match `MaterialTable` in `material_sample.wgsl`.
 *
 * One leading `vec4<f32>` of globals, then a fixed-size array of 48-byte entries. Fixed size
 * because a runtime-sized array is not permitted in the uniform address space, and uniform
 * beats storage here: the table is 3 KiB, read by every fragment, and constant for a frame.
 */
export const MATERIAL_ENTRY_BYTES = 48
export const MATERIAL_GLOBALS_BYTES = 16
export const MAX_MATERIALS = 64
export const MATERIAL_TABLE_BYTES = MATERIAL_GLOBALS_BYTES + MATERIAL_ENTRY_BYTES * MAX_MATERIALS

/**
 * Plan every allocation. Pure: no device, no side effects, fully testable.
 *
 * `bytesUsed` includes the uniform material table, because it is real VRAM and leaving it out
 * of the number that gets compared against a budget is how budgets quietly stop meaning
 * anything. It is 3 KiB against ~180 MiB, so it changes nothing — which is the point: the
 * accounting is honest whether or not the term matters.
 */
export function planMaterialArrays(
  packing: MaterialPacking,
  config: MaterialArrayConfig = DEFAULT_MATERIAL_ARRAY_CONFIG,
): MaterialArrayPlan {
  const { size, mipLevels, crackSize } = config
  if (mipLevels < 1 || mipLevels > mipChainLength(size)) {
    throw new Error(`mipLevels ${mipLevels} out of range for size ${size}`)
  }
  if (packing.totalLayers > 256) {
    // Not a hard WebGPU limit (maxTextureArrayLayers is 256 in the default limits), but it
    // IS the default limit, so exceeding it fails at device level with a message that does
    // not mention materials. Fail here instead, where the cause is obvious.
    throw new Error(`${packing.totalLayers} layers exceeds the default maxTextureArrayLayers of 256`)
  }

  const layerBytes = mipChainBytes(size, mipLevels)
  const arrayBytes = layerBytes * packing.totalLayers

  const textures: MaterialTexturePlan[] = [
    {
      kind: 'albedo',
      label: 'material-albedo-array',
      // Storage-writable. Sampled through an -srgb view; see the file header.
      format: 'rgba8unorm',
      sampleFormat: 'rgba8unorm-srgb',
      width: size,
      height: size,
      layers: packing.totalLayers,
      mipLevels,
      bytes: arrayBytes,
      srgb: true,
    },
    {
      kind: 'normal',
      label: 'material-normal-array',
      // LINEAR. RG = tangent-space normal XY, B = height in units of the material's relief,
      // A = 1. Reconstructing Z in the shader rather than storing it costs one sqrt and buys
      // a channel; storing height there is what lets the burn shader displace crack floors.
      format: 'rgba8unorm',
      sampleFormat: 'rgba8unorm',
      width: size,
      height: size,
      layers: packing.totalLayers,
      mipLevels,
      bytes: arrayBytes,
      srgb: false,
    },
    {
      kind: 'orm',
      label: 'material-orm-array',
      // LINEAR. R = occlusion, G = roughness, B = metallic, A = burn susceptibility.
      format: 'rgba8unorm',
      sampleFormat: 'rgba8unorm',
      width: size,
      height: size,
      layers: packing.totalLayers,
      mipLevels,
      bytes: arrayBytes,
      srgb: false,
    },
    {
      kind: 'crack',
      label: 'material-crack-field',
      // LINEAR, single 2D texture shared by every burnable material in the world (§7.6).
      // R = Worley boundary distance D, G = cell id, B/A unused. rgba8 rather than rg8
      // because rg8unorm needs `texture-formats-tier1` to be storage-bound and this stays
      // on the core path; the waste is 1.4 MB.
      format: 'rgba8unorm',
      sampleFormat: 'rgba8unorm',
      width: crackSize,
      height: crackSize,
      layers: 1,
      mipLevels: mipChainLength(crackSize),
      bytes: mipChainBytes(crackSize, mipChainLength(crackSize)),
      srgb: false,
    },
  ]

  const bytesUsed = textures.reduce((n, t) => n + t.bytes, 0) + MATERIAL_TABLE_BYTES

  return { config, layerCount: packing.totalLayers, textures, bytesUsed }
}

/** Look a planned texture up by kind. Throws rather than returning undefined. */
export function texturePlan(plan: MaterialArrayPlan, kind: MaterialArrayKind): MaterialTexturePlan {
  const t = plan.textures.find((x) => x.kind === kind)
  if (!t) throw new Error(`no planned texture of kind '${kind}'`)
  return t
}

/** Usage flags for the array textures. Split out so the test can assert them. */
export const MATERIAL_TEXTURE_USAGE: GPUTextureUsageFlags = 0x04 | 0x08 | 0x02 | 0x01
// TEXTURE_BINDING (0x04) | STORAGE_BINDING (0x08) | COPY_DST (0x02) | COPY_SRC (0x01).
// Literals rather than GPUTextureUsage.*, because that global does not exist in Node and
// this module has to be importable by a CLI test.
