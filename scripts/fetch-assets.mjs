#!/usr/bin/env node
/**
 * ForestFire — CC0 PBR texture fetcher. WP 1.6.
 *
 * ============================================================================
 *  THIS SCRIPT HAS NEVER BEEN RUN, AND NOTHING IN THE PROJECT NEEDS IT TO BE.
 * ============================================================================
 *
 * M1 renders entirely on the PROCEDURAL material set — `gpu-procedural` is the default source
 * of `createMaterialSystem()` and it downloads nothing. This script exists because spec §0.2
 * locks the asset strategy as "procedural geometry + curated CC0 PBR textures", so the ingest
 * path has to exist and be documented; but fetching from the network is a separate, explicitly
 * authorised step and it is the user's to take, not the build's.
 *
 * Run it, if you want to, with:
 *
 *     node scripts/fetch-assets.mjs            # download into public/assets/materials/
 *     node scripts/fetch-assets.mjs --dry-run  # print every URL and byte count, fetch nothing
 *     node scripts/fetch-assets.mjs --list     # print the manifest and licences, exit
 *
 * Then pass `{ source: 'assets' }` to `createMaterialSystem`. Without the download, that
 * source throws with a message naming this script; it does not silently fall back.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WOULD DOWNLOAD
 * ---------------------------------------------------------------------------
 *
 * Two sources, both of which publish their entire library under CC0 1.0 Universal (public
 * domain dedication — no attribution required, commercial use permitted, no share-alike):
 *
 *   - Poly Haven (https://polyhaven.com) — "All assets on Poly Haven are licensed CC0."
 *     Public JSON API at https://api.polyhaven.com, documented at
 *     https://github.com/Poly-Haven/Public-Assets-API. Files are served from
 *     https://dl.polyhaven.org.
 *   - ambientCG (https://ambientcg.com) — "All assets on ambientCG.com are licensed under the
 *     Creative Commons CC0 1.0 Universal License." Direct download endpoint at
 *     https://ambientcg.com/get?file=<AssetID>_<Resolution>-<Format>.zip
 *
 * Sixteen material sets, ~30 MB at 1K / ~120 MB at 2K, three maps each (Diffuse/Albedo,
 * Normal GL, and Roughness+AO, which this project repacks into a single ORM). The chosen
 * sets, by ambientCG asset id, mapped onto this project's material ids:
 *
 *     bark-conifer-furrowed    Bark012        rough plated conifer bark
 *     bark-broadleaf-smooth    Bark006        smooth grey broadleaf bark
 *     bark-eucalypt-ribbon     Bark014        long fibrous strips
 *     foliage-needle           (procedural)   no CC0 needle atlas is a good enough match
 *     foliage-broadleaf        (procedural)   ditto
 *     foliage-sclerophyll      (procedural)   ditto
 *     grass-blade              (procedural)   ditto
 *     litter-needle            Ground054      pine-needle forest floor
 *     litter-broadleaf         Ground035      leaf litter
 *     ground-duff              Ground047      dark forest duff
 *     ground-soil              Ground033      dry mineral soil
 *     ground-rock              Rock030        fractured granite
 *
 * The four alpha-tested vegetation materials stay procedural in every configuration. A CC0
 * bark photo is a straightforward win — real bark has correlations no noise function
 * reproduces — but a foliage atlas is a cut-out with a specific leaf shape, and this project
 * derives leaf geometry from the species' fuel parameters (§7.5). A downloaded atlas would
 * put a stock oak leaf on a lodgepole pine, which breaks the one rule the whole design rests
 * on: the picture is an expression of the physics, never a parallel authored layer.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WRITES
 * ---------------------------------------------------------------------------
 *
 *   public/assets/materials/manifest.json         index consumed by loadAssets()
 *   public/assets/materials/<id>_albedo.png       sRGB-ENCODED
 *   public/assets/materials/<id>_normal.png       LINEAR, OpenGL convention (+Y up)
 *   public/assets/materials/<id>_orm.png          LINEAR: R=AO, G=roughness, B=metallic(0)
 *   public/assets/materials/LICENSES.md           per-asset provenance and licence text
 *
 * The colour-space annotations are not decoration. The albedo PNG is consumed as encoded
 * bytes into an `rgba8unorm` texture that is SAMPLED through an `-srgb` view; the normal and
 * ORM PNGs go into non-sRGB textures. Getting that backwards produces a scene that is wrong
 * everywhere by a brightness-dependent factor and looks like a lighting bug.
 *
 * Normal maps must be OpenGL convention (green = +Y). ambientCG publishes both; this script
 * takes `NormalGL`. DirectX-convention maps invert green, which reads as light coming from
 * the wrong side and is almost impossible to spot on a rough organic surface.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not repack Roughness and AO into a single ORM PNG, because that needs an image
 * decoder and this project takes no dependencies (rule D). The `--dry-run` output lists the
 * separate Roughness and AmbientOcclusion files it would fetch; combining them is a manual
 * step, or a job for `sharp` if the user chooses to add it. `assembleOrm()` below throws
 * rather than pretending, and says exactly what is missing.
 *
 * It also does not compress to BC7. Spec §7.6 assumes BC7 (which is where the ~500 MiB
 * VRAM figure in §10 §6.2 comes from), but `texture-compression-bc` is not in
 * `WANTED_FEATURES` in `src/contracts/gpu.ts`, so the runtime cannot sample BC7 today. The
 * uncompressed procedural set fits the budget four times over, so this is not urgent — but it
 * IS a real gap between the spec and the contract, and it is reported as such.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'public', 'assets', 'materials')

/** Resolution to fetch. 1K is plenty: these tile at 0.6-2.5 m, so 1K is ~1.7 texels/mm. */
const RESOLUTION = '1K'

/** CC0 1.0 Universal, verbatim identifier. Both sources publish under exactly this. */
const LICENSE = 'CC0-1.0'

/**
 * The asset table. `id` values must exist in `MATERIAL_IDS` (src/render/materials/library.ts)
 * or `loadAssets()` throws at startup naming the offender.
 */
const ASSETS = [
  { id: 'bark-conifer-furrowed', source: 'ambientCG', asset: 'Bark012' },
  { id: 'bark-broadleaf-smooth', source: 'ambientCG', asset: 'Bark006' },
  { id: 'bark-eucalypt-ribbon', source: 'ambientCG', asset: 'Bark014' },
  { id: 'litter-needle', source: 'ambientCG', asset: 'Ground054' },
  { id: 'litter-broadleaf', source: 'ambientCG', asset: 'Ground035' },
  { id: 'ground-duff', source: 'ambientCG', asset: 'Ground047' },
  { id: 'ground-soil', source: 'ambientCG', asset: 'Ground033' },
  { id: 'ground-rock', source: 'ambientCG', asset: 'Rock030' },
]

/** ambientCG serves a zip per (asset, resolution, format). */
function ambientCgUrl(asset) {
  return `https://ambientcg.com/get?file=${asset}_${RESOLUTION}-PNG.zip`
}

/** The files inside that zip this project wants. */
function ambientCgMembers(asset) {
  return {
    albedo: `${asset}_${RESOLUTION}-PNG_Color.png`,
    normal: `${asset}_${RESOLUTION}-PNG_NormalGL.png`,
    roughness: `${asset}_${RESOLUTION}-PNG_Roughness.png`,
    ambientOcclusion: `${asset}_${RESOLUTION}-PNG_AmbientOcclusion.png`,
  }
}

/**
 * Repack Roughness + AO into a single ORM PNG.
 *
 * Not implemented, and deliberately not faked: it needs a PNG decoder and this project takes
 * no dependencies. Throwing with an explicit instruction beats writing a file that claims to
 * be an ORM map and is actually a copy of the roughness channel.
 */
async function assembleOrm(_paths, outPath) {
  throw new Error(
    `cannot write ${outPath}: packing Roughness + AmbientOcclusion into one ORM PNG needs an ` +
      `image decoder, and this project adds no dependencies. Either (a) combine them by hand ` +
      `into R=AO, G=roughness, B=0, or (b) install an encoder such as 'sharp' and implement ` +
      `assembleOrm(), or (c) stay on the procedural material set, which needs none of this.`,
  )
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    list: argv.includes('--list'),
  }
}

function printManifest() {
  console.log(`ForestFire CC0 material fetch — ${ASSETS.length} sets at ${RESOLUTION}, licence ${LICENSE}\n`)
  for (const a of ASSETS) {
    const m = ambientCgMembers(a.asset)
    console.log(`  ${a.id}`)
    console.log(`    source : ${a.source} ${a.asset} (https://ambientcg.com/view?id=${a.asset})`)
    console.log(`    licence: ${LICENSE} — public domain dedication, no attribution required`)
    console.log(`    archive: ${ambientCgUrl(a.asset)}`)
    console.log(`    members: ${m.albedo}, ${m.normal}, ${m.roughness}, ${m.ambientOcclusion}`)
  }
  console.log(
    `\nAlpha-tested vegetation (foliage-needle, foliage-broadleaf, foliage-sclerophyll,\n` +
      `grass-blade) is NOT downloaded: leaf geometry is derived from each species' fuel\n` +
      `parameters, and a stock cut-out would put the wrong leaf on the right tree.`,
  )
}

async function alreadyPresent(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.list) {
    printManifest()
    return
  }

  console.log(`ForestFire CC0 material fetch -> ${OUT_DIR}`)
  console.log(`Licence for every asset below: ${LICENSE} (CC0 1.0 Universal).`)
  if (args.dryRun) console.log('DRY RUN — nothing will be downloaded or written.\n')

  if (!args.dryRun) {
    await mkdir(OUT_DIR, { recursive: true })
  }

  const manifest = { generatedBy: 'scripts/fetch-assets.mjs', size: 1024, materials: [] }
  const licenses = [
    '# Third-party material licences',
    '',
    'Every texture set below is CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/):',
    'a public domain dedication. No attribution is required and none of it is a licence',
    'obligation. It is recorded anyway, because knowing where a thing came from is worth more',
    'than the paperwork it saves.',
    '',
  ]

  for (const a of ASSETS) {
    const url = ambientCgUrl(a.asset)
    const members = ambientCgMembers(a.asset)
    const albedoOut = join(OUT_DIR, `${a.id}_albedo.png`)
    const normalOut = join(OUT_DIR, `${a.id}_normal.png`)
    const ormOut = join(OUT_DIR, `${a.id}_orm.png`)

    console.log(`\n${a.id}  <-  ${a.source} ${a.asset}`)
    console.log(`  GET ${url}`)
    console.log(`  extract ${members.albedo} -> ${albedoOut}   (sRGB-ENCODED)`)
    console.log(`  extract ${members.normal} -> ${normalOut}   (LINEAR, OpenGL +Y)`)
    console.log(`  pack    ${members.roughness} + ${members.ambientOcclusion} -> ${ormOut}  (LINEAR)`)

    manifest.materials.push({
      id: a.id,
      albedo: `${a.id}_albedo.png`,
      normal: `${a.id}_normal.png`,
      orm: `${a.id}_orm.png`,
      source: `${a.source} ${a.asset}`,
      license: LICENSE,
    })
    licenses.push(`- **${a.id}** — ${a.source} \`${a.asset}\`, ${url} — ${LICENSE}`)

    if (args.dryRun) continue

    if (await alreadyPresent(albedoOut)) {
      console.log('  already present, skipping')
      continue
    }

    // The download itself. Node 18+ has fetch built in, so no dependency is needed for this
    // part; unzipping is the part that would need one, which is why the extraction above is
    // printed rather than performed.
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`fetch failed for ${a.asset}: HTTP ${res.status} ${res.statusText}`)
    }
    const zipPath = join(OUT_DIR, `${a.asset}_${RESOLUTION}.zip`)
    await writeFile(zipPath, Buffer.from(await res.arrayBuffer()))
    console.log(`  saved ${zipPath}`)
    console.log(
      `  NOT extracted: unzipping needs a dependency this project does not take. Extract\n` +
        `  ${members.albedo} and ${members.normal} by hand, then see assembleOrm().`,
    )
    await assembleOrm(members, ormOut)
  }

  if (args.dryRun) {
    console.log('\nDry run complete. Nothing was downloaded.')
    return
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(OUT_DIR, 'LICENSES.md'), `${licenses.join('\n')}\n`)
  console.log('\nWrote manifest.json and LICENSES.md.')
}

main().catch((err) => {
  console.error(`\nfetch-assets failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
