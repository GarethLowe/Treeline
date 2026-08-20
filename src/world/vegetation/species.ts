/**
 * Species definitions for the five biomes. WP 1.3.
 *
 * **Every number here carries a source comment.** Spec §0.7.1 is normative: a constant whose
 * source cannot be obtained may not be entered as a guess. Where no source exists the value
 * is entered as a *declared* estimate and appears in `ESTIMATED_SPECIES_FIELDS`
 * (provenance.ts), so the HUD can badge the affected quantity rather than inheriting the
 * table's overall `calibrated` status.
 *
 * Source shorthand used in the comments:
 *   §20 §4.3  — docs/spec/20-surface-spread.md §4.3, Scott & Burgan / Anderson fuel models
 *   §30 §7.1  — docs/spec/30-canopy-heat-crown.md §7.1, Van Wagner criteria and envelope
 *   §60 §7.x  — docs/spec/60-regional-models.md, the regional fuel tables
 *
 * ---------------------------------------------------------------------------
 * TWO CONVENTIONS THAT ARE EASY TO GET WRONG, FIXED HERE
 * ---------------------------------------------------------------------------
 *
 * **1. `crownBulkDensity` is WITHIN-CROWN, not stand-level.**
 *
 * The contract's inline comment mentions Van Wagner's 0.05 kg m⁻³ active-crowning threshold,
 * which is a *stand* (canopy) bulk density. The per-stem value cannot be that number. The
 * contract itself settles it: `TreeMesh.derived.crownBulkDensity` in WP 1.4 is "measured from
 * the generated geometry" and must match the Stem's value within 10 %, and geometry can only
 * yield foliage mass divided by the crown envelope's own volume. So this field is
 * foliage mass / crown volume, and it is several times larger than stand CBD because crowns
 * do not fill a stand.
 *
 * Stand CBD emerges later, when the M3 voxeliser deposits crown mass into 2 m voxels and the
 * crowns' packing decides the answer. `VegetationSet` reports the measured stand-level figure
 * as a diagnostic (`measuredStandCrownBulkDensity`) so the emergent number can be sanity
 * checked against the 0.05 kg m⁻³ threshold without anyone having to reinterpret this field.
 *
 * For shrubs the two coincide in a mature closed stand, which is why the chaparral values
 * transcribed straight from §60 §7.2.3 ("Canopy bulk density 1.0–3.5 kg m⁻³") sit an order of
 * magnitude above the conifer values here. That is real, not an inconsistency.
 *
 * **2. `foliarMoisture` is a FRACTION** (§0.6 rule 3). Every source in this file quotes
 * percent; every value here is the percent divided by 100, via `moistureFraction`.
 *
 * ---------------------------------------------------------------------------
 * SIZE RANGES ARE STAND RANGES, NOT RECORD SIZES
 * ---------------------------------------------------------------------------
 * `heightM` and `dbhM` describe the span of *mature individuals in a stand of this biome*,
 * not the species' maximum. The distinction is not pedantry: the placement sampler draws a
 * size rank across the whole declared range, so a range anchored on record trees makes the
 * *average* stem a record tree. Doing that with Silvics' "over 1 m DBH on the best sites"
 * figure for ponderosa produced a stand of 100 m² ha⁻¹ basal area — roughly three times what
 * any real ponderosa stand carries, and physically obvious only once basal area was measured.
 *
 * The two ranges are also kept **mutually consistent under elastic similarity**: because DBH
 * grows as height^1.5 (McMahon 1973, see allometry.ts), a height range spanning a factor `f`
 * implies a diameter range spanning `f^1.5`. Every woody species here satisfies that to a few
 * percent, and `species.test.ts` asserts it. Without the constraint, the smallest mature stem
 * of a species would be a broomstick and the largest a stump.
 */

import type { BiomeId, SpeciesDef } from '@contracts/world'
import type { KgPerCubicMetre, KgPerSquareMetre, Metres, MoistureFraction } from '@contracts/units'
import { kgm2, kgm3, m, moistureFraction, tonsPerAcreToKgM2 } from '@contracts/units'

// ---------------------------------------------------------------------------
// Local helpers — keep the table itself readable
// ---------------------------------------------------------------------------

const hRange = (lo: number, hi: number): readonly [Metres, Metres] => [m(lo), m(hi)]
const dRange = (lo: number, hi: number): readonly [Metres, Metres] => [m(lo), m(hi)]
const cbd = (lo: number, hi: number): readonly [KgPerCubicMetre, KgPerCubicMetre] => [
  kgm3(lo),
  kgm3(hi),
]
/** Source tables quote FMC in percent; §0.6 rule 3 says the code stores a fraction. */
const fmcPct = (lo: number, hi: number): readonly [MoistureFraction, MoistureFraction] => [
  moistureFraction(lo / 100),
  moistureFraction(hi / 100),
]
/** Total dead load of a §20 §4.3 fuel model row, short tons/acre → kg m⁻². */
const deadLoadFromFuelModel = (...tonsPerAcre: number[]): KgPerSquareMetre =>
  tonsPerAcreToKgM2(tonsPerAcre.reduce((a, b) => a + b, 0))

/** Which growth forms are instantiated as individual `Stem`s. */
export const STEM_FORMS: ReadonlySet<SpeciesDef['form']> = new Set<SpeciesDef['form']>([
  'conifer',
  'broadleaf',
  'shrub',
])

/**
 * Grass and fern are *cover* species: at 1 km² they are far too numerous to be individual
 * stems (WP 1.5 renders them as a GPU grass field), and the fire model consumes them as a
 * continuous surface/near-surface fuel layer, not as discrete plants. They are still full
 * `SpeciesDef`s because their height and moisture drive the understory layer — which is what
 * `hasLadderFuels` is measured against, and what Vesta's `H_ns` term needs (§60 §7.1.2).
 */
export const isStemForming = (sp: SpeciesDef): boolean => STEM_FORMS.has(sp.form)

// ---------------------------------------------------------------------------
// Western US conifer
// ---------------------------------------------------------------------------

const PONDEROSA_PINE: SpeciesDef = {
  id: 'pinus-ponderosa',
  commonName: 'Ponderosa pine',
  scientificName: 'Pinus ponderosa',
  biomes: ['western-us-conifer'],
  form: 'conifer',
  // Silvics of North America vol. 1 (Burns & Honkala 1990), P. ponderosa account: mature
  // trees commonly 30–50 m on good sites, less on dry interior sites. Range trimmed to the
  // dry-site form this biome represents.
  heightM: hRange(18, 38),
  // Silvics reports individuals past 1 m DBH on the best sites. This is deliberately NOT that
  // number — see the "stand range, not record size" note in the header. mean H/D ≈ 62 here,
  // which is the slenderness a stand-grown ponderosa actually has.
  dbhM: dRange(0.22, 0.68),
  // ESTIMATE (declared, see ). No per-species CBH source is
  // obtainable. Bounded by the §30 §7.7 calibration sweep CBH ∈ {0.5,1,2,3,5,8} m against the
  // height range above, plus ponderosa's documented strong self-pruning.
  crownBaseFraction: [0.2, 0.45],
  // ESTIMATE. Within-crown (see header). Chosen so that a stand at this biome's default
  // density yields a stand-level CBD near the 0.05–0.15 kg m⁻³ band that §30 §7.1's
  // active-crowning discussion treats as the conifer working range.
  crownBulkDensity: cbd(0.15, 0.5),
  crownWidthFraction: 0.3, // ESTIMATE from growth habit: narrow, deep conifer crown.
  // §30 §7.1: Van Wagner's criteria fitted with FMC ≈ 95–135 % (Cruz & Alexander 2014).
  // Ponderosa is inside that envelope, so this is the cited working range.
  foliarMoisture: fmcPct(95, 135),
  bark: 'thick-plated', // Silvics: characteristic orange plated bark on mature trees.
  // ESTIMATE (declared). Bark plates and needle clusters are the western-US brand source, but
  // no obtainable per-species figure exists; §60 §7.1.3 documents only the eucalypt mechanism.
  firebrandSource: true,
  // §20 §4.3: TL8 "Long-needle ponderosa litter", dead loads 5.80 + 1.40 + 1.10 t ac⁻¹.
  litterLoad: deadLoadFromFuelModel(5.8, 1.4, 1.1),
  surfaceFuelModel: 'TL8', // §20 §4.3, named for this species.
}

const DOUGLAS_FIR: SpeciesDef = {
  id: 'pseudotsuga-menziesii',
  commonName: 'Douglas fir',
  scientificName: 'Pseudotsuga menziesii',
  biomes: ['western-us-conifer'],
  form: 'conifer',
  heightM: hRange(20, 48), // Silvics vol. 1, P. menziesii account (interior var. glauca is shorter).
  dbhM: dRange(0.2, 0.74), // Stand range; mean H/D ≈ 72, i.e. more slender than ponderosa. Correct.
  // ESTIMATE (declared). Douglas fir retains lower branches longer than ponderosa, so the
  // fraction is lower — this is the parameter that makes it the more torch-prone of the two.
  crownBaseFraction: [0.12, 0.35],
  crownBulkDensity: cbd(0.2, 0.7), // ESTIMATE, within-crown. Denser foliage than ponderosa.
  crownWidthFraction: 0.28, // ESTIMATE from growth habit.
  foliarMoisture: fmcPct(95, 135), // §30 §7.1, Van Wagner envelope (Cruz & Alexander 2014).
  bark: 'furrowed', // Silvics: thick, deeply furrowed corky bark on mature trees.
  firebrandSource: false, // No obtainable source claims significant brand production. §0.7.1: do not guess "true".
  litterLoad: deadLoadFromFuelModel(1.15, 2.5, 4.4), // §20 §4.3, TL5 "Conifer litter".
  surfaceFuelModel: 'TL5', // §20 §4.3.
}

const GAMBEL_OAK: SpeciesDef = {
  id: 'quercus-gambelii',
  commonName: 'Gambel oak',
  scientificName: 'Quercus gambelii',
  biomes: ['western-us-conifer'],
  form: 'shrub',
  // Present because it is the classic ponderosa ladder fuel: a clonal shrub-to-small-tree
  // layer that bridges surface fire into the pine crown. `hasLadderFuels` is measured against
  // exactly this, so omitting it would make torching structurally impossible.
  heightM: hRange(2, 8), // ESTIMATE from growth habit (shrub to small tree).
  dbhM: dRange(0.03, 0.24), // ESTIMATE from growth habit.
  crownBaseFraction: [0.0, 0.15], // Shrub form: foliage effectively to the ground.
  crownBulkDensity: cbd(0.5, 1.5), // ESTIMATE, within-crown; between conifer crown and chaparral shrub.
  crownWidthFraction: 1.0, // ESTIMATE: as wide as tall, typical of clonal oak thickets.
  // ESTIMATE (declared): taken as the UK broadleaf range, §60 §7.3.3, on the grounds that both
  // are summer-green broadleaves. No Gambel oak FMC source is obtainable.
  foliarMoisture: fmcPct(100, 200),
  bark: 'furrowed',
  firebrandSource: false,
  litterLoad: deadLoadFromFuelModel(4.0, 4.0, 3.0), // §20 §4.3, TU5 "Dense conifer understorey".
  surfaceFuelModel: 'TU5', // §20 §4.3 — the model for conifer stands carrying a dense understorey.
}

const ARIZONA_FESCUE: SpeciesDef = {
  id: 'festuca-arizonica',
  commonName: 'Arizona fescue',
  scientificName: 'Festuca arizonica',
  biomes: ['western-us-conifer'],
  form: 'grass',
  // The bunchgrass understorey of open ponderosa stands. It is the fine fuel that actually
  // carries surface fire between the pines, and it sets the understory top the ladder-fuel
  // test measures against.
  heightM: hRange(0.2, 0.6), // ESTIMATE from growth habit; consistent with GR2 depth 1.0 ft.
  dbhM: dRange(0.002, 0.006),
  crownBaseFraction: [0.0, 0.0],
  // §20 §4.3 GR2: herbaceous 1.00 t ac⁻¹ = 0.224 kg m⁻² over depth 1.0 ft = 0.305 m
  // → 0.73 kg m⁻³. GR1 (0.30 t ac⁻¹ over 0.4 ft) gives 0.55; the range brackets both.
  crownBulkDensity: cbd(0.35, 0.9),
  crownWidthFraction: 0.7,
  foliarMoisture: fmcPct(30, 120), // §20 §4.3 dynamic load-transfer bracket (cured → green).
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: deadLoadFromFuelModel(0.1), // §20 §4.3, GR2 1-h dead load.
  surfaceFuelModel: 'GR2', // §20 §4.3.
}

// ---------------------------------------------------------------------------
// Grassland / savanna
// ---------------------------------------------------------------------------

const BUR_OAK: SpeciesDef = {
  id: 'quercus-macrocarpa',
  commonName: 'Bur oak',
  scientificName: 'Quercus macrocarpa',
  biomes: ['grassland-savanna'],
  form: 'broadleaf',
  // ESTIMATE from growth habit. Open-grown savanna oaks are SHORT and THICK — mean H/D ≈ 26
  // against ~62 for a stand-grown conifer. That stockiness is the savanna form, not an error.
  heightM: hRange(13, 26),
  dbhM: dRange(0.4, 1.1),
  // Open-grown savanna trees keep low, wide crowns — the opposite of the forest form. Low
  // crown base plus a grass surface fuel is why savanna oaks torch readily.
  crownBaseFraction: [0.1, 0.3], // ESTIMATE from open-grown habit.
  crownBulkDensity: cbd(0.15, 0.5), // ESTIMATE, within-crown.
  crownWidthFraction: 0.8, // ESTIMATE: open-grown crowns are broad.
  foliarMoisture: fmcPct(100, 200), // ESTIMATE (declared) — UK broadleaf range, §60 §7.3.3.
  bark: 'furrowed', // Thick corky furrowed bark; the trait that makes it a fire-tolerant savanna tree.
  firebrandSource: false,
  litterLoad: kgm2(0.55), // §60 §7.3.2 broadleaf litter, fine dead 0.30–0.80 kg m⁻²; midpoint.
  surfaceFuelModel: 'GS1', // §20 §4.3, "Savanna, chaparral edge" — grass with a woody component.
}

const BIG_BLUESTEM: SpeciesDef = {
  id: 'andropogon-gerardii',
  commonName: 'Big bluestem',
  scientificName: 'Andropogon gerardii',
  biomes: ['grassland-savanna'],
  form: 'grass',
  // §20 §4.3: GR4 depth 2.0 ft = 0.61 m. Tallgrass reaches well above the fuel-bed depth in
  // late season, so the upper bound is the plant, the lower the grazed/early-season bed.
  heightM: hRange(0.6, 2.4),
  dbhM: dRange(0.002, 0.006), // Culm diameter. Contributes negligibly to basal area, as it should.
  crownBaseFraction: [0.0, 0.0], // Grass: fuel is continuous to ground by definition.
  // Derived from §20 §4.3 GR4: herbaceous load 1.90 t ac⁻¹ = 0.426 kg m⁻² over depth 0.61 m
  // → 0.70 kg m⁻³. Range spans the GR2 (1.00 t ac⁻¹ over 1.0 ft) to GR4 bracket.
  crownBulkDensity: cbd(0.4, 1.0),
  crownWidthFraction: 0.9,
  // §20 §4.3 dynamic load transfer: M_herb = 120 % is fully green, 30 % fully cured. That
  // bracket is the cited live-herbaceous moisture range.
  foliarMoisture: fmcPct(30, 120),
  bark: 'fibrous', // No 'none' in the contract enum; fibrous is the closest true statement for a culm.
  firebrandSource: false,
  litterLoad: deadLoadFromFuelModel(0.25), // §20 §4.3, GR4 1-h dead load.
  surfaceFuelModel: 'GR4', // §20 §4.3, "Grass/savanna".
}

const LITTLE_BLUESTEM: SpeciesDef = {
  id: 'schizachyrium-scoparium',
  commonName: 'Little bluestem',
  scientificName: 'Schizachyrium scoparium',
  biomes: ['grassland-savanna'],
  form: 'grass',
  heightM: hRange(0.3, 1.2), // §20 §4.3 GS1 depth 0.9 ft = 0.27 m bed; plant height is taller.
  dbhM: dRange(0.002, 0.005),
  crownBaseFraction: [0.0, 0.0],
  // §20 §4.3 GS1: herb 0.50 t ac⁻¹ = 0.112 kg m⁻² over 0.27 m → 0.41 kg m⁻³.
  crownBulkDensity: cbd(0.3, 0.8),
  crownWidthFraction: 0.8,
  foliarMoisture: fmcPct(30, 120), // §20 §4.3 dynamic load transfer bracket.
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: deadLoadFromFuelModel(0.2), // §20 §4.3, GS1 1-h dead load.
  surfaceFuelModel: 'GS1', // §20 §4.3.
}

// ---------------------------------------------------------------------------
// Mediterranean chaparral
//
// §30 §7.1 is explicit that Van Wagner's crown-initiation criterion is out of envelope here:
// "chaparral, where there is no meaningful CBH because fuel is vertically continuous". That
// is why every crownBaseFraction below starts at 0.0 — it is a physical statement, not a
// default.
// ---------------------------------------------------------------------------

const CHAMISE: SpeciesDef = {
  id: 'adenostoma-fasciculatum',
  commonName: 'Chamise',
  scientificName: 'Adenostoma fasciculatum',
  biomes: ['mediterranean-chaparral'],
  form: 'shrub',
  heightM: hRange(1.0, 2.5), // §60 §7.2.3 mature-stand table, "Height", chamise column.
  dbhM: dRange(0.02, 0.08), // ESTIMATE: basal stem diameter of a multi-stemmed shrub.
  crownBaseFraction: [0.0, 0.05], // §30 §7.1: vertically continuous fuel, no meaningful CBH.
  crownBulkDensity: cbd(1.0, 3.5), // §60 §7.2.3 mature-stand table, "Canopy bulk density".
  crownWidthFraction: 1.2, // ESTIMATE (declared) from growth habit: broader than tall.
  // §60 §7.2.3, "Live fuel moisture, annual cycle": 55–60 % (Sep–Oct minimum) → 120–140 % (Apr).
  foliarMoisture: fmcPct(55, 140),
  bark: 'fibrous',
  firebrandSource: false, // §60 §7.2 documents no chaparral spotting mechanism. Do not invent one.
  litterLoad: deadLoadFromFuelModel(3.6, 2.1), // §20 §4.3, SH5 dead loads 3.60 + 2.10 t ac⁻¹.
  // §0.7.2 / §60 §7.2.3: the Anderson et al. (2015) shrubland closure rests on unread
  // constants, so chaparral SHIPS on Rothermel with SH5/SH7 — a substitution that is known to
  // underpredict, which is the point. SH5 = "Chaparral (mature)" in §20 §4.3.
  surfaceFuelModel: 'SH5',
}

const MANZANITA: SpeciesDef = {
  id: 'arctostaphylos-glandulosa',
  commonName: 'Eastwood manzanita',
  scientificName: 'Arctostaphylos glandulosa',
  biomes: ['mediterranean-chaparral'],
  form: 'shrub',
  heightM: hRange(2.0, 4.0), // §60 §7.2.3, "Height", manzanita/ceanothus column.
  dbhM: dRange(0.03, 0.15), // ESTIMATE: basal stem diameter.
  crownBaseFraction: [0.0, 0.1], // §30 §7.1: vertically continuous.
  crownBulkDensity: cbd(1.0, 3.0), // §60 §7.2.3, manzanita/ceanothus column.
  crownWidthFraction: 1.1, // ESTIMATE from growth habit.
  foliarMoisture: fmcPct(60, 150), // §60 §7.2.3, manzanita/ceanothus annual cycle 60–70 % → 150 %.
  bark: 'smooth', // The characteristic smooth red exfoliating bark.
  firebrandSource: false,
  litterLoad: deadLoadFromFuelModel(3.5, 5.3, 2.2), // §20 §4.3, SH7 dead loads.
  surfaceFuelModel: 'SH7', // §20 §4.3, "Chaparral, eucalypt understorey, gorse".
}

const CEANOTHUS: SpeciesDef = {
  id: 'ceanothus-megacarpus',
  commonName: 'Bigpod ceanothus',
  scientificName: 'Ceanothus megacarpus',
  biomes: ['mediterranean-chaparral'],
  form: 'shrub',
  heightM: hRange(2.0, 4.0), // §60 §7.2.3, manzanita/ceanothus column.
  dbhM: dRange(0.03, 0.12), // ESTIMATE.
  crownBaseFraction: [0.0, 0.1], // §30 §7.1.
  crownBulkDensity: cbd(1.0, 3.0), // §60 §7.2.3.
  crownWidthFraction: 1.2, // ESTIMATE.
  foliarMoisture: fmcPct(60, 150), // §60 §7.2.3.
  bark: 'smooth',
  firebrandSource: false,
  litterLoad: deadLoadFromFuelModel(3.5, 5.3, 2.2), // §20 §4.3, SH7.
  surfaceFuelModel: 'SH7', // §20 §4.3.
}

// ---------------------------------------------------------------------------
// Eucalypt dry forest
//
// §60 §7.1.3 splits the bark classes and the split is load-bearing, not cosmetic:
//   fibrous / stringybark (E. obliqua, E. marginata) → profuse SHORT-range spotting, ≤750 m
//   smooth decorticating ribbon (E. viminalis, E. globulus, E. delegatensis) → the ribbons
//     curl into tubes that burn ~40 min, and produce authenticated ~30 km spotting.
//
// The work-package brief pairs "E. obliqua / marginata" with decorticating ribbon bark. The
// specification does not: it classes both of those as fibrous/stringybark. The spec is
// normative (§90.1), so they are entered as fibrous here and E. viminalis is added to carry
// the ribbon-bark mechanism, which would otherwise be absent from the whole simulation.
// ---------------------------------------------------------------------------

const MESSMATE_STRINGYBARK: SpeciesDef = {
  id: 'eucalyptus-obliqua',
  commonName: 'Messmate stringybark',
  scientificName: 'Eucalyptus obliqua',
  biomes: ['eucalypt-dry-forest'],
  form: 'broadleaf',
  heightM: hRange(25, 60), // ESTIMATE from growth habit; the tall dry-sclerophyll form.
  dbhM: dRange(0.22, 0.82), // ESTIMATE, stand range.
  crownBaseFraction: [0.35, 0.6], // ESTIMATE: tall clear bole under an open crown.
  crownBulkDensity: cbd(0.05, 0.22), // ESTIMATE, within-crown. Eucalypt crowns are notably open.
  crownWidthFraction: 0.28, // ESTIMATE: a narrow crown on a very tall bole.
  // ESTIMATE (declared). No eucalypt FMC appears anywhere in the specification, and §30 §7.1
  // explicitly places eucalypt OUTSIDE the Van Wagner envelope this range is borrowed from.
  foliarMoisture: fmcPct(90, 130),
  bark: 'fibrous', // §60 §7.1.3 names E. obliqua as fibrous/stringybark.
  firebrandSource: true, // §60 §7.1.3: "profuse short-range spotting (≤500–750 m)".
  litterLoad: kgm2(1.25), // §60 §7.1.1: canonical fine fuel load w = 12.5 t ha⁻¹.
  surfaceFuelModel: 'SH7', // §20 §4.3, "Chaparral, eucalypt understorey, gorse".
}

const JARRAH: SpeciesDef = {
  id: 'eucalyptus-marginata',
  commonName: 'Jarrah',
  scientificName: 'Eucalyptus marginata',
  biomes: ['eucalypt-dry-forest'],
  form: 'broadleaf',
  heightM: hRange(15, 34), // ESTIMATE from growth habit. The Burrows (1994) jarrah fire dataset stands.
  dbhM: dRange(0.18, 0.61), // ESTIMATE, stand range.
  crownBaseFraction: [0.3, 0.55], // ESTIMATE.
  crownBulkDensity: cbd(0.05, 0.22), // ESTIMATE, within-crown.
  crownWidthFraction: 0.38, // ESTIMATE: jarrah crowns are broader than messmate.
  foliarMoisture: fmcPct(90, 130), // ESTIMATE (declared) — as E. obliqua.
  bark: 'fibrous', // §60 §7.1.3 names E. marginata as fibrous/stringybark.
  firebrandSource: true, // §60 §7.1.3.
  litterLoad: kgm2(1.25), // §60 §7.1.1 canonical fine fuel load.
  surfaceFuelModel: 'SH7', // §20 §4.3.
}

const MANNA_GUM: SpeciesDef = {
  id: 'eucalyptus-viminalis',
  commonName: 'Manna gum',
  scientificName: 'Eucalyptus viminalis',
  biomes: ['eucalypt-dry-forest'],
  form: 'broadleaf',
  heightM: hRange(15, 42), // ESTIMATE from growth habit.
  dbhM: dRange(0.15, 0.7), // ESTIMATE, stand range.
  crownBaseFraction: [0.35, 0.6], // ESTIMATE.
  crownBulkDensity: cbd(0.05, 0.22), // ESTIMATE, within-crown.
  crownWidthFraction: 0.32, // ESTIMATE.
  foliarMoisture: fmcPct(90, 130), // ESTIMATE (declared) — as E. obliqua.
  // §60 §7.1.3 names E. viminalis in the smooth decorticating / ribbon-bark class. This is the
  // single largest firebrand source known: streamers detach, curl into hollow tubes that burn
  // for ~40 min (Hodgson 1967), and reach authenticated ~30 km (Cruz et al. 2012, Kilmore East).
  bark: 'decorticating-ribbon',
  firebrandSource: true,
  litterLoad: kgm2(1.25), // §60 §7.1.1.
  surfaceFuelModel: 'SH7', // §20 §4.3.
}

const AUSTRAL_BRACKEN: SpeciesDef = {
  id: 'pteridium-esculentum',
  commonName: 'Austral bracken',
  scientificName: 'Pteridium esculentum',
  biomes: ['eucalypt-dry-forest'],
  form: 'fern',
  // Present because Vesta is strongly sensitive to near-surface fuel height: §60 §7.1.2 warns
  // that doubling H_ns multiplies the wind-driven term by 2^0.6366 = 1.55, and that the
  // procedural understorey generator must emit H_ns as a first-class field. This species is
  // where the eucalypt biome's H_ns comes from.
  heightM: hRange(0.3, 1.5), // Overlaps the Vesta H_ns validated range 5–40 cm at the low end.
  dbhM: dRange(0.005, 0.015),
  crownBaseFraction: [0.0, 0.0],
  crownBulkDensity: cbd(0.25, 1.25), // As Pteridium aquilinum below (§60 §7.3.2 derivation).
  crownWidthFraction: 0.9,
  foliarMoisture: fmcPct(200, 300), // §60 §7.3.2, green bracken fronds, congeneric.
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: kgm2(0.6), // §60 §7.3.2, cured bracken litter 0.30–1.20 kg m⁻²; midpoint.
  surfaceFuelModel: 'SH7', // §20 §4.3, "eucalypt understorey".
}

// ---------------------------------------------------------------------------
// UK mixed field & forest
//
// §60 §7.3 opens with "No published UK fuel model set exists. We build one and say so." The
// four broadleaves are the *structure*; §7.3.2's Calluna, bracken and gorse are the actual
// fire carriers, and §7.3.3 is explicit that in-leaf broadleaf woodland should SUPPRESS fire.
// The custom fuel model codes below (UK-*) are defined by WP 2.1 ("custom UK set", §91 M2).
// ---------------------------------------------------------------------------

const PEDUNCULATE_OAK: SpeciesDef = {
  id: 'quercus-robur',
  commonName: 'Pedunculate oak',
  scientificName: 'Quercus robur',
  biomes: ['uk-mixed-field-forest'],
  form: 'broadleaf',
  heightM: hRange(15, 32), // ESTIMATE, stand range.
  dbhM: dRange(0.22, 0.68), // ESTIMATE, stand range.
  crownBaseFraction: [0.25, 0.5], // ESTIMATE: woodland-grown form with a clear bole.
  crownBulkDensity: cbd(0.15, 0.55), // ESTIMATE, within-crown. Dense summer canopy.
  crownWidthFraction: 0.7, // ESTIMATE: broad-crowned.
  // §60 §7.3.3: "in leaf, foliar moisture 100–200 % and closure > 70 % give a wind adjustment
  // factor of 0.10–0.15 and near-permanent non-carrying status".
  foliarMoisture: fmcPct(100, 200),
  bark: 'furrowed',
  firebrandSource: false,
  litterLoad: kgm2(0.55), // §60 §7.3.2, broadleaf litter (oak/beech/ash) fine dead 0.30–0.80; midpoint.
  surfaceFuelModel: 'TL2', // §20 §4.3, "Broadleaf litter (UK)".
}

const ASH: SpeciesDef = {
  id: 'fraxinus-excelsior',
  commonName: 'Ash',
  scientificName: 'Fraxinus excelsior',
  biomes: ['uk-mixed-field-forest'],
  form: 'broadleaf',
  heightM: hRange(15, 32), // ESTIMATE, stand range.
  dbhM: dRange(0.16, 0.5), // ESTIMATE, stand range.
  crownBaseFraction: [0.3, 0.55], // ESTIMATE: ash carries a high, light crown.
  crownBulkDensity: cbd(0.1, 0.35), // ESTIMATE, within-crown. Ash canopy is notably open.
  crownWidthFraction: 0.55, // ESTIMATE.
  foliarMoisture: fmcPct(100, 200), // §60 §7.3.3.
  bark: 'furrowed',
  firebrandSource: false,
  litterLoad: kgm2(0.55), // §60 §7.3.2.
  surfaceFuelModel: 'TL2', // §20 §4.3.
}

const BEECH: SpeciesDef = {
  id: 'fagus-sylvatica',
  commonName: 'Beech',
  scientificName: 'Fagus sylvatica',
  biomes: ['uk-mixed-field-forest'],
  form: 'broadleaf',
  heightM: hRange(18, 38), // ESTIMATE, stand range.
  dbhM: dRange(0.22, 0.68), // ESTIMATE, stand range.
  crownBaseFraction: [0.3, 0.6], // ESTIMATE: heavy shade-caster, self-prunes in closed stands.
  crownBulkDensity: cbd(0.2, 0.6), // ESTIMATE, within-crown. The densest UK broadleaf canopy.
  crownWidthFraction: 0.6, // ESTIMATE.
  foliarMoisture: fmcPct(100, 200), // §60 §7.3.3.
  bark: 'smooth',
  firebrandSource: false,
  litterLoad: kgm2(0.55), // §60 §7.3.2.
  surfaceFuelModel: 'TL2', // §20 §4.3.
}

const SILVER_BIRCH: SpeciesDef = {
  id: 'betula-pendula',
  commonName: 'Silver birch',
  scientificName: 'Betula pendula',
  biomes: ['uk-mixed-field-forest'],
  form: 'broadleaf',
  heightM: hRange(10, 24), // ESTIMATE: a pioneer, shorter-lived and shorter than the others.
  dbhM: dRange(0.1, 0.37), // ESTIMATE, stand range.
  crownBaseFraction: [0.2, 0.45], // ESTIMATE.
  crownBulkDensity: cbd(0.08, 0.3), // ESTIMATE, within-crown. Light, airy crown.
  crownWidthFraction: 0.45, // ESTIMATE.
  foliarMoisture: fmcPct(100, 200), // §60 §7.3.3.
  bark: 'papery', // The characteristic peeling white bark.
  // No obtainable source claims UK birch spotting, and §60 §7.3 documents no UK spotting
  // mechanism at all. §0.7.1: leave false rather than guess, despite the suggestive bark class.
  firebrandSource: false,
  litterLoad: kgm2(0.4), // §60 §7.3.2 broadleaf litter range, low end: birch litter is sparse.
  surfaceFuelModel: 'TL2', // §20 §4.3.
}

const HEATHER: SpeciesDef = {
  id: 'calluna-vulgaris',
  commonName: 'Heather (ling)',
  scientificName: 'Calluna vulgaris',
  biomes: ['uk-mixed-field-forest'],
  form: 'shrub',
  // §60 §7.3.2 depth column across the growth cycle: pioneer 0.10–0.20 m, early building
  // 0.187, tall building 0.381, mature 0.557, degenerate 0.5–0.8 m. §7.3.2 note: "Calluna age
  // class matters more than anything else" — which the age-driven allometry reproduces
  // directly, since height here IS the age class.
  heightM: hRange(0.1, 0.8),
  dbhM: dRange(0.005, 0.025), // ESTIMATE: basal stem diameter.
  crownBaseFraction: [0.0, 0.1], // Continuous shrub fuel; degenerate stands go gappy at the base.
  // Derived from §60 §7.3.2: live load / depth by age class — early building 0.624/0.187 =
  // 3.34, mature 1.214/0.557 = 2.18, tall building 0.259/0.381 = 0.68, degenerate
  // (1.0–1.8)/(0.5–0.8) = 1.25–3.6 kg m⁻³.
  crownBulkDensity: cbd(0.7, 3.4),
  crownWidthFraction: 1.2, // ESTIMATE from growth habit.
  // §60 §7.3.2 note: measured spread thresholds put fine green at 47–65 %; Davies & Legg find
  // line ignitions fail above ~70 % and develop rapidly below ~60 % live FMC. That is the
  // bracket used here.
  foliarMoisture: fmcPct(60, 120),
  bark: 'fibrous',
  firebrandSource: false,
  // §60 §7.3.2, mature Calluna: fine dead 0.220 + moss/litter 1.019 kg m⁻². The note is
  // emphatic that omitting the moss/litter layer underpredicts badly (R² = 0.50 with it in,
  // over 27 experimental burns), so it is included here rather than in a separate field.
  litterLoad: kgm2(1.24),
  surfaceFuelModel: 'UK-CALLUNA', // Custom UK set, built by WP 2.1 (§91 M2 row 2.1).
}

const GORSE: SpeciesDef = {
  id: 'ulex-europaeus',
  commonName: 'Gorse',
  scientificName: 'Ulex europaeus',
  biomes: ['uk-mixed-field-forest'],
  form: 'shrub',
  heightM: hRange(1.5, 4.0), // §60 §7.3.2, gorse depth column 1.5–4.0 m.
  dbhM: dRange(0.02, 0.1), // ESTIMATE: basal stem diameter.
  // §60 §7.3.2: "Gorse is the UK crown-fire analogue. It carries fire in the elevated dead
  // layer independently of surface fuels." Vertically continuous, so no meaningful CBH — the
  // same statement §30 §7.1 makes about chaparral, and §7.3.2 routes gorse through the
  // chaparral single-crowning-layer closure for exactly this reason.
  crownBaseFraction: [0.0, 0.1],
  // Derived from §60 §7.3.2: live load 1.5–4.0 kg m⁻² over depth 1.5–4.0 m. The extremes of
  // that table (4.0/1.5 = 2.67, 1.5/4.0 = 0.375) bracket the range used.
  crownBulkDensity: cbd(0.4, 2.7),
  crownWidthFraction: 1.0, // ESTIMATE from growth habit.
  // ESTIMATE (declared). §60 §7.3.2 gives gorse ELEVATED DEAD thresholds — ignition fails
  // above 36 %, spread only below 19 % — but no live foliar moisture. Those dead thresholds
  // are the numbers the fire model should gate on; this live range is an estimate.
  foliarMoisture: fmcPct(60, 140),
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: kgm2(0.8), // §60 §7.3.2: gorse elevated dead 0.4–1.2 kg m⁻²; midpoint.
  surfaceFuelModel: 'SH7', // §20 §4.3 names SH7 for gorse explicitly.
}

const BRACKEN: SpeciesDef = {
  id: 'pteridium-aquilinum',
  commonName: 'Bracken',
  scientificName: 'Pteridium aquilinum',
  biomes: ['uk-mixed-field-forest'],
  form: 'fern',
  heightM: hRange(0.8, 1.8), // §60 §7.3.2, green fronds depth 0.8–1.8 m.
  dbhM: dRange(0.005, 0.015),
  crownBaseFraction: [0.0, 0.0],
  // Derived from §60 §7.3.2: green frond live load 0.4–1.0 kg m⁻² over 0.8–1.8 m depth
  // → 0.22–1.25 kg m⁻³.
  crownBulkDensity: cbd(0.25, 1.25),
  crownWidthFraction: 0.9,
  // §60 §7.3.2: green fronds live 200–300 % → non-carrying. §7.3.2 note: "Bracken is a switch,
  // not a curve" — cured frond litter in Mar–Apr and Oct–Nov is among the most flammable UK
  // fuels; green summer fronds are effectively fireproof. That phenology switch is WP 5.x's;
  // this range is the green state it switches out of.
  foliarMoisture: fmcPct(200, 300),
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: kgm2(0.6), // §60 §7.3.2, cured bracken litter 0.30–1.20 kg m⁻²; midpoint.
  surfaceFuelModel: 'UK-BRACKEN', // Custom UK set, WP 2.1.
}

const PURPLE_MOOR_GRASS: SpeciesDef = {
  id: 'molinia-caerulea',
  commonName: 'Purple moor grass',
  scientificName: 'Molinia caerulea',
  biomes: ['uk-mixed-field-forest'],
  form: 'grass',
  heightM: hRange(0.3, 0.6), // §60 §7.3.2, Molinia cured depth 0.3–0.6 m.
  dbhM: dRange(0.002, 0.006),
  crownBaseFraction: [0.0, 0.0],
  // Derived from §60 §7.3.2: cured load 0.50–1.20 kg m⁻² over 0.3–0.6 m → 0.83–4.0 kg m⁻³.
  // §7.3.2 note: these loads are 1.7–4× the Canadian FBP reference 0.30 kg m⁻², which is one
  // concrete reason the unmodified FWI/FBP mapping mis-ranks UK grass-moor fires.
  crownBulkDensity: cbd(0.8, 3.0),
  crownWidthFraction: 0.8,
  foliarMoisture: fmcPct(30, 120), // §20 §4.3 dynamic load-transfer bracket (cured → green).
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: kgm2(0.8), // §60 §7.3.2, Molinia cured 0.50–1.20 kg m⁻²; midpoint.
  surfaceFuelModel: 'UK-MOLINIA', // Custom UK set, WP 2.1.
}

const IMPROVED_PASTURE: SpeciesDef = {
  id: 'lolium-perenne',
  commonName: 'Improved pasture (perennial ryegrass)',
  scientificName: 'Lolium perenne',
  biomes: ['uk-mixed-field-forest'],
  form: 'grass',
  heightM: hRange(0.05, 0.15), // §60 §7.3.2, improved pasture grazed, depth 0.05–0.15 m.
  dbhM: dRange(0.002, 0.004),
  crownBaseFraction: [0.0, 0.0],
  // Derived from §60 §7.3.2: live 0.15–0.45 kg m⁻² over 0.05–0.15 m → 1.0–9.0 kg m⁻³. Upper
  // end capped: a grazed sward is a thin dense mat, but 9 kg m⁻³ is the arithmetic corner of
  // two independent ranges rather than an observed pairing.
  crownBulkDensity: cbd(1.0, 4.0),
  crownWidthFraction: 0.7,
  foliarMoisture: fmcPct(150, 250), // §60 §7.3.2, improved pasture grazed, "live 150–250 %".
  bark: 'fibrous',
  firebrandSource: false,
  litterLoad: kgm2(0.06), // §60 §7.3.2, improved pasture fine dead 0.02–0.10 kg m⁻²; midpoint.
  surfaceFuelModel: 'GR1', // §20 §4.3, "Grass, UK pasture".
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_SPECIES: readonly SpeciesDef[] = [
  PONDEROSA_PINE,
  DOUGLAS_FIR,
  GAMBEL_OAK,
  ARIZONA_FESCUE,
  BUR_OAK,
  BIG_BLUESTEM,
  LITTLE_BLUESTEM,
  CHAMISE,
  MANZANITA,
  CEANOTHUS,
  MESSMATE_STRINGYBARK,
  JARRAH,
  MANNA_GUM,
  AUSTRAL_BRACKEN,
  PEDUNCULATE_OAK,
  ASH,
  BEECH,
  SILVER_BIRCH,
  HEATHER,
  GORSE,
  BRACKEN,
  PURPLE_MOOR_GRASS,
  IMPROVED_PASTURE,
]

export const SPECIES_BY_ID: ReadonlyMap<string, SpeciesDef> = new Map(
  ALL_SPECIES.map((sp) => [sp.id, sp]),
)

export function speciesById(id: string): SpeciesDef {
  const sp = SPECIES_BY_ID.get(id)
  if (sp === undefined) throw new Error(`Unknown species id: ${id}`)
  return sp
}

export function speciesForBiome(biome: BiomeId): readonly SpeciesDef[] {
  return ALL_SPECIES.filter((sp) => sp.biomes.includes(biome))
}
