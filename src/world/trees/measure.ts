/**
 * Measurement of generated tree geometry (WP 1.4 acceptance mechanism).
 *
 * Nothing here reads the Stem. Everything here reads triangles: vertex positions and
 * triangle areas out of the finished `TreeLod`. That is the point. `TreeMesh.derived` is
 * filled from this module, and the acceptance test asserts it agrees with the Stem's
 * *physical* parameters within 10%. If a change to the skeleton, the placement rules or the
 * LOD chain ever pulls the geometry away from the fuel state, this is what notices — not a
 * screenshot.
 *
 * What each figure actually measures:
 *
 * - `heightM`      — the maximum y of any vertex in the mesh. Not a parameter, a bound.
 * - `crownBaseM`   — the minimum y of any vertex on the **foliage** submesh. This is the
 *                    contract's definition ("the lowest live crown foliage") and the
 *                    quantity Van Wagner's crown-initiation criterion is dominated by. Bark
 *                    and ribbon vertices are deliberately excluded: a dead branch stub or a
 *                    hanging strip of bark below the live crown is ladder fuel, not crown.
 * - `foliarBiomassKg` — summed geometric area of the foliage triangles, times the species'
 *                    card coverage to get one-sided leaf area, divided by specific leaf
 *                    area. SLA and coverage are engineering estimates (§0.7.3 `estimated`)
 *                    and they also set the card size, so they cancel out of the
 *                    derived-vs-declared comparison. What does *not* cancel — and what this
 *                    therefore genuinely tests — is whether the triangles that got emitted
 *                    are the triangles that were meant to be emitted: dropped cards, doubled
 *                    quads, collapsed or mis-wound geometry all move this number.
 * - `crownVolumeM3` — slab integration of the actual foliage point cloud: the crown is cut
 *                    into horizontal slabs and each slab contributes pi * r_max^2 * dz,
 *                    where r_max is the largest horizontal distance from the stem axis of
 *                    any foliage vertex in that slab. Independent of the analytic envelope
 *                    integral the mass was derived over, which is what makes the bulk
 *                    density check non-circular.
 * - `crownBulkDensity` — biomass over that measured volume.
 */

import type { TreeLod } from '@contracts/world.ts'
import type { FormParams } from './speciesForm.ts'

export interface TreeMetrics {
  /** Max y over every vertex, m. */
  readonly heightM: number
  /** Min y over foliage vertices, m. */
  readonly crownBaseM: number
  /** Max y over foliage vertices, m. */
  readonly crownTopM: number
  /** Max horizontal distance from the stem axis over foliage vertices, m. */
  readonly crownRadiusM: number
  /** Slab-integrated crown volume from the foliage point cloud, m3. */
  readonly crownVolumeM3: number
  /** One-sided leaf area, m2. */
  readonly leafAreaM2: number
  readonly foliarBiomassKg: number
  readonly crownBulkDensityKgM3: number
  /** Slab centre heights above ground, m. */
  readonly profileHeightM: Float64Array
  /** Bulk density in each slab, kg/m3 — the vertical profile the crown model reads. */
  readonly profileBulkDensity: Float64Array
  /** Foliar mass in each slab, kg. Sums to `foliarBiomassKg`. */
  readonly profileMassKg: Float64Array
  readonly foliageTriangles: number
  readonly barkTriangles: number
  readonly ribbonTriangles: number
  /** One-sided geometric area of the ribbon submesh, m2. */
  readonly ribbonAreaM2: number
}

function triangleArea(
  p: Float32Array,
  ia: number,
  ib: number,
  ic: number,
): number {
  const ax = p[ia * 3]!, ay = p[ia * 3 + 1]!, az = p[ia * 3 + 2]!
  const bx = p[ib * 3]!, by = p[ib * 3 + 1]!, bz = p[ib * 3 + 2]!
  const cx = p[ic * 3]!, cy = p[ic * 3 + 1]!, cz = p[ic * 3 + 2]!
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = cx - ax, vy = cy - ay, vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  return 0.5 * Math.hypot(nx, ny, nz)
}

/**
 * `slabs` trades two opposing biases against each other and 128 is where they roughly
 * cancel. A coarse slab takes its radius from the widest point inside it, which inflates the
 * volume of a tapering crown by about 1.5/n; a fine slab holds too few vertices for the
 * maximum to reach the true envelope, which deflates it. Both are around 1% at 128 for a
 * LOD-0 crown, and they have opposite signs.
 */
export function measureTree(lod: TreeLod, f: FormParams, slabs = 128): TreeMetrics {
  const pos = lod.positions
  const idx = lod.indices
  const vertexCount = pos.length / 3

  let maxY = -Infinity
  for (let v = 0; v < vertexCount; v++) {
    const y = pos[v * 3 + 1]!
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(maxY)) maxY = 0

  let foliageTriangles = 0
  let barkTriangles = 0
  let ribbonTriangles = 0
  let ribbonAreaM2 = 0
  let foliageAreaM2 = 0
  let crownBaseM = Infinity
  let crownTopM = -Infinity
  let crownRadiusM = 0

  // First pass: extents and areas.
  for (const sm of lod.submeshes) {
    const tris = sm.count / 3
    if (sm.material === 'bark') {
      barkTriangles += tris
      continue
    }
    for (let i = sm.start; i < sm.start + sm.count; i += 3) {
      const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!
      const area = triangleArea(pos, a, b, c)
      if (sm.material === 'ribbon') {
        ribbonTriangles++
        ribbonAreaM2 += area
        continue
      }
      foliageTriangles++
      foliageAreaM2 += area
      for (let k = 0; k < 3; k++) {
        const v = idx[i + k]!
        const y = pos[v * 3 + 1]!
        const r = Math.hypot(pos[v * 3]!, pos[v * 3 + 2]!)
        if (y < crownBaseM) crownBaseM = y
        if (y > crownTopM) crownTopM = y
        if (r > crownRadiusM) crownRadiusM = r
      }
    }
  }

  if (!Number.isFinite(crownBaseM)) {
    // No foliage at all — a bare stem. Report honestly rather than inventing a crown.
    return {
      heightM: maxY,
      crownBaseM: maxY,
      crownTopM: maxY,
      crownRadiusM: 0,
      crownVolumeM3: 0,
      leafAreaM2: 0,
      foliarBiomassKg: 0,
      crownBulkDensityKgM3: 0,
      profileHeightM: new Float64Array(0),
      profileBulkDensity: new Float64Array(0),
      profileMassKg: new Float64Array(0),
      foliageTriangles,
      barkTriangles,
      ribbonTriangles,
      ribbonAreaM2,
    }
  }

  const depth = Math.max(1e-6, crownTopM - crownBaseM)
  const n = Math.max(4, slabs)
  const dz = depth / n
  const slabRadius = new Float64Array(n)
  const slabMass = new Float64Array(n)
  const slabHeight = new Float64Array(n)
  for (let i = 0; i < n; i++) slabHeight[i] = crownBaseM + (i + 0.5) * dz

  const leafPerArea = f.cardCoverage / Math.max(1e-9, f.specificLeafAreaM2PerKg)

  // Second pass: per-slab max radius (from vertices) and mass (from triangle centroids).
  for (const sm of lod.submeshes) {
    if (sm.material !== 'foliage') continue
    for (let i = sm.start; i < sm.start + sm.count; i += 3) {
      const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!
      for (let k = 0; k < 3; k++) {
        const v = idx[i + k]!
        const y = pos[v * 3 + 1]!
        const r = Math.hypot(pos[v * 3]!, pos[v * 3 + 2]!)
        let s = Math.floor((y - crownBaseM) / dz)
        if (s < 0) s = 0
        if (s >= n) s = n - 1
        if (r > slabRadius[s]!) slabRadius[s] = r
      }
      const cy = (pos[a * 3 + 1]! + pos[b * 3 + 1]! + pos[c * 3 + 1]!) / 3
      let s = Math.floor((cy - crownBaseM) / dz)
      if (s < 0) s = 0
      if (s >= n) s = n - 1
      slabMass[s]! += triangleArea(pos, a, b, c) * leafPerArea
    }
  }

  // Empty slabs are rare — the attractor field pins a sample at both ends of the crown — but
  // where one occurs, carry the last non-empty radius rather than punching a zero-volume
  // hole through the middle of the integral and reporting a spuriously high bulk density.
  let lastR = 0
  for (let i = 0; i < n; i++) {
    if (slabRadius[i]! > 0) lastR = slabRadius[i]!
    else slabRadius[i] = lastR
  }

  let volume = 0
  const profileBulkDensity = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const r = slabRadius[i]!
    const slabVol = Math.PI * r * r * dz
    volume += slabVol
    profileBulkDensity[i] = slabVol > 1e-12 ? slabMass[i]! / slabVol : 0
  }

  const leafAreaM2 = foliageAreaM2 * f.cardCoverage
  const foliarBiomassKg = leafAreaM2 / Math.max(1e-9, f.specificLeafAreaM2PerKg)

  return {
    heightM: maxY,
    crownBaseM,
    crownTopM,
    crownRadiusM,
    crownVolumeM3: volume,
    leafAreaM2,
    foliarBiomassKg,
    crownBulkDensityKgM3: volume > 1e-9 ? foliarBiomassKg / volume : 0,
    profileHeightM: slabHeight,
    profileBulkDensity,
    profileMassKg: slabMass,
    foliageTriangles,
    barkTriangles,
    ribbonTriangles,
    ribbonAreaM2,
  }
}

// ---------------------------------------------------------------------------
// Geometry sanity — cheap invariants that catch the failure modes a visual check misses
// ---------------------------------------------------------------------------

export interface GeometryReport {
  readonly vertexCount: number
  readonly triangleCount: number
  readonly degenerateTriangles: number
  readonly nonFiniteVertices: number
  readonly indicesOutOfRange: number
  /** Undirected edges shared by more than two triangles — a fold in the surface. */
  readonly overSharedEdges: number
  /** Directed edges that appear twice — two triangles wound the same way across one edge. */
  readonly inconsistentWinding: number
  /** Index ranges that do not tile the index buffer exactly once. */
  readonly submeshCoverageOk: boolean
}

/**
 * `minArea` defaults to 1e-10 m2 — a 10 micrometre triangle. Anything smaller is a
 * rasteriser no-op that still costs a vertex fetch, and is usually a symptom of a collapsed
 * tube ring or a zero-mass foliage card rather than of deliberate detail.
 */
export function checkGeometry(lod: TreeLod, minArea = 1e-10): GeometryReport {
  const pos = lod.positions
  const idx = lod.indices
  const vertexCount = pos.length / 3

  let nonFinite = 0
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i]!)) nonFinite++

  let outOfRange = 0
  let degenerate = 0
  const directed = new Set<string>()
  const undirected = new Map<string, number>()
  let overShared = 0
  let badWinding = 0

  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      outOfRange++
      continue
    }
    if (a === b || b === c || a === c) {
      degenerate++
      continue
    }
    if (triangleArea(pos, a, b, c) < minArea) degenerate++

    const eu = [a, b, c]
    const ev = [b, c, a]
    for (let e = 0; e < 3; e++) {
      const u = eu[e]!
      const v = ev[e]!
      const dk = `${u}_${v}`
      if (directed.has(dk)) badWinding++
      else directed.add(dk)
      const uk = u < v ? `${u}_${v}` : `${v}_${u}`
      const n = (undirected.get(uk) ?? 0) + 1
      undirected.set(uk, n)
      if (n === 3) overShared++
    }
  }

  // Submesh ranges must tile [0, indices.length) exactly once, in order — the renderer
  // draws them as independent index ranges and a gap silently drops geometry.
  let cursor = 0
  let coverageOk = true
  for (const sm of lod.submeshes) {
    if (sm.start !== cursor) coverageOk = false
    cursor += sm.count
  }
  if (cursor !== idx.length) coverageOk = false

  return {
    vertexCount,
    triangleCount: idx.length / 3,
    degenerateTriangles: degenerate,
    nonFiniteVertices: nonFinite,
    indicesOutOfRange: outOfRange,
    overSharedEdges: overShared,
    inconsistentWinding: badWinding,
    submeshCoverageOk: coverageOk,
  }
}
