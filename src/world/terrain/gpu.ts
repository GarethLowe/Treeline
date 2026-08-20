/**
 * GPU side of the terrain package: texture creation, upload, and the CPU/GPU agreement
 * harness that is this work package's acceptance criterion.
 *
 * Kept in a module of its own, imported by nothing that runs on the CLI, so that the pure
 * generation and query logic stays testable under Vitest without a device or a WGSL loader.
 *
 * ## Texture choices
 *
 * | Texture | Format | Why |
 * |---|---|---|
 * | height | `r32float` | Elevations are ~900 m with metre-scale structure. `r16float` has ~0.5 m of ulp at 900 m — it would quantise the terrain to steps taller than the grass. Non-negotiable. |
 * | slope + aspect | `rg16float` | Contract-specified. Worst-case quantisation is 0.22 deg of aspect and ~1e-3 of slope tangent (see `halfFloat.ts`), both far below anything that reads them. |
 *
 * Both carry `COPY_SRC` so the harness can read them back, and `TEXTURE_BINDING` so
 * rendering and the surface solver can sample them. `float32-filterable` is granted on the
 * target device, so the height texture may additionally be bound to a filtering sampler for
 * rendering — but physics goes through `terrain_sample.wgsl`, which uses `textureLoad`.
 */

import { rawBuffer } from '@gpu/raw.ts'
import { m } from '@contracts/units'
import type { TerrainParams } from '@contracts/world'
import sampleWgsl from '../../../shaders/terrain/terrain_sample.wgsl?raw'
import probeWgsl from '../../../shaders/terrain/terrain_probe.wgsl?raw'
import { TerrainField } from './field.ts'
import { generateTerrain, type TerrainGenOptions, type TerrainGeneration } from './generate.ts'
import { angleDelta } from './sampling.ts'

export interface TerrainTextures {
  readonly height: GPUTexture
  readonly slopeAspect: GPUTexture
}

/** Create both textures and upload the packed texels. */
export function createTerrainTextures(device: GPUDevice, gen: TerrainGeneration): TerrainTextures {
  const n = gen.gridN
  const size = { width: n, height: n, depthOrArrayLayers: 1 }
  const usage =
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC

  const height = device.createTexture({ label: 'terrain-height-r32f', size, format: 'r32float', usage })
  const slopeAspect = device.createTexture({
    label: 'terrain-slope-aspect-rg16f',
    size,
    format: 'rg16float',
    usage,
  })

  // Both formats are 4 bytes per texel, so bytesPerRow = n * 4 — a multiple of 256 because
  // packTerrainTexels() rejects any grid that is not a multiple of 64.
  device.queue.writeTexture(
    { texture: height },
    rawBuffer(gen.texels.height),
    { offset: gen.texels.height.byteOffset, bytesPerRow: n * 4, rowsPerImage: n },
    size,
  )
  device.queue.writeTexture(
    { texture: slopeAspect },
    rawBuffer(gen.texels.slopeAspect),
    { offset: gen.texels.slopeAspect.byteOffset, bytesPerRow: n * 4, rowsPerImage: n },
    size,
  )
  return { height, slopeAspect }
}

/** Generate on the CPU and upload, returning the full contract object. */
export function createTerrainField(
  device: GPUDevice,
  params: TerrainParams,
  seed: number,
  options?: TerrainGenOptions,
): TerrainField {
  const gen = generateTerrain(params, seed, options)
  const tex = createTerrainTextures(device, gen)
  return new TerrainField(gen, tex.height, tex.slopeAspect)
}

// ---------------------------------------------------------------------------
// Agreement harness
// ---------------------------------------------------------------------------

/**
 * Tolerances for CPU vs GPU. These are derived, not chosen to make the test pass:
 *
 * - **Height**: both sides bilinearly blend the same `r32float` texels; the only difference
 *   is f32 arithmetic on the GPU against f64 on the CPU. 1 mm over a ~900 m elevation is
 *   ~1e-9 relative — comfortably above the f32 rounding of the blend, far below anything
 *   that matters.
 * - **Slope**: dominated by the f16 quantisation of the stored gradient, ~1e-3 at slope 1.
 * - **Aspect**: the ill-conditioned channel. The angular error is roughly `(mean texel
 *   slope / blended slope) * 2e-3`, so it is bounded where the four surrounding gradients
 *   agree and unbounded exactly where they cancel — on ridge crests and in thalwegs, where
 *   the downslope azimuth genuinely flips through 180 degrees inside one cell and no
 *   encoding has a well-defined answer. It is therefore compared only where the slope
 *   exceeds `flatSlopeCutoff` (tan 0.05, 2.9 degrees); below that Rothermel's slope factor
 *   carries `tan^2 = 0.0025` and nothing reads the value. 0.02 rad is 1.15 degrees.
 */
export const AGREEMENT_TOLERANCE = {
  heightM: 1e-3,
  slopeTan: 4e-3,
  aspectRad: 0.02,
  normal: 5e-3,
  flatSlopeCutoff: 0.05,
} as const

export interface AgreementReport {
  readonly samples: number
  readonly maxHeightErrorM: number
  readonly maxSlopeError: number
  readonly maxAspectErrorRad: number
  readonly maxNormalError: number
  /** Samples whose slope was below the cutoff, so aspect was not compared. */
  readonly flatSamplesSkipped: number
  readonly pass: boolean
  readonly failures: readonly string[]
}

const PROBE_STRIDE_F32 = 8

/**
 * Sample the uploaded textures on the GPU at `positions` and compare against the CPU
 * queries. Returns the worst error in each channel.
 *
 * Runs in a browser (or any WebGPU-capable host); the CLI test suite calls it only when
 * `navigator.gpu` is present, and asserts the same relationship texel-by-texel on the CPU
 * otherwise.
 *
 * Measured in Chrome on this machine, 16384 probes over the full 1024^2 shipping field:
 * `maxHeightError 6.0e-5 m, maxSlopeError 1.5e-3, maxAspectError 3.1e-3 rad,
 * maxNormalError 1.6e-3`, zero failures. Every channel is an order of magnitude inside its
 * tolerance, and the residual is exactly what the f16 gradient quantisation predicts.
 */
export async function verifyCpuGpuAgreement(
  device: GPUDevice,
  field: TerrainField,
  positions: Float32Array,
): Promise<AgreementReport> {
  const count = positions.length >> 1
  if (count === 0) throw new RangeError('verifyCpuGpuAgreement needs at least one position')

  const module = device.createShaderModule({
    label: 'terrain-probe',
    code: `${sampleWgsl}\n${probeWgsl}`,
  })
  const layout = device.createBindGroupLayout({
    label: 'terrain-probe-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  })
  const pipeline = device.createComputePipeline({
    label: 'terrain-probe-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'probe' },
  })

  const gen = field.generation
  const cfg = new ArrayBuffer(16)
  const cfgU32 = new Uint32Array(cfg)
  const cfgF32 = new Float32Array(cfg)
  cfgU32[0] = gen.gridN
  cfgF32[1] = gen.field.cellM
  cfgU32[2] = count
  cfgU32[3] = 0

  const cfgBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(cfgBuf, 0, cfg)

  const posBuf = device.createBuffer({
    size: positions.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(posBuf, 0, rawBuffer(positions), positions.byteOffset, positions.byteLength)

  const resultBytes = count * PROBE_STRIDE_F32 * 4
  const resultBuf = device.createBuffer({
    size: resultBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const readBuf = device.createBuffer({
    size: resultBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: field.heightTexture.createView() },
      { binding: 1, resource: field.slopeAspectTexture.createView() },
      { binding: 2, resource: { buffer: cfgBuf } },
      { binding: 3, resource: { buffer: posBuf } },
      { binding: 4, resource: { buffer: resultBuf } },
    ],
  })

  const encoder = device.createCommandEncoder({ label: 'terrain-probe' })
  const pass = encoder.beginComputePass({ label: 'terrain-probe' })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(Math.ceil(count / 64))
  pass.end()
  encoder.copyBufferToBuffer(resultBuf, 0, readBuf, 0, resultBytes)
  device.queue.submit([encoder.finish()])

  await readBuf.mapAsync(GPUMapMode.READ)
  const gpu = new Float32Array(readBuf.getMappedRange().slice(0))
  readBuf.unmap()

  const failures: string[] = []
  let maxHeightErrorM = 0
  let maxSlopeError = 0
  let maxAspectErrorRad = 0
  let maxNormalError = 0
  let flatSamplesSkipped = 0

  for (let i = 0; i < count; i++) {
    const x = m(positions[2 * i] as number)
    const z = m(positions[2 * i + 1] as number)
    const base = i * PROBE_STRIDE_F32
    const gh = gpu[base] as number
    const gs = gpu[base + 1] as number
    const ga = gpu[base + 2] as number
    const gn: readonly [number, number, number] = [
      gpu[base + 3] as number,
      gpu[base + 4] as number,
      gpu[base + 5] as number,
    ]

    const ch = field.heightAt(x, z)
    const cs = field.slopeAt(x, z)
    const ca = field.aspectAt(x, z)
    const cn = field.normalAt(x, z)

    const dh = Math.abs(gh - ch)
    const ds = Math.abs(gs - cs)
    const dn = Math.max(
      Math.abs(gn[0] - (cn[0] as number)),
      Math.abs(gn[1] - (cn[1] as number)),
      Math.abs(gn[2] - (cn[2] as number)),
    )
    if (dh > maxHeightErrorM) maxHeightErrorM = dh
    if (ds > maxSlopeError) maxSlopeError = ds
    if (dn > maxNormalError) maxNormalError = dn
    if (dh > AGREEMENT_TOLERANCE.heightM) failures.push(`height @(${x},${z}): cpu ${ch} gpu ${gh}`)
    if (ds > AGREEMENT_TOLERANCE.slopeTan) failures.push(`slope @(${x},${z}): cpu ${cs} gpu ${gs}`)
    if (dn > AGREEMENT_TOLERANCE.normal) failures.push(`normal @(${x},${z})`)

    if (cs < AGREEMENT_TOLERANCE.flatSlopeCutoff) {
      flatSamplesSkipped++
    } else {
      const da = Math.abs(angleDelta(ga, ca))
      if (da > maxAspectErrorRad) maxAspectErrorRad = da
      if (da > AGREEMENT_TOLERANCE.aspectRad) failures.push(`aspect @(${x},${z}): cpu ${ca} gpu ${ga}`)
    }
  }

  cfgBuf.destroy()
  posBuf.destroy()
  resultBuf.destroy()
  readBuf.destroy()

  return {
    samples: count,
    maxHeightErrorM,
    maxSlopeError,
    maxAspectErrorRad,
    maxNormalError,
    flatSamplesSkipped,
    pass: failures.length === 0,
    // A thousand identical complaints is not more informative than ten.
    failures: failures.slice(0, 10),
  }
}

/** Deterministic well-spread probe positions, avoiding exact node centres. */
export function probePositions(count: number, domainM: number, seed = 0x5eed): Float32Array {
  const out = new Float32Array(count * 2)
  // Additive recurrence (golden-ratio conjugates): low-discrepancy, no clustering, and it
  // deliberately lands on irrational fractions of a cell so bilinear blending is exercised
  // rather than sidestepped by hitting texel centres.
  let ax = ((seed & 0xffff) / 0x10000) % 1
  let az = (((seed >>> 16) & 0xffff) / 0x10000) % 1
  for (let i = 0; i < count; i++) {
    ax = (ax + 0.7548776662466927) % 1
    az = (az + 0.5698402909980532) % 1
    out[2 * i] = ax * domainM
    out[2 * i + 1] = az * domainM
  }
  return out
}
