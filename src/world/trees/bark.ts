/**
 * Shed-able bark as explicit strip geometry (WP 1.4, spec §7.5 step 8).
 *
 * This is the one piece of tree geometry that exists for a physics reason rather than a
 * visual one. Decorticating and stringy eucalypt bark is the dominant long-range firebrand
 * source in Australian dry forest and is why eucalypt spotting reaches kilometres (spec §40,
 * §7.5). At M3 the Lagrangian brand emitter samples these strips directly, so the strips
 * must be *addressable* — hence their own `ribbon` submesh with its own index range, rather
 * than being folded into the bark tube or painted into a texture.
 *
 * A note on morphology, because the spec is explicit about it and it is easy to get wrong:
 * *E. obliqua* (messmate stringybark) and *E. marginata* (jarrah) carry persistent rough
 * fibrous bark shed as long flat strips; they do **not** decorticate in ribbons. True ribbon
 * bark belongs to the smooth-barked gums (*E. viminalis*, *E. rubida*, *E. globulus*). Both
 * shed, both launch brands, and both land on the contract's single `ribbon` material slot —
 * but the strip dimensions and areal density differ, and `speciesForm.ts` keeps them apart.
 */

import type { CrownSpec } from './crownShape.ts'
import type { FormParams } from './speciesForm.ts'
import type { Skeleton, SkeletonNode } from './skeleton.ts'
import type { Rng } from './rng.ts'
import { MeshBuilder, cross, normalise, perpendicular, type Vec3 } from './meshBuilder.ts'

export interface BarkStripStats {
  readonly stripCount: number
  /** One-sided geometric area of all strips, m2. */
  readonly areaM2: number
  /** Mass of shed-able bark on the tree, kg. The firebrand reservoir M3 draws from. */
  readonly massKg: number
}

const EMPTY: BarkStripStats = { stripCount: 0, areaM2: 0, massKg: 0 }

/** Position and outward normal on the trunk at height `y`, by walking the trunk chain. */
function trunkPointAt(
  nodes: readonly SkeletonNode[],
  chain: readonly number[],
  y: number,
): { p: Vec3; radius: number } | null {
  for (let i = 1; i < chain.length; i++) {
    const a = nodes[chain[i - 1]!]!
    const b = nodes[chain[i]!]!
    if (y >= a.y && y <= b.y) {
      const s = b.y - a.y > 1e-9 ? (y - a.y) / (b.y - a.y) : 0
      return {
        p: [a.x + (b.x - a.x) * s, y, a.z + (b.z - a.z) * s],
        radius: a.radius + (b.radius - a.radius) * s,
      }
    }
  }
  return null
}

/**
 * Emit hanging bark strips on the `ribbon` submesh. Strips attach at a height on the bole,
 * hang downward, and curl away from the trunk — a partly-shed strip, which is both the
 * recognisable silhouette and the state a strip is in when it becomes a brand.
 */
export function addBarkStrips(
  mb: MeshBuilder,
  f: FormParams,
  crown: CrownSpec,
  sk: Skeleton,
  rng: Rng,
  segments = 4,
): BarkStripStats {
  if (!f.hasBarkStrips || f.stripsPerMetre <= 0) return EMPTY
  const chain = sk.trunkChains[0]
  if (chain === undefined || chain.length < 2) return EMPTY

  const nodes = sk.nodes
  const trunkTop = nodes[chain[chain.length - 1]!]!.y
  const loY = Math.min(0.15 * crown.heightM, 0.5 * trunkTop)
  const hiY = trunkTop
  if (hiY - loY < 0.3) return EMPTY

  const count = Math.max(1, Math.round((hiY - loY) * f.stripsPerMetre))
  const stripLen = Math.max(0.15, f.stripLengthFrac * (hiY - loY))
  const halfW = f.stripWidthM / 2
  let areaM2 = 0

  for (let s = 0; s < count; s++) {
    const attachY = loY + ((s + rng.next()) / count) * (hiY - loY)
    const hit = trunkPointAt(nodes, chain, attachY)
    if (hit === null) continue

    const az = rng.next() * 2 * Math.PI
    const outward: Vec3 = [Math.cos(az), 0, Math.sin(az)]
    const len = stripLen * rng.range(0.6, 1.25)
    const segLen = len / segments
    // Peel amplitude: how far the free end swings clear of the bole.
    const peel = rng.range(0.35, 1.0) * Math.min(0.5, hit.radius * 3 + 0.05)
    const twist = rng.range(-1.2, 1.2)

    let prevA = -1
    let prevB = -1
    for (let k = 0; k <= segments; k++) {
      const u = k / segments
      // Hangs down; the free end (u -> 1) bows outward and twists.
      const bow = peel * u * u
      const y = attachY - len * u
      const rad = hit.radius + 0.01 + bow
      const cx = hit.p[0] + outward[0] * rad
      const cz = hit.p[2] + outward[2] * rad

      const along: Vec3 = normalise([outward[0] * (bow / Math.max(1e-4, len)), -1, outward[2] * (bow / Math.max(1e-4, len))])
      const side0 = perpendicular(along)
      const ang = twist * u
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      const other = normalise(cross(along, side0))
      const side: Vec3 = normalise([
        side0[0] * ca + other[0] * sa,
        side0[1] * ca + other[1] * sa,
        side0[2] * ca + other[2] * sa,
      ])
      const nrm = normalise(cross(along, side))

      const a = mb.vertex(
        cx - side[0] * halfW, y - side[1] * halfW, cz - side[2] * halfW,
        nrm[0], nrm[1], nrm[2], 0, u,
      )
      const b = mb.vertex(
        cx + side[0] * halfW, y + side[1] * halfW, cz + side[2] * halfW,
        nrm[0], nrm[1], nrm[2], 1, u,
      )
      if (prevA >= 0) {
        mb.quad(prevA, a, b, prevB)
        areaM2 += segLen * f.stripWidthM
      }
      prevA = a
      prevB = b
    }
  }

  return {
    stripCount: count,
    areaM2,
    massKg: areaM2 * f.stripArealDensityKgM2,
  }
}
