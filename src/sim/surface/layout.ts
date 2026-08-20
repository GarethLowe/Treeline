/**
 * WP 2.2 — byte-level layout of the 2048² surface state, and the VRAM footprint derived
 * from it.
 *
 * ## Closing the §4.3 OPEN QUESTION
 *
 * Spec §4.3 quotes "≈ 113 MB" for the surface state and flags that the number does not
 * reconcile with the field list beside it. It does not, for three reasons: the MB/MiB
 * convention was never stated, the `φ` ping-pong buffer was omitted, and the packed byte
 * state was counted without saying how it is laid out. All three are settled here, and the
 * number this file computes is the authoritative one.
 *
 * **Convention, stated once: `MiB` = 2²⁰ bytes, `MB` = 10⁶ bytes. This project quotes MiB.**
 *
 * **Ping-pong: `φ` needs exactly two buffers, nothing else needs any.**
 * - `φ` — yes. The level-set advance reads a ±2-cell neighbourhood (ENO2) and writes the
 *   centre, so in-place is a race. TVD-RK2 needs `φⁿ` alive while `φ⁽¹⁾` is built, and the
 *   second stage reads `φⁿ` (own cell only) plus the `φ⁽¹⁾` neighbourhood and can write back
 *   into the `φⁿ` slot — no other thread reads that slot. So two buffers, not three, and the
 *   jump-flood reinitialisation of §4.6 reuses the same pair between substeps.
 * - Packed cell state — no. The ROS passes only read it; the burnout pass (WP 2.4) reads and
 *   writes the cell's own bytes with no neighbour access, so in-place is safe.
 * - `t_ign` — no. Written with `atomicMin`, which is order-independent by construction.
 * - The ellipse cache — no. Written wholly from the cell's own inputs each substep.
 *
 * ## Why three u32 planes rather than one 12-byte struct
 *
 * §4.3's field list is exactly 12 bytes: `fuelModelId` + `flags` + 5 mass fractions + 3 dead
 * moistures + 2 live moistures. Stored as a struct that is a 12-byte stride, which is not a
 * power of two and straddles cache lines on 4 of every 16 cells. Stored as three separate
 * `array<u32>` planes it is the same 12 bytes with a 4-byte stride in each plane — fully
 * coalesced, and each pass touches only the planes it needs. That is the structure-of-arrays
 * requirement in the assignment, and it costs nothing.
 *
 * The plane assignment groups by *consumer*, so the two ROS passes touch planes 0 and 1 and
 * the burnout pass touches planes 1 and 2. One byte (`mass1h`) has to straddle: there are
 * five mass fractions and only four spare slots in plane 2.
 */

import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/world'

export { SURFACE_CELLS, SURFACE_CELL_M }

export const SURFACE_CELL_COUNT = SURFACE_CELLS * SURFACE_CELLS // 4_194_304

// ---------------------------------------------------------------------------
// Packed byte state: three u32 planes
// ---------------------------------------------------------------------------

/** Byte slot within a plane, 0 = least-significant byte of the u32. */
export const enum ByteSlot {
  B0 = 0,
  B1 = 1,
  B2 = 2,
  B3 = 3,
}

/**
 * Plane 0 — read by both ROS passes.
 * Plane 1 — read by the moisture-tick ROS pass and by burnout (`mass1h`).
 * Plane 2 — read/written by burnout only.
 */
export const PLANE_COUNT = 3

export interface FieldSlot {
  readonly plane: 0 | 1 | 2
  readonly byte: ByteSlot
  /**
   * unorm8 full-scale value: the byte encodes `value / scale`. Ignored when `raw`.
   *
   * Note there is no "scale of 1 means raw" shortcut — dead moisture legitimately has a full
   * scale of exactly 1.0, and conflating that with an integer field silently zeroes it.
   */
  readonly scale: number
  /** True for integer fields (`fuelModelId`, `flags`) stored as a plain byte. */
  readonly raw?: true
}

/**
 * Moisture full-scale values. Dead fuel is bounded well below 1.0 in practice (the largest
 * tabulated `M_x,dead` is 0.35 and nothing carries fire much above 0.6), so a full scale of
 * 1.0 gives 0.39% steps. Live fuel runs to ~3.0 in spring, so it needs the wider scale and
 * gets 1.6% steps — acceptable because `η_M,live` is flat there: `M_x,live` from Eq. 88 is
 * typically 3–5, so `r_M,live` is small and the damping polynomial is nearly linear.
 *
 * **Known cost, measured:** at the §4.2 GR2 D2L2 point, dead moisture 0.06 quantises to
 * 0.0588, which raises the GPU's rate of spread to 11.81 m/min against the oracle's 11.70 —
 * about 1%. That is the dominant error in the whole pass, an order of magnitude above the f16
 * output packing.
 *
 * ponytail: unorm8 moisture, ~1% on ROS near 6% dead moisture. Upgrade path if a validation
 * benchmark needs better: promote the three dead channels to unorm16, +3 B/cell = +12 MiB.
 * Not done now because Rothermel's own documented bias in grass is tens of percent (§4.9).
 */
export const DEAD_MOISTURE_FULL_SCALE = 1.0
export const LIVE_MOISTURE_FULL_SCALE = 4.0

/** Remaining oven-dry mass as a fraction of the model's load for that class. */
export const MASS_FULL_SCALE = 1.0

export const FIELDS = {
  fuelModelId: { plane: 0, byte: ByteSlot.B0, scale: 1, raw: true },
  flags: { plane: 0, byte: ByteSlot.B1, scale: 1, raw: true },
  moistureDead1h: { plane: 0, byte: ByteSlot.B2, scale: DEAD_MOISTURE_FULL_SCALE },
  moistureDead10h: { plane: 0, byte: ByteSlot.B3, scale: DEAD_MOISTURE_FULL_SCALE },

  moistureDead100h: { plane: 1, byte: ByteSlot.B0, scale: DEAD_MOISTURE_FULL_SCALE },
  moistureLiveHerb: { plane: 1, byte: ByteSlot.B1, scale: LIVE_MOISTURE_FULL_SCALE },
  moistureLiveWoody: { plane: 1, byte: ByteSlot.B2, scale: LIVE_MOISTURE_FULL_SCALE },
  mass1h: { plane: 1, byte: ByteSlot.B3, scale: MASS_FULL_SCALE },

  mass10h: { plane: 2, byte: ByteSlot.B0, scale: MASS_FULL_SCALE },
  mass100h: { plane: 2, byte: ByteSlot.B1, scale: MASS_FULL_SCALE },
  massHerb: { plane: 2, byte: ByteSlot.B2, scale: MASS_FULL_SCALE },
  massWoody: { plane: 2, byte: ByteSlot.B3, scale: MASS_FULL_SCALE },
} as const satisfies Record<string, FieldSlot>

export type FieldName = keyof typeof FIELDS

/** Cell flag bits packed into `FIELDS.flags`. */
export const FLAG_BURNABLE = 1 << 0
export const FLAG_IGNITED = 1 << 1
export const FLAG_BURNT_OUT = 1 << 2
/** Set by the ignition tool; consumed and cleared by the level-set seed pass. */
export const FLAG_IGNITION_REQUEST = 1 << 3

// ---------------------------------------------------------------------------
// Pack / unpack. The GPU side of these lives in shaders/sim/surface/common.wgsl.
// ---------------------------------------------------------------------------

export const encodeUnorm8 = (v: number, fullScale: number): number =>
  Math.max(0, Math.min(255, Math.round((v / fullScale) * 255)))

export const decodeUnorm8 = (b: number, fullScale: number): number => (b / 255) * fullScale

export const readByte = (word: number, slot: ByteSlot): number => (word >>> (slot * 8)) & 0xff

export const writeByte = (word: number, slot: ByteSlot, value: number): number => {
  const shift = slot * 8
  return ((word & ~(0xff << shift)) | ((value & 0xff) << shift)) >>> 0
}

/** Read a named field out of the three plane words, already decoded through its scale. */
export function readField(words: readonly [number, number, number], name: FieldName): number {
  const f: FieldSlot = FIELDS[name]
  const b = readByte(words[f.plane], f.byte)
  return f.raw === true ? b : decodeUnorm8(b, f.scale)
}

/** Write a named field into a mutable triple of plane words. */
export function writeField(
  words: [number, number, number],
  name: FieldName,
  value: number,
): void {
  const f: FieldSlot = FIELDS[name]
  const b =
    f.raw === true ? Math.max(0, Math.min(255, Math.round(value))) : encodeUnorm8(value, f.scale)
  words[f.plane] = writeByte(words[f.plane], f.byte, b)
}

// ---------------------------------------------------------------------------
// Footprint — the answer to the §4.3 OPEN QUESTION
// ---------------------------------------------------------------------------

export interface BufferSpec {
  readonly name: string
  readonly bytesPerCell: number
  /** How many copies exist. 2 = ping-pong. */
  readonly copies: number
  readonly why: string
}

/**
 * Everything WP 2.2 allocates. WP 2.4's consumer-facing output textures
 * (`IFireOutputs.stateTexture`, `intensityTexture`, `consumedTexture`) are NOT in here — they
 * are a separate 4 B/cell = 16 MiB owned by that package. `arrivalTimeTexture` is not extra:
 * it is this table's `t_ign`, exposed as a texture view.
 */
export const SURFACE_BUFFERS: readonly BufferSpec[] = [
  { name: 'packedState', bytesPerCell: 4 * PLANE_COUNT, copies: 1, why: '3 u32 SoA planes; §4.3 field list, exactly 12 B' },
  { name: 'phi', bytesPerCell: 4, copies: 2, why: 'r32float level set; ENO2 reads neighbours, so ping-pong is mandatory' },
  { name: 'ignitionTime', bytesPerCell: 4, copies: 1, why: 'r32float t_ign; atomicMin, order-independent, no ping-pong' },
  { name: 'ellipseCache', bytesPerCell: 8, copies: 1, why: 'rgba16float (R_head, LB, headingX, headingY), rewritten every substep' },
  { name: 'rosBase', bytesPerCell: 4, copies: 1, why: 'rg16float (R0 [m/min], I_R [kW/m2]); the §4.3 factorisation cache, rewritten on the moisture tick only' },
]

export const SURFACE_STATE_BYTES_PER_CELL_ACTUAL = SURFACE_BUFFERS.reduce(
  (n, b) => n + b.bytesPerCell * b.copies,
  0,
) // 12 + 8 + 4 + 8 + 4 = 36

export const SURFACE_STATE_BYTES = SURFACE_STATE_BYTES_PER_CELL_ACTUAL * SURFACE_CELL_COUNT

export const MIB = 1024 * 1024
export const MB = 1_000_000

/** 36 B/cell × 4_194_304 = 150_994_944 B = **144 MiB** = 151.0 MB. */
export const SURFACE_STATE_MIB = SURFACE_STATE_BYTES / MIB
export const SURFACE_STATE_MB = SURFACE_STATE_BYTES / MB

/** Human-readable derivation, so the number in the VRAM budget carries its own working. */
export function footprintReport(): string {
  const rows = SURFACE_BUFFERS.map((b) => {
    const bytes = b.bytesPerCell * b.copies * SURFACE_CELL_COUNT
    const copies = b.copies > 1 ? ` x${b.copies}` : ''
    return `  ${b.name.padEnd(14)} ${String(b.bytesPerCell).padStart(2)} B/cell${copies.padEnd(3)} = ${(bytes / MIB).toFixed(0).padStart(3)} MiB   ${b.why}`
  })
  return [
    `Surface layer state, ${SURFACE_CELLS}^2 = ${SURFACE_CELL_COUNT.toLocaleString('en-US')} cells`,
    ...rows,
    `  ${'TOTAL'.padEnd(14)} ${SURFACE_STATE_BYTES_PER_CELL_ACTUAL} B/cell    = ${SURFACE_STATE_MIB.toFixed(0)} MiB (${SURFACE_STATE_MB.toFixed(1)} MB decimal)`,
    `MiB = 2^20 B, MB = 10^6 B. Spec §4.3's "~113 MB" is superseded.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Per-substep memory traffic — the second §4.3 OPEN QUESTION
// ---------------------------------------------------------------------------

/**
 * §4.3's second callout asks for the optimisation's payoff restated in bytes rather than
 * FLOP, because at 4.19 M cells the arithmetic is nanoseconds and the traffic is not.
 *
 * Substep pass, per cell: read `rosBase` (4) + planes 0 and 1 (8, for `fuelModelId` and the
 * cure fraction that selects the LUT bin) + terrain slope/upslope (4, rg16float, owned by
 * WP 1.2) + wind (0 — a uniform until M5 makes it a field); write the ellipse cache (8).
 * **24 B/cell/substep = 96 MiB per full-grid substep**, which at ~180 GB/s achievable is
 * ~0.53 ms. That is the number to budget against, not the ~20 FLOP.
 *
 * The LUT itself is not counted: it is ~108 KB, read broadcast (every thread in a workgroup
 * hits the same record wherever the fuel map is locally uniform, which is everywhere except
 * biome boundaries), and lands in L2. That is the thing §4.3's callout asks to confirm by
 * profiling; the design at least gives it the best possible chance by being read-only, tiny
 * and coherent.
 *
 * What the `rosBase` cache buys: without it the substep would repeat the moisture-damping and
 * heat-sink evaluation, which needs no extra traffic (planes 0 and 1 are already read) but
 * costs the `η_M` polynomial twice and the Eq. 88 live-`M_x` chain twice. So the factorisation
 * is a 4 B/cell/substep *cost* and an ALU saving — the opposite sign from the framing in
 * §4.3. It is kept because WP 2.4 needs the per-cell `I_R` anyway and would otherwise have to
 * recompute the whole kernel to get it.
 */
export const SUBSTEP_BYTES_PER_CELL = 4 + 4 + 4 + 4 + 8
export const SUBSTEP_BYTES_FULL_GRID = SUBSTEP_BYTES_PER_CELL * SURFACE_CELL_COUNT
