/**
 * `ISkyRenderer` — the full-screen physically-based sky pass, and the single entry point to the
 * solar solve.
 *
 * The important structural decision is that `solarState()` is not a graphics function that
 * happens to live next to the sky. It is *the* solar solve for the whole simulation: the same
 * elevation, azimuth and irradiance that shade the sky here are what M5's fuel-drying model
 * integrates over a slope. A separate "graphics sun" would be free to drift a few degrees and
 * nobody would notice until south-facing aspects stopped drying faster than north-facing ones.
 *
 * Spec: docs/spec/50-meteorology.md §6.5; contract: `src/contracts/render.ts`.
 */

import type { CameraState, ISkyRenderer, SolarState, TimeOfDay } from '@contracts/render.ts'
import { K } from '@contracts/units.ts'
import {
  computeSolarState,
  julianDayForLocalTime,
  makeSite,
  sunDirection,
  DEFAULT_ATMOSPHERE,
  type AtmosphereConfig,
  type FullSolarState,
  type SiteConfig,
} from './solar.ts'
import { makeSkyEnvironment, packSkyUniforms, SKY_UNIFORM_BYTES, type SkyEnvironment, type SkyOutputMode } from './sky-model.ts'
import { createSkyUniformBindGroupLayout, skyPassSource } from './shaders.ts'
import { directBeamColour } from './spectrum.ts'

export interface SkyRendererOptions {
  /** Colour format of the attachment the sky is drawn into. */
  readonly targetFormat: GPUTextureFormat
  /**
   * Depth attachment format of the pass the sky is drawn into, if it has one. Omit when the sky
   * is drawn first into a pass with no depth attachment, which is the default arrangement:
   * it writes every pixel, so depth testing buys nothing and depth writing would be wrong.
   */
  readonly depthFormat?: GPUTextureFormat
  /**
   * What the fragment shader emits. `linear-hdr` is correct when the sky is one input to a
   * tone mapper later in the frame — which is the intended arrangement, because the sun disc is
   * ~1e7 W/(m^2 sr) and the moonless night sky is ~1e-6, and no 8-bit buffer holds both.
   */
  readonly outputMode?: SkyOutputMode
  /** Linear exposure applied before tone mapping. Ignored in `linear-hdr`. */
  readonly exposure?: number
  /** Calendar year for the solar solve. `TimeOfDay` carries no year. */
  readonly year?: number
  /**
   * Local standard time offset from UTC, hours. Defaults per site to `round(longitude / 15)`.
   * Daylight saving is deliberately not applied — fire weather observations are recorded in
   * local standard time.
   */
  readonly utcOffsetHours?: number
  readonly atmosphere?: Partial<AtmosphereConfig>
  readonly label?: string
}

/** Sun movement, in radians, that invalidates the cached sky coefficients (~0.02 deg). */
const SOLAR_REBUILD_EPSILON = 3.5e-4

interface Solve {
  readonly time: TimeOfDay
  readonly latitudeDeg: number
  readonly longitudeDeg: number
  readonly jdUt: number
  readonly full: FullSolarState
}

export class SkyRenderer implements ISkyRenderer {
  readonly device: GPUDevice
  readonly uniformBuffer: GPUBuffer
  readonly bindGroupLayout: GPUBindGroupLayout

  private readonly pipeline: GPURenderPipeline
  private readonly bindGroup: GPUBindGroup
  private readonly outputMode: SkyOutputMode

  private atmosphereState: AtmosphereConfig
  private exposureValue: number
  private year: number
  private utcOffsetOverride: number | undefined

  private lastSolve: Solve | null = null
  private cachedEnv: SkyEnvironment | null = null
  private cachedEnvKey = ''

  constructor(device: GPUDevice, options: SkyRendererOptions) {
    this.device = device
    this.outputMode = options.outputMode ?? 'linear-hdr'
    this.exposureValue = options.exposure ?? 1
    this.year = options.year ?? 2024
    this.utcOffsetOverride = options.utcOffsetHours
    this.atmosphereState = { ...DEFAULT_ATMOSPHERE, ...options.atmosphere }

    this.uniformBuffer = device.createBuffer({
      label: `${options.label ?? 'sky'}-uniforms`,
      size: SKY_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.bindGroupLayout = createSkyUniformBindGroupLayout(device)
    this.bindGroup = device.createBindGroup({
      label: `${options.label ?? 'sky'}-bind-group`,
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    })

    const module = device.createShaderModule({
      label: 'sky-pass',
      code: skyPassSource(),
    })

    this.pipeline = device.createRenderPipeline({
      label: 'sky-pass',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_sky' },
      fragment: {
        module,
        entryPoint: 'fs_sky',
        targets: [{ format: options.targetFormat }],
      },
      primitive: { topology: 'triangle-list' },
      // Depth is never written: the sky is the background, and anything drawn over it must win
      // regardless of the order the world renderer chooses.
      ...(options.depthFormat === undefined
        ? {}
        : {
            depthStencil: {
              format: options.depthFormat,
              depthWriteEnabled: false,
              depthCompare: 'always' as GPUCompareFunction,
            },
          }),
    })
  }

  // -------------------------------------------------------------------------
  // Solar solve
  // -------------------------------------------------------------------------

  /** Site configuration used for a given latitude/longitude. */
  site(latitudeDeg: number, longitudeDeg: number): SiteConfig {
    return makeSite(latitudeDeg, longitudeDeg, {
      year: this.year,
      ...(this.utcOffsetOverride === undefined ? {} : { utcOffsetHours: this.utcOffsetOverride }),
    })
  }

  /**
   * Sun position and irradiance. Acceptance criterion: within 0.1 deg of an ephemeris for a
   * given date, latitude and longitude — asserted in test/render/sky/solar.test.ts against an
   * independent NOAA-formulation implementation and against published values.
   */
  solarState(time: TimeOfDay, latitudeDeg: number, longitudeDeg: number): SolarState {
    return this.fullSolarState(time, latitudeDeg, longitudeDeg)
  }

  /** As `solarState`, but keeping the geometry, irradiance split and beam colour. */
  fullSolarState(time: TimeOfDay, latitudeDeg: number, longitudeDeg: number): FullSolarState {
    const site = this.site(latitudeDeg, longitudeDeg)
    const full = computeSolarState(site, time, this.atmosphereState)
    this.lastSolve = {
      time,
      latitudeDeg,
      longitudeDeg,
      jdUt: julianDayForLocalTime(site, time),
      full,
    }
    return full
  }

  // -------------------------------------------------------------------------
  // Environment state
  // -------------------------------------------------------------------------

  get atmosphere(): AtmosphereConfig {
    return this.atmosphereState
  }

  setAtmosphere(patch: Partial<AtmosphereConfig>): void {
    this.atmosphereState = { ...this.atmosphereState, ...patch }
    this.cachedEnvKey = ''
  }

  /**
   * Smoke column optical depth over the site. M1 leaves this at zero; M4 drives it from the
   * simulated soot column. It is real plumbing, not a placeholder: a non-zero value attenuates
   * the direct beam by Beer-Lambert, returns half the removed energy to the diffuse field
   * (wildfire smoke scatters strongly forward), and reddens both the beam and the disc through
   * the wavelength-dependent smoke extinction in `spectrum.ts`.
   */
  setPlumeOpticalDepth(tau: number): void {
    const clamped = Math.max(0, tau)
    if (clamped === this.atmosphereState.plumeOpticalDepth) return
    this.atmosphereState = { ...this.atmosphereState, plumeOpticalDepth: clamped }
    this.cachedEnvKey = ''
    // The plume changes the irradiance split, so the cached solve is stale too.
    if (this.lastSolve) {
      const s = this.lastSolve
      this.fullSolarState(s.time, s.latitudeDeg, s.longitudeDeg)
    }
  }

  get exposure(): number {
    return this.exposureValue
  }

  set exposure(v: number) {
    this.exposureValue = v
  }

  /**
   * The assembled sky state for a solar state: two Perez lobes, the sun and moon discs, the star
   * level. Cached, because building it integrates the hemisphere twice to normalise the lobes
   * against the physical irradiance and that is not a per-frame cost.
   */
  environmentFor(solar: SolarState): SkyEnvironment {
    const full = this.asFullSolarState(solar)
    const key = [
      full.elevation.toFixed(6),
      full.azimuth.toFixed(6),
      full.directIrradiance.toFixed(3),
      full.diffuseIrradiance.toFixed(3),
      this.atmosphereState.turbidity,
      this.atmosphereState.cloudFraction,
      this.atmosphereState.plumeOpticalDepth,
      this.atmosphereState.groundAlbedo,
      this.lastSolve ? Math.round(this.lastSolve.jdUt * 1440) : 0,
    ].join('|')

    if (this.cachedEnv && this.cachedEnvKey === key) return this.cachedEnv

    const jd = this.lastSolve?.jdUt ?? 2451545.0
    const lat = this.lastSolve?.latitudeDeg ?? 0
    const lon = this.lastSolve?.longitudeDeg ?? 0
    const env = makeSkyEnvironment(full, jd, lat, lon, this.atmosphereState)
    this.cachedEnv = env
    this.cachedEnvKey = key
    return env
  }

  /** True when the sun has moved far enough that cached lighting should be rebuilt. */
  solarStateChanged(a: SolarState, b: SolarState): boolean {
    return (
      Math.abs(a.elevation - b.elevation) > SOLAR_REBUILD_EPSILON ||
      Math.abs(a.azimuth - b.azimuth) > SOLAR_REBUILD_EPSILON
    )
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(pass: GPURenderPassEncoder, camera: CameraState, solar: SolarState): void {
    const env = this.environmentFor(solar)
    const data = packSkyUniforms(env, {
      invViewProjMatrix: camera.invViewProjMatrix,
      cameraPosition: [camera.position[0], camera.position[1], camera.position[2]],
      exposure: this.exposureValue,
      outputMode: this.outputMode,
      plumeOpticalDepth: this.atmosphereState.plumeOpticalDepth,
      groundAlbedo: this.atmosphereState.groundAlbedo,
    })
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(3)
  }

  destroy(): void {
    this.uniformBuffer.destroy()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Accept either the rich state this class produces or a bare contract `SolarState` handed in
   * by the frame assembler.
   *
   * The bare form is missing the geometry and irradiance split, so those are reconstructed from
   * what the contract does carry. That reconstruction is exact for everything the sky needs
   * (elevation, azimuth, DNI, DHI are all present); only the Julian day is unavailable, so the
   * moon falls back to the instant of the last solve this renderer performed.
   */
  private asFullSolarState(solar: SolarState): FullSolarState {
    if (isFullSolarState(solar)) return solar

    const last = this.lastSolve?.full
    if (last && Math.abs(last.elevation - solar.elevation) < 1e-9 && Math.abs(last.azimuth - solar.azimuth) < 1e-9) {
      return last
    }

    const beam = directBeamColour(
      solar.elevation,
      this.atmosphereState.turbidity,
      this.atmosphereState.plumeOpticalDepth,
    )
    const geometry = last?.geometry
    return {
      elevation: solar.elevation,
      azimuth: solar.azimuth,
      directIrradiance: solar.directIrradiance,
      diffuseIrradiance: solar.diffuseIrradiance,
      colorTemperature: K(beam.cct),
      isDaytime: solar.isDaytime,
      geometry: {
        julianDay: geometry?.julianDay ?? 2451545.0,
        n: geometry?.n ?? 0,
        declinationRad: geometry?.declinationRad ?? 0,
        rightAscensionRad: geometry?.rightAscensionRad ?? 0,
        eclipticLongitudeRad: geometry?.eclipticLongitudeRad ?? 0,
        hourAngleRad: geometry?.hourAngleRad ?? 0,
        trueElevationRad: solar.elevation,
        apparentElevationRad: solar.elevation,
        azimuthRad: solar.azimuth,
        equationOfTimeMinutes: geometry?.equationOfTimeMinutes ?? 0,
        distanceAu: geometry?.distanceAu ?? 1,
      },
      irradiance: {
        directNormal: solar.directIrradiance,
        diffuseHorizontal: solar.diffuseIrradiance,
        globalHorizontal:
          solar.directIrradiance * Math.max(0, Math.sin(solar.elevation)) + solar.diffuseIrradiance,
        extraterrestrialNormal: 1367,
        clearnessIndex: 0,
      },
      direction: sunDirection(solar.elevation, solar.azimuth),
      beamColor: beam.rgb,
    }
  }
}

function isFullSolarState(s: SolarState): s is FullSolarState {
  return 'geometry' in s && 'irradiance' in s && 'direction' in s
}

/** Convenience for callers that want a `SolarState` without instantiating a GPU renderer. */
export function solarStateFor(
  time: TimeOfDay,
  latitudeDeg: number,
  longitudeDeg: number,
  options: { year?: number; utcOffsetHours?: number; atmosphere?: Partial<AtmosphereConfig> } = {},
): FullSolarState {
  const site = makeSite(latitudeDeg, longitudeDeg, {
    year: options.year ?? 2024,
    ...(options.utcOffsetHours === undefined ? {} : { utcOffsetHours: options.utcOffsetHours }),
  })
  return computeSolarState(site, time, { ...DEFAULT_ATMOSPHERE, ...options.atmosphere })
}
