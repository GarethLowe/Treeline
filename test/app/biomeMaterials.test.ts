/**
 * Every material id a biome asks for must exist in the material library.
 *
 * This exists because it did not, and the failure was silent: `grassMaterialLayer()` looked
 * up a literal `'grass'`, no biome has ever used that id, and the unresolved lookup fell back
 * to slot 0 — conifer bark — so grass rendered blue-violet for months. A miss is survivable
 * by construction, which is exactly why it needs a test rather than a runtime guard alone.
 */

import { describe, expect, it } from 'vitest'
import { BIOME_IDS } from '@contracts/world'
import { MATERIAL_IDS } from '@render/materials/library.ts'
import { GROUND_SLOT_COUNT } from '@render/materials/library.ts'
import { biomeParams } from '@world/vegetation/biomes.ts'
import { foliageMaterialIds, resolveGroundMaterialIds } from '../../src/app/biomeMaterials.ts'

const known = new Set<string>(MATERIAL_IDS)

describe('biome material ids resolve against the library', () => {
  for (const biome of BIOME_IDS) {
    it(`${biome}: every foliage id exists`, () => {
      const ids = foliageMaterialIds(biome)
      for (const [tag, id] of Object.entries(ids)) {
        expect(known.has(id), `${biome}.${tag} = '${id}' is not a library material id`).toBe(true)
      }
      // Named explicitly: this is the one that was wrong, and it is the largest thing on screen.
      expect(ids.grass).toBe('grass-blade')
    })

    it(`${biome}: every ground name translates, so the fallback never fires`, () => {
      // The translation is POSITIONAL — `BiomeParams.groundMaterials` is in GROUND_SLOT order
      // (Mesic, Litter, Xeric, Rock), which is why entries like 'granite-scree' -> 'litter-needle'
      // look wrong read as a material pairing and are right read as a slot pairing.
      //
      // What matters is that nothing goes untranslated: an unknown name silently swaps the whole
      // set for WP 1.6's per-biome default, and a plausible-but-wrong ground is invisible in
      // review and permanent in the build.
      const { ids, warning } = resolveGroundMaterialIds(biome, biomeParams(biome).groundMaterials)
      expect(warning).toBeNull()
      expect(ids).toHaveLength(GROUND_SLOT_COUNT)
      for (const id of ids) {
        expect(known.has(id), `${biome} ground '${id}' is not a library material id`).toBe(true)
      }
    })
  }
})
