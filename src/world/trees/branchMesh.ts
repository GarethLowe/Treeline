/**
 * Woody geometry: swept tubes along the skeleton chains (WP 1.4).
 *
 * The frame is parallel-transported rather than rebuilt per ring from a fixed up-vector.
 * A fixed up-vector flips when a branch passes through horizontal, which puts a visible
 * twist in the bark UVs and, worse, produces a bow-tie ring whose two triangles have
 * opposite winding — which then shows up as a degenerate/inverted triangle in the geometry
 * sanity test rather than as an obvious visual bug.
 */

import type { SkeletonNode } from './skeleton.ts'
import { MeshBuilder, cross, normalise, perpendicular, type Vec3 } from './meshBuilder.ts'

export interface TubeOptions {
  /** Radial segments as a function of radius. Returning < 3 skips the tube entirely. */
  readonly sidesFor: (radiusM: number) => number
  /** Metres of bark texture per unit v. */
  readonly barkTileM: number
  /** Cone the last ring down to a point, closing the branch tip. */
  readonly capTips: boolean
  /** Keep every n-th node of the chain (the ends are always kept). Straightens the sweep. */
  readonly nodeStride: number
  /** Chains with fewer nodes than this after striding are dropped entirely. */
  readonly minChainNodes: number
}

export const LOD0_TUBE: TubeOptions = {
  sidesFor: (r) => (r > 0.12 ? 8 : r > 0.045 ? 6 : 4),
  barkTileM: 0.6,
  capTips: true,
  nodeStride: 1,
  minChainNodes: 2,
}

export const LOD1_TUBE: TubeOptions = {
  sidesFor: (r) => (r > 0.09 ? 6 : 4),
  barkTileM: 0.6,
  capTips: false,
  nodeStride: 2,
  minChainNodes: 3,
}

export const LOD2_TUBE: TubeOptions = {
  sidesFor: (r) => (r > 0.06 ? 5 : 3),
  barkTileM: 0.6,
  capTips: false,
  nodeStride: 3,
  minChainNodes: 3,
}

/** Sweep one polyline of skeleton nodes as a closed tube. Returns triangles added. */
export function addTube(
  mb: MeshBuilder,
  nodes: readonly SkeletonNode[],
  fullChain: readonly number[],
  opts: TubeOptions,
): number {
  if (fullChain.length < opts.minChainNodes) return 0
  // Stride the polyline for the reduced LODs. The first and last nodes always survive, so a
  // limb keeps its start at the junction and its full length.
  let chain = fullChain
  if (opts.nodeStride > 1) {
    const strided: number[] = []
    for (let i = 0; i < fullChain.length; i += opts.nodeStride) strided.push(fullChain[i]!)
    const last = fullChain[fullChain.length - 1]!
    if (strided[strided.length - 1] !== last) strided.push(last)
    chain = strided
  }
  if (chain.length < 2) return 0

  let maxR = 0
  for (const i of chain) maxR = Math.max(maxR, nodes[i]!.radius)
  const sides = Math.max(3, Math.round(opts.sidesFor(maxR)))
  const before = mb.triangleCount

  // Initial frame.
  const first = nodes[chain[0]!]!
  const second = nodes[chain[1]!]!
  let tangent = normalise([second.x - first.x, second.y - first.y, second.z - first.z])
  let normal = perpendicular(tangent)

  let prevRing: number[] | null = null
  let vRun = 0

  for (let c = 0; c < chain.length; c++) {
    const node = nodes[chain[c]!]!
    const next = c + 1 < chain.length ? nodes[chain[c + 1]!]! : null

    if (next !== null) {
      const newTangent = normalise([next.x - node.x, next.y - node.y, next.z - node.z])
      // Parallel transport: rotate the reference normal by the same rotation that takes the
      // old tangent onto the new one, then re-orthogonalise.
      const axis = cross(tangent, newTangent)
      const axisLen = Math.hypot(axis[0], axis[1], axis[2])
      if (axisLen > 1e-8) {
        const dot = Math.max(-1, Math.min(1, tangent[0] * newTangent[0] + tangent[1] * newTangent[1] + tangent[2] * newTangent[2]))
        const angle = Math.acos(dot)
        const a = normalise(axis)
        const ca = Math.cos(angle)
        const sa = Math.sin(angle)
        const d = a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2]
        const cr = cross(a, normal)
        normal = normalise([
          normal[0] * ca + cr[0] * sa + a[0] * d * (1 - ca),
          normal[1] * ca + cr[1] * sa + a[1] * d * (1 - ca),
          normal[2] * ca + cr[2] * sa + a[2] * d * (1 - ca),
        ])
      }
      tangent = newTangent
    }

    // Re-orthogonalise against drift.
    const dotTN = tangent[0] * normal[0] + tangent[1] * normal[1] + tangent[2] * normal[2]
    normal = normalise([
      normal[0] - tangent[0] * dotTN,
      normal[1] - tangent[1] * dotTN,
      normal[2] - tangent[2] * dotTN,
    ])
    const binormal = normalise(cross(tangent, normal))

    if (c > 0) {
      const prev = nodes[chain[c - 1]!]!
      vRun += Math.hypot(node.x - prev.x, node.y - prev.y, node.z - prev.z)
    }
    const v = vRun / opts.barkTileM

    const ring: number[] = []
    const r = Math.max(1e-4, node.radius)
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * 2 * Math.PI
      const cs = Math.cos(a)
      const sn = Math.sin(a)
      const nx = normal[0] * cs + binormal[0] * sn
      const ny = normal[1] * cs + binormal[1] * sn
      const nz = normal[2] * cs + binormal[2] * sn
      ring.push(
        mb.vertex(node.x + nx * r, node.y + ny * r, node.z + nz * r, nx, ny, nz, s / sides, v),
      )
    }

    if (prevRing !== null) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides
        mb.quad(prevRing[s]!, ring[s]!, ring[s2]!, prevRing[s2]!)
      }
    }
    prevRing = ring
  }

  if (opts.capTips && prevRing !== null) {
    const tip = nodes[chain[chain.length - 1]!]!
    const apex = mb.vertex(
      tip.x + tangent[0] * tip.radius,
      tip.y + tangent[1] * tip.radius,
      tip.z + tangent[2] * tip.radius,
      tangent[0],
      tangent[1],
      tangent[2],
      0.5,
      vRun / opts.barkTileM,
    )
    for (let s = 0; s < sides; s++) {
      mb.tri(prevRing[s]!, apex, prevRing[(s + 1) % sides]!)
    }
  }

  return mb.triangleCount - before
}

/** Total swept woody volume of a chain set, m3 — the 1-h/10-h/100-h load M2 will want. */
export function woodyVolumeM3(nodes: readonly SkeletonNode[], chains: readonly (readonly number[])[]): number {
  let vol = 0
  for (const chain of chains) {
    for (let c = 1; c < chain.length; c++) {
      const a = nodes[chain[c - 1]!]!
      const b = nodes[chain[c]!]!
      const h = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      // Conical frustum.
      vol += (Math.PI * h * (a.radius * a.radius + a.radius * b.radius + b.radius * b.radius)) / 3
    }
  }
  return vol
}

export { normalise as normaliseVec3 }
export type { Vec3 }
