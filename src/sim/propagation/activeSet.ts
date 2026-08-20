/**
 * Two-level active set and indirect dispatch — work package 2.3, spec §6.4 and §4.8.
 *
 * Cost must scale with burning area, not domain area. A single fire's narrow band is
 * typically 1–5 % of the 2048² grid, so dispatching the whole domain wastes ~30× the work.
 *
 * **Compaction is at tile granularity, not cell granularity, and that is a deliberate
 * choice.** Spec §6.4 does the arithmetic: a 4.19 M-element exclusive prefix sum costs
 * ~33.5 MB of traffic ≈ 180 µs to save perhaps 40 µs of wasted work inside half-full tiles.
 * 16×16-cell tiles give 128×128 = 16,384 elements ≈ 3 µs and capture ~95 % of the benefit.
 *
 * The classification input is a per-tile `min |φ|` summary written by the advance pass
 * itself, which already has φ in registers — so classification never re-reads the 4.19 M
 * cell field. A tile whose summary says the front is far away is dropped; the dispatch set
 * is then the **dilation of the surviving tiles by one tile**, which is what lets the front
 * expand into ground that was inactive last step: halo cells are advanced too, so they
 * write a summary of their own and become active in their own right next step.
 *
 * Because the dilation buys 16 cells of margin and one step moves the front at most
 * `CFL · Δx` = 0.2 cells, the set is rebuilt **every step** rather than every 16. That
 * costs ~3 µs against the advance pass's ~660 µs — 0.5 % — and it deletes the entire class
 * of staleness bug that a periodic rebuild with a 4-cell margin invites.
 *
 * Everything here is pure and integer, so it is the oracle for `shaders/sim/propagation`.
 */

/** Cells per tile edge. 16 × 0.5 m = 8 m tiles; 2048² grid ⇒ 128² = 16,384 tiles. */
export const TILE_CELLS = 16

/**
 * How close the front must come, in metres, for a tile to count as active on its own.
 * The dilation supplies the real margin; this only has to be wide enough that the level
 * set's own numerical band (2–3 cells of smearing) is inside it.
 */
export const BAND_M = 4 * 0.5

/** `float` bit pattern, which orders identically to the value for non-negative floats. */
const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** Encode a non-negative float so `atomicMin` on u32 is `min` on the float. */
export function sortableBits(v: number): number {
  F32[0] = v
  return U32[0] as number
}

export function fromSortableBits(bits: number): number {
  U32[0] = bits
  return F32[0] as number
}

export interface TileGrid {
  readonly tilesX: number
  readonly tilesY: number
  readonly count: number
}

export function tileGrid(cellsX: number, cellsY: number): TileGrid {
  const tilesX = Math.ceil(cellsX / TILE_CELLS)
  const tilesY = Math.ceil(cellsY / TILE_CELLS)
  return { tilesX, tilesY, count: tilesX * tilesY }
}

/**
 * Compact the active tiles into `out`, dilated by one tile in each direction.
 *
 * @param minAbsPhi per-tile `min |φ|` in metres. `+Infinity` (or any large value) marks a
 *   tile the advance pass has never touched.
 * @returns number of tile ids written to `out`.
 */
export function classifyTiles(
  minAbsPhi: Float32Array,
  grid: TileGrid,
  band: number,
  out: Uint32Array,
): number {
  const { tilesX, tilesY } = grid
  let n = 0
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      if (!tileOrNeighbourActive(minAbsPhi, tilesX, tilesY, tx, ty, band)) continue
      if (n < out.length) out[n] = ty * tilesX + tx
      n++
    }
  }
  return Math.min(n, out.length)
}

function tileOrNeighbourActive(
  minAbsPhi: Float32Array,
  tilesX: number,
  tilesY: number,
  tx: number,
  ty: number,
  band: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const y = ty + dy
    if (y < 0 || y >= tilesY) continue
    for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx
      if (x < 0 || x >= tilesX) continue
      if ((minAbsPhi[y * tilesX + x] as number) <= band) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Indirect dispatch args
// ---------------------------------------------------------------------------

export interface DispatchArgs {
  readonly x: number
  readonly y: number
  readonly z: number
  /** True when work had to be **dropped** because it did not fit even after folding. */
  readonly overflowed: boolean
}

/**
 * Convert a workgroup count into `GPUDispatchIndirect` args.
 *
 * **This clamping is not optional and not defensive programming.** Per WebGPU §16.1.2, if
 * any of `workgroupCountX/Y/Z` read from an indirect buffer exceeds
 * `maxComputeWorkgroupsPerDimension`, the dispatch is *silently skipped in its entirety* on
 * the queue timeline — not clamped, not an error, no validation at encode time. A whole
 * substep of work vanishes and the only symptom is a fire that stops moving.
 *
 * So excess is folded into Y (the kernel reconstructs `wg = x + y·gridX`) and, if it still
 * does not fit, clamped with `overflowed` set so the HUD can say so out loud.
 */
export function dispatchArgs(workgroups: number, maxPerDim: number): DispatchArgs {
  const n = Math.max(0, Math.min(workgroups, 0xffff_ffff))
  const limit = Math.max(1, maxPerDim)
  if (n <= limit) return { x: n, y: n === 0 ? 0 : 1, z: 1, overflowed: false }
  const y = Math.ceil(n / limit)
  if (y <= limit) return { x: limit, y, z: 1, overflowed: false }
  return { x: limit, y: limit, z: 1, overflowed: true }
}

/** Workgroups needed to cover `items` at `perGroup` items each. */
export function workgroupsFor(items: number, perGroup: number): number {
  return Math.ceil(items / Math.max(1, perGroup))
}
