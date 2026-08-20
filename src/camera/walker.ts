/**
 * First-person walker — WP 1.8.
 *
 * The two failure modes this controller exists to avoid, per the acceptance criterion
 * ("walker stays on terrain across the full domain; no tunnelling on steep slopes"):
 *
 *   TUNNELLING. A 12 m/s sprint at 30 fps is a 0.4 m step — nearly a full surface cell.
 *   Sampling the height only at the destination lets the walker step straight over the
 *   crest of a thin ridge or through the face of an escarpment. So the horizontal move is
 *   SUBSTEPPED at `substepM` (a quarter of a 0.5 m surface cell) and each substep is
 *   validated against the previous one. Cost is a handful of height samples per frame.
 *
 *   JUDDER. Snapping the eye to `heightAt(x, z) + eyeHeight` every frame reproduces every
 *   sub-metre bump in the heightfield as a vertical jolt, and clamping a naive spring
 *   makes it worse. Two independent mechanisms handle it:
 *     - a SPATIAL footprint filter (the eye rides the average height over a foot-sized
 *       disc, not a single sample), which removes bumps at any walking speed; and
 *     - a TEMPORAL critically-damped spring WITH TARGET-VELOCITY FEED-FORWARD, so
 *       descending a constant slope has zero steady-state lag. Without feed-forward the
 *       lag is 2v/omega, which on the 63-degree test escarpment at sprint speed is over a
 *       metre of the camera sinking into the hill.
 *
 * There is no gravity and no jumping in M1 — the walker is glued to the surface. That is a
 * deliberate scope decision, not an omission: nothing in the fire simulation needs
 * ballistics, and a falling body would need a collision volume the terrain contract does
 * not provide.
 */

import { DOMAIN_SIZE_M } from '@contracts/world'
import type { Metres, Seconds } from '@contracts/units'
import {
  MAX_PITCH,
  clamp,
  criticallyDampedStep,
  expBlend,
  forwardFromYawPitch,
  normalizeAngle2Pi,
  v3,
} from './math.ts'
import type { CameraPose } from './pose.ts'
import type { InputSnapshot } from './input.ts'
import type { TerrainSampler } from './terrainStub.ts'

export interface WalkerConfig {
  /** Standing eye height above ground. */
  readonly eyeHeightM: number
  /** Crouched eye height as a fraction of standing. */
  readonly crouchFraction: number
  /** Level-ground walking speed, m/s. */
  readonly walkSpeedMps: number
  /** Sprint speed, m/s. Faster than a human, because the domain is 1 km across. */
  readonly sprintSpeedMps: number
  /** Crouched speed as a fraction of walking. */
  readonly crouchSpeedFraction: number
  /** Horizontal acceleration rate, 1/s. Higher = snappier. */
  readonly accelRate: number
  /**
   * Steepest tangent the walker may ascend. tan(50 deg) ~= 1.19. Above this the move is
   * redirected along the contour, so a cliff blocks rather than being climbed or clipped.
   */
  readonly maxClimbTan: number
  /** Maximum horizontal distance per collision substep. Half a 0.5 m surface cell. */
  readonly substepM: number
  /** Radius of the footprint filter. Roughly a boot. */
  readonly footprintRadiusM: number
  /** Ring samples in the footprint filter (plus one at the centre). */
  readonly footprintSamples: number
  /** Natural frequency of the eye-height spring, rad/s. Settling time ~ 4.7/omega. */
  readonly eyeOmega: number
  /** Hard bound on |eye - (ground + eyeHeight)|. The guarantee that the eye stays glued. */
  readonly maxEyeLagM: number
  /** The eye may never be closer than this to the ground, whatever the spring says. */
  readonly minClearanceM: number
  /** Rate at which the crouch/stand height transition blends, 1/s. */
  readonly crouchRate: number
  /** Keep-out from the domain edge, metres. */
  readonly domainMarginM: number
}

export const DEFAULT_WALKER_CONFIG: WalkerConfig = {
  eyeHeightM: 1.7,
  crouchFraction: 0.55,
  walkSpeedMps: 5,
  sprintSpeedMps: 12,
  crouchSpeedFraction: 0.35,
  accelRate: 16,
  maxClimbTan: Math.tan((50 * Math.PI) / 180),
  substepM: 0.25,
  footprintRadiusM: 0.4,
  footprintSamples: 6,
  eyeOmega: 18,
  maxEyeLagM: 0.35,
  minClearanceM: 0.25,
  crouchRate: 9,
  domainMarginM: 1,
}

export interface WalkerDebug {
  /** True on any frame a substep was refused because the rise exceeded `maxClimbTan`. */
  readonly blockedThisFrame: boolean
  /** Number of collision substeps taken last frame. */
  readonly substepsLastFrame: number
  /** Footprint-filtered ground height under the eye. */
  readonly groundSmoothM: number
  /** Raw terrain height under the eye. */
  readonly groundRawM: number
  /** eye - (rawGround + currentEyeHeight). The quantity the acceptance test bounds. */
  readonly eyeErrorM: number
}

export class WalkerController {
  readonly config: WalkerConfig

  private x = DOMAIN_SIZE_M / 2
  private z = DOMAIN_SIZE_M / 2
  private yaw = 0
  private pitch = 0
  private velX = 0
  private velZ = 0
  private eyeY = 0
  private eyeVelY = 0
  /** Blended standing/crouched eye height, so crouching is smooth without a second spring. */
  private currentEyeHeight: number
  private prevTarget = 0

  private blocked = false
  private substeps = 0
  private groundSmooth = 0
  private groundRaw = 0

  /** Settable through `ICameraRig.eyeHeightM`. */
  standingEyeHeightM: number

  constructor(
    private readonly terrain: TerrainSampler,
    config: Partial<WalkerConfig> = {},
  ) {
    this.config = { ...DEFAULT_WALKER_CONFIG, ...config }
    this.standingEyeHeightM = this.config.eyeHeightM
    this.currentEyeHeight = this.standingEyeHeightM
    this.snapToGround()
  }

  // -------------------------------------------------------------------------
  // Pose
  // -------------------------------------------------------------------------

  get pose(): CameraPose {
    return { position: v3(this.x, this.eyeY, this.z), yaw: this.yaw, pitch: this.pitch }
  }

  setOrientation(yaw: number, pitch: number): void {
    this.yaw = normalizeAngle2Pi(yaw)
    this.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH)
  }

  /** Teleport. Snaps the eye instantly — a teleport that then springs would look broken. */
  moveTo(x: number, z: number): void {
    const margin = this.config.domainMarginM
    this.x = clamp(x, margin, DOMAIN_SIZE_M - margin)
    this.z = clamp(z, margin, DOMAIN_SIZE_M - margin)
    this.velX = 0
    this.velZ = 0
    this.snapToGround()
  }

  /**
   * Place the eye exactly at ground + eye height with zero vertical velocity.
   * Also used when entering first-person from the free camera at a new location.
   */
  snapToGround(): void {
    this.groundRaw = this.terrain.heightAt(this.x as Metres, this.z as Metres)
    this.groundSmooth = this.sampleFootprint(this.x, this.z)
    this.currentEyeHeight = this.standingEyeHeightM
    this.eyeY = this.groundSmooth + this.currentEyeHeight
    this.prevTarget = this.eyeY
    this.eyeVelY = 0
  }

  get debug(): WalkerDebug {
    return {
      blockedThisFrame: this.blocked,
      substepsLastFrame: this.substeps,
      groundSmoothM: this.groundSmooth,
      groundRawM: this.groundRaw,
      eyeErrorM: this.eyeY - (this.groundRaw + this.currentEyeHeight),
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt: Seconds, input: InputSnapshot): void {
    if (!(dt > 0)) return
    const c = this.config

    this.yaw = normalizeAngle2Pi(this.yaw + input.lookYaw)
    this.pitch = clamp(this.pitch + input.lookPitch, -MAX_PITCH, MAX_PITCH)

    // --- horizontal target velocity, in the yaw frame only. Looking up must not slow
    //     you down, so pitch is deliberately excluded from the movement basis.
    const sy = Math.sin(this.yaw)
    const cy = Math.cos(this.yaw)
    // forward = (sin yaw, -cos yaw); right = (cos yaw, sin yaw) in (x, z).
    let dirX = input.moveForward * sy + input.moveRight * cy
    let dirZ = input.moveForward * -cy + input.moveRight * sy
    const dirLen = Math.hypot(dirX, dirZ)
    if (dirLen > 0) {
      dirX /= dirLen
      dirZ /= dirLen
    }

    const speed = input.crouch
      ? c.walkSpeedMps * c.crouchSpeedFraction
      : input.sprint
        ? c.sprintSpeedMps
        : c.walkSpeedMps
    const blend = expBlend(c.accelRate, dt)
    this.velX += (dirX * speed - this.velX) * blend
    this.velZ += (dirZ * speed - this.velZ) * blend

    this.moveHorizontal(this.velX * dt, this.velZ * dt)

    // --- eye height: blend the crouch offset first so the spring only ever sees a
    //     continuous target, then track the footprint-filtered ground.
    const targetEyeHeight = input.crouch
      ? this.standingEyeHeightM * c.crouchFraction
      : this.standingEyeHeightM
    this.currentEyeHeight += (targetEyeHeight - this.currentEyeHeight) * expBlend(c.crouchRate, dt)

    this.groundRaw = this.terrain.heightAt(this.x as Metres, this.z as Metres)
    this.groundSmooth = this.sampleFootprint(this.x, this.z)

    const target = this.groundSmooth + this.currentEyeHeight
    const previousTarget = this.prevTarget
    const step = criticallyDampedStep(
      this.eyeY,
      this.eyeVelY,
      previousTarget,
      target,
      c.eyeOmega,
      dt,
    )
    this.eyeY = step.value
    this.eyeVelY = step.velocity
    this.prevTarget = target

    // Hard guarantees the spring alone cannot give. Both are no-ops in normal walking;
    // they only fire on a discontinuity (teleport, cliff edge, frame spike).
    const lagLo = target - c.maxEyeLagM
    const lagHi = target + c.maxEyeLagM
    if (this.eyeY < lagLo || this.eyeY > lagHi) {
      this.eyeY = clamp(this.eyeY, lagLo, lagHi)
      // Hand the spring the TARGET's own velocity when clamped. Leaving the old spring
      // velocity in place keeps it pushing against the clamp, and the first unclamped
      // frame afterwards then jumps; zeroing it instead stalls the eye on a slope, which
      // re-triggers the clamp every frame and reads as sticking.
      this.eyeVelY = (target - previousTarget) / dt
    }
    const floor = this.groundRaw + c.minClearanceM
    if (this.eyeY < floor) {
      this.eyeY = floor
      this.eyeVelY = 0
    }
  }

  // -------------------------------------------------------------------------
  // Movement with terrain collision
  // -------------------------------------------------------------------------

  /**
   * Substepped horizontal move. Each substep is accepted only if the rise over it is
   * within the climb limit; otherwise the move is redirected along the contour (so the
   * walker slides along a cliff face rather than sticking to it), and if that is still
   * too steep the remaining motion is discarded.
   */
  private moveHorizontal(dx: number, dz: number): void {
    this.blocked = false
    this.substeps = 0
    const c = this.config
    const dist = Math.hypot(dx, dz)
    if (dist <= 0) return

    const n = Math.max(1, Math.ceil(dist / c.substepM))
    this.substeps = n
    const stepLen = dist / n
    let ux = dx / dist
    let uz = dz / dist
    let curH = this.terrain.heightAt(this.x as Metres, this.z as Metres)
    const margin = c.domainMarginM
    const hi = DOMAIN_SIZE_M - margin

    for (let i = 0; i < n; i++) {
      let nx = clamp(this.x + ux * stepLen, margin, hi)
      let nz = clamp(this.z + uz * stepLen, margin, hi)
      let nh = this.terrain.heightAt(nx as Metres, nz as Metres)

      if (nh - curH > c.maxClimbTan * stepLen) {
        this.blocked = true
        // Contour tangent at the current point. `aspectAt` is the DOWNSLOPE azimuth, so
        // downhill in (x, z) is (sin a, -cos a) and the contour is perpendicular to it.
        const a = this.terrain.aspectAt(this.x as Metres, this.z as Metres)
        const tx = Math.cos(a)
        const tz = Math.sin(a)
        const along = ux * tx + uz * tz
        if (Math.abs(along) < 1e-6) break
        const sx = tx * Math.sign(along)
        const sz = tz * Math.sign(along)
        const slideLen = stepLen * Math.abs(along)
        nx = clamp(this.x + sx * slideLen, margin, hi)
        nz = clamp(this.z + sz * slideLen, margin, hi)
        nh = this.terrain.heightAt(nx as Metres, nz as Metres)
        if (nh - curH > c.maxClimbTan * Math.max(slideLen, 1e-6)) break
        // Commit to sliding for the rest of the move and drop the into-slope velocity.
        ux = sx
        uz = sz
        const speed = Math.hypot(this.velX, this.velZ)
        this.velX = sx * speed * Math.abs(along)
        this.velZ = sz * speed * Math.abs(along)
      }

      this.x = nx
      this.z = nz
      curH = nh
    }
  }

  /**
   * Mean terrain height over a foot-sized disc. Exact for a plane (the ring is symmetric),
   * so it costs nothing on a uniform slope and only removes curvature at scales below the
   * footprint — which is precisely the sub-metre chatter that reads as judder.
   */
  private sampleFootprint(x: number, z: number): number {
    const c = this.config
    const n = c.footprintSamples
    if (n <= 0 || c.footprintRadiusM <= 0) {
      return this.terrain.heightAt(x as Metres, z as Metres)
    }
    // Centre carries half the weight; the ring shares the other half.
    let sum = this.terrain.heightAt(x as Metres, z as Metres) * 0.5
    const ringWeight = 0.5 / n
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2
      const sx = x + Math.cos(th) * c.footprintRadiusM
      const sz = z + Math.sin(th) * c.footprintRadiusM
      sum += this.terrain.heightAt(sx as Metres, sz as Metres) * ringWeight
    }
    return sum
  }

  /** Forward unit vector, including pitch. */
  get forward() {
    return forwardFromYawPitch(this.yaw, this.pitch)
  }
}
