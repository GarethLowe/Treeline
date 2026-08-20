/**
 * WGSL module assembly.
 *
 * WGSL has no include mechanism, so the modules are concatenated here: the generated constant
 * prelude, then the shared structs and helpers, then the bindings and entry points for the
 * particular pipeline. Doing it in TypeScript rather than duplicating declarations across
 * .wgsl files means the structs exist once and the constants exist zero times — they are
 * generated from `layout.ts` and `config.ts`.
 *
 * `enable` directives must precede every other declaration in a WGSL module, so they are
 * emitted first and never inside an included fragment.
 */

import common from '../../../shaders/foliage/common.wgsl?raw'
import frameBindings from '../../../shaders/foliage/frameBindings.wgsl?raw'
import occlusionSample from '../../../shaders/render/shadow/sample.wgsl?raw'
import burnShade from '../../../shaders/foliage/burnShade.wgsl?raw'
import burnState from '../../../shaders/foliage/burnState.wgsl?raw'
import cullBindings from '../../../shaders/foliage/cullBindings.wgsl?raw'
import cull from '../../../shaders/foliage/cull.wgsl?raw'
import scanCommon from '../../../shaders/foliage/scanCommon.wgsl?raw'
import scanSubgroup from '../../../shaders/foliage/scanSubgroup.wgsl?raw'
import scanWorkgroup from '../../../shaders/foliage/scanWorkgroup.wgsl?raw'
import scatter from '../../../shaders/foliage/scatter.wgsl?raw'
import materialBindings from '../../../shaders/foliage/materialBindings.wgsl?raw'
import treeDraw from '../../../shaders/foliage/treeDraw.wgsl?raw'
import grassCull from '../../../shaders/foliage/grassCull.wgsl?raw'
import grassDraw from '../../../shaders/foliage/grassDraw.wgsl?raw'
import { foliagePrelude, type PreludeOptions } from './shaderPrelude.ts'

export interface FoliageShaderSources {
  /** classify + scan + scatter, three entry points over one bind group layout. */
  readonly compute: string
  readonly treeDraw: string
  readonly grassCull: string
  readonly grassDraw: string
  /** Per-instance burn memory. One compute entry point, its own bind group. */
  readonly burnState: string
}

export const COMPUTE_ENTRY_CLASSIFY = 'classify'
export const COMPUTE_ENTRY_SCAN = 'scan'
export const COMPUTE_ENTRY_SCATTER = 'scatter'
export const GRASS_ENTRY_CULL = 'cullTiles'
export const GRASS_ENTRY_ARGS = 'writeArgs'
export const TREE_VS = 'vsTree'
export const TREE_FS = 'fsTree'
export const GRASS_VS = 'vsGrass'
export const GRASS_FS = 'fsGrass'

export function buildFoliageShaders(opts: PreludeOptions): FoliageShaderSources {
  const prelude = foliagePrelude(opts)
  const directives = opts.useSubgroups ? 'enable subgroups;\n' : ''
  const scan = opts.useSubgroups ? scanSubgroup : scanWorkgroup
  const join = (...parts: string[]): string => parts.join('\n')

  return {
    compute: directives + join(prelude, common, frameBindings, cullBindings, cull, scanCommon, scan, scatter),
    treeDraw: join(prelude, common, occlusionSample, frameBindings, materialBindings, burnShade, treeDraw),
    grassCull: join(prelude, common, frameBindings, grassCull),
    grassDraw: join(prelude, common, occlusionSample, frameBindings, materialBindings, burnShade, grassDraw),
    burnState: join(prelude, common, burnState),
  }
}
