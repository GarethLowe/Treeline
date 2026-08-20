/**
 * The sky model: Preetham coefficients, the irradiance normalisation that ties the visible sky
 * to the physics, the diurnal range from noon to genuine darkness, and the uniform packing that
 * the WGSL shader reads.
 */

import { describe, expect, it } from 'vitest'
import {
  computeSolarState,
  dayOfYearFromCalendar,
  julianDayForLocalTime,
  makeSite,
  timeOfDay,
  DEFAULT_ATMOSPHERE,
} from '../../../src/render/sky/solar.ts'
import {
  horizontalIlluminance,
  makeSkyDistribution,
  perezF,
  perezLuminance,
  perezX,
  perezY,
  skyRadiance,
  zenithChromaticity,
  zenithLuminance,
} from '../../../src/render/sky/preetham.ts'
import {
  environmentRadiance,
  makeSkyEnvironment,
  packSkyUniforms,
  radianceIncludingDiscs,
  skyDiagnostics,
  discSolidAngle,
  LOBE_FLOATS,
  SKY_UNIFORM_BYTES,
  SKY_UNIFORM_FLOATS,
  SUN_ANGULAR_RADIUS,
} from '../../../src/render/sky/sky-model.ts'
import {
  NIGHT_SKY_ILLUMINANCE_LUX,
  twilightIlluminanceLux,
  twilightIrradiance,
  effectiveTurbidity,
} from '../../../src/render/sky/twilight.ts'
import { DAYLIGHT_LUMINOUS_EFFICACY } from '../../../src/render/sky/spectrum.ts'
import { computeIrradianceSh } from '../../../src/render/sky/environment.ts'
import { shIrradiance } from '../../../src/render/sky/sh.ts'
import {
  ENV_CAPTURE_WGSL,
  SKY_COMMON_WGSL,
  envCaptureSource,
  envPrefilterSource,
  skyPassSource,
} from '../../../src/render/sky/shaders.ts'

/** Los Angeles, mid-summer: the reference site for the diurnal sweep. */
const SITE = makeSite(34.0522, -118.2437, { utcOffsetHours: -8, year: 2024 })
const DOY = dayOfYearFromCalendar(2024, 6, 21)

function envAt(hours: number, atmosphere = DEFAULT_ATMOSPHERE) {
  const time = timeOfDay(DOY, Math.floor(hours), Math.round((hours % 1) * 60))
  const solar = computeSolarState(SITE, time, atmosphere)
  const jd = julianDayForLocalTime(SITE, time)
  return makeSkyEnvironment(solar, jd, SITE.latitudeDeg, SITE.longitudeDeg, atmosphere)
}

/** CIE luminance of a linear sRGB triple. */
function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

describe('Preetham coefficients', () => {
  it('reproduces the published linear fits at T = 2 and T = 6', () => {
    // Spot values recomputed from the printed coefficient table (Preetham App. A.2).
    const y2 = perezLuminance(2)
    expect(y2.a).toBeCloseTo(0.1787 * 2 - 1.463, 12)
    expect(y2.b).toBeCloseTo(-0.3554 * 2 + 0.4275, 12)
    const x6 = perezX(6)
    expect(x6.c).toBeCloseTo(-0.0004 * 6 + 0.2125, 12)
    const yy6 = perezY(6)
    expect(yy6.d).toBeCloseTo(-0.0441 * 6 - 1.6537, 12)
  })

  it('has a distribution that peaks toward the sun and dims toward the horizon', () => {
    const k = perezLuminance(2.5)
    const nearSun = perezF(k, 0.5, 0.05)
    const awayFromSun = perezF(k, 0.5, 2.5)
    expect(nearSun).toBeGreaterThan(awayFromSun)
    // The gradient term (1 + a e^(b/cos theta)) has a < 0 and b < 0, so it rises from ~0.36 at
    // the zenith to 1.0 at the horizon: a clear sky IS brighter near the horizon, because the
    // line of sight passes through more scattering atmosphere. This is also exactly where
    // Preetham is known to overpredict, which is why absolute level comes from measured
    // irradiance rather than from the model.
    const zenith = perezF(k, 1, 1.2)
    const horizon = perezF(k, 0.02, 1.2)
    expect(horizon).toBeGreaterThan(zenith)
    expect(horizon / zenith).toBeLessThan(4)
  })

  it('gives a plausible zenith luminance and a bluer zenith for a higher sun', () => {
    const highSun = zenithLuminance(2.5, (20 * Math.PI) / 180)
    const lowSun = zenithLuminance(2.5, (80 * Math.PI) / 180)
    expect(highSun).toBeGreaterThan(3000)
    expect(highSun).toBeLessThan(20000)
    expect(highSun).toBeGreaterThan(lowSun)

    const [xHigh, yHigh] = zenithChromaticity(2.5, (20 * Math.PI) / 180)
    const [xLow] = zenithChromaticity(2.5, (85 * Math.PI) / 180)
    // Chromaticity stays in the physical region and reddens (x rises) as the sun drops.
    expect(xHigh).toBeGreaterThan(0.2)
    expect(xHigh).toBeLessThan(0.45)
    expect(yHigh).toBeGreaterThan(0.2)
    expect(xLow).toBeGreaterThan(xHigh)
  })
})

describe('irradiance normalisation — the tie between the render and the physics', () => {
  it('makes the hemisphere integral equal the requested irradiance', () => {
    for (const target of [10, 60, 180]) {
      for (const zenith of [0.2, 0.8, 1.3]) {
        const d = makeSkyDistribution({
          turbidity: 2.5,
          solarZenithRad: zenith,
          lightDirection: [Math.sin(zenith), Math.cos(zenith), 0],
          targetIrradiance: target,
        })
        const lux = horizontalIlluminance(d, 4096)
        const irradiance = (lux / DAYLIGHT_LUMINOUS_EFFICACY) * d.radianceScale
        expect(irradiance).toBeCloseTo(target, 1)
      }
    }
  })

  it('returns zero radiance below the horizon and positive radiance above it', () => {
    const d = makeSkyDistribution({
      turbidity: 2.5,
      solarZenithRad: 0.6,
      lightDirection: [0.56, 0.83, 0],
      targetIrradiance: 100,
    })
    expect(skyRadiance(d, [0, -1, 0])).toEqual([0, 0, 0])
    const up = skyRadiance(d, [0, 1, 0])
    expect(luminance(up)).toBeGreaterThan(0)
  })

  it('SH irradiance on an up-facing surface recovers the diffuse horizontal irradiance', () => {
    // This is the acceptance-grade check for "one source of truth": the ambient light a flat
    // surface receives from the rendered sky must be the same number the Erbs split produced.
    const env = envAt(12)
    const sh = computeIrradianceSh(env, 4096, false)
    const up = shIrradiance(sh, [0, 1, 0])
    const got = luminance(up)
    expect(got).toBeGreaterThan(0.9 * env.skyIrradiance)
    expect(got).toBeLessThan(1.1 * env.skyIrradiance)
  })
})

describe('the diurnal cycle', () => {
  it('spans the full range from daylight to a genuinely dark night', () => {
    const noon = skyDiagnostics(envAt(12))
    const sunset = skyDiagnostics(envAt(19.9))
    const midnight = skyDiagnostics(envAt(1))

    expect(noon.sunElevationDeg).toBeGreaterThan(70)
    expect(midnight.sunElevationDeg).toBeLessThan(-18)

    // Noon global diffuse alone is tens of thousands of lux; the moonless night sky is 2e-4 lx.
    expect(noon.skyIlluminanceLux).toBeGreaterThan(8000)
    expect(midnight.skyIlluminanceLux).toBeLessThan(0.001)
    expect(noon.skyIlluminanceLux / midnight.skyIlluminanceLux).toBeGreaterThan(1e6)

    // Monotone through the evening.
    expect(sunset.skyIlluminanceLux).toBeLessThan(noon.skyIlluminanceLux)
    expect(sunset.skyIlluminanceLux).toBeGreaterThan(midnight.skyIlluminanceLux)
  })

  it('follows the published twilight illuminance sequence', () => {
    expect(twilightIlluminanceLux(0)).toBeCloseTo(400, 6)
    expect(twilightIlluminanceLux((-6 * Math.PI) / 180)).toBeCloseTo(3.4, 6)
    expect(twilightIlluminanceLux((-12 * Math.PI) / 180)).toBeCloseTo(0.008, 6)
    expect(twilightIlluminanceLux((-18 * Math.PI) / 180)).toBeCloseTo(0.0008, 6)
    expect(twilightIlluminanceLux((-40 * Math.PI) / 180)).toBe(NIGHT_SKY_ILLUMINANCE_LUX)

    // Log-interpolated between anchors, and monotone.
    let previous = Infinity
    for (let elDeg = 0; elDeg >= -20; elDeg -= 0.5) {
      const v = twilightIlluminanceLux((elDeg * Math.PI) / 180)
      expect(v).toBeLessThanOrEqual(previous + 1e-12)
      previous = v
    }
    expect(twilightIrradiance(0)).toBeCloseTo(400 / DAYLIGHT_LUMINOUS_EFFICACY, 9)
  })

  it('crosses over from the Erbs diffuse branch to the twilight branch near the horizon', () => {
    // A few degrees up, the physical diffuse irradiance is well above the 400 lx sunset anchor.
    const morning = envAt(6.5)
    expect(morning.solar.geometry.apparentElevationRad).toBeGreaterThan(0)
    expect(morning.skyIrradiance).toBe(
      Math.max(morning.solar.diffuseIrradiance, twilightIrradiance(morning.solar.elevation)),
    )
    expect(morning.skyIrradiance * DAYLIGHT_LUMINOUS_EFFICACY).toBeGreaterThan(400)
  })

  it('eases turbidity down at low sun, where the Preetham fit is out of its envelope', () => {
    expect(effectiveTurbidity(6, (30 * Math.PI) / 180)).toBe(6)
    expect(effectiveTurbidity(6, 0)).toBeLessThan(6)
    expect(effectiveTurbidity(6, (-6 * Math.PI) / 180)).toBeCloseTo(2, 6)
  })
})

describe('sun and moon discs', () => {
  it('gives the solar disc a radiance that integrates back to the direct normal irradiance', () => {
    const env = envAt(12)
    const omega = discSolidAngle(SUN_ANGULAR_RADIUS)
    expect(omega).toBeGreaterThan(6e-5)
    expect(omega).toBeLessThan(7e-5)
    const integrated = luminance(env.sunDiscRadiance) * omega
    expect(integrated).toBeCloseTo(env.solar.directIrradiance, 0)
  })

  it('puts the disc where the sun direction points, and nowhere else', () => {
    const env = envAt(12)
    const onSun = radianceIncludingDiscs(env, env.solar.direction)
    const offSun = radianceIncludingDiscs(env, [
      -env.solar.direction[0],
      Math.abs(env.solar.direction[1]) * 0.5,
      -env.solar.direction[2],
    ])
    expect(luminance(onSun)).toBeGreaterThan(1000 * luminance(offSun))
  })

  it('extinguishes the solar disc once the sun has set', () => {
    const night = envAt(23)
    expect(night.solar.directIrradiance).toBe(0)
    expect(night.sunDiscRadiance).toEqual([0, 0, 0])
  })

  it('reddens and dims the disc under a smoke plume', () => {
    const clear = envAt(12)
    const smoky = envAt(12, { ...DEFAULT_ATMOSPHERE, plumeOpticalDepth: 2 })
    expect(luminance(smoky.sunDiscRadiance)).toBeLessThan(0.3 * luminance(clear.sunDiscRadiance))
    const redRatio = (c: readonly [number, number, number]): number => c[0] / Math.max(c[2], 1e-9)
    expect(redRatio(smoky.sunDiscRadiance)).toBeGreaterThan(redRatio(clear.sunDiscRadiance))
  })
})

describe('uniform packing', () => {
  it('matches the documented layout and size', () => {
    expect(SKY_UNIFORM_FLOATS).toBe(16 + 6 * 4 + 2 * LOBE_FLOATS)
    expect(SKY_UNIFORM_BYTES).toBe(SKY_UNIFORM_FLOATS * 4)
    expect(SKY_UNIFORM_BYTES % 16).toBe(0)
  })

  it('packs every field the shader reads', () => {
    const env = envAt(12)
    const invViewProj = new Float32Array(16).fill(0)
    for (let i = 0; i < 4; i++) invViewProj[i * 5] = 1
    const data = packSkyUniforms(env, {
      invViewProjMatrix: invViewProj,
      cameraPosition: [500, 12, -250],
      exposure: 0.25,
      outputMode: 'tonemapped-srgb',
      plumeOpticalDepth: 0,
      groundAlbedo: 0.2,
    })

    expect(data.length).toBe(SKY_UNIFORM_FLOATS)
    expect(Array.from(data.subarray(0, 16))).toEqual(Array.from(invViewProj))
    expect(data[16]).toBe(500)
    expect(data[19]).toBe(0.25)
    expect(data[20]).toBeCloseTo(env.solar.direction[0], 5)
    expect(data[23]).toBeCloseTo(SUN_ANGULAR_RADIUS, 6)
    expect(data[27]).toBe(1) // sun is up at noon
    expect(data[31]).toBeCloseTo(env.moon.angularRadius, 6)
    expect(data[37]).toBe(2) // tonemapped-srgb
    expect(data[39]).toBeCloseTo(0.2, 6)

    // Solar lobe block: coefficients, then the F(0, thetaS) denominators, then the direction.
    // f32 storage, so comparisons are to single precision, not double.
    expect(data[40]).toBeCloseTo(env.solarLobe.perez.Y.a, 6)
    expect(data[55] ?? 0).toBeCloseTo(env.solarLobe.zenithLuminanceCdM2, 1)
    expect(data[56]).toBeCloseTo(env.solarLobe.zenithX, 6)
    expect(data[58]).toBeCloseTo(env.solarLobe.radianceScale, 4)
    expect(data[60]).toBeGreaterThan(0) // denominator F(0, thetaS) for luminance
    expect(data[64]).toBeCloseTo(env.solar.direction[0], 5)
    expect(data[67]).toBe(1) // lobe enabled

    // Lunar lobe starts one lobe later.
    expect(data[40 + LOBE_FLOATS]).toBeCloseTo(env.lunarLobe.perez.Y.a, 6)
    expect(Number.isFinite(data[SKY_UNIFORM_FLOATS - 1]!)).toBe(true)
  })

  it('never packs a NaN, at any hour of the day', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const env = envAt(h)
      const data = packSkyUniforms(env, {
        invViewProjMatrix: new Float32Array(16),
        cameraPosition: [0, 0, 0],
        exposure: 1,
        outputMode: 'linear-hdr',
        plumeOpticalDepth: 0,
        groundAlbedo: 0.2,
      })
      for (let i = 0; i < data.length; i++) {
        expect(Number.isFinite(data[i]!)).toBe(true)
      }
      // And the radiance itself stays finite and non-negative in every direction.
      for (const dir of [
        [0, 1, 0],
        [0.7, 0.1, 0.7],
        [0, 0.02, -1],
      ] as const) {
        const L = environmentRadiance(env, [dir[0], dir[1], dir[2]])
        for (const c of L) {
          expect(Number.isFinite(c)).toBe(true)
          expect(c).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })
})

describe('shader assembly', () => {
  it('prepends the shared block exactly once to each entry point', () => {
    const pass = skyPassSource()
    expect(pass.startsWith(SKY_COMMON_WGSL)).toBe(true)
    expect(pass).toContain('fn vs_sky')
    expect(pass).toContain('fn fs_sky')
    expect(pass.split('struct SkyUniforms').length - 1).toBe(1)
    expect(pass.split('@group(0) @binding(0)').length - 1).toBe(1)

    const capture = envCaptureSource()
    expect(capture).toContain('fn capture_face')
    expect(capture).toContain(ENV_CAPTURE_WGSL)
    expect(capture.split('struct SkyUniforms').length - 1).toBe(1)

    // The prefilter is standalone: it must NOT drag in the sky uniform block, or its bind group
    // layout would need a binding it never uses.
    const prefilter = envPrefilterSource()
    expect(prefilter).toContain('fn prefilter')
    expect(prefilter).not.toContain('struct SkyUniforms')
  })

  it('declares a Lobe struct with the same field count the packer writes', () => {
    const lobeBlock = SKY_COMMON_WGSL.slice(
      SKY_COMMON_WGSL.indexOf('struct Lobe'),
      SKY_COMMON_WGSL.indexOf('};', SKY_COMMON_WGSL.indexOf('struct Lobe')),
    )
    const vec4Count = (lobeBlock.match(/vec4<f32>/g) ?? []).length
    expect(vec4Count * 4).toBe(LOBE_FLOATS)
  })

  it('declares a SkyUniforms struct matching SKY_UNIFORM_FLOATS', () => {
    const start = SKY_COMMON_WGSL.indexOf('struct SkyUniforms')
    const block = SKY_COMMON_WGSL.slice(start, SKY_COMMON_WGSL.indexOf('};', start))
    const vec4Count = (block.match(/vec4<f32>/g) ?? []).length
    const mat4Count = (block.match(/mat4x4<f32>/g) ?? []).length
    const lobeCount = (block.match(/:\s*Lobe/g) ?? []).length
    expect(mat4Count * 16 + vec4Count * 4 + lobeCount * LOBE_FLOATS).toBe(SKY_UNIFORM_FLOATS)
  })
})
