/**
 * Woody skeleton by space colonisation (WP 1.4, spec §7.5, Runions et al. 2007).
 *
 * The reason this project uses space colonisation rather than an L-system is stated in spec
 * §7.5: the physics prescribes a *target vertical profile of canopy bulk density*, and space
 * colonisation lets that profile be the attractor density field directly. An L-system
 * produces self-similar structure, but hitting a prescribed CBD(z) with one means a
 * parameter search per species per stand. Here the branches grow densest exactly where the
 * fuel mass is densest, because that is where the attractors are.
 *
 * The three growth forms the assignment calls for come out of four parameters rather than
 * three code paths:
 *   - conifer   — one leader to the apex (`leaderHeightFrac` 1), high `apicalDominance`,
 *                 branching permitted only at whorl heights, strong radial tropism.
 *   - broadleaf — leader stops below the crown top, low apical dominance, so the attractors
 *                 in the upper crown recruit several competing leaders on their own.
 *   - shrub     — `basalStems` > 1 seeded from the base, no trunk worth the name, and a
 *                 crown base within a few centimetres of the ground.
 */

import type { AttractorField, CrownSpec } from './crownShape.ts'
import type { FormParams } from './speciesForm.ts'
import type { Rng } from './rng.ts'
import { crownDepthM, crownVolumeM3 } from './crownShape.ts'

export interface SkeletonNode {
  x: number
  y: number
  z: number
  /** Index of the parent node, or -1 for a root. */
  parent: number
  /** Unit direction of the segment arriving at this node. */
  dx: number
  dy: number
  dz: number
  /** Pipe-model radius, metres. Filled by `assignRadii`. */
  radius: number
  /** Part of a seeded trunk/basal stem rather than a colonisation-grown branch. */
  isTrunk: boolean
  /** Whether new branches may be recruited here. False on inter-whorl trunk nodes. */
  canBranch: boolean
}

export interface Skeleton {
  readonly nodes: readonly SkeletonNode[]
  /** Node indices of the seeded trunk / basal stems, root-first. One list per stem. */
  readonly trunkChains: readonly (readonly number[])[]
  /** Growth step D, metres. */
  readonly stepM: number
  /** Iterations the colonisation actually ran, for diagnostics. */
  readonly iterations: number
  /** Attractors never reached (node cap hit, or unreachable pocket). */
  readonly orphanAttractors: number
}

// ---------------------------------------------------------------------------
// Spatial hash over nodes — space colonisation is O(|S| x |N|) without one, which for
// 3200 attractors and ~900 nodes over ~100 iterations is a third of a billion distance
// tests per tree. With a grid keyed at the influence radius it is a couple of million.
// ---------------------------------------------------------------------------

class NodeGrid {
  private readonly cells = new Map<number, number[]>()

  constructor(private readonly cellSize: number) {}

  private static key(ix: number, iy: number, iz: number): number {
    // 10 bits per axis. Distant cells can collide; that only ever adds candidates, and
    // every candidate is distance-tested anyway, so collisions cost time and never
    // correctness.
    return (((ix & 1023) << 20) | ((iy & 1023) << 10) | (iz & 1023)) >>> 0
  }

  insert(index: number, x: number, y: number, z: number): void {
    const k = NodeGrid.key(
      Math.floor(x / this.cellSize),
      Math.floor(y / this.cellSize),
      Math.floor(z / this.cellSize),
    )
    const bucket = this.cells.get(k)
    if (bucket) bucket.push(index)
    else this.cells.set(k, [index])
  }

  /** Nearest inserted node within `maxDist`, or -1. Returns squared distance via `out`. */
  nearest(
    nodes: readonly SkeletonNode[],
    x: number,
    y: number,
    z: number,
    maxDist: number,
    out: { d2: number },
  ): number {
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    let best = -1
    let bestD2 = maxDist * maxDist
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = this.cells.get(NodeGrid.key(cx + ox, cy + oy, cz + oz))
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const ni = bucket[i]!
            const n = nodes[ni]!
            const dx = n.x - x
            const dy = n.y - y
            const dz = n.z - z
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 < bestD2) {
              bestD2 = d2
              best = ni
            }
          }
        }
      }
    }
    out.d2 = bestD2
    return best
  }
}

// ---------------------------------------------------------------------------
// Trunk / basal stem seeding
// ---------------------------------------------------------------------------

function pushNode(
  nodes: SkeletonNode[],
  x: number,
  y: number,
  z: number,
  parent: number,
  dx: number,
  dy: number,
  dz: number,
  isTrunk: boolean,
  canBranch: boolean,
): number {
  nodes.push({ x, y, z, parent, dx, dy, dz, radius: 0, isTrunk, canBranch })
  return nodes.length - 1
}

/**
 * Seed the trunk (or basal stems). Everything above this is colonisation-grown.
 *
 * Whorls: conifers put their branches in discrete tiers, and that is not decoration — a
 * whorled crown has vertical gaps in its foliage that a continuous branching model does not
 * reproduce, and those gaps are what the crown-fire model sees as a discontinuous vertical
 * fuel path. Implemented by clearing `canBranch` on inter-whorl trunk nodes, which also
 * removes them from the attractor-association grid so they cannot silently absorb
 * attractors that a whorl node should have taken.
 */
function seedTrunks(
  f: FormParams,
  crown: CrownSpec,
  step: number,
  rng: Rng,
): { nodes: SkeletonNode[]; chains: number[][] } {
  const nodes: SkeletonNode[] = []
  const chains: number[][] = []
  const depth = Math.max(0.02, crown.heightM - crown.crownBaseM)
  const whorlSpacing = f.whorlSpacingFrac > 0 ? Math.max(step, f.whorlSpacingFrac * depth) : 0
  const stems = Math.max(1, Math.round(f.basalStems))

  for (let s = 0; s < stems; s++) {
    const top = Math.max(step, f.leaderHeightFrac * crown.heightM)
    const count = Math.max(1, Math.round(top / step))
    // Multi-stemmed forms lean their stems outward from a common root plate.
    const az = stems === 1 ? 0 : ((s + rng.next() * 0.6) / stems) * 2 * Math.PI
    const lean = stems === 1 ? 0 : rng.range(0.12, 0.32)
    const leanX = Math.cos(az) * lean
    const leanZ = Math.sin(az) * lean

    let x = stems === 1 ? 0 : Math.cos(az) * crown.crownRadiusM * 0.06
    let z = stems === 1 ? 0 : Math.sin(az) * crown.crownRadiusM * 0.06
    let y = 0
    let prev = pushNode(nodes, x, y, z, -1, 0, 1, 0, true, false)
    const chain = [prev]
    let nextWhorl = crown.crownBaseM

    for (let i = 1; i <= count; i++) {
      // Sinuosity: a real bole wanders. Kept small; it is the difference between a tree and
      // a lamppost, and it also breaks the perfectly radial symmetry of the whorls.
      const wander = f.sinuosity * step
      const ax = leanX * step + rng.clampedGaussian() * wander
      const az2 = leanZ * step + rng.clampedGaussian() * wander
      const nx = x + ax
      const nz = z + az2
      const ny = y + step
      let len = Math.hypot(ax, step, az2)
      if (len < 1e-9) len = 1

      let canBranch = ny >= crown.crownBaseM - 0.5 * step
      if (canBranch && whorlSpacing > 0) {
        if (ny + 1e-9 >= nextWhorl) {
          nextWhorl = ny + whorlSpacing
        } else {
          canBranch = false
        }
      }
      // The apex always recruits, otherwise a conifer leader stops dead below the crown top.
      if (i === count) canBranch = true

      prev = pushNode(nodes, nx, ny, nz, prev, ax / len, step / len, az2 / len, true, canBranch)
      chain.push(prev)
      x = nx
      y = ny
      z = nz
    }
    chains.push(chain)
  }

  return { nodes, chains }
}

// ---------------------------------------------------------------------------
// Space colonisation
// ---------------------------------------------------------------------------

/**
 * Growth step D, from the crown volume and the node budget. See `FormParams.stepScale`.
 * Clamped so a pathological aspect ratio cannot produce a step longer than the crown.
 */
export function growthStep(f: FormParams, crown: CrownSpec): number {
  const depth = crownDepthM(crown)
  const volume = Math.max(1e-6, crownVolumeM3(f, crown.crownRadiusM, depth))
  const budget = Math.max(16, Math.round(f.maxSkeletonNodes))
  const spacing = Math.cbrt(volume / budget)
  const raw = f.stepScale * spacing
  return Math.min(Math.max(raw, 1e-3), 0.5 * Math.max(depth, crown.crownRadiusM))
}

export function growSkeleton(
  f: FormParams,
  crown: CrownSpec,
  field: AttractorField,
  rng: Rng,
): Skeleton {
  const maxNodes = Math.max(16, Math.round(f.maxSkeletonNodes))
  const step = growthStep(f, crown)
  const influence = f.influenceSteps * step
  const kill = f.killSteps * step

  const { nodes, chains } = seedTrunks(f, crown, step, rng)
  const nodeCap = Math.max(nodes.length + 8, maxNodes)

  const grid = new NodeGrid(influence)
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.canBranch) grid.insert(i, nodes[i]!.x, nodes[i]!.y, nodes[i]!.z)
  }

  // Live attractors are kept in a compacted index list rather than a flag array: the outer
  // loop is O(iterations x live attractors), and once most of the crown has been colonised
  // the live set is a small fraction of the field.
  const n = field.count
  const live = new Int32Array(n)
  for (let i = 0; i < n; i++) live[i] = i
  let liveCount = n

  // Per-node accumulated growth direction. Sized to the cap so it is allocated once.
  const accX = new Float64Array(nodeCap)
  const accY = new Float64Array(nodeCap)
  const accZ = new Float64Array(nodeCap)
  const accN = new Int32Array(nodeCap)
  const touched: number[] = []
  const out = { d2: 0 }

  const maxIterations = 260
  let iterations = 0

  for (; iterations < maxIterations; iterations++) {
    if (liveCount === 0 || nodes.length >= nodeCap) break

    for (let i = 0; i < touched.length; i++) {
      const t = touched[i]!
      accX[t] = 0
      accY[t] = 0
      accZ[t] = 0
      accN[t] = 0
    }
    touched.length = 0

    let write = 0
    for (let k = 0; k < liveCount; k++) {
      const a = live[k]!
      const ax = field.positions[a * 3]!
      const ay = field.positions[a * 3 + 1]!
      const az = field.positions[a * 3 + 2]!
      const ni = grid.nearest(nodes, ax, ay, az, influence, out)
      if (ni >= 0 && out.d2 <= kill * kill) continue // consumed
      live[write++] = a
      if (ni < 0) continue
      const node = nodes[ni]!
      const dx = ax - node.x
      const dy = ay - node.y
      const dz = az - node.z
      const len = Math.sqrt(out.d2) || 1
      if (accN[ni] === 0) touched.push(ni)
      accX[ni]! += dx / len
      accY[ni]! += dy / len
      accZ[ni]! += dz / len
      accN[ni]!++
    }
    liveCount = write

    if (touched.length === 0) break

    let grown = 0
    for (let i = 0; i < touched.length; i++) {
      if (nodes.length >= nodeCap) break
      const ni = touched[i]!
      const node = nodes[ni]!

      let vx = accX[ni]!
      let vy = accY[ni]!
      let vz = accZ[ni]!
      let m = Math.hypot(vx, vy, vz)
      if (m < 1e-9) continue
      vx /= m
      vy /= m
      vz /= m

      // Tropisms and apical dominance, spec §7.5 / Runions §4.
      const rh = Math.hypot(node.x, node.z)
      if (rh > 1e-6 && f.tropismRadial !== 0) {
        vx += (node.x / rh) * f.tropismRadial
        vz += (node.z / rh) * f.tropismRadial
      }
      vy += f.tropismY
      if (f.apicalDominance > 0) {
        vx += node.dx * f.apicalDominance
        vy += node.dy * f.apicalDominance
        vz += node.dz * f.apicalDominance
      }
      m = Math.hypot(vx, vy, vz)
      if (m < 1e-9) continue
      vx /= m
      vy /= m
      vz /= m

      const nx = node.x + vx * step
      const ny = node.y + vy * step
      const nz = node.z + vz * step
      // Never grow into the ground, and never above the declared tree height: both would
      // put woody geometry outside the envelope the fuel parameters describe.
      if (ny < 0 || ny > crown.heightM) continue

      const idx = pushNode(nodes, nx, ny, nz, ni, vx, vy, vz, false, true)
      grid.insert(idx, nx, ny, nz)
      grown++
    }

    if (grown === 0) break
  }

  return { nodes, trunkChains: chains, stepM: step, iterations, orphanAttractors: liveCount }
}

// ---------------------------------------------------------------------------
// Pipe model (Shinozaki et al. 1964; spec §7.5 step 5)
// ---------------------------------------------------------------------------

/**
 * Assign branch radii by the pipe model, then scale the whole tree so the measured stem
 * diameter at breast height equals the Stem's declared DBH.
 *
 * The scaling step is the part that matters: it anchors woody volume to a *physical* stem
 * parameter rather than to an art constant. Terminal radius then falls out of the pipe
 * exponent and the topology instead of being dialled in.
 */
export function assignRadii(sk: Skeleton, dbhM: number, totalHeightM: number, exponent = 2.3): void {
  const nodes = sk.nodes
  const childAcc = new Float64Array(nodes.length)
  const childCount = new Int32Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i]!.parent
    if (p >= 0) childCount[p]!++
  }

  // Nodes are always created after their parent, so a reverse sweep is a valid topological
  // order — no sort needed.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    const r = childCount[i] === 0 ? 1 : Math.pow(childAcc[i]!, 1 / exponent)
    node.radius = r
    const p = node.parent
    if (p >= 0) childAcc[p]! += Math.pow(r, exponent)
  }

  // Reference height: breast height where the plant is tall enough for it to mean anything,
  // otherwise a quarter of the way up. A 0.4 m Calluna has no breast height.
  const refY = Math.min(1.3, 0.25 * totalHeightM)
  let sumSq = 0
  for (const chain of sk.trunkChains) {
    let picked = -1
    for (let i = 0; i < chain.length; i++) {
      const ni = chain[i]!
      if (nodes[ni]!.y <= refY) picked = ni
      else break
    }
    if (picked < 0) picked = chain[0] ?? -1
    if (picked >= 0) sumSq += nodes[picked]!.radius * nodes[picked]!.radius
  }
  if (sumSq <= 0) sumSq = 1

  // Total basal cross-sectional area of all stems equals that of the declared DBH.
  const scale = dbhM / 2 / Math.sqrt(sumSq)
  const minRadius = Math.max(4e-4, dbhM * 0.004)
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.radius = Math.max(minRadius, nodes[i]!.radius * scale)
  }
}

// ---------------------------------------------------------------------------
// Chain extraction — turns the node forest into polylines the tube mesher can sweep
// ---------------------------------------------------------------------------

/**
 * Split the skeleton into polylines. Each polyline follows the thickest child at every
 * junction, so the trunk and each main limb come out as one continuous tube; side branches
 * start a new polyline whose first point is the junction node, which closes the visual gap
 * at the fork without needing a joint solid.
 */
export function extractChains(sk: Skeleton, minRadius = 0): number[][] {
  const nodes = sk.nodes
  const children: number[][] = Array.from({ length: nodes.length }, () => [])
  const roots: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i]!.parent
    if (p >= 0) children[p]!.push(i)
    else roots.push(i)
  }

  const chains: number[][] = []
  const stack: number[] = [...roots]
  const started = new Uint8Array(nodes.length)
  for (const r of roots) started[r] = 1

  while (stack.length > 0) {
    const start = stack.pop()!
    const chain: number[] = [start]
    let cur = start
    for (;;) {
      const kids = children[cur]!
      if (kids.length === 0) break
      let primary = kids[0]!
      for (let i = 1; i < kids.length; i++) {
        if (nodes[kids[i]!]!.radius > nodes[primary]!.radius) primary = kids[i]!
      }
      for (const k of kids) {
        if (k !== primary && started[k] === 0) {
          started[k] = 1
          // A side chain starts at the junction so its tube begins inside the parent limb.
          stack.push(k)
        }
      }
      chain.push(primary)
      cur = primary
    }
    chains.push(chain)
  }

  // Re-root the side chains at their junction node.
  const out: number[][] = []
  for (const chain of chains) {
    const head = chain[0]!
    const parent = nodes[head]!.parent
    const full = parent >= 0 ? [parent, ...chain] : chain
    let maxR = 0
    for (const i of full) maxR = Math.max(maxR, nodes[i]!.radius)
    if (full.length >= 2 && maxR >= minRadius) out.push(full)
  }
  return out
}

/**
 * Dead branch stubs on the bole below the crown base — the classic ladder fuel. They are
 * woody geometry only: `Stem.hasLadderFuels` describes a *path* from surface to crown, and
 * the understorey shrub/sapling foliage that spec §7.5 step 7 also counts belongs to the
 * vegetation set as its own plants, not to this tree's crown. Putting foliage here would
 * silently drag the measured crown base down to the ground and break exactly the invariant
 * this package exists to hold.
 */
export function addLadderStubs(sk: Skeleton, crown: CrownSpec, rng: Rng): void {
  const nodes = sk.nodes as SkeletonNode[]
  const chain = sk.trunkChains[0]
  if (chain === undefined || chain.length < 3) return
  const lo = 0.15 * crown.crownBaseM
  const hi = 0.95 * crown.crownBaseM
  if (hi <= lo) return

  const count = Math.max(2, Math.round((hi - lo) * 1.6))
  for (let i = 0; i < count; i++) {
    const y = lo + ((i + rng.next()) / count) * (hi - lo)
    let attach = chain[0]!
    for (const ni of chain) {
      if (nodes[ni]!.y <= y) attach = ni
      else break
    }
    const node = nodes[attach]!
    const az = rng.next() * 2 * Math.PI
    const len = rng.range(0.25, 0.7) * crown.crownRadiusM * 0.5
    const droop = rng.range(-0.55, -0.15)
    const segs = 2
    let prev = attach
    for (let s = 1; s <= segs; s++) {
      const dx = Math.cos(az)
      const dz = Math.sin(az)
      const m = Math.hypot(dx, droop, dz)
      const stepLen = len / segs
      const px = nodes[prev]!.x + (dx / m) * stepLen
      const py = Math.max(0.02, nodes[prev]!.y + (droop / m) * stepLen)
      const pz = nodes[prev]!.z + (dz / m) * stepLen
      prev = pushNode(nodes, px, py, pz, prev, dx / m, droop / m, dz / m, false, false)
      nodes[prev]!.radius = node.radius * (0.16 / s)
    }
  }
}
