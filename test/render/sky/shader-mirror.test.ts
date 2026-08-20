/**
 * A CPU mirror of what shaders/sky/sky_common.wgsl does with the uniform buffer.
 *
 * The failure this exists to catch: the packer writes `zenithX` at float 56 and the shader reads
 * it as `zen.x` at the same offset — until someone inserts a field. Nothing type-checks that
 * correspondence, and the symptom on a GPU is a black or lurid sky with no error message. So the
 * mapping is re-implemented here EXACTLY as the WGSL reads it (by struct field, from the packed
 * Float32Array) and asserted against the model the packer was built from.
 *
 * If this test and the shader ever disagree, the shader is wrong: this file is written from the
 * WGSL field accessors, not from the packer.
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
  environmentRadiance,
  makeSkyEnvironment,
  packSkyUniforms,
  LOBE_FLOATS,
} from '../../../src/render/sky/sky-model.ts'
import { skyRadiance } from '../../../src/render/sky/preetham.ts'

const SITE = makeSite(51.5074, -0.1278, { utcOffsetHours: 0, year: 2024 })
const DOY = dayOfYearFromCalendar(2024, 8, 15)

function envAt(hours: number) {
  const time = timeOfDay(DOY, Math.floor(hours), Math.round((hours % 1) * 60))
  const solar = computeSolarState(SITE, time, DEFAULT_ATMOSPHERE)
  return makeSkyEnvironment(
    solar,
    julianDayForLocalTime(SITE, time),
    SITE.latitudeDeg,
    SITE.longitudeDeg,
    DEFAULT_ATMOSPHERE,
  )
}

// --- transcribed from sky_common.wgsl ---------------------------------------

/** `fn perez(a, b, c, d, e, cosTheta, gamma)`. */
function perez(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  cosTheta: number,
  gamma: number,
): number {
  const ct = Math.max(cosTheta, 0.01)
  const cg = Math.cos(gamma)
  return (1 + a * Math.exp(b / ct)) * (1 + c * Math.exp(d * gamma) + e * cg * cg)
}

/** `fn xyY_to_linear_srgb(x, y, Y)`. */
function xyYToLinearSrgb(x: number, y: number, Y: number): [number, number, number] {
  if (y <= 1e-6) return [0, 0, 0]
  const X = (x * Y) / y
  const Z = ((1 - x - y) * Y) / y
  return [
    Math.max(0, 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z),
    Math.max(0, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z),
    Math.max(0, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z),
  ]
}

/**
 * `fn lobe_radiance(lobe, dir)`, reading the uniform block the way the WGSL struct does:
 * y0 = floats 0..3, y1 = 4..7, y2 = 8..11, y3 = 12..15, zen = 16..19, den = 20..23, dir = 24..27.
 */
function lobeRadiance(
  u: Float32Array,
  base: number,
  dir: readonly [number, number, number],
): [number, number, number] {
  const f = (i: number): number => u[base + i]!
  const y0 = [f(0), f(1), f(2), f(3)]
  const y1 = [f(4), f(5), f(6), f(7)]
  const y2 = [f(8), f(9), f(10), f(11)]
  const y3 = [f(12), f(13), f(14), f(15)]
  const zen = [f(16), f(17), f(18), f(19)]
  const den = [f(20), f(21), f(22), f(23)]
  const ldir = [f(24), f(25), f(26), f(27)]

  if (ldir[3]! < 0.5 || dir[1] <= 0) return [0, 0, 0]

  const cosGamma = Math.max(
    -1,
    Math.min(1, dir[0] * ldir[0]! + dir[1] * ldir[1]! + dir[2] * ldir[2]!),
  )
  const gamma = Math.acos(cosGamma)
  const ct = dir[1]

  const fY = perez(y0[0]!, y0[1]!, y0[2]!, y0[3]!, y1[0]!, ct, gamma)
  const fx = perez(y1[1]!, y1[2]!, y1[3]!, y2[0]!, y2[1]!, ct, gamma)
  const fy = perez(y2[2]!, y2[3]!, y3[0]!, y3[1]!, y3[2]!, ct, gamma)

  const lum = (y3[3]! * fY) / Math.max(den[0]!, 1e-6)
  const cx = (zen[0]! * fx) / Math.max(den[1]!, 1e-6)
  const cy = (zen[1]! * fy) / Math.max(den[2]!, 1e-6)

  const radiance = lum * zen[3]! * zen[2]!
  return xyYToLinearSrgb(cx, cy, radiance)
}

/** `fn environment_radiance_ex(dir, false)` for a direction above the horizon. */
function environmentRadianceFromUniforms(
  u: Float32Array,
  dir: readonly [number, number, number],
): [number, number, number] {
  const a = lobeRadiance(u, 40, dir)
  const b = lobeRadiance(u, 40 + LOBE_FLOATS, dir)
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

// ---------------------------------------------------------------------------

const DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [0, 1, 0],
  [0.577, 0.577, 0.577],
  [-0.6, 0.2, 0.775],
  [0.99, 0.14, 0],
  [0, 0.02, -0.9998],
  [-0.3, 0.9, -0.316],
]

function packed(hours: number): { u: Float32Array; env: ReturnType<typeof envAt> } {
  const env = envAt(hours)
  const u = packSkyUniforms(env, {
    invViewProjMatrix: new Float32Array(16),
    cameraPosition: [0, 0, 0],
    exposure: 1,
    outputMode: 'linear-hdr',
    plumeOpticalDepth: 0,
    groundAlbedo: 0.2,
  })
  return { u, env }
}

describe('the shader reads what the packer wrote', () => {
  it('reproduces the solar lobe radiance from the uniform block', () => {
    for (const hour of [6, 9, 12, 15, 19, 21]) {
      const { u, env } = packed(hour)
      for (const dir of DIRECTIONS) {
        const fromShader = lobeRadiance(u, 40, dir)
        const fromModel = skyRadiance(env.solarLobe, dir)
        for (let c = 0; c < 3; c++) {
          // f32 storage of the coefficients: agreement to ~1e-5 relative.
          const scale = Math.max(1e-9, Math.abs(fromModel[c]!))
          expect(Math.abs(fromShader[c]! - fromModel[c]!) / scale).toBeLessThan(1e-4)
        }
      }
    }
  })

  it('reproduces the lunar lobe radiance from the uniform block', () => {
    const { u, env } = packed(23)
    for (const dir of DIRECTIONS) {
      const fromShader = lobeRadiance(u, 40 + LOBE_FLOATS, dir)
      const fromModel = skyRadiance(env.lunarLobe, dir)
      for (let c = 0; c < 3; c++) {
        const scale = Math.max(1e-12, Math.abs(fromModel[c]!))
        expect(Math.abs(fromShader[c]! - fromModel[c]!) / scale).toBeLessThan(1e-3)
      }
    }
  })

  it('reproduces the summed environment radiance the SH projection integrates', () => {
    for (const hour of [8, 13, 20, 2]) {
      const { u, env } = packed(hour)
      for (const dir of DIRECTIONS) {
        const fromShader = environmentRadianceFromUniforms(u, dir)
        const fromModel = environmentRadiance(env, dir)
        for (let c = 0; c < 3; c++) {
          const scale = Math.max(1e-12, Math.abs(fromModel[c]!))
          expect(Math.abs(fromShader[c]! - fromModel[c]!) / scale).toBeLessThan(1e-3)
        }
      }
    }
  })

  it('returns zero below the horizon, where the shader takes the ground branch instead', () => {
    const { u } = packed(12)
    expect(lobeRadiance(u, 40, [0, -0.5, 0.866])).toEqual([0, 0, 0])
  })

  it('carries the global horizontal irradiance the ground branch needs', () => {
    // den.w of the solar lobe is float 63; the shader reads it as sky.solarLobe.den.w.
    const { u, env } = packed(12)
    expect(u[63]).toBeCloseTo(env.solar.irradiance.globalHorizontal, 2)
    expect(u[63]).toBeGreaterThan(0)
  })
})
