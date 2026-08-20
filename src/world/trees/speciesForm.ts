/**
 * Growth-form parameters for procedural tree generation (WP 1.4, spec §7.5).
 *
 * These control *how* a skeleton is grown and how foliage elements are shaped. They do NOT
 * control how much foliage there is or where the crown starts — those come from the Stem's
 * physical fuel parameters (crownBaseM, crownRadiusM, crownBulkDensity) and nowhere else.
 * The split matters: everything in this file is appearance, everything in the Stem is fuel,
 * and the acceptance test in test/world/trees/derived.test.ts checks that the appearance
 * never contradicts the fuel.
 *
 * Specific leaf area and foliage-card coverage are engineering estimates (§0.7.3
 * `estimated`) and are registered as such below. They set the *size* of foliage cards; the
 * measurement pass in measure.ts divides by the same constants, so the derived-vs-declared
 * acceptance check is insensitive to them. What they do affect is how leafy a tree looks and
 * the leaf-area figure the M3 radiative transfer will consume, so they are flagged rather
 * than buried.
 */

import type { SpeciesDef } from '@contracts/world.ts'

/** Which skeleton-growing strategy a species uses. */
export type GrowthForm = 'conifer' | 'broadleaf' | 'shrub' | 'tuft'

export interface FormParams {
  readonly growth: GrowthForm

  // --- Crown envelope. g(t) is the crown radius at relative crown height t, as a fraction
  //     of the maximum crown radius. Piecewise: rises from gBase to 1 at tPeak, falls to
  //     gTop at the crown top. This IS the shape function s(z) of spec §7.5 step 2, with
  //     s(z) = g(t)^2 since s is defined on cross-sectional area.
  readonly tPeak: number
  readonly gBase: number
  readonly gTop: number
  readonly pLow: number
  readonly pHigh: number

  // --- Vertical foliage mass weighting w(t): a Beta(wAlpha, wBeta) density on [0,1].
  readonly wAlpha: number
  readonly wBeta: number

  // --- Space colonisation (Runions et al. 2007).
  /**
   * Growth step D, as a multiple of the mean node spacing implied by the node budget:
   * D = stepScale * (V_crown / maxSkeletonNodes)^(1/3).
   *
   * Deriving D from the crown *volume* rather than from its depth is not a detail. A
   * Douglas-fir crown is 16 m deep and 3.5 m across; a step set as a fraction of depth makes
   * the kill radius wider than the whole crown, every attractor dies against the bole on the
   * first pass, and the tree comes out as a bare pole with a handful of stubs. Scaling by the
   * cube root of volume per node makes the skeleton fill whatever shape the fuel parameters
   * describe, at whatever size, with roughly the node count it was budgeted.
   */
  readonly stepScale: number
  /** Radius of influence, in units of D. */
  readonly influenceSteps: number
  /** Kill distance, in units of D. Around 1 D: a node should clear roughly its own cell,
   *  not a sphere several steps wide, or the crown empties before it is filled. */
  readonly killSteps: number
  /** Attractors sampled over the crown volume. Spec §7.5 step 4 puts N_tot in [3000, 8000]. */
  readonly attractorCount: number
  /**
   * Hard cap on skeleton nodes. Space colonisation has no natural stopping size — it grows
   * until the attractors run out — and the node count is what sets the LOD-0 branch
   * triangle count and the per-mesh memory. Capping it here keeps the budget explicit
   * rather than emergent.
   */
  readonly maxSkeletonNodes: number
  /**
   * Foliage elements at LOD 0. Independent of `attractorCount`: attractors shape the
   * *skeleton*, foliage elements carry the *mass*, and both are drawn from the same target
   * field, so decoupling them costs nothing physically and buys a triangle budget knob.
   * Every element carries W_f / this, so total foliar mass is exact at any count.
   */
  readonly foliageElementsLod0: number
  /** Vertical tropism added to every growth direction (+ up, - droop). */
  readonly tropismY: number
  /** Outward (away from the trunk axis) bias on lateral branches. */
  readonly tropismRadial: number
  /** How strongly the leader keeps growing straight up. 1 = rigid spire, 0 = none. */
  readonly apicalDominance: number

  // --- Trunk / stem structure.
  /** Fraction of total height the primary axis reaches. Conifers ~1 (single leader to the
   *  apex), broadleaves fork below the crown top, shrubs have no trunk at all. */
  readonly leaderHeightFrac: number
  /** Number of basal stems. >1 means multi-stemmed (shrub). */
  readonly basalStems: number
  /** Vertical spacing of branch whorls, as a fraction of crown depth. 0 = not whorled
   *  (branches may leave the trunk anywhere). Conifers are strongly whorled. */
  readonly whorlSpacingFrac: number
  /** Branches per whorl (conifer) — sets how many lateral seeds each whorl offers. */
  readonly whorlBranches: number
  /** Trunk sinuosity, metres of lateral wander per metre of height. */
  readonly sinuosity: number

  // --- Foliage elements.
  /** Specific leaf area, m2/kg one-sided. ESTIMATED. */
  readonly specificLeafAreaM2PerKg: number
  /** Fraction of a foliage card's geometric area that is actually opaque leaf/needle in the
   *  alpha texture. Card area x coverage = leaf area. ESTIMATED. */
  readonly cardCoverage: number
  /** Aspect ratio (length:width) of a foliage card. Needle sprays are long and narrow. */
  readonly cardAspect: number
  /** Downward tilt of foliage cards, radians. Pendulous eucalypt foliage hangs. */
  readonly cardDroop: number

  // --- Bark.
  /** Whether this species carries shed-able bark strips as explicit geometry. */
  readonly hasBarkStrips: boolean
  /** Strips per metre of trunk height, where present. */
  readonly stripsPerMetre: number
  /** Strip width, metres. */
  readonly stripWidthM: number
  /** Strip length as a fraction of trunk length below the crown. */
  readonly stripLengthFrac: number
  /** Areal density of the bark strip, kg/m2 — the firebrand mass M3 will launch. */
  readonly stripArealDensityKgM2: number
}

const CONIFER: FormParams = {
  growth: 'conifer',
  tPeak: 0.08,
  gBase: 0.94,
  gTop: 0.02,
  pLow: 1.0,
  pHigh: 0.92,
  wAlpha: 2.0,
  wBeta: 2.6,
  stepScale: 1.0,
  influenceSteps: 5.0,
  killSteps: 1.1,
  attractorCount: 3200,
  maxSkeletonNodes: 750,
  foliageElementsLod0: 1250,
  tropismY: 0.1,
  tropismRadial: 0.55,
  apicalDominance: 0.9,
  leaderHeightFrac: 1.0,
  basalStems: 1,
  whorlSpacingFrac: 0.075,
  whorlBranches: 5,
  sinuosity: 0.008,
  specificLeafAreaM2PerKg: 6.0,
  cardCoverage: 0.45,
  cardAspect: 2.2,
  cardDroop: 0.25,
  hasBarkStrips: false,
  stripsPerMetre: 0,
  stripWidthM: 0,
  stripLengthFrac: 0,
  stripArealDensityKgM2: 0,
}

const BROADLEAF: FormParams = {
  growth: 'broadleaf',
  tPeak: 0.44,
  gBase: 0.6,
  gTop: 0.2,
  pLow: 0.7,
  pHigh: 0.62,
  wAlpha: 2.4,
  wBeta: 2.0,
  stepScale: 1.05,
  influenceSteps: 5.0,
  killSteps: 1.15,
  attractorCount: 3200,
  maxSkeletonNodes: 750,
  foliageElementsLod0: 1250,
  tropismY: -0.02,
  tropismRadial: 0.3,
  apicalDominance: 0.25,
  leaderHeightFrac: 0.62,
  basalStems: 1,
  whorlSpacingFrac: 0,
  whorlBranches: 0,
  sinuosity: 0.02,
  specificLeafAreaM2PerKg: 14.0,
  cardCoverage: 0.62,
  cardAspect: 1.3,
  cardDroop: 0.12,
  hasBarkStrips: false,
  stripsPerMetre: 0,
  stripWidthM: 0,
  stripLengthFrac: 0,
  stripArealDensityKgM2: 0,
}

const SHRUB: FormParams = {
  growth: 'shrub',
  tPeak: 0.3,
  gBase: 0.8,
  gTop: 0.14,
  pLow: 0.6,
  pHigh: 0.8,
  wAlpha: 1.9,
  wBeta: 2.1,
  stepScale: 1.05,
  influenceSteps: 4.5,
  killSteps: 1.15,
  attractorCount: 2600,
  maxSkeletonNodes: 600,
  foliageElementsLod0: 1050,
  tropismY: 0.06,
  tropismRadial: 0.5,
  apicalDominance: 0.05,
  leaderHeightFrac: 0.22,
  basalStems: 5,
  whorlSpacingFrac: 0,
  whorlBranches: 0,
  sinuosity: 0.05,
  specificLeafAreaM2PerKg: 5.0,
  cardCoverage: 0.5,
  cardAspect: 1.1,
  cardDroop: 0.05,
  hasBarkStrips: false,
  stripsPerMetre: 0,
  stripWidthM: 0,
  stripLengthFrac: 0,
  stripArealDensityKgM2: 0,
}

/** Grass tussocks and ferns: no woody skeleton worth speaking of, foliage from the base up.
 *  WP 1.5 draws the grass *sward* procedurally on the GPU; this exists so that a Stem whose
 *  species happens to be a grass or fern still yields a valid, mass-correct mesh rather than
 *  an exception. */
const TUFT: FormParams = {
  growth: 'tuft',
  tPeak: 0.12,
  gBase: 0.55,
  gTop: 0.35,
  pLow: 0.8,
  pHigh: 1.4,
  wAlpha: 1.5,
  wBeta: 2.2,
  stepScale: 1.25,
  influenceSteps: 4.0,
  killSteps: 1.2,
  attractorCount: 900,
  maxSkeletonNodes: 240,
  foliageElementsLod0: 480,
  tropismY: 0.5,
  tropismRadial: 0.4,
  apicalDominance: 0.0,
  leaderHeightFrac: 0.12,
  basalStems: 7,
  whorlSpacingFrac: 0,
  whorlBranches: 0,
  sinuosity: 0.08,
  specificLeafAreaM2PerKg: 20.0,
  cardCoverage: 0.4,
  cardAspect: 4.0,
  cardDroop: 0.35,
  hasBarkStrips: false,
  stripsPerMetre: 0,
  stripWidthM: 0,
  stripLengthFrac: 0,
  stripArealDensityKgM2: 0,
}

const BASE_BY_FORM: Record<SpeciesDef['form'], FormParams> = {
  conifer: CONIFER,
  broadleaf: BROADLEAF,
  shrub: SHRUB,
  grass: TUFT,
  fern: TUFT,
}

/**
 * Bark strip geometry, per §7.5. Shed bark is the dominant long-range firebrand source in
 * eucalypt forest, so it is real geometry on its own submesh rather than a texture — the M3
 * brand emitter samples the strips directly.
 *
 * NOTE on morphology: spec §7.5 models *E. obliqua / marginata*, which carry persistent
 * fibrous stringybark shed as long flat strips; true decorticating ribbons are the signature
 * of the smooth-barked gums. Both map to the same 'ribbon' material slot in the contract, so
 * both are emitted here; the strip dimensions differ, because the shed dynamics and brand
 * geometry differ.
 */
function applyBark(base: FormParams, species: SpeciesDef): FormParams {
  switch (species.bark) {
    case 'decorticating-ribbon':
      // Long, narrow, curling ribbons from the smooth upper trunk.
      return {
        ...base,
        hasBarkStrips: true,
        stripsPerMetre: 2.6,
        stripWidthM: 0.075,
        stripLengthFrac: 0.42,
        stripArealDensityKgM2: 0.42,
      }
    case 'fibrous':
      // Stringybark: shorter, wider, flatter strips, heavier per unit area.
      return {
        ...base,
        hasBarkStrips: true,
        stripsPerMetre: 2.0,
        stripWidthM: 0.13,
        stripLengthFrac: 0.3,
        stripArealDensityKgM2: 0.85,
      }
    case 'papery':
      return {
        ...base,
        hasBarkStrips: true,
        stripsPerMetre: 3.2,
        stripWidthM: 0.11,
        stripLengthFrac: 0.16,
        stripArealDensityKgM2: 0.2,
      }
    default:
      return base
  }
}

/**
 * Derive the growth-form parameters for a species. Deterministic and cheap; call it once
 * per species and keep the result.
 */
export function formParamsFor(species: SpeciesDef): FormParams {
  const base = BASE_BY_FORM[species.form]
  let p = applyBark(base, species)

  // Pendulous eucalypt foliage: a recognisable silhouette, and it changes how the crown
  // presents fuel to a fire front, so it is worth having.
  if (species.bark === 'decorticating-ribbon' || species.bark === 'fibrous') {
    p = { ...p, cardDroop: p.cardDroop + 0.55, cardAspect: p.cardAspect * 1.4, gTop: 0.34, tPeak: 0.3 }
  }
  return p
}

