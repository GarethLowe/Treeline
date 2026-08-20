/**
 * Compute-shader procedural generation of the material set. WP 1.6.
 *
 * This is the path M1 actually runs on: no downloaded assets, no disk, no network. The whole
 * set — bark, needle/leaf atlas, soil, litter, grass, rock, and the char and ash burn stages
 * of every burnable one — is synthesised from integer-hashed noise in `generate.wgsl`, then
 * mip-reduced in `mipdown.wgsl` with the correct transfer function per array.
 *
 * Cost on the target hardware is a few milliseconds of GPU time, once, at world load: 45
 * layers x 512^2 x 4 supersamples of value/Worley noise, plus a mip chain that is 1/3 of that
 * again. It is not on any frame's critical path.
 *
 * ## Uniform layout
 *
 * `writeGenParams` writes the exact 128-byte `Pattern` struct that `patterns.wgsl` declares.
 * There is no reflection here and no tolerance for drift: if a field moves, the shader reads
 * a different number and produces a plausible-looking wrong texture. The layout is asserted
 * by `test/render/materials/genparams.test.ts`.
 *
 * Layers are dispatched one at a time through a dynamic uniform offset, at
 * `UNIFORM_STRIDE_BYTES` = 256, which is `minUniformBufferOffsetAlignment`.
 */

import { type MaterialArrayPlan, texturePlan } from './arrays.ts'
import type { MaterialPacking } from './library.ts'
import { CRACK_WGSL, GENERATE_WGSL, MIPDOWN_WGSL } from './shaders.ts'

/** `minUniformBufferOffsetAlignment` in the default WebGPU limits. */
export const UNIFORM_STRIDE_BYTES = 256

/** Size of the `Pattern` uniform struct in `patterns.wgsl`. */
export const GEN_PARAMS_BYTES = 128

/** Mip reduction modes; must match the `MIP_MODE_*` constants in `mipdown.wgsl`. */
export const MIP_MODE = { Linear: 0, Srgb: 1, Normal: 2 } as const

/**
 * Fill one 128-byte `Pattern` record.
 *
 * `dv` must be little-endian throughout (the `true` argument on every setter). WebGPU buffers
 * are little-endian on every supported platform, and being explicit here rather than relying
 * on `DataView`'s big-endian default is the difference between working and silently reading
 * byte-swapped garbage.
 */
export function writeGenParams(
  dv: DataView,
  offset: number,
  p: {
    kind: number
    seed: number
    periodU: number
    periodV: number
    grainPeriod: number
    cellsU: number
    cellsV: number
    elementWidth: number
    elementLength: number
    tipSharpness: number
    plateiness: number
    reliefM: number
    tileSizeM: number
    metallic: number
    baseRoughness: number
    baseAlbedo: readonly [number, number, number]
    roughnessVariation: number
    deepAlbedo: readonly [number, number, number]
    detailMean: number
    burnResponse: readonly [number, number, number]
  },
  stage: number,
  size: number,
  superSamples: number,
  targetLayer: number,
): void {
  const LE = true
  // vec4<u32> kindStageSizeSS
  dv.setUint32(offset + 0, p.kind >>> 0, LE)
  dv.setUint32(offset + 4, stage >>> 0, LE)
  dv.setUint32(offset + 8, size >>> 0, LE)
  dv.setUint32(offset + 12, superSamples >>> 0, LE)
  // vec4<u32> seedPeriods
  dv.setUint32(offset + 16, p.seed >>> 0, LE)
  dv.setUint32(offset + 20, p.periodU >>> 0, LE)
  dv.setUint32(offset + 24, p.periodV >>> 0, LE)
  dv.setUint32(offset + 28, p.grainPeriod >>> 0, LE)
  // vec4<u32> cellsLayerFlags
  dv.setUint32(offset + 32, p.cellsU >>> 0, LE)
  dv.setUint32(offset + 36, p.cellsV >>> 0, LE)
  dv.setUint32(offset + 40, targetLayer >>> 0, LE)
  dv.setUint32(offset + 44, 0, LE)
  // vec4<f32> elemTipPlate
  dv.setFloat32(offset + 48, p.elementWidth, LE)
  dv.setFloat32(offset + 52, p.elementLength, LE)
  dv.setFloat32(offset + 56, p.tipSharpness, LE)
  dv.setFloat32(offset + 60, p.plateiness, LE)
  // vec4<f32> reliefTileMetal
  dv.setFloat32(offset + 64, p.reliefM, LE)
  dv.setFloat32(offset + 68, p.tileSizeM, LE)
  dv.setFloat32(offset + 72, p.metallic, LE)
  dv.setFloat32(offset + 76, p.baseRoughness, LE)
  // vec4<f32> baseAlbedoVar
  dv.setFloat32(offset + 80, p.baseAlbedo[0], LE)
  dv.setFloat32(offset + 84, p.baseAlbedo[1], LE)
  dv.setFloat32(offset + 88, p.baseAlbedo[2], LE)
  dv.setFloat32(offset + 92, p.roughnessVariation, LE)
  // vec4<f32> deepAlbedo — .w carries detailMean, which makes the burn modulation in
  // applyBurn() mean-preserving. Assuming 0.5 there costs the atlas materials ~30% of their
  // published char albedo, invisibly.
  dv.setFloat32(offset + 96, p.deepAlbedo[0], LE)
  dv.setFloat32(offset + 100, p.deepAlbedo[1], LE)
  dv.setFloat32(offset + 104, p.deepAlbedo[2], LE)
  dv.setFloat32(offset + 108, p.detailMean, LE)
  // vec4<f32> burnResponse
  dv.setFloat32(offset + 112, p.burnResponse[0], LE)
  dv.setFloat32(offset + 116, p.burnResponse[1], LE)
  dv.setFloat32(offset + 120, p.burnResponse[2], LE)
  dv.setFloat32(offset + 124, 0, LE)
}

/**
 * Build the whole uniform buffer contents: one 256-byte-strided record per array layer.
 *
 * Pure and exported so a test can assert every layer's record without a GPU.
 */
export function buildGenParamsBuffer(
  packing: MaterialPacking,
  size: number,
  superSamples: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(packing.totalLayers * UNIFORM_STRIDE_BYTES)
  const dv = new DataView(buf)
  for (const mat of packing.materials) {
    for (let stage = 0; stage < mat.layerCount; stage++) {
      const layer = mat.baseLayer + stage
      writeGenParams(dv, layer * UNIFORM_STRIDE_BYTES, mat.params, stage, size, superSamples, layer)
    }
  }
  return buf
}

// ---------------------------------------------------------------------------
// GPU execution
// ---------------------------------------------------------------------------

const WORKGROUP = 8

// `GPUBufferUsage` and `GPUShaderStage` are browser-only globals. Spelling the bit values out
// keeps this module importable by a CLI test under Node, which is what allows the uniform
// layout above — the part that fails silently rather than loudly — to be asserted without a GPU.
const BUFFER_UNIFORM = 0x0040
const BUFFER_COPY_DST = 0x0008
const STAGE_COMPUTE = 0x4

export interface ArrayTextures {
  readonly albedo: GPUTexture
  readonly normal: GPUTexture
  readonly orm: GPUTexture
  readonly crack: GPUTexture
}

/**
 * Encode every generation pass: mip 0 of all three arrays for all layers, the crack field,
 * then the mip chains.
 *
 * Encoded into a caller-supplied encoder so the whole world-load can be one submit and so the
 * frame profiler (WP 1.1) can attribute it if it wants to.
 */
export function encodeGeneration(
  device: GPUDevice,
  plan: MaterialArrayPlan,
  packing: MaterialPacking,
  textures: ArrayTextures,
  encoder: GPUCommandEncoder,
): void {
  const { size, superSamples, crackSize, crackPeriod } = plan.config

  // --- mip 0 of the three arrays -------------------------------------------------
  const genModule = device.createShaderModule({ label: 'material-generate', code: GENERATE_WGSL })
  const genLayout = device.createBindGroupLayout({
    label: 'material-generate-layout',
    entries: [
      { binding: 0, visibility: STAGE_COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: GEN_PARAMS_BYTES } },
      { binding: 1, visibility: STAGE_COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
      { binding: 2, visibility: STAGE_COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
      { binding: 3, visibility: STAGE_COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
    ],
  })
  const genPipeline = device.createComputePipeline({
    label: 'material-generate',
    layout: device.createPipelineLayout({ bindGroupLayouts: [genLayout] }),
    compute: { module: genModule, entryPoint: 'generateLayer' },
  })

  const paramsData = buildGenParamsBuffer(packing, size, superSamples)
  const paramsBuffer = device.createBuffer({
    label: 'material-generate-params',
    size: paramsData.byteLength,
    usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
  })
  device.queue.writeBuffer(paramsBuffer, 0, paramsData)

  const storageView = (t: GPUTexture, level: number): GPUTextureView =>
    t.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1, format: 'rgba8unorm' })

  const genBindGroup = device.createBindGroup({
    label: 'material-generate-bg',
    layout: genLayout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer, offset: 0, size: GEN_PARAMS_BYTES } },
      { binding: 1, resource: storageView(textures.albedo, 0) },
      { binding: 2, resource: storageView(textures.normal, 0) },
      { binding: 3, resource: storageView(textures.orm, 0) },
    ],
  })

  const groups = Math.ceil(size / WORKGROUP)
  {
    const pass = encoder.beginComputePass({ label: 'material-generate' })
    pass.setPipeline(genPipeline)
    for (let layer = 0; layer < packing.totalLayers; layer++) {
      pass.setBindGroup(0, genBindGroup, [layer * UNIFORM_STRIDE_BYTES])
      pass.dispatchWorkgroups(groups, groups, 1)
    }
    pass.end()
  }

  // --- crack field ---------------------------------------------------------------
  const crackModule = device.createShaderModule({ label: 'material-crack', code: CRACK_WGSL })
  const crackLayout = device.createBindGroupLayout({
    label: 'material-crack-layout',
    entries: [
      { binding: 0, visibility: STAGE_COMPUTE, buffer: { type: 'uniform', minBindingSize: 16 } },
      { binding: 1, visibility: STAGE_COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
    ],
  })
  const crackPipeline = device.createComputePipeline({
    label: 'material-crack',
    layout: device.createPipelineLayout({ bindGroupLayouts: [crackLayout] }),
    compute: { module: crackModule, entryPoint: 'generateCrack' },
  })
  const crackParams = device.createBuffer({
    label: 'material-crack-params',
    size: 16,
    usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
  })
  // The crack field's seed is fixed: it is ONE field shared by the entire world, so making it
  // world-seed-dependent would give every save a different char pattern for no benefit.
  device.queue.writeBuffer(crackParams, 0, new Uint32Array([crackPeriod, 0x9e3779b1, crackSize, 0]))
  const crackBindGroup = device.createBindGroup({
    label: 'material-crack-bg',
    layout: crackLayout,
    entries: [
      { binding: 0, resource: { buffer: crackParams } },
      { binding: 1, resource: storageView(textures.crack, 0) },
    ],
  })
  {
    const pass = encoder.beginComputePass({ label: 'material-crack' })
    pass.setPipeline(crackPipeline)
    pass.setBindGroup(0, crackBindGroup)
    const g = Math.ceil(crackSize / WORKGROUP)
    pass.dispatchWorkgroups(g, g, 1)
    pass.end()
  }

  encodeMipChains(device, plan, packing, textures, encoder)
}

/**
 * Build every mip chain, in the correct space per array.
 *
 * Separate from base generation because the CC0 asset path (`scripts/fetch-assets.mjs`, when
 * the user chooses to run it) uploads mip 0 with `copyExternalImageToTexture` and then needs
 * exactly this. Downloaded PNGs are sRGB-encoded, so their chains have the same
 * decode-average-encode requirement as generated ones.
 */
export function encodeMipChains(
  device: GPUDevice,
  plan: MaterialArrayPlan,
  packing: MaterialPacking,
  textures: ArrayTextures,
  encoder: GPUCommandEncoder,
): void {
  const { size, crackSize } = plan.config
  const mipLevels = plan.config.mipLevels
  const mipModule = device.createShaderModule({ label: 'material-mipdown', code: MIPDOWN_WGSL })
  const mipLayout = device.createBindGroupLayout({
    label: 'material-mipdown-layout',
    entries: [
      { binding: 0, visibility: STAGE_COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 1, visibility: STAGE_COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
      { binding: 2, visibility: STAGE_COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
    ],
  })
  const mipPipeline = device.createComputePipeline({
    label: 'material-mipdown',
    layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
    compute: { module: mipModule, entryPoint: 'mipDown' },
  })

  interface MipJob {
    readonly label: string
    readonly texture: GPUTexture
    readonly mode: number
    readonly layers: number
    readonly baseSize: number
    readonly levels: number
  }
  const jobs: MipJob[] = [
    { label: 'albedo', texture: textures.albedo, mode: MIP_MODE.Srgb, layers: packing.totalLayers, baseSize: size, levels: mipLevels },
    { label: 'normal', texture: textures.normal, mode: MIP_MODE.Normal, layers: packing.totalLayers, baseSize: size, levels: mipLevels },
    { label: 'orm', texture: textures.orm, mode: MIP_MODE.Linear, layers: packing.totalLayers, baseSize: size, levels: mipLevels },
    { label: 'crack', texture: textures.crack, mode: MIP_MODE.Linear, layers: 1, baseSize: crackSize, levels: texturePlan(plan, 'crack').mipLevels },
  ]

  // One 256-byte-strided uniform record per dispatch. Built first so the buffer can be
  // written once rather than per level.
  const WORDS_PER_RECORD = UNIFORM_STRIDE_BYTES / 4
  const records: number[] = []
  const offsetFor = (job: MipJob, level: number, layer: number): number => {
    const index = records.length / WORDS_PER_RECORD
    records.push(Math.max(1, job.baseSize >> level), layer, job.mode, 0)
    for (let i = 4; i < WORDS_PER_RECORD; i++) records.push(0)
    return index * UNIFORM_STRIDE_BYTES
  }

  interface Dispatch {
    readonly job: MipJob
    readonly level: number
    readonly layer: number
    readonly offset: number
  }
  const perLevel: Dispatch[][] = []
  for (const job of jobs) {
    for (let level = 1; level < job.levels; level++) {
      const group: Dispatch[] = []
      for (let layer = 0; layer < job.layers; layer++) {
        group.push({ job, level, layer, offset: offsetFor(job, level, layer) })
      }
      perLevel.push(group)
    }
  }
  if (perLevel.length === 0) return

  const mipParams = device.createBuffer({
    label: 'material-mipdown-params',
    size: records.length * 4,
    usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
  })
  device.queue.writeBuffer(mipParams, 0, new Uint32Array(records))

  // One compute pass per level. Level N must be complete before level N+1 reads it, and a
  // pass boundary is the ordering guarantee WebGPU gives; within a level the layers are
  // independent and dispatch back to back.
  for (const group of perLevel) {
    const first = group[0]
    if (!first) continue
    const pass = encoder.beginComputePass({
      label: `material-mipdown-${first.job.label}-${first.level}`,
    })
    pass.setPipeline(mipPipeline)
    const srcView = first.job.texture.createView({
      dimension: '2d-array',
      baseMipLevel: first.level - 1,
      mipLevelCount: 1,
    })
    const dstView = first.job.texture.createView({
      dimension: '2d-array',
      baseMipLevel: first.level,
      mipLevelCount: 1,
      format: 'rgba8unorm',
    })
    const bg = device.createBindGroup({
      layout: mipLayout,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: dstView },
        { binding: 2, resource: { buffer: mipParams, offset: 0, size: 16 } },
      ],
    })
    const dstSize = Math.max(1, first.job.baseSize >> first.level)
    const g = Math.ceil(dstSize / WORKGROUP)
    for (const d of group) {
      pass.setBindGroup(0, bg, [d.offset])
      pass.dispatchWorkgroups(g, g, 1)
    }
    pass.end()
  }
}
