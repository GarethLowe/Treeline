/**
 * HDR render targets and the resolve (exposure + tone map + sRGB) pass to the swapchain.
 *
 * Why the world is not drawn straight to the canvas: WP 1.5's foliage config defaults to an
 * `rgba16float` colour target and WP 1.7's sky defaults to `linear-hdr` output, and both are
 * right — the sun disc is ~1e7 W/(m² sr) and no 8-bit buffer holds it alongside a night sky.
 * So there is an HDR target, and this file owns it, the depth buffer, and the one pass that
 * turns radiance into pixels.
 *
 * It is also where `QualitySettings.resolutionScale` actually does something. The quality
 * controller (WP 1.1) is otherwise a number the HUD prints: the froxel and particle knobs it
 * moves belong to passes that do not exist until M4. Rendering at a scaled resolution and
 * upsampling in the resolve gives it a real lever at M1, which matters because an adaptive
 * controller nobody has ever seen adapt is an untested controller.
 */

// `src/camera` has no path alias in tsconfig.json (the alias list predates WP 1.8), so the
// camera package is reached relatively throughout src/app.
import { DEPTH_FORMAT } from '../camera/math.ts'
import RESOLVE_WGSL from '../../shaders/app/tonemap.wgsl?raw'

export interface RenderTargetOptions {
  readonly device: GPUDevice
  /** Backbuffer size in physical pixels. */
  readonly widthPx: number
  readonly heightPx: number
  /** `QualitySettings.resolutionScale`. */
  readonly resolutionScale: number
  readonly colorFormat?: GPUTextureFormat
  readonly sampleCount?: number
}

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float'

export class RenderTargets {
  readonly device: GPUDevice
  readonly colorFormat: GPUTextureFormat
  readonly depthFormat: GPUTextureFormat = DEPTH_FORMAT
  readonly sampleCount: number

  #color: GPUTexture
  #depth: GPUTexture
  #colorView: GPUTextureView
  #depthView: GPUTextureView
  #width: number
  #height: number
  #scale: number

  constructor(options: RenderTargetOptions) {
    this.device = options.device
    this.colorFormat = options.colorFormat ?? HDR_FORMAT
    this.sampleCount = options.sampleCount ?? 1
    this.#width = 1
    this.#height = 1
    this.#scale = options.resolutionScale
    const size = scaledSize(options.widthPx, options.heightPx, options.resolutionScale)
    this.#width = size.width
    this.#height = size.height
    this.#color = this.#makeColor()
    this.#depth = this.#makeDepth()
    this.#colorView = this.#color.createView()
    this.#depthView = this.#depth.createView()
  }

  get width(): number {
    return this.#width
  }
  get height(): number {
    return this.#height
  }
  get resolutionScale(): number {
    return this.#scale
  }
  get colorView(): GPUTextureView {
    return this.#colorView
  }
  get depthView(): GPUTextureView {
    return this.#depthView
  }
  get colorTexture(): GPUTexture {
    return this.#color
  }

  /** Returns true when the textures were rebuilt, so dependent bind groups can be recreated. */
  resize(widthPx: number, heightPx: number, resolutionScale: number): boolean {
    const size = scaledSize(widthPx, heightPx, resolutionScale)
    this.#scale = resolutionScale
    if (size.width === this.#width && size.height === this.#height) return false
    this.#width = size.width
    this.#height = size.height
    this.#color.destroy()
    this.#depth.destroy()
    this.#color = this.#makeColor()
    this.#depth = this.#makeDepth()
    this.#colorView = this.#color.createView()
    this.#depthView = this.#depth.createView()
    return true
  }

  destroy(): void {
    this.#color.destroy()
    this.#depth.destroy()
  }

  #makeColor(): GPUTexture {
    return this.device.createTexture({
      label: 'hdr-color',
      size: { width: this.#width, height: this.#height },
      format: this.colorFormat,
      sampleCount: this.sampleCount,
      // STORAGE_BINDING for M4's volumetric composite, which applies per-channel transmittance
      // in a compute pass. An alpha blend cannot: the blend equation carries one alpha and
      // transmittance is three numbers, and collapsing them greys the plume instead of
      // reddening it — the most recognisable thing about smoke.
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING,
    })
  }

  #makeDepth(): GPUTexture {
    return this.device.createTexture({
      label: 'hdr-depth',
      size: { width: this.#width, height: this.#height },
      format: this.depthFormat,
      sampleCount: this.sampleCount,
      // TEXTURE_BINDING so the froxel march can stop at solid geometry. Without it the plume
      // draws over the terrain in front of it.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
  }
}

function scaledSize(widthPx: number, heightPx: number, scale: number): { width: number; height: number } {
  const s = Math.min(1, Math.max(0.25, Number.isFinite(scale) ? scale : 1))
  return {
    width: Math.max(1, Math.round(widthPx * s)),
    height: Math.max(1, Math.round(heightPx * s)),
  }
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolvePassOptions {
  readonly device: GPUDevice
  readonly targetFormat: GPUTextureFormat
  /** Paint magenta instead of black when a NaN reaches the resolve. */
  readonly paintNanMagenta?: boolean
}

export class ResolvePass {
  readonly #device: GPUDevice
  readonly #pipeline: GPURenderPipeline
  readonly #layout: GPUBindGroupLayout
  readonly #sampler: GPUSampler
  readonly #uniform: GPUBuffer
  readonly #params = new Float32Array(4)
  #bindGroup: GPUBindGroup | null = null
  #boundView: GPUTextureView | null = null

  private constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
    uniform: GPUBuffer,
    paintNanMagenta: boolean,
  ) {
    this.#device = device
    this.#pipeline = pipeline
    this.#layout = layout
    this.#sampler = sampler
    this.#uniform = uniform
    this.#params[1] = paintNanMagenta ? 1 : 0
  }

  static async create(options: ResolvePassOptions): Promise<ResolvePass> {
    const { device } = options
    const module = device.createShaderModule({ label: 'resolve.wgsl', code: RESOLVE_WGSL })
    const layout = device.createBindGroupLayout({
      label: 'resolve.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 16 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })
    const pipeline = await device.createRenderPipelineAsync({
      label: 'resolve',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs_resolve' },
      fragment: { module, entryPoint: 'fs_resolve', targets: [{ format: options.targetFormat }] },
      primitive: { topology: 'triangle-list' },
    })
    const sampler = device.createSampler({
      label: 'resolve.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    const uniform = device.createBuffer({
      label: 'resolve.uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    return new ResolvePass(device, pipeline, layout, sampler, uniform, options.paintNanMagenta ?? true)
  }

  /** Rebind when the HDR target has been recreated. Cheap, and idempotent. */
  bind(hdrView: GPUTextureView): void {
    if (this.#boundView === hdrView && this.#bindGroup !== null) return
    this.#boundView = hdrView
    this.#bindGroup = this.#device.createBindGroup({
      label: 'resolve.bg',
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: hdrView },
        { binding: 2, resource: this.#sampler },
      ],
    })
  }

  draw(pass: GPURenderPassEncoder, exposure: number): void {
    if (this.#bindGroup === null) throw new Error('ResolvePass.draw() before bind()')
    this.#params[0] = exposure
    this.#device.queue.writeBuffer(this.#uniform, 0, this.#params)
    pass.setPipeline(this.#pipeline)
    pass.setBindGroup(0, this.#bindGroup)
    pass.draw(3)
  }

  destroy(): void {
    this.#uniform.destroy()
  }
}
