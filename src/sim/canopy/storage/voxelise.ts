/**
 * WP 3.1 — voxelising the M1 vegetation into the canopy grid.
 *
 * Two passes over the stems, deliberately:
 *
 * 1. Rasterise crown solids into an `OccupancyMask` (2 MiB dense bitset).
 * 2. Build the packed layout from the mask, then rasterise *again* straight into the packed
 *    arrays.
 *
 * That costs one extra CPU rasterisation and saves ~270 MiB of dense f32 scratch, which is
 * the difference between a world build that runs in a Web Worker and one that does not. It
 * also makes the measurement in `occupancy.ts` operate on the same mask the layout is built
 * from, so the reported occupancy is the shipped occupancy rather than an estimate of it.
 *
 * ## Mass conservation is the acceptance property
 *
 * The sub-sampled overlap weight (2x2x2 per voxel) is a coarse estimate of the crown solid's
 * share of each voxel. It does not need to be accurate, because the second pass normalises
 * each stem's weights to sum to 1 and multiplies by that stem's foliage mass — so the total
 * dry mass in the grid equals `Σ crownBulkDensity · crownVolume` exactly, whatever the
 * sub-sampling does. What sub-sampling controls is only the *distribution* within the crown
 * envelope, at 1/8-of-a-voxel granularity. The tests assert the conservation, not the shape.
 *
 * ## Leaf area density
 *
 * LAD (one-sided, m² m⁻³) is not stored by M1 and is not a free parameter here: for foliage
 * particles of surface-to-volume ratio σ (m⁻¹) and oven-dry particle density ρ_p (kg m⁻³),
 *
 *     total leaf area per unit canopy volume = (ρ_bulk / ρ_p) · σ    [m² m⁻³, BOTH faces]
 *     LAD_one-sided = ½ (ρ_bulk / ρ_p) · σ
 *
 * so the specific leaf area is `SLA = σ / (2 ρ_p)` m² kg⁻¹. ρ_p = 512.6 kg m⁻³ is Rothermel's
 * standard oven-dry particle density (32 lb ft⁻³) — free, published, exact. σ comes from the
 * particle's own geometry: a cylinder of diameter d has σ = 4/d, a lamina of thickness t has
 * σ = 2/t. The thicknesses are the estimated part, and are declared as such in
 * `provenance.ts`. The resulting SLA values (conifer 3.9, broadleaf 9.8, sclerophyll shrub
 * 4.9 m² kg⁻¹ one-sided) sit inside the commonly reported ranges for those growth forms,
 * which is the cross-check; they are not fitted to it.
 */

import type { IVegetationSet, SpeciesDef, Stem } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { m } from '@contracts/units'
import { crownVolumeM3 } from '@world/vegetation/vegetationSet.ts'
import type { CanopyGrid, CanopyLayout } from './layout.ts'
import { CANOPY_GRID, INVALID_VOXEL, OccupancyMask, buildLayout, columnCount, lookup } from './layout.ts'

// ---------------------------------------------------------------------------
// Foliage particle properties, by growth form
// ---------------------------------------------------------------------------

/** Rothermel (1972) standard oven-dry fuel particle density, 32 lb ft⁻³. */
export const PARTICLE_DENSITY_KG_M3 = 512.6

export type Form = SpeciesDef['form']

/** Particle surface-to-volume ratio, m⁻¹. Needle: 4/d. Lamina: 2/t. See provenance.ts. */
export const FOLIAGE_SAV_PER_M: Readonly<Record<Form, number>> = {
  conifer: 4000, // needle d = 1 mm (spec §30 §7.6 worked point)
  broadleaf: 10_000, // lamina t = 0.2 mm
  shrub: 5_000, // sclerophyll lamina t = 0.4 mm
  fern: 8_000, // frond pinnule t = 0.25 mm
  grass: 8_000, // blade t = 0.25 mm
}

/** One-sided specific leaf area, m² kg⁻¹. Derived, never transcribed. */
export const specificLeafArea = (form: Form): number =>
  FOLIAGE_SAV_PER_M[form] / (2 * PARTICLE_DENSITY_KG_M3)

/**
 * Clumping factor Ω_c (spec §30 §7.3): the departure from a random turbid medium. Conifer
 * shoots bunch needles, so a given LAD extinguishes less than Beer–Lambert predicts.
 * Spec quotes 0.4–0.8 for conifer shoots and ≈0.9 for broadleaf.
 */
export const CLUMPING: Readonly<Record<Form, number>> = {
  conifer: 0.6,
  broadleaf: 0.9,
  shrub: 0.8,
  fern: 0.9,
  grass: 0.9,
}

/** Bark class id stored per voxel. WP 3.6 needs the class, not an unsourced "bark fraction". */
export const BARK_CLASSES: readonly SpeciesDef['bark'][] = [
  'thick-plated',
  'furrowed',
  'smooth',
  'papery',
  'decorticating-ribbon',
  'fibrous',
]

/** Fibre saturation point. Below it water is bound; above it, free. Spec §30 §7.6: ~30 %. */
export const FIBRE_SATURATION = 0.3

/**
 * Crown solid, in the same idealisation `@world/vegetation`'s `crownVolumeM3` integrates, so
 * the rasterised volume and the analytic mass agree by construction rather than by luck.
 * `t` is 0 at the crown base and 1 at the top; returns the radius fraction.
 */
export function crownRadiusFraction(form: Form, t: number): number {
  if (t < 0 || t > 1) return 0
  switch (form) {
    case 'conifer':
      return 1 - t // cone, apex up — volume factor 1/3
    case 'broadleaf':
    case 'shrub':
      return Math.sqrt(Math.max(0, 1 - t * t)) // prolate half-spheroid — factor 2/3
    case 'fern':
    case 'grass':
      return 1 // slab — factor 1
  }
}

// ---------------------------------------------------------------------------
// Ground field
// ---------------------------------------------------------------------------

export interface TerrainHeights {
  heightAt(x: Metres, z: Metres): Metres
}

/** Terrain elevation at every column centre. The shear the AGL addressing needs. */
export function sampleGround(terrain: TerrainHeights, grid: CanopyGrid): Float32Array<ArrayBuffer> {
  const out = new Float32Array(columnCount(grid))
  for (let j = 0; j < grid.nxy; j++) {
    for (let i = 0; i < grid.nxy; i++) {
      out[j * grid.nxy + i] = terrain.heightAt(
        m((i + 0.5) * grid.cellM),
        m((j + 0.5) * grid.cellM),
      )
    }
  }
  return out
}

/**
 * Ground elevation difference between a column and its neighbour, metres. A stencil that
 * steps in i or j also steps in world Y by this much — the price of the sheared grid, and the
 * thing a naive 6-neighbour Laplacian would silently get wrong on a slope.
 */
export function groundStepM(
  ground: Float32Array,
  grid: CanopyGrid,
  i: number,
  j: number,
  di: number,
  dj: number,
): number {
  const i2 = i + di
  const j2 = j + dj
  if (i2 < 0 || j2 < 0 || i2 >= grid.nxy || j2 >= grid.nxy) return 0
  return (ground[j2 * grid.nxy + i2] as number) - (ground[j * grid.nxy + i] as number)
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

interface CrownExtent {
  readonly form: Form
  /** World Y of the crown base and top. */
  readonly y0: number
  readonly y1: number
  readonly radiusM: number
  readonly x: number
  readonly z: number
}

function crownExtent(stem: Stem, form: Form): CrownExtent | null {
  const y0 = stem.groundY + stem.crownBaseM
  const y1 = stem.groundY + stem.heightM
  if (!(y1 > y0) || !(stem.crownRadiusM > 0)) return null
  return { form, y0, y1, radiusM: stem.crownRadiusM, x: stem.x, z: stem.z }
}

/** Sub-sample offsets within a voxel: 2x2x2 at the quarter points. */
const SUB = [0.25, 0.75]

/**
 * Fraction of voxel `(i, j, k)` inside the crown solid, quantised to eighths.
 * `groundY` is the terrain elevation of *this* column, which is what makes the grid sheared.
 */
function voxelWeight(e: CrownExtent, grid: CanopyGrid, i: number, j: number, k: number, groundY: number): number {
  const cell = grid.cellM
  const invLen = 1 / (e.y1 - e.y0)
  let hits = 0
  for (const fy of SUB) {
    const y = groundY + (k + fy) * cell
    const t = (y - e.y0) * invLen
    if (t < 0 || t > 1) continue
    const r = e.radiusM * crownRadiusFraction(e.form, t)
    if (r <= 0) continue
    const r2 = r * r
    for (const fx of SUB) {
      const dx = (i + fx) * cell - e.x
      for (const fz of SUB) {
        const dz = (j + fz) * cell - e.z
        if (dx * dx + dz * dz <= r2) hits++
      }
    }
  }
  return hits / 8
}

/**
 * Inclusive column bounds a crown can touch. **Unclamped**: a crown whose centre is inside the
 * domain can hang over the edge, and those weights have to be counted as clipped rather than
 * silently renormalised into the columns that remain — renormalising would inflate crown bulk
 * density along the domain boundary, which is exactly the quantity Van Wagner's threshold
 * reads. Ground for an out-of-domain column clamps to the edge, matching `canopy_ground_at`.
 */
function crownBounds(e: CrownExtent, grid: CanopyGrid): { i0: number; i1: number; j0: number; j1: number } {
  const c = grid.cellM
  return {
    i0: Math.floor((e.x - e.radiusM) / c),
    i1: Math.floor((e.x + e.radiusM) / c),
    j0: Math.floor((e.z - e.radiusM) / c),
    j1: Math.floor((e.z + e.radiusM) / c),
  }
}

/** Terrain elevation with clamp-to-edge, so out-of-domain columns still have a stack origin. */
function groundClamped(ground: Float32Array, grid: CanopyGrid, i: number, j: number): number {
  const ci = i < 0 ? 0 : i >= grid.nxy ? grid.nxy - 1 : i
  const cj = j < 0 ? 0 : j >= grid.nxy ? grid.nxy - 1 : j
  return ground[cj * grid.nxy + ci] as number
}

export interface VoxeliseResult {
  readonly grid: CanopyGrid
  readonly mask: OccupancyMask
  readonly ground: Float32Array<ArrayBuffer>
  /** Total oven-dry foliage mass the stems carry, kg. */
  readonly stemFoliageMassKg: number
  /** Stems whose crown was wholly or partly above `nz * cellM` AGL, and the mass lost. */
  readonly clippedStems: number
  /** Stems with a degenerate crown (zero length or zero radius) — grasses, mostly. */
  readonly skippedStems: number
}

/**
 * Pass 1: occupancy only. `mask` is what `buildLayout` and `occupancy.ts` consume.
 */
export function voxeliseOccupancy(
  veg: IVegetationSet,
  ground: Float32Array<ArrayBuffer>,
  grid: CanopyGrid = CANOPY_GRID,
): VoxeliseResult {
  const mask = new OccupancyMask(grid)
  const topM = grid.nz * grid.cellM
  let mass = 0
  let clipped = 0
  let skipped = 0

  for (const stem of veg.stems) {
    const sp = veg.species.get(stem.speciesId)
    if (sp === undefined) continue
    const e = crownExtent(stem, sp.form)
    if (e === null) {
      skipped++
      continue
    }
    mass += stem.crownBulkDensity * crownVolumeM3(stem, sp.form)
    if (stem.heightM > topM) clipped++

    const b = crownBounds(e, grid)
    for (let j = Math.max(0, b.j0); j <= Math.min(grid.nxy - 1, b.j1); j++) {
      for (let i = Math.max(0, b.i0); i <= Math.min(grid.nxy - 1, b.i1); i++) {
        const g = ground[j * grid.nxy + i] as number
        const kLo = Math.max(0, Math.floor((e.y0 - g) / grid.cellM))
        const kHi = Math.min(grid.nz - 1, Math.ceil((e.y1 - g) / grid.cellM))
        for (let k = kLo; k <= kHi; k++) {
          if (voxelWeight(e, grid, i, j, k, g) > 0) mask.set(i, j, k)
        }
      }
    }
  }

  return {
    grid,
    mask,
    ground,
    stemFoliageMassKg: mass,
    clippedStems: clipped,
    skippedStems: skipped,
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — packed fields
// ---------------------------------------------------------------------------

/**
 * The physical state pass 2 produces. Plain typed arrays in SI, indexed by packed voxel
 * index. `store.ts` quantises these into the pool A/B words; keeping the unquantised form
 * separate is what lets the CLI tests assert conservation without decoding f16.
 */
export interface CanopyFields {
  readonly layout: CanopyLayout
  /** Oven-dry foliage bulk density, kg m⁻³. */
  readonly dryDensity: Float32Array
  /** One-sided leaf area density, m² m⁻³. */
  readonly lad: Float32Array
  /** Free water, kg m⁻³ (above fibre saturation). */
  readonly freeWater: Float32Array
  /** Bound water, kg m⁻³ (at or below fibre saturation). */
  readonly boundWater: Float32Array
  /** Index into the species list of `speciesIds`. */
  readonly speciesIdx: Uint8Array
  readonly speciesIds: readonly string[]
  /** Mass actually deposited, kg. Equals `stemFoliageMassKg` minus clipping. */
  readonly depositedMassKg: number
  /** Mass whose voxel fell outside the grid (above `nz` or past the domain edge), kg.
   *  Reported, never silently dropped or renormalised away. */
  readonly clippedMassKg: number
}

/**
 * Pass 2: deposit mass, water and species into the packed layout.
 *
 * Species per voxel is "largest single contribution wins", tracked without a dense scratch
 * array by comparing each contribution against the mass already accumulated in the voxel.
 * That is exact when contributions arrive in descending order and can pick the second-largest
 * otherwise; it decides only which SAV/clumping/bark constants a mixed voxel uses, so the
 * error is a constant-selection tie-break, not a mass error.
 */
export function voxeliseFields(
  veg: IVegetationSet,
  result: VoxeliseResult,
  layout: CanopyLayout,
): CanopyFields {
  const grid = result.grid
  const n = layout.voxelCount + layout.spareVoxels
  const mass = new Float32Array(n)
  const leafArea = new Float32Array(n)
  const free = new Float32Array(n)
  const bound = new Float32Array(n)
  const speciesIdx = new Uint8Array(n)

  const speciesIds = [...veg.species.keys()]
  const idOf = new Map(speciesIds.map((id, k) => [id, k]))

  const idx: number[] = []
  const wts: number[] = []
  let deposited = 0
  let clippedMass = 0

  for (const stem of veg.stems) {
    const sp = veg.species.get(stem.speciesId)
    if (sp === undefined) continue
    const e = crownExtent(stem, sp.form)
    if (e === null) continue

    const stemMass = stem.crownBulkDensity * crownVolumeM3(stem, sp.form)
    if (stemMass <= 0) continue

    idx.length = 0
    wts.length = 0
    let wSum = 0
    let wInside = 0
    const b = crownBounds(e, grid)
    for (let j = b.j0; j <= b.j1; j++) {
      for (let i = b.i0; i <= b.i1; i++) {
        const g = groundClamped(result.ground, grid, i, j)
        const kLoRaw = Math.floor((e.y0 - g) / grid.cellM)
        const kHiRaw = Math.ceil((e.y1 - g) / grid.cellM)
        for (let k = kLoRaw; k <= kHiRaw; k++) {
          const w = voxelWeight(e, grid, i, j, k, g)
          if (w <= 0) continue
          wSum += w
          const v = lookup(layout, i, j, k)
          if (v === INVALID_VOXEL) continue
          idx.push(v)
          wts.push(w)
          wInside += w
        }
      }
    }
    if (wSum <= 0) continue

    // Weights outside the grid — above `nz`, below ground, or past the domain edge — are
    // counted, not redistributed: silently renormalising would concentrate canopy mass into
    // the surviving voxels and inflate the crown bulk density Van Wagner's threshold reads.
    const scale = stemMass / wSum
    clippedMass += stemMass * (1 - wInside / wSum)

    const sla = specificLeafArea(sp.form)
    const fmc = stem.foliarMoisture
    const boundFrac = Math.min(fmc, FIBRE_SATURATION)
    const freeFrac = Math.max(0, fmc - FIBRE_SATURATION)
    const s = idOf.get(stem.speciesId) ?? 0

    for (let q = 0; q < idx.length; q++) {
      const v = idx[q] as number
      const dm = (wts[q] as number) * scale
      if (dm > (mass[v] as number)) speciesIdx[v] = s
      mass[v] = (mass[v] as number) + dm
      leafArea[v] = (leafArea[v] as number) + dm * sla
      free[v] = (free[v] as number) + dm * freeFrac
      bound[v] = (bound[v] as number) + dm * boundFrac
      deposited += dm
    }
  }

  // Convert accumulated per-voxel masses to densities.
  const vol = grid.cellM ** 3
  const inv = 1 / vol
  for (let v = 0; v < n; v++) {
    mass[v] = (mass[v] as number) * inv
    leafArea[v] = (leafArea[v] as number) * inv
    free[v] = (free[v] as number) * inv
    bound[v] = (bound[v] as number) * inv
  }

  return {
    layout,
    dryDensity: mass,
    lad: leafArea,
    freeWater: free,
    boundWater: bound,
    speciesIdx,
    speciesIds,
    depositedMassKg: deposited,
    clippedMassKg: clippedMass,
  }
}

/** Build occupancy, layout and fields in one call. */
export function voxeliseVegetation(
  veg: IVegetationSet,
  terrain: TerrainHeights,
  grid: CanopyGrid = CANOPY_GRID,
  growthHeadroomFraction = 0,
): { readonly occupancy: VoxeliseResult; readonly layout: CanopyLayout; readonly fields: CanopyFields } {
  const ground = sampleGround(terrain, grid)
  const occupancy = voxeliseOccupancy(veg, ground, grid)
  const layout = buildLayout(occupancy.mask, growthHeadroomFraction)
  return { occupancy, layout, fields: voxeliseFields(veg, occupancy, layout) }
}
