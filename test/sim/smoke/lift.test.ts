/**
 * How the smoke field decides a parcel rises — a text check, because the failure mode here is
 * an edit that compiles, runs, and changes nothing at all.
 *
 * The field was pinned in its injection layer for the whole of M4. The first fix read the
 * parcel's buoyancy from the CURRENT cell, which is circular under semi-Lagrangian advection:
 * an empty cell has no excess temperature, so it computes zero rise velocity, so it never
 * backtraces down into the smoke underneath it, so it stays empty. Every diagnostic came back
 * identical to the digit — indistinguishable from the shader never having been rebuilt.
 *
 * Nothing else can catch this. WGSL never reaches a compiler under Node, and on a GPU the
 * symptom is "the numbers did not move", which looks like a build problem rather than a
 * physics one.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const smokeWgsl = read('../../../shaders/sim/smoke/smoke.wgsl')
const convectionWgsl = read('../../../shaders/sim/canopy/convection/convection.wgsl')

/** Body of the advect entry point, which is where lift is decided. */
const advect = ((): string => {
  const at = smokeWgsl.indexOf('fn advect(')
  expect(at, 'advect entry point not found').toBeGreaterThan(-1)
  return smokeWgsl.slice(at)
})()

describe('smoke lift is read upstream, not from the cell being filled', () => {
  it('samples the cell below', () => {
    // `coord.z` is the vertical index; for a rising parcel the upstream cell is z - 1. If this
    // ever reads only `coord`, the field silently stops rising.
    expect(advect).toContain('coord.z - 1')
  })

  it('takes the buoyancy indicator from below as well as here', () => {
    expect(advect).toMatch(/max\(\s*here\.r,\s*below\.r\s*\)/)
  })

  it('scales the centreline profile by that indicator', () => {
    expect(advect).toContain('plumeCentrelineAt')
    expect(advect).toMatch(/w\s*=\s*prof\.y\s*\*\s*buoyantFraction/)
  })
})

describe('lift does not go through the cross-plume Gaussian', () => {
  it('the smoke field does not call plumeGasStateAtWorld for its velocity', () => {
    // That function applies exp(-s^2/b^2) about a single line through the flaming centroid.
    // It is correct for a canopy voxel and wrong for a 4 m smoke cell: with b about 2 m near
    // the ground, 549 of the 551 cells holding smoke on a 4.7 ha fire sat outside the strip
    // and read w = 0. A fire is a burning AREA and all of it lofts.
    // Matched with the open paren: the identifier also appears in the comment above,
    // explaining why it is NOT used, and a bare substring test flags that as a call.
    const velocitySection = advect.slice(0, advect.indexOf('let vel ='))
    expect(velocitySection).not.toContain('plumeGasStateAtWorld(')
  })

  it('the centreline accessor it uses applies no Gaussian', () => {
    const fn = convectionWgsl.slice(convectionWgsl.indexOf('fn plumeCentrelineAt'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).not.toContain('exp(')
    expect(body).toContain('row.x')
    expect(body).toContain('row.y')
  })
})

describe('the canopy still reads through the Gaussian, which is correct for it', () => {
  it('plumeGasStateAtWorld keeps the cross-plume falloff', () => {
    const fn = convectionWgsl.slice(convectionWgsl.indexOf('fn plumeGasState('))
    const body = fn.slice(0, fn.indexOf('\n}'))
    // A voxel asks "what gas is passing through me", which is a question about position
    // relative to the plume axis. Losing this would heat the whole canopy uniformly.
    expect(body).toContain('gaussT')
    expect(body).toContain('PLUME_LAMBDA')
  })
})
