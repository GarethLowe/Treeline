/**
 * `IWorldRenderer` — the frame assembly M1 exists to produce.
 *
 * ## The integration decision that matters most
 *
 * WP 1.8 uses **reversed-Z on a float depth buffer** and says so loudly at the top of
 * `src/camera/math.ts`: near -> depth 1, far -> depth 0, clear to 0, compare `'greater'`,
 * format `depth32float`. WP 1.5's `DEFAULT_FOLIAGE_CONFIG` ships `depthCompare: 'less'` and
 * `depthFormat: 'depth32float'`, and its own comment explains why it is a config field
 * rather than a constant: *"a foliage pass that hardcodes 'less' against a reverse-Z depth
 * buffer draws nothing at all."* Both packages behaved correctly; reconciling them is this
 * file's job, and it is done in exactly one place — {@link foliageConfigFor} — so there is
 * one line to check if the world renders as sky over an empty plain.
 *
 * Every depth-facing value in this file comes from `../camera/math.ts`. None is spelled out.
 *
 * ## Pass order
 *
 *   compute   foliage cull (WP 1.5)          — GPU-driven culling, LOD, grass tiles
 *   compute   environment update (WP 1.7)    — amortised SH + prefiltered cube
 *   render    world pass, HDR + depth
 *               sky      (WP 1.7)  no depth write, fills every pixel
 *               terrain  (src/app) depth write
 *               foliage  (WP 1.5)  depth write
 *   render    resolve pass, swapchain        — exposure, ACES, sRGB
 *
 * ## Profiler attribution, honestly stated
 *
 * The two compute stages are attributed via `attributeEncoder`: both take a raw
 * `GPUCommandEncoder` and open their own compute passes, so the scheduler — which attributes a
 * pass by *creating*
 * it — cannot see them. They are wrapped in debug groups so a capture tool still shows them.
 * The two render passes are attributed, and they are where M1's cost actually is.
 */

import type { FrameContext } from '@core/runtime.ts'
import type { QualitySettings } from '@contracts/gpu.ts'
import type {
  CameraState,
  IMaterialSystem,
  SolarState,
} from '@contracts/render.ts'
import type { ITerrainField, ITreeMeshSet, IVegetationSet } from '@contracts/world.ts'
import type { IFireOutputs } from '@contracts/sim.ts'
import { attributeEncoder } from '@gpu/attribution.ts'
import type { FrameProfiler } from '@gpu/profiler.ts'
import { FireDebugView } from '@render/firedebug/fireDebugView.ts'
import { type FireDebugViewId } from '@render/firedebug/views.ts'
import { createFoliageRenderer, type FoliageRenderer } from '@render/foliage/foliageRenderer.ts'
import { DEFAULT_FOLIAGE_CONFIG, DEFAULT_GRASS, type FoliageConfig } from '@render/foliage/config.ts'
import { SkyRenderer } from '@render/sky/sky-renderer.ts'
import { EnvironmentLighting } from '@render/sky/environment.ts'
import { createOcclusionTexture, SunOcclusion } from '@render/shadow/sunOcclusion.ts'
import { FlameRenderer } from '@render/flames/flameRenderer.ts'
import type { CanopyVoxelStore } from '@sim/canopy/storage/store.ts'
import { DEPTH_CLEAR_VALUE, DEPTH_COMPARE, DEPTH_FORMAT } from '../camera/math.ts'
import { HDR_FORMAT, RenderTargets, ResolvePass } from './resolvePass.ts'
import { TerrainPass } from './terrainPass.ts'
import { FroxelVolumetrics } from '@render/volumetrics/froxel.ts'
import { SMOKE_TOP_M } from '@sim/smoke/field.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import type { GeneratedWorld } from './worldGen.ts'

export interface WorldRendererOptions {
  readonly device: GPUDevice
  readonly context: GPUCanvasContext
  readonly canvasFormat: GPUTextureFormat
  readonly world: GeneratedWorld
  readonly profiler: FrameProfiler
  readonly widthPx: number
  readonly heightPx: number
  readonly hasSubgroups: boolean
  readonly maxComputeWorkgroupsPerDimension: number
  readonly grassEnabled: boolean
  /** Terrain grid density, quads per axis. */
  readonly gridQuads?: number
}

export interface FrameInputs {
  readonly camera: CameraState
  readonly solar: SolarState
  readonly quality: QualitySettings
  /** Linear multiplier applied in the resolve pass. */
  readonly exposure: number
  /** Present once {@link WorldRenderer.attachFireDebug} has run. */
  readonly fire?: {
    /** The solver's own simulated clock, seconds. Drives the isochrone bands. */
    readonly simTimeS: number
    readonly activeCellCount: number
  }
}

/**
 * Reconcile WP 1.5's foliage pipeline state with WP 1.8's depth convention and the HDR
 * target this file owns. THE reversed-Z reconciliation point.
 */
export function foliageConfigFor(options: {
  readonly viewportHeightPx: number
  readonly grassEnabled: boolean
  readonly understoryCover: number
}): Partial<FoliageConfig> {
  return {
    colorFormats: [HDR_FORMAT],
    depthFormat: DEPTH_FORMAT,
    depthCompare: DEPTH_COMPARE,
    depthWriteEnabled: true,
    sampleCount: 1,
    viewportHeightPx: Math.max(1, options.viewportHeightPx),
    enableGrass: options.grassEnabled,
    grass: {
      ...DEFAULT_GRASS,
      // Grass density is a *biome* property, not a rendering constant: 400 blades/m² of
      // tallgrass prairie and 400 blades/m² under closed chaparral are not the same world.
      // `understoryCover` is the vegetation package's own cover fraction.
      densityPerM2: DEFAULT_GRASS.densityPerM2 * Math.min(1, Math.max(0, options.understoryCover)),
    },
    // Left at the package default (false), which re-derives the planes from the
    // view-projection with a pinned convention. WP 1.8 does export planes and does document
    // its ordering, so this could be flipped — but a sign error here culls the entire world
    // silently, and the derived path is already correct. Not worth the risk at integration.
    useCameraFrustumPlanes: DEFAULT_FOLIAGE_CONFIG.useCameraFrustumPlanes,
  }
}

export class WorldRenderer {
  readonly terrain: ITerrainField
  readonly vegetation: IVegetationSet
  readonly trees: ITreeMeshSet
  readonly materials: IMaterialSystem
  readonly foliage: FoliageRenderer
  readonly sky: SkyRenderer
  readonly environment: EnvironmentLighting
  readonly profiler: FrameProfiler

  readonly foliageRenderer: FoliageRenderer
  readonly skyRenderer: SkyRenderer
  readonly environmentLighting: EnvironmentLighting
  readonly terrainPass: TerrainPass
  /** Phase 3 rung 1. Rebuilt only when the sun moves; see `render/shadow/sunOcclusion.ts`. */
  readonly sunOcclusion: SunOcclusion

  readonly targets: RenderTargets

  /**
   * WP 4.5's flames, surface and crown. Null until {@link attachFire} — they read the solver's
   * own textures and M3's voxel pool.
   */
  flames: FlameRenderer | null = null

  /** WP 2.6's provisional overlay. Null until {@link attachFireDebug}; deleted when M4 lands. */
  fireDebug: FireDebugView | null = null

  readonly #context: GPUCanvasContext
  readonly #resolve: ResolvePass
  readonly #device: GPUDevice
  readonly #world: GeneratedWorld
  #widthPx: number
  #heightPx: number
  #ctx: FrameContext | null = null

  private constructor(init: {
    options: WorldRendererOptions
    foliage: FoliageRenderer
    sky: SkyRenderer
    environment: EnvironmentLighting
    terrainPass: TerrainPass
    targets: RenderTargets
    resolve: ResolvePass
    sunOcclusion: SunOcclusion
  }) {
    const o = init.options
    this.terrain = o.world.terrain
    this.vegetation = o.world.vegetation
    this.trees = o.world.trees
    this.materials = o.world.materials
    this.profiler = o.profiler
    this.foliage = init.foliage
    this.foliageRenderer = init.foliage
    this.sky = init.sky
    this.skyRenderer = init.sky
    this.environment = init.environment
    this.environmentLighting = init.environment
    this.terrainPass = init.terrainPass
    this.targets = init.targets
    this.#resolve = init.resolve
    this.sunOcclusion = init.sunOcclusion
    this.#context = o.context
    this.#device = o.device
    this.#world = o.world
    this.#widthPx = o.widthPx
    this.#heightPx = o.heightPx
    this.#resolve.bind(this.targets.colorView)
  }

  static async create(options: WorldRendererOptions): Promise<WorldRenderer> {
    const { device, world } = options

    const sky = new SkyRenderer(device, {
      targetFormat: HDR_FORMAT,
      // The sky shares the world pass, so its pipeline must declare the same depth
      // attachment. It writes no depth and compares 'always', so it works under either
      // depth convention — but omitting the format here would be a pipeline/pass mismatch.
      depthFormat: DEPTH_FORMAT,
      outputMode: 'linear-hdr',
      label: 'sky',
    })

    const environment = new EnvironmentLighting(device, sky, { label: 'env' })

    // Before the foliage renderer, because its two draw pipelines bind this.
    const occlusionTexture = createOcclusionTexture(device)

    const foliage = createFoliageRenderer({
      device,
      vegetation: world.vegetation,
      trees: world.trees,
      materials: world.materials,
      materialIds: world.materialIds,
      terrainHeightTexture: world.terrain.heightTexture,
      occlusionTexture,
      hasSubgroups: options.hasSubgroups,
      maxComputeWorkgroupsPerDimension: options.maxComputeWorkgroupsPerDimension,
      config: foliageConfigFor({
        viewportHeightPx: options.heightPx,
        grassEnabled: options.grassEnabled,
        understoryCover: world.config.vegetation.understoryCover,
      }),
    })

    // Before the terrain pass, because the terrain's bind group samples the occlusion map.
    // The pass reads the foliage instance buffer directly rather than keeping a second copy
    // of 36,700 crowns.
    const sunOcclusion = await SunOcclusion.create({
      device,
      texture: occlusionTexture,
      instances: foliage.instanceBuffer,
      instanceCount: foliage.scene.instanceCount,
      heightTexture: world.terrain.heightTexture,
    })

    const terrainPass = await TerrainPass.create({
      device,
      heightTexture: world.terrain.heightTexture,
      slopeAspectTexture: world.terrain.slopeAspectTexture,
      drainageTexture: world.drainageTexture,
      materials: world.materials,
      groundMaterialSlots: world.groundMaterialSlots,
      environmentLayout: environment.bindGroupLayout,
      environmentBindGroup: environment.createBindGroup(device),
      colorFormat: HDR_FORMAT,
      depthFormat: DEPTH_FORMAT,
      depthCompare: DEPTH_COMPARE,
      sampleCount: 1,
      latitudeDeg: world.config.site.latitudeDeg,
      terrainGridN: world.terrain.generation.gridN,
      terrainCellM: world.terrain.generation.field.cellM,
      specularMipCount: environment.mipCount,
      occlusionTexture,
      ...(options.gridQuads === undefined ? {} : { gridQuads: options.gridQuads }),
    })

    const targets = new RenderTargets({
      device,
      widthPx: options.widthPx,
      heightPx: options.heightPx,
      resolutionScale: 1,
    })

    const resolve = await ResolvePass.create({ device, targetFormat: options.canvasFormat })

    return new WorldRenderer({
      options,
      foliage,
      sky,
      environment,
      terrainPass,
      targets,
      resolve,
      sunOcclusion,
    })
  }

  /**
   * Bring up WP 2.6's fire debug overlay over the solver's output textures.
   *
   * Separate from `create` because the fire solver is built *after* the renderer — its fuel
   * bed comes from the vegetation and its slope factor from the terrain, both of which are
   * the renderer's inputs too.
   *
   * Every depth-facing value comes from `../camera/math.ts`, the same single source the
   * foliage reconciliation uses. `FireDebugView` takes `depthCompare` as a parameter for
   * exactly the reason documented at the top of this file, and gets it from there — an
   * overlay that hardcoded `'less'` against this reversed-Z buffer would draw nothing and
   * look like a solver that never ignited.
   */
  /**
   * Point the foliage renderer's burn bindings at the solver's output.
   *
   * Separate from {@link attachFireDebug} deliberately: that overlay is optional and off by
   * default, and burning vegetation must not depend on a debug view being switched on.
   */
  async attachFire(outputs: IFireOutputs, canopyStore: CanopyVoxelStore): Promise<void> {
    this.foliageRenderer.attachFire(outputs.consumedTexture, outputs.intensityTexture, canopyStore)
    this.flames?.destroy()
    this.flames = await FlameRenderer.create({
      device: this.#device,
      stateTexture: outputs.stateTexture,
      intensityTexture: outputs.intensityTexture,
      consumedTexture: outputs.consumedTexture,
      heightTexture: this.#world.terrain.heightTexture,
      colorFormat: HDR_FORMAT,
      depthFormat: DEPTH_FORMAT,
      depthCompare: DEPTH_COMPARE,
      canopyStore,
    })
  }

  async attachFireDebug(outputs: IFireOutputs, view: FireDebugViewId): Promise<void> {
    this.fireDebug?.destroy()
    this.fireDebug = null
    this.fireDebug = await FireDebugView.create({
      device: this.#device,
      outputs,
      heightTexture: this.#world.terrain.heightTexture,
      terrainGridN: this.#world.terrain.generation.gridN,
      terrainCellM: this.#world.terrain.generation.field.cellM,
      colorFormat: HDR_FORMAT,
      depthFormat: DEPTH_FORMAT,
      depthCompare: DEPTH_COMPARE,
      sampleCount: 1,
      view,
      legendParent: document.body,
    })
    // The legend defaults to bottom-right, which is where #controls lives (index.html:80).
    // Its own comment calls the styling provisional, so nudging it here beats forking it.
    this.fireDebug.legend?.element.style.setProperty('right', '20rem')
  }

  /** Called by the frame loop before {@link render}, which the contract gives no encoder. */
  beginFrame(ctx: FrameContext): void {
    this.#ctx = ctx
  }

  render(camera: CameraState, solar: SolarState, quality: QualitySettings): void {
    const ctx = this.#ctx
    if (ctx === null) throw new Error('WorldRenderer.render() called without beginFrame()')
    this.renderWith(ctx, { camera, solar, quality, exposure: this.exposure })
  }

  /** Exposure for the next `render()` call made through the bare contract method. */
  exposure = 1

  /**
   * M4's froxel volumetrics. Constructed lazily by `attachVolumetrics` because it needs the
   * smoke field, which is built after the renderer.
   */
  volumetrics: FroxelVolumetrics | null = null
  /** WP 4.1's current field. Ping-ponged, so the composer re-hands it every frame. */
  smokeField: GPUTexture | null = null

  renderWith(ctx: FrameContext, inputs: FrameInputs): void {
    const { encoder, scheduler } = ctx
    const { camera, solar, quality } = inputs

    if (this.targets.resize(this.#widthPx, this.#heightPx, quality.resolutionScale)) {
      this.#resolve.bind(this.targets.colorView)
    }

    // The sky's own solve is the single source of truth for the beam direction and colour —
    // the same numbers M5's fuel drying will integrate. Reconstructed here rather than
    // recomputed, so a graphics sun cannot drift from a physics sun.
    const env = this.skyRenderer.environmentFor(solar)

    this.foliageRenderer.setSunDirection([
      -(env.solar.direction[0] as number),
      -(env.solar.direction[1] as number),
      -(env.solar.direction[2] as number),
    ])
    // Same source as the direction, for the same reason: the foliage pass emits physical
    // radiance, so it needs the actual irradiance rather than a shading constant. Driving it
    // from anywhere else would let the foliage brighten while the terrain beside it did not.
    //
    // Per channel, because the light is not white. The beam tint is the sky's own solve —
    // airmass reddening plus the plume's lambda^-1.76 extinction — and the ambient tint is the
    // DC term of the irradiance SH, i.e. the same blue the terrain reads. Both are normalised
    // to their peak channel before scaling, so this changes hue and not magnitude: a scalar
    // here made foliage the only surface in the frame lit by a grey sun.
    this.foliageRenderer.setIrradiance(
      tint(solar.directIrradiance, env.solar.beamColor),
      tint(solar.diffuseIrradiance, this.environment.irradianceShCoefficients?.[0]),
    )

    // Both subsystems open their own compute passes on this encoder, so they are routed
    // through an attributing proxy — otherwise their cost lands nowhere and the `render`
    // phase under-reports by however much culling and the sky prefilter actually take.
    const timed = attributeEncoder(encoder, scheduler.profiler, 'render')

    // No-op unless the sun has actually moved; see SUN_REBUILD_RADIANS.
    encoder.pushDebugGroup('sun.occlusion')
    this.sunOcclusion.update(timed, [
      env.solar.direction[0] as number,
      env.solar.direction[1] as number,
      env.solar.direction[2] as number,
    ])
    encoder.popDebugGroup()

    // Fold this frame's fireline intensity into each stem's remembered peak, before the
    // draws read it. No-op while the bindings still point at the 1x1 stand-in.
    encoder.pushDebugGroup('foliage.burnState')
    this.foliageRenderer.updateBurnState(timed)
    encoder.popDebugGroup()

    // Rebuild the flame billboard list from the solver's state texture. Before the world
    // pass, which is where they are drawn.
    if (this.flames !== null) {
      encoder.pushDebugGroup('flames.gather')
      this.flames.gather(timed, {
        viewProj: camera.viewProjMatrix as Float32Array,
        cameraPos: [
          camera.position[0] as number,
          camera.position[1] as number,
          camera.position[2] as number,
        ],
        // Same clock and wind the foliage sway uses, so a flame leans the way the grass
        // beside it does rather than telling a different story about the same wind.
        timeSec: inputs.fire?.simTimeS ?? 0,
        windDirX: Math.sin(this.foliageRenderer.windDirectionRad),
        windDirZ: Math.cos(this.foliageRenderer.windDirectionRad),
        windSpeed: this.foliageRenderer.windSpeedMps,
      })
      encoder.popDebugGroup()
    }

    encoder.pushDebugGroup('foliage.cull')
    this.foliageRenderer.cull(timed, camera, quality)
    encoder.popDebugGroup()

    encoder.pushDebugGroup('environment.update')
    this.environmentLighting.update(timed, solar)
    encoder.popDebugGroup()

    this.terrainPass.update({
      camera,
      sunDirection: env.solar.direction,
      directIrradiance: solar.directIrradiance,
      diffuseIrradiance: solar.diffuseIrradiance,
      beamColor: env.solar.beamColor,
    })

    scheduler.render(
      encoder,
      'render',
      'world',
      {
        colorAttachments: [
          {
            view: this.targets.colorView,
            // The sky covers every pixel, so this clear is belt and braces — but a clear to
            // black rather than to garbage is what makes "the sky pass did not run" look
            // like a black screen instead of like undefined memory.
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: this.targets.depthView,
          // Reversed-Z: the FAR value is 0, not 1. Clearing to 1 here would make every
          // depth test fail and the world would be sky only.
          depthClearValue: DEPTH_CLEAR_VALUE,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      },
      (pass) => {
        this.skyRenderer.render(pass, camera, solar)
        this.terrainPass.draw(pass)
        this.foliageRenderer.draw(pass, camera, quality)
        // Flames before the overlay and after the geometry: additive, depth-tested against
        // what the terrain and foliage wrote, writing no depth of its own.
        this.flames?.draw(pass)
        // Last in the pass: it is alpha-blended, reads the depth the terrain and foliage
        // wrote and writes none of its own, so it can only ever tint what is already there.
        if (this.fireDebug !== null && inputs.fire !== undefined) {
          this.fireDebug.update({
            camera,
            simTimeS: inputs.fire.simTimeS,
            exposure: inputs.exposure,
            activeCellCount: inputs.fire.activeCellCount,
          })
          this.fireDebug.draw(pass)
        }
      },
    )

    // Volumetrics go here: after the world pass, which is what wrote the depth the march
    // stops against, and before the resolve, which tonemaps. Doing it after the resolve would
    // apply the plume to already-tonemapped colour and destroy the physical radiance the whole
    // renderer is built on.
    if (this.volumetrics !== null && this.smokeField !== null) {
      const timedVol = attributeEncoder(encoder, scheduler.profiler, 'render')
      this.volumetrics.encode(
        timedVol,
        {
          camera,
          smoke: this.smokeField,
          height: this.#world.terrain.heightTexture,
          depth: this.targets.depthView,
          hdr: this.targets.colorView,
          sunDirection: [
            env.solar.direction[0] as number,
            env.solar.direction[1] as number,
            env.solar.direction[2] as number,
          ],
          sunIrradiance: [solar.directIrradiance, solar.directIrradiance, solar.directIrradiance],
          skyIrradiance: [solar.diffuseIrradiance, solar.diffuseIrradiance, solar.diffuseIrradiance],
          ambientK: 293.15,
          domainSizeM: DOMAIN_SIZE_M as never,
          smokeTopM: SMOKE_TOP_M,
          slices: quality.froxelMarchSteps,
        },
        this.targets.width,
        this.targets.height,
      )
    }

    scheduler.render(
      encoder,
      'render',
      'resolve',
      {
        colorAttachments: [
          {
            view: this.#context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      },
      (pass) => {
        this.#resolve.draw(pass, inputs.exposure)
      },
    )
  }

  resize(widthPx: number, heightPx: number): void {
    this.#widthPx = Math.max(1, widthPx)
    this.#heightPx = Math.max(1, heightPx)
    if (this.targets.resize(this.#widthPx, this.#heightPx, this.targets.resolutionScale)) {
      this.#resolve.bind(this.targets.colorView)
    }
  }

  destroy(): void {
    this.fireDebug?.destroy()
    this.foliageRenderer.destroy()
    this.terrainPass.destroy()
    this.environmentLighting.destroy()
    this.skyRenderer.destroy()
    this.targets.destroy()
    this.#resolve.destroy()
  }
}

/**
 * Scale a scalar irradiance by a peak-normalised colour, so the magnitude is exactly the
 * scalar and only the hue comes from the colour. A missing colour (no SH built yet on the
 * first frame) is white, which reproduces the old scalar behaviour rather than going black.
 */
function tint(
  scalar: number,
  color: readonly [number, number, number] | undefined,
): [number, number, number] {
  if (color === undefined) return [scalar, scalar, scalar]
  const peak = Math.max(color[0], color[1], color[2], 1e-6)
  return [(scalar * color[0]) / peak, (scalar * color[1]) / peak, (scalar * color[2]) / peak]
}
