/**
 * WGSL source assembly. WP 1.6.
 *
 * WGSL has no include mechanism, so composition is string concatenation done here rather than
 * copy-paste done in seven places. The `?raw` imports keep the shaders in real `.wgsl` files
 * with editor tooling and syntax highlighting, which is why `vite.config.ts` lists
 * `assetsInclude: ['**\/*.wgsl']`.
 *
 * ## For other packages
 *
 * `materialWgsl(matGroup, burnGroup)` returns the material bind group declarations and the
 * sampling interface, ready to prepend to a consumer shader. The group indices are parameters
 * rather than baked constants specifically so this package does not have to win an argument
 * with the foliage or terrain passes about who owns `@group(1)`.
 *
 * Substituting `@group(N)` textually looks crude next to a real module system. It is also the
 * only mechanism WebGPU offers today, and it has one real virtue: the TypeScript bind group
 * layout and the WGSL declarations can be cross-checked by parsing the emitted source, which
 * `test/render/materials/bindings.test.ts` does. A binding-index mismatch between a pipeline
 * layout and its shader is otherwise a runtime validation error discovered in a browser.
 */

import noiseSrc from '../../../shaders/materials/noise.wgsl?raw'
import patternsSrc from '../../../shaders/materials/patterns.wgsl?raw'
import generateSrc from '../../../shaders/materials/generate.wgsl?raw'
import mipdownSrc from '../../../shaders/materials/mipdown.wgsl?raw'
import crackSrc from '../../../shaders/materials/crack.wgsl?raw'
import materialSampleSrc from '../../../shaders/materials/material_sample.wgsl?raw'
import splatSrc from '../../../shaders/materials/splat.wgsl?raw'

/** Raw chunks, exported for the tests that parse them. */
export const WGSL_SOURCES = {
  noise: noiseSrc,
  patterns: patternsSrc,
  generate: generateSrc,
  mipdown: mipdownSrc,
  crack: crackSrc,
  materialSample: materialSampleSrc,
  splat: splatSrc,
} as const

const join = (...parts: string[]): string => parts.join('\n\n')

/** Compute module that synthesises one array layer. Entry point `generateLayer`. */
export const GENERATE_WGSL: string = join(noiseSrc, patternsSrc, generateSrc)

/** Compute module that reduces one mip level to the next. Entry point `mipDown`. */
export const MIPDOWN_WGSL: string = join(noiseSrc, mipdownSrc)

/** Compute module that synthesises the shared crack field. Entry point `generateCrack`. */
export const CRACK_WGSL: string = join(noiseSrc, patternsSrc, crackSrc)

/** Placeholders substituted by `materialWgsl`. */
const MAT_GROUP_TOKEN = '__MAT_GROUP__'
const BURN_GROUP_TOKEN = '__BURN_GROUP__'

export interface MaterialWgslOptions {
  /** Bind group index the material group is bound at. */
  readonly materialGroup: number
  /** Bind group index the per-instance burn state is bound at. Defaults to `materialGroup+1`. */
  readonly burnGroup?: number
  /** Append the terrain splat functions. Fragment stage only — they use `dpdx`/`dpdy`. */
  readonly includeSplat?: boolean
}

/**
 * The chunk consumer shaders prepend.
 *
 * Depends on `noise.wgsl` for `clamp01f` and `smoothstepSafe`, so that is included; it is
 * ~150 lines of integer hashing that the compiler dead-strips if the consumer never calls it.
 */
export function materialWgsl(options: MaterialWgslOptions): string {
  const mat = options.materialGroup
  const burn = options.burnGroup ?? options.materialGroup + 1
  if (!Number.isInteger(mat) || mat < 0 || mat > 3) {
    // maxBindGroups is 4 (spec §10 §6.9 item 10). A group index outside 0..3 fails at
    // pipeline creation with a message that does not mention materials.
    throw new Error(`materialGroup must be an integer in 0..3, got ${mat}`)
  }
  if (!Number.isInteger(burn) || burn < 0 || burn > 3) {
    throw new Error(`burnGroup must be an integer in 0..3, got ${burn}`)
  }
  if (burn === mat) {
    throw new Error('burnGroup must differ from materialGroup')
  }
  const parts = [noiseSrc, materialSampleSrc]
  if (options.includeSplat) parts.push(splatSrc)
  return join(...parts)
    .split(MAT_GROUP_TOKEN)
    .join(String(mat))
    .split(BURN_GROUP_TOKEN)
    .join(String(burn))
}

/**
 * Parse `@group(N) @binding(M) var ... name : type;` declarations out of WGSL.
 *
 * Used by the binding cross-check test. Deliberately a small regex rather than a real parser:
 * it only has to understand the handful of declaration forms this package emits, and a real
 * WGSL parser is a dependency this project does not take.
 */
export interface ParsedBinding {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly declaration: string
}

export function parseBindings(source: string): ParsedBinding[] {
  const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(<[^>]*>)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/g
  const out: ParsedBinding[] = []
  for (const m of source.matchAll(re)) {
    out.push({
      group: Number(m[1]),
      binding: Number(m[2]),
      name: m[4] as string,
      declaration: `var${m[3] ?? ''} ${m[4]} : ${(m[5] as string).trim()}`,
    })
  }
  return out
}
