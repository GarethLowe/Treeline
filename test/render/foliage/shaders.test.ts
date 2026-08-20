import { describe, expect, it } from 'vitest'
import { buildFoliageShaders } from '@render/foliage/shaders'
import { foliagePrelude } from '@render/foliage/shaderPrelude'
import {
  CULL_WORKGROUP_SIZE,
  GRASS_VERTS_PER_BLADE,
  LOD_COUNT,
  MAX_BUCKETS,
  SCAN_WORKGROUP_SIZE,
} from '@render/foliage/config'
import { COMPACTED_INDEX_BITS, STATS_CLAMP_EVENTS } from '@render/foliage/layout'
import { DOMAIN_SIZE_M } from '@contracts/world'

/**
 * The WGSL cannot be compiled without a device, but the things that silently go wrong between
 * the two languages — a constant that drifted, a struct that exists twice, an `enable`
 * directive in the wrong place — are all visible in the assembled source. These assertions
 * cost nothing and catch exactly the class of bug that otherwise surfaces as a black screen.
 */
describe('shader prelude', () => {
  const prelude = foliagePrelude({ useSubgroups: true, ditherAlpha: true })

  it('emits the TypeScript constants, not copies of them', () => {
    expect(prelude).toContain(`const CULL_WG: u32 = ${CULL_WORKGROUP_SIZE}u;`)
    expect(prelude).toContain(`const SCAN_WG: u32 = ${SCAN_WORKGROUP_SIZE}u;`)
    expect(prelude).toContain(`const MAX_BUCKETS: u32 = ${MAX_BUCKETS}u;`)
    expect(prelude).toContain(`const LOD_COUNT: u32 = ${LOD_COUNT}u;`)
    expect(prelude).toContain(`const VERTS_PER_BLADE: u32 = ${GRASS_VERTS_PER_BLADE}u;`)
    expect(prelude).toContain(`const COMPACTED_INDEX_BITS: u32 = ${COMPACTED_INDEX_BITS}u;`)
    expect(prelude).toContain(`const STATS_CLAMP_EVENTS: u32 = ${STATS_CLAMP_EVENTS}u;`)
    expect(prelude).toContain(`const DOMAIN_SIZE_M: f32 = ${DOMAIN_SIZE_M}.0;`)
  })

  it('divides the bucket table evenly across the scan workgroup', () => {
    expect(MAX_BUCKETS % SCAN_WORKGROUP_SIZE).toBe(0)
    expect(prelude).toContain(
      `const BUCKETS_PER_SCAN_THREAD: u32 = ${MAX_BUCKETS / SCAN_WORKGROUP_SIZE}u;`,
    )
  })

  it('emits every float constant with a decimal point', () => {
    // `const X: f32 = 3;` is a type error in WGSL, and the failure is a shader that does not
    // compile at all — worth one regex.
    const floats = [...prelude.matchAll(/const \w+: f32 = ([^;]+);/g)].map((m) => m[1]!)
    expect(floats.length).toBeGreaterThan(0)
    for (const value of floats) expect(value).toMatch(/\./)
  })

  it('switches the code paths it is asked to', () => {
    expect(foliagePrelude({ useSubgroups: true, ditherAlpha: false })).toContain(
      'const USE_SUBGROUPS: bool = true;',
    )
    expect(foliagePrelude({ useSubgroups: false, ditherAlpha: false })).toContain(
      'const DITHER_ALPHA: bool = false;',
    )
  })
})

describe('shader assembly', () => {
  const withSubgroups = buildFoliageShaders({ useSubgroups: true, ditherAlpha: true })
  const withoutSubgroups = buildFoliageShaders({ useSubgroups: false, ditherAlpha: true })

  it('puts the enable directive first, and only when subgroups are used', () => {
    expect(withSubgroups.compute.startsWith('enable subgroups;')).toBe(true)
    expect(withoutSubgroups.compute).not.toContain('enable subgroups;')
  })

  it('selects exactly one scan implementation', () => {
    expect(withSubgroups.compute).toContain('subgroupExclusiveAdd')
    expect(withSubgroups.compute).not.toContain('var<workgroup> partials')
    expect(withoutSubgroups.compute).toContain('var<workgroup> partials')
    expect(withoutSubgroups.compute).not.toContain('subgroupExclusiveAdd')
  })

  it('declares each entry point exactly once per module', () => {
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1
    expect(count(withSubgroups.compute, 'fn classify(')).toBe(1)
    expect(count(withSubgroups.compute, 'fn scan(')).toBe(1)
    expect(count(withSubgroups.compute, 'fn scatter(')).toBe(1)
    expect(count(withSubgroups.treeDraw, 'fn vsTree(')).toBe(1)
    expect(count(withSubgroups.treeDraw, 'fn fsTree(')).toBe(1)
    expect(count(withSubgroups.grassCull, 'fn cullTiles(')).toBe(1)
    expect(count(withSubgroups.grassCull, 'fn writeArgs(')).toBe(1)
    expect(count(withSubgroups.grassDraw, 'fn vsGrass(')).toBe(1)
    expect(count(withSubgroups.grassDraw, 'fn fsGrass(')).toBe(1)
  })

  it('declares each shared struct exactly once per module', () => {
    for (const module of [
      withSubgroups.compute,
      withSubgroups.treeDraw,
      withSubgroups.grassCull,
      withSubgroups.grassDraw,
    ]) {
      for (const struct of ['struct TreeInstance', 'struct MeshEntry', 'struct FrameUniform']) {
        expect(module.split(struct).length - 1).toBe(1)
      }
    }
  })

  it('never binds a read_write storage buffer in a module with a vertex stage', () => {
    // WGSL forbids read_write storage in the vertex stage, and the failure mode is a pipeline
    // that will not create. The draw modules must only ever see read-only storage.
    for (const module of [withSubgroups.treeDraw, withSubgroups.grassDraw]) {
      expect(module).not.toContain('storage, read_write')
    }
  })

  it('keeps the compute module free of the material group it does not bind', () => {
    expect(withSubgroups.compute).not.toContain('@group(2)')
    expect(withSubgroups.grassCull).not.toContain('@group(2)')
    expect(withSubgroups.treeDraw).toContain('@group(2)')
  })

  it('reads the frame uniform from group 0 in every module', () => {
    for (const module of [
      withSubgroups.compute,
      withSubgroups.treeDraw,
      withSubgroups.grassCull,
      withSubgroups.grassDraw,
    ]) {
      expect(module).toContain('@group(0) @binding(0) var<uniform> frame: FrameUniform;')
    }
  })
})
