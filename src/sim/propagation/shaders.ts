/**
 * WGSL module assembly for the propagation pipeline.
 *
 * WGSL has no include mechanism, so the fragments are concatenated here. `enable` directives
 * must precede every other declaration in a module, so they are emitted first and never
 * inside an included fragment — and the subgroup entry point lives in its own file, because
 * a module that merely *mentions* a subgroup builtin fails to compile on a device without
 * the feature.
 */

import ellipse from '../../../shaders/sim/propagation/ellipse.wgsl?raw'
import propagation from '../../../shaders/sim/propagation/propagation.wgsl?raw'
import classifySubgroup from '../../../shaders/sim/propagation/classify_subgroup.wgsl?raw'
import classifyWorkgroup from '../../../shaders/sim/propagation/classify_workgroup.wgsl?raw'

export const ENTRY = {
  tick: 'tick',
  classifySubgroup: 'tileClassifySubgroup',
  classifyWorkgroup: 'tileClassifyWorkgroup',
  dispatchArgs: 'dispatchArgs',
  advance: 'advance',
  igniteClear: 'igniteClear',
  ignite: 'ignite',
  jfaSeed: 'jfaSeed',
  jfaFlood: 'jfaFlood',
  jfaResolve: 'jfaResolve',
} as const

export function buildPropagationShader(useSubgroups: boolean): string {
  const directives = useSubgroups ? 'enable subgroups;\n' : ''
  const classify = useSubgroups ? classifySubgroup : classifyWorkgroup
  return [directives + ellipse, propagation, classify].join('\n')
}
