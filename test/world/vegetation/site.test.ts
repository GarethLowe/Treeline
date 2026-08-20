/**
 * Site-field tests.
 *
 * The density responses cannot be tested inside a generated landscape — a steep cell is
 * usually also a high cell on a particular aspect, so every response is confounded with every
 * other. They are therefore tested two ways:
 *
 *  1. Directly, on the exported `densityWeight` / `aspectCoolness` functions, one input moving
 *     at a time. This proves the direction of each response.
 *  2. Through a purpose-built analytic terrain whose ONLY asymmetry is aspect: a corrugation
 *     `h = A·cos(2πz/L)`, which is exactly symmetric about z = L/2 in height, slope and
 *     topographic position, and antisymmetric only in which way the slope faces. Any
 *     difference in stem count between the halves therefore has exactly one possible cause.
 *
 * That second terrain is also how the southern-hemisphere check works: flipping the sign of
 * the latitude must move the dense half from north-facing to south-facing, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { makeStubTerrain } from '../../fixtures/world.ts'
import type { Metres, Radians, SlopeTangent } from '@contracts/units'
import { m, rad, slopeTan } from '@contracts/units'
import { type TerrainSampler } from '../../../src/camera/terrainStub.ts'
import { BIOMES, BIOME_EXTRAS } from '../../../src/world/vegetation/biomes.ts'
import { SiteField, aspectCoolness, densityWeight, moistureIndex } from '../../../src/world/vegetation/site.ts'
import { speciesForBiome } from '../../../src/world/vegetation/species.ts'

/**
 * `h = A·cos(2πz/L)`. Flat in x. For z < L/2 the ground falls toward −z (north), so the
 * DOWNSLOPE azimuth is south (π); for z > L/2 it is north (0). Height, slope magnitude and
 * topographic position are mirror-symmetric about z = L/2, so aspect is the only asymmetry.
 */
class CorrugatedTerrain implements TerrainSampler {
  readonly minElevationM: Metres
  readonly maxElevationM: Metres
  constructor(
    private readonly amplitude: number,
    private readonly sizeM: number,
  ) {
    this.minElevationM = m(-amplitude)
    this.maxElevationM = m(amplitude)
  }
  private dhdz(z: number): number {
    return -this.amplitude * ((2 * Math.PI) / this.sizeM) * Math.sin((2 * Math.PI * z) / this.sizeM)
  }
  heightAt(_x: Metres, z: Metres): Metres {
    return m(this.amplitude * Math.cos((2 * Math.PI * z) / this.sizeM))
  }
  normalAt(_x: Metres, z: Metres): readonly [number, number, number] {
    const hz = this.dhdz(z)
    const inv = 1 / Math.sqrt(hz * hz + 1)
    return [0, inv, -hz * inv]
  }
  slopeAt(_x: Metres, z: Metres): SlopeTangent {
    return slopeTan(Math.abs(this.dhdz(z)))
  }
  aspectAt(_x: Metres, z: Metres): Radians {
    const hz = this.dhdz(z)
    // east = 0, north = +∂h/∂z. atan2(0, +) = 0 (north-facing); atan2(0, −) = π (south-facing).
    return rad(hz >= 0 ? 0 : Math.PI)
  }
}

describe('density response functions', () => {
  const sr = BIOME_EXTRAS['western-us-conifer'].siteResponse

  it('makes steep ground sparser when slopeResponse < 1', () => {
    expect(sr.slopeResponse).toBeLessThan(1)
    const flat = densityWeight(sr, 0, 0, 0, sr.elevationOptimum)
    const steep = densityWeight(sr, 1, 0, 0, sr.elevationOptimum)
    expect(steep).toBeLessThan(flat)
  })

  it('makes steep ground denser in the UK biome, where the flat land is farmed', () => {
    const uk = BIOME_EXTRAS['uk-mixed-field-forest'].siteResponse
    expect(uk.slopeResponse).toBeGreaterThan(1)
    expect(densityWeight(uk, 1, 0, 0, uk.elevationOptimum)).toBeGreaterThan(
      densityWeight(uk, 0, 0, 0, uk.elevationOptimum),
    )
  })

  it('makes the cool aspect denser than the hot aspect, by the declared ratio', () => {
    const cool = densityWeight(sr, 0.5, 1, 0, sr.elevationOptimum)
    const hot = densityWeight(sr, 0.5, -1, 0, sr.elevationOptimum)
    expect(cool / hot).toBeCloseTo(sr.coolAspectResponse, 6)
  })

  it('makes valley bottoms denser and ridge crests sparser', () => {
    const mid = densityWeight(sr, 0.5, 0, 0, sr.elevationOptimum)
    const valley = densityWeight(sr, 0.5, 0, -1, sr.elevationOptimum)
    const ridge = densityWeight(sr, 0.5, 0, 1, sr.elevationOptimum)
    expect(valley / mid).toBeCloseTo(sr.valleyResponse, 6)
    expect(ridge / mid).toBeCloseTo(sr.ridgeResponse, 6)
    expect(valley).toBeGreaterThan(ridge)
  })

  it('peaks at the elevation optimum', () => {
    const peak = densityWeight(sr, 0, 0, 0, sr.elevationOptimum)
    expect(densityWeight(sr, 0, 0, 0, 0)).toBeLessThan(peak)
    expect(densityWeight(sr, 0, 0, 0, 1)).toBeLessThan(peak)
  })
})

describe('aspect coolness', () => {
  it('is zero on flat ground, whatever the nominal aspect', () => {
    expect(aspectCoolness(0, 0, 50)).toBe(0)
  })

  it('is zero at the equator, where no aspect is shaded', () => {
    expect(aspectCoolness(0, 1, 0)).toBe(0)
  })

  it('picks north in the northern hemisphere and south in the southern', () => {
    const north = rad(0)
    const south = rad(Math.PI)
    expect(aspectCoolness(north, 1, 50)).toBeGreaterThan(0)
    expect(aspectCoolness(south, 1, 50)).toBeLessThan(0)
    // Southern hemisphere: exactly inverted. This is why the eucalypt biome's dense
    // vegetation sits on south-facing slopes.
    expect(aspectCoolness(north, 1, -38)).toBeLessThan(0)
    expect(aspectCoolness(south, 1, -38)).toBeGreaterThan(0)
  })
})

describe('moisture index', () => {
  it('is highest on a cool-aspect valley bottom and lowest on a hot-aspect ridge', () => {
    expect(moistureIndex(1, -1)).toBeGreaterThan(moistureIndex(0, 0))
    expect(moistureIndex(-1, 1)).toBeLessThan(moistureIndex(0, 0))
    expect(moistureIndex(1, -1)).toBeCloseTo(1, 6)
    expect(moistureIndex(-1, 1)).toBeCloseTo(-1, 6)
  })
})

describe('intensity field normalisation', () => {
  // This is the invariant the entire density acceptance criterion rests on: terrain
  // redistributes stems, it cannot change how many there are.
  it.each(Object.keys(BIOMES) as (keyof typeof BIOMES)[])(
    '%s expects exactly density × area stems regardless of terrain response',
    (biome) => {
      const sizeM = 512
      const terrain = makeStubTerrain(4242, biome, sizeM)
      const veg = BIOMES[biome].defaultVegetation
      const site = new SiteField(
        { seed: 4242, biome, vegetation: veg, terrain, sizeM, latitudeDeg: 45 },
        speciesForBiome(biome),
      )
      const expectedStems = (veg.stemDensityPerHa * (sizeM * sizeM)) / 10_000
      expect(site.expectedStemCount).toBeCloseTo(expectedStems, 6)
    },
  )

  it('still redistributes strongly even though the total is fixed', () => {
    const sizeM = 512
    const biome = 'western-us-conifer' as const
    const terrain = makeStubTerrain(99, biome, sizeM)
    const site = new SiteField(
      {
        seed: 99,
        biome,
        vegetation: BIOMES[biome].defaultVegetation,
        terrain,
        sizeM,
        latitudeDeg: 34.5,
      },
      speciesForBiome(biome),
    )
    let lo = Infinity
    let hi = 0
    for (let k = 0; k < site.cellCount; k++) {
      const v = site.intensity[k] as number
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    // A field that came out flat would pass the normalisation test above while doing nothing.
    expect(hi / lo).toBeGreaterThan(2)
  })
})

describe('the corrugated terrain isolates aspect', () => {
  const sizeM = 512
  const biome = 'western-us-conifer' as const

  function halfIntensities(latitudeDeg: number): { south: number; north: number } {
    const terrain = new CorrugatedTerrain(30, sizeM)
    const site = new SiteField(
      {
        seed: 5,
        biome,
        vegetation: BIOMES[biome].defaultVegetation,
        terrain,
        sizeM,
        latitudeDeg,
        cellSizeM: 8,
      },
      speciesForBiome(biome),
    )
    let south = 0
    let north = 0
    const n = site.cols
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = site.intensity[j * n + i] as number
        // z < L/2 faces south; z > L/2 faces north.
        if (j < n / 2) south += v
        else north += v
      }
    }
    return { south, north }
  }

  it('puts more stems on the north-facing half in the northern hemisphere', () => {
    const { south, north } = halfIntensities(34.5)
    expect(north).toBeGreaterThan(south * 1.2)
  })

  it('inverts in the southern hemisphere', () => {
    const { south, north } = halfIntensities(-38.6)
    expect(south).toBeGreaterThan(north * 1.2)
  })

  it('is symmetric at the equator, where aspect stops mattering', () => {
    const { south, north } = halfIntensities(0)
    expect(north / south).toBeCloseTo(1, 6)
  })
})
