/**
 * Screen-to-world picking and the ignition shapes it feeds.
 *
 * A picking bug is indistinguishable from a solver bug from the user's chair — you click and
 * nothing burns — so it gets its own oracle: a flat and then a sloped analytic "terrain"
 * whose intersection can be computed by hand.
 */

import { describe, expect, it } from 'vitest'
import type { CameraState } from '../../src/contracts/render.ts'
import { DOMAIN_SIZE_M } from '../../src/contracts/world.ts'
import { m as metres, rad, type Metres } from '../../src/contracts/units.ts'
import {
  mat4Create,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  v3,
} from '../../src/camera/math.ts'
import { ignitionShape, ndcFromPointer, pickGround } from '../../src/app/ignition.ts'

/** Just enough `CameraState` for the picker: it reads only `invViewProjMatrix`. */
function cameraLookingAt(eye: [number, number, number], forward: [number, number, number]): CameraState {
  const proj = mat4Perspective(mat4Create(), Math.PI / 3, 16 / 9, 0.1, 4000)
  const view = mat4View(mat4Create(), v3(...eye), v3(...forward), v3(0, 1, 0))
  const viewProj = mat4Multiply(mat4Create(), proj, view)
  const inv = mat4Create()
  expect(mat4Invert(inv, viewProj)).toBe(true)
  return { invViewProjMatrix: inv } as unknown as CameraState
}

const flat = (h: number) => ({ heightAt: (): Metres => metres(h) })
/** A 20% slope rising with +x, so the hit point moves in a direction the test can predict. */
const ramp = { heightAt: (x: Metres): Metres => metres(0.2 * (x as number)) }

describe('ndcFromPointer', () => {
  const rect = { left: 0, top: 0, width: 800, height: 400 }

  it('puts the centre of the canvas at the origin', () => {
    expect(ndcFromPointer(400, 200, rect)).toEqual([0, 0])
  })

  it('flips Y, because WebGPU NDC is Y-up and the framebuffer is Y-down', () => {
    expect(ndcFromPointer(400, 0, rect)[1]).toBe(1)
    expect(ndcFromPointer(400, 400, rect)[1]).toBe(-1)
  })

  it('is unaffected by where the canvas sits on the page', () => {
    expect(ndcFromPointer(500, 300, { left: 100, top: 100, width: 800, height: 400 })).toEqual([0, 0])
  })
})

describe('pickGround', () => {
  it('hits straight down at the camera position', () => {
    const cam = cameraLookingAt([500, 100, 500], [0, -1, 0])
    const hit = pickGround(cam, flat(0), [0, 0])
    expect(hit).not.toBeNull()
    expect(hit?.x as number).toBeCloseTo(500, 1)
    expect(hit?.z as number).toBeCloseTo(500, 1)
    expect(hit?.y as number).toBeCloseTo(0, 1)
  })

  it('hits at 45 degrees exactly one height away, which is the reversed-Z check', () => {
    // If the near/far depth values were swapped the ray would point backwards and this
    // would land at 400, or miss entirely. That is the failure mode worth a named test.
    const cam = cameraLookingAt([500, 100, 500], [1, -1, 0])
    const hit = pickGround(cam, flat(0), [0, 0])
    expect(hit?.x as number).toBeCloseTo(600, 0)
    expect(hit?.z as number).toBeCloseTo(500, 0)
  })

  it('returns null when aimed at the sky', () => {
    const cam = cameraLookingAt([500, 100, 500], [0, 1, 0])
    expect(pickGround(cam, flat(0), [0, 0])).toBeNull()
  })

  it('follows the terrain: a rising slope is met sooner than flat ground', () => {
    const cam = cameraLookingAt([100, 100, 500], [1, -1, 0])
    const onFlat = pickGround(cam, flat(0), [0, 0])
    const onRamp = pickGround(cam, ramp, [0, 0])
    expect(onRamp?.x as number).toBeLessThan(onFlat?.x as number)
    // On the ramp, y must equal the terrain height there — not the flat ground's zero.
    expect(onRamp?.y as number).toBeCloseTo(0.2 * (onRamp?.x as number), 0)
  })

  it('clamps to the domain rather than refusing to ignite near the edge', () => {
    const cam = cameraLookingAt([990, 5, 500], [1, -0.02, 0])
    const hit = pickGround(cam, flat(0), [0, 0])
    expect(hit).not.toBeNull()
    expect(hit?.x as number).toBeLessThanOrEqual(DOMAIN_SIZE_M)
    expect(hit?.clamped).toBe(true)
  })

  it('picks off-centre where the pointer is, not at the crosshair', () => {
    // Not looking straight down: `mat4View` picks an arbitrary roll reference there, so
    // "screen right" would not correspond to any particular world axis.
    const cam = cameraLookingAt([500, 100, 500], [0, -1, -1])
    const centre = pickGround(cam, flat(0), [0, 0])
    const left = pickGround(cam, flat(0), [-0.5, 0])
    const right = pickGround(cam, flat(0), [0.5, 0])
    // Convention-free: the two must straddle the crosshair pick and be distinct from it.
    const cx = centre?.x as number
    expect(Math.sign((right?.x as number) - cx)).toBe(-Math.sign((left?.x as number) - cx))
    expect(Math.abs((right?.x as number) - cx)).toBeGreaterThan(1)
  })
})

describe('ignitionShape', () => {
  const at = { x: metres(500), z: metres(500), radiusM: 10, windDirection: rad(0) }

  it('makes a point of the requested radius', () => {
    const s = ignitionShape({ ...at, tool: 'point' })
    expect(s.kind).toBe('point')
    if (s.kind === 'point') expect(s.radius as number).toBe(10)
  })

  it('makes a ring that encloses area rather than a fat point', () => {
    const s = ignitionShape({ ...at, tool: 'ring' })
    expect(s.kind).toBe('ring')
    if (s.kind === 'ring') expect(s.radius as number).toBeGreaterThan(s.width as number)
  })

  it('lays the line ACROSS the wind, which is the only way to get a head fire', () => {
    // Wind toward azimuth 0 = due north = -Z in world terms is not assumed here; what is
    // asserted is perpendicularity, which is the property that matters.
    for (const azimuth of [0, 0.7, Math.PI / 2, 2.9]) {
      const s = ignitionShape({ ...at, tool: 'line', windDirection: rad(azimuth) })
      expect(s.kind).toBe('line')
      if (s.kind !== 'line') continue
      const lx = (s.x1 as number) - (s.x0 as number)
      const lz = (s.z1 as number) - (s.z0 as number)
      const wx = Math.sin(azimuth)
      const wz = Math.cos(azimuth)
      const len = Math.hypot(lx, lz)
      expect(len).toBeGreaterThan(0)
      expect(Math.abs((lx * wx + lz * wz) / len)).toBeLessThan(1e-6)
    }
  })

  it('never emits a zero-size shape, which would ignite nothing at all', () => {
    for (const tool of ['point', 'line', 'ring'] as const) {
      const s = ignitionShape({ ...at, tool, radiusM: 0 })
      const size = s.kind === 'line' ? Math.hypot((s.x1 as number) - (s.x0 as number), (s.z1 as number) - (s.z0 as number)) : (s.radius as number)
      expect(size).toBeGreaterThan(0)
    }
  })

  it('keeps a line inside the domain when ignited at a corner', () => {
    const s = ignitionShape({ tool: 'line', x: metres(2), z: metres(2), radiusM: 60, windDirection: rad(0) })
    if (s.kind !== 'line') throw new Error('expected a line')
    for (const v of [s.x0, s.z0, s.x1, s.z1]) {
      expect(v as number).toBeGreaterThanOrEqual(0)
      expect(v as number).toBeLessThanOrEqual(DOMAIN_SIZE_M)
    }
  })
})
