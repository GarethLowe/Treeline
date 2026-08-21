/**
 * WP 3.1 — the canopy voxel store: pool packing, the allocator, the grow path, and the
 * allocation-failure policy.
 *
 * ## There is no eviction, and that is a decision, not an omission
 *
 * §7.2 asks for "allocation and eviction". Eviction is wrong here and is deliberately not
 * implemented. A canopy voxel holds fuel mass, moisture and char state; evicting one during
 * a fire deletes fuel that has not burned, which changes the answer the simulation exists to
 * produce. The failure mode of *declining* an allocation is that a voxel which should have
 * become active stays absent — locally conservative, bounded, and countable. The failure mode
 * of eviction is unbounded and silent. So:
 *
 * - allocation is a bump pointer into a spare tail,
 * - a grown column is *re-homed* (new run copied into the tail, old slots leaked until the
 *   next world rebuild) rather than compacted, because compaction would have to stop the
 *   world to renumber every offset,
 * - when the tail is exhausted `allocate` returns `INVALID_VOXEL`, `failedAllocations`
 *   increments and `overflowed` latches true. Every reader already handles `INVALID_VOXEL`
 *   (it is what an empty column returns), so the failure needs no new code path anywhere,
 *   and the counter is what the dev HUD shows.
 *
 * Leaked slots are bounded by the number of grow events, which is bounded by the tail size,
 * so the leak cannot cascade.
 *
 * ## Why the tail is small
 *
 * The build pass covers the whole domain in one go, so every column that holds vegetation is
 * already allocated. Growth exists for the case §7.2 names — activity arriving outside the
 * initial hull — and for a column that must extend upward (a plume writing gas state above
 * the canopy top). Both are rare and local. The default tail is 2 % of the built voxel count
 * with a 4096-slot floor: 0.7 MiB on the measured dense-conifer world.
 */

import type { SpeciesDef } from '@contracts/world'
import { f32ToF16 } from '@world/terrain/halfFloat.ts'
import type { CanopyLayout } from './layout.ts'
import {
  INVALID_VOXEL,
  POOL_A_BYTES,
  POOL_B_BYTES,
  POOL_C_BYTES,
  Z_MASK,
  ZCOUNT_SHIFT,
  columnCount,
  packHeader,
} from './layout.ts'
import type { CanopyFields } from './voxelise.ts'
import { BARK_CLASSES, CLUMPING, FOLIAGE_SAV_PER_M } from './voxelise.ts'

// ---------------------------------------------------------------------------
// Quantisation
// ---------------------------------------------------------------------------

/** SAV log-quantisation range, m⁻¹. Covers ash bark (~200) to fine grass blade (~20 000). */
export const SAV_MIN_PER_M = 100
export const SAV_MAX_PER_M = 100_000
const SAV_LOG_SPAN = Math.log(SAV_MAX_PER_M / SAV_MIN_PER_M)

export const encodeSav = (sav: number): number => {
  const t = Math.log(Math.max(SAV_MIN_PER_M, Math.min(SAV_MAX_PER_M, sav)) / SAV_MIN_PER_M) / SAV_LOG_SPAN
  return Math.round(t * 255)
}
export const decodeSav = (code: number): number => SAV_MIN_PER_M * Math.exp((code / 255) * SAV_LOG_SPAN)

const u16norm = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 65535)
const u8norm = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255)

/** Voxel lifecycle. Mirrored in WGSL. WP 3.2 owns the transitions; the store owns the byte. */
export const PHASE_INERT = 0
export const PHASE_DRYING = 1
export const PHASE_PYROLYSING = 2
export const PHASE_FLAMING = 3
export const PHASE_CHAR = 4
export const PHASE_ASH = 5

// ---------------------------------------------------------------------------
// Pool packing
// ---------------------------------------------------------------------------

export interface PackedPools {
  // `<ArrayBuffer>` rather than plain: `GPUAllowSharedBufferSource` rejects the default
  // `ArrayBufferLike`, which also admits `SharedArrayBuffer`. Same reason as camera/math.ts.
  /** 4 u32 per voxel. See `layout.ts` POOL_A_BYTES. */
  readonly poolA: Uint32Array<ArrayBuffer>
  /** 2 u32 per voxel. */
  readonly poolB: Uint32Array<ArrayBuffer>
  /** 1 f32 per voxel — net volumetric source, written each step by WP 3.3/3.4. */
  readonly poolC: Float32Array<ArrayBuffer>
  /** 2 u32 per column: header, offset. */
  readonly columnIndex: Uint32Array<ArrayBuffer>
  /** 1 f32 per column: terrain elevation at the column centre. */
  readonly ground: Float32Array<ArrayBuffer>
  readonly slotCount: number
}

export interface PackOptions {
  /** Initial solid temperature. Default 293.15 K. */
  readonly ambientK?: number
  /**
   * Spare slots appended for the grow path. Default `max(4096, 2 % of built slots)`.
   * `layout.spareVoxels` wins if it is larger — a caller that pre-sized the layout meant it.
   */
  readonly spareVoxels?: number
}

/**
 * Quantise the SI fields into the three pools.
 *
 * Crown roundwood (φ_0-3, φ_3-6) is written as **zero**, not guessed. M1's vegetation carries
 * foliage bulk density and nothing else, so there is no source for a crown branchwood load;
 * inventing a split would put an unsourced constant into the fuel mass that Van Wagner's
 * CBD threshold reads. WP 3.2 owns closing that gap. See `provenance.ts`.
 */
export function packStore(
  fields: CanopyFields,
  ground: Float32Array<ArrayBuffer>,
  species: ReadonlyMap<string, SpeciesDef>,
  options: PackOptions = {},
): PackedPools {
  const layout = fields.layout
  const built = layout.voxelCount
  const spare = Math.max(
    layout.spareVoxels,
    options.spareVoxels ?? Math.max(4096, Math.round(built * 0.02)),
  )
  const slots = built + spare

  const poolA = new Uint32Array(slots * (POOL_A_BYTES / 4))
  const poolB = new Uint32Array(slots * (POOL_B_BYTES / 4))
  const poolC = new Float32Array(slots * (POOL_C_BYTES / 4))

  // Per-species constants, resolved once.
  const savCode: number[] = []
  const clumpCode: number[] = []
  const barkCode: number[] = []
  for (const id of fields.speciesIds) {
    const sp = species.get(id)
    const form = sp?.form ?? 'broadleaf'
    savCode.push(encodeSav(FOLIAGE_SAV_PER_M[form]))
    clumpCode.push(u8norm(CLUMPING[form]))
    const bi = sp === undefined ? 0 : BARK_CLASSES.indexOf(sp.bark)
    barkCode.push(bi < 0 ? 0 : bi)
  }

  const tBits = f32ToF16(options.ambientK ?? 293.15)
  const foliageFull = u16norm(1)

  for (let v = 0; v < built; v++) {
    const a = v * 4
    poolA[a] = (tBits | (foliageFull << 16)) >>> 0
    poolA[a + 1] = 0 // φ_0-3 | φ_3-6 — see the doc comment above
    poolA[a + 2] =
      (f32ToF16(fields.freeWater[v] as number) | (f32ToF16(fields.boundWater[v] as number) << 16)) >>> 0
    poolA[a + 3] = PHASE_INERT << 8 // χ = 0, phase, ṁ'' = 0

    const s = fields.speciesIdx[v] as number
    const b = v * 2
    poolB[b] =
      (f32ToF16(fields.lad[v] as number) | (f32ToF16(fields.dryDensity[v] as number) << 16)) >>> 0
    poolB[b + 1] =
      ((savCode[s] as number) |
        (s << 8) |
        ((clumpCode[s] as number) << 16) |
        ((barkCode[s] as number) << 24)) >>>
      0
  }

  const nCols = columnCount(layout.grid)
  const columnIndex = new Uint32Array(nCols * 2)
  for (let c = 0; c < nCols; c++) {
    columnIndex[c * 2] = layout.columnHeader[c] as number
    columnIndex[c * 2 + 1] = layout.columnOffset[c] as number
  }

  return { poolA, poolB, poolC, columnIndex, ground, slotCount: slots }
}

// ---------------------------------------------------------------------------
// Allocator — pure, CLI-testable, no device
// ---------------------------------------------------------------------------

export interface AllocationResult {
  /** First packed voxel index of the column's new run, or `INVALID_VOXEL` on refusal. */
  readonly offset: number
  readonly zStart: number
  readonly zCount: number
  /** Slots the previous run occupied and which are now leaked. 0 for a fresh column. */
  readonly leaked: number
}

/**
 * Bump allocator over the spare tail, with the re-home grow path.
 *
 * Holds a CPU mirror of the column index so `CanopyVoxelStore` can push exactly the eight
 * bytes that changed to the GPU rather than re-uploading the index.
 */
export class CanopyAllocator {
  readonly layout: CanopyLayout
  readonly columnIndex: Uint32Array<ArrayBuffer>
  readonly slotCount: number
  /** Next free slot in the tail. */
  private cursor: number
  private failed = 0
  private leakedSlots = 0
  private overflowedFlag = false

  constructor(layout: CanopyLayout, columnIndex: Uint32Array<ArrayBuffer>, slotCount: number) {
    this.layout = layout
    this.columnIndex = columnIndex
    this.slotCount = slotCount
    this.cursor = layout.voxelCount
  }

  get freeSlots(): number {
    return this.slotCount - this.cursor
  }
  get failedAllocations(): number {
    return this.failed
  }
  get leaked(): number {
    return this.leakedSlots
  }
  get overflowed(): boolean {
    return this.overflowedFlag
  }

  header(i: number, j: number): { zStart: number; zCount: number; offset: number } {
    const c = (j * this.layout.grid.nxy + i) * 2
    const h = this.columnIndex[c] as number
    return {
      zStart: h & Z_MASK,
      zCount: (h >>> ZCOUNT_SHIFT) & Z_MASK,
      offset: this.columnIndex[c + 1] as number,
    }
  }

  lookup(i: number, j: number, k: number): number {
    const g = this.layout.grid
    if (i < 0 || j < 0 || k < 0 || i >= g.nxy || j >= g.nxy || k >= g.nz) return INVALID_VOXEL
    const h = this.header(i, j)
    const d = k - h.zStart
    return d < 0 || d >= h.zCount ? INVALID_VOXEL : h.offset + d
  }

  /**
   * Ensure `[kLo, kHi]` is addressable in column `(i, j)`, growing the run if needed.
   *
   * Returns the run that now covers the request, or `offset === INVALID_VOXEL` if the tail is
   * exhausted. On refusal nothing is modified: the column keeps whatever it had.
   */
  ensureRange(i: number, j: number, kLo: number, kHi: number): AllocationResult {
    const g = this.layout.grid
    const refuse: AllocationResult = { offset: INVALID_VOXEL, zStart: 0, zCount: 0, leaked: 0 }
    if (i < 0 || j < 0 || i >= g.nxy || j >= g.nxy) return refuse
    const lo = Math.max(0, Math.min(kLo, kHi))
    const hi = Math.min(g.nz - 1, Math.max(kLo, kHi))
    if (hi < lo) return refuse

    const cur = this.header(i, j)
    if (cur.zCount > 0 && lo >= cur.zStart && hi < cur.zStart + cur.zCount) {
      return { offset: cur.offset, zStart: cur.zStart, zCount: cur.zCount, leaked: 0 }
    }

    const newStart = cur.zCount > 0 ? Math.min(cur.zStart, lo) : lo
    const newEnd = cur.zCount > 0 ? Math.max(cur.zStart + cur.zCount - 1, hi) : hi
    const newCount = newEnd - newStart + 1

    if (this.cursor + newCount > this.slotCount) {
      this.failed++
      this.overflowedFlag = true
      return refuse
    }

    const offset = this.cursor
    this.cursor += newCount
    this.leakedSlots += cur.zCount
    const c = (j * g.nxy + i) * 2
    this.columnIndex[c] = packHeader(newStart, newCount)
    this.columnIndex[c + 1] = offset
    return { offset, zStart: newStart, zCount: newCount, leaked: cur.zCount }
  }
}

// ---------------------------------------------------------------------------
// GPU store
// ---------------------------------------------------------------------------

export interface CanopyStoreStats {
  readonly voxelSlots: number
  readonly builtSlots: number
  readonly freeSlots: number
  readonly leakedSlots: number
  readonly failedAllocations: number
  readonly overflowed: boolean
}

/**
 * The five buffers every canopy pass binds, in this order:
 * `0 columnIndex, 1 ground, 2 poolA, 3 poolB, 4 poolC`.
 *
 * A/B are read-write (A is the hot state, B is static after build but shares the binding
 * pattern), C is read-write and write-combined by the flux passes.
 */
export class CanopyVoxelStore {
  readonly device: GPUDevice
  readonly allocator: CanopyAllocator
  readonly columnIndexBuffer: GPUBuffer
  readonly groundBuffer: GPUBuffer
  readonly poolABuffer: GPUBuffer
  /**
   * Pool A exactly as the voxeliser produced it, kept so the canopy can be put back.
   *
   * ~16 B per slot of host memory, about 20 MB on the shipping world. Worth it: without it
   * `resetFire` left every crown it had ever burnt charred forever — the fire restarted and the
   * forest did not, which only became obvious once foliage actually changed colour. It cannot
   * be reconstructed on demand either, because per-voxel water comes from each stem's foliar
   * moisture at voxelisation time and nothing else records it.
   */
  private readonly initialPoolA: Uint32Array<ArrayBuffer>
  readonly poolBBuffer: GPUBuffer
  readonly poolCBuffer: GPUBuffer
  readonly slotCount: number
  private readonly builtSlots: number

  constructor(device: GPUDevice, layout: CanopyLayout, packed: PackedPools) {
    this.device = device
    this.slotCount = packed.slotCount
    this.builtSlots = layout.voxelCount
    this.allocator = new CanopyAllocator(layout, packed.columnIndex, packed.slotCount)

    const make = (data: Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>, label: string): GPUBuffer => {
      const buf = device.createBuffer({
        label,
        size: Math.max(4, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(buf, 0, data)
      return buf
    }
    this.columnIndexBuffer = make(packed.columnIndex, 'canopy.columnIndex')
    this.groundBuffer = make(packed.ground, 'canopy.ground')
    this.poolABuffer = make(packed.poolA, 'canopy.poolA')
    this.initialPoolA = packed.poolA
    this.poolBBuffer = make(packed.poolB, 'canopy.poolB')
    this.poolCBuffer = make(packed.poolC, 'canopy.poolC')
  }

  /**
   * Put every voxel back to how it was voxelised: ambient, full foliage, full water, inert.
   *
   * Pool B is static by construction and pool C is written before it is read every step, so
   * pool A is the whole of the mutable state.
   */
  resetState(): void {
    this.device.queue.writeBuffer(this.poolABuffer, 0, this.initialPoolA)
  }

  /** Bind-group entries in the documented order. */
  bindGroupEntries(): GPUBindGroupEntry[] {
    return [
      { binding: 0, resource: { buffer: this.columnIndexBuffer } },
      { binding: 1, resource: { buffer: this.groundBuffer } },
      { binding: 2, resource: { buffer: this.poolABuffer } },
      { binding: 3, resource: { buffer: this.poolBBuffer } },
      { binding: 4, resource: { buffer: this.poolCBuffer } },
    ]
  }

  static bindGroupLayoutEntries(visibility: number = GPUShaderStage.COMPUTE): GPUBindGroupLayoutEntry[] {
    const ro: GPUBufferBindingLayout = { type: 'read-only-storage' }
    const rw: GPUBufferBindingLayout = { type: 'storage' }
    return [
      { binding: 0, visibility, buffer: ro },
      { binding: 1, visibility, buffer: ro },
      { binding: 2, visibility, buffer: rw },
      { binding: 3, visibility, buffer: ro },
      { binding: 4, visibility, buffer: rw },
    ]
  }

  /**
   * Grow a column and push only what changed: the 8-byte index entry, plus zero-fill of the
   * new run so the freshly-homed slots start inert rather than holding a previous tenant's
   * state. Existing voxel data is NOT copied — a re-homed run is re-initialised, because the
   * only caller is "activity arrived where there was no canopy", which has nothing to carry
   * over. A caller that needs the old contents must read them before calling.
   */
  ensureRange(i: number, j: number, kLo: number, kHi: number): AllocationResult {
    const r = this.allocator.ensureRange(i, j, kLo, kHi)
    if (r.offset === INVALID_VOXEL) return r
    const c = (j * this.allocator.layout.grid.nxy + i) * 2
    this.device.queue.writeBuffer(
      this.columnIndexBuffer,
      c * 4,
      this.allocator.columnIndex,
      c,
      2,
    )
    const zerosA = new Uint32Array(r.zCount * (POOL_A_BYTES / 4))
    const tBits = f32ToF16(293.15)
    for (let v = 0; v < r.zCount; v++) zerosA[v * 4] = tBits
    this.device.queue.writeBuffer(this.poolABuffer, r.offset * POOL_A_BYTES, zerosA)
    this.device.queue.writeBuffer(
      this.poolBBuffer,
      r.offset * POOL_B_BYTES,
      new Uint32Array(r.zCount * (POOL_B_BYTES / 4)),
    )
    this.device.queue.writeBuffer(
      this.poolCBuffer,
      r.offset * POOL_C_BYTES,
      new Float32Array(r.zCount),
    )
    return r
  }

  get stats(): CanopyStoreStats {
    return {
      voxelSlots: this.slotCount,
      builtSlots: this.builtSlots,
      freeSlots: this.allocator.freeSlots,
      leakedSlots: this.allocator.leaked,
      failedAllocations: this.allocator.failedAllocations,
      overflowed: this.allocator.overflowed,
    }
  }

  destroy(): void {
    this.columnIndexBuffer.destroy()
    this.groundBuffer.destroy()
    this.poolABuffer.destroy()
    this.poolBBuffer.destroy()
    this.poolCBuffer.destroy()
  }
}
