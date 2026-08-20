/**
 * WGSL / TypeScript agreement. WP 1.6.
 *
 * A binding index mismatch between a pipeline layout and its shader is a runtime WebGPU
 * validation error, discovered in a browser, with a message that names a number rather than a
 * resource. Parsing the emitted WGSL and comparing it against the bind group layout this
 * package hands out turns that into a CLI failure with a name attached.
 *
 * The same idea covers the other CPU/GPU mirrors in this package: the constants that must
 * match across the language boundary are asserted here rather than trusted.
 */

import { describe, expect, it } from 'vitest'
import {
  CRACK_WGSL,
  GENERATE_WGSL,
  MIPDOWN_WGSL,
  WGSL_SOURCES,
  materialWgsl,
  parseBindings,
} from '../../../src/render/materials/shaders.ts'
import { MAX_MATERIALS } from '../../../src/render/materials/arrays.ts'
import { CRACK_GRADIENT_SCALE, BURN_TARGETS } from '../../../src/render/materials/patterns.ts'
import { SPLAT_SLOPE } from '../../../src/render/materials/splat.ts'
import { CHAR_EMISSIVITY, EMBER_MIN_TEMP_K, STEFAN_BOLTZMANN } from '../../../src/render/materials/burn.ts'
import { GEN_PARAMS_BYTES, MIP_MODE } from '../../../src/render/materials/gpuGenerator.ts'

/**
 * The material bind group layout, restated as (binding, kind) pairs.
 *
 * Deliberately a literal rather than a read of `bindGroupLayout`: a `GPUBindGroupLayout` is
 * opaque, and constructing one needs a device. This is the declaration the WGSL is checked
 * against, and it is the same list `materialSystem.ts` builds.
 */
const EXPECTED_MATERIAL_BINDINGS = [
  { binding: 0, name: 'matAlbedo', type: /texture_2d_array<f32>/ },
  { binding: 1, name: 'matNormal', type: /texture_2d_array<f32>/ },
  { binding: 2, name: 'matOrm', type: /texture_2d_array<f32>/ },
  { binding: 3, name: 'matCrack', type: /texture_2d<f32>/ },
  { binding: 4, name: 'matSampler', type: /sampler/ },
  { binding: 5, name: 'matTable', type: /MaterialTable/ },
] as const

describe('material bind group', () => {
  it('declares exactly the bindings the TypeScript layout creates, in order', () => {
    const src = materialWgsl({ materialGroup: 1 })
    const bindings = parseBindings(src).filter((b) => b.group === 1)
    expect(bindings).toHaveLength(EXPECTED_MATERIAL_BINDINGS.length)
    EXPECTED_MATERIAL_BINDINGS.forEach((expected, i) => {
      const actual = bindings[i]
      expect(actual, `binding ${expected.binding}`).toBeDefined()
      expect(actual?.binding).toBe(expected.binding)
      expect(actual?.name).toBe(expected.name)
      expect(actual?.declaration).toMatch(expected.type)
    })
  })

  it('substitutes the requested group index everywhere', () => {
    for (const group of [0, 1, 2, 3]) {
      const src = materialWgsl({ materialGroup: group, burnGroup: (group + 1) % 4 })
      expect(src).not.toContain('__MAT_GROUP__')
      expect(src).not.toContain('__BURN_GROUP__')
      for (const b of parseBindings(src)) {
        expect(b.group).toBe(group)
      }
    }
  })

  it('rejects group indices outside the maxBindGroups of 4', () => {
    expect(() => materialWgsl({ materialGroup: 4 })).toThrow(/0\.\.3/)
    expect(() => materialWgsl({ materialGroup: -1 })).toThrow(/0\.\.3/)
    expect(() => materialWgsl({ materialGroup: 1, burnGroup: 1 })).toThrow(/must differ/)
    expect(() => materialWgsl({ materialGroup: 1, burnGroup: 9 })).toThrow(/0\.\.3/)
  })

  it('exposes the sampling entry points other packages call', () => {
    const src = materialWgsl({ materialGroup: 1 })
    for (const fn of [
      'fn materialSample(',
      'fn materialSampleGrad(',
      'fn materialSampleLod(',
      'fn materialAlphaTestFails(',
      'fn materialWorldUV(',
      'fn burnStateUnburnt(',
      'fn burnCoordinate(',
      'fn unpackBurnState(',
      'fn crackMask(',
      'fn emberRadiance(',
    ]) {
      expect(src, fn).toContain(fn)
    }
  })

  it('adds the splat functions only when asked', () => {
    expect(materialWgsl({ materialGroup: 1 })).not.toContain('fn terrainSplat(')
    const withSplat = materialWgsl({ materialGroup: 1, includeSplat: true })
    expect(withSplat).toContain('fn terrainSplat(')
    expect(withSplat).toContain('fn splatWeights(')
  })

  it('never declares an -srgb storage format, which does not exist in WebGPU', () => {
    for (const [name, src] of Object.entries(WGSL_SOURCES)) {
      expect(src, name).not.toMatch(/texture_storage_2d(_array)?<[a-z0-9]*srgb/)
    }
  })
})

describe('generation modules', () => {
  it('declare their compute entry points', () => {
    expect(GENERATE_WGSL).toContain('fn generateLayer(')
    expect(GENERATE_WGSL).toContain('@compute @workgroup_size(8, 8, 1)')
    expect(MIPDOWN_WGSL).toContain('fn mipDown(')
    expect(CRACK_WGSL).toContain('fn generateCrack(')
  })

  it('bind their storage textures as write-only rgba8unorm arrays', () => {
    const bindings = parseBindings(GENERATE_WGSL)
    const storage = bindings.filter((b) => /texture_storage/.test(b.declaration))
    expect(storage).toHaveLength(3)
    for (const b of storage) {
      expect(b.declaration).toContain('texture_storage_2d_array<rgba8unorm, write>')
    }
  })

  it('includes the noise and pattern chunks it depends on', () => {
    // Concatenation is the only include mechanism WGSL has, so a missing chunk is a
    // "unresolved identifier" at pipeline creation rather than at build time.
    expect(GENERATE_WGSL).toContain('fn hashU32(')
    expect(GENERATE_WGSL).toContain('fn samplePattern(')
    expect(CRACK_WGSL).toContain('fn crackDistance(')
    expect(MIPDOWN_WGSL).toContain('fn clamp01f(')
  })

  it('agrees with TypeScript on the mip modes', () => {
    expect(MIPDOWN_WGSL).toContain(`const MIP_MODE_LINEAR: u32 = ${MIP_MODE.Linear}u`)
    expect(MIPDOWN_WGSL).toContain(`const MIP_MODE_SRGB: u32 = ${MIP_MODE.Srgb}u`)
    expect(MIPDOWN_WGSL).toContain(`const MIP_MODE_NORMAL: u32 = ${MIP_MODE.Normal}u`)
  })
})

describe('constants that must match across the language boundary', () => {
  it('agrees on the crack gradient scale', () => {
    expect(WGSL_SOURCES.crack).toContain(`const CRACK_GRAD_SCALE: f32 = ${CRACK_GRADIENT_SCALE};`)
    expect(WGSL_SOURCES.materialSample).toContain(
      `const CRACK_GRAD_SCALE_INV: f32 = 1.0 / ${CRACK_GRADIENT_SCALE};`,
    )
  })

  it('agrees on the ember constants', () => {
    expect(WGSL_SOURCES.materialSample).toContain(`const STEFAN_BOLTZMANN: f32 = ${STEFAN_BOLTZMANN};`)
    expect(WGSL_SOURCES.materialSample).toContain(`const CHAR_EMISSIVITY: f32 = ${CHAR_EMISSIVITY.toFixed(2)};`)
    expect(WGSL_SOURCES.materialSample).toContain(`const EMBER_MIN_TEMP_K: f32 = ${EMBER_MIN_TEMP_K.toFixed(1)};`)
  })

  it('agrees on the spec §7.6 burn targets', () => {
    // The shader carries the same four rows the TypeScript does. If either drifts, a material
    // generated on the GPU and one baked on the CPU stop matching, and the comparison test
    // between them becomes meaningless.
    for (const t of BURN_TARGETS.slice(1)) {
      const row = `vec4<f32>(${t.albedo[0]}, ${t.albedo[1]}, ${t.albedo[2]}, ${t.roughness})`
      expect(WGSL_SOURCES.patterns, row).toContain(row)
    }
  })

  it('agrees on the splat slope thresholds', () => {
    expect(WGSL_SOURCES.splat).toContain(`const SPLAT_ROCK_ONSET: f32 = ${SPLAT_SLOPE.rockOnset};`)
    expect(WGSL_SOURCES.splat).toContain(
      `const SPLAT_LITTER_SHED_START: f32 = ${SPLAT_SLOPE.litterShedStart};`,
    )
    expect(WGSL_SOURCES.splat).toContain(`const SPLAT_LITTER_SHED_END: f32 = ${SPLAT_SLOPE.litterShedEnd};`)
    expect(WGSL_SOURCES.splat).toContain(`const SPLAT_DRY_START: f32 = ${SPLAT_SLOPE.dryStart};`)
    expect(WGSL_SOURCES.splat).toContain(`const SPLAT_DRY_END: f32 = ${SPLAT_SLOPE.dryEnd};`)
  })

  it('agrees on the material table array length', () => {
    expect(WGSL_SOURCES.materialSample).toContain(`array<MaterialEntry, ${MAX_MATERIALS}>`)
  })

  it('keeps the Pattern uniform struct at the declared size', () => {
    // Eight vec4s of 16 bytes. If a member is added, GEN_PARAMS_BYTES must move with it or
    // the dynamic offset reads into the next record.
    const struct = WGSL_SOURCES.patterns.slice(
      WGSL_SOURCES.patterns.indexOf('struct Pattern {'),
    )
    const body = struct.slice(0, struct.indexOf('}'))
    const members = body.split('\n').filter((l) => /:\s*vec4</.test(l))
    expect(members).toHaveLength(GEN_PARAMS_BYTES / 16)
  })
})

describe('WGSL hygiene', () => {
  it('has balanced braces and parentheses in every chunk', () => {
    for (const [name, src] of Object.entries(WGSL_SOURCES)) {
      // Comments can contain unbalanced punctuation; strip them first.
      const code = src.replace(/\/\/[^\n]*/g, '')
      const count = (re: RegExp): number => (code.match(re) ?? []).length
      expect(count(/\{/g), `${name} braces`).toBe(count(/\}/g))
      expect(count(/\(/g), `${name} parens`).toBe(count(/\)/g))
    }
  })

  it('uses no WGSL reserved words as identifiers in the burn struct', () => {
    // `char` is reserved; the struct member is `charFrac` for that reason alone, and losing
    // that detail is a compile error found only in a browser.
    expect(WGSL_SOURCES.materialSample).toContain('charFrac : f32')
    expect(WGSL_SOURCES.materialSample).not.toMatch(/\bchar\s*:\s*f32/)
  })
})
