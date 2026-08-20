/**
 * Near-field flames — WP 4.5.
 *
 * Until this existed nothing in the renderer drew fire. WP 2.6's false-colour overlay put an
 * arrival-time stain on the ground and M4's froxel volumetrics carried the smoke, but the
 * flame itself — the brightest, most recognisable thing in the whole scene — was absent.
 *
 * Reads only the public `IFireOutputs` textures, so it is a renderer that watches the solver
 * rather than a second copy of it. See `shaders/render/flames/flames.wgsl` for the two stages
 * and for what the approximation does and does not model.
 *
 * **No textures.** The shape is procedural and the colour is the blackbody LUT from
 * `render/volumetrics/blackbody.ts`, which is `validated` against CIE illuminant A. A flame
 * here is the same physics as the glow the froxel march emits.
 */

import flamesWgsl from '../../../shaders/render/flames/flames.wgsl?raw'
import commonWgsl from '../../../shaders/foliage/common.wgsl?raw'
import { foliagePrelude } from '@render/foliage/shaderPrelude.ts'
import { DOMAIN_SIZE_M, SURFACE_CELLS } from '@contracts/world'
import { DEFAULT_FLAME_TEMPERATURE_K } from '@sim/canopy/radiation/optics.ts'
import { LUT_MIN_K, LUT_MAX_K, LUT_SIZE, buildBlackbodyLut } from '@render/volumetrics/blackbody.ts'
import { rawBuffer } from '@gpu/raw.ts'

/**
 * Surface cells per billboard, per axis.
 *
 * The surface grid is 2048² at 0.5 m. One flame per cell would be 4.2 M candidate threads and
 * far more geometry than a metre of burning ground warrants, so the gather scans in blocks.
 * 2 gives one flame per metre, which is finer than the flame lengths this model produces for
 * anything short of a crown fire.
 */
export const FLAME_STRIDE = 2

/**
 * Billboards per frame.
 *
 * A fast-moving head fire in grass runs ~10 k active cells; at stride 2 that is ~2.5 k
 * billboards. 65536 leaves room for a large multi-front fire and costs 1 MiB. Overflow is
 * dropped and counted rather than wrapped — see the note in the shader.
 */
export const MAX_FLAMES = 65536

const UNIFORM_BYTES = 128
const INSTANCE_BYTES = 16
/** vertexCount, instanceCount, firstVertex, firstInstance. */
const DRAW_ARGS_BYTES = 16
const VERTS_PER_FLAME = 6

export interface FlameRendererInit {
  readonly device: GPUDevice
  readonly stateTexture: GPUTexture
  readonly intensityTexture: GPUTexture
  readonly heightTexture: GPUTexture
  readonly colorFormat: GPUTextureFormat
  readonly depthFormat: GPUTextureFormat
  readonly depthCompare: GPUCompareFunction
}

export class FlameRenderer {
  readonly #device: GPUDevice
  readonly #uniform: GPUBuffer
  readonly #list: GPUBuffer
  readonly #count: GPUBuffer
  readonly #args: GPUBuffer
  readonly #countReadback: GPUBuffer
  readonly #lut: GPUTexture
  readonly #sharedGroup: GPUBindGroup
  readonly #gatherGroup: GPUBindGroup
  readonly #drawGroup: GPUBindGroup
  readonly #gather: GPUComputePipeline
  readonly #draw: GPURenderPipeline
  readonly #scratch = new ArrayBuffer(UNIFORM_BYTES)

  /** Billboards emitted by the last gather that was read back. `?debug` prints it. */
  lastFlameCount = 0
  /**
   * Readback cycle. A staging buffer may not be written by a submit while it is mapped OR
   * while a map is pending, and `mapAsync` must not be called on a buffer this frame's
   * not-yet-submitted encoder is about to write. So the copy is issued in one frame and
   * consumed at the start of a later one, never both at once.
   */
  #readback: 'idle' | 'copied' | 'mapping' = 'idle'

  private constructor(parts: {
    device: GPUDevice
    uniform: GPUBuffer
    list: GPUBuffer
    count: GPUBuffer
    args: GPUBuffer
    countReadback: GPUBuffer
    lut: GPUTexture
    sharedGroup: GPUBindGroup
    gatherGroup: GPUBindGroup
    drawGroup: GPUBindGroup
    gather: GPUComputePipeline
    draw: GPURenderPipeline
  }) {
    this.#device = parts.device
    this.#uniform = parts.uniform
    this.#list = parts.list
    this.#count = parts.count
    this.#args = parts.args
    this.#countReadback = parts.countReadback
    this.#lut = parts.lut
    this.#sharedGroup = parts.sharedGroup
    this.#gatherGroup = parts.gatherGroup
    this.#drawGroup = parts.drawGroup
    this.#gather = parts.gather
    this.#draw = parts.draw
  }

  static async create(init: FlameRendererInit): Promise<FlameRenderer> {
    const { device } = init
    const S = GPUBufferUsage.STORAGE
    const CD = GPUBufferUsage.COPY_DST

    const uniform = device.createBuffer({
      label: 'flames.uniform',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | CD,
    })
    const list = device.createBuffer({
      label: 'flames.list',
      size: MAX_FLAMES * INSTANCE_BYTES,
      usage: S,
    })
    const count = device.createBuffer({
      label: 'flames.count',
      size: 4,
      usage: S | CD | GPUBufferUsage.COPY_SRC,
    })
    // Separate from `count` because WebGPU's usage-scope rule forbids one buffer being both
    // writable storage and the indirect source; the count is copied across each frame.
    const args = device.createBuffer({
      label: 'flames.drawArgs',
      size: DRAW_ARGS_BYTES,
      usage: GPUBufferUsage.INDIRECT | CD,
    })
    device.queue.writeBuffer(args, 0, new Uint32Array([VERTS_PER_FLAME, 0, 0, 0]))

    const countReadback = device.createBuffer({
      label: 'flames.count.readback',
      size: 4,
      usage: CD | GPUBufferUsage.MAP_READ,
    })

    const lut = device.createTexture({
      label: 'flames.blackbodyLut',
      size: { width: LUT_SIZE },
      dimension: '1d',
      // rgba32float: the chroma is unit-luminance and an 8-bit LUT visibly bands the ramp from
      // deep red to white, which is exactly the part of a flame the eye reads.
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const lutData = buildBlackbodyLut()
    device.queue.writeTexture(
      { texture: lut },
      rawBuffer(lutData),
      { bytesPerRow: LUT_SIZE * 16 },
      { width: LUT_SIZE },
    )

    // See the three-group note at the top of flames.wgsl: a read_write storage buffer cannot
    // be visible to the vertex stage, so the list is bound writable to the gather and
    // read-only to the draw.
    const sharedLayout = device.createBindGroupLayout({
      label: 'flames.bgl.shared',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: UNIFORM_BYTES },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '1d' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })
    const gatherLayout = device.createBindGroupLayout({
      label: 'flames.bgl.gather',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'uint', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    const drawLayout = device.createBindGroupLayout({
      label: 'flames.bgl.draw',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })

    const sharedGroup = device.createBindGroup({
      label: 'flames.bg.shared',
      layout: sharedLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: init.heightTexture.createView() },
        { binding: 2, resource: lut.createView({ dimension: '1d' }) },
        {
          binding: 3,
          resource: device.createSampler({
            label: 'flames.lutSampler',
            magFilter: 'linear',
            minFilter: 'linear',
          }),
        },
      ],
    })
    const gatherGroup = device.createBindGroup({
      label: 'flames.bg.gather',
      layout: gatherLayout,
      entries: [
        { binding: 0, resource: { buffer: list } },
        { binding: 1, resource: { buffer: count } },
        { binding: 2, resource: init.stateTexture.createView() },
        { binding: 3, resource: init.intensityTexture.createView() },
      ],
    })
    const drawGroup = device.createBindGroup({
      label: 'flames.bg.draw',
      layout: drawLayout,
      entries: [{ binding: 0, resource: { buffer: list } }],
    })

    // `common.wgsl` supplies `terrainHeightAt`, `hash2` and `rnd01`; the prelude supplies the
    // constants it is written against. Same composition as the sun-occlusion pass.
    const code = [
      foliagePrelude({ useSubgroups: false, ditherAlpha: false }),
      commonWgsl,
      `const SIGMA_SB : f32 = ${5.670374419e-8};`,
      `const LUT_MIN_K : f32 = ${LUT_MIN_K.toFixed(1)};`,
      `const LUT_MAX_K : f32 = ${LUT_MAX_K.toFixed(1)};`,
      flamesWgsl,
    ].join('\n\n')
    const module = device.createShaderModule({ label: 'flames', code })
    // An entry point only has to be compatible with the groups it actually references, so the
    // gather's layout can stop at group 1 and the draw's can put an empty layout in that slot.
    const empty = device.createBindGroupLayout({ label: 'flames.bgl.empty', entries: [] })
    const gatherPl = device.createPipelineLayout({ bindGroupLayouts: [sharedLayout, gatherLayout] })
    const drawPl = device.createPipelineLayout({
      bindGroupLayouts: [sharedLayout, empty, drawLayout],
    })

    const [gather, draw] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'flames.gather',
        layout: gatherPl,
        compute: { module, entryPoint: 'csGather' },
      }),
      device.createRenderPipelineAsync({
        label: 'flames.draw',
        layout: drawPl,
        vertex: { module, entryPoint: 'vsFlame' },
        fragment: {
          module,
          entryPoint: 'fsFlame',
          targets: [
            {
              format: init.colorFormat,
              // ADDITIVE. A flame emits; it does not occlude what is behind it, and an alpha
              // blend would darken the smoke and terrain it overlaps instead of adding to it.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
          format: init.depthFormat,
          // Tested so flames behind a trunk are hidden, but NOT written: they are a
          // participating emitter, and writing depth would let one billboard occlude the next
          // and punch a hole in the smoke behind them.
          depthWriteEnabled: false,
          depthCompare: init.depthCompare,
        },
      }),
    ])

    return new FlameRenderer({
      device,
      uniform,
      list,
      count,
      args,
      countReadback,
      lut,
      sharedGroup,
      gatherGroup,
      drawGroup,
      gather,
      draw,
    })
  }

  /** Rebuild the billboard list from this frame's solver state. Before the world pass. */
  gather(
    encoder: GPUCommandEncoder,
    frame: {
      readonly viewProj: Float32Array
      readonly cameraPos: readonly [number, number, number]
      readonly timeSec: number
      readonly windDirX: number
      readonly windDirZ: number
      readonly windSpeed: number
    },
  ): void {
    const f = new Float32Array(this.#scratch)
    f.set(frame.viewProj.subarray(0, 16), 0)
    f[16] = frame.cameraPos[0]
    f[17] = frame.cameraPos[1]
    f[18] = frame.cameraPos[2]
    f[19] = frame.timeSec
    f[20] = DOMAIN_SIZE_M as number
    f[21] = SURFACE_CELLS as number
    f[22] = FLAME_STRIDE
    f[23] = MAX_FLAMES
    f[24] = frame.windDirX
    f[25] = frame.windDirZ
    f[26] = frame.windSpeed
    f[27] = DEFAULT_FLAME_TEMPERATURE_K as number
    this.#device.queue.writeBuffer(this.#uniform, 0, this.#scratch)

    encoder.clearBuffer(this.#count)
    const pass = encoder.beginComputePass({ label: 'flames.gather' })
    pass.setPipeline(this.#gather)
    pass.setBindGroup(0, this.#sharedGroup)
    pass.setBindGroup(1, this.#gatherGroup)
    const blocks = Math.ceil(SURFACE_CELLS / FLAME_STRIDE / 8)
    pass.dispatchWorkgroups(blocks, blocks)
    pass.end()

    // The count becomes the indirect instance count. A copy rather than a second dispatch:
    // the value is already exactly the u32 the draw args want.
    encoder.copyBufferToBuffer(this.#count, 0, this.#args, 4, 4)

    // Consume the PREVIOUS frame's copy first: its command buffer has been submitted by now,
    // so mapping is legal. Doing this at the end of the same frame that issued the copy is
    // "used in submit while pending map", which discards the whole frame.
    if (this.#readback === 'copied') {
      this.#readback = 'mapping'
      void this.#countReadback
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.lastFlameCount =
            new Uint32Array(this.#countReadback.getMappedRange().slice(0))[0] ?? 0
          this.#countReadback.unmap()
        })
        .catch(() => undefined)
        .finally(() => {
          this.#readback = 'idle'
        })
    } else if (this.#readback === 'idle') {
      encoder.copyBufferToBuffer(this.#count, 0, this.#countReadback, 0, 4)
      this.#readback = 'copied'
    }
  }

  /** Draw into an open render pass that owns the HDR colour target and the scene depth. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.#draw)
    pass.setBindGroup(0, this.#sharedGroup)
    pass.setBindGroup(2, this.#drawGroup)
    pass.drawIndirect(this.#args, 0)
  }

  destroy(): void {
    this.#uniform.destroy()
    this.#list.destroy()
    this.#count.destroy()
    this.#args.destroy()
    this.#countReadback.destroy()
    this.#lut.destroy()
  }
}
