/**
 * `burnShade.wgsl` computes char height from Byram flame length. So does
 * `sim/rothermel/kernel.ts`. This asserts they are the same relation.
 *
 * The project's whole failure history is two copies of one convention drifting apart — the
 * reversed-Z depth compare, the foliage culler's frustum planes, three different functions
 * named `hashU32`. A flame-length coefficient transcribed into a shader is exactly that shape
 * of hazard, and WGSL never reaches a compiler under Node, so nothing else would catch it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flameLength } from '@sim/rothermel/kernel.ts'
import { kWm } from '@contracts/units'

const source = readFileSync(
  fileURLToPath(new URL('../../../shaders/foliage/burnShade.wgsl', import.meta.url)),
  'utf8',
)

describe('burnShade.wgsl mirrors the Byram flame length', () => {
  it('uses the same coefficient and exponent as sim/rothermel/kernel.ts', () => {
    const match = source.match(/return\s+([\d.]+)\s*\*\s*pow\(peakIntensityKwM,\s*([\d.]+)\)/)
    expect(match, 'charHeightM no longer has the expected shape').not.toBeNull()
    const coefficient = Number(match?.[1])
    const exponent = Number(match?.[2])

    // Recover the kernel's own pair by evaluating it, rather than by reading its source: that
    // way a change to the kernel fails here even if it changes shape rather than digits.
    // L = c * I^e, so L(1) = c and L(100)/L(1) = 100^e.
    const atOne = flameLength(kWm(1)) as number
    const atHundred = flameLength(kWm(100)) as number
    expect(coefficient).toBeCloseTo(atOne, 12)
    expect(exponent).toBeCloseTo(Math.log(atHundred / atOne) / Math.log(100), 12)
  })

  it('the shader guards zero intensity, as the kernel does', () => {
    // Without the guard `pow(0, 0.46)` is 0 anyway, but an unburnt stem would still take the
    // divide in `stemBurnCoordinate`. Both sides return early instead.
    expect(flameLength(kWm(0)) as number).toBe(0)
    expect(source).toContain('if (peakIntensityKwM <= 0.0) { return 0.0; }')
  })

  it('char is full at the base and gone at the flame tip', () => {
    // The relation the shader implements, restated here so the intent is pinned even though
    // the arithmetic lives in WGSL: burn = consumed * clamp(1 - h/reach).
    const reach = flameLength(kWm(500)) as number
    const coordinate = (consumed: number, h: number): number =>
      consumed * Math.min(1, Math.max(0, 1 - h / reach))

    expect(coordinate(1, 0)).toBe(1)
    expect(coordinate(1, reach)).toBe(0)
    expect(coordinate(1, reach * 2)).toBe(0)
    // A backing fire that consumes half the fuel leaves a stem half-charred at the ankle.
    expect(coordinate(0.5, 0)).toBeCloseTo(0.5, 12)
    expect(source).toContain('clamp(1.0 - heightM / reach, 0.0, 1.0)')
  })
})
