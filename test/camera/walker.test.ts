/**
 * WP 1.8 — first-person walker acceptance tests.
 *
 * The acceptance criterion is "walker stays on terrain across the full domain; no
 * tunnelling on steep slopes", so these are scripted traverses of the analytic stub
 * terrain with the eye-to-ground error measured EVERY FRAME, not just at the end. A test
 * that only checks the final pose would pass while the camera pops through a ridge
 * mid-traverse, which is exactly the failure being guarded against.
 */

import { describe, expect, it } from 'vitest'
import { DOMAIN_SIZE_M } from '@contracts/world'
import type { Metres, Seconds } from '@contracts/units'
import { DEFAULT_WALKER_CONFIG, WalkerController } from '../../src/camera/walker.ts'
import { StubTerrain } from '../../src/camera/terrainStub.ts'
import { EMPTY_SNAPSHOT, type InputSnapshot } from '../../src/camera/input.ts'

const M = (v: number): Metres => v as Metres
const S = (v: number): Seconds => v as Seconds

const walk = (over: Partial<InputSnapshot> = {}): InputSnapshot => ({
  ...EMPTY_SNAPSHOT,
  moveForward: 1,
  ...over,
})

interface TraverseResult {
  readonly worstEyeError: number
  readonly worstSlopeSeen: number
  readonly maxVerticalAccel: number
  readonly blockedFrames: number
  readonly samples: number
  readonly path: readonly { x: number; z: number; y: number }[]
}

/** Walk on a fixed bearing for `seconds`, checking the invariants on every frame. */
const traverse = (
  w: WalkerController,
  terrain: StubTerrain,
  bearingRad: number,
  seconds: number,
  dt: number,
  input: InputSnapshot = walk({ sprint: true }),
): TraverseResult => {
  w.setOrientation(bearingRad, 0)
  let worstEyeError = 0
  let worstSlopeSeen = 0
  let blockedFrames = 0
  let maxVerticalAccel = 0
  const path: { x: number; z: number; y: number }[] = []
  const steps = Math.round(seconds / dt)
  let prevY = w.pose.position.y
  let prevVy = 0

  for (let i = 0; i < steps; i++) {
    w.update(S(dt), input)
    const p = w.pose.position
    const d = w.debug

    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x).toBeLessThanOrEqual(DOMAIN_SIZE_M)
    expect(p.z).toBeGreaterThanOrEqual(0)
    expect(p.z).toBeLessThanOrEqual(DOMAIN_SIZE_M)
    // Never below the surface, whatever the spring is doing.
    expect(p.y).toBeGreaterThan(d.groundRawM)

    worstEyeError = Math.max(worstEyeError, Math.abs(d.eyeErrorM))
    worstSlopeSeen = Math.max(worstSlopeSeen, terrain.slopeAt(M(p.x), M(p.z)))
    if (d.blockedThisFrame) blockedFrames++

    const vy = (p.y - prevY) / dt
    maxVerticalAccel = Math.max(maxVerticalAccel, Math.abs((vy - prevVy) / dt))
    prevVy = vy
    prevY = p.y
    path.push({ x: p.x, z: p.z, y: p.y })
  }

  return { worstEyeError, worstSlopeSeen, maxVerticalAccel, blockedFrames, samples: steps, path }
}

describe('WalkerController — staying on the ground', () => {
  it('sits exactly at ground + eye height after a teleport', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    for (const [x, z] of [
      [10, 10],
      [512, 512],
      [704, 300],
      [1000, 1000],
    ] as const) {
      w.moveTo(x, z)
      const p = w.pose.position
      expect(p.x).toBeCloseTo(x, 6)
      expect(p.z).toBeCloseTo(z, 6)
      // groundSmooth is the footprint-filtered height; the raw error is bounded by the
      // filter, which on this terrain is centimetres.
      expect(Math.abs(w.debug.eyeErrorM)).toBeLessThan(0.05)
    }
  })

  it('clamps a teleport to the domain', () => {
    const w = new WalkerController(new StubTerrain())
    w.moveTo(-500, 99999)
    const p = w.pose.position
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x).toBeLessThanOrEqual(DOMAIN_SIZE_M)
    expect(p.z).toBeGreaterThanOrEqual(0)
    expect(p.z).toBeLessThanOrEqual(DOMAIN_SIZE_M)
  })

  it('traverses the entire domain on eight bearings without leaving the ground', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    const dt = 1 / 60
    let worst = 0
    let steepest = 0
    let frames = 0

    // Eight bearings from eight start points: a lawnmower pattern would miss the
    // escarpment approached obliquely, which is the interesting case for the slide path.
    const starts: readonly [number, number][] = [
      [40, 40],
      [980, 40],
      [40, 980],
      [980, 980],
      [512, 20],
      [20, 512],
      [512, 1000],
      [660, 512],
    ]
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i] as [number, number]
      w.moveTo(start[0], start[1])
      const bearing = (i / starts.length) * Math.PI * 2 + 0.4
      const r = traverse(w, terrain, bearing, 100, dt)
      worst = Math.max(worst, r.worstEyeError)
      steepest = Math.max(steepest, r.worstSlopeSeen)
      frames += r.samples
    }

    expect(frames).toBeGreaterThan(40_000)
    // The traverse must actually have visited steep ground, or the test proves nothing.
    expect(steepest).toBeGreaterThan(1.0)
    // Eye tracks ground within a boot's height at 12 m/s over every slope in the domain.
    expect(worst).toBeLessThan(0.3)
  })

  it('holds the eye glued while running straight down the 72-degree escarpment', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    // Start on top of the escarpment (east side) and run west, i.e. straight down it.
    w.moveTo(terrain.escarpmentCentreX + 40, 500)
    const r = traverse(w, terrain, (270 * Math.PI) / 180, 12, 1 / 60)
    expect(r.worstSlopeSeen).toBeGreaterThan(1.9) // the cliff really was descended
    expect(r.worstEyeError).toBeLessThan(DEFAULT_WALKER_CONFIG.maxEyeLagM)
    // Descent is smooth, not a series of drops: bound the vertical acceleration.
    expect(r.maxVerticalAccel).toBeLessThan(400)
  })

  it('refuses to climb the escarpment and slides along it instead of tunnelling', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    const startX = terrain.escarpmentCentreX - 30 // at the foot, west side
    w.moveTo(startX, 500)
    const baseHeight = terrain.heightAt(M(startX), M(500))
    const r = traverse(w, terrain, (90 * Math.PI) / 180, 10, 1 / 60) // due east, uphill

    expect(r.blockedFrames).toBeGreaterThan(0) // the climb limit actually engaged
    const end = w.pose.position
    // Did NOT end up on top of the escarpment: it is 48 m high and the walker may only
    // ascend tan(50 deg). Anything that gained most of that height has tunnelled.
    const climbed = terrain.heightAt(M(end.x), M(end.z)) - baseHeight
    expect(climbed).toBeLessThan(30)
    expect(r.worstEyeError).toBeLessThan(0.3)

    // No step in the path may exceed the climb limit for its own horizontal length.
    for (let i = 1; i < r.path.length; i++) {
      const a = r.path[i - 1] as { x: number; z: number }
      const b = r.path[i] as { x: number; z: number }
      const horiz = Math.hypot(b.x - a.x, b.z - a.z)
      const rise = terrain.heightAt(M(b.x), M(b.z)) - terrain.heightAt(M(a.x), M(a.z))
      if (horiz > 1e-6) {
        expect(rise / horiz).toBeLessThan(DEFAULT_WALKER_CONFIG.maxClimbTan + 0.35)
      }
    }
  })

  it('does not tunnel at low frame rates', () => {
    // 12 m/s at 15 fps is a 0.8 m step — 1.6 surface cells. Without substepping the
    // walker steps clean over a ridge crest.
    const terrain = new StubTerrain()
    const dt = 1 / 15
    const w = new WalkerController(terrain)
    w.moveTo(terrain.escarpmentCentreX - 30, 400)
    const r = traverse(w, terrain, (90 * Math.PI) / 180, 10, dt)
    expect(r.worstEyeError).toBeLessThan(0.4)
    expect(w.debug.substepsLastFrame).toBeGreaterThan(1) // substepping was actually used
    const climbed =
      terrain.heightAt(M(w.pose.position.x), M(w.pose.position.z)) -
      terrain.heightAt(M(terrain.escarpmentCentreX - 30), M(400))
    expect(climbed).toBeLessThan(30)
  })

  it('survives frame-time spikes without popping off the ground', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    w.moveTo(300, 300)
    w.setOrientation(1.0, 0)
    let worst = 0
    for (let i = 0; i < 900; i++) {
      // Alternating 144 fps and a 100 ms hitch, which is what a shader compile looks like.
      const dt = i % 17 === 0 ? 0.1 : 1 / 144
      w.update(S(dt), walk({ sprint: true }))
      worst = Math.max(worst, Math.abs(w.debug.eyeErrorM))
      expect(w.pose.position.y).toBeGreaterThan(w.debug.groundRawM)
    }
    expect(worst).toBeLessThan(DEFAULT_WALKER_CONFIG.maxEyeLagM + 1e-6)
  })

  it('does not judder on gentle terrain: vertical motion is smooth frame to frame', () => {
    const terrain = new StubTerrain({ escarpmentHeightM: 0, detailAmplitudeM: 3 })
    const w = new WalkerController(terrain)
    w.moveTo(200, 600)
    const dt = 1 / 60
    const r = traverse(w, terrain, 0.9, 30, dt, walk())
    // Walking at 5 m/s over 3 m bumps of 41 m wavelength, the ground itself accelerates by
    // at most v^2 * h'' ~= 25 * 0.07 = 1.8 m/s^2. Allow generous headroom but still catch
    // per-frame snapping, which produces accelerations in the hundreds.
    expect(r.maxVerticalAccel).toBeLessThan(25)
    expect(r.worstEyeError).toBeLessThan(0.1)
  })

  it('crouches and stands smoothly, with the eye never crossing the ground', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    w.moveTo(400, 400)
    const dt = 1 / 60
    const heights: number[] = []
    for (let i = 0; i < 240; i++) {
      const crouching = i > 60 && i < 180
      w.update(S(dt), walk({ crouch: crouching, moveForward: 0 }))
      heights.push(w.pose.position.y - w.debug.groundRawM)
      expect(w.pose.position.y).toBeGreaterThan(w.debug.groundRawM)
    }
    const standing = heights[50] as number
    const crouched = heights[170] as number
    const restood = heights[239] as number
    expect(crouched).toBeLessThan(standing * 0.7)
    expect(restood).toBeCloseTo(standing, 2)
    // The transition is continuous and does not overshoot: the eye is always between the
    // crouched and standing heights, and no single frame moves it more than the crouch
    // rate allows (9 /s over 0.765 m of travel at 60 fps = 0.115 m).
    for (let i = 1; i < heights.length; i++) {
      const h = heights[i] as number
      expect(h).toBeGreaterThan(standing * 0.5 - 0.05)
      expect(h).toBeLessThan(standing + 0.05)
      expect(Math.abs(h - (heights[i - 1] as number))).toBeLessThan(0.12)
    }
  })

  it('honours a changed standing eye height', () => {
    const terrain = new StubTerrain()
    const w = new WalkerController(terrain)
    w.standingEyeHeightM = 2.4
    w.moveTo(500, 500)
    expect(w.pose.position.y - w.debug.groundRawM).toBeCloseTo(2.4, 1)
  })

  it('is speed-limited: sprint is faster than walk, crouch is slower', () => {
    const terrain = new StubTerrain({ hillAmplitudeM: 0, ridgeAmplitudeM: 0, detailAmplitudeM: 0, escarpmentHeightM: 0 })
    const distance = (input: InputSnapshot): number => {
      const w = new WalkerController(terrain)
      w.moveTo(100, 500)
      const start = w.pose.position
      for (let i = 0; i < 300; i++) w.update(S(1 / 60), input)
      const end = w.pose.position
      return Math.hypot(end.x - start.x, end.z - start.z)
    }
    const walkD = distance(walk())
    const sprintD = distance(walk({ sprint: true }))
    const crouchD = distance(walk({ crouch: true }))
    expect(sprintD).toBeGreaterThan(walkD * 1.5)
    expect(crouchD).toBeLessThan(walkD * 0.6)
    // 5 m/s for 5 s, minus the acceleration ramp.
    expect(walkD).toBeGreaterThan(23)
    expect(walkD).toBeLessThan(25.1)
  })

  it('does not move faster diagonally', () => {
    const terrain = new StubTerrain({ hillAmplitudeM: 0, ridgeAmplitudeM: 0, detailAmplitudeM: 0, escarpmentHeightM: 0 })
    const run = (input: InputSnapshot): number => {
      const w = new WalkerController(terrain)
      w.moveTo(100, 500)
      const s = w.pose.position
      for (let i = 0; i < 300; i++) w.update(S(1 / 60), input)
      const e = w.pose.position
      return Math.hypot(e.x - s.x, e.z - s.z)
    }
    const straight = run(walk())
    const diagonal = run(walk({ moveRight: 1 }))
    expect(diagonal).toBeCloseTo(straight, 3)
  })
})
