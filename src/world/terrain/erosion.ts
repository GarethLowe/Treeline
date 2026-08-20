/**
 * Droplet-based hydraulic erosion.
 *
 * Why real erosion instead of a cheaper valley-shaped noise trick: slope enters the
 * Rothermel spread rate as `tan^2 phi` (spec §20 Eq. 51), so terrain is not scenery here —
 * it is a first-order term in the physics. Fake valleys give plausible-looking slope
 * statistics with no *connectivity*: the channels do not join, do not deepen downstream and
 * do not agree with where water would actually go, so a fire pushed into a "canyon" is not
 * being channelled by anything real. Droplet erosion produces coherent dendritic networks
 * because it is a (crude) integration of the actual transport process, and connectivity is
 * an emergent property of it rather than an authored one.
 *
 * The scheme is the standard Lagrangian particle model: a droplet is stepped down the local
 * gradient with inertia, carrying a sediment load bounded by a capacity that grows with
 * speed, water volume and how steeply it is descending. Over capacity it deposits; under
 * capacity it erodes. Deposition is bilinear onto the four surrounding nodes; erosion is
 * spread over a small radial brush, because a single-node erode digs a one-cell spike that
 * the next droplet then falls into.
 *
 * ## Units
 *
 * Everything here works in **cell units**: height divided by the node spacing, position in
 * nodes. That makes `deltaHeight` per step literally the terrain gradient (dimensionless),
 * so a single set of tuned constants behaves identically at 1024 nodes over 1 km and at 256
 * nodes over the same kilometre — and, importantly, erosion stays *stronger on steeper
 * ground*, which it would not if the field were normalised to a unit height range first.
 *
 * These constants are engineering choices, not physical measurements; they are tuned for
 * plausible drainage geometry, and nothing downstream reads them as physics.
 */

import type { Rng } from './rng.ts'

export interface ErosionParams {
  /** Number of droplets. Cost is linear in this. */
  readonly droplets: number
  /** Maximum steps before a droplet is abandoned. */
  readonly maxLifetime: number
  /** 0 = follows the gradient exactly, 1 = never turns. Low values carve; high values wander. */
  readonly inertia: number
  /** Sediment capacity per unit (descent x speed x water). */
  readonly capacityFactor: number
  /** Floor on capacity, so a droplet on flat ground still carries a little. */
  readonly minCapacity: number
  /**
   * Ceiling on capacity, in cell units of height. Without it a droplet on a long steep
   * descent accumulates an unbounded load and dumps it in one place the moment the ground
   * flattens, building a spike tens of metres tall in a single cell — which shows up as a
   * slope tangent in the hundreds and is the single worst artefact this scheme produces.
   */
  readonly maxCapacity: number
  /**
   * Terminal speed. `speed^2 += -dh * gravity` grows without bound over a long descent,
   * and speed multiplies into capacity, so this is the other half of the same fix.
   */
  readonly maxSpeed: number
  /** Fraction of the capacity deficit converted to erosion per step. */
  readonly erodeSpeed: number
  /** Fraction of the excess load deposited per step. */
  readonly depositSpeed: number
  /** Water lost per step, as a fraction. */
  readonly evaporateSpeed: number
  /** Converts descent into speed. */
  readonly gravity: number
  readonly initialSpeed: number
  readonly initialWater: number
  /** Erosion brush radius in nodes. */
  readonly brushRadius: number
}

export const DEFAULT_EROSION: ErosionParams = {
  droplets: 250_000,
  maxLifetime: 48,
  inertia: 0.06,
  capacityFactor: 3.0,
  minCapacity: 0.005,
  maxCapacity: 0.6,
  maxSpeed: 4.0,
  erodeSpeed: 0.3,
  depositSpeed: 0.3,
  evaporateSpeed: 0.02,
  gravity: 4.0,
  initialSpeed: 1.0,
  initialWater: 1.0,
  brushRadius: 3,
}

export interface ErosionReport {
  readonly droplets: number
  /** Total material removed, in cell units of height. */
  readonly erodedCellUnits: number
  /** Total material re-deposited. */
  readonly depositedCellUnits: number
  /** Mean number of steps a droplet survived — a sanity check that droplets actually move. */
  readonly meanLifetime: number
}

interface Brush {
  readonly dx: Int32Array
  readonly dz: Int32Array
  readonly w: Float64Array
}

/** Radial falloff brush, weights summing to 1. Cached per radius. */
const brushCache = new Map<number, Brush>()

function makeBrush(radius: number): Brush {
  const cached = brushCache.get(radius)
  if (cached !== undefined) return cached
  const dx: number[] = []
  const dz: number[] = []
  const w: number[] = []
  let total = 0
  const r = Math.max(1, Math.floor(radius))
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = Math.sqrt(i * i + j * j)
      if (d > r) continue
      const weight = 1 - d / r
      if (weight <= 0) continue
      dx.push(i)
      dz.push(j)
      w.push(weight)
      total += weight
    }
  }
  const brush: Brush = {
    dx: Int32Array.from(dx),
    dz: Int32Array.from(dz),
    w: Float64Array.from(w, (v) => v / total),
  }
  brushCache.set(radius, brush)
  return brush
}

/**
 * Erode `h` (heights in **cell units**, row-major, `n x n`) in place.
 *
 * Deterministic: droplet start positions come only from `rng`, and droplets are simulated
 * strictly in sequence, so the result depends on the seed and nothing else.
 */
export function erodeDroplets(
  h: Float32Array,
  n: number,
  rng: Rng,
  params: ErosionParams,
): ErosionReport {
  const brush = makeBrush(params.brushRadius)
  const bn = brush.w.length
  const maxPos = n - 1.0001 // keep floor() inside [0, n-2] so the +1 neighbours exist
  let eroded = 0
  let deposited = 0
  let lifetimeSum = 0

  for (let d = 0; d < params.droplets; d++) {
    let posX = rng.range(0, maxPos)
    let posZ = rng.range(0, maxPos)
    let dirX = 0
    let dirZ = 0
    let speed = params.initialSpeed
    let water = params.initialWater
    let sediment = 0

    let step = 0
    for (; step < params.maxLifetime; step++) {
      const nodeX = Math.floor(posX)
      const nodeZ = Math.floor(posZ)
      const fx = posX - nodeX
      const fz = posZ - nodeZ
      const c = nodeZ * n + nodeX
      const h00 = h[c] as number
      const h10 = h[c + 1] as number
      const h01 = h[c + n] as number
      const h11 = h[c + n + 1] as number

      // Exact gradient of the bilinear patch the droplet is standing on.
      const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz
      const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx
      const height =
        h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz

      dirX = dirX * params.inertia - gx * (1 - params.inertia)
      dirZ = dirZ * params.inertia - gz * (1 - params.inertia)
      const len = Math.sqrt(dirX * dirX + dirZ * dirZ)
      if (len < 1e-12) break // dead flat and stationary: nothing left to do
      dirX /= len
      dirZ /= len

      posX += dirX
      posZ += dirZ
      if (posX < 0 || posZ < 0 || posX > maxPos || posZ > maxPos) break

      const nx = Math.floor(posX)
      const nz = Math.floor(posZ)
      const nfx = posX - nx
      const nfz = posZ - nz
      const nc = nz * n + nx
      const n00 = h[nc] as number
      const n10 = h[nc + 1] as number
      const n01 = h[nc + n] as number
      const n11 = h[nc + n + 1] as number
      const newHeight =
        n00 * (1 - nfx) * (1 - nfz) +
        n10 * nfx * (1 - nfz) +
        n01 * (1 - nfx) * nfz +
        n11 * nfx * nfz

      const dh = newHeight - height
      const capacity = Math.min(
        params.maxCapacity,
        Math.max(-dh * speed * water * params.capacityFactor, params.minCapacity),
      )

      if (sediment > capacity || dh > 0) {
        // Uphill step: drop at most enough to fill the rise, so the droplet cannot build a
        // dam taller than the obstacle it just hit. Otherwise shed the excess load.
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * params.depositSpeed
        if (amount > 0) {
          sediment -= amount
          deposited += amount
          h[c] = h00 + amount * (1 - fx) * (1 - fz)
          h[c + 1] = h10 + amount * fx * (1 - fz)
          h[c + n] = h01 + amount * (1 - fx) * fz
          h[c + n + 1] = h11 + amount * fx * fz
        }
      } else {
        // Never cut deeper than the drop just made, or the droplet outruns its own channel.
        const amount = Math.min((capacity - sediment) * params.erodeSpeed, -dh)
        if (amount > 0) {
          sediment += amount
          eroded += amount
          for (let b = 0; b < bn; b++) {
            const bi = nodeX + (brush.dx[b] as number)
            const bj = nodeZ + (brush.dz[b] as number)
            if (bi < 0 || bj < 0 || bi >= n || bj >= n) continue
            const bidx = bj * n + bi
            h[bidx] = (h[bidx] as number) - amount * (brush.w[b] as number)
          }
        }
      }

      speed = Math.min(params.maxSpeed, Math.sqrt(Math.max(0, speed * speed - dh * params.gravity)))
      water *= 1 - params.evaporateSpeed
      if (water < 1e-4) break
    }
    lifetimeSum += step
  }

  return {
    droplets: params.droplets,
    erodedCellUnits: eroded,
    depositedCellUnits: deposited,
    meanLifetime: params.droplets > 0 ? lifetimeSum / params.droplets : 0,
  }
}
