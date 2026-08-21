/**
 * ForestFire — M1 entry point.
 *
 * Composition only. Every subsystem here belongs to one of the eight M1 work packages; this
 * file's whole job is to bring them up in the right order, name the one that fails, and run
 * the frame loop.
 *
 *   WP 1.1  src/core, src/gpu          device, Runtime (loop + profiler + scheduler + quality)
 *   WP 1.2  src/world/terrain          heightfield, textures, CPU query
 *   WP 1.3  src/world/vegetation       biomes, seeded stem placement
 *   WP 1.4  src/world/trees            procedural tree geometry from fuel parameters
 *   WP 1.5  src/render/foliage         GPU cull, instancing, LOD, grass
 *   WP 1.6  src/render/materials       procedural PBR arrays and the terrain splat
 *   WP 1.7  src/render/sky             sky, solar solve, environment lighting
 *   WP 1.8  src/camera                 walker and drone cameras
 *
 * The adapter report from the original bring-up screen is kept, and is more than decoration:
 * on this machine the browser silently selects the Intel iGPU over the RTX 4070, and every
 * frame time measured in that state is ~10x off. The warning has already caught it once.
 */

import { s as seconds, m as metres } from '@contracts/units.ts'
import { provenanceReport } from './provenance.ts'
import type { Metres, Seconds } from '@contracts/units.ts'
import type { BiomeId } from '@contracts/world.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import type { TimeOfDay } from '@contracts/render.ts'
import type { SurfaceWeather } from '@contracts/sim.ts'
import { createDevice, syncCanvasSize, type Device } from '@core/device.ts'
import { attributeEncoder } from '@gpu/attribution.ts'
import { Runtime, type FrameContext } from '@core/runtime.ts'
import { createCameraRig, type CameraRig } from './camera/rig.ts'
import {
  REVERSED_Z,
  mat4Create,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  v3,
  vNormalize,
  vSub,
} from './camera/math.ts'
import { BootScreen } from './app/bootScreen.ts'
import { installShaderAudit, pipelineErrors, shaderAuditReport } from './app/shaderAudit.ts'
import { FLAME_STRIDE, MAX_FLAMES } from '@render/flames/flameRenderer.ts'
import { adaptExposure, autoExposure } from './app/exposure.ts'
import { StageTracker } from './app/stages.ts'
import { DEFAULT_SETTINGS, searchFromSettings, settingsFromSearch, type AppSettings } from './app/settings.ts'
import { Controls, Hud, type FireHudFrame } from './app/ui.ts'
import { generateWorld, yieldToBrowser, type GeneratedWorld } from './app/worldGen.ts'
import { WorldRenderer } from './app/worldRenderer.ts'
import { FROXEL_NX, FROXEL_NY, FroxelVolumetrics } from '@render/volumetrics/froxel.ts'
import { FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { FireSim, dominantFuelModel, gpuErrors, weatherFrom } from './app/fire.ts'
import { flameDepth } from '@sim/rothermel/kernel.ts'
import { CanopySim } from './app/canopy.ts'
import { SMOKE_NXZ, SMOKE_TOP_M, SmokeField } from '@sim/smoke/field.ts'
import { ignitionShape, ndcFromPointer, pickGround } from './app/ignition.ts'
import { FIRE_DEBUG_VIEWS, cycleView, type FireDebugViewId } from '@render/firedebug/views.ts'
import { benchRequested, startBench } from './bench/index.ts'

const canvas = document.getElementById('view') as HTMLCanvasElement
const boot = new BootScreen()

let settings: AppSettings = settingsFromSearch(window.location.search, DEFAULT_SETTINGS)
let device: Device | null = null
let runtime: Runtime | null = null
let world: GeneratedWorld | null = null
let renderer: WorldRenderer | null = null
let rig: CameraRig | null = null
let hud: Hud | null = null
let fire: FireSim | null = null
let canopy: CanopySim | null = null
let smoke: SmokeField | null = null
let regenerating = false

/** Limits worth showing on the boot screen. The rest are noise. */
const LIMITS_OF_INTEREST = [
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupStorageSize',
  'maxComputeWorkgroupsPerDimension',
  'maxStorageBuffersPerShaderStage',
  'maxTextureDimension2D',
] as const

function readLimits(gpu: GPUDevice): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of LIMITS_OF_INTEREST) {
    const v = gpu.limits[key]
    if (typeof v === 'number') out[key] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const stages = new StageTracker()
  stages.onChange((records) => boot.renderStages(records))
  boot.renderStages(stages.records)
  boot.setPhase('device bring-up')

  if (settings.debug) {
    boot.appendBlock('Model provenance (spec §0.7)', provenanceReport())
    boot.appendBlock('Settings', JSON.stringify(settings, null, 2))
    boot.setPhase('device bring-up')
  }

  device = await stages.run('device', async () => {
    const d = await createDevice({
      canvas,
      onDeviceLost: (info) => {
        boot.show()
        boot.renderFailure(new Error(`GPU device lost: ${info.reason} — ${info.message}`))
      },
    })
    stages.note('device', `${d.report.grantedFeatures.length} optional features granted`)
    // Before anything creates a pipeline, so the audit sees every module. Unconditional:
    // an invalid pipeline is a black screen, and Chrome reports it as a console warning that
    // nothing else in this app was watching.
    installShaderAudit(d.device)
    return d
  })

  const advice = boot.renderAdapter(device.report, readLimits(device.device))
  // Not blocking, deliberately: on this machine the iGPU is what the browser pane always
  // hands back, and refusing to start would make the app unusable for functional work. The
  // warning is loud, is repeated in the HUD, and every timing carries the flag.
  if (advice.blocking) boot.setPhase('generating world — ON THE WRONG GPU')

  runtime = new Runtime(device, {})
  syncCanvasSize(canvas, device.device)

  await build(stages)
}

/** Build (or rebuild) the world and everything that depends on it. */
async function build(stages: StageTracker): Promise<void> {
  const d = device
  const rt = runtime
  if (d === null || rt === null) throw new Error('build() before device bring-up')

  boot.setPhase(`generating world — seed ${settings.seed}, ${settings.biome}`)
  boot.show()

  world = await generateWorld({
    device: d.device,
    settings,
    stages,
    onSubProgress: (f) => boot.setSubProgress(f),
  })
  boot.setSubProgress(0)

  renderer = await stages.run('renderer', async () => {
    const r = await WorldRenderer.create({
      device: d.device,
      context: d.context,
      canvasFormat: d.canvasFormat,
      world: world as GeneratedWorld,
      profiler: rt.profiler,
      widthPx: canvas.width,
      heightPx: canvas.height,
      hasSubgroups: d.has('subgroups'),
      maxComputeWorkgroupsPerDimension: d.device.limits.maxComputeWorkgroupsPerDimension,
      grassEnabled: settings.grassEnabled,
    })
    stages.note(
      'renderer',
      `terrain ${r.terrainPass.triangleCount.toLocaleString('en-US')} tris, ` +
        `foliage ${r.foliageRenderer.diagnostics.bucketCount} buckets / ` +
        `${r.foliageRenderer.diagnostics.instanceCount.toLocaleString('en-US')} instances`,
    )
    return r
  })

  // M2 — the surface fire solver. Built after the world because the fuel bed comes from the
  // vegetation and the slope factor from the terrain; built before the loop starts because
  // `onStep` will call into it on the very first frame.
  const w = world as GeneratedWorld
  fire = await stages.run('fire', async () => {
    const f = new FireSim({
      device: d.device,
      slopeAspectTexture: w.terrain.slopeAspectTexture,
      fuelModelCode:
        settings.fuelModel ??
        dominantFuelModel(w.config.vegetation.speciesMix, w.vegetation.species),
      useSubgroups: d.has('subgroups'),
      // WP 3.5's Van Wagner criteria. `measuredStandCrownBulkDensity` is the STAND value the
      // 0.05 kg/m3 active-crowning threshold is defined against, not `Stem.crownBulkDensity`,
      // which is within-crown and several times larger.
      stand: {
        stems: w.vegetation.stems,
        standCrownBulkDensity: w.vegetation.diagnostics.measuredStandCrownBulkDensity,
      },
    })
    f.setWeather(weatherFromSettings(settings))
    f.timeScale = settings.fireTimeScale
    stages.note(
      'fire',
      `${f.cells}^2 cells @ ${f.cellM} m, fuel ${f.fuelModelCode} (id ${f.fuelModelId}), ` +
        `wind ${(f.weather.midflameWind as number).toFixed(1)} m/s midflame`,
    )
    return f
  })

  // M3. Built after the fire because the emitter pass reads WP 2.4's intensity and state
  // fields, and after the world because the voxelisation is over the vegetation set. The
  // build is CPU-heavy (two rasterisation passes over ~36 700 stems plus the extinction
  // field), so it gets its own boot stage rather than hiding inside another one.
  canopy = await stages.run('canopy', async () => {
    await yieldToBrowser()
    const c = new CanopySim({
      device: d.device,
      vegetation: w.vegetation,
      terrain: w.terrain,
      species: w.vegetation.species,
    })
    await c.ready()
    const st = c.stats
    stages.note(
      'canopy',
      `${st.occupiedVoxels.toLocaleString()} voxels in ${st.slotCount.toLocaleString()} slots, ` +
        `${st.activeBricks.toLocaleString()}/${st.totalBricks.toLocaleString()} bricks active, ` +
        `${(st.depositedMassKg / 1000).toFixed(1)} t foliage` +
        (st.clippedMassKg > 0 ? ` (${(st.clippedMassKg / 1000).toFixed(2)} t clipped)` : ''),
    )
    return c
  })
  // M4.1 — the advected smoke field the froxel volumetrics sample. It rides on the canopy's
  // plume uniform rather than solving its own: spec §6.4 advects smoke with the terrain wind
  // plus the parameterised buoyant velocity, and that velocity is WP 3.4's LUT.
  smoke = new SmokeField(d.device, {
    arrivalTexture: fire.outputs.arrivalTimeTexture,
    stateTexture: fire.outputs.stateTexture,
    plume: canopy.plumeUniforms,
  })
  smoke.setModel(fire.burnoutModelForSmoke())
  {
    const enc = d.device.createCommandEncoder({ label: 'smoke.reset' })
    smoke.reset(enc)
    d.device.queue.submit([enc.finish()])
  }

  renderer.volumetrics = new FroxelVolumetrics(d.device)
  // WP 4.6: the ground now reads the sim's own consumed-fraction field, so it scorches, chars
  // and ashes over behind the front instead of staying green. Spec §7.6(d) — no per-instance
  // record, the 2048^2 surface texture is sampled directly by world XZ.
  renderer.terrainPass.attachBurnState(
    fire.outputs.consumedTexture,
    smoke.current,
    293.15,
    SMOKE_TOP_M,
  )

  // AFTER the smoke field exists, not before. This is the one call that pushes the wind into
  // both the plume and the smoke advection, and running it while `smoke` was still null left
  // the field with a zero wind vector: with the plume tilted downwind there is no vertical
  // velocity directly over the fire either, so the semi-Lagrangian backtrace landed exactly on
  // the cell it started from and nothing ever moved.
  applyCanopyWeather()

  // WP 2.6's provisional overlay, so the solver can be judged by eye. `?fireView=off` skips
  // it entirely; M4's volumetrics replaces it.
  // Before the overlay, and unconditionally: vegetation chars from the solver's own output,
  // not from a debug view.
  await renderer.attachFire(fire.outputs, canopy.store)

  if (settings.fireView !== 'off') {
    await renderer.attachFireDebug(fire.outputs, asFireView(settings.fireView))
  }

  if (settings.debug) {
    // The one check that cannot be made under Node: does the fire actually spread on a GPU?
    boot.setPhase('debug — running the M2 solver self-test')
    await yieldToBrowser()
    try {
      boot.appendBlock('M2 surface solver self-test', await fire.selfTest())
    } catch (err) {
      boot.appendBlock('M2 surface solver self-test', `FAILED: ${String(err)}`)
    }
    boot.setPhase('debug — probing the M3 canopy chain')
    await yieldToBrowser()
    try {
      const before = gpuErrors.length
      const primed = await primeCanopy()
      const raised = gpuErrors.slice(before, before + 6)
      const volReport = await probeVolumetrics()
      boot.appendBlock('M4 volumetrics probe', volReport)
      boot.appendBlock(
        'M3 canopy chain probe',
        [
          primed,
          (await canopy?.report()) ?? 'no canopy',
          '',
          raised.length === 0
            ? 'GPU validation    no new errors during the prime run'
            : [`GPU validation    ${gpuErrors.length - before} NEW ERROR(S) during the prime run:`]
                .concat(raised.map((e) => `  ${e}`))
                .join(String.fromCharCode(10)),
        ].join(String.fromCharCode(10)),
      )
    } catch (err) {
      boot.appendBlock('M3 canopy chain probe', `FAILED: ${String(err)}`)
    }
    boot.appendBlock(
      'Near-field flames (WP 4.5)',
      renderer.flames === null
        ? 'no flame renderer — attachFire did not run'
        : [
            `billboards        ${renderer.flames.lastFlameCount} last gathered, ` +
              `${renderer.flames.lastCanopyFlameCount} of them crown`,
            `capacity          ${MAX_FLAMES} (overflow is dropped and counted, never wrapped)`,
            `stride            ${FLAME_STRIDE} surface cells per billboard; the canopy gather ` +
              `emits one per FLAMING voxel`,
          ].join(String.fromCharCode(10)),
    )
    boot.setPhase('debug — probing vegetation burn state')
    await yieldToBrowser()
    try {
      // After the canopy prime run above, which burns a few thousand square metres. The prime
      // steps the solver without rendering, so the fold has to be dispatched explicitly.
      renderer.foliageRenderer.updateBurnStateNow()
      boot.appendBlock(
        'Vegetation burn state (spec 7.6c)',
        await renderer.foliageRenderer.burnReport(),
      )
    } catch (err) {
      boot.appendBlock('Vegetation burn state (spec 7.6c)', `FAILED: ${String(err)}`)
    }
    boot.setPhase('debug — probing sun occlusion')
    await yieldToBrowser()
    try {
      // Nothing has rendered a frame yet, so the map has never been built. Force one at the
      // configured time of day — the same solar solve the frame path uses.
      const occTime: TimeOfDay = {
        secondsOfDay: seconds(settings.secondsOfDay),
        dayOfYear: settings.dayOfYear,
      }
      const occSolar = renderer.skyRenderer.fullSolarState(
        occTime,
        world.config.site.latitudeDeg,
        world.config.site.longitudeDeg,
      )
      const dir = renderer.skyRenderer.environmentFor(occSolar).solar.direction
      renderer.sunOcclusion.buildNow([dir[0] as number, dir[1] as number, dir[2] as number])
      boot.appendBlock(
        'Sun occlusion (phase 3 rung 1)',
        `sun elevation     ${((occSolar.elevation as number) * 57.29578).toFixed(1)} deg
` +
          (await renderer.sunOcclusion.report()),
      )
    } catch (err) {
      boot.appendBlock('Sun occlusion (phase 3 rung 1)', `FAILED: ${String(err)}`)
    }
    boot.setPhase('debug — auditing shader compilation')
    await yieldToBrowser()
    boot.appendBlock('WGSL compilation', await shaderAuditReport())
    boot.appendBlock('Model provenance, with the fire models (spec §0.7)', provenanceReport())
  }

  boot.renderWarnings([
    ...world.warnings,
    ...renderer.foliageRenderer.warnings,
    ...pipelineErrors.map((e) => `INVALID PIPELINE — ${e}`),
  ])

  rig?.detach()
  rig = createCameraRig(world.terrain, {
    rig: { aspect: canvas.width / Math.max(1, canvas.height) },
    free: { defaultSpeedMps: settings.cameraSpeed },
  })
  rig.attach(canvas)
  rig.resize(canvas.width, canvas.height)
  rig.moveTo(metres(DOMAIN_SIZE_M / 2), metres(DOMAIN_SIZE_M / 2))

  hud = new Hud(d.report, world.stats.stemCount, world.stats.uniqueMeshCount, document)
  hud.visible = settings.hudVisible
  new Controls(settings, controlHandlers, document)

  applyQualityPin()
  startLoop(stages)

  // `?bench` sweeps quality 0-5 over a deterministic camera path and prints real per-phase
  // timings. It runs its own rAF loop alongside the app's and only writes camera poses, so
  // this one call is the entire coupling. Nothing is imported unless the flag is present.
  if (benchRequested()) {
    void startBench({
      adapter: d.report,
      profiler: rt.profiler,
      quality: rt.quality,
      rig: rig as CameraRig,
      terrain: world.terrain,
      canvas,
      seed: settings.seed,
      biome: settings.biome,
    })
  }
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

let secondsOfDay = 0
let exposure = 1e-3
let lastWallTime = 0
let fps = 0
let lastHudMs = 0
let firstFrameDone = false
let reportedGpuErrors = 0

/**
 * A GPU validation error raised mid-run is invisible: WebGPU logs it and carries on with the
 * command buffer silently dropped, which reads as the picture freezing or going black. Put it
 * on screen the first time it happens rather than leaving the owner to open a console.
 */
function reportNewGpuErrors(): void {
  if (gpuErrors.length <= reportedGpuErrors) return
  const fresh = gpuErrors.slice(reportedGpuErrors)
  reportedGpuErrors = gpuErrors.length
  console.error('GPU validation error during the frame loop:', fresh.join(String.fromCharCode(10)))
  boot.appendBlock(
    'GPU VALIDATION ERROR DURING THE RUN',
    [
      'The command buffer for this frame was discarded, which is why the picture stopped.',
      '',
      ...fresh,
    ].join(String.fromCharCode(10)),
  )
  boot.show()
}

function startLoop(stages: StageTracker): void {
  const rt = runtime as Runtime
  secondsOfDay = settings.secondsOfDay
  lastWallTime = rt.loop.wallTime
  stages.begin('first-frame')

  rt.start(
    (dt: Seconds) => {
      // The diurnal clock runs on SIMULATED time, not wall time (spec §0.6 rule 5), so it
      // freezes when the loop pauses and scales with timeScale like everything else will.
      secondsOfDay = (secondsOfDay + dt * settings.hoursPerSecond * 3600) % 86400
      stepFire(dt)
    },
    (ctx: FrameContext) => {
      try {
        frame(ctx)
        if (!firstFrameDone) {
          firstFrameDone = true
          stages.end('first-frame')
          boot.hide()
        }
        reportNewGpuErrors()
      } catch (err) {
        rt.stop()
        boot.show()
        if (!firstFrameDone) stages.fail('first-frame', err)
        boot.renderFailure(err)
      }
    },
  )

  // The render callback runs on requestAnimationFrame, which a browser does not fire for a
  // tab it is not compositing. Without this, loading in a background tab leaves the boot
  // screen stuck on "First frame" forever with nothing logged. Hand the screen back and let
  // the real frame draw when the tab becomes visible — reported honestly as skipped, since
  // no frame has in fact been rendered yet.
  if (document.hidden) {
    const onVisible = (): void => {
      if (!document.hidden) {
        document.removeEventListener('visibilitychange', onVisible)
        if (!firstFrameDone) stages.begin('first-frame')
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    setTimeout(() => {
      if (!firstFrameDone && document.hidden) {
        stages.skip('first-frame', 'tab is not visible — deferred until it is')
        boot.hide()
      }
    }, 500)
  }
}

/**
 * One fixed simulation step of the fire, on its OWN command encoder and submission.
 *
 * Deliberately not folded into the frame encoder. The fixed step and the render rate are
 * decoupled (spec §0.5.1, §6.5), and sharing an encoder would quietly re-couple them: the
 * sim's work would only reach the queue when a frame was encoded, so a stalled or throttled
 * `requestAnimationFrame` would stall the physics and every arrival time the HUD reports
 * would be wrong by an unreported amount. A handful of extra submissions per frame is a
 * cheap price for that not being possible.
 *
 * Failures here stop the loop and show the boot screen with the error rather than leaving a
 * silently-frozen fire over a scene that still renders — the worst diagnosis to have to make.
 */
function stepFire(dt: Seconds): void {
  const f = fire
  const d = device
  if (f === null || d === null || settings.firePaused) return
  try {
    const encoder = d.device.createCommandEncoder({ label: 'fire.step' })
    // Attributed to `surface` so the solver's cost appears in the HUD and the bench table.
    // The timestamps land in the profiler's shared query set and are resolved by the frame
    // encoder that follows; this submission goes out first, so they are already written.
    const rt = runtime
    // How far the fire actually moved, `timeScale` included. Everything downstream steps on
    // this, not on `dt`.
    const simDt = f.step(rt === null ? encoder : attributeEncoder(encoder, rt.profiler, 'surface'), dt)
    // M3 on the same encoder and the same clock as the surface fire, attributed to its own
    // phase so the two costs can be told apart. It reads the fields WP 2.4 has just written,
    // so it must follow the surface step within the encoder, never precede it.
    canopy?.step(rt === null ? encoder : attributeEncoder(encoder, rt.profiler, 'canopy'), simDt, f.outputs)
    // The canopy's own answer to "how much of the crown burned", one readback behind. Van
    // Wagner's curve is only the fallback now.
    if (canopy !== null) f.setMeasuredCrownConsumed(canopy.crownConsumedFraction)
    // `fluid` is the profiler phase spec §6.3 reserves for advected fields. It reads the
    // surface arrival times WP 2.4 has just resolved, so it follows both.
    smoke?.step(
      rt === null ? encoder : attributeEncoder(encoder, rt.profiler, 'fluid'),
      simDt,
      f.simTimeS,
    )
    d.device.queue.submit([encoder.finish()])
  } catch (err) {
    fire = null
    runtime?.stop()
    boot.show()
    boot.renderFailure(err)
  }
}

/**
 * Run the composed surface+canopy step long enough for the canopy chain to have something to
 * report.
 *
 * `FireSim.selfTest` cannot serve: it steps only the surface solver, on its own encoders, and
 * resets the fire when it finishes. The canopy probe needs a fire that is *currently* flaming,
 * because the emitter pass reads the BURNING band and nothing else.
 *
 * 90 s of simulated time at the 8 s radiation interval is a dozen radiation solves — enough
 * for the field to be established rather than caught mid-first-gather.
 */
async function primeCanopy(): Promise<string> {
  const f = fire
  const c = canopy
  const d = device
  if (f === null || c === null || d === null) return 'no fire or canopy'
  const centre = metres(DOMAIN_SIZE_M / 2)
  f.reset()
  f.ignite({ kind: 'point', x: centre, z: centre, radius: metres(15) })
  const dt = seconds(1 / 30)
  for (let i = 0; i < 900; i++) {
    const encoder = d.device.createCommandEncoder({ label: 'canopy.prime' })
    const simDt = f.step(encoder, dt)
    c.step(encoder, simDt, f.outputs)
    // The smoke field advects on the same clock. Leaving it out of the prime loop is why the
    // probe below reported an empty field on the first attempt: everything was wired and
    // nothing had ever been stepped.
    smoke?.step(encoder, simDt, f.simTimeS)
    d.device.queue.submit([encoder.finish()])
    // Yield often: both subsystems keep mapAsync-driven readbacks whose callbacks are
    // macrotasks, and a tight loop starves them exactly as it did in the surface self-test.
    if ((i & 15) === 15) {
      // Re-seat the plume on the fire, exactly as the frame loop does. Leaving it out meant
      // the probe ran a plume pinned to the ignition point while the front moved away from
      // it — so the probe was not exercising the shipping path, which is the one thing a
      // probe exists to do.
      applyCanopyWeather()
      await d.device.queue.onSubmittedWorkDone()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  await d.device.queue.onSubmittedWorkDone()
  await new Promise((r) => setTimeout(r, 50))
  await f.outputs.readAggregates()
  const sm = await probeSmoke()
  return (
    `${sm}
` +
    `prime run         ${f.simTimeS.toFixed(1)} s simulated at timeScale ${f.timeScale}, ` +
    `${f.ignitionCount} ignition(s)
` +
    `  surface         ${f.outputs.burntAreaM2.toFixed(0)} m2 burnt, ` +
    `${f.activeCellCount} active cells, peak ` +
    `${(f.outputs.maxFirelineIntensity as number).toFixed(0)} kW/m` +
    (f.dispatchOverflowed ? '   <- DISPATCH OVERFLOWED' : '')
  )
}

/**
 * Read a horizontal slice of the smoke field back and report what is in it.
 *
 * The field is 8 MiB of rgba16float that nothing on the CLI can see, and an advected field that
 * is quietly empty looks identical to one the renderer is failing to sample. Sampling at the
 * second level rather than the ground one checks that buoyancy actually lifted the mass, which
 * a ground-level sample cannot distinguish from injection with no transport at all.
 */
async function probeSmoke(): Promise<string> {
  const d = device
  const sf = smoke
  if (d === null || sf === null) return 'smoke field      not constructed'
  const n = 64
  // Four levels, not one: an empty slice cannot distinguish "nothing was injected" from
  // "injection worked and nothing was lifted", and those have completely different causes.
  const LEVELS = 4
  const bytesPerRow = 256 * Math.ceil((n * 8) / 256) // rgba16float = 8 B/texel
  const buf = d.device.createBuffer({
    label: 'smoke.probe',
    size: bytesPerRow * n * LEVELS,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const enc = d.device.createCommandEncoder({ label: 'smoke.probe' })
  enc.copyTextureToBuffer(
    { texture: sf.current, origin: { x: SMOKE_NXZ / 2 - n / 2, y: SMOKE_NXZ / 2 - n / 2, z: 0 } },
    { buffer: buf, bytesPerRow, rowsPerImage: n },
    { width: n, height: n, depthOrArrayLayers: LEVELS },
  )
  d.device.queue.submit([enc.finish()])
  await d.device.queue.onSubmittedWorkDone()
  await buf.mapAsync(GPUMapMode.READ)
  const halfs = new Uint16Array(buf.getMappedRange().slice(0))
  buf.unmap()
  buf.destroy()

  const decode = (h: number): number => {
    const exp = (h >> 10) & 0x1f
    const frac = h & 0x3ff
    const sign = h & 0x8000 ? -1 : 1
    if (exp === 0) return sign * frac * 2 ** -24
    if (exp === 31) return frac === 0 ? sign * Infinity : NaN
    return sign * (1 + frac / 1024) * 2 ** (exp - 15)
  }
  let peakT = 0
  let peakMass = 0
  let ecAtPeak = 0
  const perLevel: number[] = []
  for (let z = 0; z < LEVELS; z++) {
    let filled = 0
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const o = (z * n + r) * (bytesPerRow / 2) + c * 4
        const t = decode(halfs[o] as number)
        const mass = decode(halfs[o + 1] as number)
        const ec = decode(halfs[o + 2] as number)
        if (mass > 0) filled++
        if (t > peakT) peakT = t
        if (mass > peakMass) {
          peakMass = mass
          ecAtPeak = ec
        }
      }
    }
    perLevel.push(filled)
  }
  const f = peakMass > 0 ? ecAtPeak / peakMass : 0
  const lut = canopy?.lastLut ?? new Float32Array(0)
  const w = (row: number): string => (lut[row * 4 + 1] ?? 0).toFixed(2)
  const plumeLine =
    lut.length === 0
      ? '  plume LUT        not built'
      : `  plume LUT        w = ${w(0)} / ${w(2)} / ${w(8)} / ${w(16)} m/s at rows 0/2/8/16, ` +
        `B0 = ${(canopy?.lastProfile.b0 ?? 0).toExponential(2)}, ` +
        `level-off ${(canopy?.lastProfile.levelOff ?? 0).toFixed(0)} m`
  const total = perLevel.reduce((a, b) => a + b, 0)
  return (
    `smoke field       peak ${peakMass.toExponential(2)} kg/m3, +${peakT.toFixed(1)} K, ` +
    `f = ${f.toFixed(3)}
` +
    `  cells with mass  ${perLevel.map((v, i) => `L${i}:${v}`).join('  ')} of 4096 each
` +
    plumeLine +
    (total === 0
      ? '   <- EMPTY: nothing injected'
      : (perLevel[0] ?? 0) > 0 && total === (perLevel[0] ?? 0)
        ? '   <- injected but NOT LIFTED: buoyancy is zero'
        : '')
  )
}

/**
 * March the froxel volume once from a synthetic camera and report what came back.
 *
 * The volumetrics only run inside `frame()`, which is driven by `requestAnimationFrame` — and
 * a browser does not fire that for a tab it is not compositing. In this environment that makes
 * the entire pass unverifiable by looking at it, so it is verified by reading it: encode one
 * march and check that the scattered-radiance target is non-zero where the plume is.
 *
 * The camera is placed 60 m from the domain centre at 25 m up, looking down at the fire, which
 * puts the plume across the middle of the frame at a distance the near-field slices resolve.
 */
async function probeVolumetrics(): Promise<string> {
  const d = device
  const r = renderer
  const sf = smoke
  const w = world
  if (d === null || r === null || sf === null || w === null) return 'volumetrics     not constructed'
  const vol = r.volumetrics
  if (vol === null) return 'volumetrics     not constructed'

  const centre = DOMAIN_SIZE_M / 2
  const ground = w.terrain.heightAt(metres(centre), metres(centre)) as number
  const eye = v3(centre - 60, ground + 25, centre)
  const target = v3(centre, ground + 8, centre)
  const view = mat4Create()
  mat4View(view, eye, vNormalize(vSub(target, eye)), v3(0, 1, 0))
  const proj = mat4Create()
  mat4Perspective(proj, Math.PI / 3, 16 / 9, 0.1, 4000, REVERSED_Z)
  const vp = mat4Create()
  mat4Multiply(vp, proj, view)
  const inv = mat4Create()
  if (!mat4Invert(inv, vp)) return 'volumetrics     synthetic camera matrix is singular'

  const enc = d.device.createCommandEncoder({ label: 'froxel.probe' })
  vol.encode(
    enc,
    {
      camera: {
        position: [metres(eye.x), metres(eye.y), metres(eye.z)],
        invViewProjMatrix: inv as unknown as Float32Array,
      },
      smoke: sf.current,
      height: w.terrain.heightTexture,
      depth: r.targets.depthView,
      hdr: r.targets.colorView,
      sunDirection: [0.3, 0.9, 0.3],
      sunIrradiance: [849, 849, 849],
      skyIrradiance: [141, 141, 141],
      ambientK: 293.15,
      domainSizeM: metres(DOMAIN_SIZE_M),
      smokeTopM: SMOKE_TOP_M,
      slices: 128,
    },
    r.targets.width,
    r.targets.height,
  )
  d.device.queue.submit([enc.finish()])
  await d.device.queue.onSubmittedWorkDone()

  const read = async (tex: GPUTexture): Promise<Float32Array> => {
    const bytesPerRow = 256 * Math.ceil((FROXEL_NX * 8) / 256)
    const buf = d.device.createBuffer({
      label: 'froxel.probe.read',
      size: bytesPerRow * FROXEL_NY,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const e = d.device.createCommandEncoder({ label: 'froxel.probe.copy' })
    e.copyTextureToBuffer(
      { texture: tex },
      { buffer: buf, bytesPerRow, rowsPerImage: FROXEL_NY },
      { width: FROXEL_NX, height: FROXEL_NY },
    )
    d.device.queue.submit([e.finish()])
    await d.device.queue.onSubmittedWorkDone()
    await buf.mapAsync(GPUMapMode.READ)
    const halfs = new Uint16Array(buf.getMappedRange().slice(0))
    buf.unmap()
    buf.destroy()
    const out = new Float32Array(FROXEL_NX * FROXEL_NY * 4)
    const decode = (h: number): number => {
      const exp = (h >> 10) & 0x1f
      const frac = h & 0x3ff
      const sign = h & 0x8000 ? -1 : 1
      if (exp === 0) return sign * frac * 2 ** -24
      if (exp === 31) return frac === 0 ? sign * Infinity : NaN
      return sign * (1 + frac / 1024) * 2 ** (exp - 15)
    }
    for (let y = 0; y < FROXEL_NY; y++) {
      for (let x = 0; x < FROXEL_NX; x++) {
        for (let c = 0; c < 4; c++) {
          out[(y * FROXEL_NX + x) * 4 + c] = decode(halfs[y * (bytesPerRow / 2) + x * 4 + c] as number)
        }
      }
    }
    return out
  }

  const scat = await read(vol.scatter)
  const trans = await read(vol.transmittance)
  let peak = 0
  let lit = 0
  let peakRgb: readonly number[] = [0, 0, 0]
  let minT = 1
  let occluded = 0
  let nan = 0
  for (let i = 0; i < FROXEL_NX * FROXEL_NY; i++) {
    const rr = scat[i * 4] as number
    const gg = scat[i * 4 + 1] as number
    const bb = scat[i * 4 + 2] as number
    if (!Number.isFinite(rr) || !Number.isFinite(gg) || !Number.isFinite(bb)) nan++
    const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb
    if (lum > 0) lit++
    if (lum > peak) {
      peak = lum
      peakRgb = [rr, gg, bb]
    }
    const tg = trans[i * 4 + 1] as number
    if (tg < 1) occluded++
    if (tg < minT) minT = tg
  }
  const total = FROXEL_NX * FROXEL_NY
  const [pr, pg, pb] = peakRgb
  return (
    `volumetrics       peak scatter ${peak.toExponential(2)} W/m2/sr over ${lit}/${total} froxels\n` +
    `  peak RGB        ${(pr as number).toExponential(2)} / ${(pg as number).toExponential(2)} / ` +
    `${(pb as number).toExponential(2)}` +
    ((pr as number) > (pb as number) ? '   (red-dominant, as smoke and flame should be)' : '   <- NOT red-dominant') +
    `\n  transmittance   min ${minT.toFixed(4)}, ${occluded}/${total} froxels attenuated` +
    (nan > 0 ? `\n  <- ${nan} NON-FINITE froxels: a NaN here blackens the frame` : '') +
    (lit === 0 ? '\n  <- NO SCATTER: the march found no medium, or the field is empty' : '')
  )
}

function frame(ctx: FrameContext): void {
  const d = device as Device
  const rt = runtime as Runtime
  const r = renderer as WorldRenderer
  const w = world as GeneratedWorld
  const cam = rig as CameraRig

  // Wall delta from the loop's own clamped clock, so a tab switch cannot teleport the
  // camera and the two clocks cannot disagree.
  const wall = rt.loop.wallTime as number
  const wallDt = Math.max(0, wall - lastWallTime)
  lastWallTime = wall
  if (wallDt > 0) fps = fps === 0 ? 1 / wallDt : fps * 0.9 + (1 / wallDt) * 0.1

  if (syncCanvasSize(canvas, d.device)) {
    r.resize(canvas.width, canvas.height)
    cam.resize(canvas.width, canvas.height)
  }

  cam.update(seconds(wallDt))
  r.foliageRenderer.setTime(rt.loop.simTime as number)

  const time: TimeOfDay = { secondsOfDay: seconds(secondsOfDay), dayOfYear: settings.dayOfYear }
  const solar = r.skyRenderer.fullSolarState(time, w.config.site.latitudeDeg, w.config.site.longitudeDeg)

  const target = autoExposure({
    directIrradiance: solar.directIrradiance,
    diffuseIrradiance: solar.diffuseIrradiance,
    elevation: solar.elevation as number,
    compensationStops: settings.exposureStops,
    // A conifer canopy reflects about 0.13 and a grassland about 0.21. Metering both at one
    // number is what left the forest 0.8 stops under.
    biome: settings.biome,
  })
  exposure = adaptExposure(exposure, target, wallDt)

  // The smoke field ping-pongs every step, so the renderer is told which buffer is current
  // rather than caching one. Caching it shows the field as it was two steps ago, on alternate
  // frames, which reads as a flicker rather than as a bug.
  r.smokeField = smoke?.current ?? null
  r.beginFrame(ctx)
  r.renderWith(ctx, {
    camera: cam.state,
    solar,
    quality: ctx.quality,
    exposure,
    // The solver's own simulated clock, not the render clock — the isochrone bands are drawn
    // against it and would smear if they were handed wall time.
    ...(fire === null
      ? {}
      : { fire: { simTimeS: fire.simTimeS, activeCellCount: fire.activeCellCount } }),
  })

  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (hud !== null && hud.visible && now - lastHudMs > 200) {
    lastHudMs = now
    const p = cam.state.position
    const diag = r.foliageRenderer.diagnostics
    hud.update({
      timings: rt.profiler.timings,
      fps,
      quality: rt.quality.level,
      qualityPinned: settings.qualityPin !== null,
      settings: ctx.quality,
      cameraMode: cam.mode,
      position: [p[0] as number, p[1] as number, p[2] as number],
      groundY: w.terrain.heightAt(clampDomain(p[0]), clampDomain(p[2])) as number,
      pointerLocked: cam.pointerLocked,
      foliage: r.foliageRenderer.stats,
      droppedStems: diag.droppedStems,
      clampEvents: diag.clampEvents,
      terrainTriangles: r.terrainPass.triangleCount,
      solar,
      secondsOfDay,
      dayOfYear: settings.dayOfYear,
      exposure,
      renderWidth: r.targets.width,
      renderHeight: r.targets.height,
      ...(fire === null ? {} : { fire: fireHudFrame(fire) }),
    })
  }
}

/**
 * Snapshot the solver for the HUD.
 *
 * `missing` is not padding: it is the list of fields the HUD would otherwise report as a
 * physical zero when they are really an integration gap. It shrank on 2026-08-19 when WP 2.3
 * and WP 2.4 were reconciled — the propagation pass now stamps the rate of spread at arrival,
 * and `FireOutputs` derives intensity and consumed fraction from it — and it should keep
 * shrinking. Anything still listed here is not yet physics.
 */
function fireHudFrame(f: FireSim): FireHudFrame {
  const p = f.predicted
  const out = f.outputs
  const crown = f.crown
  return {
    running: !settings.firePaused,
    timeScale: f.timeScale,
    simTimeS: f.simTimeS,
    fuelModelCode: f.fuelModelCode,
    fuelModelName: FUEL_MODELS.get(f.fuelModelCode).name,
    ignitionCount: f.ignitionCount,
    windMps: settings.windMps,
    windFromDeg: settings.windFromDeg,
    dead1hPct: settings.dead1hPct,
    predicted: {
      rateOfSpreadMps: p.rateOfSpread as number,
      firelineIntensityKWm: p.firelineIntensity as number,
      flameLengthM: p.flameLength as number,
      lengthToBreadth: p.lengthToBreadth,
      effectiveWindMps: p.effectiveWind as number,
      extinguished: p.extinguished,
    },
    ...(crown === null
      ? {}
      : {
          crown: {
            classification: crown.classification,
            criticalIntensityKWm: crown.criticalIntensity as number,
            crownFractionBurned: crown.crownFractionBurned,
            cfbIsDiagnostic: crown.crownFractionBurnedIsDiagnostic,
            envelopeWarnings: crown.envelopeWarnings,
            ...(renderer?.flames == null
              ? {}
              : {
                  flames: {
                    total: renderer.flames.lastFlameCount,
                    crown: renderer.flames.lastCanopyFlameCount,
                    capacity: MAX_FLAMES,
                    voxelsFlaming: canopy?.flamingVoxels ?? 0,
                  },
                }),
          },
        }),
    measured: {
      burntAreaM2: out.burntAreaM2,
      perimeterM: out.perimeterM,
      activeCellCount: f.activeCellCount,
      maxFirelineIntensityKWm: out.maxFirelineIntensity as number,
      dispatchOverflowed: f.dispatchOverflowed,
    },
    missing: MISSING_OUTPUTS,
  }
}

/**
 * Things the renderer or the sim does NOT do, stated in the HUD so a missing effect reads as
 * a known gap rather than a bug. **Keep this honest in both directions** — an entry that has
 * since been built is worse than no entry at all, because it teaches the reader to ignore the
 * list. "No cast shadows anywhere" lived here after sun occlusion shipped.
 */
const MISSING_OUTPUTS: readonly string[] = [
  'crown fire is classified by the Van Wagner CURVE, not by the 3D canopy: the voxel',
  '  combustion runs, but CFB is the empirical criterion, not a count of what burned',
  'fire lights nothing (WP 4.4): flames are emissive but cast no light on grass or trunks',
  'shadows are a top-down occlusion map, not cascades — no side-lit trunk shadows',
  'volumetrics have no sun-transmittance volume (spec §7.1.4), so the plume does not',
  '  self-shadow: a thick column is lit evenly instead of bright on top, dark underneath',
  'soot yield is `estimated` and scales plume opacity linearly (Andreae 2019 Table 1 unread)',
]

function clampDomain(v: number): Metres {
  return metres(Math.min(DOMAIN_SIZE_M, Math.max(0, v)))
}

/** `settings.fireView` is a plain string so `settings.ts` stays free of render imports. */
function asFireView(v: string): FireDebugViewId {
  return (FIRE_DEBUG_VIEWS as readonly string[]).includes(v) ? (v as FireDebugViewId) : 'arrival'
}

/**
 * Push the current fire and wind state into M3's plume.
 *
 * The plume is a property of the fire driving it, so this is called on any weather change and
 * whenever the fire's predicted intensity moves — not on a timer. The source is placed at the
 * domain centre until the plume becomes per-front at M5; a single line plume over the whole
 * fire is exactly the simplification `solvePlume` is written for.
 */
function applyCanopyWeather(): void {
  const c = canopy
  const f = fire
  const w = world
  if (c === null || f === null || w === null) return
  const centre = metres(DOMAIN_SIZE_M / 2)
  // Meteorological convention: `windFromDeg` is where the wind blows FROM, clockwise from
  // north. The plume leans the other way, which is the sign error that would make fire lean
  // into the wind instead of away from it.
  const toRad = ((settings.windFromDeg + 180) * Math.PI) / 180
  // Same wind vector the plume leans along, so the smoke cannot drift in one direction while
  // the plume tilts in another.
  smoke?.setWind(Math.sin(toRad) * settings.windMps, -Math.cos(toRad) * settings.windMps)
  smoke?.setModel(f.burnoutModelForSmoke())
  // Anchor the plume on the FLAMING FRONT, not the middle of the map. A fixed source meant a
  // fire spreading away from the domain centre left its own plume behind: every crown at the
  // front then read ambient gas, and the canopy could not ignite however hard the surface
  // burned. Falls back to the centre only while nothing is alight, when there is no plume to
  // place anyway.
  const seat = f.outputs.flamingCentroid
  const plumeX = metres(seat?.x ?? (centre as number))
  const plumeZ = metres(seat?.z ?? (centre as number))
  c.setWeather({
    firelineIntensityKWm: f.predicted.firelineIntensity as number,
    // D = R * t_r, Rothermel/Anderson — the along-wind depth of the flaming zone, and the
    // width of the line source the plume rises from. It was hardcoded to 1 m, which makes the
    // plume a narrow column: `gaussT` then falls to nothing within a few metres of the axis
    // and crowns either side of the front see ambient gas. A slash fire's flaming zone is
    // several metres deep, so this was out by a factor of several.
    flameDepthM: Math.max(0.1, flameDepth(f.predicted.rateOfSpread, f.predicted.residenceTime) as number),
    sourceX: plumeX as number,
    sourceZ: plumeZ as number,
    sourceGroundY: w.terrain.heightAt(plumeX, plumeZ) as number,
    windSpeedMps: settings.windMps,
    windDirX: Math.sin(toRad),
    windDirZ: -Math.cos(toRad),
  })
}

/** The one place percent-quoted moisture becomes the fraction the solver requires (§0.6). */
function weatherFromSettings(s: AppSettings): SurfaceWeather {
  return weatherFrom({
    windMps: s.windMps,
    windFromDeg: s.windFromDeg,
    dead1h: s.dead1hPct / 100,
    liveHerb: s.liveHerbPct / 100,
  })
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function applyQualityPin(): void {
  runtime?.quality.pin(settings.qualityPin)
}

const controlHandlers = {
  onLive(patch: Partial<AppSettings>): void {
    const grassChanged = patch.grassEnabled !== undefined && patch.grassEnabled !== settings.grassEnabled
    settings = { ...settings, ...patch }
    if (patch.secondsOfDay !== undefined) secondsOfDay = patch.secondsOfDay
    if (patch.qualityPin !== undefined) applyQualityPin()
    if (patch.cameraSpeed !== undefined && rig !== null) rig.freeSpeed = patch.cameraSpeed
    if (patch.dayOfYear !== undefined) renderer?.environmentLighting.invalidate()
    if (
      patch.windMps !== undefined ||
      patch.windFromDeg !== undefined ||
      patch.dead1hPct !== undefined ||
      patch.liveHerbPct !== undefined
    ) {
      fire?.setWeather(weatherFromSettings(settings))
      applyCanopyWeather()
    }
    if (patch.fireTimeScale !== undefined && fire !== null) fire.timeScale = patch.fireTimeScale
    if (patch.fireView !== undefined && renderer !== null && fire !== null) {
      if (patch.fireView === 'off') {
        renderer.fireDebug?.destroy()
        renderer.fireDebug = null
      } else if (renderer.fireDebug !== null) {
        renderer.fireDebug.view = asFireView(patch.fireView)
      } else {
        void renderer.attachFireDebug(fire.outputs, asFireView(patch.fireView))
      }
    }
    if (patch.fuelModel !== undefined && fire !== null && world !== null) {
      fire.setFuelModel(
        patch.fuelModel ??
          dominantFuelModel(world.config.vegetation.speciesMix, world.vegetation.species),
      )
    }
    // Grass is baked into the foliage pipeline at construction, so toggling it is a rebuild.
    if (grassChanged) void regenerate(settings.seed, settings.biome)
    history.replaceState(null, '', searchFromSettings(settings))
  },
  onRegenerate(seed: number, biome: BiomeId): void {
    void regenerate(seed, biome)
  },
  onTeleport(): void {
    rig?.moveTo(metres(DOMAIN_SIZE_M / 2), metres(DOMAIN_SIZE_M / 2))
  },
  onIgnite(): void {
    igniteAt([0, 0])
  },
  onResetFire(): void {
    resetFire()
  },
}

async function regenerate(seed: number, biome: BiomeId): Promise<void> {
  if (regenerating) return
  regenerating = true
  try {
    settings = { ...settings, seed, biome }
    history.replaceState(null, '', searchFromSettings(settings))
    runtime?.stop()
    firstFrameDone = false
    smoke?.destroy()
    canopy?.destroy()
    fire?.destroy()
    renderer?.destroy()
    world?.destroy()
    smoke = null
    canopy = null
    fire = null
    renderer = null
    world = null

    const stages = new StageTracker()
    stages.onChange((records) => boot.renderStages(records))
    stages.skip('device', 'already up')
    boot.renderStages(stages.records)
    await build(stages)
  } catch (err) {
    boot.renderFailure(err)
  } finally {
    regenerating = false
  }
}

// Keys that are about diagnostics rather than camera control, so not bound through WP 1.8's
// input map. `F` is already the camera toggle there, hence `V` for the fire view.
window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return
  if (ev.code === 'KeyH' && hud !== null) {
    hud.visible = !hud.visible
    settings = { ...settings, hudVisible: hud.visible }
    return
  }
  if (ev.code === 'KeyV' && renderer?.fireDebug != null) {
    const next = cycleView(renderer.fireDebug.view, ev.shiftKey ? -1 : 1)
    renderer.fireDebug.view = next
    settings = { ...settings, fireView: next }
    return
  }
  if (ev.code === 'KeyR' && ev.shiftKey) resetFire()
})

// Right-click ignites. Left-click is already spoken for — WP 1.8's rig takes pointer lock
// with it — and under pointer lock the cursor position is meaningless, so the ray is taken
// through the crosshair instead. Both states go through the same picker.
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault())
canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 2) return
  ev.preventDefault()
  igniteAt(
    rig?.pointerLocked === true
      ? [0, 0]
      : ndcFromPointer(ev.clientX, ev.clientY, canvas.getBoundingClientRect()),
  )
})

/** Ignite where the ray through `ndc` meets the ground. Reports failure rather than no-op. */
function igniteAt(ndc: readonly [number, number]): void {
  const f = fire
  const w = world
  const cam = rig
  if (f === null || w === null || cam === null) return
  const hit = pickGround(cam.state, w.terrain, ndc)
  if (hit === null) {
    toast('no ground under the cursor — aim below the horizon')
    return
  }
  f.ignite(
    ignitionShape({
      tool: settings.ignitionTool,
      x: hit.x,
      z: hit.z,
      radiusM: settings.ignitionRadiusM,
      windDirection: f.weather.windDirection,
    }),
  )
  toast(
    `${settings.ignitionTool} ignition at ${(hit.x as number).toFixed(0)}, ` +
      `${(hit.z as number).toFixed(0)} m${hit.clamped ? ' (clamped to domain)' : ''}`,
  )
}

let toastTimer = 0
function toast(text: string): void {
  const el = document.getElementById('toast')
  if (el === null) return
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.hidden = true
  }, 2500)
}

function resetFire(): void {
  fire?.reset()
  const d = device
  if (smoke !== null && d !== null) {
    const enc = d.device.createCommandEncoder({ label: 'smoke.reset' })
    smoke.reset(enc)
    d.device.queue.submit([enc.finish()])
  }
  toast('fire reset')
}

main().catch((err: unknown) => {
  boot.renderFailure(err)
})
