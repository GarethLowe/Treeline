/**
 * The terrain surface pass.
 *
 * The one renderer M1 has no work package for: WP 1.2 makes the heightfield, WP 1.6 makes
 * the splat that shades it, WP 1.5 draws trees standing on it, and nobody draws the ground.
 *
 * Everything physical here comes from a sibling package rather than from this file:
 *   - height, slope, aspect and normal from WP 1.2's `terrain_sample.wgsl`, the same
 *     transcription the CPU query and the acceptance harness use;
 *   - ground cover from WP 1.6's `terrainSplat()`, whose weights are a unit-tested pure
 *     function of slope, aspect, drainage and latitude with no authored splat map anywhere;
 *   - lighting from WP 1.7's irradiance SH and prefiltered specular cube.
 *
 * What this file contributes is the grid, the bind-group wiring and the assembly of those
 * three shader chunks — which is exactly the composition layer's job.
 */

import type { CameraState } from '@contracts/render.ts'
import { SURFACE_CELLS } from '@contracts/sim.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import { materialWgsl } from '@render/materials/shaders.ts'
import type { ForestFireMaterialSystem } from '@render/materials/materialSystem.ts'
import terrainSampleWgsl from '../../shaders/terrain/terrain_sample.wgsl?raw'
import terrainWgsl from '../../shaders/app/terrain.wgsl?raw'
import occlusionSampleWgsl from '../../shaders/render/shadow/sample.wgsl?raw'
import { buildTerrainGrid, DEFAULT_GRID_QUADS, INNER_FRACTION, SKIRT_REACH } from './terrainGrid.ts'

/** 7 x vec4 worth of uniform. Must match `TerrainUniforms` in shaders/app/terrain.wgsl. */
const UNIFORM_BYTES = 160

export interface TerrainPassOptions {
  readonly device: GPUDevice
  readonly heightTexture: GPUTexture
  readonly slopeAspectTexture: GPUTexture
  readonly drainageTexture: GPUTexture
  readonly materials: ForestFireMaterialSystem
  /** Material-table indices in GROUND_SLOT order (mesic, litter, xeric, rock). */
  readonly groundMaterialSlots: readonly [number, number, number, number]
  readonly environmentLayout: GPUBindGroupLayout
  readonly environmentBindGroup: GPUBindGroup
  readonly colorFormat: GPUTextureFormat
  readonly depthFormat: GPUTextureFormat
  readonly depthCompare: GPUCompareFunction
  readonly sampleCount: number
  /** Site latitude in DEGREES. The splat's hemisphere test needs the sign (spec §0.6 rule 4). */
  readonly latitudeDeg: number
  /** Terrain heightfield nodes per axis. */
  readonly terrainGridN: number
  readonly terrainCellM: number
  readonly specularMipCount: number
  /** Sun-occlusion map from `render/shadow/sunOcclusion.ts`, r8unorm over the domain. */
  readonly occlusionTexture: GPUTexture
  readonly gridQuads?: number
}

export interface TerrainFrameState {
  readonly camera: CameraState
  /** Unit vector TOWARDS the sun, world space. */
  readonly sunDirection: readonly [number, number, number]
  /** Direct normal irradiance, W/m². */
  readonly directIrradiance: number
  /** Diffuse horizontal irradiance, W/m². */
  readonly diffuseIrradiance: number
  /** Normalised linear-sRGB beam tint, peak channel 1. */
  readonly beamColor: readonly [number, number, number]
}

export class TerrainPass {
  readonly triangleCount: number
  readonly vertexCount: number

  readonly #device: GPUDevice
  readonly #uniformBuffer: GPUBuffer
  readonly #indexBuffer: GPUBuffer
  readonly #indexCount: number
  readonly #bindGroup: GPUBindGroup
  readonly #materialBindGroup: GPUBindGroup
  readonly #environmentBindGroup: GPUBindGroup
  readonly #pipeline: GPURenderPipeline
  readonly #burnLayout: GPUBindGroupLayout
  readonly #burnParams: GPUBuffer
  readonly #burnSampler: GPUSampler
  /** Unburnt until `attachBurnState` runs; see there for why that is the right default. */
  #burnBindGroup: GPUBindGroup
  readonly #scratch = new ArrayBuffer(UNIFORM_BYTES)

  private constructor(init: {
    device: GPUDevice
    uniformBuffer: GPUBuffer
    indexBuffer: GPUBuffer
    indexCount: number
    bindGroup: GPUBindGroup
    materialBindGroup: GPUBindGroup
    environmentBindGroup: GPUBindGroup
    burnLayout: GPUBindGroupLayout
    pipeline: GPURenderPipeline
    vertexCount: number
    options: TerrainPassOptions
  }) {
    this.#device = init.device
    this.#uniformBuffer = init.uniformBuffer
    this.#indexBuffer = init.indexBuffer
    this.#indexCount = init.indexCount
    this.#bindGroup = init.bindGroup
    this.#materialBindGroup = init.materialBindGroup
    this.#environmentBindGroup = init.environmentBindGroup
    this.#pipeline = init.pipeline
    this.#burnLayout = init.burnLayout
    this.#burnParams = init.device.createBuffer({
      label: 'terrain.burn.params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.#burnSampler = init.device.createSampler({
      label: 'terrain.burn.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    })
    // A 1x1 zero consumed texture and a 1x1x1 zero smoke field: unburnt ground, which is the
    // correct picture before anything is alight rather than a placeholder to be replaced.
    const zero2d = init.device.createTexture({
      label: 'terrain.burn.zero2d',
      size: { width: 1, height: 1 },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const zero3d = init.device.createTexture({
      label: 'terrain.burn.zero3d',
      dimension: '3d',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    init.device.queue.writeBuffer(this.#burnParams, 0, new Float32Array([1, 1, 293.15, 1]))
    this.#burnBindGroup = init.device.createBindGroup({
      label: 'terrain.burn.bg.unburnt',
      layout: init.burnLayout,
      entries: [
        { binding: 0, resource: zero2d.createView() },
        { binding: 1, resource: zero3d.createView() },
        { binding: 2, resource: this.#burnSampler },
        { binding: 3, resource: { buffer: this.#burnParams } },
      ],
    })
    this.vertexCount = init.vertexCount
    this.triangleCount = init.indexCount / 3

    // The static half of the uniform never changes; writing it once here means the per-frame
    // write is a memcpy of 160 bytes with no branching.
    const o = init.options
    const f = new Float32Array(this.#scratch)
    const u = new Uint32Array(this.#scratch)
    f[16 + 3] = o.latitudeDeg
    f[28] = (o.gridQuads ?? DEFAULT_GRID_QUADS) + 1
    f[29] = DOMAIN_SIZE_M
    f[30] = o.terrainGridN
    f[31] = o.terrainCellM
    u[32] = o.groundMaterialSlots[0] >>> 0
    u[33] = o.groundMaterialSlots[1] >>> 0
    u[34] = o.groundMaterialSlots[2] >>> 0
    u[35] = o.groundMaterialSlots[3] >>> 0
    f[36] = INNER_FRACTION
    f[37] = SKIRT_REACH
    f[38] = Math.max(1, o.specularMipCount)
    f[39] = 0
  }

  /**
   * Async because `createRenderPipelineAsync` is (spec §6.8 pitfall 7: Dawn compiles lazily,
   * so a pipeline created synchronously stalls the first draw for as long as compilation
   * takes — which for a shader carrying the whole material sampler is not trivial).
   */
  static async create(options: TerrainPassOptions): Promise<TerrainPass> {
    const device = options.device
    const quads = options.gridQuads ?? DEFAULT_GRID_QUADS
    const grid = buildTerrainGrid(quads)

    const indexBuffer = device.createBuffer({
      label: 'terrain.indices',
      size: grid.indices.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    })
    new Uint32Array(indexBuffer.getMappedRange()).set(grid.indices)
    indexBuffer.unmap()

    const uniformBuffer = device.createBuffer({
      label: 'terrain.uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const bindGroupLayout = device.createBindGroupLayout({
      label: 'terrain.bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: UNIFORM_BYTES },
        },
        // textureLoad only, so `unfilterable-float` — no dependency on the optional
        // `float32-filterable` feature for the r32float height texture.
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        // Sun occlusion. `textureLoad` with a hand-rolled bilinear, so no sampler binding and
        // no dependency on r8unorm being filterable.
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })

    const bindGroup = device.createBindGroup({
      label: 'terrain.bg',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: options.heightTexture.createView() },
        { binding: 2, resource: options.slopeAspectTexture.createView() },
        { binding: 3, resource: options.drainageTexture.createView() },
        { binding: 4, resource: options.occlusionTexture.createView() },
      ],
    })

    // Group 3 is the burn state (WP 4.6). WP 1.6 reserved it and pointed materialWgsl's
    // burnGroup here; `terrain.wgsl` now declares it. Spec §7.6(d) has the ground sample the
    // sim's own surface fields by world XZ rather than carrying any per-instance record.
    const burnLayout = device.createBindGroupLayout({
      label: 'terrain.burn.bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '3d' },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 16 },
        },
      ],
    })
    const code = [
      materialWgsl({ materialGroup: 1, burnGroup: 3, includeSplat: true }),
      `const DOMAIN_SIZE_M: f32 = ${DOMAIN_SIZE_M.toFixed(1)};`,
      occlusionSampleWgsl,
      terrainSampleWgsl,
      terrainWgsl,
    ].join('\n\n')

    const module = device.createShaderModule({ label: 'terrain.wgsl', code })

    const pipeline = await device.createRenderPipelineAsync({
      label: 'terrain',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          bindGroupLayout,
          options.materials.bindGroupLayout,
          options.environmentLayout,
          burnLayout,
        ],
      }),
      vertex: { module, entryPoint: 'vs_terrain' },
      fragment: {
        module,
        entryPoint: 'fs_terrain',
        targets: [{ format: options.colorFormat }],
      },
      primitive: {
        topology: 'triangle-list',
        // Deliberately unculled. WebGPU decides facing in FRAMEBUFFER coordinates (y down),
        // so a winding that is counter-clockwise in a y-up world is clockwise here, and the
        // sign also depends on where the camera is looking. Getting it wrong makes the whole
        // ground invisible — the exact silent-black-screen failure this integration is
        // supposed to eliminate — and back-face culling on a heightfield saves almost no
        // fragments, because you hardly ever see its underside. Turn it on once there is a
        // browser to check it in.
        cullMode: 'none',
      },
      depthStencil: {
        format: options.depthFormat,
        depthWriteEnabled: true,
        depthCompare: options.depthCompare,
      },
      multisample: { count: options.sampleCount },
    })

    return new TerrainPass({
      device,
      uniformBuffer,
      indexBuffer,
      indexCount: grid.indices.length,
      bindGroup,
      materialBindGroup: options.materials.createBindGroup(device),
      environmentBindGroup: options.environmentBindGroup,
      burnLayout,
      pipeline,
      vertexCount: grid.vertexCount,
      options,
    })
  }

  update(state: TerrainFrameState): void {
    const f = new Float32Array(this.#scratch)
    f.set(state.camera.viewProjMatrix.subarray(0, 16), 0)
    f[16] = state.camera.position[0] as number
    f[17] = state.camera.position[1] as number
    f[18] = state.camera.position[2] as number
    // f[19] is latitude, written once in the constructor.
    f[20] = state.sunDirection[0] as number
    f[21] = state.sunDirection[1] as number
    f[22] = state.sunDirection[2] as number
    f[23] = state.directIrradiance
    f[24] = state.beamColor[0] as number
    f[25] = state.beamColor[1] as number
    f[26] = state.beamColor[2] as number
    f[27] = state.diffuseIrradiance
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, this.#scratch)
  }

  /**
   * Point the burn state at the sim's fields. Call once the fire and smoke exist.
   *
   * Until this is called the ground draws with an unburnt state from a 1x1 zero texture, which
   * is the correct picture for a world that has not caught fire rather than a placeholder.
   */
  attachBurnState(consumed: GPUTexture, smoke: GPUTexture, ambientK: number, smokeTopM: number): void {
    const params = new Float32Array([SURFACE_CELLS, DOMAIN_SIZE_M, ambientK, smokeTopM])
    this.#device.queue.writeBuffer(this.#burnParams, 0, params)
    this.#burnBindGroup = this.#device.createBindGroup({
      label: 'terrain.burn.bg',
      layout: this.#burnLayout,
      entries: [
        { binding: 0, resource: consumed.createView() },
        { binding: 1, resource: smoke.createView() },
        { binding: 2, resource: this.#burnSampler },
        { binding: 3, resource: { buffer: this.#burnParams } },
      ],
    })
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.#pipeline)
    pass.setBindGroup(0, this.#bindGroup)
    pass.setBindGroup(1, this.#materialBindGroup)
    pass.setBindGroup(2, this.#environmentBindGroup)
    pass.setBindGroup(3, this.#burnBindGroup)
    pass.setIndexBuffer(this.#indexBuffer, 'uint32')
    pass.drawIndexed(this.#indexCount)
  }

  destroy(): void {
    this.#uniformBuffer.destroy()
    this.#indexBuffer.destroy()
    this.#burnParams.destroy()
  }
}
