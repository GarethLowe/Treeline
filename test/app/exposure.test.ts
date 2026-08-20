/**
 * Auto-exposure. `exposure.ts` claimed this file pinned its monotonicity and night clamp; it
 * did not exist. It does now, and it also pins the per-biome metering reflectance, which is
 * what stopped the conifer world rendering 0.8 stops under.
 */

import { describe, expect, it } from 'vitest'
import {
  BIOME_MEAN_ALBEDO,
  KEY_VALUE,
  MAX_EXPOSURE,
  MEAN_ALBEDO,
  MIN_EXPOSURE,
  adaptExposure,
  autoExposure,
  horizontalIrradiance,
  meanAlbedoFor,
} from '../../src/app/exposure.ts'

/** Mid-morning on the shipping world: the numbers the HUD shows at 10:00, day 196. */
const NOON = { directIrradiance: 849, diffuseIrradiance: 141, elevation: (54.5 * Math.PI) / 180 }

describe('horizontalIrradiance', () => {
  it('projects the beam onto the horizontal and adds the diffuse', () => {
    expect(horizontalIrradiance(NOON)).toBeCloseTo(849 * Math.sin(NOON.elevation) + 141, 6)
  })

  it('drops the beam entirely below the horizon but keeps the sky', () => {
    expect(horizontalIrradiance({ directIrradiance: 800, diffuseIrradiance: 20, elevation: -0.2 })).toBe(20)
  })

  it('never returns a negative irradiance from negative inputs', () => {
    expect(horizontalIrradiance({ directIrradiance: -5, diffuseIrradiance: -5, elevation: 1 })).toBe(0)
  })
})

describe('metering reflectance', () => {
  it('meters a conifer canopy far darker than a grassland', () => {
    // The physical claim: closed conifer is one of the darkest natural land covers (0.08-0.15
    // broadband), grass is roughly 0.16-0.26. If these ever converge, the forest goes dark
    // again and nothing else in the renderer will look wrong.
    expect(BIOME_MEAN_ALBEDO['western-us-conifer'] as number).toBeLessThan(
      BIOME_MEAN_ALBEDO['grassland-savanna'] as number,
    )
    expect(BIOME_MEAN_ALBEDO['western-us-conifer'] as number).toBeLessThan(0.16)
    expect(BIOME_MEAN_ALBEDO['grassland-savanna'] as number).toBeGreaterThan(0.16)
  })

  it('keeps every biome inside the physically plausible band', () => {
    for (const [id, a] of Object.entries(BIOME_MEAN_ALBEDO)) {
      expect(a, id).toBeGreaterThan(0.05)
      expect(a, id).toBeLessThan(0.4)
    }
  })

  it('falls back rather than throwing on an unknown biome', () => {
    // A mis-exposed frame is recoverable with the EV slider; a boot failure is not.
    expect(meanAlbedoFor('not-a-biome')).toBe(MEAN_ALBEDO)
    expect(meanAlbedoFor(undefined)).toBe(MEAN_ALBEDO)
  })

  it('exposes a dark biome brighter than a bright one under identical light', () => {
    const conifer = autoExposure({ ...NOON, biome: 'western-us-conifer' })
    const grass = autoExposure({ ...NOON, biome: 'grassland-savanna' })
    expect(conifer).toBeGreaterThan(grass)
  })
})

describe('autoExposure', () => {
  it('puts an average lit surface on the key value', () => {
    const e = autoExposure({ ...NOON, biome: 'western-us-conifer' })
    const albedo = BIOME_MEAN_ALBEDO['western-us-conifer'] as number
    const sceneRadiance = (albedo * horizontalIrradiance(NOON)) / Math.PI
    expect(sceneRadiance * e).toBeCloseTo(KEY_VALUE, 6)
  })

  it('falls monotonically as the scene gets brighter', () => {
    let previous = Infinity
    for (const dni of [0, 50, 200, 500, 900, 1361]) {
      const e = autoExposure({ directIrradiance: dni, diffuseIrradiance: 20, elevation: 1 })
      expect(e).toBeLessThanOrEqual(previous)
      previous = e
    }
  })

  it('clamps at night instead of lighting it like noon', () => {
    const night = autoExposure({ directIrradiance: 0, diffuseIrradiance: 0, elevation: -0.5 })
    expect(night).toBeLessThanOrEqual(MAX_EXPOSURE)
    expect(night).toBeGreaterThanOrEqual(MIN_EXPOSURE)
  })

  it('applies compensation in stops, and a stop is a factor of two', () => {
    const base = autoExposure({ ...NOON, biome: 'western-us-conifer' })
    const up = autoExposure({ ...NOON, biome: 'western-us-conifer', compensationStops: 1 })
    expect(up / base).toBeCloseTo(2, 6)
  })

  it('is always finite and positive across a whole day', () => {
    for (let deg = -90; deg <= 90; deg += 5) {
      const e = autoExposure({
        directIrradiance: Math.max(0, 900 * Math.sin((deg * Math.PI) / 180)),
        diffuseIrradiance: 120,
        elevation: (deg * Math.PI) / 180,
      })
      expect(Number.isFinite(e)).toBe(true)
      expect(e).toBeGreaterThan(0)
    }
  })
})

describe('adaptExposure', () => {
  it('moves in log space, so a 100x change is halved in log at one half-life', () => {
    const next = adaptExposure(1e-5, 1e-3, 0.35, 0.35)
    expect(Math.log10(next)).toBeCloseTo(-4, 6)
  })

  it('converges on the target and stays there', () => {
    // 200 frames at 60 Hz is 3.3 s, about 9.5 half-lives, so a little under 1% of the log
    // distance survives. Asserted as a ratio rather than an absolute: the whole point of
    // adapting in log space is that the error is multiplicative.
    let e = 1
    for (let i = 0; i < 200; i++) e = adaptExposure(e, 2.4e-3, 1 / 60)
    expect(e / 2.4e-3).toBeGreaterThan(0.99)
    expect(e / 2.4e-3).toBeLessThan(1.01)

    // And it keeps closing rather than orbiting: the remaining error strictly shrinks.
    const before = Math.abs(Math.log(e / 2.4e-3))
    for (let i = 0; i < 200; i++) e = adaptExposure(e, 2.4e-3, 1 / 60)
    const after = Math.abs(Math.log(e / 2.4e-3))
    expect(after).toBeLessThan(before)
    expect(after).toBeLessThan(1e-3)
  })

  it('takes the target immediately from a degenerate current value', () => {
    expect(adaptExposure(0, 1e-3, 0.1)).toBe(1e-3)
    expect(adaptExposure(-1, 1e-3, 0.1)).toBe(1e-3)
  })

  it('holds still rather than diving when handed a non-positive target', () => {
    expect(adaptExposure(1e-3, 0, 0.1)).toBe(1e-3)
  })
})
