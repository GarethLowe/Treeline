/**
 * `IEnvironmentLighting` — SH irradiance for diffuse, prefiltered cube for specular.
 *
 * AMORTISATION IS THE WHOLE DESIGN. Rebuilding a 128^2 environment cube and its GGX-prefiltered
 * mip chain every frame would cost more than the entire 6 ms geometry budget for something that
 * changes at 15 degrees per hour of simulated time. So the work is broken into eleven jobs — one
 * SH projection, one capture dispatch per mip, one prefilter dispatch per mip — and at most a
 * couple are executed per `update()`. The full chain refreshes in five or six frames, and only
 * when the sun has actually moved past a threshold (0.25 deg by default, about one minute of
 * real time, or less under time acceleration).
 *
 * The SH projection runs on the CPU against the analytic sky rather than by reducing the cube on
 * the GPU. Two reasons: the analytic model is exact where a 128^2 cube is quantised, and a CPU
 * projection is unit-testable without a device — the SH round-trip test is the one that proves
 * the irradiance a surface receives from this environment is the irradiance the solar model
 * said the sky was delivering.
 */

import type { SolarState } from '@contracts/render.ts'
import {
  environmentRadiance,
  packSkyUniforms,
  SKY_UNIFORM_BYTES,
  type SkyEnvironment,
} from './sky-model.ts'
import {
  addDirectionalToSh,
  convolveWithCosineLobe,
  packShToFloat32,
  projectRadianceToSh,
  SH_BUFFER_BYTES,
  type ShRgb,
} from './sh.ts'
import { createSkyUniformBindGroupLayout, envCaptureSource, envPrefilterSource } from './shaders.ts'
import type { SkyRenderer } from './sky-renderer.ts'

export interface EnvironmentLightingOptions {
  /** Face size of the environment cube in texels. 128 gives a 0.8 MB cube at rgba16float. */
  readonly cubeSize?: number
  /** Mip levels; mip m holds roughness m/(mipCount-1). */
  readonly mipCount?: number
  /** GGX samples per texel in the prefilter. */
  readonly prefilterSamples?: number
  /** Directions used for the CPU SH projection. The sky is smooth; 1024 is ample for order 2. */
  readonly shSamples?: number
  /** GPU jobs executed per `update()` call. Two gives a full refresh in ~6 frames. */
  readonly jobsPerUpdate?: number
  /** Sun movement, radians, that triggers a rebuild. Default 0.25 deg. */
  readonly rebuildEpsilon?: number
  /**
   * Whether the direct solar beam is folded into the SH irradiance. Default false: the PBR pass
   * applies the sun as an analytic directional light built from the same `SolarState`, and
   * including it here as well would double-count it. Set true only for a renderer that has no
   * separate key light.
   */
  readonly includeSunInIrradiance?: boolean
  readonly label?: string
}

type Job = { readonly kind: 'sh' } | { readonly kind: 'capture' | 'prefilter'; readonly mip: number }

/** The solar/atmospheric state the current cube and SH were built from. */
interface BuiltFrom {
  readonly elevation: number
  readonly azimuth: number
  readonly skyIrradiance: number
  readonly moonIrradiance: number
  readonly directIrradiance: number
  readonly turbidity: number
}

export class EnvironmentLighting {
  readonly device: GPUDevice
  readonly irradianceSH: GPUBuffer
  readonly specularCube: GPUTexture
  /** Cube the specular prefilter reads from: the raw analytic sky, all mips. */
  readonly captureCube: GPUTexture
  readonly bindGroupLayout: GPUBindGroupLayout
  readonly cubeSize: number
  readonly mipCount: number

  private readonly sky: SkyRenderer
  private readonly options: Required<Omit<EnvironmentLightingOptions, 'label'>>
  private readonly sampler: GPUSampler

  private readonly skyUniformBuffer: GPUBuffer
  private readonly skyUniformBindGroup: GPUBindGroup

  private readonly capturePipeline: GPUComputePipeline
  private readonly captureBindGroups: GPUBindGroup[] = []
  private readonly prefilterPipeline: GPUComputePipeline
  private readonly prefilterBindGroups: GPUBindGroup[] = []
  private readonly transientBuffers: GPUBuffer[] = []

  private readonly specularView: GPUTextureView

  private queue: Job[] = []
  private pendingEnv: SkyEnvironment | null = null
  private builtFrom: BuiltFrom | null = null
  private lastIrradianceSh: ShRgb | null = null
  private updates = 0

  constructor(device: GPUDevice, sky: SkyRenderer, options: EnvironmentLightingOptions = {}) {
    this.device = device
    this.sky = sky
    const label = options.label ?? 'sky-env'
    this.options = {
      cubeSize: options.cubeSize ?? 128,
      mipCount: options.mipCount ?? 5,
      prefilterSamples: options.prefilterSamples ?? 64,
      shSamples: options.shSamples ?? 1024,
      jobsPerUpdate: options.jobsPerUpdate ?? 2,
      rebuildEpsilon: options.rebuildEpsilon ?? (0.25 * Math.PI) / 180,
      includeSunInIrradiance: options.includeSunInIrradiance ?? false,
    }
    this.cubeSize = this.options.cubeSize
    this.mipCount = this.options.mipCount

    const cubeDesc = {
      size: { width: this.cubeSize, height: this.cubeSize, depthOrArrayLayers: 6 },
      mipLevelCount: this.mipCount,
      format: 'rgba16float' as GPUTextureFormat,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      dimension: '2d' as GPUTextureDimension,
    }
    this.captureCube = device.createTexture({ ...cubeDesc, label: `${label}-capture` })
    this.specularCube = device.createTexture({ ...cubeDesc, label: `${label}-specular` })
    this.specularView = this.specularCube.createView({ dimension: 'cube' })

    this.irradianceSH = device.createBuffer({
      label: `${label}-sh`,
      size: SH_BUFFER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.sampler = device.createSampler({
      label: `${label}-sampler`,
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    // --- sky uniforms (own copy: the capture must not read camera values written for a frame) --
    const skyUniformLayout = createSkyUniformBindGroupLayout(device)
    this.skyUniformBuffer = device.createBuffer({
      label: `${label}-sky-uniforms`,
      size: SKY_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.skyUniformBindGroup = device.createBindGroup({
      layout: skyUniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.skyUniformBuffer } }],
    })

    // --- capture pipeline ----------------------------------------------------
    const captureGroupLayout = device.createBindGroupLayout({
      label: `${label}-capture-layout`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d-array',
          },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    })
    this.capturePipeline = device.createComputePipeline({
      label: `${label}-capture`,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [skyUniformLayout, captureGroupLayout],
      }),
      compute: {
        module: device.createShaderModule({ label: 'sky-env-capture', code: envCaptureSource() }),
        entryPoint: 'capture_face',
      },
    })

    for (let mip = 0; mip < this.mipCount; mip++) {
      const size = Math.max(1, this.cubeSize >> mip)
      const params = device.createBuffer({
        label: `${label}-capture-params-${mip}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(params, 0, new Uint32Array([size, 0, 0, 0]))
      this.transientBuffers.push(params)
      this.captureBindGroups.push(
        device.createBindGroup({
          label: `${label}-capture-bg-${mip}`,
          layout: captureGroupLayout,
          entries: [
            {
              binding: 0,
              resource: this.captureCube.createView({
                dimension: '2d-array',
                baseMipLevel: mip,
                mipLevelCount: 1,
                baseArrayLayer: 0,
                arrayLayerCount: 6,
              }),
            },
            { binding: 1, resource: { buffer: params } },
          ],
        }),
      )
    }

    // --- prefilter pipeline --------------------------------------------------
    const prefilterGroupLayout = device.createBindGroupLayout({
      label: `${label}-prefilter-layout`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d-array',
          },
        },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    })
    this.prefilterPipeline = device.createComputePipeline({
      label: `${label}-prefilter`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [prefilterGroupLayout] }),
      compute: {
        module: device.createShaderModule({
          label: 'sky-env-prefilter',
          code: envPrefilterSource(),
        }),
        entryPoint: 'prefilter',
      },
    })

    const captureCubeView = this.captureCube.createView({ dimension: 'cube' })
    for (let mip = 0; mip < this.mipCount; mip++) {
      const size = Math.max(1, this.cubeSize >> mip)
      const roughness = this.mipCount > 1 ? mip / (this.mipCount - 1) : 0
      const params = device.createBuffer({
        label: `${label}-prefilter-params-${mip}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(
        params,
        0,
        new Float32Array([roughness, size, this.cubeSize, this.options.prefilterSamples]),
      )
      this.transientBuffers.push(params)
      this.prefilterBindGroups.push(
        device.createBindGroup({
          label: `${label}-prefilter-bg-${mip}`,
          layout: prefilterGroupLayout,
          entries: [
            { binding: 0, resource: captureCubeView },
            { binding: 1, resource: this.sampler },
            {
              binding: 2,
              resource: this.specularCube.createView({
                dimension: '2d-array',
                baseMipLevel: mip,
                mipLevelCount: 1,
                baseArrayLayer: 0,
                arrayLayerCount: 6,
              }),
            },
            { binding: 3, resource: { buffer: params } },
          ],
        }),
      )
    }

    // --- what consumers bind -------------------------------------------------
    this.bindGroupLayout = device.createBindGroupLayout({
      label: `${label}-consumer-layout`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
      ],
    })
  }

  /** Bind group a shading pass uses: SH buffer, prefiltered cube, sampler. */
  createBindGroup(device: GPUDevice = this.device): GPUBindGroup {
    return device.createBindGroup({
      label: 'sky-env-consumer',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.irradianceSH } },
        { binding: 1, resource: this.specularView },
        { binding: 2, resource: this.sampler },
      ],
    })
  }

  /** True when no environment work is outstanding. */
  get isConverged(): boolean {
    return this.queue.length === 0 && this.builtFrom !== null
  }

  /** Latest CPU-side irradiance SH (post cosine convolution). Null before the first update. */
  get irradianceShCoefficients(): ShRgb | null {
    return this.lastIrradianceSh
  }

  /** Number of `update()` calls made. Used by the integrator's smoke test. */
  get updateCount(): number {
    return this.updates
  }

  /**
   * Encode at most `jobsPerUpdate` environment jobs. Safe to call every frame: when the sun has
   * not moved and the chain is complete, this does nothing at all.
   */
  update(encoder: GPUCommandEncoder, solar: SolarState): void {
    this.updates++
    const env = this.sky.environmentFor(solar)

    if (this.needsRebuild(env)) {
      this.builtFrom = {
        elevation: env.solar.geometry.apparentElevationRad,
        azimuth: env.solar.azimuth,
        skyIrradiance: env.skyIrradiance,
        moonIrradiance: env.moonIrradiance,
        directIrradiance: env.solar.directIrradiance,
        turbidity: env.solarLobe.turbidity,
      }
      this.pendingEnv = env
      // Upload the sky coefficients this rebuild will be captured from. Identity view matrix:
      // the capture derives directions from the cube face, never from the camera.
      this.device.queue.writeBuffer(
        this.skyUniformBuffer,
        0,
        packSkyUniforms(env, {
          invViewProjMatrix: IDENTITY4,
          cameraPosition: [0, 0, 0],
          exposure: 1,
          outputMode: 'linear-hdr',
          plumeOpticalDepth: this.sky.atmosphere.plumeOpticalDepth,
          groundAlbedo: this.sky.atmosphere.groundAlbedo,
        }),
      )
      this.queue = [{ kind: 'sh' }]
      for (let mip = 0; mip < this.mipCount; mip++) this.queue.push({ kind: 'capture', mip })
      for (let mip = 0; mip < this.mipCount; mip++) this.queue.push({ kind: 'prefilter', mip })
    }

    let budget = this.options.jobsPerUpdate
    while (budget > 0 && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.runJob(encoder, job)
      budget--
    }
  }

  /** Force the whole chain to be rebuilt on the next `update()`. */
  invalidate(): void {
    this.builtFrom = null
  }

  destroy(): void {
    this.irradianceSH.destroy()
    this.skyUniformBuffer.destroy()
    for (const b of this.transientBuffers) b.destroy()
    this.captureCube.destroy()
    this.specularCube.destroy()
  }

  // -------------------------------------------------------------------------

  private runJob(encoder: GPUCommandEncoder, job: Job): void {
    const env = this.pendingEnv
    if (!env) return

    if (job.kind === 'sh') {
      this.projectSh(env)
      return
    }

    const size = Math.max(1, this.cubeSize >> job.mip)
    const groups = Math.ceil(size / 8)

    if (job.kind === 'capture') {
      const pass = encoder.beginComputePass({ label: `sky-env-capture-mip${job.mip}` })
      pass.setPipeline(this.capturePipeline)
      pass.setBindGroup(0, this.skyUniformBindGroup)
      pass.setBindGroup(1, this.captureBindGroups[job.mip]!)
      pass.dispatchWorkgroups(groups, groups, 6)
      pass.end()
      return
    }

    const pass = encoder.beginComputePass({ label: `sky-env-prefilter-mip${job.mip}` })
    pass.setPipeline(this.prefilterPipeline)
    pass.setBindGroup(0, this.prefilterBindGroups[job.mip]!)
    pass.dispatchWorkgroups(groups, groups, 6)
    pass.end()
  }

  private projectSh(env: SkyEnvironment): void {
    const sh = computeIrradianceSh(env, this.options.shSamples, this.options.includeSunInIrradiance)
    this.lastIrradianceSh = sh
    this.device.queue.writeBuffer(this.irradianceSH, 0, packShToFloat32(sh))
  }

  /**
   * Has the environment moved enough to be worth rebuilding?
   *
   * Compared against the state the current cube was actually BUILT from, not against quantisation
   * bins. Bins were the first attempt and they flap: a sun sitting on a bin edge crosses it back
   * and forth and rebuilds the whole chain every few frames for a movement of a thousandth of a
   * degree. Hysteresis against the last build has the semantics we actually want — "how far has
   * it drifted since the lighting was last correct" — and irradiance is compared relatively so
   * the same 2% rule works at 900 W/m^2 and at the 2e-6 W/m^2 of a moonless night.
   */
  private needsRebuild(env: SkyEnvironment): boolean {
    const built = this.builtFrom
    if (!built) return true
    const e = this.options.rebuildEpsilon
    if (Math.abs(env.solar.geometry.apparentElevationRad - built.elevation) > e) return true
    if (Math.abs(angleDelta(env.solar.azimuth, built.azimuth)) > e) return true
    if (relativeChange(env.skyIrradiance, built.skyIrradiance) > 0.02) return true
    if (relativeChange(env.moonIrradiance, built.moonIrradiance) > 0.02) return true
    if (relativeChange(env.solar.directIrradiance, built.directIrradiance) > 0.02) return true
    if (Math.abs(env.solarLobe.turbidity - built.turbidity) > 1e-6) return true
    return false
  }
}

/** Smallest signed difference between two bearings, radians. */
function angleDelta(a: number, b: number): number {
  const twoPi = 2 * Math.PI
  let d = (a - b) % twoPi
  if (d > Math.PI) d -= twoPi
  if (d < -Math.PI) d += twoPi
  return d
}

/** Relative change between two non-negative quantities, robust at zero. */
function relativeChange(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12)
  return Math.abs(a - b) / denom
}

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/**
 * Irradiance SH for a sky environment. Exposed as a free function because it is pure and is
 * what the tests assert against — the GPU class is a thin wrapper around it.
 *
 * The sky lobes are projected by sampling; the sun and moon are added analytically, because a
 * disc a third of a degree across would be missed entirely by any practical sample count.
 */
export function computeIrradianceSh(
  env: SkyEnvironment,
  samples = 1024,
  includeSun = false,
): ShRgb {
  let radianceSh = projectRadianceToSh((dir) => environmentRadiance(env, dir), samples)

  if (includeSun && env.solar.directIrradiance > 0) {
    // A directional source delivering E W/m^2 normal to the beam.
    const e = env.solar.directIrradiance
    const c = env.solar.beamColor
    const peak = Math.max(c[0], c[1], c[2], 1e-6)
    radianceSh = addDirectionalToSh(radianceSh, env.solar.direction, [
      (e * c[0]) / peak,
      (e * c[1]) / peak,
      (e * c[2]) / peak,
    ])
  }

  if (env.moon.elevation > 0 && env.moon.illuminanceLux > 0) {
    // Moonlight, as a directional source. The horizontal illuminance already includes the
    // cosine of the moon's altitude, so it is divided back out to recover the normal irradiance.
    const eHorizontal = env.moonIrradiance
    const eNormal = eHorizontal / Math.max(0.02, Math.sin(env.moon.elevation))
    radianceSh = addDirectionalToSh(radianceSh, env.moon.direction, [
      eNormal * 0.95,
      eNormal * 0.97,
      eNormal,
    ])
  }

  return convolveWithCosineLobe(radianceSh)
}
