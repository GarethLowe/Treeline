/**
 * The grass blade atlas, against the UVs `grassDraw.wgsl` actually samples it with.
 *
 * Two bugs shipped here and both were invisible to every existing test, because the grass
 * material was never reached: `grassMaterialLayer()` looked up a literal `'grass'`, no biome
 * uses that id, and the miss fell back to layer 0 — opaque conifer bark. Fixing the lookup
 * made grass vanish, which is how the collision below surfaced.
 *
 * These are CPU assertions on `samplePattern`, the same oracle the GPU generator mirrors, so
 * they hold without a device.
 */

import { describe, expect, it } from 'vitest'
import { MATERIAL_RECIPES, seedForId } from '@render/materials/library.ts'
import { patternDetailMean, samplePattern, type PatternParams } from '@render/materials/patterns.ts'
import { BURN_STAGE } from '@render/materials/patterns.ts'

const recipe = MATERIAL_RECIPES.find((r) => r.id === 'grass-blade')
if (recipe === undefined) throw new Error("no 'grass-blade' recipe")

const withSeed = { ...recipe.pattern, seed: seedForId(recipe.id) }
const params: PatternParams = { ...withSeed, detailMean: patternDetailMean(withSeed) }

const at = (u: number, v: number) => samplePattern(params, u, v, BURN_STAGE.Green)

describe('grass blade atlas vs the UVs the ribbon samples it with', () => {
  it('is fully transparent at u = 0 and u = 1, which is why the cutout test killed every blade', () => {
    // The ribbon's two edges are `u = j & 1`, i.e. exactly the cell boundaries. Blades are
    // ~3.5% of a cell wide and randomly offset inside it, so the boundary is always gap.
    // If this ever stops being true the alpha test could be reinstated — but the geometry
    // already is the silhouette, so it should not be.
    for (let i = 0; i <= 10; i++) {
      const v = i / 10
      expect(at(0, v).alpha, `u=0 v=${v}`).toBe(0)
      expect(at(1, v).alpha, `u=1 v=${v}`).toBe(0)
    }
  })

  it('shades green at the base and cured straw at the tip, in that order along v', () => {
    // `uv.y = t` in the vertex shader, t = 0 at the ground. The gradient IS the curing state
    // M5 drives, so its direction is physics, not decoration. It used to be `1.0 - t`.
    const base = at(0, 0).albedo
    const tip = at(0, 1).albedo

    // Green at the base: more green than red.
    expect(base[1]).toBeGreaterThan(base[0])
    // Cured at the tip: red has caught green up, and the whole thing is brighter and yellower.
    expect(tip[0]).toBeGreaterThan(base[0])
    expect(tip[0] / tip[1]).toBeGreaterThan(base[0] / base[1])
  })

  it('carries the gradient monotonically, so no band of it reads as a stripe', () => {
    let previous = -Infinity
    for (let i = 0; i <= 8; i++) {
      const rg = (() => {
        const c = at(0, i / 8).albedo
        return c[0] / c[1]
      })()
      expect(rg).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = rg
    }
  })
})
