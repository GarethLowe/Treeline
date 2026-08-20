/**
 * `ISkyRenderer` and `IEnvironmentLighting` against a recording stand-in device.
 *
 * The parts worth testing without a GPU are the ones where a mistake is silent: the amortisation
 * state machine (does the environment actually stop doing work when the sun is still, and does it
 * restart when the sun moves?), the buffer sizes, and the contract surface. Shader compilation
 * and pixels are for the integrator's in-browser check.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeGpu, fakeCamera, type FakeGpu } from './fake-device.ts'
import { SkyRenderer } from '../../../src/render/sky/sky-renderer.ts'
import { EnvironmentLighting } from '../../../src/render/sky/environment.ts'
import { SKY_UNIFORM_BYTES } from '../../../src/render/sky/sky-model.ts'
import { SH_BUFFER_BYTES } from '../../../src/render/sky/sh.ts'
import { timeOfDay } from '../../../src/render/sky/solar.ts'
import type { SolarState } from '../../../src/contracts/render.ts'

const LA = { lat: 34.0522, lon: -118.2437 }
const DOY = 173 // 21 June

let gpu: FakeGpu

beforeEach(() => {
  gpu = createFakeGpu()
})

function makeRenderer(): SkyRenderer {
  return new SkyRenderer(gpu.device, {
    targetFormat: 'rgba16float',
    outputMode: 'linear-hdr',
    year: 2024,
    utcOffsetHours: -8,
  })
}

describe('SkyRenderer', () => {
  it('creates exactly the resources the pass needs', () => {
    makeRenderer()
    expect(gpu.renderPipelines).toEqual(['sky-pass'])
    expect(gpu.buffers).toHaveLength(1)
    expect(gpu.buffers[0]!.size).toBe(SKY_UNIFORM_BYTES)
    // The shader module got the shared block plus the pass, in one compilation unit.
    expect(gpu.shaderSources).toHaveLength(1)
    expect(gpu.shaderSources[0]!).toContain('fn fs_sky')
    expect(gpu.shaderSources[0]!).toContain('fn lobe_radiance')
  })

  it('draws one full-screen triangle with the sky bind group', () => {
    const sky = makeRenderer()
    const solar = sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon)
    const pass = gpu.newRenderPass()
    sky.render(pass, fakeCamera(), solar)

    expect(gpu.draws).toHaveLength(1)
    expect(gpu.draws[0]!.vertexCount).toBe(3)
    expect(gpu.draws[0]!.bindGroups).toEqual([0])
    // Uniforms uploaded once, in full.
    const uniformWrites = gpu.writes.filter((w) => w.byteLength === SKY_UNIFORM_BYTES)
    expect(uniformWrites).toHaveLength(1)
    expect(uniformWrites[0]!.offset).toBe(0)
  })

  it('implements the contract shape of SolarState', () => {
    const sky = makeRenderer()
    const solar: SolarState = sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon)
    expect(solar.isDaytime).toBe(true)
    expect(solar.elevation).toBeGreaterThan(1.2) // >69 deg at LA on the solstice
    expect(solar.azimuth).toBeGreaterThanOrEqual(0)
    expect(solar.directIrradiance).toBeGreaterThan(700)
    expect(solar.diffuseIrradiance).toBeGreaterThan(0)
    expect(solar.colorTemperature).toBeGreaterThan(4500)
    expect(solar.colorTemperature).toBeLessThan(7000)

    const night: SolarState = sky.solarState(timeOfDay(DOY, 1), LA.lat, LA.lon)
    expect(night.isDaytime).toBe(false)
    expect(night.directIrradiance).toBe(0)
  })

  it('accepts a bare contract SolarState that it did not produce', () => {
    const sky = makeRenderer()
    const rich = sky.solarState(timeOfDay(DOY, 15), LA.lat, LA.lon)
    // Strip it down to exactly the contract's fields, as a frame assembler might.
    const bare: SolarState = {
      elevation: rich.elevation,
      azimuth: rich.azimuth,
      directIrradiance: rich.directIrradiance,
      diffuseIrradiance: rich.diffuseIrradiance,
      colorTemperature: rich.colorTemperature,
      isDaytime: rich.isDaytime,
    }
    const env = sky.environmentFor(bare)
    expect(env.solar.directIrradiance).toBe(rich.directIrradiance)
    expect(env.skyIrradiance).toBeGreaterThan(0)
    const pass = gpu.newRenderPass()
    sky.render(pass, fakeCamera(), bare)
    expect(gpu.draws).toHaveLength(1)
  })

  it('caches the assembled environment until something actually changes', () => {
    const sky = makeRenderer()
    const solar = sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon)
    const a = sky.environmentFor(solar)
    const b = sky.environmentFor(solar)
    expect(b).toBe(a)

    const later = sky.solarState(timeOfDay(DOY, 14), LA.lat, LA.lon)
    expect(sky.environmentFor(later)).not.toBe(a)
  })

  it('plumbs the plume optical depth through to the beam and the disc', () => {
    const sky = makeRenderer()
    const clearSolar = sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon)
    const clear = sky.environmentFor(clearSolar)
    const clearDni = clear.solar.directIrradiance
    const clearCct = clear.solar.colorTemperature

    // M1 default is zero; M4 drives this from the smoke column.
    expect(sky.atmosphere.plumeOpticalDepth).toBe(0)
    sky.setPlumeOpticalDepth(2.5)
    expect(sky.atmosphere.plumeOpticalDepth).toBe(2.5)

    const smoky = sky.environmentFor(sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon))
    expect(smoky.solar.directIrradiance).toBeLessThan(0.15 * clearDni)
    expect(smoky.solar.colorTemperature).toBeLessThan(clearCct - 500)
    // Energy removed from the beam is not destroyed: half is returned to the diffuse field.
    expect(smoky.solar.diffuseIrradiance).toBeGreaterThan(clear.solar.diffuseIrradiance)

    sky.setPlumeOpticalDepth(0)
    const restored = sky.environmentFor(sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon))
    expect(restored.solar.directIrradiance).toBeCloseTo(clearDni, 6)
  })

  it('rejects a negative optical depth rather than inverting the extinction', () => {
    const sky = makeRenderer()
    sky.setPlumeOpticalDepth(-3)
    expect(sky.atmosphere.plumeOpticalDepth).toBe(0)
  })
})

describe('EnvironmentLighting', () => {
  function makeEnv(sky: SkyRenderer, jobsPerUpdate = 2): EnvironmentLighting {
    return new EnvironmentLighting(gpu.device, sky, { jobsPerUpdate })
  }

  it('allocates a cube pair, an SH buffer and the two compute pipelines', () => {
    const sky = makeRenderer()
    makeEnv(sky)
    expect(gpu.computePipelines).toEqual(['sky-env-capture', 'sky-env-prefilter'])
    expect(gpu.textures.filter((t) => t.format === 'rgba16float')).toHaveLength(2)
    for (const t of gpu.textures) {
      expect(t.layers).toBe(6)
      expect(t.mipLevelCount).toBe(5)
    }
    const shBuffer = gpu.buffers.find((b) => b.label.endsWith('-sh'))
    expect(shBuffer?.size).toBe(SH_BUFFER_BYTES)
  })

  it('amortises the rebuild across frames and then goes quiet', () => {
    const sky = makeRenderer()
    const env = makeEnv(sky, 2)
    const solar = sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon)

    // 11 jobs: one SH projection, 5 capture dispatches, 5 prefilter dispatches.
    let updates = 0
    while (!env.isConverged && updates < 20) {
      const encoder = gpu.newEncoder()
      env.update(encoder, solar)
      updates++
      // Never more than the budget of GPU dispatches in a single frame.
      expect(gpu.dispatches.length).toBeLessThanOrEqual(updates * 2)
    }
    expect(env.isConverged).toBe(true)
    expect(updates).toBe(6)
    expect(gpu.dispatches).toHaveLength(10)
    expect(gpu.dispatches.filter((d) => d.pipeline === 'sky-env-capture')).toHaveLength(5)
    expect(gpu.dispatches.filter((d) => d.pipeline === 'sky-env-prefilter')).toHaveLength(5)

    // Every dispatch covers all six faces, and the workgroup grid matches the mip size.
    for (const d of gpu.dispatches) {
      expect(d.z).toBe(6)
      expect(d.x).toBe(d.y)
      expect([16, 8, 4, 2, 1]).toContain(d.x)
    }

    // Once converged, a still sun costs nothing at all.
    gpu.reset()
    for (let i = 0; i < 10; i++) env.update(gpu.newEncoder(), solar)
    expect(gpu.dispatches).toHaveLength(0)
    expect(gpu.writes).toHaveLength(0)
  })

  it('rebuilds when the sun has moved past the threshold, not before', () => {
    const sky = makeRenderer()
    const env = makeEnv(sky, 11)
    env.update(gpu.newEncoder(), sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon))
    expect(env.isConverged).toBe(true)
    gpu.reset()

    // Ten seconds of simulated time: the sun has moved ~0.04 deg, under the 0.25 deg threshold.
    env.update(gpu.newEncoder(), sky.solarState(timeOfDay(DOY, 12, 0, 10), LA.lat, LA.lon))
    expect(gpu.dispatches).toHaveLength(0)

    // Ten minutes: ~2.5 deg. Rebuild.
    env.update(gpu.newEncoder(), sky.solarState(timeOfDay(DOY, 12, 10), LA.lat, LA.lon))
    expect(gpu.dispatches).toHaveLength(10)
  })

  it('writes 9 vec4 of irradiance SH, and the values track the sun', () => {
    const sky = makeRenderer()
    const env = makeEnv(sky, 11)
    env.update(gpu.newEncoder(), sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon))

    const shWrites = gpu.writes.filter((w) => w.byteLength === SH_BUFFER_BYTES)
    expect(shWrites).toHaveLength(1)

    const noonSh = env.irradianceShCoefficients
    expect(noonSh).not.toBeNull()
    const noonAmbient = noonSh![0]![1]

    gpu.reset()
    env.update(gpu.newEncoder(), sky.solarState(timeOfDay(DOY, 1), LA.lat, LA.lon))
    const nightSh = env.irradianceShCoefficients!
    const nightAmbient = nightSh[0]![1]

    expect(noonAmbient).toBeGreaterThan(0)
    expect(nightAmbient).toBeGreaterThan(0)
    // Night ambient is millions of times darker — that is what makes fire the dominant light
    // source at M4 rather than a bright object in an already-lit scene.
    expect(noonAmbient / nightAmbient).toBeGreaterThan(1e5)
  })

  it('can be forced to rebuild', () => {
    const sky = makeRenderer()
    const env = makeEnv(sky, 11)
    const solar = sky.solarState(timeOfDay(DOY, 12), LA.lat, LA.lon)
    env.update(gpu.newEncoder(), solar)
    gpu.reset()
    env.update(gpu.newEncoder(), solar)
    expect(gpu.dispatches).toHaveLength(0)
    env.invalidate()
    env.update(gpu.newEncoder(), solar)
    expect(gpu.dispatches).toHaveLength(10)
  })

  it('exposes the consumer bind group layout and can build a bind group', () => {
    const sky = makeRenderer()
    const env = makeEnv(sky)
    expect(env.bindGroupLayout).toBeDefined()
    expect(env.createBindGroup()).toBeDefined()
    expect(env.irradianceSH).toBeDefined()
    expect(env.specularCube).toBeDefined()
  })

  it('releases its buffers and textures on destroy', () => {
    const sky = makeRenderer()
    const env = makeEnv(sky)
    env.destroy()
    sky.destroy()
    expect(gpu.buffers.every((b) => b.destroyed)).toBe(true)
  })
})
