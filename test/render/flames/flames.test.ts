/**
 * There are now THREE copies of Byram's flame length in this repo: the CPU kernel, the foliage
 * burn shader, and the flame renderer. That is one more than is comfortable, and WGSL never
 * reaches a compiler under Node, so nothing else would notice them drifting apart.
 *
 * This pins all three to each other. If a flame is drawn at a different height from the char
 * it leaves on the trunk beside it, that is the bug this catches.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flameLength } from '@sim/rothermel/kernel.ts'
import { kWm } from '@contracts/units'
import { FLAME_STRIDE, MAX_FLAMES } from '@render/flames/flameRenderer.ts'
import { SURFACE_CELLS } from '@contracts/world'

const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const flamesWgsl = read('../../../shaders/render/flames/flames.wgsl')
const burnWgsl = read('../../../shaders/foliage/burnShade.wgsl')

const COEFF = /([\d.]+)\s*\*\s*pow\(\s*\w+\s*,\s*([\d.]+)\s*\)/

describe('flame length is one relation in three places', () => {
  it('flames.wgsl matches the kernel', () => {
    const m = flamesWgsl.match(COEFF)
    expect(m, 'flameLengthM no longer has the expected shape').not.toBeNull()
    // Recover the kernel's own pair by evaluating it: L = c * I^e, so L(1) = c.
    const atOne = flameLength(kWm(1)) as number
    const atHundred = flameLength(kWm(100)) as number
    expect(Number(m?.[1])).toBeCloseTo(atOne, 12)
    expect(Number(m?.[2])).toBeCloseTo(Math.log(atHundred / atOne) / Math.log(100), 12)
  })

  it('flames.wgsl and burnShade.wgsl agree with each other', () => {
    const a = flamesWgsl.match(COEFF)
    const b = burnWgsl.match(COEFF)
    expect(a?.[1]).toBe(b?.[1])
    expect(a?.[2]).toBe(b?.[2])
  })
})

describe('the gather is sized so a full front cannot silently overflow', () => {
  it('the stride divides the surface grid exactly', () => {
    // `csGather` computes `cells / stride` as integer division. A stride that does not divide
    // would drop a strip of cells along two edges of the domain and nothing would say so.
    expect((SURFACE_CELLS as number) % FLAME_STRIDE).toBe(0)
  })

  it('capacity covers a front far larger than any this model produces', () => {
    // The worst realistic case is a fire whose whole perimeter is flaming at once. A circular
    // front filling the domain has a perimeter of pi * 1024 m; at the flaming residence times
    // in play the band is a few metres deep, so a few thousand billboards. Two orders of
    // headroom over that, and the shader drops rather than wraps past it.
    const blocksPerAxis = (SURFACE_CELLS as number) / FLAME_STRIDE
    const perimeterBillboards = Math.PI * blocksPerAxis
    expect(MAX_FLAMES).toBeGreaterThan(perimeterBillboards * 20)
  })
})
