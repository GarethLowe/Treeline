/**
 * Froxel volumetrics — WP 4.2/4.4.
 *
 * Two compute passes: a 1/16-resolution frustum march that integrates emission and in-scatter
 * against WP 4.1's smoke field, and a full-resolution composite that applies the result to the
 * HDR target. `blackbody.ts` supplies the emission colour LUT and is `validated`; the optical
 * constants live in the shader beside their citations.
 *
 * Runs after the world pass and before the resolve, because it needs the depth the terrain and
 * foliage wrote in order to stop marching at solid geometry.
 */

import type { CameraState } from '@contracts/render'
import type { Metres } from '@contracts/units'
import FROXEL_WGSL from '../../../shaders/render/volumetrics/froxel.wgsl?raw'
import { LUT_SIZE, buildBlackbodyLut } from './blackbody.ts'

/** §7.1.1: 16x16 px tiles at 2560x1440. Fixed, and bilinearly upsampled to whatever is set. */
export const FROXEL_NX = 160
export const FROXEL_NY = 90
/** Slice count. §7.1.6's quality lever runs 128 -> 96 -> 64 for 3.1 -> 2.4 -> 1.7 ms. */
export const FROXEL_SLICES = 128
/** Slices in the linear near-field half of the piecewise depth distribution. */
export const FROXEL_NEAR_SLICES = 64
export const FROXEL_Z0 = 0.5
export const FROXEL_Z1 = 64
export const FROXEL_ZF = 1024

const PARAMS_BYTES = 176

export interface FroxelInputs {
  /**
   * Only the inverse view-projection and the eye position are read.
   *
   * Narrowed from the full `CameraState` deliberately: it lets `?debug` march a synthetic
   * camera without standing up a rig, which is the only way this pass can be verified in an
   * environment where the browser never composites and `requestAnimationFrame` never fires.
   */
  readonly camera: Pick<CameraState, 'position' | 'invViewProjMatrix'>
  /** WP 4.1's current field. It ping-pongs, so this is read fresh every frame. */
  readonly smoke: GPUTexture
  /** WP 1.2's r32float terrain height. */
  readonly height: GPUTexture
  /** The world pass's depth, reversed-Z. */
  readonly depth: GPUTextureView
  /** The HDR colour target the composite writes into. */
  readonly hdr: GPUTextureView
  /** Direction TOWARDS the sun, normalised. */
  readonly sunDirection: readonly [number, number, number]
  readonly sunIrradiance: readonly [number, number, number]
  readonly skyIrradiance: readonly [number, number, number]
  readonly ambientK: number
  readonly domainSizeM: Metres
  /** Vertical extent of the smoke field, m above ground. */
  readonly smokeTopM: number
  /** Quality tier's slice count; floored so the near-field split stays meaningful. */
  readonly slices?: number
}

export class FroxelVolumetrics {
  readonly scatter: GPUTexture
  readonly transmittance: GPUTexture

  private readonly device: GPUDevice
  private readonly params: GPUBuffer
  private readonly lut: GPUTexture
  private readonly linearSampler: GPUSampler
  private readonly lutSampler: GPUSampler
  private readonly marchPipeline: GPUComputePipeline
  private readonly compositePipeline: GPUComputePipeline
  private marchGroup: GPUBindGroup | null = null
  private compositeGroup: GPUBindGroup | null = null
  private marchKey = ''
  private cachedDepth: GPUTextureView | null = null
  private compositeKey = ''

  constructor(device: GPUDevice) {
    this.device = device

    const low = (label: string): GPUTexture =>
      device.createTexture({
        label,
        size: { width: FROXEL_NX, height: FROXEL_NY },
        format: 'rgba16float',
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      })
    this.scatter = low('froxel.scatter')
    this.transmittance = low('froxel.transmittance')

    this.params = device.createBuffer({
      label: 'froxel.params',
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // The blackbody chroma LUT. rgba32float rather than rgb9e5ufloat because the latter is not
    // a filterable sampled format everywhere, and 4 KiB is not worth a compatibility branch.
    this.lut = device.createTexture({
      label: 'froxel.blackbodyLut',
      dimension: '1d',
      size: { width: LUT_SIZE },
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const lutData = buildBlackbodyLut()
    device.queue.writeTexture(
      { texture: this.lut },
      lutData,
      { bytesPerRow: LUT_SIZE * 16 },
      { width: LUT_SIZE },
    )

    this.linearSampler = device.createSampler({
      label: 'froxel.linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    })
    this.lutSampler = device.createSampler({
      label: 'froxel.lut',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
    })

    const module = device.createShaderModule({ label: 'froxel', code: FROXEL_WGSL })
    this.marchPipeline = device.createComputePipeline({
      label: 'froxel.march',
      layout: 'auto',
      compute: { module, entryPoint: 'march' },
    })
    this.compositePipeline = device.createComputePipeline({
      label: 'froxel.composite',
      layout: 'auto',
      compute: { module, entryPoint: 'composite' },
    })
  }

  /**
   * March and composite.
   *
   * Two passes, not one: the composite reads every froxel the march wrote, so it is a genuine
   * read-after-write across the whole texture and §6.3's pass boundary is mandatory rather than
   * tidy.
   */
  encode(encoder: GPUCommandEncoder, inputs: FroxelInputs, widthPx: number, heightPx: number): void {
    this.writeParams(inputs)

    const march = this.marchGroupFor(inputs)
    const p1 = encoder.beginComputePass({ label: 'froxel.march' })
    p1.setPipeline(this.marchPipeline)
    p1.setBindGroup(0, march)
    p1.dispatchWorkgroups(Math.ceil(FROXEL_NX / 8), Math.ceil(FROXEL_NY / 8))
    p1.end()

    const composite = this.compositeGroupFor(inputs)
    const p2 = encoder.beginComputePass({ label: 'froxel.composite' })
    p2.setPipeline(this.compositePipeline)
    // Group 0 as well now: the depth-aware upsample reads the scene depth and the camera
    // transform, so the composite is no longer a pure function of the two low-res textures.
    p2.setBindGroup(0, this.compositeDepthGroupFor(inputs))
    p2.setBindGroup(1, composite)
    p2.dispatchWorkgroups(Math.ceil(widthPx / 8), Math.ceil(heightPx / 8))
    p2.end()
  }

  destroy(): void {
    this.scatter.destroy()
    this.transmittance.destroy()
    this.lut.destroy()
    this.params.destroy()
  }

  /**
   * Bind groups are rebuilt only when a resource identity changes.
   *
   * The smoke field ping-pongs and the HDR target is recreated on resize, so caching on the
   * object identity is what keeps this from allocating two bind groups per frame forever.
   *
   * The DEPTH view has to be compared by identity too, and leaving it out of the key was a
   * black screen: `RenderTargets.resize` destroys `hdr-depth` and makes a new view, but the
   * smoke and height labels it was keyed on never change, so this handed back a bind group
   * still pointing at the destroyed texture. WebGPU then rejects the whole command buffer at
   * submit — "Destroyed texture used in a submit" — as a console warning, and the screen goes
   * black with nothing thrown. The trigger is any resolution-scale change, which is exactly
   * what the auto quality controller does when the frame rate drops.
   */
  private marchGroupFor(inputs: FroxelInputs): GPUBindGroup {
    const key = `${inputs.smoke.label}|${inputs.height.label}`
    if (this.marchGroup !== null && this.marchKey === key && this.cachedDepth === inputs.depth) {
      return this.marchGroup
    }
    this.marchGroup = this.device.createBindGroup({
      label: 'froxel.march.g0',
      layout: this.marchPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: inputs.smoke.createView() },
        { binding: 2, resource: this.linearSampler },
        { binding: 3, resource: inputs.height.createView() },
        { binding: 4, resource: inputs.depth },
        { binding: 5, resource: this.scatter.createView() },
        { binding: 6, resource: this.transmittance.createView() },
        { binding: 7, resource: this.lut.createView() },
        { binding: 8, resource: this.lutSampler },
      ],
    })
    this.marchKey = key
    this.cachedDepth = inputs.depth
    return this.marchGroup
  }

  private compositeGroupFor(inputs: FroxelInputs): GPUBindGroup {
    // The HDR view is recreated on every resize and there is no stable identity to key on, so
    // the caller's view object itself is the key.
    const key = String(inputs.hdr as unknown as string)
    if (this.compositeGroup !== null && this.compositeKey === key && this.cachedHdr === inputs.hdr) {
      return this.compositeGroup
    }
    this.compositeGroup = this.device.createBindGroup({
      label: 'froxel.composite.g1',
      layout: this.compositePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.scatter.createView() },
        { binding: 1, resource: this.transmittance.createView() },
        { binding: 3, resource: inputs.hdr },
      ],
    })
    this.compositeKey = key
    this.cachedHdr = inputs.hdr
    return this.compositeGroup
  }

  private cachedHdr: GPUTextureView | null = null

  /**
   * Group 0 for the COMPOSITE pipeline: the params buffer and the scene depth.
   *
   * A separate group from the march's, and deliberately not shared: `layout: 'auto'` derives a
   * different layout per pipeline from the bindings that entry point actually references, so
   * the march's group 0 is not compatible here even though the two overlap.
   *
   * The depth view is in the cache key for the reason spelled out on `marchGroupFor`: a
   * resize destroys `hdr-depth` and makes a new view, and a bind group cached over the old one
   * makes WebGPU reject the whole command buffer at submit — as a warning, so the screen goes
   * black with nothing thrown and a green test suite. That bug shipped once already.
   */
  private compositeDepthGroupFor(inputs: FroxelInputs): GPUBindGroup {
    if (this.compositeDepthGroup !== null && this.cachedCompositeDepth === inputs.depth) {
      return this.compositeDepthGroup
    }
    this.compositeDepthGroup = this.device.createBindGroup({
      label: 'froxel.composite.g0',
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 4, resource: inputs.depth },
      ],
    })
    this.cachedCompositeDepth = inputs.depth
    return this.compositeDepthGroup
  }

  private compositeDepthGroup: GPUBindGroup | null = null
  private cachedCompositeDepth: GPUTextureView | null = null

  private writeParams(inputs: FroxelInputs): void {
    const buf = new ArrayBuffer(PARAMS_BYTES)
    const v = new DataView(buf)
    const m = inputs.camera.invViewProjMatrix
    for (let i = 0; i < 16; i++) v.setFloat32(i * 4, m[i] as number, true)

    const p = inputs.camera.position
    v.setFloat32(64, p[0] as number, true)
    v.setFloat32(68, p[1] as number, true)
    v.setFloat32(72, p[2] as number, true)

    v.setFloat32(80, inputs.sunDirection[0], true)
    v.setFloat32(84, inputs.sunDirection[1], true)
    v.setFloat32(88, inputs.sunDirection[2], true)

    v.setFloat32(96, inputs.sunIrradiance[0], true)
    v.setFloat32(100, inputs.sunIrradiance[1], true)
    v.setFloat32(104, inputs.sunIrradiance[2], true)

    v.setFloat32(112, inputs.skyIrradiance[0], true)
    v.setFloat32(116, inputs.skyIrradiance[1], true)
    v.setFloat32(120, inputs.skyIrradiance[2], true)

    const slices = Math.max(FROXEL_NEAR_SLICES + 8, Math.trunc(inputs.slices ?? FROXEL_SLICES))
    v.setFloat32(128, FROXEL_NX, true)
    v.setFloat32(132, FROXEL_NY, true)
    v.setFloat32(136, slices, true)
    v.setFloat32(140, inputs.height.width, true)

    v.setFloat32(144, inputs.ambientK, true)
    v.setFloat32(148, FROXEL_Z1, true)
    v.setFloat32(152, FROXEL_ZF, true)
    v.setFloat32(156, FROXEL_Z0, true)

    v.setFloat32(160, FROXEL_NEAR_SLICES, true)
    v.setFloat32(164, inputs.smokeTopM, true)
    v.setFloat32(168, inputs.domainSizeM as number, true)
    this.device.queue.writeBuffer(this.params, 0, buf)
  }
}
