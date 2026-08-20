/**
 * Free / drone camera — WP 1.8.
 *
 * Six degrees of freedom, roll-free by construction (orientation is stored as yaw/pitch,
 * never as a quaternion, so no sequence of look deltas can tilt the horizon).
 *
 * The speed range this camera has to cover is the awkward part. Inspecting a single grass
 * tuft wants ~0.5 m/s; crossing the 1 km domain to look at the far ridge wants ~200 m/s.
 * That is a factor of 400, so the speed control is MULTIPLICATIVE (each wheel notch scales
 * by a constant factor) rather than additive — a linear control would be unusable at one
 * end or the other.
 *
 * Motion is velocity-based with symmetric acceleration and damping. Both are the EXACT
 * solution of `dv/dt = -k (v - vTarget)` over the step, including the exact displacement
 * integral, rather than `v += (vt - v) * k * dt; p += v * dt`:
 *
 *   - The exact form cannot overshoot or oscillate for any dt or any k. The naive
 *     semi-implicit form is unstable once `k * dt > 2`, and at k = 6 that is a 333 ms
 *     frame — which happens during shader compilation, so it is not hypothetical.
 *   - Using the exact displacement integral instead of `v_new * dt` removes a first-order
 *     error that shows up as the camera drifting past its stopping point by an amount that
 *     depends on frame rate. A camera whose stopping distance changes with frame rate is
 *     unpleasant to fly and impossible to script a test against.
 */

import { DOMAIN_SIZE_M } from '@contracts/world'
import type { Metres, Seconds } from '@contracts/units'
import {
  MAX_PITCH,
  clamp,
  dampedVelocityStep,
  forwardFromYawPitch,
  normalizeAngle2Pi,
  v3,
  vCross,
  vNormalize,
  type Vec3,
} from './math.ts'
import type { CameraPose } from './pose.ts'
import type { InputSnapshot } from './input.ts'
import type { TerrainSampler } from './terrainStub.ts'

export interface FreeCameraConfig {
  /** Slowest cruise speed. Slow enough to inspect a grass blade. */
  readonly minSpeedMps: number
  /** Fastest cruise speed. Crosses the 1 km domain in ~5 s. */
  readonly maxSpeedMps: number
  readonly defaultSpeedMps: number
  /** Multiplicative speed change per wheel notch. 1.25 gives ~27 notches across the range. */
  readonly speedStepFactor: number
  /** Sprint multiplier applied on top of the cruise speed. */
  readonly sprintMultiplier: number
  /** Fine-control multiplier while the slow modifier is held. */
  readonly slowMultiplier: number
  /**
   * Velocity damping/acceleration rate, 1/s. Time constant 1/k; the camera reaches 95% of
   * a new target speed in 3/k seconds and coasts to a stop over roughly the same time.
   */
  readonly accelRate: number
  /** When true the camera cannot pass below the terrain surface. */
  readonly collideWithTerrain: boolean
  /** Minimum clearance above ground when collision is enabled. */
  readonly minClearanceM: number
  /** Ceiling, metres above sea level. Above this there is nothing to look at. */
  readonly maxAltitudeM: number
  /** How far outside the domain the camera may fly, so the domain can be viewed from outside. */
  readonly outsideMarginM: number
}

export const DEFAULT_FREE_CAMERA_CONFIG: FreeCameraConfig = {
  minSpeedMps: 0.5,
  maxSpeedMps: 200,
  defaultSpeedMps: 12,
  speedStepFactor: 1.25,
  sprintMultiplier: 4,
  slowMultiplier: 0.25,
  accelRate: 6,
  collideWithTerrain: false,
  minClearanceM: 1.5,
  maxAltitudeM: 3000,
  outsideMarginM: 256,
}

export class FreeCameraController {
  readonly config: FreeCameraConfig

  private pos: Vec3
  private vel = v3(0, 0, 0)
  private yaw = 0
  private pitch = 0
  private speed: number
  private collide: boolean
  /** True on any frame the position was clamped by terrain, ceiling or domain bounds. */
  private clampedThisFrame = false

  constructor(
    private readonly terrain: TerrainSampler,
    config: Partial<FreeCameraConfig> = {},
  ) {
    this.config = { ...DEFAULT_FREE_CAMERA_CONFIG, ...config }
    this.speed = clamp(this.config.defaultSpeedMps, this.config.minSpeedMps, this.config.maxSpeedMps)
    this.collide = this.config.collideWithTerrain
    const cx = DOMAIN_SIZE_M / 2
    this.pos = v3(cx, this.groundAt(cx, cx) + 60, cx)
  }

  // -------------------------------------------------------------------------
  // Pose and settings
  // -------------------------------------------------------------------------

  get pose(): CameraPose {
    return { position: v3(this.pos.x, this.pos.y, this.pos.z), yaw: this.yaw, pitch: this.pitch }
  }

  /** Cruise speed in m/s, before the sprint/slow modifiers. */
  get cruiseSpeedMps(): number {
    return this.speed
  }
  set cruiseSpeedMps(v: number) {
    this.speed = clamp(v, this.config.minSpeedMps, this.config.maxSpeedMps)
  }

  get terrainCollisionEnabled(): boolean {
    return this.collide
  }
  set terrainCollisionEnabled(v: boolean) {
    this.collide = v
  }

  get velocity(): Vec3 {
    return v3(this.vel.x, this.vel.y, this.vel.z)
  }

  get wasClamped(): boolean {
    return this.clampedThisFrame
  }

  setOrientation(yaw: number, pitch: number): void {
    this.yaw = normalizeAngle2Pi(yaw)
    this.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH)
  }

  /** Place the camera. Velocity is cleared so a teleport does not carry momentum. */
  setPosition(x: number, y: number, z: number): void {
    this.pos = v3(x, y, z)
    this.vel = v3(0, 0, 0)
    this.applyBounds()
  }

  /** Adopt another controller's pose exactly, for a mode change. */
  adoptPose(pose: CameraPose): void {
    this.setPosition(pose.position.x, pose.position.y, pose.position.z)
    this.setOrientation(pose.yaw, pose.pitch)
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt: Seconds, input: InputSnapshot): void {
    if (!(dt > 0)) return
    const c = this.config

    this.yaw = normalizeAngle2Pi(this.yaw + input.lookYaw)
    this.pitch = clamp(this.pitch + input.lookPitch, -MAX_PITCH, MAX_PITCH)

    if (input.scroll !== 0) {
      this.speed = clamp(
        this.speed * Math.pow(c.speedStepFactor, input.scroll),
        c.minSpeedMps,
        c.maxSpeedMps,
      )
    }

    // Basis. Vertical movement uses WORLD up, not camera up: a drone that drifts sideways
    // when you press "ascend" while pitched down is disorienting, and it is also how every
    // flying camera the user has ever used behaves.
    const fwd = forwardFromYawPitch(this.yaw, this.pitch)
    const right = vNormalize(vCross(fwd, v3(0, 1, 0)))

    // `crouch` shares its key binding with "move down"; in free mode that key means descend,
    // so the slow modifier is only honoured when it is NOT also producing vertical motion.
    // Otherwise every descent would silently drop to quarter speed.
    const slow = input.crouch && input.moveUp >= 0
    const speed =
      this.speed * (input.sprint ? c.sprintMultiplier : 1) * (slow ? c.slowMultiplier : 1)

    let tx = fwd.x * input.moveForward + right.x * input.moveRight
    let ty = fwd.y * input.moveForward + right.y * input.moveRight + input.moveUp
    let tz = fwd.z * input.moveForward + right.z * input.moveRight
    const len = Math.hypot(tx, ty, tz)
    if (len > 1e-9) {
      // Normalise so a diagonal is not faster than a straight line.
      const k = speed / len
      tx *= k
      ty *= k
      tz *= k
    } else {
      tx = 0
      ty = 0
      tz = 0
    }

    const sx = dampedVelocityStep(this.vel.x, tx, c.accelRate, dt)
    const sy = dampedVelocityStep(this.vel.y, ty, c.accelRate, dt)
    const sz = dampedVelocityStep(this.vel.z, tz, c.accelRate, dt)
    this.vel = v3(sx.velocity, sy.velocity, sz.velocity)
    this.pos = v3(
      this.pos.x + sx.displacement,
      this.pos.y + sy.displacement,
      this.pos.z + sz.displacement,
    )

    this.applyBounds()
  }

  // -------------------------------------------------------------------------
  // Bounds
  // -------------------------------------------------------------------------

  /**
   * Terrain, ceiling and domain limits. Each clamp also removes the velocity component
   * pushing into it — leaving it in place lets velocity integrate against a wall, and the
   * camera then lurches when it is finally released.
   */
  private applyBounds(): void {
    this.clampedThisFrame = false
    const c = this.config
    const lo = -c.outsideMarginM
    const hi = DOMAIN_SIZE_M + c.outsideMarginM

    const cx = clamp(this.pos.x, lo, hi)
    const cz = clamp(this.pos.z, lo, hi)
    if (cx !== this.pos.x) {
      this.pos.x = cx
      this.vel.x = 0
      this.clampedThisFrame = true
    }
    if (cz !== this.pos.z) {
      this.pos.z = cz
      this.vel.z = 0
      this.clampedThisFrame = true
    }

    if (this.collide) {
      const floor = this.groundAt(this.pos.x, this.pos.z) + c.minClearanceM
      if (this.pos.y < floor) {
        this.pos.y = floor
        if (this.vel.y < 0) this.vel.y = 0
        this.clampedThisFrame = true
      }
    }
    if (this.pos.y > c.maxAltitudeM) {
      this.pos.y = c.maxAltitudeM
      if (this.vel.y > 0) this.vel.y = 0
      this.clampedThisFrame = true
    }
  }

  /**
   * Terrain height, with the sample point clamped into the domain. The camera is allowed
   * outside the domain; the terrain field is not required to be defined there, so the edge
   * height is extended outward rather than extrapolated.
   */
  private groundAt(x: number, z: number): number {
    return this.terrain.heightAt(
      clamp(x, 0, DOMAIN_SIZE_M) as Metres,
      clamp(z, 0, DOMAIN_SIZE_M) as Metres,
    )
  }
}
