/**
 * Foliage placement (WP 1.4, spec §7.5 step 6).
 *
 * The whole package turns on this file. The Stem carries a crown bulk density; the crown
 * envelope turns that into a foliar biomass and a target vertical mass profile; and this is
 * where that mass becomes triangles. Two invariants are maintained by construction, and
 * then re-measured independently in `measure.ts`:
 *
 *   1. **Mass is exact at every LOD.** Every element carries W_f / N kg, and every element's
 *      card area is sized from its own mass through the species' specific leaf area and card
 *      coverage. Dropping to a coarser LOD keeps a subset of elements and scales the
 *      survivors' mass up by the same factor, so integrated foliar biomass is invariant
 *      across the LOD chain. A tree that loses fuel when it gets further away would make the
 *      canopy voxeliser's answer depend on the camera.
 *
 *   2. **Geometry stays inside the declared crown envelope, and touches it.** An element is
 *      placed at its attractor, then pushed just far enough inward that its own corners —
 *      whose offsets are known exactly, because the card is a quad with known basis vectors
 *      and half-extents — land on the envelope rather than outside it. The lowest elements
 *      therefore bottom out at exactly the declared crown base height. That is not a fudge:
 *      "the lowest live foliage" is the definition of crown base height, and this makes the
 *      mesh honour the definition instead of approximating it with a seed-dependent gap.
 */

import type { AttractorField, CrownSpec } from './crownShape.ts'
import type { FormParams } from './speciesForm.ts'
import type { Skeleton } from './skeleton.ts'
import type { Rng } from './rng.ts'
import { crownRadiusFrac } from './crownShape.ts'
import { PointGrid } from './spatialGrid.ts'
import { MeshBuilder, cross, normalise, perpendicular, type Vec3 } from './meshBuilder.ts'

export interface FoliageElement {
  /** Attractor position, tree-local. Clamped into the envelope at emit time. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** Long axis of the leaf spray — the direction the twig left the nearest branch. */
  readonly axis: Vec3
  /** Foliar mass this element stands for at LOD 0, kg. */
  readonly massKg: number
}

export interface FoliageEmitOptions {
  /** 2 = crossed quads (4 triangles), 1 = single quad (2 triangles). */
  readonly quads: 1 | 2
  /** Mass multiplier applied when a LOD keeps only a subset of elements. */
  readonly massScale: number
}

/**
 * Attach each foliage element to the nearest skeleton node and orient it along the twig
 * that would connect them. The twig itself is not meshed — spec §7.5 puts the terminal two
 * branch orders in the leaf-cluster card, which is also what every production foliage atlas
 * does, and meshing 1800 twigs per tree would roughly double the LOD-0 triangle count for
 * geometry that is entirely hidden behind its own leaves.
 */
export function placeFoliage(
  f: FormParams,
  field: AttractorField,
  sk: Skeleton,
  rng: Rng,
): FoliageElement[] {
  const nodes = sk.nodes
  const grid = new PointGrid(Math.max(0.05, sk.stepM * 2))
  for (let i = 0; i < nodes.length; i++) grid.insert(i, nodes[i]!.x, nodes[i]!.y, nodes[i]!.z)
  const gx = (i: number) => nodes[i]!.x
  const gy = (i: number) => nodes[i]!.y
  const gz = (i: number) => nodes[i]!.z

  const out: FoliageElement[] = []
  for (let i = 0; i < field.count; i++) {
    const x = field.positions[i * 3]!
    const y = field.positions[i * 3 + 1]!
    const z = field.positions[i * 3 + 2]!
    const ni = grid.nearest(x, y, z, gx, gy, gz)

    let axis: Vec3
    if (ni >= 0) {
      const n = nodes[ni]!
      const dx = x - n.x
      const dy = y - n.y
      const dz = z - n.z
      axis = Math.hypot(dx, dy, dz) > 1e-4 ? normalise([dx, dy, dz]) : [n.dx, n.dy, n.dz]
    } else {
      const rh = Math.hypot(x, z)
      axis = rh > 1e-4 ? normalise([x / rh, 0.35, z / rh]) : [0, 1, 0]
    }

    // Species droop plus a little scatter, so a spray does not read as a decal.
    const jx = rng.clampedGaussian() * 0.18
    const jz = rng.clampedGaussian() * 0.18
    axis = normalise([axis[0] + jx, axis[1] - f.cardDroop, axis[2] + jz])

    out.push({ x, y, z, axis, massKg: field.massPerAttractorKg })
  }
  return out
}

interface CardGeometry {
  readonly halfLenM: number
  readonly halfWidM: number
  readonly basis: readonly Vec3[]
  readonly axis: Vec3
}

function cardGeometry(f: FormParams, massKg: number, axis: Vec3, quads: 1 | 2): CardGeometry {
  const leafAreaM2 = Math.max(1e-9, massKg * f.specificLeafAreaM2PerKg)
  const geometricAreaM2 = leafAreaM2 / Math.max(1e-6, f.cardCoverage)
  const perQuad = geometricAreaM2 / quads
  const lengthM = Math.sqrt(perQuad * f.cardAspect)
  const widthM = Math.sqrt(perQuad / f.cardAspect)

  const b1 = perpendicular(axis)
  const b2 = normalise(cross(axis, b1))
  return {
    halfLenM: lengthM / 2,
    halfWidM: widthM / 2,
    basis: quads === 2 ? [b1, b2] : [b1],
    axis,
  }
}

/**
 * Emit foliage cards. Returns the total foliar mass actually placed, kg — which the caller
 * can cross-check against the field's declared total, though `measure.ts` re-derives it from
 * triangle areas independently and that is the number the acceptance test uses.
 *
 * Placement works on the card's **actual corner offsets** rather than on a bounding
 * half-extent. The difference matters more than it sounds: a bound is always an over-estimate
 * in every direction at once, so clamping against it leaves the geometry sitting inside the
 * declared envelope by a margin that varies with the card's orientation. That margin becomes
 * a systematic under-measurement of crown volume, and therefore a systematic over-estimate of
 * crown bulk density — a bias of several percent, eating budget that belongs to the mesh
 * cache's quantisation.
 */
export function addFoliage(
  mb: MeshBuilder,
  f: FormParams,
  crown: CrownSpec,
  elements: readonly FoliageElement[],
  opts: FoliageEmitOptions,
): number {
  const depth = Math.max(1e-4, crown.heightM - crown.crownBaseM)
  let placedKg = 0

  // Corner offsets, reused per element: 4 per quad, at most 8.
  const ox = new Float64Array(8)
  const oy = new Float64Array(8)
  const oz = new Float64Array(8)

  for (const el of elements) {
    const massKg = el.massKg * opts.massScale
    const card = cardGeometry(f, massKg, el.axis, opts.quads)
    const a = card.axis
    const hl = card.halfLenM
    const hw = card.halfWidM

    // Corners in cycle order, so the quad below is convex without a reorder:
    // (-l,-w) (+l,-w) (+l,+w) (-l,+w).
    const SL = [-1, 1, 1, -1]
    const SW = [-1, -1, 1, 1]
    let nOff = 0
    let maxOffsetY = 0
    for (const b of card.basis) {
      for (let k = 0; k < 4; k++) {
        const sl = SL[k]!
        const sw = SW[k]!
        ox[nOff] = a[0] * hl * sl + b[0] * hw * sw
        oy[nOff] = a[1] * hl * sl + b[1] * hw * sw
        oz[nOff] = a[2] * hl * sl + b[2] * hw * sw
        maxOffsetY = Math.max(maxOffsetY, Math.abs(oy[nOff]!))
        nOff++
      }
    }

    // Vertical placement: the lowest corner lands on the crown base, the highest on the crown
    // top. That is not a fudge — "the lowest live foliage" *is* the definition of crown base
    // height, and this makes the mesh honour it exactly instead of leaving a gap that varies
    // with the seed. Where the card is taller than the whole crown (a 40 cm Calluna at a
    // coarse LOD), centre it and let it overhang: reporting a wrong crown base would be worse
    // than a chunky impostor.
    const loY = crown.crownBaseM + maxOffsetY
    const hiY = crown.heightM - maxOffsetY
    const cy =
      loY <= hiY
        ? Math.min(hiY, Math.max(loY, el.y))
        : 0.5 * (crown.crownBaseM + crown.heightM)

    // Radial placement: pull the element inward until no corner pokes through the envelope
    // *at that corner's own height*. Testing against the envelope at the card centre is not
    // good enough — a long, near-vertical spray has corners well above its centre, where a
    // tapering crown is much narrower, and the resulting overhang shows up as a systematic
    // over-measurement of crown volume (13-17% on the grass and fern forms, whose cards are
    // long relative to their crowns) and therefore an under-report of bulk density.
    //
    // Each corner's height is already fixed by the vertical clamp, so its envelope radius is
    // a constant and only the radial offset needs iterating. Two passes converge: the first
    // removes the excess measured at the current position, the second corrects for the
    // corners' radial directions differing from the centre's.
    let r = Math.hypot(el.x, el.z)
    const ux = r > 1e-9 ? el.x / r : 1
    const uz = r > 1e-9 ? el.z / r : 0
    const envR = new Float64Array(nOff)
    for (let i = 0; i < nOff; i++) {
      const ty = Math.min(1, Math.max(0, (cy + oy[i]! - crown.crownBaseM) / depth))
      envR[i] = crown.crownRadiusM * crownRadiusFrac(f, ty)
    }
    for (let pass = 0; pass < 2 && r > 0; pass++) {
      const px = ux * r
      const pz = uz * r
      let excess = 0
      for (let i = 0; i < nOff; i++) {
        excess = Math.max(excess, Math.hypot(px + ox[i]!, pz + oz[i]!) - envR[i]!)
      }
      if (excess <= 0) break
      r = Math.max(0, r - excess)
    }
    const cx = ux * r
    const cz = uz * r

    for (let q = 0; q < card.basis.length; q++) {
      const b = card.basis[q]!
      // The card's normal is the third axis of its own frame.
      const n = normalise(cross(a, b))
      const base = q * 4
      const U = [0, 1, 1, 0]
      const V = [0, 0, 1, 1]
      // The emitted vertices are exactly the corners that were clamped above — no
      // recomputation, so geometry and envelope test cannot disagree.
      const c0 = mb.vertex(cx + ox[base]!, cy + oy[base]!, cz + oz[base]!, n[0], n[1], n[2], U[0]!, V[0]!)
      const c1 = mb.vertex(cx + ox[base + 1]!, cy + oy[base + 1]!, cz + oz[base + 1]!, n[0], n[1], n[2], U[1]!, V[1]!)
      const c2 = mb.vertex(cx + ox[base + 2]!, cy + oy[base + 2]!, cz + oz[base + 2]!, n[0], n[1], n[2], U[2]!, V[2]!)
      const c3 = mb.vertex(cx + ox[base + 3]!, cy + oy[base + 3]!, cz + oz[base + 3]!, n[0], n[1], n[2], U[3]!, V[3]!)
      mb.quad(c0, c1, c2, c3)
    }
    placedKg += massKg
  }
  return placedKg
}

/**
 * Keep every `stride`-th element and scale the survivors' mass so the subset carries the
 * same total. Because elements are stratified in the crown's mass CDF, a stride-subset is
 * still stratified — the coarse LOD keeps the vertical mass profile, not just the total.
 */
export function decimate(
  elements: readonly FoliageElement[],
  targetCount: number,
): { readonly kept: FoliageElement[]; readonly massScale: number } {
  if (targetCount >= elements.length || targetCount <= 0) {
    return { kept: [...elements], massScale: 1 }
  }
  const stride = Math.max(1, Math.floor(elements.length / targetCount))
  const kept: FoliageElement[] = []
  for (let i = 0; i < elements.length; i += stride) kept.push(elements[i]!)
  return { kept, massScale: elements.length / kept.length }
}
