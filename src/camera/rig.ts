/**
 * Camera rig — WP 1.8. Implements `ICameraRig` and produces `CameraState`.
 *
 * Owns the two controllers, the input state machine, the mode transition, and the matrix
 * assembly. Everything a sibling package touches goes through `state`.
 *
 * DEPTH CONVENTION: reversed-Z with a float depth buffer. See the long note at the top of
 * `math.ts` — every consumer of a depth buffer must use `DEPTH_FORMAT`, `DEPTH_COMPARE`
 * and `DEPTH_CLEAR_VALUE` exported from there, and any shader reconstructing world space
 * from depth must feed the raw 0..1 depth sample into `invViewProjMatrix` unmodified.
 *
 * MODE TRANSITION. Switching from a 200 m drone shot to the walker moves the eye ~200 m; a
 * cut there is disorienting and, worse, invalidates any temporal reprojection running that
 * frame (M4 depends on frame-to-frame camera continuity). So the rendered pose is blended
 * from the pose at the moment of the switch to the incoming controller's LIVE pose over
 * `transitionSeconds`, with a smoothstep weight so the blend starts and ends with zero
 * derivative. The incoming controller is driven by input throughout, so control is never
 * taken away from the user mid-transition — only the displayed pose is interpolated.
 */

import { DOMAIN_SIZE_M } from '@contracts/world'
import type { CameraMode, CameraState, } from '@contracts/render'
import type { Metres, Radians, Seconds } from '@contracts/units'
import {
  FRUSTUM_FLOATS,
  MAX_PITCH,
  REVERSED_Z,
  clamp,
  extractFrustumPlanes,
  forwardFromYawPitch,
  lerpAngle,
  mat4Create,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  smoothstep01,
  v3,
  vCross,
  vNormalize,
  type Mat4,
  type Vec3,
} from './math.ts'
import { CameraInput, DomInputBinding, type InputConfig, type InputSnapshot } from './input.ts'
import type { CameraPose } from './pose.ts'
import { FreeCameraController, type FreeCameraConfig } from './freeCamera.ts'
import { WalkerController, type WalkerConfig } from './walker.ts'
import { StubTerrain, type TerrainSampler } from './terrainStub.ts'

export interface CameraRigConfig {
  readonly verticalFovRad: number
  readonly nearM: number
  readonly farM: number
  readonly aspect: number
  /** Duration of the smooth blend between camera modes. */
  readonly transitionSeconds: number
  /** Reversed-Z. Exposed only so a debug view can turn it off; leave it alone. */
  readonly reverseZ: boolean
  readonly startMode: CameraMode
  /** Largest wall-clock step the controllers will see. Protects against tab-switch spikes. */
  readonly maxStepSeconds: number
}

/**
 * Near at 5 cm so the walker can put its face into a grass tuft; far at 8 km so distant
 * ridges and the sky dome are inside the frustum. That ratio (1:160000) is exactly why this
 * project uses reversed-Z with a float depth buffer — a 24-bit unorm depth buffer with a
 * conventional mapping would z-fight visibly past a few hundred metres.
 */
export const DEFAULT_RIG_CONFIG: CameraRigConfig = {
  verticalFovRad: (60 * Math.PI) / 180,
  nearM: 0.05,
  farM: 8000,
  aspect: 16 / 9,
  transitionSeconds: 0.7,
  reverseZ: REVERSED_Z,
  startMode: 'first-person',
  maxStepSeconds: 0.1,
}

export interface CameraRigOptions {
  readonly rig?: Partial<CameraRigConfig>
  readonly walker?: Partial<WalkerConfig>
  readonly free?: Partial<FreeCameraConfig>
  readonly input?: Partial<InputConfig>
}

/**
 * Mutable backing for `CameraState`.
 *
 * The typed arrays and the position/forward/up tuples are allocated ONCE and rewritten in
 * place every frame, so a per-frame `queue.writeBuffer` of the matrices allocates nothing.
 * A consumer that needs to retain a value across frames must copy it.
 */
class MutableCameraState implements CameraState {
  readonly position: [Metres, Metres, Metres] = [0 as Metres, 0 as Metres, 0 as Metres]
  readonly forward: [number, number, number] = [0, 0, -1]
  readonly up: [number, number, number] = [0, 1, 0]
  readonly viewMatrix: Float32Array = mat4Create()
  readonly projMatrix: Float32Array = mat4Create()
  readonly viewProjMatrix: Float32Array = mat4Create()
  readonly invViewProjMatrix: Float32Array = mat4Create()
  readonly frustumPlanes: Float32Array = new Float32Array(FRUSTUM_FLOATS)
  verticalFov: Radians = 0 as Radians
  nearM: Metres = 0 as Metres
  farM: Metres = 0 as Metres
  aspect = 1
}

export class CameraRig {
  readonly config: CameraRigConfig
  readonly walker: WalkerController
  readonly free: FreeCameraController
  readonly input: CameraInput

  private readonly binding: DomInputBinding
  private readonly terrain: TerrainSampler
  private readonly stateImpl = new MutableCameraState()

  private currentMode: CameraMode
  /** Pose the transition blends FROM. Fixed at the moment of the switch. */
  private transitionFrom: CameraPose | null = null
  private transitionRemaining = 0

  /** Last rendered pose — the blend result, not either controller's raw pose. */
  private renderPose: CameraPose

  private fovRad: number
  private near: number
  private far: number
  private aspectRatio: number

  constructor(terrain?: TerrainSampler, options: CameraRigOptions = {}) {
    this.terrain = terrain ?? new StubTerrain()
    this.config = { ...DEFAULT_RIG_CONFIG, ...(options.rig ?? {}) }
    this.fovRad = this.config.verticalFovRad
    this.near = this.config.nearM
    this.far = this.config.farM
    this.aspectRatio = this.config.aspect

    this.walker = new WalkerController(this.terrain, options.walker ?? {})
    this.free = new FreeCameraController(this.terrain, options.free ?? {})
    this.input = new CameraInput(options.input ?? {})
    this.binding = new DomInputBinding(this.input)

    this.currentMode = this.config.startMode
    // Start both controllers co-located so the first mode switch is not a 60 m jump.
    this.free.adoptPose(this.walker.pose)
    this.renderPose = this.activeController.pose
    this.rebuildState()
  }

  // -------------------------------------------------------------------------
  // ICameraRig
  // -------------------------------------------------------------------------

  get mode(): CameraMode {
    return this.currentMode
  }

  get state(): CameraState {
    return this.stateImpl
  }

  setMode(mode: CameraMode): void {
    if (mode === this.currentMode) return
    const from: CameraPose = {
      position: v3(this.renderPose.position.x, this.renderPose.position.y, this.renderPose.position.z),
      yaw: this.renderPose.yaw,
      pitch: this.renderPose.pitch,
    }

    if (mode === 'free') {
      // The drone starts exactly where the walker's eye was, so only the control model
      // changes and the blend is a no-op that costs nothing.
      this.free.adoptPose(from)
    } else {
      // The walker cannot be at the drone's altitude: it takes the drone's ground position
      // and orientation and stands up there. The blend then flies the view down to it.
      this.walker.moveTo(from.position.x, from.position.z)
      this.walker.setOrientation(from.yaw, from.pitch)
    }

    this.currentMode = mode
    this.transitionFrom = from
    this.transitionRemaining = this.config.transitionSeconds
  }

  /** True while a mode blend is in progress. */
  get isTransitioning(): boolean {
    return this.transitionRemaining > 0
  }

  update(dt: Seconds): void {
    // Clamp the step rather than trusting the caller: a tab-switch or a shader compile can
    // deliver a multi-second dt, and integrating a 12 m/s walk over 3 s teleports the
    // camera across a fifth of the domain.
    const step = clamp(dt, 0, this.config.maxStepSeconds) as Seconds
    const snapshot: InputSnapshot = this.input.consume()

    if (snapshot.toggleMode) {
      this.setMode(this.currentMode === 'first-person' ? 'free' : 'first-person')
    }

    this.activeController.update(step, snapshot)
    const live = this.activeController.pose

    if (this.transitionRemaining > 0 && this.transitionFrom) {
      this.transitionRemaining = Math.max(0, this.transitionRemaining - step)
      const total = Math.max(this.config.transitionSeconds, 1e-6)
      const w = smoothstep01(1 - this.transitionRemaining / total)
      const from = this.transitionFrom
      this.renderPose = {
        position: v3(
          from.position.x + (live.position.x - from.position.x) * w,
          from.position.y + (live.position.y - from.position.y) * w,
          from.position.z + (live.position.z - from.position.z) * w,
        ),
        yaw: lerpAngle(from.yaw, live.yaw, w),
        pitch: from.pitch + (live.pitch - from.pitch) * w,
      }
      if (this.transitionRemaining === 0) this.transitionFrom = null
    } else {
      this.renderPose = live
    }

    this.rebuildState()
  }

  /** Teleport, preserving orientation. Clamped to the domain. Cancels any transition. */
  moveTo(x: Metres, z: Metres): void {
    const cx = clamp(x, 0, DOMAIN_SIZE_M)
    const cz = clamp(z, 0, DOMAIN_SIZE_M)
    this.walker.moveTo(cx, cz)
    if (this.currentMode === 'free') {
      // Keep the drone's height ABOVE GROUND, not its absolute altitude: teleporting from a
      // valley to a ridge at constant altitude would put the camera inside the hill.
      const oldGround = this.terrain.heightAt(
        clamp(this.renderPose.position.x, 0, DOMAIN_SIZE_M) as Metres,
        clamp(this.renderPose.position.z, 0, DOMAIN_SIZE_M) as Metres,
      )
      const agl = this.renderPose.position.y - oldGround
      const newGround = this.terrain.heightAt(cx as Metres, cz as Metres)
      this.free.setPosition(cx, newGround + agl, cz)
    } else {
      this.free.adoptPose(this.walker.pose)
    }
    this.transitionFrom = null
    this.transitionRemaining = 0
    this.renderPose = this.activeController.pose
    this.rebuildState()
  }

  get eyeHeightM(): Metres {
    return this.walker.standingEyeHeightM as Metres
  }
  set eyeHeightM(v: Metres) {
    this.walker.standingEyeHeightM = Math.max(0.1, v)
  }

  get freeSpeed(): number {
    return this.free.cruiseSpeedMps
  }
  set freeSpeed(v: number) {
    this.free.cruiseSpeedMps = v
  }

  attach(canvas: HTMLCanvasElement): void {
    this.binding.attach(canvas)
    if (canvas.width > 0 && canvas.height > 0) this.resize(canvas.width, canvas.height)
  }

  detach(): void {
    this.binding.detach()
  }

  /** True once the pointer is locked; the HUD shows a "click to look" prompt until then. */
  get pointerLocked(): boolean {
    return this.binding.isLocked
  }

  // -------------------------------------------------------------------------
  // Projection parameters
  // -------------------------------------------------------------------------

  /** Backbuffer size in physical pixels. Call from the resize handler. */
  resize(widthPx: number, heightPx: number): void {
    if (widthPx > 0 && heightPx > 0) {
      this.aspectRatio = widthPx / heightPx
      this.rebuildState()
    }
  }

  setVerticalFov(fovRad: Radians): void {
    this.fovRad = clamp(fovRad, (5 * Math.PI) / 180, (170 * Math.PI) / 180)
    this.rebuildState()
  }

  setClipPlanes(nearM: Metres, farM: Metres): void {
    this.near = Math.max(1e-3, nearM)
    this.far = Math.max(this.near * 1.001, farM)
    this.rebuildState()
  }

  /** Orientation in radians: yaw is compass azimuth clockwise from north, pitch is elevation. */
  setOrientation(yaw: Radians, pitch: Radians): void {
    const p = clamp(pitch, -MAX_PITCH, MAX_PITCH)
    this.walker.setOrientation(yaw, p)
    this.free.setOrientation(yaw, p)
    this.renderPose = this.activeController.pose
    this.rebuildState()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private get activeController(): WalkerController | FreeCameraController {
    return this.currentMode === 'first-person' ? this.walker : this.free
  }

  /** Recompute every derived quantity in `CameraState` from `renderPose`. */
  private rebuildState(): void {
    const s = this.stateImpl
    const p = this.renderPose
    const fwd: Vec3 = forwardFromYawPitch(p.yaw, p.pitch)
    // Roll-free basis: right is horizontal by construction (world up in the cross product),
    // so the derived up can never tilt the horizon.
    const right = vNormalize(vCross(fwd, v3(0, 1, 0)))
    const up = vCross(right, fwd)

    s.position[0] = p.position.x as Metres
    s.position[1] = p.position.y as Metres
    s.position[2] = p.position.z as Metres
    s.forward[0] = fwd.x
    s.forward[1] = fwd.y
    s.forward[2] = fwd.z
    s.up[0] = up.x
    s.up[1] = up.y
    s.up[2] = up.z

    mat4View(s.viewMatrix as Mat4, p.position, fwd, v3(0, 1, 0))
    mat4Perspective(
      s.projMatrix as Mat4,
      this.fovRad,
      this.aspectRatio,
      this.near,
      this.far,
      this.config.reverseZ,
    )
    mat4Multiply(s.viewProjMatrix as Mat4, s.projMatrix as Mat4, s.viewMatrix as Mat4)
    if (!mat4Invert(s.invViewProjMatrix as Mat4, s.viewProjMatrix as Mat4)) {
      // Unreachable for a well-formed view-projection. Failing loudly beats handing the
      // M4 froxel pass a matrix full of NaN and debugging it there.
      throw new Error('CameraRig: view-projection matrix is singular')
    }
    extractFrustumPlanes(s.frustumPlanes, s.viewProjMatrix as Mat4, this.config.reverseZ)

    s.verticalFov = this.fovRad as Radians
    s.nearM = this.near as Metres
    s.farM = this.far as Metres
    s.aspect = this.aspectRatio
  }
}

/** Convenience factory. Defaults to the analytic stub terrain when none is supplied. */
export const createCameraRig = (
  terrain?: TerrainSampler,
  options: CameraRigOptions = {},
): CameraRig => new CameraRig(terrain, options)
