/**
 * The material catalogue. WP 1.6.
 *
 * One place that says: which materials exist, what array layers each occupies, and what
 * procedural recipe synthesises it. Everything downstream — the GPU generator, the CPU
 * oracle, the splat system, the shader-side material table — reads this and only this.
 *
 * **Layer packing rule.** A burnable material occupies FOUR consecutive array layers
 * (green, scorch, char, ash — spec §7.6); a non-burnable material occupies one. `layer` in
 * `MaterialDef` is the BASE layer of the run, and the shader adds `floor(b)` to it, where
 * `b` is the burn coordinate. Consecutive-run packing is what makes the burn blend two
 * fetches from one array rather than a bind-group swap per burn state.
 *
 * **Seeds are derived from the id string**, not hand-assigned. Two consequences that matter:
 * adding a material never perturbs another material's appearance (which hand-assigned
 * incrementing seeds would do), and the whole set is reproducible from this file alone.
 *
 * The albedo/roughness figures here are authored appearance values, not measured physical
 * data, and they are not claimed otherwise. The exception is the burn-stage colour targets in
 * `patterns.ts` (`BURN_TARGETS`), which come from spec §7.6 and are asserted by the tests —
 * because those are what M4's whole burn visual is anchored to.
 */

import type { MaterialDef } from '@contracts/render.ts'
import { hashU32 } from './noise.ts'
import { BURN_LAYER_COUNT, PATTERN, patternDetailMean, type PatternParams } from './patterns.ts'

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * The canonical material id vocabulary.
 *
 * NOTE for integration: `BiomeParams.groundMaterials` (contract, WP 1.3) is
 * `readonly string[]` with no declared vocabulary, so these strings are the de facto
 * contract between WP 1.3 and WP 1.6. `defaultGroundMaterials()` below supplies a valid set
 * per biome; if WP 1.3 emits something else, `resolveGroundMaterials()` throws with the list
 * rather than silently substituting, because a silently wrong ground material is exactly the
 * class of error that survives to release looking like an art choice.
 */
export const MATERIAL_IDS = [
  'bark-conifer-furrowed',
  'bark-broadleaf-smooth',
  'bark-eucalypt-ribbon',
  'foliage-needle',
  'foliage-broadleaf',
  'foliage-sclerophyll',
  'grass-blade',
  'litter-needle',
  'litter-broadleaf',
  'ground-duff',
  'ground-soil',
  'ground-rock',
] as const

export type MaterialId = (typeof MATERIAL_IDS)[number]

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

/** A material as authored here: its shading constants plus its procedural recipe. */
export interface MaterialRecipe {
  readonly id: MaterialId
  readonly baseColorFactor: readonly [number, number, number]
  readonly roughnessFactor: number
  readonly metallicFactor: number
  readonly alphaTest: boolean
  readonly doubleSided: boolean
  readonly burnable: boolean
  /** Alpha below this is discarded. Only meaningful when `alphaTest`. */
  readonly alphaCutoff: number
  /**
   * The procedural recipe, minus the two derived fields: `seed` comes from the id, and
   * `detailMean` is measured from the pattern itself by `packMaterials`.
   */
  readonly pattern: Omit<PatternParams, 'seed' | 'detailMean'>
}

/** Deterministic per-material seed. Stable under insertion, reordering and renaming siblings. */
export function seedForId(id: string): number {
  let h = 0x9e3779b1
  for (let i = 0; i < id.length; i++) {
    h = hashU32((h ^ id.charCodeAt(i)) >>> 0)
  }
  return h >>> 0
}

const NO_METAL = 0

/**
 * Recipes. Ordering here fixes layer assignment, so it is stable on purpose: reordering this
 * array re-numbers every layer index and invalidates anything that cached one.
 */
export const MATERIAL_RECIPES: readonly MaterialRecipe[] = [
  {
    id: 'bark-conifer-furrowed',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Bark,
      tileSizeM: 0.6,
      // Fewer cells along v than u makes the plates taller than they are wide, which is what
      // a trunk's bark actually does. Expressed as unequal lattice periods so it still tiles.
      periodU: 7,
      periodV: 3,
      reliefM: 0.018,
      plateiness: 0.75,
      baseAlbedo: [0.1, 0.062, 0.035],
      deepAlbedo: [0.028, 0.018, 0.012],
      baseRoughness: 0.88,
      roughnessVariation: 0.08,
      metallic: NO_METAL,
      cellsU: 1,
      cellsV: 1,
      elementWidth: 0,
      elementLength: 0,
      tipSharpness: 1,
      grainPeriod: 64,
      // Bark is already brown, so the scorch stage barely moves it; char and ash do.
      burnResponse: [0.55, 0.9, 0.7],
    },
  },
  {
    id: 'bark-broadleaf-smooth',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Bark,
      tileSizeM: 0.7,
      periodU: 5,
      periodV: 4,
      reliefM: 0.005,
      plateiness: 0.15,
      baseAlbedo: [0.13, 0.125, 0.115],
      deepAlbedo: [0.055, 0.05, 0.045],
      baseRoughness: 0.72,
      roughnessVariation: 0.12,
      metallic: NO_METAL,
      cellsU: 1,
      cellsV: 1,
      elementWidth: 0,
      elementLength: 0,
      tipSharpness: 1,
      grainPeriod: 96,
      burnResponse: [0.7, 0.95, 0.7],
    },
  },
  {
    id: 'bark-eucalypt-ribbon',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Bark,
      tileSizeM: 0.8,
      // Strongly elongated cells: decorticating ribbon bark peels in long vertical strips.
      // Not decoration — this is the largest firebrand source in the whole simulation (§30),
      // so the material has to read as ribbons for the picture to match the physics.
      periodU: 4,
      periodV: 2,
      reliefM: 0.012,
      plateiness: 0.3,
      baseAlbedo: [0.2, 0.175, 0.15],
      deepAlbedo: [0.07, 0.055, 0.045],
      baseRoughness: 0.8,
      roughnessVariation: 0.14,
      metallic: NO_METAL,
      cellsU: 1,
      cellsV: 1,
      elementWidth: 0,
      elementLength: 0,
      tipSharpness: 1,
      grainPeriod: 48,
      burnResponse: [0.65, 0.95, 0.8],
    },
  },
  {
    id: 'foliage-needle',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: true,
    doubleSided: true,
    burnable: true,
    alphaCutoff: 0.4,
    pattern: {
      kind: PATTERN.FoliageAtlas,
      tileSizeM: 0.25,
      periodU: 8,
      periodV: 8,
      reliefM: 0.0006,
      plateiness: 0,
      baseAlbedo: [0.09, 0.16, 0.05],
      deepAlbedo: [0.045, 0.085, 0.028],
      // Waxy cuticle: conifer needles have a real specular lobe, which is why a lit crown
      // rim-lights instead of reading as flat green cardboard.
      baseRoughness: 0.45,
      roughnessVariation: 0.14,
      metallic: NO_METAL,
      cellsU: 8,
      cellsV: 8,
      elementWidth: 0.045,
      elementLength: 0.46,
      tipSharpness: 3,
      grainPeriod: 128,
      burnResponse: [1, 1, 1],
    },
  },
  {
    id: 'foliage-broadleaf',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: true,
    doubleSided: true,
    burnable: true,
    alphaCutoff: 0.4,
    pattern: {
      kind: PATTERN.FoliageAtlas,
      tileSizeM: 0.3,
      periodU: 4,
      periodV: 4,
      reliefM: 0.0009,
      plateiness: 0,
      baseAlbedo: [0.1, 0.19, 0.055],
      deepAlbedo: [0.05, 0.1, 0.03],
      baseRoughness: 0.5,
      roughnessVariation: 0.16,
      metallic: NO_METAL,
      cellsU: 4,
      cellsV: 4,
      elementWidth: 0.2,
      elementLength: 0.42,
      tipSharpness: 1.2,
      grainPeriod: 96,
      burnResponse: [1, 1, 1],
    },
  },
  {
    id: 'foliage-sclerophyll',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: true,
    doubleSided: true,
    burnable: true,
    alphaCutoff: 0.4,
    pattern: {
      kind: PATTERN.FoliageAtlas,
      tileSizeM: 0.22,
      periodU: 6,
      periodV: 6,
      reliefM: 0.0008,
      plateiness: 0,
      // Grey-green and waxy: chaparral and eucalypt foliage, not temperate leaf green.
      baseAlbedo: [0.095, 0.13, 0.065],
      deepAlbedo: [0.05, 0.07, 0.035],
      baseRoughness: 0.38,
      roughnessVariation: 0.12,
      metallic: NO_METAL,
      cellsU: 6,
      cellsV: 6,
      elementWidth: 0.1,
      elementLength: 0.44,
      tipSharpness: 2,
      grainPeriod: 112,
      burnResponse: [1, 1, 1],
    },
  },
  {
    id: 'grass-blade',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: true,
    doubleSided: true,
    burnable: true,
    alphaCutoff: 0.35,
    pattern: {
      kind: PATTERN.Grass,
      tileSizeM: 0.15,
      periodU: 12,
      periodV: 1,
      reliefM: 0.0004,
      plateiness: 0,
      // Tip is cured (straw), base is green. The gradient IS the curing state at M5.
      baseAlbedo: [0.16, 0.16, 0.07],
      deepAlbedo: [0.06, 0.11, 0.035],
      baseRoughness: 0.5,
      roughnessVariation: 0.18,
      metallic: NO_METAL,
      cellsU: 12,
      cellsV: 1,
      elementWidth: 0.035,
      elementLength: 0.5,
      tipSharpness: 2,
      grainPeriod: 64,
      burnResponse: [1, 1, 1],
    },
  },
  {
    id: 'litter-needle',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Litter,
      tileSizeM: 1.2,
      periodU: 10,
      periodV: 10,
      reliefM: 0.012,
      plateiness: 0,
      baseAlbedo: [0.075, 0.045, 0.022],
      deepAlbedo: [0.03, 0.02, 0.012],
      baseRoughness: 0.87,
      roughnessVariation: 0.1,
      metallic: NO_METAL,
      cellsU: 10,
      cellsV: 10,
      elementWidth: 0.05,
      elementLength: 0.45,
      tipSharpness: 3,
      grainPeriod: 128,
      burnResponse: [0.8, 0.95, 0.9],
    },
  },
  {
    id: 'litter-broadleaf',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Litter,
      tileSizeM: 1.4,
      periodU: 5,
      periodV: 5,
      reliefM: 0.014,
      plateiness: 0,
      baseAlbedo: [0.09, 0.062, 0.03],
      deepAlbedo: [0.035, 0.025, 0.015],
      baseRoughness: 0.85,
      roughnessVariation: 0.12,
      metallic: NO_METAL,
      cellsU: 5,
      cellsV: 5,
      elementWidth: 0.22,
      elementLength: 0.4,
      tipSharpness: 1.2,
      grainPeriod: 96,
      burnResponse: [0.8, 0.95, 0.9],
    },
  },
  {
    id: 'ground-duff',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Granular,
      tileSizeM: 1.5,
      periodU: 24,
      periodV: 24,
      reliefM: 0.006,
      plateiness: 0,
      baseAlbedo: [0.045, 0.033, 0.022],
      deepAlbedo: [0.022, 0.016, 0.011],
      baseRoughness: 0.95,
      roughnessVariation: 0.06,
      metallic: NO_METAL,
      cellsU: 1,
      cellsV: 1,
      elementWidth: 0,
      elementLength: 0,
      tipSharpness: 1,
      grainPeriod: 128,
      // Duff smoulders down to ash more completely than anything else in the set.
      burnResponse: [0.7, 0.9, 0.95],
    },
  },
  {
    id: 'ground-soil',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    burnable: true,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Granular,
      tileSizeM: 2,
      periodU: 16,
      periodV: 16,
      reliefM: 0.004,
      plateiness: 0,
      baseAlbedo: [0.14, 0.105, 0.07],
      deepAlbedo: [0.07, 0.05, 0.033],
      baseRoughness: 0.92,
      roughnessVariation: 0.08,
      metallic: NO_METAL,
      cellsU: 1,
      cellsV: 1,
      elementWidth: 0,
      elementLength: 0,
      tipSharpness: 1,
      grainPeriod: 96,
      // Mineral soil does not char, but ash falls on it, so the ash stage still applies.
      burnResponse: [0.35, 0.6, 0.85],
    },
  },
  {
    id: 'ground-rock',
    baseColorFactor: [1, 1, 1],
    roughnessFactor: 1,
    metallicFactor: NO_METAL,
    alphaTest: false,
    doubleSided: false,
    // Rock is the one material with a single layer. It is also the reason the packer has to
    // handle variable run lengths rather than assuming a stride of four.
    burnable: false,
    alphaCutoff: 0,
    pattern: {
      kind: PATTERN.Rock,
      tileSizeM: 2.5,
      periodU: 6,
      periodV: 6,
      reliefM: 0.05,
      plateiness: 0,
      baseAlbedo: [0.13, 0.128, 0.125],
      deepAlbedo: [0.055, 0.054, 0.052],
      baseRoughness: 0.7,
      roughnessVariation: 0.18,
      metallic: NO_METAL,
      cellsU: 1,
      cellsV: 1,
      elementWidth: 0,
      elementLength: 0,
      tipSharpness: 1,
      grainPeriod: 64,
      burnResponse: [0, 0, 0],
    },
  },
]

// ---------------------------------------------------------------------------
// Layer assignment
// ---------------------------------------------------------------------------

/** One material's slot in the packed arrays, plus the recipe for every layer it owns. */
export interface PackedMaterial {
  readonly def: MaterialDef
  readonly recipe: MaterialRecipe
  /** Base layer index; equal to `def.layer`. */
  readonly baseLayer: number
  /** 4 for burnable, 1 otherwise. */
  readonly layerCount: number
  /** Fully-resolved pattern params (seed filled in), one entry per owned layer. */
  readonly params: PatternParams
}

export interface MaterialPacking {
  readonly materials: readonly PackedMaterial[]
  readonly byId: ReadonlyMap<string, PackedMaterial>
  readonly totalLayers: number
  /** `layerOwners[i]` is the material occupying array layer `i`, plus which burn stage it is. */
  readonly layerOwners: readonly { readonly id: MaterialId; readonly stage: number }[]
}

/**
 * Assign consecutive array layers to every recipe.
 *
 * The invariant the tests assert: layers are contiguous, start at 0, and every layer has
 * exactly one owner. A gap here is not a crash — it is a layer of undefined texels that some
 * material samples on some burn state, which is precisely the kind of bug that shows up once
 * in a hundred frames and gets blamed on the sim.
 */
export function packMaterials(recipes: readonly MaterialRecipe[] = MATERIAL_RECIPES): MaterialPacking {
  const materials: PackedMaterial[] = []
  const byId = new Map<string, PackedMaterial>()
  const layerOwners: { id: MaterialId; stage: number }[] = []
  let next = 0

  for (const recipe of recipes) {
    if (byId.has(recipe.id)) throw new Error(`duplicate material id: ${recipe.id}`)
    const layerCount = recipe.burnable ? BURN_LAYER_COUNT : 1
    const baseLayer = next
    const def: MaterialDef = {
      id: recipe.id,
      layer: baseLayer,
      baseColorFactor: recipe.baseColorFactor,
      roughnessFactor: recipe.roughnessFactor,
      metallicFactor: recipe.metallicFactor,
      alphaTest: recipe.alphaTest,
      doubleSided: recipe.doubleSided,
      burnable: recipe.burnable,
    }
    const withSeed = { ...recipe.pattern, seed: seedForId(recipe.id) }
    const packed: PackedMaterial = {
      def,
      recipe,
      baseLayer,
      layerCount,
      params: { ...withSeed, detailMean: patternDetailMean(withSeed) },
    }
    materials.push(packed)
    byId.set(recipe.id, packed)
    for (let stage = 0; stage < layerCount; stage++) {
      layerOwners.push({ id: recipe.id, stage })
    }
    next += layerCount
  }

  return { materials, byId, totalLayers: next, layerOwners }
}

// ---------------------------------------------------------------------------
// Ground materials per biome (input to the splat system)
// ---------------------------------------------------------------------------

/**
 * The four ground slots, in the order `BiomeParams.groundMaterials` must supply them.
 *
 * This ordering IS the meaning of that array. The contract describes it only as "by
 * slope/aspect band", which is not enough to write a splat function against, so the
 * convention is fixed here and asserted by the tests.
 */
export const GROUND_SLOT = {
  /** Shallow, shaded, moist ground. The default that shows through everywhere else. */
  Mesic: 0,
  /** Litter. Accumulates in drainages and on shallow ground; washes off steep ground. */
  Litter: 1,
  /** Dry, sun-exposed ground. Ridges and equator-facing aspects. */
  Xeric: 2,
  /** Bare rock. Exposed by slope, and by slope alone. */
  Rock: 3,
} as const

export const GROUND_SLOT_COUNT = 4

/** Biome ids, duplicated locally only as a key type. Values come from the contract. */
type BiomeKey =
  | 'western-us-conifer'
  | 'grassland-savanna'
  | 'mediterranean-chaparral'
  | 'eucalypt-dry-forest'
  | 'uk-mixed-field-forest'

const GROUND_BY_BIOME: Readonly<Record<BiomeKey, readonly [MaterialId, MaterialId, MaterialId, MaterialId]>> = {
  // Deep needle duff under closed canopy; needle litter in the draws; decomposed granite on
  // the sunny ridges; granite where it is too steep to hold anything.
  'western-us-conifer': ['ground-duff', 'litter-needle', 'ground-soil', 'ground-rock'],
  // Almost no duff layer: grassland ground is mineral soil with a thin thatch.
  'grassland-savanna': ['ground-soil', 'litter-broadleaf', 'ground-soil', 'ground-rock'],
  // Chaparral sheds a sparse sclerophyll litter and sits on thin, rocky soil.
  'mediterranean-chaparral': ['ground-soil', 'litter-broadleaf', 'ground-rock', 'ground-rock'],
  // Eucalypt: heavy bark-and-leaf litter, which is why these forests carry so much fine fuel.
  'eucalypt-dry-forest': ['ground-duff', 'litter-broadleaf', 'ground-soil', 'ground-rock'],
  // UK: wet, organic, and rarely bare.
  'uk-mixed-field-forest': ['ground-duff', 'litter-broadleaf', 'ground-soil', 'ground-rock'],
}

/** The ground material set this package expects for a biome. Wire into `BiomeParams`. */
export function defaultGroundMaterials(biome: string): readonly MaterialId[] {
  const set = GROUND_BY_BIOME[biome as BiomeKey]
  if (!set) {
    throw new Error(
      `no default ground materials for biome '${biome}'; known: ${Object.keys(GROUND_BY_BIOME).join(', ')}`,
    )
  }
  return set
}

/**
 * Turn `BiomeParams.groundMaterials` into base layer indices, one per ground slot.
 *
 * Throws on an unknown id rather than substituting a default. A wrong-but-plausible ground
 * material is invisible in review and permanent in the build.
 */
export function resolveGroundMaterials(
  packing: MaterialPacking,
  groundMaterials: readonly string[],
): readonly [number, number, number, number] {
  if (groundMaterials.length < GROUND_SLOT_COUNT) {
    throw new Error(
      `groundMaterials needs ${GROUND_SLOT_COUNT} entries ` +
        `(mesic, litter, xeric, rock); got ${groundMaterials.length}`,
    )
  }
  const out: number[] = []
  for (let i = 0; i < GROUND_SLOT_COUNT; i++) {
    const id = groundMaterials[i] as string
    const m = packing.byId.get(id)
    if (!m) {
      throw new Error(`unknown ground material '${id}'; known ids: ${MATERIAL_IDS.join(', ')}`)
    }
    out.push(m.baseLayer)
  }
  return out as unknown as readonly [number, number, number, number]
}
