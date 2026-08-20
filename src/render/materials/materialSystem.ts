/**
 * `IMaterialSystem` implementation. WP 1.6.
 *
 * Owns the three texture arrays, the shared crack field, the material table uniform, the
 * sampler, and the one bind group layout that every other rendering package binds against.
 *
 * ## Three sources, one format
 *
 * The material FORMAT is fixed regardless of where the texels come from:
 *
 *  - `gpu-procedural` (default, and what M1 ships on): compute shaders synthesise the whole
 *    set from noise. No downloads, no disk, no network, a few milliseconds at world load.
 *  - `cpu-procedural`: the same recipes evaluated in TypeScript and uploaded with
 *    `writeTexture`. Slower by orders of magnitude, but it is the oracle the GPU path is
 *    tested against and it is a genuine fallback where compute is unavailable.
 *  - `assets`: the curated CC0 PBR set, ingested into the same arrays. `scripts/fetch-assets.mjs`
 *    fetches it; that script is written but deliberately NOT run — downloading is a separate,
 *    explicitly authorised step. If the manifest is absent this source fails loudly with the
 *    command to run, rather than silently falling back to procedural, because "why does the
 *    build look different on my machine" is a much worse day than an error message.
 *
 * ## bytesUsed
 *
 * Reported from `planMaterialArrays`, which is the same object the textures are created from,
 * so the number cannot drift from the allocation. Spec §10 §6.2 budgets ~500 MiB for the
 * material set; the default configuration uses ~180 MiB.
 */

import type { IMaterialSystem, MaterialDef } from '@contracts/render.ts'
import {
  DEFAULT_MATERIAL_ARRAY_CONFIG,
  MATERIAL_ENTRY_BYTES,
  MATERIAL_GLOBALS_BYTES,
  MATERIAL_TABLE_BYTES,
  MATERIAL_TEXTURE_USAGE,
  MAX_MATERIALS,
  type MaterialArrayPlan,
  planMaterialArrays,
  texturePlan,
} from './arrays.ts'
import { type BakedLevel, bakeCrackField, bakeLayer } from './bake.ts'
import { type MaterialPacking, packMaterials } from './library.ts'
import { encodeGeneration, encodeMipChains, type ArrayTextures } from './gpuGenerator.ts'
import type { BurnStage } from './patterns.ts'

// ---------------------------------------------------------------------------
// Material table
// ---------------------------------------------------------------------------

/** Flag bits in `MaterialEntry.layout.z`. Must match `MAT_FLAG_*` in material_sample.wgsl. */
export const MAT_FLAG = { Burnable: 1, AlphaTest: 2, DoubleSided: 4 } as const

/**
 * Serialise the shader-side material table.
 *
 * Pure and exported so a test can assert the byte layout without a device — a mismatch here
 * does not throw, it makes every material read a neighbouring material's roughness.
 */
export function buildMaterialTable(
  packing: MaterialPacking,
  crackTileSizeM: number,
  burnSusceptibilityStrength: number,
): ArrayBuffer {
  if (packing.materials.length > MAX_MATERIALS) {
    throw new Error(`${packing.materials.length} materials exceeds MAX_MATERIALS (${MAX_MATERIALS})`)
  }
  const buf = new ArrayBuffer(MATERIAL_TABLE_BYTES)
  const dv = new DataView(buf)
  const LE = true
  dv.setFloat32(0, crackTileSizeM, LE)
  dv.setFloat32(4, burnSusceptibilityStrength, LE)
  dv.setFloat32(8, 0, LE)
  dv.setFloat32(12, 0, LE)

  packing.materials.forEach((mat, index) => {
    const o = MATERIAL_GLOBALS_BYTES + index * MATERIAL_ENTRY_BYTES
    const d = mat.def
    dv.setFloat32(o + 0, d.baseColorFactor[0], LE)
    dv.setFloat32(o + 4, d.baseColorFactor[1], LE)
    dv.setFloat32(o + 8, d.baseColorFactor[2], LE)
    dv.setFloat32(o + 12, d.roughnessFactor, LE)
    dv.setFloat32(o + 16, d.metallicFactor, LE)
    dv.setFloat32(o + 20, mat.params.tileSizeM, LE)
    dv.setFloat32(o + 24, mat.params.reliefM, LE)
    dv.setFloat32(o + 28, mat.recipe.alphaCutoff, LE)
    dv.setUint32(o + 32, mat.baseLayer, LE)
    dv.setUint32(o + 36, mat.layerCount, LE)
    dv.setUint32(
      o + 40,
      (d.burnable ? MAT_FLAG.Burnable : 0) |
        (d.alphaTest ? MAT_FLAG.AlphaTest : 0) |
        (d.doubleSided ? MAT_FLAG.DoubleSided : 0),
      LE,
    )
    dv.setUint32(o + 44, 0, LE)
  })
  return buf
}

/**
 * Index of a material in the table, which is what a shader passes to `materialSample`.
 *
 * NOT the same as `MaterialDef.layer`: the layer is where its texels live, the index is where
 * its parameters live. Conflating them works right up until a non-burnable material appears
 * and the two stop being equal.
 */
export function materialIndex(packing: MaterialPacking, id: string): number {
  const i = packing.materials.findIndex((m) => m.def.id === id)
  if (i < 0) throw new Error(`unknown material '${id}'`)
  return i
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MaterialSource = 'gpu-procedural' | 'cpu-procedural' | 'assets'

export interface MaterialSystemOptions {
  readonly source?: MaterialSource
  readonly packing?: MaterialPacking
  /**
   * How far the per-texel susceptibility field shifts the burn coordinate, in stage units.
   * 0 disables the effect and every texel of an instance transitions together.
   */
  readonly burnSusceptibilityStrength?: number
  /** Anisotropy. 8 is the usual sweet spot for ground textures at a grazing first-person view. */
  readonly maxAnisotropy?: number
  /** Base URL for the `assets` source. */
  readonly assetBaseUrl?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// `GPUShaderStage` and `GPUBufferUsage` are browser-only globals; the bit values are spelled
// out so the system can be constructed against a recording stub in a CLI test — which is how
// `bytesUsed` is checked against the descriptors actually handed to `createTexture`.
const SHADER_STAGE_ALL = 0x1 | 0x2 | 0x4 // VERTEX | FRAGMENT | COMPUTE
const BUFFER_UNIFORM = 0x0040
const BUFFER_COPY_DST = 0x0008

class MaterialSystem implements IMaterialSystem {
  readonly albedoArray: GPUTexture
  readonly normalArray: GPUTexture
  readonly ormArray: GPUTexture
  readonly crackField: GPUTexture
  readonly materials: ReadonlyMap<string, MaterialDef>
  readonly bytesUsed: number
  readonly bindGroupLayout: GPUBindGroupLayout
  readonly plan: MaterialArrayPlan
  readonly packing: MaterialPacking

  readonly device: GPUDevice
  private readonly sampler: GPUSampler
  private readonly tableBuffer: GPUBuffer
  private readonly albedoSampleView: GPUTextureView
  private readonly normalSampleView: GPUTextureView
  private readonly ormSampleView: GPUTextureView
  private readonly crackSampleView: GPUTextureView

  constructor(device: GPUDevice, plan: MaterialArrayPlan, packing: MaterialPacking, opts: MaterialSystemOptions) {
    this.device = device
    this.plan = plan
    this.packing = packing
    this.bytesUsed = plan.bytesUsed

    const make = (kind: 'albedo' | 'normal' | 'orm' | 'crack'): GPUTexture => {
      const t = texturePlan(plan, kind)
      return device.createTexture({
        label: t.label,
        size: { width: t.width, height: t.height, depthOrArrayLayers: t.layers },
        format: t.format,
        // Only albedo needs the reinterpretation. Listing it unconditionally would be
        // harmless but would blur the point: exactly one array carries a transfer function.
        ...(t.srgb ? { viewFormats: [t.sampleFormat] } : {}),
        mipLevelCount: t.mipLevels,
        dimension: '2d',
        usage: MATERIAL_TEXTURE_USAGE,
      })
    }
    this.albedoArray = make('albedo')
    this.normalArray = make('normal')
    this.ormArray = make('orm')
    this.crackField = make('crack')

    // THE sRGB decision, in one line: the albedo SAMPLING view carries the -srgb format, so
    // `textureSample` returns linear and no shader ever decodes. The storage views used by
    // the generator are plain rgba8unorm over the same memory.
    // `usage` narrows the view to TEXTURE_BINDING. Without it the view inherits the
    // texture's full usage, which includes STORAGE_BINDING — and STORAGE_BINDING is
    // invalid for an -srgb format, so CreateView is rejected and every bind group built
    // from it is invalid. Headless tests never caught this because it only fails on a
    // real device.
    this.albedoSampleView = this.albedoArray.createView({
      dimension: '2d-array',
      format: texturePlan(plan, 'albedo').sampleFormat,
      // 0x04 = GPUTextureUsage.TEXTURE_BINDING, spelled numerically because the global is
      // absent under Node and this line is reached by the unit tests' fake device.
      usage: 0x04,
    })
    this.normalSampleView = this.normalArray.createView({ dimension: '2d-array' })
    this.ormSampleView = this.ormArray.createView({ dimension: '2d-array' })
    this.crackSampleView = this.crackField.createView({ dimension: '2d' })

    this.sampler = device.createSampler({
      label: 'material-sampler',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: opts.maxAnisotropy ?? 8,
    })

    this.tableBuffer = device.createBuffer({
      label: 'material-table',
      size: MATERIAL_TABLE_BYTES,
      usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
    })
    device.queue.writeBuffer(
      this.tableBuffer,
      0,
      buildMaterialTable(packing, plan.config.crackTileSizeM, opts.burnSusceptibilityStrength ?? 0.5),
    )

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'material-bind-group-layout',
      entries: [
        { binding: 0, visibility: SHADER_STAGE_ALL, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: SHADER_STAGE_ALL, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: SHADER_STAGE_ALL, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: SHADER_STAGE_ALL, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: SHADER_STAGE_ALL, sampler: { type: 'filtering' } },
        { binding: 5, visibility: SHADER_STAGE_ALL, buffer: { type: 'uniform', minBindingSize: MATERIAL_TABLE_BYTES } },
      ],
    })

    const defs = new Map<string, MaterialDef>()
    for (const m of packing.materials) defs.set(m.def.id, m.def)
    this.materials = defs
  }

  get(id: string): MaterialDef {
    const d = this.materials.get(id)
    if (!d) {
      throw new Error(`unknown material '${id}'; known: ${[...this.materials.keys()].join(', ')}`)
    }
    return d
  }

  createBindGroup(device: GPUDevice): GPUBindGroup {
    return device.createBindGroup({
      label: 'material-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.albedoSampleView },
        { binding: 1, resource: this.normalSampleView },
        { binding: 2, resource: this.ormSampleView },
        { binding: 3, resource: this.crackSampleView },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: { buffer: this.tableBuffer } },
      ],
    })
  }

  /** Table index for a material id — what a shader passes to `materialSample`. */
  indexOf(id: string): number {
    return materialIndex(this.packing, id)
  }

  textures(): ArrayTextures {
    return {
      albedo: this.albedoArray,
      normal: this.normalArray,
      orm: this.ormArray,
      crack: this.crackField,
    }
  }

  destroy(): void {
    this.albedoArray.destroy()
    this.normalArray.destroy()
    this.ormArray.destroy()
    this.crackField.destroy()
    this.tableBuffer.destroy()
  }

  /** Upload a CPU-baked set. Used by `cpu-procedural`. */
  uploadBaked(): void {
    const { size, mipLevels, superSamples, crackSize, crackPeriod } = this.plan.config
    for (const mat of this.packing.materials) {
      for (let stage = 0; stage < mat.layerCount; stage++) {
        const baked = bakeLayer(mat.params, stage as BurnStage, size, superSamples, mipLevels)
        const layer = mat.baseLayer + stage
        this.writeChain(this.albedoArray, baked.albedo, layer)
        this.writeChain(this.normalArray, baked.normal, layer)
        this.writeChain(this.ormArray, baked.orm, layer)
      }
    }
    const crackMips = texturePlan(this.plan, 'crack').mipLevels
    // Fixed seed: one field for the whole world, so making it world-seed-dependent would give
    // every save a different char pattern for no benefit. Matches gpuGenerator.ts.
    this.writeChain(this.crackField, bakeCrackField(crackSize, crackPeriod, 0x9e3779b1, crackMips), 0)
  }

  private writeChain(texture: GPUTexture, chain: readonly BakedLevel[], layer: number): void {
    chain.forEach((level, mipLevel) => {
      this.device.queue.writeTexture(
        { texture, mipLevel, origin: { x: 0, y: 0, z: layer } },
        level.data,
        { bytesPerRow: level.size * 4, rowsPerImage: level.size },
        { width: level.size, height: level.size, depthOrArrayLayers: 1 },
      )
    })
  }
}

// ---------------------------------------------------------------------------
// Asset ingest (the curated CC0 path)
// ---------------------------------------------------------------------------

/** One entry of `public/assets/materials/manifest.json`, as `scripts/fetch-assets.mjs` writes it. */
export interface AssetManifestEntry {
  readonly id: string
  readonly albedo: string
  readonly normal: string
  readonly orm: string
  readonly source: string
  readonly license: string
}

export interface AssetManifest {
  readonly generatedBy: string
  readonly size: number
  readonly materials: readonly AssetManifestEntry[]
}

/**
 * Load mip 0 of every layer from downloaded PNGs, then rebuild the mip chains on the GPU.
 *
 * Note what does NOT happen here: no sRGB conversion. The PNGs are already sRGB-encoded and
 * the destination albedo texture stores encoded bytes, so `copyExternalImageToTexture` with
 * `colorSpace: 'srgb'` is a straight byte copy. Converting would double-encode. Normal and
 * ORM PNGs are linear data that merely happens to be in a PNG, and they land in non-sRGB
 * textures, so they are equally a straight copy.
 *
 * A downloaded set only covers the GREEN stage of each material; the burn stages are still
 * procedural, generated into the remaining three layers of each run. So the two sources are
 * not exclusive, and this function generates the non-green layers before overwriting layer
 * `baseLayer` with the downloaded texels.
 */
async function loadAssets(system: MaterialSystem, baseUrl: string): Promise<void> {
  const manifestUrl = `${baseUrl.replace(/\/$/, '')}/manifest.json`
  let manifest: AssetManifest
  try {
    const res = await fetch(manifestUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    manifest = (await res.json()) as AssetManifest
  } catch (cause) {
    throw new Error(
      `material source 'assets' needs ${manifestUrl}, which is not present. ` +
        `Run 'node scripts/fetch-assets.mjs' to download the CC0 set (see the script header ` +
        `for exactly what it fetches and under which licence), or use the 'gpu-procedural' ` +
        `source, which needs no assets at all. Cause: ${String(cause)}`,
    )
  }

  const jobs: Promise<void>[] = []
  for (const entry of manifest.materials) {
    const mat = system.packing.byId.get(entry.id)
    if (!mat) {
      throw new Error(`manifest lists material '${entry.id}', which is not in the library`)
    }
    const upload = async (url: string, texture: GPUTexture): Promise<void> => {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${url}`)
      if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`)
      const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' })
      if (bitmap.width !== manifest.size || bitmap.height !== manifest.size) {
        throw new Error(
          `${url} is ${bitmap.width}x${bitmap.height}, manifest declares ${manifest.size}`,
        )
      }
      system.device.queue.copyExternalImageToTexture(
        { source: bitmap, flipY: false },
        { texture, origin: { x: 0, y: 0, z: mat.baseLayer }, colorSpace: 'srgb', premultipliedAlpha: false },
        { width: bitmap.width, height: bitmap.height, depthOrArrayLayers: 1 },
      )
      bitmap.close()
    }
    jobs.push(upload(entry.albedo, system.albedoArray))
    jobs.push(upload(entry.normal, system.normalArray))
    jobs.push(upload(entry.orm, system.ormArray))
  }
  await Promise.all(jobs)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Extra surface beyond `IMaterialSystem` that this package's own consumers use. */
export interface ForestFireMaterialSystem extends IMaterialSystem {
  readonly plan: MaterialArrayPlan
  readonly packing: MaterialPacking
  readonly crackField: GPUTexture
  indexOf(id: string): number
  textures(): ArrayTextures
  destroy(): void
}

/**
 * Build the material system.
 *
 * Async only because the `assets` source has to fetch. The procedural sources complete
 * synchronously apart from the GPU work, which is queued and completes before the first
 * frame that samples it — WebGPU orders submits, so no fence is needed.
 */
export async function createMaterialSystem(
  device: GPUDevice,
  options: MaterialSystemOptions = {},
): Promise<ForestFireMaterialSystem> {
  const packing = options.packing ?? packMaterials()
  const config = DEFAULT_MATERIAL_ARRAY_CONFIG
  const plan = planMaterialArrays(packing, config)
  const system = new MaterialSystem(device, plan, packing, options)
  const source = options.source ?? 'gpu-procedural'

  if (source === 'cpu-procedural') {
    system.uploadBaked()
    return system
  }

  const encoder = device.createCommandEncoder({ label: 'material-generation' })
  encodeGeneration(device, plan, packing, system.textures(), encoder)
  device.queue.submit([encoder.finish()])

  if (source === 'assets') {
    // The procedural pass above has already filled every layer, so the burn stages are
    // present and only the green layer is replaced by downloaded texels.
    await loadAssets(system, options.assetBaseUrl ?? '/assets/materials')
    const mipEncoder = device.createCommandEncoder({ label: 'material-asset-mips' })
    encodeMipChains(device, plan, packing, system.textures(), mipEncoder)
    device.queue.submit([mipEncoder.finish()])
  }

  return system
}
