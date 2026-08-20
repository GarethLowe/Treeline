/**
 * WP 3.2 — thermophysical and kinetic constants for canopy ignition and pyrolysis.
 *
 * Spec §7.6. Everything here is CPU-side and precomputed into LUTs before it reaches a
 * shader, so per spec §0.5.1 there is no accuracy/cost trade to make on any of these
 * numbers: a correct constant and a wrong one cost exactly the same at runtime. They are
 * therefore transcribed to full published precision.
 *
 * **Units.** SI throughout (spec §0.6). Energies are J, J/kg or J/m3 — NOT MJ — because the
 * one place this module could plausibly go wrong by 10^6 is a mixed MJ/J heat balance, and
 * making every energy a raw joule removes the opportunity. Temperatures are kelvin.
 * Moisture is a fraction of oven-dry mass.
 *
 * **The kinetics lineage.** Spec §7.6 flags that its own kinetics table pairs Grishin's
 * pre-exponentials with activation energies from a different lineage, and that this is a
 * ~36x error in pyrolysis rate at 600 K. That is real and it is asserted in
 * `test/sim/canopy/kinetics/kinetics.test.ts`. This module ships Grishin's OWN self-consistent
 * pairs — A and E/R both from the same source for each stage — and exports the rejected
 * mixed values under `MIXED_LINEAGE_*` names for the regression test only. Never import those
 * for anything but the test.
 */

// ---------------------------------------------------------------------------
// Universal
// ---------------------------------------------------------------------------

/** CODATA 2018. Exact by the 2019 SI redefinition of k_B. */
export const STEFAN_BOLTZMANN = 5.670374419e-8 // W m^-2 K^-4
/** CODATA 2018. Exact by the 2019 SI redefinition. */
export const GAS_CONSTANT = 8.31446261815324 // J mol^-1 K^-1

// ---------------------------------------------------------------------------
// Water — the evaporation heat sink (spec §7.6, "Moisture as heat sink")
// ---------------------------------------------------------------------------

/**
 * Latent heat of vaporisation of water at the normal boiling point, 373.124 K / 101.325 kPa.
 *
 * NIST Chemistry WebBook gives dvapH = 40.65 kJ/mol at the normal boiling point; with the
 * standard molar mass 18.01528 g/mol that is 2.25642e6 J/kg, i.e. 2.2564e6 at the four
 * significant figures the published dvapH carries. The spec quotes 2.26e6, which is
 * the same number to three figures. This is the single largest term in the canopy energy
 * balance for moist fuel and it is free to get exactly right.
 */
export const WATER_LATENT_HEAT = 2.2564e6 // J/kg
/** Normal boiling point of water. IAPWS / ITS-90: 373.124 K (the familiar 373.15 is on IPTS-68). */
export const WATER_BOILING_K = 373.124 // K
/**
 * Specific heat of liquid water, mean over 300-373 K. IAPWS-95 gives 4180 J/kg/K at 300 K and
 * 4216 at 373 K; the mean over the heating interval is 4190. The spec quotes 4186 (the
 * thermochemical-calorie value at 288 K), which is inside the 1% spread of the property over
 * the interval. 4190 is used because it is the correct mean for the integral this module
 * actually evaluates.
 */
export const WATER_SPECIFIC_HEAT = 4190 // J/kg/K
/**
 * Extra desorption enthalpy for bound water, over and above the free-water latent heat.
 * Spec §7.6: "~0.3 MJ/kg". `estimated` — no primary source was obtained for the figure.
 *
 * Spec §7.6 also has it released over 373-450 K rather than isothermally; `evaporation.ts`
 * releases it at the boiling point and documents why that is observationally identical here.
 */
export const BOUND_WATER_DESORPTION_HEAT = 3.0e5 // J/kg
/** Fibre saturation point: moisture above this is free water, below it is bound. Spec §7.6, "~30% MC". */
export const FIBRE_SATURATION_MOISTURE = 0.30 // fraction of oven-dry mass

// ---------------------------------------------------------------------------
// Solid fuel
// ---------------------------------------------------------------------------

/** Dry wood/foliage specific heat. Spec §7.6 worked examples use 1500 J/kg/K throughout. */
export const SOLID_SPECIFIC_HEAT = 1500 // J/kg/K
/** Char specific heat. Roughly 1100 J/kg/K for wood char near 700 K. `estimated`. */
export const CHAR_SPECIFIC_HEAT = 1100 // J/kg/K
/** Thermal conductivity of moist wood across the grain. Spec §7.6: k_s ~= 0.20 W/m/K. */
export const SOLID_CONDUCTIVITY = 0.20 // W/m/K
/** Oven-dry particle density. Spec §7.6 uses 500 kg/m3 for the tau and diffusivity examples. */
export const SOLID_DENSITY = 500 // kg/m3

/**
 * Heat of pyrolysis, endothermic. Spec §7.6 table: -0.42 MJ/kg. Same table as the kinetics,
 * so it carries the same `estimated` status — no primary source was obtained.
 *
 * For scale: Sullivan (2009) §2, reporting di Blasi (1998) and Ball et al. (1999), gives TRUE
 * cellulose volatilisation as endothermic at ~3.0e5 J/kg and char formation as exothermic at
 * ~1.0e6 J/kg. 4.2e5 sits between them, which is what an effective lumped value should do.
 */
export const PYROLYSIS_HEAT = 4.2e5 // J/kg, endothermic (positive = energy consumed)

/** Char mass yield from pyrolysis. `estimated`; does not affect ignition delay. */
export const CHAR_YIELD = 0.20 // kg char per kg dry solid pyrolysed

// ---------------------------------------------------------------------------
// Kinetics — ONE lineage, Grishin (1997), both members of each pair from that source
// ---------------------------------------------------------------------------

/**
 * Free-water evaporation, Grishin's own pair:
 *   mdot_w = -A_w * m_w * T^(-1/2) * exp(-E_w/(R T))
 * Spec §7.6: "Grishin's own pairs are ... evaporation A = 6e5 K^1/2 s^-1 with E/R = 6000 K
 * (E = 49.9 kJ/mol)". Note the T^-1/2 in the rate law — that is why A carries K^1/2.
 */
export const EVAPORATION_A = 6.0e5 // K^1/2 s^-1
export const EVAPORATION_E_OVER_R = 6000 // K

/**
 * Pyrolysis, Grishin's own pair:
 *   mdot_s = -A_p * m_s * exp(-E_p/(R T))
 * Spec §7.6: "Grishin's own pairs are pyrolysis A = 3.63e4 s^-1 with E/R = 9400 K
 * (E = 78.1 kJ/mol)".
 */
export const PYROLYSIS_A = 3.63e4 // s^-1
export const PYROLYSIS_E_OVER_R = 9400 // K

/**
 * The REJECTED mixed-lineage activation energies from the spec §7.6 table. Exported solely so
 * `kinetics.test.ts` can assert the size of the error they cause and fail if anyone
 * reintroduces them. Importing these outside that test is a bug.
 */
export const MIXED_LINEAGE_PYROLYSIS_E_OVER_R = 7250 // K — do not use
export const MIXED_LINEAGE_EVAPORATION_E_OVER_R = 5800 // K — do not use

// ---------------------------------------------------------------------------
// Ignition
// ---------------------------------------------------------------------------

/**
 * Critical mass flux for sustained flaming ignition of dead, DRY woody fuel.
 *
 * Mean of McAllister, Finney & Cohen's four measured dry-poplar points at 1 m/s oxidiser flow
 * over 20-50 kW/m2 external radiant flux (1.288, 1.527, 1.733, 2.193 g/m2/s -> mean 1.685);
 * the companion 2011 paper's 0.2%-MC row gives 1.305/1.430/1.749/1.875 -> mean 1.590. The two
 * independent series average 1.64.
 *
 * The measured envelope across BOTH papers and all moisture contents is 1.29-2.98 g/m2/s, so
 * the spec's 2.5 g/m2/s is a real measured value but sits at the wettest, highest-flux corner.
 * A dry value is the right default here because this gate is only reached after the voxel's
 * free water is gone — the moisture dependence is carried explicitly by the drying stage
 * rather than by inflating this constant, which would double-count it.
 */
export const CRITICAL_MASS_FLUX = 1.64e-3 // kg/m2/s
/** Measured envelope of the above across McAllister's full (flux x moisture) matrix. */
export const CRITICAL_MASS_FLUX_RANGE = [1.29e-3, 2.98e-3] as const // kg/m2/s

/**
 * Piloted-ignition surface temperature band for wood, from Dietenberger (1996) FPL: 290-356 C
 * derived across LIFT and cone-calorimeter tests, varying with moisture content. Used as a
 * sanity rail on the mass-flux-derived ignition temperature, not as the criterion itself.
 */
export const IGNITION_TEMPERATURE_BAND_K = [563.15, 629.15] as const // K

/**
 * The folkloric "T_ig ~ 600 K" cheap early-out from spec §7.6. Kept ONLY as an early-out: at
 * canopy bulk densities it corresponds to a pyrolysate flux ~7x below the measured critical
 * mass flux (asserted in ignition.test.ts), so used as the criterion it ignites early.
 */
export const EARLY_OUT_TEMPERATURE_K = 600 // K
