/**
 * Camera math — WP 1.8.
 *
 * Matrix operations delegate to **wgpu-matrix**, which is written specifically for WebGPU
 * and therefore already uses the 0..1 clip-space depth range this project needs. The
 * hand-rolled implementations that were here originally were duplicated by a second,
 * independent mat4 in `src/render/foliage/math/` — an artefact of parallel construction,
 * and two sets of conventions that could silently disagree. Both now sit on one tested
 * library.
 *
 * The wrappers below are kept deliberately: they hold this module's *conventions* (the
 * Vec3 record type, reversed-Z as the default, the `out`-first argument order used
 * throughout the camera package) so that swapping the backing library never becomes a
 * change to every call site.
 *
 * ===========================================================================
 * CONVENTIONS — NORMATIVE FOR THIS MODULE. Siblings' depth tests depend on them.
 * ===========================================================================
 *
 * WORLD SPACE
 *   Right-handed, Y up. +X = east, +Y = up, +Z = south (because east x up = south).
 *   Terrain is queried as (x, z) in [0, DOMAIN_SIZE_M]; height is Y.
 *   Compass azimuth is measured CLOCKWISE FROM NORTH, matching
 *   `ITerrainField.aspectAt`. North is therefore -Z, east is +X:
 *       dir(azimuth) = ( sin(az), 0, -cos(az) )
 *   Camera orientation is stored as (yaw, pitch) with yaw = that same azimuth and
 *   pitch = elevation above the horizon. Roll is never stored, so the horizon can
 *   never tilt — both camera modes are roll-free by construction.
 *
 * MATRIX STORAGE
 *   `Mat4` is a 16-element Float32Array in COLUMN-MAJOR order, i.e. m[0..3] is the
 *   first COLUMN. This is what WGSL's `mat4x4<f32>` expects from a uniform buffer, so
 *   a Mat4 can be written straight into a GPUBuffer with no transpose.
 *   Element (row r, col c) lives at index c * 4 + r.
 *   Vectors are columns; a transform is `clip = P * V * p`.
 *
 * CLIP SPACE (WebGPU, NOT OpenGL)
 *   x, y in [-1, 1] with +Y UP in NDC. z in [0, 1] — not [-1, 1].
 *
 * REVERSED-Z — READ THIS
 *   The domain is 1 km across and the near plane is decimetres, so the near:far ratio
 *   is ~1:20000. With a conventional [near -> 0, far -> 1] mapping, float32 depth
 *   wastes almost all of its mantissa immediately in front of the eye and z-fights on
 *   distant ridgelines. This project therefore uses REVERSED-Z by default:
 *
 *       near plane -> depth 1.0        far plane -> depth 0.0
 *
 *   The floating-point exponent's clustering near zero then cancels the projection's
 *   1/z clustering near one, and depth precision becomes near-uniform over the km.
 *
 *   Every consumer of a depth buffer MUST therefore use:
 *       depthClearValue: DEPTH_CLEAR_VALUE   (0.0)
 *       depthCompare:    DEPTH_COMPARE       ('greater')
 *       format:          DEPTH_FORMAT        ('depth32float' — reversed-Z with a
 *                                             24-bit unorm buffer throws away the
 *                                             entire benefit)
 *   and any shader reconstructing world position from depth must use
 *   `invViewProjMatrix` with ndc.z taken from the depth buffer AS-IS (it is already
 *   in the same 0..1 space the matrix was built for — do NOT remap to -1..1).
 *
 *   `mat4Perspective` takes an explicit `reverseZ` flag so the convention is testable
 *   both ways and so a debug view can turn it off; REVERSED_Z is the project default.
 */

import { mat4 as wgpuMat4 } from 'wgpu-matrix'

// ---------------------------------------------------------------------------
// Depth convention constants — the single source of truth for siblings
// ---------------------------------------------------------------------------

/** Project default. See the reversed-Z note above. */
export const REVERSED_Z = true

/** Reversed-Z is worthless on a 24-bit unorm depth buffer. Use float depth. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float'

/** Cleared to the FAR value, which under reversed-Z is 0. */
export const DEPTH_CLEAR_VALUE: number = REVERSED_Z ? 0 : 1

/** Depth test for opaque geometry. Under reversed-Z, nearer means greater. */
export const DEPTH_COMPARE: GPUCompareFunction = REVERSED_Z ? 'greater' : 'less'

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/**
 * Deliberately an object, not a tuple or a Float32Array: under
 * `noUncheckedIndexedAccess` every array index would be `number | undefined`, and the
 * resulting `!` noise is a place for real bugs to hide.
 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })
export const vClone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z })
export const vSet = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x
  out.y = y
  out.z = z
  return out
}
export const vCopy = (out: Vec3, a: Vec3): Vec3 => vSet(out, a.x, a.y, a.z)
export const vAdd = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z)
export const vSub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z)
export const vScale = (a: Vec3, k: number): Vec3 => v3(a.x * k, a.y * k, a.z * k)
export const vAddScaled = (a: Vec3, b: Vec3, k: number): Vec3 =>
  v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k)
export const vDot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const vCross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
export const vLength = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)

/** Returns the zero vector unchanged rather than producing NaN. */
export const vNormalize = (a: Vec3): Vec3 => {
  const len = vLength(a)
  return len > 0 ? vScale(a, 1 / len) : v3(0, 0, 0)
}

export const vTuple = (a: Vec3): [number, number, number] => [a.x, a.y, a.z]

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

/** Smooth Hermite step, zero first derivative at both ends. */
export const smoothstep01 = (t: number): number => {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/** Pitch is clamped just short of vertical so `forward x worldUp` never degenerates. */
export const MAX_PITCH = Math.PI / 2 - 1e-3

/**
 * yaw = compass azimuth clockwise from north (north = -Z, east = +X).
 * pitch = elevation above the horizon.
 */
export const forwardFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cp = Math.cos(pitch)
  return v3(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
}

/** Inverse of `forwardFromYawPitch`. Yaw is returned in [0, 2*PI). */
export const yawPitchFromForward = (f: Vec3): { yaw: number; pitch: number } => {
  const n = vNormalize(f)
  const horiz = Math.hypot(n.x, n.z)
  const yaw = normalizeAngle2Pi(Math.atan2(n.x, -n.z))
  const pitch = Math.atan2(n.y, horiz)
  return { yaw, pitch }
}

/** Compass azimuth (clockwise from north) of a horizontal direction given in world (x, z). */
export const azimuthFromXZ = (dx: number, dz: number): number =>
  normalizeAngle2Pi(Math.atan2(dx, -dz))

export const normalizeAngle2Pi = (a: number): number => {
  const twoPi = Math.PI * 2
  const r = a % twoPi
  return r < 0 ? r + twoPi : r
}

/** Signed shortest angular difference `a - b`, in (-PI, PI]. Used for yaw blending. */
export const shortestAngleDelta = (a: number, b: number): number => {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** Interpolate two angles along the short arc. */
export const lerpAngle = (a: number, b: number, t: number): number =>
  normalizeAngle2Pi(a + shortestAngleDelta(b, a) * t)

// ---------------------------------------------------------------------------
// Matrices — column-major, 16 floats
// ---------------------------------------------------------------------------

export type Mat4 = Float32Array

export const mat4Create = (): Mat4 => wgpuMat4.identity(new Float32Array(16)) as Mat4

/** Read element (row, col) of a column-major Mat4. */
export const mat4At = (m: Mat4, row: number, col: number): number => m[col * 4 + row] as number

export const mat4Identity = (out: Mat4): Mat4 => wgpuMat4.identity(out) as Mat4

/** out = a * b (column-major, so `b` is applied to the vector first). */
export const mat4Multiply = (out: Mat4, a: Mat4, b: Mat4): Mat4 =>
  wgpuMat4.multiply(a, b, out) as Mat4

/**
 * Right-handed view matrix. Camera looks along `forward`; the view-space basis is
 * (right, up, -forward), so view space has the camera looking down its own -Z, which is
 * what `mat4Perspective` assumes.
 *
 * `upHint` only picks the roll reference — the returned matrix has zero roll about
 * `forward`. Passing world up (0,1,0) therefore keeps the horizon level always.
 */
export const mat4View = (out: Mat4, eye: Vec3, forward: Vec3, upHint: Vec3): Mat4 => {
  const f = vNormalize(forward)
  let r = vCross(f, upHint)
  if (vLength(r) < 1e-6) {
    // Looking straight along the hint: pick any perpendicular so the matrix stays finite.
    r = vCross(f, v3(0, 0, 1))
    if (vLength(r) < 1e-6) r = vCross(f, v3(1, 0, 0))
  }
  r = vNormalize(r)
  const u = vCross(r, f)

  out[0] = r.x
  out[1] = u.x
  out[2] = -f.x
  out[3] = 0
  out[4] = r.y
  out[5] = u.y
  out[6] = -f.y
  out[7] = 0
  out[8] = r.z
  out[9] = u.z
  out[10] = -f.z
  out[11] = 0
  out[12] = -vDot(r, eye)
  out[13] = -vDot(u, eye)
  out[14] = vDot(f, eye)
  out[15] = 1
  return out
}

/**
 * Right-handed perspective projection into WebGPU clip space (z in [0, 1]).
 *
 * `reverseZ === false`:  view z = -near -> ndc z = 0,  view z = -far -> ndc z = 1
 * `reverseZ === true`:   view z = -near -> ndc z = 1,  view z = -far -> ndc z = 0
 *
 * The reversed form is the conventional form with `near` and `far` exchanged in the
 * depth row; nothing else differs, so x/y are identical between the two.
 */
export const mat4Perspective = (
  out: Mat4,
  verticalFovRad: number,
  aspect: number,
  near: number,
  far: number,
  reverseZ: boolean = REVERSED_Z,
): Mat4 => {
  // wgpu-matrix targets WebGPU, so both forms already produce z in [0, 1] — no GL-style
  // [-1, 1] remap is involved. Verified: perspectiveReverseZ maps near -> 1 and far -> 0,
  // perspective maps near -> 0 and far -> 1, matching the contract documented above.
  return (
    reverseZ
      ? wgpuMat4.perspectiveReverseZ(verticalFovRad, aspect, near, far, out)
      : wgpuMat4.perspective(verticalFovRad, aspect, near, far, out)
  ) as Mat4
}

/**
 * General 4x4 inverse by cofactor expansion. Returns false and leaves `out` untouched
 * when the matrix is singular — a projection or view matrix never is, but the froxel
 * pass at M4 depends on invViewProj being right, so a silent NaN is not acceptable.
 */
/** Scratch for mat4Invert, so a singular input leaves `out` untouched without allocating. */
const invScratch = new Float32Array(16)

export const mat4Invert = (out: Mat4, m: Mat4): boolean => {
  wgpuMat4.inverse(m, invScratch)
  // wgpu-matrix does not signal singularity; it divides by a zero determinant and returns
  // Inf/NaN. The froxel pass at M4 depends on invViewProj being right, so a silent NaN is
  // not acceptable — check, and only then commit to `out`.
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(invScratch[i] as number)) return false
  }
  out.set(invScratch)
  return true
}

/**
 * Workaround for a CONTRACT TYPING PROBLEM, reported to the integrator; delete it when the
 * contract is fixed.
 *
 * `CameraState` declares its matrices as bare `Float32Array`, which under TypeScript 5.7's
 * generic typed arrays means `Float32Array<ArrayBufferLike>`. `GPUQueue.writeBuffer` wants
 * `ArrayBufferView<ArrayBuffer>` — `ArrayBufferLike` also admits `SharedArrayBuffer`, which
 * WebGPU will not accept — so
 *
 *     device.queue.writeBuffer(buf, 0, camera.viewProjMatrix)
 *
 * does not compile, for every package that uploads a camera matrix. The arrays this module
 * produces are always backed by a plain `ArrayBuffer`, so narrowing is sound here; it is
 * still a cast, and it lives in exactly one place rather than in seven packages.
 */
export const asUploadable = (a: Float32Array): Float32Array<ArrayBuffer> =>
  a as Float32Array<ArrayBuffer>

export interface Vec4 {
  x: number
  y: number
  z: number
  w: number
}

/** m * (p, 1). Returns the homogeneous result WITHOUT the perspective divide. */
export const mat4TransformPoint = (m: Mat4, p: Vec3): Vec4 => ({
  x: mat4At(m, 0, 0) * p.x + mat4At(m, 0, 1) * p.y + mat4At(m, 0, 2) * p.z + mat4At(m, 0, 3),
  y: mat4At(m, 1, 0) * p.x + mat4At(m, 1, 1) * p.y + mat4At(m, 1, 2) * p.z + mat4At(m, 1, 3),
  z: mat4At(m, 2, 0) * p.x + mat4At(m, 2, 1) * p.y + mat4At(m, 2, 2) * p.z + mat4At(m, 2, 3),
  w: mat4At(m, 3, 0) * p.x + mat4At(m, 3, 1) * p.y + mat4At(m, 3, 2) * p.z + mat4At(m, 3, 3),
})

/** World -> NDC. x, y in [-1, 1] (+Y up); z in [0, 1]. */
export const projectToNdc = (viewProj: Mat4, p: Vec3): Vec3 => {
  const c = mat4TransformPoint(viewProj, p)
  const iw = 1 / c.w
  return v3(c.x * iw, c.y * iw, c.z * iw)
}

/**
 * NDC -> world, the exact inverse of `projectToNdc`. `ndc.z` is in the 0..1 range and is
 * exactly what a depth-buffer sample contains — do not remap it.
 */
export const unprojectFromNdc = (invViewProj: Mat4, ndc: Vec3): Vec3 => {
  const c = mat4TransformPoint(invViewProj, ndc)
  const iw = 1 / c.w
  return v3(c.x * iw, c.y * iw, c.z * iw)
}

// ---------------------------------------------------------------------------
// Frustum
// ---------------------------------------------------------------------------

export const FRUSTUM_PLANE_COUNT = 6
export const FRUSTUM_FLOATS = FRUSTUM_PLANE_COUNT * 4

/**
 * Plane order in the packed Float32Array. GEOMETRIC order — `Near` is always the plane
 * closest to the eye regardless of the reversed-Z flag, so a culling consumer never has
 * to know which depth convention built the matrix. Each plane is `(nx, ny, nz, d)`,
 * normalised, with a point INSIDE the frustum satisfying `dot(n, p) + d >= 0`.
 * Six vec4s: also a valid std140/std430 array<vec4<f32>, 6> for the GPU cull pass.
 */
export const FrustumPlane = {
  Left: 0,
  Right: 1,
  Bottom: 2,
  Top: 3,
  Near: 4,
  Far: 5,
} as const
export type FrustumPlane = (typeof FrustumPlane)[keyof typeof FrustumPlane]

/**
 * Gribb & Hartmann plane extraction, adapted for WebGPU's 0..1 depth range.
 *
 * For clip-space rows r0..r3 of `viewProj` the six half-spaces are
 *   -w <= x <= w,  -w <= y <= w,  0 <= z <= w
 * giving  left = r3 + r0, right = r3 - r0, bottom = r3 + r1, top = r3 - r1,
 *         z >= 0 -> r2,   z <= w -> r3 - r2.
 * (An OpenGL -1..1 extraction would use `r3 + r2` for the near plane; using that here
 * yields a plane that is simply wrong, which is why this is spelled out.)
 *
 * Under reversed-Z the depth mapping is flipped, so `r2` is the FAR plane and
 * `r3 - r2` is the NEAR plane. They are written into the slots that match their
 * geometry, not their algebra.
 */
export const extractFrustumPlanes = (
  out: Float32Array,
  viewProj: Mat4,
  reverseZ: boolean = REVERSED_Z,
): Float32Array => {
  const r = (row: number, col: number): number => mat4At(viewProj, row, col)

  const write = (slot: number, a: number, b: number, c: number, d: number): void => {
    const inv = 1 / Math.hypot(a, b, c)
    out[slot * 4 + 0] = a * inv
    out[slot * 4 + 1] = b * inv
    out[slot * 4 + 2] = c * inv
    out[slot * 4 + 3] = d * inv
  }

  write(FrustumPlane.Left, r(3, 0) + r(0, 0), r(3, 1) + r(0, 1), r(3, 2) + r(0, 2), r(3, 3) + r(0, 3))
  write(FrustumPlane.Right, r(3, 0) - r(0, 0), r(3, 1) - r(0, 1), r(3, 2) - r(0, 2), r(3, 3) - r(0, 3))
  write(FrustumPlane.Bottom, r(3, 0) + r(1, 0), r(3, 1) + r(1, 1), r(3, 2) + r(1, 2), r(3, 3) + r(1, 3))
  write(FrustumPlane.Top, r(3, 0) - r(1, 0), r(3, 1) - r(1, 1), r(3, 2) - r(1, 2), r(3, 3) - r(1, 3))

  const zGeZero: [number, number, number, number] = [r(2, 0), r(2, 1), r(2, 2), r(2, 3)]
  const zLeW: [number, number, number, number] = [
    r(3, 0) - r(2, 0),
    r(3, 1) - r(2, 1),
    r(3, 2) - r(2, 2),
    r(3, 3) - r(2, 3),
  ]
  const near = reverseZ ? zLeW : zGeZero
  const far = reverseZ ? zGeZero : zLeW
  write(FrustumPlane.Near, near[0], near[1], near[2], near[3])
  write(FrustumPlane.Far, far[0], far[1], far[2], far[3])
  return out
}

/** Signed distance from a packed plane to a point. Positive is inside. */
export const planeDistance = (planes: Float32Array, slot: number, p: Vec3): number =>
  (planes[slot * 4 + 0] as number) * p.x +
  (planes[slot * 4 + 1] as number) * p.y +
  (planes[slot * 4 + 2] as number) * p.z +
  (planes[slot * 4 + 3] as number)

/** Conservative sphere test. `radius = 0` is a point test. */
export const sphereInFrustum = (planes: Float32Array, centre: Vec3, radius = 0): boolean => {
  for (let i = 0; i < FRUSTUM_PLANE_COUNT; i++) {
    if (planeDistance(planes, i, centre) < -radius) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Damping primitives
// ---------------------------------------------------------------------------

/**
 * Exact critically-damped spring step, solved analytically rather than integrated.
 *
 * Two properties matter here and neither is available from a naive
 * `x += (target - x) * k * dt`:
 *   1. Unconditionally stable and NON-OSCILLATING for any dt. A semi-implicit spring
 *      rings when dt * omega > 1, and on a frame spike that reads as camera judder.
 *   2. `targetVel` is a feed-forward term. The error obeys the homogeneous equation in
 *      the target's own moving frame, so tracking a ramp (walking down a constant
 *      slope) has ZERO steady-state lag. A spring without it lags by 2 * v / omega,
 *      which on a 60-degree escarpment at running speed is over a metre — the camera
 *      would visibly sink into the hillside on every descent.
 *
 * @param x         current value
 * @param v         current rate of change of `x`
 * @param target0   target at the START of the step
 * @param target1   target at the END of the step (already known: we move first, smooth second)
 * @param omega     natural frequency, rad/s. Settling time ~ 4.7 / omega.
 * @param dt        seconds
 */
export const criticallyDampedStep = (
  x: number,
  v: number,
  target0: number,
  target1: number,
  omega: number,
  dt: number,
): { value: number; velocity: number } => {
  if (dt <= 0) return { value: x, velocity: v }
  const targetVel = (target1 - target0) / dt
  const d0 = x - target0
  const dv0 = v - targetVel
  const c = dv0 + omega * d0
  const e = Math.exp(-omega * dt)
  const d1 = (d0 + c * dt) * e
  const dv1 = (c * (1 - omega * dt) - omega * d0) * e
  return { value: target1 + d1, velocity: targetVel + dv1 }
}

/**
 * Frame-rate independent exponential approach of a value to a target.
 * Returns the multiplier `1 - exp(-rate * dt)`; `x += (target - x) * blend(rate, dt)`.
 */
export const expBlend = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt)

/**
 * Exact solution of `dv/dt = -k (v - vTarget)` over `dt`, returning both the new velocity
 * and the EXACT displacement integral. Using `pos += v * dt` after damping instead
 * accumulates a first-order error that shows up as the free camera overshooting its
 * stopping point at low frame rates.
 */
export const dampedVelocityStep = (
  v: number,
  vTarget: number,
  k: number,
  dt: number,
): { velocity: number; displacement: number } => {
  if (dt <= 0) return { velocity: v, displacement: 0 }
  if (k <= 0) return { velocity: v, displacement: v * dt }
  const e = Math.exp(-k * dt)
  const dv = v - vTarget
  return {
    velocity: vTarget + dv * e,
    displacement: vTarget * dt + (dv * (1 - e)) / k,
  }
}
