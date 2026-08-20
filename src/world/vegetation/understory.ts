/**
 * The understory / near-surface layer.
 *
 * Grass and fern species are not instantiated as individual stems — at 1 km² there would be
 * tens of millions of them, WP 1.5 renders them as a GPU grass field, and the fire model
 * consumes them as a continuous layer rather than as objects. They are represented here as a
 * per-cell cover fraction and top height.
 *
 * This layer is not decoration. It does three jobs:
 *
 *  1. **It is what `hasLadderFuels` is measured against.** A vertical gap between the
 *     understory top and the crown base is the thing that decides torching at M3, so the
 *     understory has to have a real height before that test means anything.
 *  2. **It is the eucalypt biome's `H_ns`.** §60 §7.1.2 warns that Vesta is strongly sensitive
 *     to near-surface fuel height — doubling it multiplies the wind-driven term by 1.55 — and
 *     that "our procedural understorey generator must emit `H_ns` and both FHS fields as
 *     first-class per-cell fields, not derive them from a single fuel load scalar".
 *     `nearSurfaceHeightCm` is that field, in the centimetres Vesta wants.
 *  3. **It carries the shade response.** Cover falls under a closed canopy, which is why an
 *     open savanna carries continuous grass and a closed beech wood carries almost none —
 *     and, per §60 §7.3.3, why in-leaf British broadleaf woodland should suppress fire.
 *
 * Canopy closure uses the random-overlapping-disc gap fraction, `closure = 1 − e^(−A)` with A
 * the crown area per unit ground area. That is the Poisson gap model, the same form as the
 * Beer–Lambert extinction §30 §7.3 uses for leaf area, and it beats clamping summed crown
 * areas at 1 because it never saturates artificially and it conserves crown area exactly.
 */

import type { SpeciesDef, Stem, VegetationParams } from '@contracts/world'
import type { Metres } from '@contracts/units'
import { clamp01, lerp } from '../../math.ts'
import type { SiteField } from './site.ts'

const f64 = (a: Float64Array, i: number): number => a[i] as number

/** Fraction of the open-ground cover that survives under a fully closed canopy. */
const SHADE_SURVIVAL = 0.15

export class UnderstoryField {
  readonly cols: number
  readonly cellSizeM: number
  readonly sizeM: number
  /** 0..1 cover fraction per cell, after shade suppression. */
  readonly cover: Float64Array
  /** Top of the understory layer above ground, metres, per cell. */
  readonly topHeightM: Float64Array
  /** 0..1 canopy closure per cell, from the crown-disc gap model. */
  readonly canopyClosure: Float64Array
  readonly coverSpecies: readonly SpeciesDef[]

  constructor(
    site: SiteField,
    vegetation: VegetationParams,
    coverSpecies: readonly SpeciesDef[],
    stems: readonly Stem[],
  ) {
    this.cols = site.cols
    this.cellSizeM = site.sizeM / site.cols
    this.sizeM = site.sizeM
    this.coverSpecies = coverSpecies
    const cells = site.cellCount
    this.cover = new Float64Array(cells)
    this.topHeightM = new Float64Array(cells)
    this.canopyClosure = new Float64Array(cells)

    // --- Canopy closure: accumulate crown area per cell, conserving total area.
    const cellArea = this.cellSizeM * this.cellSizeM
    const areaSum = new Float64Array(cells)
    const n = this.cols
    for (const st of stems) {
      const r = st.crownRadiusM
      const crownArea = Math.PI * r * r
      const i0 = Math.max(0, Math.floor((st.x - r) / this.cellSizeM))
      const i1 = Math.min(n - 1, Math.floor((st.x + r) / this.cellSizeM))
      const j0 = Math.max(0, Math.floor((st.z - r) / this.cellSizeM))
      const j1 = Math.min(n - 1, Math.floor((st.z + r) / this.cellSizeM))
      let hits = 0
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * this.cellSizeM
          const cz = (j + 0.5) * this.cellSizeM
          const dx = cx - st.x
          const dz = cz - st.z
          if (dx * dx + dz * dz <= r * r) hits++
        }
      }
      if (hits === 0) {
        // Crown smaller than a cell: all of its area lands in the cell it stands in.
        const c = site.cellIndexAt(st.x, st.z)
        areaSum[c] = f64(areaSum, c) + crownArea
        continue
      }
      const share = crownArea / hits
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * this.cellSizeM
          const cz = (j + 0.5) * this.cellSizeM
          const dx = cx - st.x
          const dz = cz - st.z
          if (dx * dx + dz * dz <= r * r) {
            const c = j * n + i
            areaSum[c] = f64(areaSum, c) + share
          }
        }
      }
    }

    // --- Cover species mix. Weights come from the same speciesMix as the stems; cover
    // species simply never enter the stem draw.
    const weights = coverSpecies.map((sp) => vegetation.speciesMix[sp.id] ?? 0)
    const weightTotal = weights.reduce((a, b) => a + b, 0)

    for (let c = 0; c < cells; c++) {
      const closure = 1 - Math.exp(-f64(areaSum, c) / cellArea)
      this.canopyClosure[c] = closure
      const cond = site.conditionsAtCell(c)
      // Moist sites carry more cover; shade removes most of it but never all of it.
      const openCover = clamp01(vegetation.understoryCover * (1 + 0.25 * cond.moisture))
      const cover = openCover * (SHADE_SURVIVAL + (1 - SHADE_SURVIVAL) * (1 - closure))
      this.cover[c] = cover

      if (weightTotal <= 0) {
        this.topHeightM[c] = 0
        continue
      }
      // Height within each cover species' declared range, shifted by site moisture. Cover
      // species are grass and fern: their "height range" IS their seasonal/site range, so this
      // is an interpolation inside cited bounds, not an extrapolation.
      let h = 0
      for (let i = 0; i < coverSpecies.length; i++) {
        const sp = coverSpecies[i]
        if (sp === undefined) continue
        const t = clamp01(0.5 + 0.35 * cond.moisture)
        h += (weights[i] ?? 0) * lerp(sp.heightM[0], sp.heightM[1], t)
      }
      this.topHeightM[c] = h / weightTotal
    }
  }

  private cellAt(x: number, z: number): number {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSizeM)))
    const j = Math.min(this.cols - 1, Math.max(0, Math.floor(z / this.cellSizeM)))
    return j * this.cols + i
  }

  coverAt(x: Metres, z: Metres): number {
    return f64(this.cover, this.cellAt(x, z))
  }

  topHeightAt(x: Metres, z: Metres): number {
    return f64(this.topHeightM, this.cellAt(x, z))
  }

  canopyClosureAt(x: Metres, z: Metres): number {
    return f64(this.canopyClosure, this.cellAt(x, z))
  }

  /**
   * Near-surface fuel height in **centimetres** — the units Project Vesta's `H_ns` term takes
   * (§60 §7.1.2, validated range 5–40 cm). Exposed in the source units on purpose: a metres
   * value silently fed to Vesta would under-predict the wind term by a factor of 100^0.6366,
   * which is roughly 18×, and would look merely "a bit slow" rather than obviously broken.
   */
  nearSurfaceHeightCm(x: Metres, z: Metres): number {
    return this.topHeightAt(x, z) * 100
  }

  /** Mean cover over the domain. Diagnostic, and what the tests assert against. */
  meanCover(): number {
    let sum = 0
    for (let i = 0; i < this.cover.length; i++) sum += f64(this.cover, i)
    return sum / this.cover.length
  }

  meanCanopyClosure(): number {
    let sum = 0
    for (let i = 0; i < this.canopyClosure.length; i++) sum += f64(this.canopyClosure, i)
    return sum / this.canopyClosure.length
  }
}
