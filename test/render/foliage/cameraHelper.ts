/**
 * A synthetic `CameraState` for the foliage tests, built with the SHIPPING camera maths.
 *
 * It used to use the foliage package's own mat4 adapter, which had a different argument order
 * and returned `null` rather than a flag on a singular inverse. Two adapters is how a matrix
 * comes out subtly wrong instead of erroring; that copy is gone.
 */

import type { CameraState } from '@contracts/render'
import type { Metres, Radians } from '@contracts/units'
import { extractFrustumPlanes, PLANE_FLOATS } from '@render/foliage/cullMath'
import {
  REVERSED_Z,
  mat4Create,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  v3,
  vNormalize,
  vSub,
} from '../../../src/camera/math.ts'

export interface TestCameraOptions {
  readonly eye: readonly [number, number, number]
  readonly target: readonly [number, number, number]
  readonly fovRad?: number
  readonly aspect?: number
  readonly near?: number
  readonly far?: number
}

export function makeCamera(opts: TestCameraOptions): CameraState {
  const fov = opts.fovRad ?? Math.PI / 3
  const aspect = opts.aspect ?? 16 / 9
  const near = opts.near ?? 0.1
  const far = opts.far ?? 2000
  const eye = v3(opts.eye[0], opts.eye[1], opts.eye[2])
  const target = v3(opts.target[0], opts.target[1], opts.target[2])
  const view = mat4View(mat4Create(), eye, vNormalize(vSub(target, eye)), v3(0, 1, 0))
  const proj = mat4Perspective(mat4Create(), fov, aspect, near, far, REVERSED_Z)
  const viewProj = mat4Multiply(mat4Create(), proj, view)
  const inv = mat4Create()
  mat4Invert(inv, viewProj)
  const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), viewProj, REVERSED_Z)

  const fx = opts.target[0] - opts.eye[0]
  const fy = opts.target[1] - opts.eye[1]
  const fz = opts.target[2] - opts.eye[2]
  const len = Math.hypot(fx, fy, fz) || 1

  return {
    position: [opts.eye[0] as Metres, opts.eye[1] as Metres, opts.eye[2] as Metres],
    forward: [fx / len, fy / len, fz / len],
    up: [0, 1, 0],
    viewMatrix: view,
    projMatrix: proj,
    viewProjMatrix: viewProj,
    invViewProjMatrix: inv,
    verticalFov: fov as Radians,
    nearM: near as Metres,
    farM: far as Metres,
    aspect,
    frustumPlanes: planes,
  }
}
