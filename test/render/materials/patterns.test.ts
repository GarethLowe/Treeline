/**
 * Procedural generator: determinism, tiling, and the spec §7.6 burn-stage targets. WP 1.6.
 */

import { describe, expect, it } from 'vitest'
import {
  BURN_STAGE,
  BURN_TARGETS,
  CRACK_GRADIENT_SCALE,
  crackDepthM,
  crackField,
  crackMask,
  decodeCrackGradient,
  patternDetailMean,
  patternHeight,
  samplePattern,
  type BurnStage,
} from '../../../src/render/materials/patterns.ts'
import { fbm2P, hashU32, valueNoise2P, worley2P } from '../../../src/render/materials/noise.ts'
import { MATERIAL_RECIPES, packMaterials, seedForId } from '../../../src/render/materials/library.ts'
import { bakeLayerBase, meanChannel, meanLinearAlbedo } from '../../../src/render/materials/bake.ts'

const packing = packMaterials()
const byId = (id: string) => {
  const m = packing.byId.get(id)
  if (!m) throw new Error(`missing ${id}`)
  return m
}

describe('noise', () => {
  it('hashes deterministically and stays in u32', () => {
    expect(hashU32(0)).toBe(hashU32(0))
    for (const x of [0, 1, 7, 0xffffffff, 0x9e3779b1]) {
      const h = hashU32(x)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('avalanches: one input bit changes about half the output bits', () => {
    let total = 0
    const trials = 64
    for (let i = 0; i < trials; i++) {
      const a = hashU32(i * 2654435761)
      const b = hashU32((i * 2654435761) ^ 1)
      let diff = 0
      let x = (a ^ b) >>> 0
      while (x !== 0) {
        diff += x & 1
        x >>>= 1
      }
      total += diff
    }
    const mean = total / trials
    expect(mean).toBeGreaterThan(12)
    expect(mean).toBeLessThan(20)
  })

  it('tiles seamlessly: value noise at u=0 equals u=1', () => {
    for (let i = 0; i < 32; i++) {
      const v = i / 32
      expect(valueNoise2P(0, v, 8, 5, 1234)).toBeCloseTo(valueNoise2P(1, v, 8, 5, 1234), 12)
      expect(valueNoise2P(v, 0, 8, 5, 1234)).toBeCloseTo(valueNoise2P(v, 1, 8, 5, 1234), 12)
    }
  })

  it('tiles seamlessly through fbm and worley', () => {
    for (let i = 0; i < 16; i++) {
      const v = i / 16
      expect(fbm2P(0, v, 6, 6, 99, 4)).toBeCloseTo(fbm2P(1, v, 6, 6, 99, 4), 12)
      const a = worley2P(0, v, 7, 7, 99)
      const b = worley2P(1, v, 7, 7, 99)
      expect(a.f1).toBeCloseTo(b.f1, 12)
      expect(a.f2).toBeCloseTo(b.f2, 12)
      expect(a.cell).toBe(b.cell)
    }
  })

  it('produces value noise on [0,1]', () => {
    for (let i = 0; i < 500; i++) {
      const n = valueNoise2P((i * 0.0137) % 1, (i * 0.0913) % 1, 9, 4, 7)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(1)
    }
  })

  it('worley f2 is never less than f1', () => {
    for (let i = 0; i < 300; i++) {
      const w = worley2P((i * 0.031) % 1, (i * 0.071) % 1, 11, 11, 3)
      expect(w.f2).toBeGreaterThanOrEqual(w.f1)
    }
  })
})

describe('material library', () => {
  it('measures each pattern\'s detail mean rather than assuming 0.5', () => {
    // The alpha-tested atlases are the reason this is measured. Their `detail` is near zero
    // across the empty part of every cell, so an assumed 0.5 would bias their burn-stage
    // albedo well below the published §7.6 values — invisibly.
    for (const m of packing.materials) {
      expect(m.params.detailMean, m.def.id).toBeGreaterThan(0)
      expect(m.params.detailMean, m.def.id).toBeLessThan(1)
      expect(m.params.detailMean, m.def.id).toBeCloseTo(patternDetailMean(m.params), 12)
    }
    const atlas = byId('foliage-needle').params.detailMean
    const bark = byId('bark-conifer-furrowed').params.detailMean
    expect(atlas).toBeLessThan(bark)
  })

  it('derives seeds from ids, stably and distinctly', () => {
    expect(seedForId('bark-conifer-furrowed')).toBe(seedForId('bark-conifer-furrowed'))
    const seeds = new Set(MATERIAL_RECIPES.map((r) => seedForId(r.id)))
    expect(seeds.size).toBe(MATERIAL_RECIPES.length)
  })

  it('packs layers contiguously from zero with exactly one owner each', () => {
    let expected = 0
    for (const m of packing.materials) {
      expect(m.baseLayer).toBe(expected)
      expect(m.def.layer).toBe(m.baseLayer)
      expect(m.layerCount).toBe(m.def.burnable ? 4 : 1)
      expected += m.layerCount
    }
    expect(packing.totalLayers).toBe(expected)
    expect(packing.layerOwners.length).toBe(packing.totalLayers)
  })

  it('has exactly one non-burnable material, which is why runs are variable-length', () => {
    const single = packing.materials.filter((m) => m.layerCount === 1)
    expect(single.map((m) => m.def.id)).toEqual(['ground-rock'])
  })

  it('is all dielectric — no material has non-zero metallic', () => {
    // Bark, leaves, soil and ash are dielectrics. A stray metallic would turn a tree black
    // under ambient light and read as a lighting bug rather than a material one.
    for (const m of packing.materials) {
      expect(m.def.metallicFactor, m.def.id).toBe(0)
      expect(m.params.metallic, m.def.id).toBe(0)
    }
  })

  it('rejects duplicate ids', () => {
    const dup = [MATERIAL_RECIPES[0] as (typeof MATERIAL_RECIPES)[number], MATERIAL_RECIPES[0] as (typeof MATERIAL_RECIPES)[number]]
    expect(() => packMaterials(dup)).toThrow(/duplicate/)
  })
})

describe('pattern sampling', () => {
  it('is deterministic for a given (material, stage, uv)', () => {
    const p = byId('bark-conifer-furrowed').params
    for (let i = 0; i < 50; i++) {
      const u = (i * 0.0193) % 1
      const v = (i * 0.0417) % 1
      const a = samplePattern(p, u, v, BURN_STAGE.Green)
      const b = samplePattern(p, u, v, BURN_STAGE.Green)
      expect(a.albedo).toEqual(b.albedo)
      expect(a.roughness).toBe(b.roughness)
      expect(a.alpha).toBe(b.alpha)
    }
  })

  it('keeps every channel in range for every material and stage', () => {
    for (const m of packing.materials) {
      for (let stage = 0; stage < m.layerCount; stage++) {
        for (let i = 0; i < 40; i++) {
          const s = samplePattern(m.params, (i * 0.0271) % 1, (i * 0.0631) % 1, stage as BurnStage)
          for (const c of s.albedo) {
            expect(Number.isFinite(c), `${m.def.id} stage ${stage} albedo`).toBe(true)
            expect(c).toBeGreaterThanOrEqual(0)
            expect(c).toBeLessThanOrEqual(1.5)
          }
          expect(s.roughness).toBeGreaterThanOrEqual(0)
          expect(s.roughness).toBeLessThanOrEqual(1)
          expect(s.occlusion).toBeGreaterThanOrEqual(0)
          expect(s.occlusion).toBeLessThanOrEqual(1)
          expect(s.alpha).toBeGreaterThanOrEqual(0)
          expect(s.alpha).toBeLessThanOrEqual(1)
          expect(s.detail).toBeGreaterThanOrEqual(0)
          expect(s.detail).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('tiles seamlessly in shade and in height', () => {
    for (const id of ['bark-conifer-furrowed', 'ground-soil', 'litter-needle', 'ground-rock']) {
      const p = byId(id).params
      for (let i = 0; i < 12; i++) {
        const v = i / 12
        const a = samplePattern(p, 0, v, BURN_STAGE.Green)
        const b = samplePattern(p, 1, v, BURN_STAGE.Green)
        expect(a.albedo[0], `${id} albedo seam`).toBeCloseTo(b.albedo[0] as number, 10)
        expect(patternHeight(p, 0, v, BURN_STAGE.Green), `${id} height seam`).toBeCloseTo(
          patternHeight(p, 1, v, BURN_STAGE.Green),
          10,
        )
      }
    }
  })

  it('gives alpha-tested materials real coverage variation and opaque ones alpha 1', () => {
    for (const m of packing.materials) {
      let min = 1
      let max = 0
      for (let i = 0; i < 400; i++) {
        const a = samplePattern(m.params, (i * 0.0173) % 1, (i * 0.0291) % 1, BURN_STAGE.Green).alpha
        min = Math.min(min, a)
        max = Math.max(max, a)
      }
      if (m.def.alphaTest) {
        expect(min, `${m.def.id} min alpha`).toBeLessThan(0.05)
        expect(max, `${m.def.id} max alpha`).toBeGreaterThan(0.9)
      } else {
        expect(min, `${m.def.id} alpha`).toBe(1)
      }
    }
  })
})

describe('burn stages reproduce the spec §7.6 targets', () => {
  // Baked at low resolution: the assertion is on the MEAN of a layer, and the mean converges
  // long before the texture is detailed enough to look at.
  const SIZE = 64

  it('foliage lands on the published scorch, char and ash colours', () => {
    // foliage-needle has burnResponse [1,1,1], so its stage means must land ON the published
    // values. This is the assertion that anchors M4's whole burn visual.
    const p = byId('foliage-needle').params
    for (const stage of [BURN_STAGE.Scorch, BURN_STAGE.Char, BURN_STAGE.Ash] as const) {
      const baked = bakeLayerBase(p, stage, SIZE, 1)
      const mean = meanLinearAlbedo(baked.albedo)
      const target = BURN_TARGETS[stage]
      for (let c = 0; c < 3; c++) {
        expect(mean[c] as number, `stage ${stage} channel ${c}`).toBeCloseTo(
          target.albedo[c] as number,
          2,
        )
      }
      const roughMean = meanChannel(baked.orm, 1)
      expect(roughMean, `stage ${stage} roughness`).toBeCloseTo(target.roughness, 1)
    }
  })

  it('char is darker than scorch and ash is much lighter than both', () => {
    // The monotone perceptual story of §7.6: green -> browner -> nearly black -> pale grey.
    const p = byId('foliage-broadleaf').params
    const lum = (stage: BurnStage): number => {
      const m = meanLinearAlbedo(bakeLayerBase(p, stage, SIZE, 1).albedo)
      return 0.2126 * (m[0] as number) + 0.7152 * (m[1] as number) + 0.0722 * (m[2] as number)
    }
    const green = lum(BURN_STAGE.Green)
    const scorch = lum(BURN_STAGE.Scorch)
    const char = lum(BURN_STAGE.Char)
    const ash = lum(BURN_STAGE.Ash)
    expect(scorch).toBeLessThan(green)
    expect(char).toBeLessThan(scorch)
    expect(ash).toBeGreaterThan(green * 3)
  })

  it('roughens live vegetation monotonically as it burns', () => {
    // Restricted to the materials whose green roughness is BELOW the §7.6 scorch figure of
    // 0.68 — foliage and grass. Litter and duff are already rougher than that when green, so
    // for them the scorch stage correctly moves roughness DOWN. Asserting monotonicity across
    // the whole library would be asserting something that is not true and not desirable.
    for (const id of ['foliage-needle', 'foliage-broadleaf', 'foliage-sclerophyll', 'grass-blade']) {
      const p = byId(id).params
      expect(p.baseRoughness, `${id} precondition`).toBeLessThan(BURN_TARGETS[1].roughness)
      let previous = -1
      for (const stage of [0, 1, 2, 3] as const) {
        const r = meanChannel(bakeLayerBase(p, stage, 32, 1).orm, 1)
        expect(r, `${id} stage ${stage}`).toBeGreaterThan(previous)
        previous = r
      }
    }
  })

  it('drives every burnable material toward the ash roughness of 0.96', () => {
    // The claim that IS true library-wide: fully consumed material is powder, and powder is
    // the roughest thing in the set whatever it started as.
    for (const m of packing.materials) {
      if (!m.def.burnable) continue
      const green = meanChannel(bakeLayerBase(m.params, 0, 32, 1).orm, 1)
      const ash = meanChannel(bakeLayerBase(m.params, 3, 32, 1).orm, 1)
      expect(ash, `${m.def.id}`).toBeGreaterThan(green)
      expect(ash, `${m.def.id}`).toBeGreaterThan(0.85)
    }
  })

  it('bark responds less at the scorch stage than foliage does', () => {
    // burnResponse encodes that bark is already brown. The test asserts the intent rather
    // than the number, so retuning the appearance does not break it.
    const bark = byId('bark-conifer-furrowed').recipe.pattern.burnResponse[0] as number
    const foliage = byId('foliage-needle').recipe.pattern.burnResponse[0] as number
    expect(bark).toBeLessThan(foliage)
  })

  it('is deterministic: the same bake twice is byte-identical', () => {
    const p = byId('ground-duff').params
    const a = bakeLayerBase(p, BURN_STAGE.Char, 32, 2)
    const b = bakeLayerBase(p, BURN_STAGE.Char, 32, 2)
    expect(Array.from(a.albedo.data)).toEqual(Array.from(b.albedo.data))
    expect(Array.from(a.normal.data)).toEqual(Array.from(b.normal.data))
    expect(Array.from(a.orm.data)).toEqual(Array.from(b.orm.data))
  })

  it('generates a non-degenerate normal map', () => {
    // A flat 128,128 normal map everywhere would mean the height field is not reaching the
    // normal computation at all — which type-checks perfectly and renders as plastic.
    const baked = bakeLayerBase(byId('bark-conifer-furrowed').params, BURN_STAGE.Green, 64, 1)
    let offFlat = 0
    for (let i = 0; i < 64 * 64; i++) {
      const nx = baked.normal.data[i * 4] as number
      const ny = baked.normal.data[i * 4 + 1] as number
      if (Math.abs(nx - 128) > 4 || Math.abs(ny - 128) > 4) offFlat++
    }
    expect(offFlat / (64 * 64)).toBeGreaterThan(0.3)
  })
})

describe('alligator crack field (§7.6)', () => {
  it('is a distance field in [0,1] that tiles', () => {
    for (let i = 0; i < 32; i++) {
      const v = i / 32
      const [d] = crackField(0.37, v, 24, 5)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(1)
      expect(crackField(0, v, 24, 5)[0]).toBeCloseTo(crackField(1, v, 24, 5)[0], 10)
    }
  })

  it('opens cracks as char increases, and has none at char 0', () => {
    // m_crack is 1 on the intact plate and 0 in the crack floor. At c = 0 the smoothstep
    // edges coincide and everything above D = 0.5 must read as intact.
    expect(crackMask(0.6, 0)).toBe(1)
    expect(crackMask(0.2, 0)).toBe(0)
    // As char grows the mask's lower edge drops, so a mid-distance texel goes from open
    // toward intact... the OPEN region (1 - m) grows at the low-D end.
    const openAt = (c: number): number => 1 - crackMask(0.2, c)
    expect(openAt(1)).toBeLessThan(openAt(0))
    // The width of the transition band grows with char: that is the crack opening.
    expect(crackMask(0.3, 1)).toBeGreaterThan(crackMask(0.3, 0))
  })

  it('reaches 3 mm depth at full char and zero at none', () => {
    expect(crackDepthM(0)).toBe(0)
    expect(crackDepthM(1)).toBeCloseTo(0.003, 12)
    expect(crackDepthM(0.5)).toBeCloseTo(0.0015, 12)
  })

  it('round-trips the packed gradient', () => {
    for (const g of [-100, -10, 0, 10, 100]) {
      const encoded = g * CRACK_GRADIENT_SCALE * 0.5 + 0.5
      expect(decodeCrackGradient(encoded)).toBeCloseTo(g, 6)
    }
  })
})
