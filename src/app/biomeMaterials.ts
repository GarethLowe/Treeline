/**
 * The material-naming bridge between WP 1.3, WP 1.5 and WP 1.6.
 *
 * THIS FILE EXISTS BECAUSE OF A CONTRACT GAP, and the gap is worth stating rather than
 * papering over:
 *
 *  - `BiomeParams.groundMaterials` (contract `@contracts/world`) is declared as
 *    `readonly string[]` with the comment "ground material identifiers for the splat system".
 *    The contract never fixes the vocabulary. WP 1.3 filled it with ecological names
 *    (`'needle-duff'`, `'granite-scree'`, …); WP 1.6 shipped a fixed twelve-entry
 *    `MATERIAL_IDS` table (`'ground-duff'`, `'ground-rock'`, …) and a
 *    `resolveGroundMaterials()` that **throws** on an unknown id rather than substituting.
 *    Both did the right thing given the contract; the contract was under-specified.
 *
 *  - `MaterialIdMap` in WP 1.5 has the same shape of gap. Its `DEFAULT_MATERIAL_IDS` is
 *    `{ bark: 'bark', foliage: 'foliage', … }`, none of which exists in WP 1.6's table, and
 *    `buildFoliageScene` resolves an unknown id to material slot 0 *silently*. Left alone,
 *    every tree in the world would have been shaded with whatever material happens to sort
 *    first. That is the quiet failure mode this file removes.
 *
 * So the composition layer owns the translation, which is where a naming decision between
 * two frozen packages belongs. WP 1.6's per-biome `defaultGroundMaterials()` already encodes
 * the same ecological intent as WP 1.3's names, so the ground mapping delegates to it and the
 * table below records the correspondence for the reader.
 *
 * Pure module — no GPU, no DOM.
 */

import type { BiomeId } from '@contracts/world.ts'
import type { MaterialIdMap } from '@render/foliage/sceneBuild.ts'
import { defaultGroundMaterials, MATERIAL_IDS, type MaterialId } from '@render/materials/library.ts'

/**
 * WP 1.3's ecological ground names, in `GROUND_SLOT` order (mesic, litter, xeric, rock),
 * against the WP 1.6 material they resolve to.
 *
 * Kept as data rather than as a comment so `test/app/biomeMaterials.test.ts` can assert that
 * every name WP 1.3 emits has a translation and every translation names a real material. If
 * WP 1.3 renames a ground type, the test fails instead of the browser rendering mud.
 */
export const GROUND_NAME_TRANSLATION: Readonly<Record<string, MaterialId>> = {
  // western-us-conifer
  'needle-duff': 'ground-duff',
  'granite-scree': 'litter-needle',
  'dry-bunchgrass': 'ground-soil',
  'bare-mineral-soil': 'ground-rock',
  // grassland-savanna
  'tallgrass-thatch': 'ground-soil',
  'cured-grass': 'litter-broadleaf',
  'dark-prairie-soil': 'ground-soil',
  gravel: 'ground-rock',
  // mediterranean-chaparral
  'shrub-litter': 'ground-soil',
  'weathered-sandstone': 'litter-broadleaf',
  'bare-clay': 'ground-soil',
  talus: 'ground-rock',
  // eucalypt-dry-forest
  'eucalypt-leaf-bark-litter': 'ground-duff',
  'lateritic-gravel': 'litter-broadleaf',
  'bracken-mat': 'ground-soil',
  ironstone: 'ground-rock',
  // uk-mixed-field-forest
  'improved-pasture': 'ground-duff',
  'broadleaf-leaf-litter': 'litter-broadleaf',
  'moor-peat': 'ground-soil',
  'chalk-soil': 'ground-rock',
}

const KNOWN_MATERIALS: ReadonlySet<string> = new Set<string>(MATERIAL_IDS)

/**
 * Ground materials for a biome, in `GROUND_SLOT` order, guaranteed to be ids WP 1.6 knows.
 *
 * `biomeGroundNames` is what `BiomeParams.groundMaterials` actually said. When every one of
 * them translates, the translation is used — that keeps WP 1.3's intent. Otherwise WP 1.6's
 * own per-biome default is used and the caller is told, because a *plausible but wrong*
 * ground material is invisible in review and permanent in the build.
 */
export function resolveGroundMaterialIds(
  biome: BiomeId,
  biomeGroundNames: readonly string[],
): { readonly ids: readonly MaterialId[]; readonly warning: string | null } {
  const translated: MaterialId[] = []
  const untranslated: string[] = []
  for (const name of biomeGroundNames) {
    const direct = KNOWN_MATERIALS.has(name) ? (name as MaterialId) : undefined
    const mapped = direct ?? GROUND_NAME_TRANSLATION[name]
    if (mapped === undefined) untranslated.push(name)
    else translated.push(mapped)
  }
  if (untranslated.length === 0 && translated.length >= 4) {
    return { ids: translated, warning: null }
  }
  return {
    ids: defaultGroundMaterials(biome),
    warning:
      `biome '${biome}' names ground materials WP 1.6 does not define ` +
      `(${untranslated.join(', ')}); fell back to defaultGroundMaterials('${biome}').`,
  }
}

/**
 * Which WP 1.6 material each tree submesh tag maps to, per biome.
 *
 * `TreeLod.submeshes[].material` is one of 'bark' | 'foliage' | 'ribbon'. That is a *class*,
 * not an id, so the mapping is per biome: a ponderosa's bark is furrowed conifer bark and a
 * stringybark's is decorticating ribbon, and both arrive tagged 'bark'.
 */
export function foliageMaterialIds(biome: BiomeId): MaterialIdMap {
  switch (biome) {
    case 'western-us-conifer':
      return { bark: 'bark-conifer-furrowed', foliage: 'foliage-needle', ribbon: 'bark-eucalypt-ribbon', grass: 'grass-blade' }
    case 'grassland-savanna':
      return { bark: 'bark-broadleaf-smooth', foliage: 'foliage-broadleaf', ribbon: 'bark-eucalypt-ribbon', grass: 'grass-blade' }
    case 'mediterranean-chaparral':
      return { bark: 'bark-broadleaf-smooth', foliage: 'foliage-sclerophyll', ribbon: 'bark-eucalypt-ribbon', grass: 'grass-blade' }
    case 'eucalypt-dry-forest':
      return { bark: 'bark-eucalypt-ribbon', foliage: 'foliage-sclerophyll', ribbon: 'bark-eucalypt-ribbon', grass: 'grass-blade' }
    case 'uk-mixed-field-forest':
      return { bark: 'bark-broadleaf-smooth', foliage: 'foliage-broadleaf', ribbon: 'bark-eucalypt-ribbon', grass: 'grass-blade' }
  }
}
