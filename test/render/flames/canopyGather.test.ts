/**
 * The crown-flame gather reaches across a package boundary, and both sides of it are invisible
 * to the compiler.
 *
 * `csGatherCanopy` reads M3's voxel pool directly to find burning canopy, so it depends on two
 * things that live in TypeScript: the phase code the solver writes for a flaming voxel, and
 * the byte stride of the billboard struct the two gathers share. WGSL never reaches a compiler
 * under Node, and a WebGPU pipeline built against a mismatched layout does not throw — it
 * returns an invalid pipeline, drops every dispatch that uses it, and leaves a canopy that
 * burns in the solver and renders nothing. That is the exact failure this file exists to catch,
 * and it is the failure the whole of M3 shipped with for a different reason.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PHASE_FLAMING } from '@sim/canopy/storage/store.ts'
import { canopyStorageWgsl } from '@sim/canopy/storage/shaders.ts'
import { CANOPY_N_XY } from '@contracts/sim'

const flamesWgsl = readFileSync(
  fileURLToPath(new URL('../../../shaders/render/flames/flames.wgsl', import.meta.url)),
  'utf8',
)

describe('the crown-flame gather agrees with the canopy store it reads', () => {
  it('declares the entry point exactly once', () => {
    expect(flamesWgsl.match(/fn csGatherCanopy/g)?.length).toBe(1)
  })

  it('tests against the phase code the solver actually writes', () => {
    // The shader compares against CANOPY_PHASE_FLAMING, which flameRenderer.ts emits from
    // `PHASE_FLAMING`. If the constant is ever inlined into the WGSL as a literal instead,
    // this fails — a second copy of a phase code is how a gather silently matches nothing.
    expect(flamesWgsl).toContain('CANOPY_PHASE_FLAMING')
    expect(flamesWgsl).not.toMatch(/canopy_phase\([^)]*\)\s*[!=]=\s*\d+u/)
    expect(PHASE_FLAMING).toBe(3)
  })

  it('reads the pool through the store prelude rather than redeclaring its bindings', () => {
    // Every canopy accessor the gather uses must come from the generated prelude. A local
    // `@group(3) @binding(2) var<storage...>` here would compile and read the right buffer
    // right up until the pool layout changed underneath it.
    expect(flamesWgsl).not.toMatch(/var<storage[^>]*>\s*canopy/)
    const prelude = canopyStorageWgsl(3)
    for (const fn of ['canopy_phase', 'canopy_voxel_centre', 'canopyColumns']) {
      expect(prelude, `${fn} is not in the prelude the renderer prepends`).toContain(fn)
      expect(flamesWgsl, `${fn} is not used by the gather`).toContain(fn)
    }
  })

  it('unpacks the column header the way the layout packs it', () => {
    // zStart in the low byte, zCount above it — `packHeader` in storage/layout.ts. Swapping
    // them reads a run length as a start height and finds flaming voxels nowhere.
    expect(flamesWgsl).toContain('col.header & CANOPY_Z_MASK')
    expect(flamesWgsl).toContain('(col.header >> CANOPY_ZCOUNT_SHIFT) & CANOPY_Z_MASK')
  })

  it('dispatches over every column of the grid', () => {
    // One thread per column, 8x8 workgroups. If CANOPY_N_XY stops being a multiple of 8 the
    // renderer's `Math.ceil` still covers it, but the shader's own bound must be the one that
    // rejects the overshoot.
    expect(flamesWgsl).toContain('gid.x >= CANOPY_NXY')
    expect(flamesWgsl).toContain('gid.y >= CANOPY_NXY')
    expect(CANOPY_N_XY % 8).toBe(0)
  })
})

describe('the billboard struct is one layout on both sides', () => {
  it('the TypeScript stride matches the WGSL struct', async () => {
    const struct = /struct FlameInstance \{([\s\S]*?)\n\};/.exec(flamesWgsl)
    expect(struct, 'FlameInstance no longer has the expected shape').not.toBeNull()
    const fields = (struct?.[1] ?? '').match(/^\s*\w+\s*:\s*vec4<f32>,/gm) ?? []
    expect(fields.length, 'expected vec4 fields only').toBeGreaterThan(0)
    // Importing the renderer pulls in `?raw` shader imports, which only Vite resolves, so the
    // stride is asserted against the module's own constant via a dynamic import guarded by
    // the same alias config the app uses.
    const { INSTANCE_BYTES_FOR_TEST } = await import('@render/flames/flameRenderer.ts')
    expect(INSTANCE_BYTES_FOR_TEST).toBe(fields.length * 16)
  })

  it('both gathers write every field, so no billboard is drawn with a stale base', () => {
    // `packed2.x` carries the base Y. A gather that appends without setting it inherits
    // whatever the previous frame left in that slot and plants the flame at the wrong height.
    const surface = flamesWgsl.slice(flamesWgsl.indexOf('fn csGather('))
    const canopy = flamesWgsl.slice(flamesWgsl.indexOf('fn csGatherCanopy'))
    for (const [name, body] of [
      ['csGather', surface.slice(0, surface.indexOf('fn csGatherCanopy'))],
      ['csGatherCanopy', canopy],
    ] as const) {
      expect(body, `${name} does not write packed`).toContain('.packed =')
      expect(body, `${name} does not write packed2`).toContain('.packed2 =')
    }
  })
})
