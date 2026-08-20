/**
 * Screen → world picking against the terrain, and the ignition shapes it produces.
 *
 * Pure except for the terrain query it is handed, so all of it is CLI-testable — which
 * matters more than usual here, because a picking bug looks exactly like a solver bug: you
 * click, nothing burns, and there is nothing in the console.
 *
 * ## Why march rather than solve
 *
 * The heightfield is procedural and only exposed as a point query (`ITerrainField.heightAt`).
 * There is no analytic intersection to solve, so the ray is sampled until it crosses the
 * surface and then bisected. 512 samples over a 2 km ray is 4 m of stride — finer than the
 * terrain's own 1 m grid would need for a first bracket, and the bisection takes the answer
 * to well under a surface cell in 20 more queries. It runs once per click.
 */

import type { CameraState } from '@contracts/render.ts'
import type { IgnitionShape } from '@contracts/sim.ts'
import type { ITerrainField } from '@contracts/world.ts'
import { DOMAIN_SIZE_M } from '@contracts/world.ts'
import type { Metres, Radians } from '@contracts/units.ts'
import { m as metres } from '@contracts/units.ts'
import { unprojectFromNdc, REVERSED_Z } from '../camera/math.ts'

/** Coarse samples along the ray before bisection. */
const MARCH_SAMPLES = 512
const BISECT_STEPS = 20
/** Ray length, metres. The domain diagonal is ~1.45 km; this covers looking across it. */
const MAX_RANGE_M = 2500

export interface PickedGround {
  readonly x: Metres
  readonly z: Metres
  readonly y: Metres
  /** True when the ray left the domain before hitting ground and the point was clamped. */
  readonly clamped: boolean
}

/**
 * Normalised device coordinates for a pointer event over the canvas.
 *
 * WebGPU NDC has +Y up and the framebuffer has +Y down, hence the flip. Under pointer lock
 * the cursor position is meaningless and callers pass `[0, 0]` — the crosshair — instead.
 */
export function ndcFromPointer(
  clientX: number,
  clientY: number,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): readonly [number, number] {
  const x = (2 * (clientX - rect.left)) / Math.max(1, rect.width) - 1
  const y = 1 - (2 * (clientY - rect.top)) / Math.max(1, rect.height)
  return [x, y]
}

/**
 * Where the ray through `ndc` meets the ground.
 *
 * Returns null only when the ray never descends to the terrain at all — looking at the sky.
 * A ray that leaves the 1 km domain first is clamped to the boundary and flagged, because
 * refusing to ignite there is more annoying than igniting at the edge.
 */
export function pickGround(
  camera: CameraState,
  terrain: Pick<ITerrainField, 'heightAt'>,
  ndc: readonly [number, number],
): PickedGround | null {
  const nx = ndc[0]
  const ny = ndc[1]
  // Reversed-Z (src/camera/math.ts): the NEAR plane is depth 1 and the far plane is 0. Get
  // this backwards and the ray points behind the camera, which reads as "picking is broken"
  // rather than as a sign error.
  const nearDepth = REVERSED_Z ? 1 : 0
  const farDepth = REVERSED_Z ? 0 : 1
  const a = unprojectFromNdc(camera.invViewProjMatrix, { x: nx, y: ny, z: nearDepth })
  const b = unprojectFromNdc(camera.invViewProjMatrix, { x: nx, y: ny, z: farDepth })
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  if (!(len > 0)) return null
  const ux = dx / len
  const uy = dy / len
  const uz = dz / len

  const groundAt = (t: number): number =>
    terrain.heightAt(clampM(a.x + ux * t), clampM(a.z + uz * t)) as number
  const above = (t: number): number => a.y + uy * t - groundAt(t)

  let t0 = 0
  let f0 = above(0)
  // Standing inside the terrain (or exactly on it) — the click is at our own feet.
  if (f0 <= 0) return at(a.x, a.y, a.z)

  const stride = MAX_RANGE_M / MARCH_SAMPLES
  for (let i = 1; i <= MARCH_SAMPLES; i++) {
    const t1 = i * stride
    const f1 = above(t1)
    if (f1 <= 0) {
      // Bracketed. Bisect — the surface is not monotonic, so a secant step can leave it.
      let lo = t0
      let hi = t1
      for (let k = 0; k < BISECT_STEPS; k++) {
        const mid = 0.5 * (lo + hi)
        if (above(mid) > 0) lo = mid
        else hi = mid
      }
      return at(a.x + ux * hi, a.y + uy * hi, a.z + uz * hi)
    }
    t0 = t1
    f0 = f1
  }
  return null

  function at(x: number, y: number, z: number): PickedGround {
    const cx = clampM(x)
    const cz = clampM(z)
    return {
      x: cx,
      z: cz,
      y: metres(y),
      clamped: cx !== x || cz !== z,
    }
  }
}

const clampM = (v: number): Metres =>
  metres(Number.isFinite(v) ? Math.min(DOMAIN_SIZE_M, Math.max(0, v)) : 0)

export type IgnitionTool = 'point' | 'line' | 'ring'

export interface IgnitionRequest {
  readonly tool: IgnitionTool
  readonly x: Metres
  readonly z: Metres
  /** Point/ring radius, or half the length of a line. */
  readonly radiusM: number
  /** Direction the wind blows TOWARD, radians clockwise from north — see `fire.ts`. */
  readonly windDirection: Radians
}

/**
 * Turn a picked point and a tool into the contract's `IgnitionShape`.
 *
 * The line is laid **across** the wind, not along it. That is the standard test ignition and
 * the only one that produces a clean head fire to measure a rate of spread against: a line
 * parallel to the wind gives two flanks and no head, which looks like the solver has failed.
 */
export function ignitionShape(req: IgnitionRequest): IgnitionShape {
  const r = Math.max(0.5, req.radiusM)
  if (req.tool === 'point') {
    return { kind: 'point', x: req.x, z: req.z, radius: metres(r) }
  }
  if (req.tool === 'ring') {
    // A ring wants to enclose something, so it is drawn wider than a point of the same
    // nominal size; the width is the burning annulus itself.
    return { kind: 'ring', x: req.x, z: req.z, radius: metres(r * 3), width: metres(r) }
  }
  // Perpendicular to the wind: rotate the toward-vector (sin a, cos a) by 90 degrees.
  const across = { x: Math.cos(req.windDirection), z: -Math.sin(req.windDirection) }
  const half = r * 2
  return {
    kind: 'line',
    x0: clampM(req.x - across.x * half),
    z0: clampM(req.z - across.z * half),
    x1: clampM(req.x + across.x * half),
    z1: clampM(req.z + across.z * half),
    width: metres(Math.max(1, r * 0.4)),
  }
}
