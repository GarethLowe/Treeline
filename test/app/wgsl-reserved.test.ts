/**
 * Every `.wgsl` in the tree, checked against the WGSL reserved-word list.
 *
 * ## Why this exists
 *
 * Vitest runs under Node, which has no WebGPU, so no WGSL in this project ever reaches a
 * compiler during `npm test`. Four real bugs have shipped through a green suite that way and
 * **two of them were exactly this**: `target` and `layout` used as identifiers. A reserved
 * word is not a subtle failure — `createShaderModule` rejects the module, the pipeline throws
 * and the feature is simply absent — but it is invisible to every test we can run.
 *
 * Integrating M2 turned up a third: `var active = false` in both tile-classify shaders, which
 * would have made `new SurfaceSolver(...)` throw and no fire run at all.
 *
 * This is a lexical check, not a parse. It cannot find a type error or a bad builtin; it can
 * only find the one failure mode that is both trivially detectable and has a 3-for-3 record
 * of reaching main.
 *
 * Source: W3C WGSL §2.3 "Reserved Words". Keywords proper (`fn`, `let`, `var`, …) are NOT in
 * here — using those as an identifier is a syntax error the author notices immediately.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RESERVED = new Set(
  `NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await
   become binding_array cast catch class co_await co_return co_yield coherent column_major
   common compile compile_fragment concept const_cast consteval constexpr constinit crate
   debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export
   extends extern external fallthrough filter final finally friend from fxgroup get goto
   groupshared highp impl implements import inline instanceof interface layout lowp macro
   macro_rules match mediump meta mod module move mutable namespace new nil noexcept noinline
   nointerpolation non_coherent noncoherent noperspective null nullptr of operator package
   packoffset partition pass patch pixelfragment precise precision premerge priv protected pub
   public readonly reference regardless register reinterpret_cast require resource restrict
   self set shared sizeof smooth snorm static static_assert static_cast std subroutine super
   target template this thread_local throw trait try type typedef typeid typename union unless
   unorm unsafe unsized use using varying virtual volatile wgsl where with writeonly yield`
    .split(/\s+/)
    .filter((w) => w.length > 0),
)

function wgslFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) wgslFiles(p, out)
    else if (name.endsWith('.wgsl')) out.push(p)
  }
  return out
}

/** Strip line and block comments, and string-ish content, so prose does not trip the check. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
}

describe('WGSL reserved words', () => {
  const files = wgslFiles('shaders')

  it('finds the shader tree', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files)('%s uses no reserved word as an identifier', (file) => {
    const found = new Set<string>()
    for (const token of code(readFileSync(file, 'utf8')).match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
      if (RESERVED.has(token)) found.add(token)
    }
    expect([...found]).toEqual([])
  })
})
