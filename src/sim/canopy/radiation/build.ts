/**
 * World-build inputs for WP 3.3, derived from WP 3.1's voxelisation on the CPU.
 *
 * Two things the radiation pass needs and nothing produced:
 *
 * 1. **The 4 m extinction field** (`buildExtinctionField`). `extinction.wgsl` computes it on
 *    the GPU from dense 2 m LAD and clumping textures — 48 MiB of 3D textures materialised
 *    purely to be read once and thrown away. kappa is *linear* in LAD, which the shader's own
 *    header points out, so averaging on the CPU from `CanopyFields` (which already holds LAD
 *    per voxel, in memory, at build time) gives the identical field for a 4 MiB upload and no
 *    pass at all. The GPU path stays for the day the canopy changes at runtime.
 *
 * 2. **The active brick list** (`buildBrickList`). `gather.wgsl` runs one workgroup per active
 *    16 m brick and reads the list of them; nothing built it. A brick is active if any of its
 *    2 m voxels holds foliage — a brick with no canopy has nothing to heat, and including it
 *    would spend a full 64-lane cluster scan producing zeros.
 *
 * Both are pure and CLI-testable, which is the point: the shader they feed cannot be tested
 * under Vitest at all.
 */

import type { SpeciesDef } from '@contracts/world'
import type { CanopyFields } from '../storage/voxelise.ts'
import { CLUMPING } from '../storage/voxelise.ts'
import { INVALID_VOXEL, lookup } from '../storage/layout.ts'
import { LEAF_PROJECTION_SPHERICAL } from './optics.ts'
import { RAD_NI, RAD_NJ, RAD_NK } from './layout.ts'
import { BRICK_NI, BRICK_NJ, BRICK_NK } from './shaders.ts'
import { RAD_CELLS_PER_BRICK_AXIS } from './layout.ts'
/**
 * Encode one f32 as IEEE binary16. Bit-exact, including subnormals and the overflow clamp.
 *
 * Lived in WP 2.3's `stub.ts` until that was deleted; this is its one production caller.
 */
function toHalf(value: number): number {
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  f32[0] = value
  const x = u32[0] as number
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x007f_ffff
  if (exp >= 0x1f) return sign | 0x7c00
  if (exp <= 0) {
    if (exp < -10) return sign
    return sign | ((mant | 0x0080_0000) >>> (1 - exp + 13))
  }
  exp = exp << 10
  return sign | exp | (mant >>> 13)
}

/**
 * Per-voxel accessor over the packed layout. Returns 0 outside any allocated column run,
 * which is the physically correct answer: no allocation means no foliage.
 */
function ladLookup(fields: CanopyFields): (i: number, j: number, k: number) => number {
  return (i, j, k) => {
    const slot = lookup(fields.layout, i, j, k)
    return slot === INVALID_VOXEL ? 0 : (fields.lad[slot] ?? 0)
  }
}

function clumpLookup(
  fields: CanopyFields,
  species: ReadonlyMap<string, SpeciesDef>,
): (i: number, j: number, k: number) => number {
  // Resolve the per-species constant once; the voxel stores only the species index.
  // The form comes from the species definition — inferring it from the id string would be a
  // silent wrong answer for any species whose name does not happen to contain its form.
  const perSpecies = fields.speciesIds.map((id) => {
    const def = species.get(id)
    if (def === undefined) throw new Error(`buildExtinctionField: unknown species '${id}'`)
    return CLUMPING[def.form]
  })
  return (i, j, k) => {
    const slot = lookup(fields.layout, i, j, k)
    if (slot === INVALID_VOXEL) return 0
    return perSpecies[fields.speciesIdx[slot] ?? 0] ?? CLUMPING.conifer
  }
}

/**
 * `kappa = G · Omega_c · LAD`, averaged over each 4 m cell's eight 2 m voxels.
 *
 * Averaging LAD and then taking kappa is identical to averaging kappa, because the relation
 * is linear — unlike averaging *transmittance*, which is where voxel radiative transfer
 * usually goes wrong.
 *
 * @returns `RAD_NI · RAD_NJ · RAD_NK` binary16 values, x fastest then y then z, ready for
 *   `CanopyRadiation.uploadExtinction`.
 */
export function buildExtinctionField(
  fields: CanopyFields,
  species: ReadonlyMap<string, SpeciesDef>,
): Uint16Array<ArrayBuffer> {
  const lad = ladLookup(fields)
  const clump = clumpLookup(fields, species)
  const out = new Uint16Array(RAD_NI * RAD_NJ * RAD_NK)
  for (let k = 0; k < RAD_NK; k++) {
    for (let j = 0; j < RAD_NJ; j++) {
      for (let i = 0; i < RAD_NI; i++) {
        let sum = 0
        for (let dk = 0; dk < 2; dk++) {
          for (let dj = 0; dj < 2; dj++) {
            for (let di = 0; di < 2; di++) {
              const vi = i * 2 + di
              const vj = j * 2 + dj
              const vk = k * 2 + dk
              sum += LEAF_PROJECTION_SPHERICAL * clump(vi, vj, vk) * Math.max(0, lad(vi, vj, vk))
            }
          }
        }
        out[(k * RAD_NJ + j) * RAD_NI + i] = toHalf(sum * 0.125)
      }
    }
  }
  return out
}

export interface BrickList {
  /** Indirection-grid indices of the active bricks, in the order `gather.wgsl` expects. */
  readonly indices: Uint32Array<ArrayBuffer>
  readonly count: number
  /** Bricks in the full grid, for reporting the sparsity this actually bought. */
  readonly total: number
}

/**
 * Active 16 m bricks — those whose radiation cells contain any foliage at all.
 *
 * The index convention is `bi + BRICK_NI·bj + BRICK_NI·BRICK_NJ·bk`, k vertical, matching the
 * decode at the top of `gather.wgsl`. Getting this wrong does not fail; it heats the wrong
 * part of the forest.
 */
export function buildBrickList(fields: CanopyFields): BrickList {
  const lad = ladLookup(fields)
  const per = RAD_CELLS_PER_BRICK_AXIS
  const total = BRICK_NI * BRICK_NJ * BRICK_NK
  const indices = new Uint32Array(total)
  let count = 0
  for (let bk = 0; bk < BRICK_NK; bk++) {
    for (let bj = 0; bj < BRICK_NJ; bj++) {
      for (let bi = 0; bi < BRICK_NI; bi++) {
        // A brick spans `per` radiation cells, each two canopy voxels wide.
        const i0 = bi * per * 2
        const j0 = bj * per * 2
        const k0 = bk * per * 2
        let occupied = false
        for (let dk = 0; dk < per * 2 && !occupied; dk++) {
          for (let dj = 0; dj < per * 2 && !occupied; dj++) {
            for (let di = 0; di < per * 2; di++) {
              if (lad(i0 + di, j0 + dj, k0 + dk) > 0) {
                occupied = true
                break
              }
            }
          }
        }
        if (occupied) {
          indices[count] = bi + BRICK_NI * bj + BRICK_NI * BRICK_NJ * bk
          count++
        }
      }
    }
  }
  return { indices: indices.slice(0, Math.max(1, count)), count, total }
}
