import { describe, expect, it } from 'vitest'
import { REVERSED_Z } from '../../../src/camera/math.ts'
import {
  activeSlotsForTile,
  bandCount,
  bandOf,
  bladeSlotsForBand,
  bladeWidthScale,
  cullGrassTiles,
  domainTiles,
  grassDensityAt,
  MAX_WIDTH_COMPENSATION,
  outerFade,
  tileCapacityPerBand,
  tileSpan,
  validateGrassParams,
} from '@render/foliage/grassMath'
import { DEFAULT_GRASS, GRASS_VERTS_PER_BLADE, type GrassParams } from '@render/foliage/config'
import { extractFrustumPlanes, PLANE_FLOATS } from '@render/foliage/cullMath'
import { DOMAIN_SIZE_M } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { makeCamera } from './cameraHelper.ts'

const g = DEFAULT_GRASS

describe('grass density', () => {
  it('reproduces the spec §7.4 falloff exactly', () => {
    const d0 = g.falloffStartM as number
    const d1 = g.falloffEndM as number
    for (const d of [0, 5, 12, 20, 30, 44, 45, 60]) {
      const expected = g.densityPerM2 * Math.min(Math.max((d1 - d) / (d1 - d0), 0), 1)
      expect(grassDensityAt(d, g)).toBeCloseTo(expected, 9)
    }
    expect(grassDensityAt(0, g)).toBe(400)
    expect(grassDensityAt(12, g)).toBeCloseTo(400, 9)
    expect(grassDensityAt(45, g)).toBe(0)
    expect(grassDensityAt(1000, g)).toBe(0)
  })

  it('never increases with distance', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= 60; d += 0.25) {
      const rho = grassDensityAt(d, g)
      expect(rho).toBeLessThanOrEqual(previous + 1e-9)
      previous = rho
    }
  })
})

describe('grass bands', () => {
  it('assigns every distance in range to exactly one band', () => {
    for (let d = 0; d < (g.falloffEndM as number); d += 0.1) {
      const b = bandOf(d, g)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(bandCount(g))
      const near = g.bandEdgesM[b] as number
      const far = g.bandEdgesM[b + 1] as number
      expect(d).toBeGreaterThanOrEqual(near)
      expect(d).toBeLessThan(far)
    }
    expect(bandOf(g.falloffEndM as number, g)).toBe(bandCount(g) - 1)
    expect(bandOf((g.falloffEndM as number) + 0.01, g)).toBe(-1)
  })

  it('sizes each band by the density at its near edge, so no tile is truncated', () => {
    for (let b = 0; b < bandCount(g); b++) {
      const slots = bladeSlotsForBand(b, g)
      const near = g.bandEdgesM[b] as number
      const far = g.bandEdgesM[b + 1] as number
      for (let d = near; d < far; d += 0.5) {
        expect(activeSlotsForTile(d, b, g)).toBeLessThanOrEqual(slots)
      }
      // The near edge itself is the maximum, up to the ceil() the slot count applies.
      expect(activeSlotsForTile(near, b, g)).toBeLessThanOrEqual(slots)
      expect(slots).toBeGreaterThan(0)
    }
  })

  it('thins monotonically with distance inside a band', () => {
    for (let b = 0; b < bandCount(g); b++) {
      let previous = Number.POSITIVE_INFINITY
      const near = g.bandEdgesM[b] as number
      const far = g.bandEdgesM[b + 1] as number
      for (let d = near; d <= far; d += 0.25) {
        const active = activeSlotsForTile(d, b, g)
        expect(active).toBeLessThanOrEqual(previous)
        previous = active
      }
    }
  })

  it('widens blades as they thin, within the clamp', () => {
    const slots = bladeSlotsForBand(3, g)
    const nearEdge = bladeWidthScale(slots, slots, g)
    expect(nearEdge).toBeCloseTo(1, 9)
    const halfDensity = bladeWidthScale(Math.round(slots / 2), slots, g)
    expect(halfDensity).toBeCloseTo(Math.SQRT2, 2)
    expect(bladeWidthScale(1, slots, g)).toBeLessThanOrEqual(MAX_WIDTH_COMPENSATION)
    // Compensation disabled means no widening at all.
    const noComp: GrassParams = { ...g, widthCompensation: 0 }
    expect(bladeWidthScale(1, slots, noComp)).toBe(1)
  })

  it('fades out over the outer shell', () => {
    expect(outerFade(0, g)).toBe(1)
    expect(outerFade(g.falloffEndM as number, g)).toBe(0)
    const w = (g.falloffEndM as number) * g.outerFadeFraction
    expect(outerFade((g.falloffEndM as number) - w / 2, g)).toBeCloseTo(0.5, 6)
  })
})

describe('grass tile grid', () => {
  it('covers the falloff radius', () => {
    const span = tileSpan(g)
    const radiusM = ((span - 1) / 2) * (g.tileSizeM as number)
    expect(radiusM).toBeGreaterThanOrEqual(g.falloffEndM as number)
    expect(domainTiles(g)).toBe(DOMAIN_SIZE_M / (g.tileSizeM as number))
    expect(tileCapacityPerBand(g)).toBe(span * span)
  })

  it('culls tiles behind the camera and keeps tiles in front', () => {
    const camera = makeCamera({ eye: [512, 1.7, 512], target: [512, 1.7, 400] })
    const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)
    const result = cullGrassTiles(
      { cameraX: 512, cameraZ: 512, planes, verticalMarginM: 4, groundY: 0 },
      g,
    )
    expect(result.tilesVisible).toBeGreaterThan(0)
    expect(result.clamped).toBe(false)
    for (const tiles of result.tilesByBand) {
      for (const tile of tiles) {
        const cz = (tile.tileZ + 0.5) * (g.tileSizeM as number)
        // The camera looks towards -Z; a tile well behind it must not survive.
        expect(cz).toBeLessThan(512 + (g.tileSizeM as number) * 3)
      }
    }
  })

  it('counts blades as the exact sum of per-tile active slots', () => {
    const camera = makeCamera({ eye: [512, 1.7, 512], target: [512, 1.7, 400] })
    const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)
    const result = cullGrassTiles(
      { cameraX: 512, cameraZ: 512, planes, verticalMarginM: 4, groundY: 0 },
      g,
    )
    let expected = 0
    for (const tiles of result.tilesByBand) {
      for (const tile of tiles) {
        expect(tile.activeSlots).toBe(activeSlotsForTile(tile.distanceM, tile.band, g))
        expected += tile.activeSlots
      }
    }
    expect(result.bladesDrawn).toBe(expected)
    expect(result.bladesDrawn).toBeGreaterThan(0)
  })

  it('writes per-band draw arguments whose vertex count covers the band', () => {
    const camera = makeCamera({ eye: [512, 1.7, 512], target: [512, 1.7, 400] })
    const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)
    const result = cullGrassTiles(
      { cameraX: 512, cameraZ: 512, planes, verticalMarginM: 4, groundY: 0 },
      g,
    )
    result.drawArgs.forEach((args, band) => {
      expect(args[0]).toBe(bladeSlotsForBand(band, g) * GRASS_VERTS_PER_BLADE)
      expect(args[1]).toBe(result.tilesByBand[band]!.length)
      expect(args[2]).toBe(0)
      expect(args[3]).toBe(0)
      for (const tile of result.tilesByBand[band]!) {
        expect(tile.activeSlots * GRASS_VERTS_PER_BLADE).toBeLessThanOrEqual(args[0])
      }
    })
  })

  it('clips tiles to the domain at a corner', () => {
    const camera = makeCamera({ eye: [2, 1.7, 2], target: [40, 1.7, 40] })
    const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)
    const result = cullGrassTiles({ cameraX: 2, cameraZ: 2, planes, verticalMarginM: 4, groundY: 0 }, g)
    for (const tiles of result.tilesByBand) {
      for (const tile of tiles) {
        expect(tile.tileX).toBeGreaterThanOrEqual(0)
        expect(tile.tileZ).toBeGreaterThanOrEqual(0)
        expect(tile.tileX).toBeLessThan(domainTiles(g))
        expect(tile.tileZ).toBeLessThan(domainTiles(g))
      }
    }
  })

  it('produces a blade count in the order of magnitude spec §7.4 quotes', () => {
    // Spec says ~600 k blades for the whole field. A 60-degree camera sees a fraction of it;
    // the check that matters is that we are within an order of magnitude, not that we match a
    // number the spec itself flags as unverified.
    const camera = makeCamera({ eye: [512, 1.7, 512], target: [512, 1.7, 400] })
    const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)
    const result = cullGrassTiles(
      { cameraX: 512, cameraZ: 512, planes, verticalMarginM: 4, groundY: 0 },
      g,
    )
    expect(result.bladesDrawn).toBeGreaterThan(50_000)
    expect(result.bladesDrawn).toBeLessThan(600_000)
  })
})

describe('grass parameter validation', () => {
  it('accepts the defaults', () => {
    expect(validateGrassParams(g)).toEqual([])
  })

  it('rejects band edges that do not span the falloff', () => {
    const bad: GrassParams = { ...g, bandEdgesM: [0, 10, 20] as unknown as readonly Metres[] }
    expect(validateGrassParams(bad).join(' ')).toContain('must end at falloffEndM')
  })

  it('rejects non-ascending band edges and too many bands', () => {
    const notAscending: GrassParams = {
      ...g,
      bandEdgesM: [0, 20, 15, 45] as unknown as readonly Metres[],
    }
    expect(validateGrassParams(notAscending).join(' ')).toContain('strictly ascending')

    const tooMany: GrassParams = {
      ...g,
      bandEdgesM: [0, 5, 10, 15, 20, 45] as unknown as readonly Metres[],
    }
    expect(validateGrassParams(tooMany).join(' ')).toContain('max is')
  })
})
