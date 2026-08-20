/**
 * The fire debug overlay pass — WP 2.6.
 *
 * Reads `IFireOutputs` and composites it over the terrain. Explicitly NOT the real fire
 * rendering: M4 owns that (froxel raymarch of the sim's own soot and temperature fields,
 * blackbody flame colour). This is the cheap, obviously-provisional view that lets M2 be
 * judged by eye while it is being built, and it should be deleted or hidden behind a flag
 * when M4 lands.
 *
 * ## It never waits on the solver
 *
 * The acceptance criterion is "no impact on solver timing". So: no `mapAsync`, no
 * `onSubmittedWorkDone`, no `copyTextureToBuffer`, no readback of any kind. It binds the
 * solver's output textures read-only and draws. Every number it displays either comes from
 * the plain-JS fields of `IFireOutputs` or is computed on the GPU inside this pass. If a
 * future version wants a histogram, it must get it without a fence.
 *
 * ## Geometry
 *
 * A procedural grid over the 1 km domain — no vertex buffer, no index buffer, six vertices
 * per quad from `@builtin(vertex_index)`. The grid only has to hug the terrain; the fire
 * itself is sampled per FRAGMENT at the full 0.5 m resolution, so grid density is a
 * z-fighting knob, not a fidelity one.
 */

import type { CameraState } from '@contracts/render.ts'
import type { IFireOutputs } from '@contracts/sim.ts'
import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/sim.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import { FireDebugLegend, type LegendStats } from './legend.ts'
import { FIRE_DEBUG_FS, FIRE_DEBUG_VS, fireDebugShader } from './shaders.ts'
import {
  DEFAULT_RANGES,
  cycleView,
  radianceScaleForExposure,
  viewIndex,
  type FireDebugRanges,
  type FireDebugViewId,
} from './views.ts'

/** mat4 + 16 scalars. Must match `FireDebugUniforms` in shaders/firedebug/firedebug.wgsl. */
const UNIFORM_BYTES = 128

/** Quads per axis. 512 puts the overlay grid at 2 m over a 1 m heightfield. */
export const DEFAULT_GRID_QUADS = 512

/**
 * How far the overlay floats above the terrain mesh, metres.
 *
 * A world-space lift rather than `depthBias`, because the sign of a depth bias depends on
 * the caller's depth convention (WP 1.8 ships reverse-Z-capable cameras and the app passes
 * `depthCompare` in) and getting it wrong makes the overlay silently invisible. A lift is
 * the same in both conventions. It is visible as float at eye level; raise the grid density
 * and lower this if that matters.
 */
export const DEFAULT_LIFT_M = 0.3

export interface FireDebugViewOptions {
  readonly device: GPUDevice
  readonly outputs: IFireOutputs
  /** WP 1.2's r32float heightfield. */
  readonly heightTexture: GPUTexture
  readonly terrainGridN: number
  readonly terrainCellM: number
  readonly colorFormat: GPUTextureFormat
  readonly depthFormat: GPUTextureFormat
  /** The app's depth convention. Passed in for the same reason `TerrainPass` takes it. */
  readonly depthCompare: GPUCompareFunction
  readonly sampleCount: number
  readonly gridQuads?: number
  readonly liftM?: number
  readonly ranges?: FireDebugRanges
  readonly view?: FireDebugViewId
  /** Whole-overlay opacity, 0..1. */
  readonly opacity?: number
  /** If given, a legend element is created and kept in sync with the current view. */
  readonly legendParent?: HTMLElement
  readonly surfaceCells?: number
  readonly surfaceCellM?: number
}

export interface FireDebugFrameState {
  readonly camera: CameraState
  /** Simulated clock seconds (spec §0.6 rule 5), for the legend only. */
  readonly simTimeS: number
  /**
   * The frame's exposure multiplier from `src/app/exposure.ts`. Given, the overlay is scaled
   * to survive tone mapping; omitted, it is written at unit magnitude, which is what you
   * want if it is composited after the tone map instead.
   */
  readonly exposure?: number
  /** `ISurfaceSolver.activeCellCount`, shown in the legend. Not read from the GPU. */
  readonly activeCellCount?: number
}

export class FireDebugView {
  readonly legend: FireDebugLegend | null

  #view: FireDebugViewId
  #ranges: FireDebugRanges
  #opacity: number
  #stats: LegendStats | null = null

  readonly #device: GPUDevice
  readonly #uniformBuffer: GPUBuffer
  readonly #bindGroup: GPUBindGroup
  readonly #pipeline: GPURenderPipeline
  readonly #vertexCount: number
  readonly #outputs: IFireOutputs
  readonly #scratch = new ArrayBuffer(UNIFORM_BYTES)

  private constructor(init: {
    device: GPUDevice
    uniformBuffer: GPUBuffer
    bindGroup: GPUBindGroup
    pipeline: GPURenderPipeline
    options: FireDebugViewOptions
  }) {
    const o = init.options
    this.#device = init.device
    this.#uniformBuffer = init.uniformBuffer
    this.#bindGroup = init.bindGroup
    this.#pipeline = init.pipeline
    this.#outputs = o.outputs
    this.#view = o.view ?? 'state'
    this.#ranges = o.ranges ?? DEFAULT_RANGES
    this.#opacity = o.opacity ?? 1

    const quads = Math.max(1, Math.floor(o.gridQuads ?? DEFAULT_GRID_QUADS))
    this.#vertexCount = quads * quads * 6

    // The static half of the uniform is written once; the per-frame write is a memcpy.
    const f = new Float32Array(this.#scratch)
    f[16] = quads
    f[17] = DOMAIN_SIZE_M
    f[18] = o.terrainGridN
    f[19] = o.terrainCellM
    f[20] = o.surfaceCells ?? SURFACE_CELLS
    f[21] = o.surfaceCellM ?? SURFACE_CELL_M
    f[22] = o.liftM ?? DEFAULT_LIFT_M

    this.legend = o.legendParent ? new FireDebugLegend(o.legendParent.ownerDocument) : null
    if (this.legend && o.legendParent) {
      o.legendParent.append(this.legend.element)
      this.legend.update(this.#view, this.#ranges)
    }
  }

  /** Async for the same reason `TerrainPass.create` is: Dawn compiles lazily otherwise. */
  static async create(options: FireDebugViewOptions): Promise<FireDebugView> {
    const device = options.device
    const uniformBuffer = device.createBuffer({
      label: 'firedebug.uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // All four output textures are read with textureLoad, so `unfilterable-float` — no
    // dependency on float32-filterable for the r32float arrival texture.
    const floatTex = {
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    } as const satisfies Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>

    const layout = device.createBindGroupLayout({
      label: 'firedebug.bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: UNIFORM_BYTES },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, ...floatTex },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'uint', viewDimension: '2d' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, ...floatTex },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, ...floatTex },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, ...floatTex },
      ],
    })

    const out = options.outputs
    const bindGroup = device.createBindGroup({
      label: 'firedebug.bg',
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: options.heightTexture.createView() },
        { binding: 2, resource: out.stateTexture.createView() },
        { binding: 3, resource: out.intensityTexture.createView() },
        { binding: 4, resource: out.arrivalTimeTexture.createView() },
        { binding: 5, resource: out.consumedTexture.createView() },
      ],
    })

    const module = device.createShaderModule({
      label: 'firedebug.wgsl',
      code: fireDebugShader(),
    })

    const pipeline = await device.createRenderPipelineAsync({
      label: 'firedebug',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: FIRE_DEBUG_VS },
      fragment: {
        module,
        entryPoint: FIRE_DEBUG_FS,
        targets: [
          {
            format: options.colorFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              // Destination alpha is left alone: the HDR target's alpha is not the overlay's
              // business, and clobbering it has bitten resolve passes before.
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      // Unculled for the same reason the terrain is: facing is decided in framebuffer
      // coordinates and a wrong winding here means an invisible overlay, which is the one
      // failure mode a debug view must not have.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: options.depthFormat,
        // Reads the depth the terrain and foliage wrote; writes nothing, so it cannot
        // affect anything drawn after it.
        depthWriteEnabled: false,
        depthCompare: options.depthCompare,
      },
      multisample: { count: options.sampleCount },
    })

    return new FireDebugView({ device, uniformBuffer, bindGroup, pipeline, options })
  }

  get view(): FireDebugViewId {
    return this.#view
  }

  set view(v: FireDebugViewId) {
    this.#view = v
    this.legend?.update(v, this.#ranges, this.#stats ?? undefined)
  }

  /** The toggle. Bind a key to this. */
  cycle(step = 1): FireDebugViewId {
    this.view = cycleView(this.#view, step)
    return this.#view
  }

  get ranges(): FireDebugRanges {
    return this.#ranges
  }

  setRanges(ranges: FireDebugRanges): void {
    this.#ranges = ranges
    this.legend?.update(this.#view, ranges, this.#stats ?? undefined)
  }

  setOpacity(opacity: number): void {
    this.#opacity = Math.min(1, Math.max(0, opacity))
  }

  update(state: FireDebugFrameState): void {
    const f = new Float32Array(this.#scratch)
    const u = new Uint32Array(this.#scratch)
    f.set(state.camera.viewProjMatrix.subarray(0, 16), 0)
    f[23] = this.#opacity
    u[24] = viewIndex(this.#view) >>> 0
    f[25] = state.simTimeS
    f[26] = this.#ranges.isochroneIntervalS
    f[27] = this.#ranges.arrivalMaxS
    f[28] = Math.log(Math.max(this.#ranges.intensityMinKWm, 1e-6))
    f[29] = Math.log(Math.max(this.#ranges.intensityMaxKWm, 1e-6))
    f[30] = state.exposure === undefined ? 1 : radianceScaleForExposure(state.exposure)
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, this.#scratch)

    if (this.legend) {
      this.#stats = {
        burntAreaM2: this.#outputs.burntAreaM2,
        perimeterM: this.#outputs.perimeterM,
        maxFirelineIntensityKWm: this.#outputs.maxFirelineIntensity,
        activeCellCount: state.activeCellCount ?? 0,
        simTimeS: state.simTimeS,
      }
      this.legend.update(this.#view, this.#ranges, this.#stats)
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.#pipeline)
    pass.setBindGroup(0, this.#bindGroup)
    pass.draw(this.#vertexCount)
  }

  destroy(): void {
    this.#uniformBuffer.destroy()
    this.legend?.destroy()
  }
}
