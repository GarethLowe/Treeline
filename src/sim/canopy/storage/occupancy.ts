/**
 * WP 3.1 — the instrumentation that closes spec §30 §7.2's OPEN QUESTION.
 *
 * The question, restated: the 8192-brick pool was sized from *voxel* occupancy (10–18 %) but
 * allocation happens at whole-8³-brick granularity, so a thin terrain-following canopy band
 * may clip far more bricks than its voxel fraction implies, and 8192 of 32 768 slots could be
 * an overflow rather than headroom. It also asked whether "25 % of the dense grid allocated"
 * and "25 % headroom" had been conflated (they had).
 *
 * This module measures it. `measureOccupancy` takes the same `OccupancyMask` the shipped
 * layout is built from and reports, for any brick shape and for the column-run layout:
 *
 * - fraction of indirection slots touched,
 * - mean voxel fill per touched brick,
 * - allocated voxel slots and the bytes they cost,
 * - the amplification factor — allocated slots ÷ occupied voxels — which is the single number
 *   the open question is really about.
 *
 * Nothing here runs at frame time. It is a build-pass diagnostic and a test oracle.
 */

import type { OccupancyMask } from './layout.ts'
import type { CanopyLayout } from './layout.ts'
import { VOXEL_BYTES, columnCount, denseVoxelCount } from './layout.ts'

export interface BrickShape {
  readonly bx: number
  readonly by: number
  readonly bz: number
}

/** The spec's proposal: 8³ voxels = a 16 m cube. */
export const BRICK_8_CUBED: BrickShape = { bx: 8, by: 8, bz: 8 }

export interface BrickStats {
  readonly shape: BrickShape
  /** Indirection slots in the dense grid. */
  readonly slotsTotal: number
  /** Slots that contain at least one occupied voxel — the bricks that must be allocated. */
  readonly slotsTouched: number
  readonly slotsTouchedFraction: number
  /** Occupied voxels ÷ (touched bricks × voxels per brick). */
  readonly meanFillPerTouchedBrick: number
  /** Voxel slots the pool must provide. */
  readonly allocatedVoxels: number
  /** Allocated ÷ occupied. 1.0 is perfect; the spec's implicit assumption was near 1. */
  readonly amplification: number
  readonly poolBytes: number
  readonly indirectionBytes: number
}

export interface ColumnRunStats {
  readonly occupiedColumns: number
  readonly occupiedColumnFraction: number
  readonly allocatedVoxels: number
  readonly amplification: number
  readonly meanRunLength: number
  readonly maxRunLength: number
  readonly poolBytes: number
  readonly indexBytes: number
}

export interface OccupancyReport {
  readonly label: string
  readonly denseVoxels: number
  readonly occupiedVoxels: number
  /** The 10–18 % figure §7.2 quotes. */
  readonly voxelOccupancy: number
  /** Highest occupied level, i.e. the canopy band's AGL thickness in voxels. */
  readonly maxOccupiedLevel: number
  readonly bricks: readonly BrickStats[]
  readonly columnRun: ColumnRunStats
}

/** Bricks along each axis, rounded up — a partial brick at the far edge still needs a slot. */
const brickCounts = (mask: OccupancyMask, s: BrickShape): [number, number, number] => [
  Math.ceil(mask.grid.nxy / s.bx),
  Math.ceil(mask.grid.nxy / s.by),
  Math.ceil(mask.grid.nz / s.bz),
]

export function measureBricks(mask: OccupancyMask, shape: BrickShape): BrickStats {
  const g = mask.grid
  const [nbx, nby, nbz] = brickCounts(mask, shape)
  const slotsTotal = nbx * nby * nbz
  const touched = new Uint8Array(slotsTotal)

  let occupied = 0
  for (let j = 0; j < g.nxy; j++) {
    const bj = ((j / shape.by) | 0) * nbx
    for (let i = 0; i < g.nxy; i++) {
      const bi = (i / shape.bx) | 0
      const base = (j * g.nxy + i) * g.nz
      for (let k = 0; k < g.nz; k++) {
        const n = base + k
        if ((((mask.words[n >>> 5] as number) >>> (n & 31)) & 1) === 0) continue
        occupied++
        touched[((k / shape.bz) | 0) * nbx * nby + bj + bi] = 1
      }
    }
  }

  let slotsTouched = 0
  for (let b = 0; b < slotsTotal; b++) slotsTouched += touched[b] as number

  const voxelsPerBrick = shape.bx * shape.by * shape.bz
  const allocated = slotsTouched * voxelsPerBrick
  return {
    shape,
    slotsTotal,
    slotsTouched,
    slotsTouchedFraction: slotsTouched / slotsTotal,
    meanFillPerTouchedBrick: allocated > 0 ? occupied / allocated : 0,
    allocatedVoxels: allocated,
    amplification: occupied > 0 ? allocated / occupied : 0,
    poolBytes: allocated * VOXEL_BYTES,
    indirectionBytes: slotsTotal * 4,
  }
}

export function measureColumnRun(mask: OccupancyMask, layout: CanopyLayout): ColumnRunStats {
  const occupied = mask.count()
  const nCols = columnCount(mask.grid)
  let maxRun = 0
  for (let c = 0; c < nCols; c++) {
    const run = ((layout.columnHeader[c] as number) >>> 8) & 0xff
    if (run > maxRun) maxRun = run
  }
  const allocated = layout.voxelCount
  return {
    occupiedColumns: layout.occupiedColumns,
    occupiedColumnFraction: layout.occupiedColumns / nCols,
    allocatedVoxels: allocated,
    amplification: occupied > 0 ? allocated / occupied : 0,
    meanRunLength: layout.occupiedColumns > 0 ? allocated / layout.occupiedColumns : 0,
    maxRunLength: maxRun,
    poolBytes: allocated * VOXEL_BYTES,
    indexBytes: nCols * 12, // header u32 + offset u32 + ground f32
  }
}

export function measureOccupancy(
  label: string,
  mask: OccupancyMask,
  layout: CanopyLayout,
  shapes: readonly BrickShape[] = [BRICK_8_CUBED, { bx: 8, by: 8, bz: 2 }, { bx: 4, by: 4, bz: 4 }],
): OccupancyReport {
  const g = mask.grid
  let maxLevel = -1
  for (let c = 0; c < columnCount(g); c++) {
    const h = layout.columnHeader[c] as number
    const run = (h >>> 8) & 0xff
    if (run === 0) continue
    const top = (h & 0xff) + run - 1
    if (top > maxLevel) maxLevel = top
  }

  const occupied = mask.count()
  return {
    label,
    denseVoxels: denseVoxelCount(g),
    occupiedVoxels: occupied,
    voxelOccupancy: occupied / denseVoxelCount(g),
    maxOccupiedLevel: maxLevel,
    bricks: shapes.map((s) => measureBricks(mask, s)),
    columnRun: measureColumnRun(mask, layout),
  }
}

const mib = (b: number): string => (b / (1024 * 1024)).toFixed(1)

/** Human-readable table. Printed by the measurement test so the numbers live in CI output. */
export function formatReport(r: OccupancyReport): string {
  const lines: string[] = []
  lines.push(`--- ${r.label}`)
  lines.push(
    `dense ${r.denseVoxels.toLocaleString()} voxels; occupied ${r.occupiedVoxels.toLocaleString()}` +
      ` (${(r.voxelOccupancy * 100).toFixed(1)}%); band top level ${r.maxOccupiedLevel}`,
  )
  for (const b of r.bricks) {
    lines.push(
      `brick ${b.shape.bx}x${b.shape.by}x${b.shape.bz}: ${b.slotsTouched.toLocaleString()}/${b.slotsTotal.toLocaleString()}` +
        ` slots touched (${(b.slotsTouchedFraction * 100).toFixed(1)}%), mean fill ${(b.meanFillPerTouchedBrick * 100).toFixed(1)}%,` +
        ` alloc ${b.allocatedVoxels.toLocaleString()} vox (x${b.amplification.toFixed(2)}), pool ${mib(b.poolBytes)} MiB` +
        ` + indirection ${mib(b.indirectionBytes)} MiB`,
    )
  }
  const c = r.columnRun
  lines.push(
    `column-run: ${c.occupiedColumns.toLocaleString()} cols (${(c.occupiedColumnFraction * 100).toFixed(1)}%),` +
      ` mean run ${c.meanRunLength.toFixed(1)}, max ${c.maxRunLength},` +
      ` alloc ${c.allocatedVoxels.toLocaleString()} vox (x${c.amplification.toFixed(2)}), pool ${mib(c.poolBytes)} MiB` +
      ` + index ${mib(c.indexBytes)} MiB`,
  )
  return lines.join('\n')
}
