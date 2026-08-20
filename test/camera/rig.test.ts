/**
 * WP 1.8 — the rig: `CameraState` assembly, mode transitions, and the `CameraRig` contract.
 *
 * These are the tests the integrator runs to know the camera can be handed to WP 1.5's cull
 * pass and M4's froxel pass: the matrices must be internally consistent, the frustum must
 * agree with the matrices, and no mode change may produce a discontinuity.
 */

import { describe, expect, it } from 'vitest'
import { DOMAIN_SIZE_M } from '@contracts/world'
import type { CameraState, } from '@contracts/render'
import type { Metres, Radians, Seconds } from '@contracts/units'
import { CameraRig, createCameraRig } from '../../src/camera/rig.ts'
import { StubTerrain } from '../../src/camera/terrainStub.ts'
import {
  FRUSTUM_FLOATS,
  FrustumPlane,
  asUploadable,
  REVERSED_Z,
  mat4Create,
  mat4Multiply,
  planeDistance,
  projectToNdc,
  unprojectFromNdc,
  v3,
  vCross,
  vDot,
  vLength,
} from '../../src/camera/math.ts'

const M = (v: number): Metres => v as Metres
const S = (v: number): Seconds => v as Seconds
const R = (v: number): Radians => v as Radians

const terrain = new StubTerrain()
const makeRig = (): CameraRig => createCameraRig(terrain)

const stepFor = (rig: CameraRig, seconds: number, dt = 1 / 60): void => {
  for (let i = 0; i < Math.round(seconds / dt); i++) rig.update(S(dt))
}

describe('CameraRig — contract conformance', () => {
  it('satisfies CameraRig structurally', () => {
    const rig: CameraRig = makeRig()
    expect(rig.mode).toBe('first-person')
    const state: CameraState = rig.state
    expect(state.viewMatrix.length).toBe(16)
    expect(state.projMatrix.length).toBe(16)
    expect(state.viewProjMatrix.length).toBe(16)
    expect(state.invViewProjMatrix.length).toBe(16)
    expect(state.frustumPlanes.length).toBe(FRUSTUM_FLOATS)
    expect(state.position.length).toBe(3)
  })

  it('matrices can be handed to writeBuffer via asUploadable', () => {
    // Guards the workaround for the contract's `Float32Array` typing (see math.ts). If the
    // contract is fixed to `Float32Array<ArrayBuffer>` this stays true and the helper can go.
    const rig = makeRig()
    const src: Float32Array<ArrayBuffer> = asUploadable(rig.state.viewProjMatrix)
    expect(src.byteLength).toBe(64)
    expect(src.buffer.byteLength).toBe(64)
  })

  it('exposes a valid state before the first update', () => {
    const rig = makeRig()
    const s = rig.state
    for (const mat of [s.viewMatrix, s.projMatrix, s.viewProjMatrix, s.invViewProjMatrix]) {
      for (const v of mat) expect(Number.isFinite(v)).toBe(true)
    }
    expect(s.position[1]).toBeGreaterThan(terrain.heightAt(M(s.position[0]), M(s.position[2])))
  })

  it('eyeHeightM and freeSpeed are readable and writable, per the contract', () => {
    const rig: CameraRig = makeRig()
    rig.eyeHeightM = M(2.2)
    expect(rig.eyeHeightM).toBeCloseTo(2.2, 9)
    rig.freeSpeed = 75
    expect(rig.freeSpeed).toBeCloseTo(75, 9)
    rig.freeSpeed = 1e9 // clamped to the configured maximum, not accepted blindly
    expect(rig.freeSpeed).toBe(200)
  })
})

describe('CameraRig — matrix consistency', () => {
  it('viewProj is exactly proj * view', () => {
    const rig = makeRig()
    rig.setOrientation(R(1.3), R(-0.2))
    rig.update(S(1 / 60))
    const s = rig.state
    const expected = mat4Multiply(mat4Create(), s.projMatrix, s.viewMatrix)
    for (let i = 0; i < 16; i++) {
      expect(s.viewProjMatrix[i] as number).toBeCloseTo(expected[i] as number, 5)
    }
  })

  it('invViewProj round-trips points from 1 m to 2 km', () => {
    const rig = makeRig()
    rig.setMode('free')
    rig.setOrientation(R(0.6), R(-0.15))
    stepFor(rig, 1)
    const s = rig.state
    const eye = v3(s.position[0], s.position[1], s.position[2])
    const fwd = v3(s.forward[0], s.forward[1], s.forward[2])
    let worst = 0
    for (const d of [1, 10, 100, 1000, 2000]) {
      const p = v3(eye.x + fwd.x * d, eye.y + fwd.y * d, eye.z + fwd.z * d)
      const ndc = projectToNdc(s.viewProjMatrix, p)
      expect(ndc.z).toBeGreaterThanOrEqual(0)
      expect(ndc.z).toBeLessThanOrEqual(1)
      const back = unprojectFromNdc(s.invViewProjMatrix, ndc)
      worst = Math.max(worst, vLength(v3(back.x - p.x, back.y - p.y, back.z - p.z)) / d)
    }
    expect(worst).toBeLessThan(1e-4)
  })

  it('uses reversed-Z: a nearer point has a GREATER depth value', () => {
    const rig = makeRig()
    rig.update(S(1 / 60))
    const s = rig.state
    const eye = v3(s.position[0], s.position[1], s.position[2])
    const fwd = v3(s.forward[0], s.forward[1], s.forward[2])
    const at = (d: number): number =>
      projectToNdc(s.viewProjMatrix, v3(eye.x + fwd.x * d, eye.y + fwd.y * d, eye.z + fwd.z * d)).z
    if (REVERSED_Z) {
      expect(at(5)).toBeGreaterThan(at(500))
    } else {
      expect(at(5)).toBeLessThan(at(500))
    }
  })

  it('keeps the horizon level: the camera basis is orthonormal and roll-free', () => {
    const rig = makeRig()
    rig.setMode('free')
    for (let i = 0; i < 200; i++) {
      rig.input.addLookRadians(0.11, 0.07)
      rig.update(S(1 / 60))
      const s = rig.state
      const f = v3(s.forward[0], s.forward[1], s.forward[2])
      const u = v3(s.up[0], s.up[1], s.up[2])
      expect(vLength(f)).toBeCloseTo(1, 6)
      expect(vLength(u)).toBeCloseTo(1, 6)
      expect(vDot(f, u)).toBeCloseTo(0, 6)
      // The right vector must stay horizontal — that is what "no roll" means.
      const right = vCross(f, u)
      expect(Math.abs(right.y)).toBeLessThan(1e-6)
      expect(u.y).toBeGreaterThan(0)
    }
  })

  it('frustum planes agree with the projection and follow the aspect ratio', () => {
    const rig = makeRig()
    rig.resize(2560, 1440)
    rig.update(S(1 / 60))
    const s = rig.state
    expect(s.aspect).toBeCloseTo(2560 / 1440, 9)
    const eye = v3(s.position[0], s.position[1], s.position[2])
    const fwd = v3(s.forward[0], s.forward[1], s.forward[2])
    const ahead = v3(eye.x + fwd.x * 50, eye.y + fwd.y * 50, eye.z + fwd.z * 50)
    const behind = v3(eye.x - fwd.x * 50, eye.y - fwd.y * 50, eye.z - fwd.z * 50)
    for (const slot of Object.values(FrustumPlane)) {
      expect(planeDistance(s.frustumPlanes, slot, ahead)).toBeGreaterThan(0)
    }
    expect(planeDistance(s.frustumPlanes, FrustumPlane.Near, behind)).toBeLessThan(0)
    // Near/far distances match the configured clip planes.
    expect(planeDistance(s.frustumPlanes, FrustumPlane.Near, eye)).toBeCloseTo(-s.nearM, 3)
    expect(planeDistance(s.frustumPlanes, FrustumPlane.Far, eye)).toBeCloseTo(s.farM, 0)
  })

  it('honours setVerticalFov and setClipPlanes', () => {
    const rig = makeRig()
    rig.setVerticalFov(R(Math.PI / 2))
    rig.setClipPlanes(M(0.2), M(1500))
    rig.update(S(1 / 60))
    expect(rig.state.verticalFov).toBeCloseTo(Math.PI / 2, 9)
    expect(rig.state.nearM).toBeCloseTo(0.2, 9)
    expect(rig.state.farM).toBeCloseTo(1500, 9)
    // A far plane inside the near plane would produce a singular projection; it is clamped.
    rig.setClipPlanes(M(10), M(1))
    expect(rig.state.farM).toBeGreaterThan(rig.state.nearM)
  })
})

describe('CameraRig — modes and transitions', () => {
  it('starts on the ground in first person and follows terrain', () => {
    const rig = makeRig()
    rig.moveTo(M(300), M(700))
    rig.update(S(1 / 60))
    const s = rig.state
    const ground = terrain.heightAt(M(s.position[0]), M(s.position[2]))
    expect(s.position[1] - ground).toBeGreaterThan(1.0)
    expect(s.position[1] - ground).toBeLessThan(2.5)
  })

  it('blends between modes instead of cutting, and finishes on the new controller', () => {
    const rig = makeRig()
    rig.setMode('free')
    // Climb to 200 m so the return to first person is a large, obvious discontinuity.
    rig.freeSpeed = 60
    for (let i = 0; i < 400; i++) {
      rig.input.setKey('Space', true)
      rig.update(S(1 / 60))
    }
    rig.input.setKey('Space', false)
    const altitude =
      rig.state.position[1] - terrain.heightAt(M(rig.state.position[0]), M(rig.state.position[2]))
    expect(altitude).toBeGreaterThan(150)

    rig.setMode('first-person')
    expect(rig.isTransitioning).toBe(true)
    const yStart = rig.state.position[1] as number
    let prev = yStart
    let maxJump = 0
    const dt = 1 / 60
    for (let i = 0; i < 120; i++) {
      rig.update(S(dt))
      const y = rig.state.position[1] as number
      maxJump = Math.max(maxJump, Math.abs(y - prev))
      prev = y
    }
    const drop = Math.abs(yStart - (rig.state.position[1] as number))
    // A smoothstep over `transitionSeconds` peaks at 1.5x the mean rate, so the largest
    // legitimate per-frame step is 1.5 * drop / 0.7 * dt. A hard cut would instead show up
    // as a single step of the whole drop.
    const smoothPeak = (1.5 * drop) / 0.7 * dt
    expect(maxJump).toBeLessThan(smoothPeak * 1.2)
    expect(maxJump).toBeLessThan(drop * 0.1)
    expect(rig.isTransitioning).toBe(false)
    const s = rig.state
    const ground = terrain.heightAt(M(s.position[0]), M(s.position[2]))
    expect(s.position[1] - ground).toBeLessThan(2.5)
  })

  it('preserves orientation across a mode change', () => {
    const rig = makeRig()
    rig.setOrientation(R(2.1), R(-0.35))
    rig.update(S(1 / 60))
    const before = [...rig.state.forward]
    rig.setMode('free')
    rig.update(S(1 / 60))
    for (let k = 0; k < 3; k++) {
      expect(rig.state.forward[k] as number).toBeCloseTo(before[k] as number, 3)
    }
  })

  it('switching to free mode is seamless: the drone starts where the eye was', () => {
    const rig = makeRig()
    rig.moveTo(M(650), M(420))
    rig.update(S(1 / 60))
    const before = [...rig.state.position]
    rig.setMode('free')
    rig.update(S(1 / 60))
    for (let k = 0; k < 3; k++) {
      expect(rig.state.position[k] as number).toBeCloseTo(before[k] as number, 2)
    }
  })

  it('the mode toggle key switches modes exactly once per press', () => {
    const rig = makeRig()
    rig.input.setKey('KeyF', true)
    rig.update(S(1 / 60))
    expect(rig.mode).toBe('free')
    rig.update(S(1 / 60))
    expect(rig.mode).toBe('free') // held, not repeating
    rig.input.setKey('KeyF', false)
    rig.input.setKey('KeyF', true)
    rig.update(S(1 / 60))
    expect(rig.mode).toBe('first-person')
  })

  it('setMode to the current mode is a no-op', () => {
    const rig = makeRig()
    rig.update(S(1 / 60))
    const y = rig.state.position[1]
    rig.setMode('first-person')
    expect(rig.isTransitioning).toBe(false)
    rig.update(S(1 / 60))
    expect(rig.state.position[1] as number).toBeCloseTo(y as number, 6)
  })
})

describe('CameraRig — robustness', () => {
  it('clamps moveTo to the domain and cancels any transition', () => {
    const rig = makeRig()
    rig.setMode('free')
    rig.moveTo(M(-9999), M(1e6))
    expect(rig.isTransitioning).toBe(false)
    const s = rig.state
    expect(s.position[0]).toBeGreaterThanOrEqual(0)
    expect(s.position[0]).toBeLessThanOrEqual(DOMAIN_SIZE_M)
    expect(s.position[2]).toBeGreaterThanOrEqual(0)
    expect(s.position[2]).toBeLessThanOrEqual(DOMAIN_SIZE_M)
  })

  it('keeps the free camera above ground level across a teleport', () => {
    const rig = makeRig()
    rig.setMode('free')
    rig.freeSpeed = 40
    for (let i = 0; i < 200; i++) {
      rig.input.setKey('Space', true)
      rig.update(S(1 / 60))
    }
    rig.input.setKey('Space', false)
    const aglBefore =
      rig.state.position[1] - terrain.heightAt(M(rig.state.position[0]), M(rig.state.position[2]))
    rig.moveTo(M(704), M(500)) // onto the escarpment, a very different ground height
    const aglAfter =
      rig.state.position[1] - terrain.heightAt(M(rig.state.position[0]), M(rig.state.position[2]))
    expect(aglAfter).toBeCloseTo(aglBefore, 3)
    expect(aglAfter).toBeGreaterThan(0)
  })

  it('clamps a monstrous dt rather than teleporting across the domain', () => {
    const rig = makeRig()
    rig.setMode('free')
    rig.freeSpeed = 200
    stepFor(rig, 3) // reach cruise speed
    const before = rig.state.position[0] as number
    rig.update(S(30)) // a 30 second "frame", e.g. the tab was in the background
    const moved = Math.abs((rig.state.position[0] as number) - before)
    expect(moved).toBeLessThan(200 * 0.1 + 1) // maxStepSeconds worth of travel, not 6 km
  })

  it('produces finite state for a long mixed-mode session', () => {
    const rig = makeRig()
    rig.freeSpeed = 30
    for (let i = 0; i < 3000; i++) {
      if (i % 500 === 0) rig.setMode(rig.mode === 'free' ? 'first-person' : 'free')
      rig.input.setKey('KeyW', i % 7 !== 0)
      rig.input.setKey('ShiftLeft', i % 3 === 0)
      rig.input.addLookRadians(0.02 * Math.sin(i * 0.1), 0.01 * Math.cos(i * 0.07))
      rig.update(S(i % 11 === 0 ? 0.05 : 1 / 90))
      const s = rig.state
      expect(Number.isFinite(s.position[0] + s.position[1] + s.position[2])).toBe(true)
      for (const v of s.viewProjMatrix) expect(Number.isFinite(v)).toBe(true)
      for (const v of s.invViewProjMatrix) expect(Number.isFinite(v)).toBe(true)
      for (const v of s.frustumPlanes) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('defaults to the analytic stub terrain when none is supplied', () => {
    const rig = new CameraRig()
    rig.update(S(1 / 60))
    expect(Number.isFinite(rig.state.position[1])).toBe(true)
  })
})
