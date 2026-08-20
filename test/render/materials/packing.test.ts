/**
 * Array packing, layer indexing, the shader-side material table, and — the acceptance
 * criterion — that `bytesUsed` equals the bytes actually allocated. WP 1.6.
 *
 * The device stub below is not a mock of a sibling package (rule 4 of §90.1 forbids that); it
 * is a recorder for the WebGPU API itself, which is a frozen external interface. It exists so
 * that the VRAM figure reported to the budget can be checked against the descriptors the
 * system really hands to `createTexture`, rather than against a second copy of the same
 * arithmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MATERIAL_ARRAY_CONFIG,
  MATERIAL_ENTRY_BYTES,
  MATERIAL_GLOBALS_BYTES,
  MATERIAL_TABLE_BYTES,
  MATERIAL_TEXTURE_USAGE,
  mipChainBytes,
  mipChainLength,
  planMaterialArrays,
  texturePlan,
} from '../../../src/render/materials/arrays.ts'
import {
  GROUND_SLOT,
  MATERIAL_IDS,
  defaultGroundMaterials,
  packMaterials,
  resolveGroundMaterials,
} from '../../../src/render/materials/library.ts'
import {
  MAT_FLAG,
  buildMaterialTable,
  createMaterialSystem,
  materialIndex,
} from '../../../src/render/materials/materialSystem.ts'
import {
  GEN_PARAMS_BYTES,
  UNIFORM_STRIDE_BYTES,
  buildGenParamsBuffer,
} from '../../../src/render/materials/gpuGenerator.ts'

const packing = packMaterials()

// ---------------------------------------------------------------------------
// Recording device stub
// ---------------------------------------------------------------------------

interface RecordedTexture {
  readonly descriptor: GPUTextureDescriptor
}

function createRecordingDevice(): { device: GPUDevice; textures: RecordedTexture[]; buffers: GPUBufferDescriptor[] } {
  const textures: RecordedTexture[] = []
  const buffers: GPUBufferDescriptor[] = []
  const noop = (): void => {}
  const pass = {
    setPipeline: noop,
    setBindGroup: noop,
    dispatchWorkgroups: noop,
    end: noop,
  }
  const device = {
    createTexture(descriptor: GPUTextureDescriptor) {
      textures.push({ descriptor })
      return { ...descriptor, createView: () => ({}), destroy: noop }
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      buffers.push(descriptor)
      return { destroy: noop }
    },
    createSampler: () => ({}),
    createBindGroupLayout: (d: unknown) => d,
    createPipelineLayout: (d: unknown) => d,
    createBindGroup: (d: unknown) => d,
    createShaderModule: (d: unknown) => d,
    createComputePipeline: (d: unknown) => d,
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: noop,
      writeTexture: noop,
      submit: noop,
      copyExternalImageToTexture: noop,
    },
  }
  return { device: device as unknown as GPUDevice, textures, buffers }
}

// ---------------------------------------------------------------------------

describe('array layout', () => {
  it('computes the full mip chain length', () => {
    expect(mipChainLength(512)).toBe(10)
    expect(mipChainLength(1)).toBe(1)
    expect(() => mipChainLength(500)).toThrow(/power of two/)
  })

  it('computes chain bytes as the sum of the levels, not the 4/3 shortcut', () => {
    // Full chain: the closed form happens to agree, and this pins it.
    const full = mipChainBytes(512, 10)
    expect(full).toBe(4 * (512 * 512 + 256 * 256 + 128 * 128 + 64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1))
    // Partial chain: the closed form does NOT agree, which is why the loop exists.
    expect(mipChainBytes(512, 2)).toBe(4 * (512 * 512 + 256 * 256))
  })

  it('plans four textures with the right formats and exactly one sRGB view', () => {
    const plan = planMaterialArrays(packing)
    expect(plan.textures.map((t) => t.kind)).toEqual(['albedo', 'normal', 'orm', 'crack'])
    for (const t of plan.textures) {
      // No plan may use a storage-incompatible format: sRGB formats cannot be storage-bound.
      expect(t.format).toBe('rgba8unorm')
    }
    const srgb = plan.textures.filter((t) => t.srgb)
    expect(srgb.map((t) => t.kind)).toEqual(['albedo'])
    expect(texturePlan(plan, 'albedo').sampleFormat).toBe('rgba8unorm-srgb')
    expect(texturePlan(plan, 'normal').sampleFormat).toBe('rgba8unorm')
    expect(texturePlan(plan, 'orm').sampleFormat).toBe('rgba8unorm')
  })

  it('fits the spec §10 §6.2 material budget of ~500 MiB', () => {
    const plan = planMaterialArrays(packing)
    const MiB = 1024 * 1024
    expect(plan.bytesUsed / MiB).toBeLessThan(500)
    // And is not accidentally trivial — that would mean the arrays are not being allocated.
    expect(plan.bytesUsed / MiB).toBeGreaterThan(100)
  })

  it('rejects a layer count above the default maxTextureArrayLayers', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      ...(packing.materials[0] as (typeof packing.materials)[number]).recipe,
      id: `m${i}` as never,
    }))
    expect(() => planMaterialArrays(packMaterials(many))).toThrow(/maxTextureArrayLayers/)
  })

  it('sets TEXTURE_BINDING and STORAGE_BINDING on the array textures', () => {
    // STORAGE_BINDING is what lets the compute generator write mip 0 directly; TEXTURE_BINDING
    // is what lets everything else sample it. Both, on the same texture, is the whole trick.
    expect(MATERIAL_TEXTURE_USAGE & 0x04).toBeTruthy()
    expect(MATERIAL_TEXTURE_USAGE & 0x08).toBeTruthy()
  })
})

describe('bytesUsed matches the actual allocation', () => {
  it('sums exactly the descriptors handed to createTexture, plus the table buffer', async () => {
    const { device, textures, buffers } = createRecordingDevice()
    const system = await createMaterialSystem(device)

    expect(textures).toHaveLength(4)
    let allocated = 0
    for (const { descriptor } of textures) {
      const size = descriptor.size as GPUExtent3DDict
      const w = size.width
      const h = size.height ?? 1
      const layers = size.depthOrArrayLayers ?? 1
      const mips = descriptor.mipLevelCount ?? 1
      allocated += mipChainBytes(w, mips) * layers
      expect(h).toBe(w)
    }
    // The uniform material table is real VRAM and is counted, so the budget number stays
    // honest whether or not the term is large.
    const tableBuffer = buffers.find((b) => b.label === 'material-table')
    expect(tableBuffer?.size).toBe(MATERIAL_TABLE_BYTES)
    allocated += MATERIAL_TABLE_BYTES

    expect(system.bytesUsed).toBe(allocated)
  })

  it('creates the albedo texture with an sRGB view format and the others without', async () => {
    const { device, textures } = createRecordingDevice()
    await createMaterialSystem(device)
    const albedo = textures.find((t) => t.descriptor.label === 'material-albedo-array')
    const normal = textures.find((t) => t.descriptor.label === 'material-normal-array')
    expect(albedo?.descriptor.viewFormats).toEqual(['rgba8unorm-srgb'])
    expect(normal?.descriptor.viewFormats).toBeUndefined()
  })

  it('scales with the configured resolution', async () => {
    const small = planMaterialArrays(packing, { ...DEFAULT_MATERIAL_ARRAY_CONFIG, size: 256, mipLevels: 9 })
    const big = planMaterialArrays(packing)
    // Four times the texels for the three arrays; the crack field is unchanged.
    const crack = texturePlan(big, 'crack').bytes
    expect((big.bytesUsed - crack - MATERIAL_TABLE_BYTES) / (small.bytesUsed - crack - MATERIAL_TABLE_BYTES)).toBeCloseTo(4, 2)
  })
})

describe('material lookup', () => {
  it('exposes every library material through the contract interface', async () => {
    const { device } = createRecordingDevice()
    const system = await createMaterialSystem(device)
    for (const id of MATERIAL_IDS) {
      const def = system.get(id)
      expect(def.id).toBe(id)
      expect(def.layer).toBeGreaterThanOrEqual(0)
      expect(def.layer).toBeLessThan(packing.totalLayers)
    }
    expect(system.materials.size).toBe(MATERIAL_IDS.length)
  })

  it('throws on an unknown id and names the alternatives', async () => {
    const { device } = createRecordingDevice()
    const system = await createMaterialSystem(device)
    expect(() => system.get('bark-oak')).toThrow(/unknown material 'bark-oak'/)
  })

  it('distinguishes table index from layer index', () => {
    // They coincide for material 0 and diverge immediately after, which is exactly the trap.
    expect(materialIndex(packing, MATERIAL_IDS[0] as string)).toBe(0)
    const second = packing.materials[1]
    expect(second).toBeDefined()
    expect(materialIndex(packing, (second as (typeof packing.materials)[number]).def.id)).toBe(1)
    expect((second as (typeof packing.materials)[number]).baseLayer).toBe(4)
  })
})

describe('shader-side material table', () => {
  const table = buildMaterialTable(packing, 0.5, 0.5)
  const dv = new DataView(table)

  it('is the declared size, with globals ahead of the entries', () => {
    expect(table.byteLength).toBe(MATERIAL_TABLE_BYTES)
    expect(MATERIAL_TABLE_BYTES).toBe(MATERIAL_GLOBALS_BYTES + MATERIAL_ENTRY_BYTES * 64)
    // Uniform buffers cap at 65536 bytes in the default limits.
    expect(MATERIAL_TABLE_BYTES).toBeLessThanOrEqual(65536)
    expect(dv.getFloat32(0, true)).toBeCloseTo(0.5, 6)
  })

  it('writes each material at its own 48-byte entry, little-endian', () => {
    packing.materials.forEach((mat, i) => {
      const o = MATERIAL_GLOBALS_BYTES + i * MATERIAL_ENTRY_BYTES
      expect(dv.getFloat32(o + 12, true)).toBeCloseTo(mat.def.roughnessFactor, 6)
      expect(dv.getFloat32(o + 16, true)).toBeCloseTo(mat.def.metallicFactor, 6)
      expect(dv.getFloat32(o + 20, true)).toBeCloseTo(mat.params.tileSizeM, 5)
      expect(dv.getUint32(o + 32, true)).toBe(mat.baseLayer)
      expect(dv.getUint32(o + 36, true)).toBe(mat.layerCount)
      const flags = dv.getUint32(o + 40, true)
      expect(Boolean(flags & MAT_FLAG.Burnable)).toBe(mat.def.burnable)
      expect(Boolean(flags & MAT_FLAG.AlphaTest)).toBe(mat.def.alphaTest)
      expect(Boolean(flags & MAT_FLAG.DoubleSided)).toBe(mat.def.doubleSided)
    })
  })
})

describe('generator uniform records', () => {
  const buffer = buildGenParamsBuffer(packing, 512, 2)
  const dv = new DataView(buffer)

  it('has one 256-byte-strided record per array layer', () => {
    expect(buffer.byteLength).toBe(packing.totalLayers * UNIFORM_STRIDE_BYTES)
    // The struct itself must fit inside the stride, or a dynamic offset reads the next record.
    expect(GEN_PARAMS_BYTES).toBeLessThanOrEqual(UNIFORM_STRIDE_BYTES)
  })

  it('addresses each layer with its own stage and target layer', () => {
    for (const mat of packing.materials) {
      for (let stage = 0; stage < mat.layerCount; stage++) {
        const o = (mat.baseLayer + stage) * UNIFORM_STRIDE_BYTES
        expect(dv.getUint32(o + 0, true), `${mat.def.id} kind`).toBe(mat.params.kind)
        expect(dv.getUint32(o + 4, true), `${mat.def.id} stage`).toBe(stage)
        expect(dv.getUint32(o + 8, true)).toBe(512)
        expect(dv.getUint32(o + 12, true)).toBe(2)
        expect(dv.getUint32(o + 16, true), `${mat.def.id} seed`).toBe(mat.params.seed)
        expect(dv.getUint32(o + 40, true), `${mat.def.id} layer`).toBe(mat.baseLayer + stage)
        expect(dv.getFloat32(o + 64, true)).toBeCloseTo(mat.params.reliefM, 6)
        expect(dv.getFloat32(o + 68, true)).toBeCloseTo(mat.params.tileSizeM, 5)
        expect(dv.getFloat32(o + 80, true)).toBeCloseTo(mat.params.baseAlbedo[0] as number, 6)
      }
    }
  })
})

describe('ground material resolution', () => {
  it('supplies four slots for every biome, all of them known ids', () => {
    for (const biome of [
      'western-us-conifer',
      'grassland-savanna',
      'mediterranean-chaparral',
      'eucalypt-dry-forest',
      'uk-mixed-field-forest',
    ]) {
      const ids = defaultGroundMaterials(biome)
      expect(ids).toHaveLength(4)
      for (const id of ids) expect(MATERIAL_IDS).toContain(id)
      const layers = resolveGroundMaterials(packing, ids)
      expect(layers).toHaveLength(4)
      for (const l of layers) expect(l).toBeGreaterThanOrEqual(0)
      // The rock slot must actually be a rock-capable material on steep ground.
      expect(ids[GROUND_SLOT.Rock]).toBe('ground-rock')
    }
  })

  it('throws, rather than substituting, on an unknown ground material', () => {
    expect(() => resolveGroundMaterials(packing, ['ground-duff', 'litter-needle', 'gravel', 'ground-rock'])).toThrow(
      /unknown ground material 'gravel'/,
    )
    expect(() => resolveGroundMaterials(packing, ['ground-duff'])).toThrow(/needs 4 entries/)
    expect(() => defaultGroundMaterials('tundra')).toThrow(/no default ground materials/)
  })
})
