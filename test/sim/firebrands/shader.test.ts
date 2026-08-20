/**
 * Drift guard between `brands.ts` (the CPU oracle, where the physics is proven) and
 * `firebrands.wgsl` (what actually runs). Nothing here needs a GPU.
 *
 * The failure this prevents is specific and nasty: the oracle stays right, the tests stay green,
 * and the shader quietly burns brands at a different rate because someone edited one constant.
 * It also pins the two structural claims the work package makes — two dispatches, and an
 * explicitly clamped indirect count.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AIR_DENSITY,
  AIR_VISCOSITY,
  BRAND_BULK_DENSITY,
  CHI_MOISTURE_COEFF,
  GLOW_MASS_FRACTION,
  GRAVITY,
} from '@sim/firebrands/brands.ts'
import { EMITTERS_PER_THREAD, INTEGRATE_WORKGROUP, SPAWN_WORKGROUP } from '@sim/firebrands/layout.ts'

const src = readFileSync(
  fileURLToPath(new URL('../../../shaders/sim/firebrands/firebrands.wgsl', import.meta.url)),
  'utf8',
)

const constant = (name: string): number => {
  const match = src.match(new RegExp(`const ${name} = ([0-9.eE+-]+)u?;`))
  if (!match?.[1]) throw new Error(`${name} not found in firebrands.wgsl`)
  return Number(match[1])
}

describe('WGSL constants mirror the CPU oracle', () => {
  it('carries the same physical constants', () => {
    expect(constant('GRAVITY')).toBe(GRAVITY)
    expect(constant('AIR_DENSITY')).toBe(AIR_DENSITY)
    expect(constant('AIR_VISCOSITY')).toBe(AIR_VISCOSITY)
    expect(constant('BULK_DENSITY')).toBe(BRAND_BULK_DENSITY)
    expect(constant('GLOW_MASS_FRACTION')).toBe(GLOW_MASS_FRACTION)
    expect(constant('CHI_MOISTURE_COEFF')).toBe(CHI_MOISTURE_COEFF)
  })

  it('carries the same dispatch geometry', () => {
    expect(constant('SPAWN_WG')).toBe(SPAWN_WORKGROUP)
    expect(constant('EMITTERS_PER_THREAD')).toBe(EMITTERS_PER_THREAD)
    expect(constant('INTEGRATE_WG')).toBe(INTEGRATE_WORKGROUP)
  })

  it('uses the same integer hash, so spawning is reproducible on both sides', () => {
    // The three PCG constants. A mismatch would give the shader a different brand-size
    // distribution from the one the tests validate, with no other symptom.
    for (const k of ['747796405u', '2891336453u', '277803737u']) expect(src).toContain(k)
  })
})

describe('structural claims of the pass', () => {
  it('is exactly two compute entry points', () => {
    const entries = src.match(/@compute/g) ?? []
    expect(entries.length).toBe(2)
    expect(src).toContain('fn spawn_step')
    expect(src).toContain('fn integrate')
  })

  it('clamps the indirect workgroup count explicitly', () => {
    // WebGPU §16.1.2: an over-large indirect count silently skips the whole dispatch. This is
    // the acceptance item, so it is asserted on the text rather than trusted to review.
    expect(src).toMatch(/indirectArgs\[0\] = min\(wg, max\(params\.maxWorkgroups, 1u\)\)/)
    expect(src).toMatch(/let slots = min\(atomicLoad\(&state\.highWater\), params\.poolSize\)/)
  })

  it('allocates slots without atomics', () => {
    // §4.2: a global atomic counter serialises AND makes the result non-deterministic across
    // runs, which makes spot behaviour undebuggable. Allocation is prefix-sum + ring cursor;
    // the only atomics allowed are commutative stats and the ignition bitmask.
    const atomicOps = src.match(/atomic(Add|Or|Max|Store|Load)\(&(\w+)/g) ?? []
    expect(atomicOps.length).toBeGreaterThan(0)
    for (const op of atomicOps) {
      expect(op).toMatch(/&(state|ignitionMask)/)
    }
    expect(src).not.toContain('atomicCompareExchange')
    expect(src).not.toContain('freeList')
  })

  it('samples the brand-size distribution from the -2 power law inverse CDF', () => {
    expect(src).toContain('let area = 1.0 / (lo - u01 * (lo - hi));')
  })

  it('guards the brand array read against a stale indirect count', () => {
    expect(src).toMatch(/if \(i >= params\.poolSize \|\| i >= arrayLength\(&brands\)\)/)
  })
})
