/**
 * M3, composed.
 *
 * Seven work packages shipped and none of them constructed anything: WP 3.1's sparse store,
 * 3.2's kinetics, 3.3's radiation, 3.4's convection, 3.6's firebrands. The HUD carried a
 * standing "NOT WIRED" line saying so. This is the object that owns all of them, decides what
 * runs at which rate, and hands each one the resource kind it wants.
 *
 * Three clocks, deliberately different (spec §7.5):
 *
 * | channel | rate | why |
 * |---|---|---|
 * | plume LUT | on weather change | 41 µs of CPU RK4, and the inputs only move when the user or the fire moves them |
 * | radiation | 7.5 Hz | the irradiance field's physical timescale is minutes; 133 ms of staleness costs 1.3 % at 20 m |
 * | voxel step + firebrands | every canopy step | convection ignites fuel in ~1 s and is the fast channel |
 *
 * Running radiation at the step rate would be the single most expensive mistake available
 * here, and running the voxel step at the radiation rate would miss the ignition it exists to
 * catch. Both are easy to get wrong by writing `step()` once and calling everything from it.
 */

import { DOMAIN_SIZE_M } from '@contracts/world'
import type { Seconds } from '@contracts/units'
import { m as metres, kWm } from '@contracts/units'
import type { ITerrainField, IVegetationSet, SpeciesDef } from '@contracts/world'
import { CanopyVoxelStore, packStore } from '@sim/canopy/storage/store.ts'
import { type VoxeliseResult, voxeliseVegetation } from '@sim/canopy/storage/voxelise.ts'
import { CanopyRadiation } from '@sim/canopy/radiation/pass.ts'
import { SurfaceEmitterPass } from '@sim/canopy/radiation/surfaceEmitters.ts'
import { buildBrickList, buildExtinctionField } from '@sim/canopy/radiation/build.ts'
import { RAD_UPDATE_INTERVAL_S, MIN_RAY_COUNT, RAD_NI, RAD_NJ } from '@sim/canopy/radiation/layout.ts'
import { CanopyVoxelStep, OFFSET_NONE, OFFSET_SCALE, TEMP_SCALE } from '@sim/canopy/voxelStep.ts'

/** flaming, everIgnited, crownDry, crownInitial, maxTemp, warmCount, maxGas, minOffset. */
const STATS_BYTES = 44
import { PLUME_UNIFORM_BYTES, packPlumeUniforms } from '@sim/canopy/convection/plume.ts'
import { buildPlumeLut, solvePlume } from '@sim/canopy/convection/plume.ts'


import { FirebrandSystem } from '@sim/firebrands/system.ts'
import type { IFireOutputs } from '@contracts/sim'

export interface CanopySimOptions {
  readonly device: GPUDevice
  readonly vegetation: IVegetationSet
  readonly terrain: ITerrainField
  readonly species: ReadonlyMap<string, SpeciesDef>
  /** Ambient air temperature, K. */
  readonly ambientK?: number
}

export interface CanopyWeather {
  /** Byram intensity of the fire driving the plume, kW/m. 0 = no plume. */
  readonly firelineIntensityKWm: number
  /** Flame depth, m. Sets the plume's initial half-width. */
  readonly flameDepthM: number
  /** Plume source position, world metres. */
  readonly sourceX: number
  readonly sourceZ: number
  readonly sourceGroundY: number
  readonly windSpeedMps: number
  /** Unit wind vector in world x–z. */
  readonly windDirX: number
  readonly windDirZ: number
}

export interface CanopyBuildStats {
  readonly occupiedVoxels: number
  readonly slotCount: number
  readonly activeBricks: number
  readonly totalBricks: number
  readonly depositedMassKg: number
  readonly clippedMassKg: number
  readonly buildMs: number
}

export class CanopySim {
  readonly store: CanopyVoxelStore
  readonly radiation: CanopyRadiation
  readonly emitters: SurfaceEmitterPass
  readonly voxels: CanopyVoxelStep
  readonly firebrands: FirebrandSystem
  readonly stats: CanopyBuildStats

  /** The plume LUT as last packed, for the `?debug` probe. Rows of [dT, w, b, tilt]. */
  lastLut: Float32Array = new Float32Array(0)
  /** Diagnostic scalars from the last plume solve. */
  lastProfile: { levelOff: number; b0: number } = { levelOff: 0, b0: 0 }

  /** Flaming and ever-ignited voxel counts, one readback behind. The M3 acceptance number. */
  flamingVoxels = 0
  everIgnitedVoxels = 0
  /**
   * Fraction of crown fuel consumed, MEASURED from the voxel field rather than inferred from
   * a spread rate. `vanWagner.ts` prefers this over its own CFB curve and has never had it.
   * Null until the first readback lands, so "not measured yet" stays distinguishable from
   * "measured zero" — those are different states and only one of them is a bug.
   */
  crownConsumedFraction: number | null = null
  private burntAreaM2 = 0
  /** Domain-wide crown fuel totals from the last readback, dry density x scale. */
  private crownDryRaw = 0
  private crownInitialRaw = 0
  /** Hottest canopy voxel, K. The chain's own answer to "is anything up there heating?". */
  maxVoxelTempK = 0

  /** Hottest plume gas any occupied voxel sampled this step [K]. */
  maxGasTempK = 0

  /**
   * Closest any occupied voxel got to the tilted plume centreline [m], or `null` when none was
   * inside the plume at all. The core at crown base is under a metre wide against a 2 m voxel,
   * so this is what tells a resolution limit apart from a wiring bug.
   */
  minCentrelineOffsetM: number | null = null
  /** Voxels at least 50 K over ambient. */
  warmVoxels = 0

  private readonly device: GPUDevice
  private readonly brickList: GPUBuffer
  private readonly brickCount: number
  private readonly plumeBuffer: GPUBuffer
  private readonly statsStaging: GPUBuffer
  private readonly ambientK: number
  private surfaceState: GPUTexture
  private nextRadiationS = 0
  private simTimeS = 0
  private rayCount = MIN_RAY_COUNT
  private readingBack = false
  private copyPending = false

  constructor(options: CanopySimOptions) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0
    const device = options.device
    this.device = device
    this.ambientK = options.ambientK ?? 293.15
    // Replaced on the first step(); the probe only reads it after one has run.
    this.surfaceState = options.terrain.heightTexture

    // --- WP 3.1: voxelise, pack, upload ------------------------------------
    const { occupancy, layout, fields } = voxeliseVegetation(options.vegetation, options.terrain)
    const packed = packStore(fields, occupancy.ground, options.species, { ambientK: this.ambientK })
    this.store = new CanopyVoxelStore(device, layout, packed)

    // --- WP 3.3: the two build inputs nothing produced ----------------------
    this.radiation = new CanopyRadiation(device)
    this.radiation.uploadExtinction(buildExtinctionField(fields, options.species))

    const bricks = buildBrickList(fields)
    this.brickCount = bricks.count
    this.brickList = device.createBuffer({
      label: 'canopy.brickList',
      size: Math.max(4, bricks.indices.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this.brickList, 0, bricks.indices as Uint32Array<ArrayBuffer>)

    this.emitters = new SurfaceEmitterPass(device)

    // --- WP 3.4: the plume uniform the voxel pass samples --------------------
    this.plumeBuffer = device.createBuffer({
      label: 'canopy.plumeUniforms',
      size: PLUME_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    // A no-fire plume, so the buffer is never read uninitialised. Every voxel then sees
    // ambient gas at the ambient wind, which is the correct answer before anything is alight.
    this.setWeather({
      firelineIntensityKWm: 0,
      flameDepthM: 1,
      sourceX: 0,
      sourceZ: 0,
      sourceGroundY: 0,
      windSpeedMps: 0,
      windDirX: 1,
      windDirZ: 0,
    })

    // --- WP 3.2 + 3.1: the pass that joins them -----------------------------
    this.voxels = new CanopyVoxelStep(
      device,
      layout,
      {
        columns: this.store.columnIndexBuffer,
        ground: this.store.groundBuffer,
        poolA: this.store.poolABuffer,
        poolB: this.store.poolBBuffer,
        poolC: this.store.poolCBuffer,
        irradiance: this.radiation.irradiance,
        plume: this.plumeBuffer,
      },
      { ambientK: this.ambientK },
    )

    this.firebrands = new FirebrandSystem(device)

    this.statsStaging = device.createBuffer({
      label: 'canopy.voxelStats.staging',
      size: STATS_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    this.stats = {
      occupiedVoxels: countOccupied(occupancy),
      slotCount: layout.voxelCount,
      activeBricks: bricks.count,
      totalBricks: bricks.total,
      depositedMassKg: fields.depositedMassKg,
      clippedMassKg: fields.clippedMassKg,
      buildMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
    }

  }

  /**
   * Await the radiation pipelines.
   *
   * `CanopyRadiation` compiles asynchronously on purpose (§6.8 pitfall 7: Dawn compiles
   * lazily, so the first ignition would otherwise stall for a couple of hundred milliseconds)
   * and throws from `encode` until it has finished. The constructor cannot await, so the
   * composer must — and must do so before the first step, not before the first fire.
   */
  async ready(): Promise<void> {
    await this.radiation.compile()
  }

  /**
   * WP 3.4's packed plume uniform.
   *
   * Shared with M4's smoke field, which advects on the same buoyant velocity. Two plumes in
   * one simulation — one heating the canopy, another carrying the smoke — would drift apart
   * silently and look plausible the whole time.
   */
  get plumeUniforms(): GPUBuffer {
    return this.plumeBuffer
  }

  /** Quality tier's ray count for the radiation gather (spec §6.7 floors it at 8). */
  setRayCount(rays: number): void {
    this.rayCount = Math.max(MIN_RAY_COUNT, Math.trunc(rays))
  }

  /**
   * Re-solve the plume and repack the uniform.
   *
   * Called on a weather change and at {@link PLUME_UPDATE_INTERVAL_S}; the RK4 solve is 41 µs,
   * so the rate limit is about not re-uploading 544 B sixty times a second rather than about
   * the arithmetic.
   */
  setWeather(weather: CanopyWeather): void {
    const intensity = Math.max(0, weather.firelineIntensityKWm)
    const profile = solvePlume(
      { intensity: kWm(intensity), flameDepth: metres(Math.max(0.1, weather.flameDepthM)) },
      {
        tempK: this.ambientK as never,
        density: 1.2,
        // Neutral. M5's stability model replaces this; until then a neutral plume rises
        // without limit, which over-predicts reach rather than under-predicting it.
        potentialTempGradient: 0,
        wind: () => weather.windSpeedMps,
      },
    )
    const lut = buildPlumeLut(profile)
    this.lastLut = lut
    this.lastProfile = { levelOff: profile.levelOffHeight, b0: profile.buoyancyFlux0 }
    const packedUniform = packPlumeUniforms({
      lut,
      sourceX: weather.sourceX,
      sourceZ: weather.sourceZ,
      sourceGroundY: weather.sourceGroundY,
      windSpeed: weather.windSpeedMps,
      ambientTempK: this.ambientK,
      windDirX: weather.windDirX,
      windDirZ: weather.windDirZ,
    })
    this.device.queue.writeBuffer(this.plumeBuffer, 0, packedUniform as Float32Array<ArrayBuffer>)
  }

  /**
   * One canopy step, on the caller's encoder.
   *
   * The radiation chain (emitters → clusters → gather) is rate-limited; the voxel step and the
   * firebrands are not. `simTimeS` is the solver's own clock, not wall time, so a paused or
   * time-scaled fire keeps the three channels in step with each other.
   */
  step(encoder: GPUCommandEncoder, dt: Seconds, surface: IFireOutputs): void {
    this.readStats()
    this.surfaceState = surface.stateTexture
    this.burntAreaM2 = surface.burntAreaM2
    this.simTimeS += dt

    if (this.simTimeS >= this.nextRadiationS) {
      this.nextRadiationS = this.simTimeS + RAD_UPDATE_INTERVAL_S
      this.emitters.encode(encoder, {
        intensityTexture: surface.intensityTexture,
        stateTexture: surface.stateTexture,
      })
      this.radiation.encode(
        encoder,
        {
          emitters: this.emitters.emitters,
          emitterCount: 0,
          emitterCountBuffer: this.emitters.counter,
          emitterArgsOffset: this.emitters.argsOffset,
          brickList: this.brickList,
          brickCount: this.brickCount,
        },
        this.rayCount,
      )
    }

    this.voxels.encode(encoder, dt)
    this.firebrands.step(encoder, dt, surface)

    if (!this.readingBack) {
      encoder.copyBufferToBuffer(this.voxels.stats, 0, this.statsStaging, 0, STATS_BYTES)
      this.copyPending = true
    }
  }

  /**
   * The M3 acceptance check, for `?debug`. Nothing in `npm test` can perform it: every pass
   * above is WGSL, and Vitest under Node never reaches a shader compiler.
   *
   * Reads back the emitter count, the irradiance field and the voxel counters. Each has a
   * distinct failure signature, and the ORDER of the report is the order to read it in —
   * the first zero is the broken stage, exactly like the surface solver's chain probe.
   */
  async report(): Promise<string> {
    const dev = this.device
    const read = async (src: GPUBuffer, bytes: number): Promise<Uint32Array> => {
      const dst = dev.createBuffer({
        label: 'canopy.probe',
        size: bytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      // One encoder per probe: an invalid copy invalidates its whole command buffer, so
      // batching them means one mistake zeroes them all and the diagnosis blames the wrong
      // stage. That has happened here before.
      const enc = dev.createCommandEncoder({ label: 'canopy.probe' })
      enc.copyBufferToBuffer(src, 0, dst, 0, bytes)
      dev.queue.submit([enc.finish()])
      await dst.mapAsync(GPUMapMode.READ)
      const out = new Uint32Array(dst.getMappedRange().slice(0))
      dst.unmap()
      dst.destroy()
      return out
    }

    const counter = await read(this.emitters.counter, 20)
    const stats = await read(this.voxels.stats, STATS_BYTES)

    // Irradiance, over a horizontal slab at the height most canopy occupies. r16float, so the
    // row pitch must reach the 256 B copy alignment.
    const w = 64
    const bytesPerRow = 256 * Math.ceil((w * 2) / 256)
    const irrBuf = dev.createBuffer({
      label: 'canopy.irradianceProbe',
      size: bytesPerRow * w,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const enc = dev.createCommandEncoder({ label: 'canopy.probe.irradiance' })
    enc.copyTextureToBuffer(
      { texture: this.radiation.irradiance, origin: { x: RAD_NI / 2 - w / 2, y: RAD_NJ / 2 - w / 2, z: 2 } },
      { buffer: irrBuf, bytesPerRow, rowsPerImage: w },
      { width: w, height: w, depthOrArrayLayers: 1 },
    )
    dev.queue.submit([enc.finish()])
    await dev.queue.onSubmittedWorkDone()
    await irrBuf.mapAsync(GPUMapMode.READ)
    const halfs = new Uint16Array(irrBuf.getMappedRange().slice(0))
    irrBuf.unmap()
    irrBuf.destroy()
    let peakKw = 0
    let lit = 0
    for (let r = 0; r < w; r++) {
      for (let c = 0; c < w; c++) {
        const v = decodeHalf(halfs[r * (bytesPerRow / 2) + c] ?? 0)
        if (v > 0) lit++
        if (v > peakKw) peakKw = v
      }
    }

    // How many cells the emit pass SHOULD have found. Without this, "0 emitters" cannot be
    // told apart from "no cell is currently flaming", and those have nothing in common.
    const stateRow = 256 * Math.ceil(64 / 256)
    const stateBuf = dev.createBuffer({
      label: 'canopy.stateProbe',
      size: stateRow * 64,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const senc = dev.createCommandEncoder({ label: 'canopy.probe.state' })
    senc.copyTextureToBuffer(
      { texture: this.surfaceState, origin: { x: 1024 - 32, y: 1024 - 32 } },
      { buffer: stateBuf, bytesPerRow: stateRow },
      { width: 64, height: 64 },
    )
    dev.queue.submit([senc.finish()])
    await dev.queue.onSubmittedWorkDone()
    await stateBuf.mapAsync(GPUMapMode.READ)
    const stateBytes = new Uint8Array(stateBuf.getMappedRange().slice(0))
    stateBuf.unmap()
    stateBuf.destroy()
    let burning = 0
    let burnt = 0
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < 64; c++) {
        const v = stateBytes[r * stateRow + c] ?? 0
        if (v === 1) burning++
        if (v === 2) burnt++
      }
    }

    const st = this.stats
    const emitted = counter[0] ?? 0
    const overflow = counter[4] ?? 0
    return [
      `voxel store       ${st.occupiedVoxels.toLocaleString()} voxels in ` +
        `${st.slotCount.toLocaleString()} slots, ${st.activeBricks.toLocaleString()}/` +
        `${st.totalBricks.toLocaleString()} bricks (${((100 * st.activeBricks) / st.totalBricks).toFixed(1)} %)`,
      `foliage mass      ${(st.depositedMassKg / 1000).toFixed(1)} t deposited, ` +
        `${(st.clippedMassKg / 1000).toFixed(2)} t clipped (reported, never renormalised away)`,
      `surface state     ${burning} BURNING, ${burnt} BURNT of 4096 sampled at the domain centre`,
      `surface emitters  ${emitted.toLocaleString()} flame panels` +
        (overflow > 0 ? `   <- ${overflow} DROPPED, raise DEFAULT_EMITTER_CAPACITY` : ''),
      `irradiance        peak ${peakKw.toFixed(2)} kW/m2 over ${lit}/4096 cells sampled at 8 m AGL`,
      `canopy voxels     ${(stats[0] ?? 0).toLocaleString()} flaming, ` +
        `${(stats[1] ?? 0).toLocaleString()} ever ignited`,
      `  heating         max voxel ${((stats[4] ?? 0) / TEMP_SCALE).toFixed(1)} K, ` +
        `${(stats[5] ?? 0).toLocaleString()} voxels >= 50 K over ambient`,
      `  convection      hottest gas at a voxel ${((stats[6] ?? 0) / TEMP_SCALE).toFixed(1)} K, ` +
        `closest approach to the plume centreline ` +
        ((stats[7] ?? OFFSET_NONE) === OFFSET_NONE
          ? 'NONE (no voxel inside the plume)'
          : `${((stats[7] ?? 0) / OFFSET_SCALE).toFixed(2)} m`),
      `  in the core     ${(stats[8] ?? 0).toLocaleString()} voxels in gas >= 800 K, ` +
        `hottest of them ${((stats[9] ?? 0) / TEMP_SCALE).toFixed(1)} K`,
      `  stalled         ${(stats[10] ?? 0).toLocaleString()} of them pinned at the boiling ` +
        `plateau (many stalled with nothing igniting = the canopy is off the fire's clock)`,
      '',
      emitted === 0
        ? 'NO EMITTERS — the surface fire is not flaming, or WP 2.4 wrote no intensity.'
        : peakKw <= 0
          ? 'NO IRRADIANCE — emitters exist but the gather produced nothing. Suspect the ' +
            'brick list, the cluster threshold, or the extinction field.'
          : 'PASS — flame panels radiate, the gather resolves a field, and the voxel pass reads it.',
    ].join(String.fromCharCode(10))
  }

  destroy(): void {
    this.voxels.destroy()
    this.firebrands.destroy()
    this.emitters.destroy()
    this.radiation.destroy()
    this.store.destroy()
    this.brickList.destroy()
    this.plumeBuffer.destroy()
    this.statsStaging.destroy()
  }

  /**
   * Crown fraction burned, measured — but normalised to the fire's OWN footprint.
   *
   * The voxel accumulators are domain-wide, and Van Wagner's CFB is not: it is the fraction of
   * crown fuel consumed *where the fire has been*. Dividing consumed mass by the whole
   * landscape's crown mass reports ~0 % for any fire smaller than the domain, which is the
   * arithmetic of a 0.1 ha burn in 104 ha, not a statement about crown fire.
   *
   * So the denominator is scaled by the burnt fraction of the domain. **That assumes the
   * canopy is spatially uniform** — true enough for a procedurally placed stand at constant
   * density, and stated rather than hidden. A patchy canopy makes this noisy at small burn
   * areas, which is why it returns null until the fire has covered enough ground to mean
   * anything.
   */
  private computeCrownConsumed(): number | null {
    if (this.crownInitialRaw <= 0) return null
    // Below this the denominator is a handful of voxels and the ratio is noise.
    const MIN_BURNT_M2 = 200
    if (this.burntAreaM2 < MIN_BURNT_M2) return null
    const domainM2 = (DOMAIN_SIZE_M as number) ** 2
    const burntFraction = Math.min(1, this.burntAreaM2 / domainM2)
    const consumed = Math.max(0, this.crownInitialRaw - this.crownDryRaw)
    const inFootprint = this.crownInitialRaw * burntFraction
    if (inFootprint <= 0) return null
    return Math.min(1, consumed / inFootprint)
  }

  /**
   * Pull the voxel counters back, one step behind.
   *
   * Same `copyPending` handshake as `FireOutputs.readAggregates`, and for the same reason: map
   * and copy have to alternate or the copy is never encoded at all, and every counter reads
   * zero — which is indistinguishable from a canopy that is not burning.
   */
  private readStats(): void {
    if (this.readingBack || !this.copyPending) return
    this.readingBack = true
    this.copyPending = false
    void this.statsStaging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const raw = new Uint32Array(this.statsStaging.getMappedRange().slice(0))
        this.statsStaging.unmap()
        this.flamingVoxels = raw[0] ?? 0
        this.everIgnitedVoxels = raw[1] ?? 0
        this.crownDryRaw = raw[2] ?? 0
        this.crownInitialRaw = raw[3] ?? 0
        this.maxVoxelTempK = (raw[4] ?? 0) / TEMP_SCALE
        this.warmVoxels = raw[5] ?? 0
        this.maxGasTempK = (raw[6] ?? 0) / TEMP_SCALE
        const off = raw[7] ?? OFFSET_NONE
        this.minCentrelineOffsetM = off === OFFSET_NONE ? null : off / OFFSET_SCALE
        this.crownConsumedFraction = this.computeCrownConsumed()
      })
      .finally(() => {
        this.readingBack = false
      })
  }
}

/** binary16 -> number. Only non-negative finite values occur in an irradiance field. */
function decodeHalf(h: number): number {
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return frac * 2 ** -24
  if (exp === 31) return frac === 0 ? Infinity : NaN
  return (1 + frac / 1024) * 2 ** (exp - 15)
}

function countOccupied(occupancy: VoxeliseResult): number {
  return occupancy.mask.count()
}
