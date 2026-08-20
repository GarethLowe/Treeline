/**
 * Integration invariants that would each produce a plausible-looking but wrong
 * world, silently. Nothing here needs a GPU.
 */

import { describe, expect, it } from 'vitest'
import { DEPTH_COMPARE, DEPTH_CLEAR_VALUE, DEPTH_FORMAT, REVERSED_Z } from '../../src/camera/math.ts'
import { BIOME_IDS } from '../../src/contracts/world.ts'
import { biomeParams } from '../../src/world/vegetation/biomes.ts'
import { MATERIAL_IDS } from '../../src/render/materials/library.ts'
import { resolveGroundMaterialIds } from '../../src/app/biomeMaterials.ts'
import { buildTerrainGrid, gridAxisToWorld, INNER_FRACTION } from '../../src/app/terrainGrid.ts'
import { foliageConfigFor } from '../../src/app/worldRenderer.ts'
import { autoExposure } from '../../src/app/exposure.ts'

describe('depth convention', () => {
  // The single most likely cause of a black screen at integration: WP 1.8 renders with
  // reversed-Z, WP 1.5's DEFAULT_FOLIAGE_CONFIG ships depthCompare 'less'. A foliage pass
  // that keeps 'less' against a reverse-Z buffer draws nothing at all.
  it('foliage inherits the camera package reversed-Z state, not the package default', () => {
    expect(REVERSED_Z).toBe(true)
    expect(DEPTH_COMPARE).toBe('greater')
    expect(DEPTH_CLEAR_VALUE).toBe(0)

    const cfg = foliageConfigFor({ viewportHeightPx: 1440, grassEnabled: true, understoryCover: 0.5 })
    expect(cfg.depthCompare).toBe(DEPTH_COMPARE)
    expect(cfg.depthFormat).toBe(DEPTH_FORMAT)
    expect(cfg.colorFormats).toEqual(['rgba16float'])
  })

  it('scales grass density by the biome understory cover', () => {
    const full = foliageConfigFor({ viewportHeightPx: 1440, grassEnabled: true, understoryCover: 1 })
    const half = foliageConfigFor({ viewportHeightPx: 1440, grassEnabled: true, understoryCover: 0.5 })
    expect(half.grass?.densityPerM2).toBeCloseTo((full.grass?.densityPerM2 ?? 0) / 2)
  })
})

describe('ground material translation', () => {
  // WP 1.3 names ground types ecologically ('needle-duff'); WP 1.6 ships a fixed id table
  // ('ground-duff') and throws on anything else. Every biome must translate, or the fallback
  // silently discards WP 1.3's intent.
  it('translates every biome without falling back', () => {
    for (const biome of BIOME_IDS) {
      const { ids, warning } = resolveGroundMaterialIds(biome, biomeParams(biome).groundMaterials)
      expect(warning, `biome ${biome}`).toBeNull()
      expect(ids).toHaveLength(4)
      for (const id of ids) expect(MATERIAL_IDS).toContain(id)
    }
  })

  it('falls back loudly on an unknown name rather than substituting one silently', () => {
    const { warning } = resolveGroundMaterialIds('western-us-conifer', ['nonsense', 'a', 'b', 'c'])
    expect(warning).toMatch(/nonsense/)
  })
})

describe('terrain grid', () => {
  // Mirrored exactly by terrainAxisToWorld() in shaders/app/terrain.wgsl. If these drift the
  // mesh and the heightfield stop describing the same surface.
  it('puts the domain edges exactly on the inner-fraction boundary', () => {
    const domain = 1024
    expect(gridAxisToWorld(0.5, domain)).toBeCloseTo(512)
    expect(gridAxisToWorld(0.5 - INNER_FRACTION / 2, domain)).toBeCloseTo(0)
    expect(gridAxisToWorld(0.5 + INNER_FRACTION / 2, domain)).toBeCloseTo(domain)
  })

  it('is monotonic and reaches past the domain on both sides', () => {
    const domain = 1024
    let previous = -Infinity
    for (let i = 0; i <= 64; i++) {
      const v = gridAxisToWorld(i / 64, domain)
      expect(v).toBeGreaterThan(previous)
      previous = v
    }
    expect(gridAxisToWorld(0, domain)).toBeLessThan(0)
    expect(gridAxisToWorld(1, domain)).toBeGreaterThan(domain)
  })

  it('emits a consistent two-triangle quad layout', () => {
    const grid = buildTerrainGrid(2)
    expect(grid.vertsPerAxis).toBe(3)
    expect(grid.vertexCount).toBe(9)
    expect(grid.indices).toHaveLength(2 * 2 * 6)
    // Quad (0,0) is a=0, b=1, c=3, d=4 -> (a,c,b) then (b,c,d). Pinned because the terrain
    // pass draws unculled: if culling is ever enabled, this is the winding to reason about.
    expect([...grid.indices.slice(0, 6)]).toEqual([0, 3, 1, 1, 3, 4])
  })
})

describe('auto exposure', () => {
  it('falls as the scene brightens and is clamped at night', () => {
    const noon = autoExposure({ directIrradiance: 900, diffuseIrradiance: 120, elevation: 1.2 })
    const dusk = autoExposure({ directIrradiance: 50, diffuseIrradiance: 40, elevation: 0.05 })
    const night = autoExposure({ directIrradiance: 0, diffuseIrradiance: 0, elevation: -0.5 })
    expect(noon).toBeLessThan(dusk)
    // Dusk is already dark enough to sit on the ceiling, which is the point of the ceiling:
    // without it the key value would chase moonlight and light the night like noon.
    expect(dusk).toBeLessThanOrEqual(night)
    expect(night).toBeCloseTo(0.02)
  })
})
