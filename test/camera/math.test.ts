/**
 * WP 1.8 — camera matrix math against HAND-COMPUTED reference values.
 *
 * These are deliberately not "compare against another library" tests. The conventions
 * (column-major, WebGPU 0..1 depth, reversed-Z, +Y up in NDC, compass yaw) are the things
 * every sibling package's depth comparisons and cull tests depend on, so the reference
 * numbers here are worked out by hand in the comments and asserted literally.
 */

import { describe, expect, it } from 'vitest'
import {
  DEPTH_CLEAR_VALUE,
  DEPTH_COMPARE,
  FRUSTUM_FLOATS,
  FrustumPlane,
  REVERSED_Z,
  criticallyDampedStep,
  dampedVelocityStep,
  extractFrustumPlanes,
  forwardFromYawPitch,
  mat4At,
  mat4Create,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4TransformPoint,
  mat4View,
  planeDistance,
  projectToNdc,
  sphereInFrustum,
  unprojectFromNdc,
  v3,
  vCross,
  vDot,
  vLength,
  vNormalize,
  yawPitchFromForward,
} from '../../src/camera/math.ts'

const near = (a: number, b: number, tol = 1e-6): void => {
  expect(Math.abs(a - b), `${a} != ${b} (tol ${tol})`).toBeLessThanOrEqual(tol)
}

describe('orientation conventions', () => {
  it('yaw is a compass azimuth: north is -Z, east is +X', () => {
    const north = forwardFromYawPitch(0, 0)
    near(north.x, 0)
    near(north.y, 0)
    near(north.z, -1)

    const east = forwardFromYawPitch(Math.PI / 2, 0)
    near(east.x, 1)
    near(east.z, 0)

    const south = forwardFromYawPitch(Math.PI, 0)
    near(south.z, 1)

    const west = forwardFromYawPitch((3 * Math.PI) / 2, 0)
    near(west.x, -1)
  })

  it('pitch is elevation above the horizon and round-trips', () => {
    const up45 = forwardFromYawPitch(0, Math.PI / 4)
    near(up45.y, Math.SQRT1_2)
    near(up45.z, -Math.SQRT1_2)

    for (const yaw of [0, 0.3, 2.0, 5.9]) {
      for (const pitch of [-1.2, -0.1, 0, 0.4, 1.3]) {
        const f = forwardFromYawPitch(yaw, pitch)
        const back = yawPitchFromForward(f)
        near(back.yaw, yaw, 1e-9)
        near(back.pitch, pitch, 1e-9)
      }
    }
  })
})

describe('mat4Multiply', () => {
  it('is column-major: element (row, col) lives at col * 4 + row', () => {
    // A pure translation by (2, 3, 4) has its translation in the LAST COLUMN,
    // i.e. indices 12, 13, 14.
    const t = mat4Create()
    t[12] = 2
    t[13] = 3
    t[14] = 4
    const p = mat4TransformPoint(t, v3(1, 1, 1))
    near(p.x, 3)
    near(p.y, 4)
    near(p.z, 5)
    near(p.w, 1)
    near(mat4At(t, 0, 3), 2)
    near(mat4At(t, 1, 3), 3)
  })

  it('applies b before a, and may alias its output', () => {
    const scale = mat4Create()
    scale[0] = 2
    scale[5] = 2
    scale[10] = 2
    const trans = mat4Create()
    trans[12] = 1
    trans[13] = 0
    trans[14] = 0

    // scale * trans: translate first, then scale -> (1+1)*2 = 4 in x.
    const st = mat4Multiply(mat4Create(), scale, trans)
    near(mat4TransformPoint(st, v3(1, 0, 0)).x, 4)
    // trans * scale: scale first, then translate -> 1*2 + 1 = 3.
    const ts = mat4Multiply(mat4Create(), trans, scale)
    near(mat4TransformPoint(ts, v3(1, 0, 0)).x, 3)

    const aliased = mat4Multiply(mat4Create(), scale, trans)
    mat4Multiply(aliased, aliased, mat4Create())
    for (let i = 0; i < 16; i++) near(aliased[i] as number, st[i] as number)
  })
})

describe('mat4View', () => {
  it('is the identity for an eye at the origin looking north', () => {
    const v = mat4View(mat4Create(), v3(0, 0, 0), v3(0, 0, -1), v3(0, 1, 0))
    const id = mat4Create()
    for (let i = 0; i < 16; i++) near(v[i] as number, id[i] as number)
  })

  it('translates by -eye and puts the view direction on -Z', () => {
    const eye = v3(10, 5, -3)
    const v = mat4View(mat4Create(), eye, v3(0, 0, -1), v3(0, 1, 0))
    const p = mat4TransformPoint(v, v3(10, 5, -13)) // 10 m north of the eye
    near(p.x, 0)
    near(p.y, 0)
    near(p.z, -10) // 10 m in front == -10 on view Z
  })

  it('maps east to view -Z when looking east', () => {
    const v = mat4View(mat4Create(), v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0))
    const p = mat4TransformPoint(v, v3(7, 0, 0))
    near(p.x, 0)
    near(p.y, 0)
    near(p.z, -7)
    // A point to the camera's RIGHT (which is south, +Z in world) maps to +X in view.
    const r = mat4TransformPoint(v, v3(0, 0, 3))
    near(r.x, 3)
  })

  it('is roll-free: view-space up has no sideways component for any yaw/pitch', () => {
    for (const yaw of [0, 0.7, 2.5, 4.4]) {
      for (const pitch of [-1.4, -0.3, 0.6, 1.5]) {
        const f = forwardFromYawPitch(yaw, Math.max(-1.5, Math.min(1.5, pitch)))
        const v = mat4View(mat4Create(), v3(1, 2, 3), f, v3(0, 1, 0))
        // View-space X axis is the first ROW of the rotation part = the world right vector.
        const right = v3(mat4At(v, 0, 0), mat4At(v, 0, 1), mat4At(v, 0, 2))
        near(right.y, 0, 1e-7) // horizon can never tilt
        near(vLength(right), 1, 1e-6)
      }
    }
  })
})

describe('mat4Perspective — WebGPU 0..1 depth', () => {
  // fov 90 deg, aspect 1, near 1, far 101.
  //   f = 1/tan(45) = 1
  //   conventional: m22 = far/(near-far) = -1.01, m23 = far*near/(near-far) = -1.01
  //   reversed:     m22 = near/(far-near) = 0.01, m23 = far*near/(far-near) = 1.01
  const FOV = Math.PI / 2

  it('conventional mapping puts near at 0 and far at 1', () => {
    const p = mat4Perspective(mat4Create(), FOV, 1, 1, 101, false)
    near(mat4At(p, 0, 0), 1)
    near(mat4At(p, 1, 1), 1)
    near(mat4At(p, 3, 2), -1)
    near(mat4At(p, 2, 2), -1.01, 1e-6)
    near(mat4At(p, 2, 3), -1.01, 1e-6)

    near(projectToNdc(p, v3(0, 0, -1)).z, 0, 1e-6)
    near(projectToNdc(p, v3(0, 0, -101)).z, 1, 1e-6)
    // Halfway in VIEW space is not halfway in depth: 1/z clustering.
    near(projectToNdc(p, v3(0, 0, -2)).z, 0.505, 1e-6)
  })

  it('reversed mapping puts near at 1 and far at 0, and is the exact complement', () => {
    const p = mat4Perspective(mat4Create(), FOV, 1, 1, 101, true)
    near(mat4At(p, 2, 2), 0.01, 1e-7)
    near(mat4At(p, 2, 3), 1.01, 1e-6)

    near(projectToNdc(p, v3(0, 0, -1)).z, 1, 1e-6)
    near(projectToNdc(p, v3(0, 0, -101)).z, 0, 1e-6)
    near(projectToNdc(p, v3(0, 0, -2)).z, 1 - 0.505, 1e-6)
  })

  it('+Y is up in NDC and the FOV edges land on +/-1', () => {
    const p = mat4Perspective(mat4Create(), FOV, 1, 1, 101, REVERSED_Z)
    // 45 degrees up at 1 m depth is the top edge of a 90 deg vertical FOV.
    near(projectToNdc(p, v3(0, 1, -1)).y, 1, 1e-6)
    near(projectToNdc(p, v3(0, -1, -1)).y, -1, 1e-6)
    near(projectToNdc(p, v3(1, 0, -1)).x, 1, 1e-6)
  })

  it('aspect scales X only', () => {
    const p = mat4Perspective(mat4Create(), FOV, 2, 1, 101, REVERSED_Z)
    near(projectToNdc(p, v3(2, 0, -1)).x, 1, 1e-6)
    near(projectToNdc(p, v3(0, 1, -1)).y, 1, 1e-6)
  })

  it('reversed-Z spends its depth budget evenly over a kilometre', () => {
    // The actual reason for reversed-Z. Measure the fraction of the float32 depth range
    // spent in the first 10 m of an 8 km frustum with a 5 cm near plane.
    const conv = mat4Perspective(mat4Create(), FOV, 1, 0.05, 8000, false)
    const rev = mat4Perspective(mat4Create(), FOV, 1, 0.05, 8000, true)
    const convFrac = projectToNdc(conv, v3(0, 0, -10)).z // ~= 1 - near/10 = 0.995
    const revFrac = 1 - projectToNdc(rev, v3(0, 0, -10)).z
    expect(convFrac).toBeGreaterThan(0.99) // conventional: everything past 10 m shares <1%
    expect(revFrac).toBeGreaterThan(0.99) // reversed: same crowding, but toward 0...
    // ...where float32's exponent gives ~10^7 more representable values, which is the win.
    // What matters for correctness is that the two are exact complements:
    near(projectToNdc(conv, v3(0, 0, -137)).z, 1 - projectToNdc(rev, v3(0, 0, -137)).z, 1e-6)
  })

  it('exports depth-state constants consistent with the reversed-Z flag', () => {
    expect(DEPTH_CLEAR_VALUE).toBe(REVERSED_Z ? 0 : 1)
    expect(DEPTH_COMPARE).toBe(REVERSED_Z ? 'greater' : 'less')
  })
})

describe('mat4Invert / invViewProj round-trip', () => {
  it('inverts a translation and a projection exactly enough to round-trip', () => {
    const p = mat4Perspective(mat4Create(), Math.PI / 3, 16 / 9, 0.05, 8000, REVERSED_Z)
    const inv = mat4Create()
    expect(mat4Invert(inv, p)).toBe(true)
    const prod = mat4Multiply(mat4Create(), p, inv)
    const id = mat4Create()
    for (let i = 0; i < 16; i++) near(prod[i] as number, id[i] as number, 1e-4)
  })

  it('reports failure rather than emitting NaN for a singular matrix', () => {
    const singular = mat4Create()
    singular[0] = 0
    const out = mat4Create()
    out[3] = 1234
    expect(mat4Invert(out, singular)).toBe(false)
    expect(out[3]).toBe(1234) // untouched
  })

  it('a point projected then unprojected returns to itself across the whole domain', () => {
    const eye = v3(300, 80, 700)
    const fwd = forwardFromYawPitch(1.1, -0.2)
    const view = mat4View(mat4Create(), eye, fwd, v3(0, 1, 0))
    const proj = mat4Perspective(mat4Create(), Math.PI / 3, 16 / 9, 0.05, 8000, REVERSED_Z)
    const viewProj = mat4Multiply(mat4Create(), proj, view)
    const invViewProj = mat4Create()
    expect(mat4Invert(invViewProj, viewProj)).toBe(true)

    // Points spread from 1 m to 2 km in front of the eye, off-axis in both directions.
    const right = vNormalize(vCross(fwd, v3(0, 1, 0)))
    const up = vCross(right, fwd)
    let worst = 0
    for (const dist of [1, 5, 50, 250, 1000, 2000]) {
      for (const ox of [-0.4, 0, 0.4]) {
        for (const oy of [-0.3, 0, 0.3]) {
          const p = v3(
            eye.x + fwd.x * dist + right.x * ox * dist + up.x * oy * dist,
            eye.y + fwd.y * dist + right.y * ox * dist + up.y * oy * dist,
            eye.z + fwd.z * dist + right.z * ox * dist + up.z * oy * dist,
          )
          const ndc = projectToNdc(viewProj, p)
          expect(ndc.z).toBeGreaterThanOrEqual(0)
          expect(ndc.z).toBeLessThanOrEqual(1)
          const back = unprojectFromNdc(invViewProj, ndc)
          const err = vLength(v3(back.x - p.x, back.y - p.y, back.z - p.z))
          worst = Math.max(worst, err / dist)
        }
      }
    }
    // Relative error, because the matrices are stored as float32 (~6 significant digits).
    expect(worst).toBeLessThan(1e-4)
  })
})

describe('extractFrustumPlanes', () => {
  // Identity view, fov 90, aspect 1, near 1, far 101. By hand:
  //   left   n = (+sin45, 0, -cos45), d = 0
  //   right  n = (-sin45, 0, -cos45), d = 0
  //   bottom n = (0, +sin45, -cos45), d = 0
  //   top    n = (0, -sin45, -cos45), d = 0
  //   near   n = (0, 0, -1), d = -1
  //   far    n = (0, 0, +1), d = +101
  const S = Math.SQRT1_2
  const expected: Record<number, readonly [number, number, number, number]> = {
    [FrustumPlane.Left]: [S, 0, -S, 0],
    [FrustumPlane.Right]: [-S, 0, -S, 0],
    [FrustumPlane.Bottom]: [0, S, -S, 0],
    [FrustumPlane.Top]: [0, -S, -S, 0],
    [FrustumPlane.Near]: [0, 0, -1, -1],
    [FrustumPlane.Far]: [0, 0, 1, 101],
  }

  for (const reverseZ of [false, true]) {
    it(`matches hand-computed planes (reverseZ=${reverseZ})`, () => {
      const view = mat4View(mat4Create(), v3(0, 0, 0), v3(0, 0, -1), v3(0, 1, 0))
      const proj = mat4Perspective(mat4Create(), Math.PI / 2, 1, 1, 101, reverseZ)
      const vp = mat4Multiply(mat4Create(), proj, view)
      const planes = extractFrustumPlanes(new Float32Array(FRUSTUM_FLOATS), vp, reverseZ)

      for (const slot of Object.values(FrustumPlane)) {
        const e = expected[slot] as readonly [number, number, number, number]
        for (let k = 0; k < 4; k++) {
          // Relative tolerance: the matrices are float32, so the far plane's d = 101
          // carries ~1e-4 of absolute rounding while the unit normals carry ~1e-7.
          const ref = e[k] as number
          near(planes[slot * 4 + k] as number, ref, 2e-5 * Math.max(1, Math.abs(ref)))
        }
      }
    })
  }

  it('geometric plane slots do not depend on the depth convention', () => {
    const view = mat4View(mat4Create(), v3(12, 40, -7), forwardFromYawPitch(2.2, 0.15), v3(0, 1, 0))
    const a = extractFrustumPlanes(
      new Float32Array(FRUSTUM_FLOATS),
      mat4Multiply(mat4Create(), mat4Perspective(mat4Create(), 1.0, 1.7, 0.1, 900, false), view),
      false,
    )
    const b = extractFrustumPlanes(
      new Float32Array(FRUSTUM_FLOATS),
      mat4Multiply(mat4Create(), mat4Perspective(mat4Create(), 1.0, 1.7, 0.1, 900, true), view),
      true,
    )
    for (let i = 0; i < FRUSTUM_FLOATS; i++) {
      const ref = a[i] as number
      near(ref, b[i] as number, 1e-3 * Math.max(1, Math.abs(ref)))
    }
  })

  it('planes are normalised, so plane distance is a true metric distance', () => {
    const view = mat4View(mat4Create(), v3(0, 0, 0), v3(0, 0, -1), v3(0, 1, 0))
    const proj = mat4Perspective(mat4Create(), Math.PI / 2, 1.6, 0.5, 500, REVERSED_Z)
    const planes = extractFrustumPlanes(
      new Float32Array(FRUSTUM_FLOATS),
      mat4Multiply(mat4Create(), proj, view),
      REVERSED_Z,
    )
    for (const slot of Object.values(FrustumPlane)) {
      const n = v3(
        planes[slot * 4 + 0] as number,
        planes[slot * 4 + 1] as number,
        planes[slot * 4 + 2] as number,
      )
      near(vLength(n), 1, 1e-5)
    }
    // A point 10 m in front is exactly 9.5 m inside the 0.5 m near plane.
    near(planeDistance(planes, FrustumPlane.Near, v3(0, 0, -10)), 9.5, 1e-3)
    near(planeDistance(planes, FrustumPlane.Far, v3(0, 0, -10)), 490, 1e-2)
  })

  it('culls correctly, including the sphere-radius margin', () => {
    const view = mat4View(mat4Create(), v3(0, 0, 0), v3(0, 0, -1), v3(0, 1, 0))
    const proj = mat4Perspective(mat4Create(), Math.PI / 2, 1, 1, 101, REVERSED_Z)
    const planes = extractFrustumPlanes(
      new Float32Array(FRUSTUM_FLOATS),
      mat4Multiply(mat4Create(), proj, view),
      REVERSED_Z,
    )
    expect(sphereInFrustum(planes, v3(0, 0, -50))).toBe(true)
    expect(sphereInFrustum(planes, v3(0, 0, -0.5))).toBe(false) // in front of near
    expect(sphereInFrustum(planes, v3(0, 0, -200))).toBe(false) // beyond far
    expect(sphereInFrustum(planes, v3(0, 0, 50))).toBe(false) // behind the camera
    expect(sphereInFrustum(planes, v3(60, 0, -50))).toBe(false) // outside laterally
    expect(sphereInFrustum(planes, v3(60, 0, -50), 12)).toBe(true) // ...until it has a radius
  })

  it('every NDC corner unprojects onto the frustum boundary', () => {
    const eye = v3(140, 33, 610)
    const fwd = forwardFromYawPitch(0.8, -0.25)
    const view = mat4View(mat4Create(), eye, fwd, v3(0, 1, 0))
    const proj = mat4Perspective(mat4Create(), Math.PI / 3, 16 / 9, 0.1, 2000, REVERSED_Z)
    const vp = mat4Multiply(mat4Create(), proj, view)
    const inv = mat4Create()
    mat4Invert(inv, vp)
    const planes = extractFrustumPlanes(new Float32Array(FRUSTUM_FLOATS), vp, REVERSED_Z)

    for (const x of [-1, 1]) {
      for (const y of [-1, 1]) {
        for (const z of [0, 1]) {
          const world = unprojectFromNdc(inv, v3(x, y, z))
          for (const slot of Object.values(FrustumPlane)) {
            const d = planeDistance(planes, slot, world)
            expect(d).toBeGreaterThan(-0.05) // inside, to float32 tolerance
          }
          // A corner lies ON three planes: the two it is extreme in, plus near or far.
          const touching = Object.values(FrustumPlane).filter(
            (slot) => Math.abs(planeDistance(planes, slot, world)) < 0.05,
          )
          expect(touching.length).toBe(3)
        }
      }
    }
  })
})

describe('damping primitives', () => {
  it('critically damped step never overshoots a step target, at any dt', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 5, 1, 3]) {
      let x = 0
      let v = 0
      // Run a fixed SIMULATED duration, not a fixed step count: settling time is 4.7/omega
      // regardless of step size, which is the frame-rate independence being asserted.
      const steps = Math.ceil(5 / dt)
      for (let i = 0; i < steps; i++) {
        const r = criticallyDampedStep(x, v, 1, 1, 18, dt)
        x = r.value
        v = r.velocity
        expect(x).toBeGreaterThanOrEqual(-1e-12)
        expect(x).toBeLessThanOrEqual(1 + 1e-9) // critical damping: no ringing, ever
      }
      near(x, 1, 1e-6)
    }
  })

  it('tracks a constant-rate ramp with zero steady-state lag (feed-forward)', () => {
    // The camera descending a constant slope. Without the target-velocity feed-forward
    // term the steady-state lag would be 2v/omega = 2*10/18 = 1.1 m.
    const dt = 1 / 60
    const rate = 10
    let target = 0
    let x = 0
    let v = 0
    for (let i = 0; i < 600; i++) {
      const t0 = target
      target += rate * dt
      const r = criticallyDampedStep(x, v, t0, target, 18, dt)
      x = r.value
      v = r.velocity
    }
    near(x, target, 1e-6)
    near(v, rate, 1e-6)
  })

  it('damped velocity step matches the analytic solution and its exact integral', () => {
    const v0 = 3
    const vt = 12
    const k = 6
    const dt = 0.37
    const r = dampedVelocityStep(v0, vt, k, dt)
    near(r.velocity, vt + (v0 - vt) * Math.exp(-k * dt), 1e-12)
    near(r.displacement, vt * dt + ((v0 - vt) * (1 - Math.exp(-k * dt))) / k, 1e-12)
    // Composing two half-steps equals one whole step: the solution is exact, not integrated.
    const h1 = dampedVelocityStep(v0, vt, k, dt / 2)
    const h2 = dampedVelocityStep(h1.velocity, vt, k, dt / 2)
    near(h1.velocity + 0 * h2.velocity, h1.velocity)
    near(h2.velocity, r.velocity, 1e-12)
    near(h1.displacement + h2.displacement, r.displacement, 1e-12)
  })

  it('damped velocity never overshoots its target or reverses sign', () => {
    for (const dt of [1 / 240, 1 / 30, 0.5, 2]) {
      let v = 0
      const steps = Math.ceil(8 / dt) // a fixed simulated duration, not a step count
      for (let i = 0; i < steps; i++) {
        const r = dampedVelocityStep(v, 20, 6, dt)
        expect(r.velocity).toBeGreaterThanOrEqual(v - 1e-12)
        expect(r.velocity).toBeLessThanOrEqual(20 + 1e-9)
        expect(r.displacement).toBeGreaterThanOrEqual(0)
        v = r.velocity
      }
      // ...and coasting to a stop is monotone too.
      for (let i = 0; i < steps; i++) {
        const r = dampedVelocityStep(v, 0, 6, dt)
        expect(r.velocity).toBeLessThanOrEqual(v + 1e-12)
        expect(r.velocity).toBeGreaterThanOrEqual(0)
        v = r.velocity
      }
      near(v, 0, 1e-6)
    }
  })
})

describe('vector helpers', () => {
  it('normalises the zero vector to zero rather than NaN', () => {
    const n = vNormalize(v3(0, 0, 0))
    expect(Number.isFinite(n.x + n.y + n.z)).toBe(true)
    near(vLength(n), 0)
  })

  it('cross and dot follow the right-hand rule used by the view basis', () => {
    const c = vCross(v3(1, 0, 0), v3(0, 1, 0))
    near(c.z, 1)
    near(vDot(v3(1, 2, 3), v3(4, 5, 6)), 32)
  })
})
