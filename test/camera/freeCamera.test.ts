/**
 * WP 1.8 — free/drone camera.
 *
 * The load-bearing property is that the damping is STABLE and does not oscillate at any
 * frame time, and that the resulting motion is frame-rate independent. Both are asserted
 * against dt values spanning 240 fps to a 2-second hitch, because the naive
 * `v += (vt - v) * k * dt` form passes at 60 fps and diverges at 5.
 */

import { describe, expect, it } from 'vitest'
import { DOMAIN_SIZE_M } from '@contracts/world'
import type { Metres, Seconds } from '@contracts/units'
import { DEFAULT_FREE_CAMERA_CONFIG, FreeCameraController } from '../../src/camera/freeCamera.ts'
import { StubTerrain } from '../../src/camera/terrainStub.ts'
import { EMPTY_SNAPSHOT, type InputSnapshot } from '../../src/camera/input.ts'
import { MAX_PITCH, vLength, v3 } from '../../src/camera/math.ts'

const M = (v: number): Metres => v as Metres
const S = (v: number): Seconds => v as Seconds
const input = (over: Partial<InputSnapshot> = {}): InputSnapshot => ({ ...EMPTY_SNAPSHOT, ...over })

const terrain = new StubTerrain()

const makeCam = (cfg: Partial<typeof DEFAULT_FREE_CAMERA_CONFIG> = {}): FreeCameraController => {
  const c = new FreeCameraController(terrain, cfg)
  c.setPosition(500, 800, 500)
  c.setOrientation(Math.PI / 2, 0) // due east, level
  return c
}

describe('FreeCameraController — damping', () => {
  it('accelerates monotonically to the cruise speed and never overshoots it', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 12, 0.5, 2]) {
      const cam = makeCam()
      cam.cruiseSpeedMps = 30
      let prev = 0
      const steps = Math.ceil(6 / dt)
      for (let i = 0; i < steps; i++) {
        cam.update(S(dt), input({ moveForward: 1 }))
        const sp = vLength(cam.velocity)
        expect(sp).toBeGreaterThanOrEqual(prev - 1e-9) // monotone: no ringing
        expect(sp).toBeLessThanOrEqual(30 + 1e-6) // and no overshoot, at any dt
        expect(Number.isFinite(sp)).toBe(true)
        prev = sp
      }
      expect(prev).toBeCloseTo(30, 4)
    }
  })

  it('coasts to a stop without reversing or oscillating', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 10, 1]) {
      const cam = makeCam()
      cam.cruiseSpeedMps = 50
      for (let i = 0; i < Math.ceil(4 / dt); i++) cam.update(S(dt), input({ moveForward: 1 }))
      let prevSpeed = vLength(cam.velocity)
      let prevX = cam.pose.position.x
      for (let i = 0; i < Math.ceil(8 / dt); i++) {
        cam.update(S(dt), input())
        const sp = vLength(cam.velocity)
        expect(sp).toBeLessThanOrEqual(prevSpeed + 1e-9)
        expect(cam.velocity.x).toBeGreaterThanOrEqual(-1e-9) // never reverses
        expect(cam.pose.position.x).toBeGreaterThanOrEqual(prevX - 1e-9) // never backs up
        prevSpeed = sp
        prevX = cam.pose.position.x
      }
      expect(prevSpeed).toBeLessThan(1e-3)
    }
  })

  it('travels the same distance regardless of frame rate', () => {
    const run = (dt: number): number => {
      const cam = makeCam()
      cam.cruiseSpeedMps = 40
      const steps = Math.round(3 / dt)
      for (let i = 0; i < steps; i++) cam.update(S(dt), input({ moveForward: 1 }))
      return cam.pose.position.x - 500
    }
    const fast = run(1 / 240)
    const slow = run(1 / 24)
    const awful = run(1 / 5)
    // The exact displacement integral makes these agree to floating-point, not to "close
    // enough" — a camera whose stopping distance depends on frame rate is unflyable.
    expect(Math.abs(fast - slow)).toBeLessThan(1e-6)
    expect(Math.abs(fast - awful)).toBeLessThan(1e-6)
    expect(fast).toBeGreaterThan(100) // ~40 m/s for 3 s minus the ramp
  })

  it('is not faster diagonally', () => {
    const speedAfter = (over: Partial<InputSnapshot>): number => {
      const cam = makeCam()
      cam.cruiseSpeedMps = 20
      for (let i = 0; i < 600; i++) cam.update(S(1 / 60), input(over))
      return vLength(cam.velocity)
    }
    expect(speedAfter({ moveForward: 1 })).toBeCloseTo(20, 4)
    expect(speedAfter({ moveForward: 1, moveRight: 1, moveUp: 1 })).toBeCloseTo(20, 4)
  })
})

describe('FreeCameraController — speed control', () => {
  it('covers the whole 0.5 to 200 m/s range multiplicatively and clamps at both ends', () => {
    const cam = makeCam()
    for (let i = 0; i < 100; i++) cam.update(S(1 / 60), input({ scroll: 1 }))
    expect(cam.cruiseSpeedMps).toBe(DEFAULT_FREE_CAMERA_CONFIG.maxSpeedMps)
    expect(cam.cruiseSpeedMps).toBe(200)
    for (let i = 0; i < 200; i++) cam.update(S(1 / 60), input({ scroll: -1 }))
    expect(cam.cruiseSpeedMps).toBe(DEFAULT_FREE_CAMERA_CONFIG.minSpeedMps)
    expect(cam.cruiseSpeedMps).toBe(0.5)

    // A single notch is a fixed RATIO, so the control has the same feel at both ends.
    cam.cruiseSpeedMps = 10
    cam.update(S(1 / 60), input({ scroll: 1 }))
    expect(cam.cruiseSpeedMps).toBeCloseTo(12.5, 6)
    cam.cruiseSpeedMps = 100
    cam.update(S(1 / 60), input({ scroll: 1 }))
    expect(cam.cruiseSpeedMps).toBeCloseTo(125, 6)
  })

  it('crosses the 1 km domain in a few seconds at top speed', () => {
    const cam = makeCam()
    // Start at the western edge and fly east across the full 1 km. (The camera is allowed
    // a margin outside the domain, so a full-width crossing is representable.)
    cam.setPosition(0, 800, 500)
    cam.cruiseSpeedMps = 200
    let t = 0
    const dt = 1 / 60
    while (cam.pose.position.x < DOMAIN_SIZE_M && t < 60) {
      cam.update(S(dt), input({ moveForward: 1 }))
      t += dt
    }
    expect(cam.pose.position.x).toBeGreaterThanOrEqual(DOMAIN_SIZE_M)
    expect(t).toBeLessThan(10) // 1024 m at 200 m/s plus the acceleration ramp
  })

  it('sprint multiplies the cruise speed; the slow modifier divides it', () => {
    const settle = (over: Partial<InputSnapshot>): number => {
      const cam = makeCam()
      cam.cruiseSpeedMps = 10
      for (let i = 0; i < 600; i++) cam.update(S(1 / 60), input({ moveForward: 1, ...over }))
      return vLength(cam.velocity)
    }
    expect(settle({})).toBeCloseTo(10, 4)
    expect(settle({ sprint: true })).toBeCloseTo(40, 4)
    expect(settle({ crouch: true })).toBeCloseTo(2.5, 4)
    // ...but the slow modifier must not apply while the same key is being used to descend,
    // or every descent would silently drop to quarter speed.
    expect(settle({ crouch: true, moveUp: -1 })).toBeCloseTo(10, 4)
  })
})

describe('FreeCameraController — bounds and collision', () => {
  it('passes through terrain when collision is off', () => {
    const cam = makeCam({ collideWithTerrain: false })
    cam.cruiseSpeedMps = 50
    for (let i = 0; i < 600; i++) cam.update(S(1 / 60), input({ moveUp: -1 }))
    expect(cam.pose.position.y).toBeLessThan(terrain.heightAt(M(500), M(500)))
  })

  it('stops at the clearance height when collision is on, without sticking or jittering', () => {
    const cam = makeCam({ collideWithTerrain: true })
    cam.cruiseSpeedMps = 50
    const ys: number[] = []
    for (let i = 0; i < 600; i++) {
      cam.update(S(1 / 60), input({ moveUp: -1 }))
      ys.push(cam.pose.position.y)
    }
    const floor = terrain.heightAt(M(500), M(500)) + DEFAULT_FREE_CAMERA_CONFIG.minClearanceM
    expect(cam.pose.position.y).toBeCloseTo(floor, 6)
    expect(cam.velocity.y).toBe(0) // the into-surface velocity was removed, not accumulated
    // Once settled it stays settled: no bounce.
    for (let i = ys.length - 60; i < ys.length; i++) {
      expect(ys[i] as number).toBeCloseTo(floor, 6)
    }
    // And it can leave again immediately, with no residual downward momentum.
    cam.update(S(1 / 60), input({ moveUp: 1 }))
    expect(cam.pose.position.y).toBeGreaterThan(floor)
  })

  it('may fly outside the domain but not indefinitely, and not above the ceiling', () => {
    const cam = makeCam()
    cam.cruiseSpeedMps = 200
    for (let i = 0; i < 3000; i++) cam.update(S(1 / 60), input({ moveForward: 1, moveUp: 1 }))
    const p = cam.pose.position
    const margin = DEFAULT_FREE_CAMERA_CONFIG.outsideMarginM
    expect(p.x).toBeLessThanOrEqual(DOMAIN_SIZE_M + margin + 1e-6)
    expect(p.x).toBeGreaterThan(DOMAIN_SIZE_M) // it did get outside, which is intended
    expect(p.y).toBeLessThanOrEqual(DEFAULT_FREE_CAMERA_CONFIG.maxAltitudeM + 1e-6)
    expect(cam.wasClamped).toBe(true)
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true)
  })
})

describe('FreeCameraController — orientation', () => {
  it('is roll-free and pitch-clamped however hard it is spun', () => {
    const cam = makeCam()
    for (let i = 0; i < 500; i++) {
      cam.update(S(1 / 60), input({ lookYaw: 0.37, lookPitch: 0.41 }))
      expect(Math.abs(cam.pose.pitch)).toBeLessThanOrEqual(MAX_PITCH + 1e-12)
    }
    expect(cam.pose.pitch).toBeCloseTo(MAX_PITCH, 9)
    for (let i = 0; i < 500; i++) cam.update(S(1 / 60), input({ lookPitch: -0.41 }))
    expect(cam.pose.pitch).toBeCloseTo(-MAX_PITCH, 9)
    // Yaw wraps into [0, 2pi) rather than growing without bound.
    expect(cam.pose.yaw).toBeGreaterThanOrEqual(0)
    expect(cam.pose.yaw).toBeLessThan(Math.PI * 2)
  })

  it('moves along its view direction, with vertical motion on WORLD up', () => {
    const cam = makeCam()
    cam.setOrientation(0, -Math.PI / 4) // north, pitched 45 degrees down
    cam.cruiseSpeedMps = 10
    for (let i = 0; i < 600; i++) cam.update(S(1 / 60), input({ moveForward: 1 }))
    const v = cam.velocity
    expect(v.z).toBeCloseTo(-10 * Math.SQRT1_2, 3) // north
    expect(v.y).toBeCloseTo(-10 * Math.SQRT1_2, 3) // and downward, following the pitch
    expect(v.x).toBeCloseTo(0, 6)

    // Ascend while pitched down: still straight up, not up-and-back.
    const cam2 = makeCam()
    cam2.setOrientation(0, -Math.PI / 4)
    cam2.cruiseSpeedMps = 10
    for (let i = 0; i < 600; i++) cam2.update(S(1 / 60), input({ moveUp: 1 }))
    expect(cam2.velocity.y).toBeCloseTo(10, 3)
    expect(vLength(v3(cam2.velocity.x, 0, cam2.velocity.z))).toBeLessThan(1e-6)
  })

  it('adopts a pose exactly, dropping any momentum', () => {
    const cam = makeCam()
    cam.cruiseSpeedMps = 100
    for (let i = 0; i < 120; i++) cam.update(S(1 / 60), input({ moveForward: 1 }))
    expect(vLength(cam.velocity)).toBeGreaterThan(1)
    cam.adoptPose({ position: v3(11, 900, 22), yaw: 1.23, pitch: -0.4 })
    expect(cam.pose.position.x).toBe(11)
    expect(cam.pose.position.y).toBe(900)
    expect(cam.pose.position.z).toBe(22)
    expect(cam.pose.yaw).toBeCloseTo(1.23, 9)
    expect(cam.pose.pitch).toBeCloseTo(-0.4, 9)
    expect(vLength(cam.velocity)).toBe(0)
  })
})
