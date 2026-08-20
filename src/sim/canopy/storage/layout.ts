/**
 * WP 3.1 — canopy voxel grid convention, occupancy mask, and the packed storage layout.
 *
 * ## The vertical axis is HEIGHT ABOVE GROUND, not elevation. This is forced, not chosen.
 *
 * `CANOPY_N_Z = 64` at `CANOPY_CELL_M_3D = 2` gives 128 m of vertical extent. Measured on the
 * shipping worlds (see `occupancy.ts` and the tests), a world-axis-aligned grid does not fit:
 *
 * | Biome (default params, seed 1234) | terrain span | tallest stem | world-aligned extent |
 * |---|---|---|---|
 * | western-us-conifer (relief 0.70) | 140 m | 45 m | **185 m** — overflows 128 m |
 * | western-us-conifer (relief 1.00) | 237 m | 45 m | **282 m** — overflows |
 * | mediterranean-chaparral (relief 0.65) | 109 m | 4 m | 113 m — fits, barely |
 * | grassland-savanna (relief 0.15) | 21 m | 25 m | 46 m — fits |
 *
 * So `k` indexes height above the terrain surface of the voxel's own column:
 *
 *     worldY(i, j, k) = groundM[j * N + i] + (k + 0.5) * CELL      // voxel centre
 *
 * Consequences a consumer must know:
 * - The grid is **sheared**, not curvilinear-stretched. Every voxel is still an axis-aligned
 *   2 m box in world space; only the *stack origin* moves per column. A ray marcher works in
 *   world space and converts with one `groundM` fetch per sample (`shaders/…/address.wgsl`).
 * - Column stacks of neighbouring columns overlap in world Y on a slope. That is correct —
 *   the fuel really is at those elevations — but a neighbour-of-`k` stencil is NOT a
 *   neighbour in world space on a slope. Diffusion-style solvers must offset by the ground
 *   step. `groundStepM()` gives it.
 * - 128 m AGL clears the tallest species in the table (E. regnans-class, 60 m) with 2x
 *   headroom, so nothing clips vertically. `voxeliseVegetation` reports clipped mass anyway.
 *
 * ## Storage: per-column vertical runs, not a brick pool. See §7.2's OPEN QUESTION.
 *
 * The spec proposed 8³ bricks with a 32 768-slot indirection grid and an 8192-brick pool.
 * `occupancy.ts` measures both structures on real generated worlds; the numbers are in the
 * package README section of `index.ts` and in `test/sim/canopy/storage/occupancy.test.ts`.
 * The short version: canopy sparsity is almost entirely VERTICAL. In XY the canopy covers
 * nearly every 16 m brick column of a stocked domain, so an 8³ brick pool pays for 512-voxel
 * granularity to store a band that is ~10 voxels thick, and 8192 bricks is not headroom — it
 * is an overflow for dense conifer. A per-column run stores exactly the occupied vertical
 * span, needs no free list, no eviction and no fragmentation, and is smaller.
 *
 * Layout, three arrays (structure-of-arrays as §7.2 requires, for the same 128 MiB
 * `maxStorageBufferBindingSize` reason):
 *
 *     columnHeader[j * N + i] = zStart | (zCount << 8)      // u32, one per XY column
 *     columnOffset[j * N + i] = first voxel index of the column   // u32, exclusive prefix sum
 *     voxel index of (i, j, k) = columnOffset[c] + (k - zStart[c]),  or INVALID
 *
 * `zStart`/`zCount` each fit in 8 bits because `CANOPY_N_Z = 64`; they share one u32 so the
 * hot path is two loads (header, offset) instead of three, and both headers are contiguous in
 * XY so a cone marching horizontally hits the same cache lines.
 */

import { CANOPY_CELL_M_3D, CANOPY_N_XY, CANOPY_N_Z } from '@contracts/sim'

export interface CanopyGrid {
  /** Columns per side. */
  readonly nxy: number
  /** Levels per column. */
  readonly nz: number
  /** Voxel edge, metres. Cubic. */
  readonly cellM: number
  /** Domain edge, metres. `nxy * cellM` for the shipping grid. */
  readonly domainM: number
}

export const CANOPY_GRID: CanopyGrid = {
  nxy: CANOPY_N_XY,
  nz: CANOPY_N_Z,
  cellM: CANOPY_CELL_M_3D,
  domainM: CANOPY_N_XY * CANOPY_CELL_M_3D,
}

/** Tests use a small grid; everything here is parameterised on the spec rather than global. */
export function makeGrid(nxy: number, nz: number, cellM = CANOPY_CELL_M_3D): CanopyGrid {
  if (nz > 255) throw new RangeError(`zStart/zCount are u8-packed; nz must be <= 255, got ${nz}`)
  return { nxy, nz, cellM, domainM: nxy * cellM }
}

export const columnCount = (g: CanopyGrid): number => g.nxy * g.nxy
export const denseVoxelCount = (g: CanopyGrid): number => g.nxy * g.nxy * g.nz

/** Returned by every lookup that misses. Matches the WGSL constant. */
export const INVALID_VOXEL = 0xffffffff

// ---------------------------------------------------------------------------
// Occupancy mask — the intermediate the layout and the measurement both consume
// ---------------------------------------------------------------------------

/**
 * One bit per dense voxel, `(j * nxy + i) * nz + k`. 2 MiB at the shipping grid, which is why
 * the build can afford a dense first pass and still pack exactly.
 */
export class OccupancyMask {
  readonly grid: CanopyGrid
  readonly words: Uint32Array

  constructor(grid: CanopyGrid) {
    this.grid = grid
    this.words = new Uint32Array(Math.ceil(denseVoxelCount(grid) / 32))
  }

  /** Dense linear index. Column-major in k so a column is contiguous. */
  index(i: number, j: number, k: number): number {
    return (j * this.grid.nxy + i) * this.grid.nz + k
  }

  set(i: number, j: number, k: number): void {
    const n = this.index(i, j, k)
    this.words[n >>> 5] = ((this.words[n >>> 5] as number) | (1 << (n & 31))) >>> 0
  }

  get(i: number, j: number, k: number): boolean {
    const n = this.index(i, j, k)
    return (((this.words[n >>> 5] as number) >>> (n & 31)) & 1) === 1
  }

  count(): number {
    let total = 0
    for (let w = 0; w < this.words.length; w++) {
      let v = this.words[w] as number
      // Hamming weight, SWAR.
      v = v - ((v >>> 1) & 0x55555555)
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
      total += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
    }
    return total
  }
}

// ---------------------------------------------------------------------------
// Packed column-run layout
// ---------------------------------------------------------------------------

/** Bit positions inside `columnHeader`. Mirrored in WGSL by `shaders.ts`. */
export const ZSTART_SHIFT = 0
export const ZCOUNT_SHIFT = 8
export const Z_MASK = 0xff

export const packHeader = (zStart: number, zCount: number): number =>
  ((zStart & Z_MASK) | ((zCount & Z_MASK) << ZCOUNT_SHIFT)) >>> 0

export interface CanopyLayout {
  readonly grid: CanopyGrid
  /** `packHeader(zStart, zCount)` per column. `zCount === 0` means an empty column. */
  readonly columnHeader: Uint32Array
  /** First packed voxel index of the column. Undefined (0) where `zCount === 0`. */
  readonly columnOffset: Uint32Array
  /** Sum of `zCount`. The number of voxel slots actually allocated. */
  readonly voxelCount: number
  /** Columns with `zCount > 0`. */
  readonly occupiedColumns: number
  /**
   * Voxels inside an allocated run that hold no foliage. The run is the min→max span of the
   * column, so a crown with a hole in it pays for the hole. This is the layout's only waste
   * and the measurement reports it.
   */
  readonly interiorGapVoxels: number
  /** Spare slots appended past `voxelCount` for the grow path. See `store.ts`. */
  readonly spareVoxels: number
}

/**
 * Build the packed layout from an occupancy mask.
 *
 * `growthHeadroomFraction` appends spare slots so a run can be extended in place without
 * re-packing the whole domain (see `store.ts` — the grow path). Default 0 because the build
 * pass covers the whole domain and vegetation does not appear at runtime; pass a fraction
 * only if a caller adds fuel later.
 */
export function buildLayout(mask: OccupancyMask, growthHeadroomFraction = 0): CanopyLayout {
  const g = mask.grid
  const nCols = columnCount(g)
  const header = new Uint32Array(nCols)
  const offset = new Uint32Array(nCols)

  let cursor = 0
  let occupied = 0
  let gaps = 0
  for (let c = 0; c < nCols; c++) {
    const base = c * g.nz
    let lo = -1
    let hi = -1
    let filled = 0
    for (let k = 0; k < g.nz; k++) {
      const n = base + k
      if ((((mask.words[n >>> 5] as number) >>> (n & 31)) & 1) === 1) {
        if (lo < 0) lo = k
        hi = k
        filled++
      }
    }
    if (lo < 0) continue
    const count = hi - lo + 1
    header[c] = packHeader(lo, count)
    offset[c] = cursor
    cursor += count
    occupied++
    gaps += count - filled
  }

  const spare = Math.round(cursor * growthHeadroomFraction)
  return {
    grid: g,
    columnHeader: header,
    columnOffset: offset,
    voxelCount: cursor,
    occupiedColumns: occupied,
    interiorGapVoxels: gaps,
    spareVoxels: spare,
  }
}

/** Packed voxel index, or `INVALID_VOXEL`. The CPU twin of the WGSL `canopy_lookup`. */
export function lookup(layout: CanopyLayout, i: number, j: number, k: number): number {
  const g = layout.grid
  if (i < 0 || j < 0 || k < 0 || i >= g.nxy || j >= g.nxy || k >= g.nz) return INVALID_VOXEL
  const c = j * g.nxy + i
  const h = layout.columnHeader[c] as number
  const zStart = h & Z_MASK
  const zCount = (h >>> ZCOUNT_SHIFT) & Z_MASK
  const d = k - zStart
  if (d < 0 || d >= zCount) return INVALID_VOXEL
  return (layout.columnOffset[c] as number) + d
}

// ---------------------------------------------------------------------------
// Byte accounting
// ---------------------------------------------------------------------------

/**
 * Per-voxel bytes, by pool, exactly as §7.2's table specifies. Three bindings, because
 * `maxStorageBufferBindingSize` defaults to 128 MiB and each pool must stay under it on its
 * own for the no-raised-limit fallback path to work.
 *
 * Pool A packs its nine f16/u16/u8 fields into four u32 words, so it is `u32`-addressed and
 * needs no `shader-f16` feature (§7.2: `unpack2x16float`). B is two u32 words, C is one f32.
 */
export const POOL_A_BYTES = 16
export const POOL_B_BYTES = 8
export const POOL_C_BYTES = 4
export const VOXEL_BYTES = POOL_A_BYTES + POOL_B_BYTES + POOL_C_BYTES

/** Per-column index bytes: one header u32 + one offset u32. */
export const COLUMN_BYTES = 8
/** Ground elevation per column, f32 — the shear the addressing needs. */
export const GROUND_BYTES = 4

export interface CanopyFootprint {
  readonly voxelSlots: number
  readonly poolABytes: number
  readonly poolBBytes: number
  readonly poolCBytes: number
  readonly indexBytes: number
  readonly totalBytes: number
  /** 2^20 bytes. */
  readonly totalMiB: number
  /** 10^6 bytes. Quoted alongside because §7.2's own budget line never said which it meant. */
  readonly totalMB: number
  /** True if any single pool would exceed the default 128 MiB binding limit. */
  readonly exceedsDefaultBindingLimit: boolean
}

export const DEFAULT_MAX_STORAGE_BINDING = 128 * 1024 * 1024

export function footprint(layout: CanopyLayout): CanopyFootprint {
  const slots = layout.voxelCount + layout.spareVoxels
  const a = slots * POOL_A_BYTES
  const b = slots * POOL_B_BYTES
  const c = slots * POOL_C_BYTES
  const index = columnCount(layout.grid) * (COLUMN_BYTES + GROUND_BYTES)
  const total = a + b + c + index
  return {
    voxelSlots: slots,
    poolABytes: a,
    poolBBytes: b,
    poolCBytes: c,
    indexBytes: index,
    totalBytes: total,
    totalMiB: total / (1024 * 1024),
    totalMB: total / 1e6,
    exceedsDefaultBindingLimit: Math.max(a, b, c) > DEFAULT_MAX_STORAGE_BINDING,
  }
}
