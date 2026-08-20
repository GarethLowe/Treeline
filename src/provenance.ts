/**
 * Every model's validation status, in one table. Spec §0.7.4 makes this a product requirement:
 * the HUD shows the weakest contributor to anything it displays, and "no provenance registered"
 * must not look like "provenance is fine".
 *
 * Full references, known biases and open questions live in `docs/spec/_provenance-notes.md`.
 */

/**
 * A full reference. The validation harness carries these per benchmark case — the model table
 * only needs the short form, but a published case has to say exactly where its number came from.
 */
export interface Citation {
  readonly ref: string
  readonly full: string
  /** Where in the source. "somewhere in this paper" is not a citation. */
  readonly locator: string
  readonly url?: string
}

export type ValidationStatus = 'validated' | 'calibrated' | 'substituted' | 'estimated'

export interface ModelRecord {
  readonly id: string
  /** The HUD groups by this and reports each group's weakest member. */
  readonly subsystem: string
  readonly name: string
  readonly status: ValidationStatus
  /** Short form, e.g. "Rothermel 1972". */
  readonly ref: string
  /** Where in the source. "somewhere in this paper" is not a citation. */
  readonly locator: string
  readonly url?: string
}

/** Worst first: a composite is only as good as its weakest part. */
const ORDER: readonly ValidationStatus[] = ['estimated', 'substituted', 'calibrated', 'validated']

export const MODELS: readonly ModelRecord[] = [
  { id: "wind-limit-ros-rail", subsystem: "Surface fire behaviour", name: "Spread-rate sanity rail R_head <= U_eff", status: "substituted",
    ref: "Andrews, Cruz & Rothermel 2013", locator: "Abstract (full text paywalled; restated in RMRS-GTR-371 §3.2.7 p. 25)", url: "https://www.frames.gov/catalog/16000" },
  { id: "fuel-models-sb40", subsystem: "Surface fire behaviour", name: "Scott & Burgan (2005) standard fire behavior fuel models", status: "calibrated",
    ref: "Scott & Burgan 2005", locator: "Table 5 (fuel model parameters) and Appendix A; dynamic curing transfer §3.4", url: "https://www.fs.usda.gov/rm/pubs/rmrs_gtr153.pdf" },
  { id: "fuel-models-anderson13", subsystem: "Surface fire behaviour", name: "Anderson (1982) 13 original fire behavior fuel models", status: "calibrated",
    ref: "Anderson 1982", locator: "Table 1, fuel models 1-13", url: "https://www.fs.usda.gov/rm/pubs_int/int_gtr122.pdf" },
  { id: "fuel-models-uk", subsystem: "Surface fire behaviour", name: "UK heath, moor and farmland fuel set", status: "estimated",
    ref: "ForestFire spec §60 §7.3.2", locator: "Table of UK fuel carriers: loads, depths, assigned SAV, spread-threshold FMC" },
  { id: "fuel-model-uk-gorse", subsystem: "Surface fire behaviour", name: "UK gorse (Ulex europaeus) via SH7", status: "substituted",
    ref: "ForestFire spec §60 §7.3.2", locator: "Table of UK fuel carriers: loads, depths, assigned SAV, spread-threshold FMC" },
  { id: "anderson-1983-length-to-breadth", subsystem: "Surface fire behaviour", name: "Anderson (1983) fire length-to-breadth ratio", status: "calibrated",
    ref: "Anderson 1983", locator: "Eq. 17, p. 7 — \"l/w = 0.936 EXP(0.1147U) + 0.461 EXP(-0.0692U) where U = windspeed at 1.5 ft or midflame miles per hour\". Cross-checks: Eq. 18 same page; fig. 6 same page.", url: "https://www.frames.gov/documents/behaveplus/publications/Anderson_1983_INT-RP-305_ocr.pdf" },
  { id: "acr-2013-spread-rate-rail", subsystem: "Surface fire behaviour", name: "Andrews, Cruz & Rothermel (2013) spread-rate sanity rail", status: "substituted",
    ref: "Andrews, Cruz & Rothermel 2013", locator: "Abstract — recommends limiting rate of spread to the effective midflame wind speed in place of the 0.9·I_R wind limit.", url: "https://www.frames.gov/catalog/16000" },
  { id: "level-set-propagation", subsystem: "Front propagation", name: "Narrow-band level-set front propagation with an elliptical support-function Hamiltonian", status: "validated",
    ref: "Osher & Sethian 1988", locator: "The level-set formulation itself." },
  { id: "michalsky-solar-position", subsystem: "Sky & solar position", name: "Solar position (Michalsky 1988 / Astronomical Almanac low-precision)", status: "validated",
    ref: "Michalsky 1988", locator: "Eqs. 1-13" },
  { id: "erbs-haurwitz-irradiance", subsystem: "Sky & solar position", name: "Direct/diffuse irradiance split (Haurwitz clear sky, Kasten-Czeplak cloud, Erbs split)", status: "calibrated",
    ref: "Haurwitz 1946", locator: "clear-sky global horizontal fit" },
  { id: "preetham-sky", subsystem: "Sky & solar position", name: "Analytic daylight sky (Preetham/Perez)", status: "substituted",
    ref: "Preetham et al. 1999", locator: "Appendix A.1-A.2 (zenith values and distribution coefficients)" },
  { id: "twilight-illuminance", subsystem: "Sky & solar position", name: "Twilight and night-sky illuminance sequence", status: "calibrated",
    ref: "Brown 1952", locator: "400 lx at 0 deg, 3.4 lx at -6 deg, 0.008 lx at -12 deg, 0.0008 lx at -18 deg" },
  { id: "schlyter-moon", subsystem: "Sky & solar position", name: "Lunar position, phase and moonlight", status: "calibrated",
    ref: "Schlyter", locator: "moon orbital elements and the 12 + 5 + 2 perturbation terms" },
  { id: "vegetation-species-table", subsystem: "Vegetation & placement", name: "Biome species parameter table (WP 1.3)", status: "calibrated",
    ref: "Scott & Burgan 2005", locator: "Fuel model table, as transcribed in docs/spec/20-surface-spread.md §4.3", url: "https://www.fs.usda.gov/rm/pubs/rmrs_gtr153.pdf" },
  { id: "vegetation-allometry", subsystem: "Vegetation & placement", name: "Per-stem allometry: age → height → DBH → crown (WP 1.3)", status: "estimated",
    ref: "McMahon 1973", locator: "Elastic similarity result, used here only as the FORM of the height–diameter law" },
  { id: "vegetation-placement", subsystem: "Vegetation & placement", name: "Terrain-modulated seeded stem placement (WP 1.3)", status: "estimated",
    ref: "Weiss 2001", locator: "TPI definition (elevation minus neighbourhood mean elevation)" },
  { id: "vegetation-ladder-fuel", subsystem: "Vegetation & placement", name: "Fuel-strata-gap ladder-fuel test (WP 1.3)", status: "estimated",
    ref: "Van Wagner 1977", locator: "Initiation and active-crowning criteria, as transcribed in docs/spec/30-canopy-heat-crown.md §7.1" },
  { id: "tree-space-colonisation", subsystem: "Tree geometry", name: "Space-colonisation branching skeleton", status: "calibrated",
    ref: "Runions et al. 2007", locator: "Sec. 3, \"The space colonization algorithm\"", url: "http://algorithmicbotany.org/papers/colonization.egwnp2007.html" },
  { id: "tree-pipe-model", subsystem: "Tree geometry", name: "Pipe-model branch radii (da Vinci exponent 2.3)", status: "calibrated",
    ref: "Shinozaki et al. 1964", locator: "Part I, pp. 97-105" },
  { id: "tree-foliage-sla", subsystem: "Tree geometry", name: "Specific leaf area and foliage-card coverage", status: "estimated",
    ref: "ForestFire spec §7.5", locator: "Step 6, foliage element sizing" },
  { id: "rothermel-surface", subsystem: "Surface fire behaviour", name: "Rothermel (1972) surface fire spread", status: "validated",
    ref: "Rothermel 1972", locator: "Eqs. 12, 14, 24, 27, 29, 30, 36, 37, 42, 47-51, 88", url: "https://www.fs.usda.gov/rm/pubs_int/int_rp115.pdf" },
  { id: "byram-intensity", subsystem: "Surface fire behaviour", name: "Byram (1959) fireline intensity and flame length", status: "calibrated",
    ref: "Byram 1959", locator: "Fireline intensity I = H·w·R; flame length L = 0.0775·I^0.46" },
  { id: "midflame-waf", subsystem: "Surface fire behaviour", name: "Albini & Baughman (1979) wind adjustment factor", status: "validated",
    ref: "Albini & Baughman 1979", locator: "Midflame wind adjustment factor, sheltered and unsheltered forms", url: "https://www.fs.usda.gov/rm/pubs_int/int_rp221.pdf" },
  { id: "wind-limit-none", subsystem: "Surface fire behaviour", name: "No hard wind limit (author-recommended default)", status: "calibrated",
    ref: "Andrews 2018 (RMRS-GTR-371)", locator: "§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)", url: "https://research.fs.usda.gov/treesearch/download/55928.pdf" },
  { id: "length-to-breadth-behaveplus", subsystem: "Surface fire behaviour", name: "Length-to-breadth ratio, BehavePlus form", status: "substituted",
    ref: "Andrews 2018 (RMRS-GTR-371)", locator: "§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)", url: "https://research.fs.usda.gov/treesearch/download/55928.pdf" },
  { id: "canopy-voxel-store", subsystem: "Canopy storage", name: "Sparse canopy voxel store (per-column runs) and crown voxelisation", status: "calibrated",
    ref: "ForestFire spec §30 §7.2", locator: "§7.2 brick pool sizing and the OPEN QUESTION this package closes" },
  { id: "canopy-foliage-optics", subsystem: "Canopy storage", name: "Leaf area density and extinction from crown bulk density", status: "estimated",
    ref: "Rothermel 1972", locator: "Oven-dry fuel particle density ρ_p = 32 lb ft⁻³ (= 512.6 kg m⁻³), used throughout", url: "https://www.fs.usda.gov/rm/pubs_int/int_rp115.pdf" },
  { id: "canopy-ignition-massflux-threshold", subsystem: "Canopy kinetics", name: "Critical-mass-flux ignition gate, inverted to a temperature threshold", status: "validated",
    ref: "McAllister, Finney & Cohen 2010", locator: "Table 1 — dry poplar at 1 m/s: t_ig = 75.3 / 30.0 / 16.7 / 9.7 s at 20 / 30 / 40 / 50 kW m^-2; critical mass flux 1.288 / 1.527 / 1.733 / 2.193 g m^-2 s^-1", url: "https://research.fs.usda.gov/treesearch/39357" },
  { id: "canopy-moisture-heat-sink", subsystem: "Canopy kinetics", name: "Moisture evaporation heat sink and drying front", status: "validated",
    ref: "NIST Chemistry WebBook", locator: "dvapH = 40.65 kJ/mol at the normal boiling point; M = 18.01528 g/mol -> 2.2564e6 J/kg", url: "https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185&Mask=4" },
  { id: "canopy-pyrolysis-kinetics-grishin", subsystem: "Canopy kinetics", name: "Single-step Arrhenius pyrolysis and evaporation kinetics (Grishin lineage)", status: "estimated",
    ref: "ForestFire spec §30 §7.6", locator: "Kinetics table and the honesty flag; the statement that Grishin's own pairs are pyrolysis A = 3.63e4 s^-1 with E/R = 9400 K and evaporation A = 6e5 K^1/2 s^-1 with E/R = 6000 K" },
  { id: "canopy-radiation-optics", subsystem: "Canopy radiation", name: "Turbid-medium canopy extinction and grey emissivity", status: "calibrated",
    ref: "Nilson 1971", locator: "Eq. 1-3, the Poisson gap model that gives P0 = exp(-G*LAI/cos(theta))" },
  { id: "flame-grey-emitter", subsystem: "Canopy radiation", name: "Grey flame sheet, emissivity from optical depth", status: "estimated",
    ref: "Frankman et al. 2013", locator: "Field radiometry of flame emissive power and radiant fraction", url: "https://www.fs.usda.gov/treesearch/pubs/43325" },
  { id: "canopy-radiation-transport", subsystem: "Canopy radiation", name: "Next-event-estimation gather over a clustered emitter list", status: "substituted",
    ref: "Siegel & Howell", locator: "Grey-medium radiative transfer; divergence of radiative flux = kappa*(G - 4*sigma*T^4)" },
  { id: "canopy-plume-mtt-line", subsystem: "Canopy convection", name: "MTT line-plume rise (Gaussian convention)", status: "calibrated",
    ref: "Richardson & Hunt 2022", locator: "Eq. (7.1) — Gaussian, line plume: alpha = 0.11 +/- 15 %, lambda = 1.2 fixed. Sec. 3 — the convention-independent observables asserted by the CI regression. Best single measurement alpha = 0.108 +/- 2 %; curated spread 0.095-0.13.", url: "https://doi.org/10.1017/jfm.2021.1070" },
  { id: "canopy-plume-convective-fraction", subsystem: "Canopy convection", name: "Convective fraction of fireline intensity (chi_c = 0.6)", status: "estimated",
    ref: "ForestFire spec §6.4", locator: "Convective fraction chi_c = 0.5-0.7 of Byram I_B; stability dtheta/dz defaults 0.02 / 0.035 K/m" },
  { id: "canopy-convective-coefficient", subsystem: "Canopy convection", name: "Convective heat transfer coefficient (Churchill-Bernstein, cylinder in crossflow)", status: "calibrated",
    ref: "Churchill & Bernstein 1977", locator: "The single continuous correlation Nu = 0.3 + 0.62 Re^1/2 Pr^1/3 / [1+(0.4/Pr)^2/3]^1/4 · [1+(Re/282000)^5/8]^4/5, valid Re·Pr > 0.2. Reproduced verbatim in spec §7.5." },
  { id: "van-wagner-crown", subsystem: "Crown fire", name: "Van Wagner (1977) crown fire initiation and active crowning", status: "validated",
    ref: "Van Wagner 1977", locator: "Crown initiation I_0 = (0.01·CBH·(460+25.9·FMC))^1.5; critical mass flow rate S_0 = 0.05 kg m^-2 s^-1; the three-way surface/passive/active/independent classification", url: "https://www.frames.gov/catalog/5319" },
  { id: "firebrand-drag", subsystem: "Firebrands", name: "Orientation-averaged drag, non-spherical brands", status: "validated",
    ref: "Bagheri & Bonadonna 2016", locator: "Eq. 14, Eq. 27-28, Table 5; §5.1.2 Fig. 13; §5.2.3 Figs. 19-20", url: "https://arxiv.org/abs/1810.08787" },
  { id: "firebrand-size-measured", subsystem: "Firebrands", name: "Brand size, areal density and burnout — conifer and eucalypt", status: "calibrated",
    ref: "Manzello et al. 2009", locator: "pp. 25, 27, 29 — all collected brands cylindrical, 3-5 mm x 34-53 mm", url: "https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=861421" },
  { id: "firebrand-size-estimated", subsystem: "Firebrands", name: "Brand size — grassland, chaparral, UK mixed", status: "estimated",
    ref: "Hedayati et al. 2019", locator: "Table 1 — median m/a = 0.159/0.288/0.468 kg/m2 at low/medium/high wind", url: "https://www.frontiersin.org/articles/10.3389/fmech.2019.00043/full" },
  { id: "firebrand-generation", subsystem: "Firebrands", name: "Brand generation rate from component mass loss", status: "estimated",
    ref: "Adusumilli, Chaplen & Blunck 2021", locator: "specific firebrand production per kg dry mass burned; sagebrush ~6x ponderosa at comparable MC; production rises exponentially with decreasing moisture over 15-60% MC", url: "https://www.frontiersin.org/articles/10.3389/fmech.2021.655593/full" },
  { id: "firebrand-ignition", subsystem: "Firebrands", name: "Landing ignition probability (logistic surrogate)", status: "estimated",
    ref: "Ellis 2011", locator: "glowing 0.5-1.6 g stringybark brands ignite P. radiata litter at 2-8% MC; the f_glow = 0.20 burnout floor is anchored here" },
  { id: "albini-spot-envelope", subsystem: "Firebrands", name: "Albini spotting models (calibration harness, not the runtime model)", status: "calibrated",
    ref: "Albini 1983", locator: "§1.2 loft height and §1.4 flat-terrain deposition, as coded in BehavePlus", url: "https://www.fs.usda.gov/rm/pubs_int/int_rp309.pdf" },
  { id: "smoke-soot-yield", subsystem: "Smoke & volumetrics", name: "Smoke particulate yield per kg of fuel consumed", status: "estimated",
    ref: "Andreae 2019", locator: "Table 1 (PM2.5 emission factors by biome) — NOT READ, see openQuestions", url: "https://acp.copernicus.org/articles/19/8523/2019/" },
  { id: "smoke-composition", subsystem: "Smoke & volumetrics", name: "Smoke composition endmembers (EC/OC by combustion regime)", status: "calibrated",
    ref: "Reid et al. 2005", locator: "Section 2.4, p. 834 — flaming-dominated omega_0 = 0.75, smouldering 0.90", url: "https://acp.copernicus.org/articles/5/827/2005/" },
  { id: "blackbody-emission", subsystem: "Smoke & volumetrics", name: "Blackbody flame colour (Planck integrated against CIE 1931)", status: "validated",
    ref: "Wyman et al. 2013", locator: "Multi-lobe piecewise-Gaussian fit, Table 1", url: "https://jcgt.org/published/0002/02/01/" },
  { id: "canadian-fwi", subsystem: "Fire weather", name: "Canadian Forest Fire Weather Index System (FFMC, DMC, DC, ISI, BUI, FWI)", status: "calibrated",
    ref: "Van Wagner 1987", locator: "Equations for FFMC, DMC, DC, ISI, BUI and FWI" },
  { id: "fwi-size-class-crosswalk", subsystem: "Fire weather", name: "FWI codes to timelag-class fuel moisture", status: "estimated",
    ref: "ForestFire spec §6.7", locator: "\"This cross-walk is our own construction and is not a validated published mapping\"" },
]

export function weakestStatus(models: readonly ModelRecord[]): ValidationStatus {
  let worst: ValidationStatus = 'validated'
  for (const m of models) {
    if (ORDER.indexOf(m.status) < ORDER.indexOf(worst)) worst = m.status
  }
  return worst
}

/** Upper-cased for the two statuses a reader must not skim past. */
export const statusLabel = (s: ValidationStatus): string =>
  s === 'estimated' || s === 'substituted' ? s.toUpperCase() : s

export interface ProvenanceGroup {
  readonly subsystem: string
  readonly models: readonly ModelRecord[]
  readonly status: ValidationStatus
}

export function provenanceGroups(): readonly ProvenanceGroup[] {
  const by = new Map<string, ModelRecord[]>()
  for (const m of MODELS) {
    const list = by.get(m.subsystem)
    if (list === undefined) by.set(m.subsystem, [m])
    else list.push(m)
  }
  return [...by].map(([subsystem, models]) => ({ subsystem, models, status: weakestStatus(models) }))
}

/** Weakest status across everything. What the HUD's one-line summary shows. */
export const overallStatus = (): ValidationStatus => weakestStatus(MODELS)

/** The HUD's per-subsystem lines. */
export const provenanceLines = (): readonly string[] =>
  provenanceGroups().map(
    (g) => `${g.subsystem.padEnd(24)}${statusLabel(g.status)} (${g.models.length} models)`,
  )

/** The `?debug` dump: every model, grouped, with its primary locator. */
export function provenanceReport(): string {
  const out: string[] = []
  for (const g of provenanceGroups()) {
    out.push(`${g.subsystem} — ${statusLabel(g.status)}`)
    for (const m of g.models) {
      out.push(`  [${m.status}] ${m.name}`)
      out.push(`      ${m.ref} — ${m.locator}`)
    }
    out.push('')
  }
  out.push('Full references and open questions: docs/spec/_provenance-notes.md')
  return out.join(String.fromCharCode(10))
}
