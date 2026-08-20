/**
 * Spatial indices for stems.
 *
 * Two structures, because placement and query want opposite things:
 *
 *  - {@link PointGrid} is *mutable* and is used during dart-throwing, where points arrive one
 *    at a time and each new candidate must be tested against its neighbours. It stores a
 *    per-point exclusion radius, because the Poisson-disc radius here varies with the local
 *    stem density — a dense valley stand and a sparse ridge stand must not share one spacing.
 *
 *  - {@link StemGrid} is *immutable* and is built once, after placement, in a single counting
 *    pass. It backs `IVegetationSet.stemsInAabb` (renderer culling now, canopy voxelisation at
 *    M3) and the neighbour queries that derive competition and ladder fuels.
 *
 * A uniform grid rather than a tree: the domain is a fixed 1 km square with a roughly uniform
 * point density, which is precisely the case a uniform grid handles best and a hierarchy
 * handles worst. Build is O(n) with two passes and no allocation per cell.
 */

import type { Stem } from '@contracts/world'
import type { Metres } from '@contracts/units'

const i32 = (a: Int32Array, i: number): number => a[i] as number

// ---------------------------------------------------------------------------
// Mutable point grid for placement
// ---------------------------------------------------------------------------

/**
 * Insert-and-query grid over points with per-point exclusion radii.
 *
 * Cell size is the *maximum* exclusion radius in play, which is what makes a 3×3 neighbourhood
 * scan sufficient: any stored point within `maxRadius` of a query is necessarily in one of the
 * nine cells around it.
 */
export class PointGrid {
  private readonly cols: number
  private readonly cellSize: number
  private readonly buckets: number[][]
  private readonly xs: number[] = []
  private readonly zs: number[] = []
  private readonly radii: number[] = []

  constructor(sizeM: number, maxRadius: number) {
    this.cellSize = Math.max(0.5, maxRadius)
    this.cols = Math.max(1, Math.ceil(sizeM / this.cellSize))
    this.buckets = Array.from({ length: this.cols * this.cols }, () => [] as number[])
  }

  get count(): number {
    return this.xs.length
  }

  private cellOf(x: number, z: number): number {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)))
    const j = Math.min(this.cols - 1, Math.max(0, Math.floor(z / this.cellSize)))
    return j * this.cols + i
  }

  /**
   * True if any stored point lies closer than the larger of the two exclusion radii.
   *
   * Symmetric (`max` of the pair) rather than candidate-only, so a sparse-stand candidate
   * cannot be dropped right up against a dense-stand neighbour that would itself have
   * rejected it. Asymmetric variable-radius Poisson disc produces visible one-sided clumping
   * along density gradients; this does not.
   */
  conflicts(x: number, z: number, radius: number): boolean {
    const ci = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)))
    const cj = Math.min(this.cols - 1, Math.max(0, Math.floor(z / this.cellSize)))
    for (let dj = -1; dj <= 1; dj++) {
      const j = cj + dj
      if (j < 0 || j >= this.cols) continue
      for (let di = -1; di <= 1; di++) {
        const i = ci + di
        if (i < 0 || i >= this.cols) continue
        const bucket = this.buckets[j * this.cols + i]
        if (bucket === undefined) continue
        for (const p of bucket) {
          const dx = (this.xs[p] as number) - x
          const dz = (this.zs[p] as number) - z
          const r = Math.max(radius, this.radii[p] as number)
          if (dx * dx + dz * dz < r * r) return true
        }
      }
    }
    return false
  }

  insert(x: number, z: number, radius: number): void {
    const id = this.xs.length
    this.xs.push(x)
    this.zs.push(z)
    this.radii.push(radius)
    const bucket = this.buckets[this.cellOf(x, z)]
    if (bucket !== undefined) bucket.push(id)
  }
}

// ---------------------------------------------------------------------------
// Immutable CSR grid over placed stems
// ---------------------------------------------------------------------------

export class StemGrid {
  readonly cols: number
  readonly cellSizeM: number
  private readonly stems: readonly Stem[]
  /** CSR row offsets, length cols² + 1. */
  private readonly starts: Int32Array
  /** Stem indices, grouped by cell. */
  private readonly items: Int32Array

  constructor(stems: readonly Stem[], sizeM: number, cellSizeM: number) {
    this.stems = stems
    this.cellSizeM = Math.max(1, cellSizeM)
    this.cols = Math.max(1, Math.ceil(sizeM / this.cellSizeM))
    const cells = this.cols * this.cols

    const counts = new Int32Array(cells + 1)
    const cellOf = new Int32Array(stems.length)
    for (let s = 0; s < stems.length; s++) {
      const st = stems[s] as Stem
      const c = this.cellIndex(st.x, st.z)
      cellOf[s] = c
      counts[c + 1] = i32(counts, c + 1) + 1
    }
    for (let c = 0; c < cells; c++) counts[c + 1] = i32(counts, c + 1) + i32(counts, c)
    this.starts = counts

    const cursor = new Int32Array(cells)
    this.items = new Int32Array(stems.length)
    for (let s = 0; s < stems.length; s++) {
      const c = i32(cellOf, s)
      const at = i32(this.starts, c) + i32(cursor, c)
      this.items[at] = s
      cursor[c] = i32(cursor, c) + 1
    }
  }

  private cellIndex(x: number, z: number): number {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSizeM)))
    const j = Math.min(this.cols - 1, Math.max(0, Math.floor(z / this.cellSizeM)))
    return j * this.cols + i
  }

  /**
   * Exact AABB query. The grid narrows the candidate set; every returned stem is then tested
   * against the real box, so the result contains no false positives — a caller doing GPU
   * instance culling gets a usable list, not a conservative one it has to re-filter.
   *
   * The box is treated as inclusive on both bounds, and is clamped to the grid, so a query
   * covering the whole domain returns every stem exactly once.
   */
  queryAabb(minX: number, minZ: number, maxX: number, maxZ: number): Stem[] {
    const out: Stem[] = []
    if (maxX < minX || maxZ < minZ) return out
    const i0 = Math.min(this.cols - 1, Math.max(0, Math.floor(minX / this.cellSizeM)))
    const i1 = Math.min(this.cols - 1, Math.max(0, Math.floor(maxX / this.cellSizeM)))
    const j0 = Math.min(this.cols - 1, Math.max(0, Math.floor(minZ / this.cellSizeM)))
    const j1 = Math.min(this.cols - 1, Math.max(0, Math.floor(maxZ / this.cellSizeM)))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * this.cols + i
        const end = i32(this.starts, c + 1)
        for (let k = i32(this.starts, c); k < end; k++) {
          const st = this.stems[i32(this.items, k)]
          if (st === undefined) continue
          if (st.x >= minX && st.x <= maxX && st.z >= minZ && st.z <= maxZ) out.push(st)
        }
      }
    }
    return out
  }

  /** Indices of stems within `radius` of (x, z), including any stem exactly at that point. */
  queryRadiusIndices(x: number, z: number, radius: number): number[] {
    const out: number[] = []
    const r2 = radius * radius
    const i0 = Math.min(this.cols - 1, Math.max(0, Math.floor((x - radius) / this.cellSizeM)))
    const i1 = Math.min(this.cols - 1, Math.max(0, Math.floor((x + radius) / this.cellSizeM)))
    const j0 = Math.min(this.cols - 1, Math.max(0, Math.floor((z - radius) / this.cellSizeM)))
    const j1 = Math.min(this.cols - 1, Math.max(0, Math.floor((z + radius) / this.cellSizeM)))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * this.cols + i
        const end = i32(this.starts, c + 1)
        for (let k = i32(this.starts, c); k < end; k++) {
          const s = i32(this.items, k)
          const st = this.stems[s]
          if (st === undefined) continue
          const dx = st.x - x
          const dz = st.z - z
          if (dx * dx + dz * dz <= r2) out.push(s)
        }
      }
    }
    return out
  }

  countInRadius(x: Metres, z: Metres, radius: number): number {
    return this.queryRadiusIndices(x, z, radius).length
  }
}
