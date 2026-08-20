# Near-flame smoke optics  (status: partially-closed)

## [corrected] omega_0 is reduced to ~0.70 within 30 m of flame (spec §7.1.2 table, flagged as 'a modelling choice, not a cited value').

**Correct value:** No free source supports 0.70 as a distance-keyed value, and the directly measured near-fire number is higher. Kleinman et al. 2020 (BBOP, nine pseudo-Lagrangian wildfire flights): 'Near-fire aerosol had a single scatter albedo (SSA) of 0.8-0.9.' Sect. 4.3: 'The lowest SSAs observed were 0.8 to 0.85 in fresh smoke', with an independent MISR retrieval showing 'SSA increases from < 0.84 near the source to 0.92'. The broader phase-resolved range is Reid et al. 2005 Sect. 2.4, p. 834: 'mid-visible omega_0 values increasing from 0.65 to 0.85 in ignition/flaming to values of 0.8 to 0.9 and 0.88 to 0.99 for mixed phase and smoldering phase combustion, respectively'. RECOMMENDED near-flame value: omega_0(550) = 0.76 for a fully flaming-dominated parcel (see the two-endmember rule below), not 0.70.

**Citation:** Kleinman, L. I., et al. (2020), 'Rapid evolution of aerosol particles and their optical properties downwind of wildfires in the western US', Atmos. Chem. Phys. 20:13319-13341, Abstract and Sect. 4.3 p. 13332-13333, doi:10.5194/acp-20-13319-2020, https://acp.copernicus.org/articles/20/13319/2020/acp-20-13319-2020.pdf . Reid, J. S., et al. (2005), ACP 5:827-849, Sect. 2.4 p. 834, https://acp.copernicus.org/articles/5/827/2005/acp-5-827-2005.pdf

## [corrected] A 30 m distance threshold is the right switch between 'near-flame' and 'aged' smoke optics.

**Correct value:** REFUTED as a physical mechanism. Measured aging is far too slow to produce any variation inside a 1 km domain. Reid et al. 2005 Sect. 2.4 p. 834, citing Abel et al. 2003: 'an increase in omega_0 by 0.04 in two hours (from 0.84 to 0.88), and by 0.06 in 5 hours (from 0.84 to 0.90) due to the condensation of organic matter.' Reid Sect. 5 p. 843 defines the regimes: "by 'fresh' we imply smoke that is <=5 min old. 'Aged smoke' can encompass smoke that is from an hour to several days old." A 1 km domain at 1-10 m/s is traversed in 100-1000 s (1.7-17 min), i.e. entirely inside Reid's 'fresh' regime, over which the aging-driven change in omega_0 is < 0.01 — below the quantisation of an r16float field and far below the +-0.05 measurement uncertainty. CONSEQUENCE: the whole domain is fresh smoke; the spec has the regimes inverted, using aged column values as the default and fresh only within 30 m. Delete the distance switch entirely.

**Citation:** Reid, J. S., et al. (2005), ACP 5:827-849, Sect. 2.4 p. 834 (Abel et al. 2003 aging rate) and Sect. 5 p. 843 (fresh/aged definitions), doi:10.5194/acp-5-827-2005, https://acp.copernicus.org/articles/5/827/2005/acp-5-827-2005.pdf

## [corrected] The biome split (omega_0 = 0.95 conifer/boreal vs 0.88 grass/shrub) is a usable rule; mixed-fuel fires and biome boundaries are undefined.

**Correct value:** DELETE the biome switch. Pokhrel et al. 2016 Abstract states the governing result directly: 'SSA and AAE cannot be directly predicted based on fuel type because they depend strongly on burn conditions.' Their EC/(EC+OC) parameterisation instead spans 12 fuels (Indonesian peat, African grass, crop residue, US brushwood, coniferous trees; 41 burns) with a single linear fit at Pearson r = 0.94-0.97. Biome enters ONLY through how much flaming vs smouldering a fuel produces, never as a direct optical branch. The spec's ordering (conifer brighter than grass) is correct in SIGN — Reid Table 5 p. 843 gives fresh-smoke omega_0(550) = 0.88 +- 0.05 temperate/boreal forest vs 0.821 +- 0.05 grass/savanna (0.85 +- 0.05 tropical forest) — but the spec's magnitudes are 0.06-0.07 too HIGH because they are aged column-AERONET values applied to a fresh-smoke domain.

**Citation:** Pokhrel, R. P., et al. (2016), 'Parameterization of single-scattering albedo (SSA) and absorption Angstrom exponent (AAE) with EC/OC for aerosol emissions from biomass burning', Atmos. Chem. Phys. 16:9549-9561, Abstract and Sect. 2.1, doi:10.5194/acp-16-9549-2016, https://acp.copernicus.org/articles/16/9549/2016/acp-16-9549-2016.pdf . Reid et al. (2005), ACP 5:827-849, Table 5 p. 843.

## [confirmed] (New — the replacement rule.) There is no documented, non-distance-thresholded way to interpolate between fresh and aged smoke optics.

**Correct value:** THERE IS ONE, and it is a published linear fit. Let f = EC/(EC+OC) = black/elemental carbon mass fraction of the carbonaceous aerosol in the froxel. Pokhrel et al. 2016 Fig. 4 panels (a)(b)(c), equations printed in-panel:
  SSA(405 nm) = 0.91 (+-0.01) - 0.87 (+-0.04) * f,  r = -0.97
  SSA(532 nm) = 0.98 (+-0.01) - 1.01 (+-0.05) * f,  r = -0.97
  SSA(660 nm) = 0.99 (+-0.02) - 1.07 (+-0.07) * f,  r = -0.96
All fits constrained to SSA <= 1 (Sect. 3.2). Linearly interpolating the published coefficients to the spec's channel wavelengths (this interpolation is mine, the coefficients are theirs):
  R 600 nm: omega_0 = 0.985 - 1.042 f
  G 550 nm: omega_0 = 0.981 - 1.018 f
  B 450 nm: omega_0 = 0.935 - 0.920 f
f is exactly what the sim can carry: flaming combustion emits EC-rich aerosol, smouldering emits OC-rich. Pokhrel Sect. 3.1: 'more BC and less OC is produced during the flaming part of a burn when MCE is highest, while more OC and less BC is produced during the smoldering part of a burning when MCE is lowest.'

**Citation:** Pokhrel, R. P., et al. (2016), ACP 16:9549-9561, Fig. 4 (p. 9555, in-panel fit equations), Sect. 3.2 and Sect. 3.1, doi:10.5194/acp-16-9549-2016, https://acp.copernicus.org/articles/16/9549/2016/acp-16-9549-2016.pdf

## [confirmed] (New.) Endmember values needed to drive f from the sim's flaming/smouldering split.

**Correct value:** Reid et al. 2005 Sect. 2.4 p. 834 gives both endmembers explicitly, at 550 nm, per unit dry PM mass:
  FLAMING-dominated:    sigma_s = 3.4 m2/g, sigma_a = 1.1 m2/g  ->  omega_0 = 0.75 (verbatim: 'we would expect a mean omega_0 value of 0.75')
  SMOULDERING-dominated: sigma_s = 3.7 m2/g, sigma_a = 0.4 m2/g  ->  omega_0 = 0.90 (verbatim: 'we would expect a mean omega_0 value of 0.90')
Arithmetic check: 3.4/4.5 = 0.756 and 3.7/4.1 = 0.902 — the quoted values are internally consistent. Inverting through the Pokhrel 550 nm fit gives the source-term f values to emit: f_flaming = 0.22, f_smouldering = 0.08.
Supporting phase-resolved absorption, same page: sigma_a = 0.9-1.1 m2/g flaming; 0.6-1.0 m2/g mixed phase; 0.2-0.7 m2/g smouldering-dominated; '<0.3 m2 g-1' purely smouldering.

**Citation:** Reid, J. S., et al. (2005), ACP 5:827-849, Sect. 2.4 p. 834, doi:10.5194/acp-5-827-2005, https://acp.copernicus.org/articles/5/827/2005/acp-5-827-2005.pdf

## [confirmed] (New.) Wavelength dependence of absorption must be a separate, composition-dependent exponent.

**Correct value:** Pokhrel et al. 2016 Fig. 4d: AAE = 1.00 (+-0.45) - 2.07 (+-0.36) * log10(EC/(EC+OC)),  r = -0.79 (fitted over 405/532/660 nm). This is a strong result for the renderer because it is self-validating at the endpoint: at f = 1 (pure black carbon) it returns AAE = 1.00 exactly, matching Bond & Bergstrom's independent recommendation for pure light-absorbing carbon ('Absorption cross section may be assumed to depend inversely on wavelength throughout the visible spectrum', Sect. 9.1). Two unrelated literatures converge on the same limit.
IMPORTANT: the spec does NOT need to evaluate this equation. I verified numerically that applying the single extinction Angstrom exponent alpha = 1.76 to sigma_t, combined with the per-channel Pokhrel omega_0 fits above, reproduces AAE(f) automatically to within 5% over f = 0.08-0.40 (implied vs Pokhrel: 3.39 vs 3.27 at f=0.08; 2.61 vs 2.71 at f=0.15; 2.25 vs 2.36 at f=0.22; 1.84 vs 1.82 at f=0.40). The spec's current alpha = 1.6 degrades this agreement to ~10%.

**Citation:** Pokhrel, R. P., et al. (2016), ACP 16:9549-9561, Fig. 4d (p. 9555), doi:10.5194/acp-16-9549-2016. Bond, T. C. and Bergstrom, R. W. (2006), 'Light Absorption by Carbonaceous Particles: An Investigative Review', Aerosol Sci. Technol. 40:27-67, Sect. 9.1 'Wavelength dependence', p. 57; free full text at https://lweb.cfa.harvard.edu/HITRAN/HITRAN2012/Aerosols/papers/bond_aerscitech_2006.pdf

## [corrected] Extinction Angstrom exponent alpha = 1.6, cited to Sayer et al. 2014 Table 4 as 'alpha = 1.42-1.97 across ten AERONET sites (mean 1.76)'.

**Correct value:** The CITATION is exact — I recomputed from Sayer Table 4: alpha = 1.95, 1.42, 1.91, 1.88, 1.89, 1.62, 1.66, 1.97, 1.54, 1.74 across Alta Floresta, Bonanza Creek, Cuiaba, Jabiru, Mongu, Moscow, Mukdahan, Skukuza, Tomsk, Yakutsk; range 1.42-1.97, mean 1.758. The alpha_abs values are 1.78, 2.20, 1.68, 1.62, 1.43, 1.92, 1.43, 1.66, 1.95, 1.99, range 1.43-2.20 — also exact. But the spec's CHOSEN value of 1.6 is unexplained and sits below the mean. USE alpha = 1.76, which is the site mean AND is the value that makes the omega_0/AAE scheme self-consistent (finding above). Caveat to carry: Sayer Table 4 caption states these are computed at tau_f,550 = 0.5 and tau_c,550 = 0.03 and 'will vary for different AOD'.

**Citation:** Sayer, A. M., Hsu, N. C., Eck, T. F., Smirnov, A., and Holben, B. N. (2014), 'AERONET-based models of smoke-dominated aerosol near source regions and transported over oceans...', Atmos. Chem. Phys. 14:11493-11523, Table 4 p. 11501, doi:10.5194/acp-14-11493-2014, https://acp.copernicus.org/articles/14/11493/2014/acp-14-11493-2014.pdf

## [confirmed] Fresh combustion soot near flame: refractive index, albedo, asymmetry, cross-sections (question item 1).

**Correct value:** Bond & Bergstrom 2006 Sect. 9.1/9.2 recommendations for FRESH light-absorbing carbon (pure LAC, not whole smoke):
  refractive index m = 1.95 - 0.79i at 550 nm; void-fraction line ~1.8 - 0.74i (Fig. 9 caption). They explicitly retire the common m = 1.74 - 0.44i: 'The value commonly used by climate modelers (m = 1.74-0.44i at 550 nm) represents none of the possible refractive indices and should be retired.'
  MAC = 7.5 +- 1.2 m2/g at 550 nm ('the average is that of 17 measurements', Sect. 7.3)
  omega_0 = 0.20-0.30, central 0.25 (Sect. 9.1, Table 7) -> implied MSC = 2.5 m2/g, MEC = 10.0 m2/g at 550 nm
  backscatter fraction b = 0.16-0.18 (Schnaiter et al. 2003) -> Henyey-Greenstein g = 0.48-0.52 (I inverted b = (1-g^2)/(2g)*[1/sqrt(1+g^2) - 1/(1+g)] numerically; b=0.16 -> g=0.522, b=0.17 -> g=0.502, b=0.18 -> g=0.482)
  density 1.7-1.9 g/cm3, use 1.8; 'the use of 1.0 g/cm3 should be abandoned'
  refractive index constant across 400-700 nm; absorption ~ lambda^-1 (AAE = 1)
  coating enhancement on aging: factor ~1.5 on absorption
NOTE these are for the BC component only. Whole near-flame wildland smoke is >90% organic (Kleinman 2020 Abstract: 'On all transects more than 90 % of aerosol is organic'), which is why whole-plume omega_0 is 0.8-0.9, not 0.25.

**Citation:** Bond, T. C. and Bergstrom, R. W. (2006), Aerosol Sci. Technol. 40:27-67; Sect. 7.3 p. 52 (MAC), Sect. 7.2 p. 51 (refractive index), Fig. 9 caption p. 52, Sect. 9.1 pp. 56-57 (all recommendations), free full text https://lweb.cfa.harvard.edu/HITRAN/HITRAN2012/Aerosols/papers/bond_aerscitech_2006.pdf . Chakrabarty, R. K., et al. (2014), Sci. Rep. 4:5508, Methods/Fig. 7 caption, also adopts m = 1.95-0.79i with 50 nm monomers at 550 nm, https://www.nature.com/articles/srep05508

## [confirmed] K_633 = 8700 m2 kg-1 (flaming soot); 3500-5000 (mixed wildland smoke), cited to Mulholland & Croarkin 2000.

**Correct value:** CONFIRMED with a public-domain locator, and the mass basis is now pinned. NIST FDS Technical Reference Guide (NIST SP 1018, Vol. 1), Sect. 9 'Fire Detection Devices', p. 89, immediately after Eq. (9.6): 'For most flaming fuels, a suggested value for K_m is 8700 m2/kg +- 1100 m2/kg at a wavelength of 633 nm [100]', where ref [100] is Mulholland & Croarkin, Fire and Materials 24:227-230 (2000). In Eq. (9.6) the mass basis is Y_c, the mass fraction of SMOKE — so 8700 is per unit smoke mass from flaming combustion of wood/plastics, which is soot-dominated, NOT per unit wildland smoke PM.
CROSS-VALIDATION (independent literatures): Bond MAC 7.5 m2/g at 550 with omega_0 = 0.25 gives MEC = 10.0 m2/g at 550; scaling by Bond's own lambda^-1 to 632.8 nm gives 8.69 m2/g vs the NIST 8.7 +- 1.1. (If scattering is instead scaled lambda^-4 the result is 7.95 m2/g — still inside 8.7 +- 1.1.) The two agree within stated uncertainty either way.
The primary Mulholland & Croarkin paper itself is paywalled at Wiley; the NIST FDS guide is the free, public-domain equivalent that documents the same value and I used it in place of the paywalled original.

**Citation:** McGrattan, K., et al., 'Fire Dynamics Simulator Technical Reference Guide, Volume 1: Mathematical Model', NIST Special Publication 1018-1, Sect. 9, p. 89 (text following Eq. 9.6), ref [100] p. 156, https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1018e6.pdf

## [corrected] (New — mass-basis correction to K.) sigma_t = K_633 * rho_s with K_633 = 8700 applied to the sim's soot field.

**Correct value:** This is ~2x too opaque if rho_s is total smoke aerosol mass rather than the soot/EC component. Reid et al. 2005 Table 5 (550 nm, dry) gives total mass extinction efficiency sigma_s + sigma_a for every column: IPCC fresh 4.14, IPCC aged 4.05, grass/savanna fresh 4.40, grass/savanna aged 4.65, tropical fresh 4.20, tropical aged 4.70, temperate/boreal fresh 4.30, temperate/boreal aged 4.70 m2/g. Mean 4.4, full range 4.05-4.70 m2/g — REMARKABLY INVARIANT across biome and age. Scaled to 633 nm at alpha = 1.76 this is ~3440 m2/kg, consistent with the spec's own quoted 3500-5000 band for mixed wildland smoke and with FDS's 4000-5000 m2/kg for smouldering/pyrolysis smoke.
RECOMMENDED: K_550 = 4400 m2 kg-1 (range 4050-4700) if rho_s is total dry smoke PM; K_550 = 10000 m2 kg-1 (K_633 = 8700) only if rho_s is strictly the EC/soot component. Pick one and label the field accordingly. The near-invariance of total extinction is a useful renderer simplification: combustion phase moves the sigma_s/sigma_a SPLIT, not the total.

**Citation:** Reid, J. S., et al. (2005), ACP 5:827-849, Table 5 p. 843, 'Likely optical properties for dry biomass-burning smoke at 550 nm' (I reconstructed the column-to-row mapping from the two-column PDF layout and verified it by checking omega_0 = sigma_s/(sigma_s+sigma_a) against the table's own SSA row on all eight columns — all eight agree to <=0.004).

## [confirmed] g = 0.65, single value, cited to Sayer et al. 2014 Table 4 (g = 0.66-0.71 at 440 nm, 0.61-0.67 at 675 nm).

**Correct value:** CONFIRMED — the spec's g = 0.65 survives, and is the one number here that needs no change. Sayer Table 4 ten-site means: g(440) = 0.689, g(675) = 0.641 (I recomputed from the ten site rows). Linear in lambda this gives aged g = 0.687 (450 nm), 0.667 (550), 0.656 (600). Reid et al. 2005 Sect. 5 p. 844 gives the fresh correction: g 'should be taken from the Dubovik et al. (2002) climatology... for aged smoke... These values should be considered upper limits for fresh smoke, which... should be 0.02 to 0.04 lower' -> fresh g = 0.657 (B), 0.637 (G), 0.626 (R).
Reid Table 5 p. 843 gives lower fresh values: grass/savanna 0.55 +- 0.06, tropical 0.59 +- 0.06, temperate/boreal 0.60 +- 0.06 (aged 0.58/0.63/0.65). RECOMMEND g(550) = 0.63 +- 0.06 for fresh smoke, ONE value, NO biome split and NO f-dependence — the biome spread (0.05) is smaller than the stated uncertainty (+-0.06), so a biome split in g is not resolved by the data. The spec's 0.65 is inside +-0.06 of every free source; keep it if churn is a concern. Reid p. 844 cautions that g 'has never been measured directly and presented in the literature' and rests on 'a few backscatter ratio measurements'.

**Citation:** Sayer, A. M., et al. (2014), ACP 14:11493-11523, Table 4 p. 11501 (g columns at 440/675/870/1020 nm for 10 sites). Reid, J. S., et al. (2005), ACP 5:827-849, Sect. 5 p. 844 (fresh-vs-aged g offset) and Table 5 p. 843 (per-biome fresh/aged g).

## [confirmed] (New.) If any aging term is kept, what should it act on?

**Correct value:** Apply aging to SCATTERING ONLY; hold mass-specific absorption fixed. Kleinman et al. 2020 Abstract: 'As absorption remained nearly constant with age, the time evolution of single scatter albedo was controlled by age-dependent scattering.' Sect. 4.3: 'on seven of nine flights, absorption per unit mass of aerosol is either independent of or decreases slightly with age.' Rate: mass scattering efficiency 'increased in 2 h by 56 %' (Abstract), 'average increase is 56 % with a standard deviation of 20 % and range 33 % to 97 %' (Sect. 4.3). Mechanism per Reid Sect. 5 p. 844: coagulation, condensation of organics, and collapse of chain aggregates raise sigma_s.
Over a 1 km domain (<=17 min) this is a <8% change in sigma_s and is safely NEGLECTED. Recorded here so that if the domain is ever extended, the correct term is known and is a scattering-only growth of +56%/2 h, not an omega_0 ramp.

**Citation:** Kleinman, L. I., et al. (2020), ACP 20:13319-13341, Abstract and Sect. 4.3 p. 13332, doi:10.5194/acp-20-13319-2020, https://acp.copernicus.org/articles/20/13319/2020/acp-20-13319-2020.pdf

## [unconfirmed] A distance-resolved (or metre-scale plume-age-resolved) near-flame SSA profile exists and can be cited.

**Correct value:** NOT FOUND in the free literature, and I believe it does not exist. The finest-grained published resolution is (a) COMBUSTION-PHASE resolved (Reid 2005: ignition/flaming 0.65-0.85, mixed 0.8-0.9, smouldering 0.88-0.99) and (b) PLUME-AGE resolved at 5-60 minute granularity from aircraft (Kleinman 2020; near-fire 0.8-0.9). Nothing resolves the first ~30 m / first few seconds of a plume, because the region is inaccessible to aircraft and too hot and optically thick for the in-situ extinction cells and photoacoustic instruments used in all of these campaigns. Reid Sect. 5 p. 843 offers only the anecdote 'The authors have observed forest fires with extremely dark plumes, omega_0 ~ 0.35' — no instrument, no locator, not usable. This sub-question should be closed as unanswerable-as-posed and replaced by the composition-keyed rule, which is measurable and measured.

**Citation:** Searched: ACP/AMT/ESSD (Copernicus open access), NIST NVL public repository, NOAA CSL FIREX-AQ publication list (https://csl.noaa.gov/projects/firex-aq/science/pubs.html), NASA ESD/ESPO publication mirrors, PMC/Sci. Rep. open access. Negative result. Nearest free bounds: Reid et al. (2005) ACP 5:827-849 Sect. 2.4 p. 834 and Sect. 5 p. 843; Kleinman et al. (2020) ACP 20:13319 Abstract.

## [unconfirmed] Near-source g remains genuinely uncertain (Ahern et al. 2025 find real refractive indices larger than commonly assumed).

**Correct value:** COULD NOT VERIFY — paywalled with no free equivalent found. Ahern et al. (2025), 'Direct Measurements and Implications of the Aerosol Asymmetry Parameter in Wildfire Smoke During FIREX-AQ', J. Geophys. Res. Atmos. 130, doi:10.1029/2024JD042091, is behind the Wiley paywall. I did not attempt to bypass it. I checked the NOAA CSL FIREX-AQ publications page, the NOAA institutional repository, NASA ESD/ESPO mirrors, and preprint servers for a free author copy or agency-report equivalent and found none. The spec's characterisation may well be right; it is simply not verifiable from free sources at this time. KEEP it in the spec as an explicitly unverified caveat on g, do NOT let any number be derived from it, and note that the recommended g = 0.63 +- 0.06 already carries an uncertainty band wide enough to absorb a moderate revision.

**Citation:** Ahern, A. T., et al. (2025), J. Geophys. Res. Atmos. 130, e2024JD042091, doi:10.1029/2024JD042091 — PAYWALLED (Wiley). Free-source search of NOAA CSL FIREX-AQ pubs list, NOAA repository, NASA ESPO/ESD, and preprint servers returned no open version.

## RECOMMENDATION

REPLACE the distance threshold and the biome switch with ONE composition-keyed rule. Both authored guesses go away; nothing branches.

THE RULE. The sim advects two carbon scalars instead of one soot field: m_EC and m_OC (or equivalently rho_total plus the mass-weighted scalar f). Define per froxel f = m_EC/(m_EC + m_OC). Source terms per cell per step, from the flaming/smouldering mass-loss split the solver already computes:
  flaming mass loss     -> emit aerosol with f_src = 0.22   (Reid 2005 p. 834: sigma_s 3.4, sigma_a 1.1, omega_0 0.75)
  smouldering mass loss -> emit aerosol with f_src = 0.08   (Reid 2005 p. 834: sigma_s 3.7, sigma_a 0.4, omega_0 0.90)
Then per froxel, per channel:
  omega_0,R = clamp(0.985 - 1.042 f, 0, 1)     (600 nm)
  omega_0,G = clamp(0.981 - 1.018 f, 0, 1)     (550 nm)
  omega_0,B = clamp(0.935 - 0.920 f, 0, 1)     (450 nm)
  sigma_t,c = K_550 * rho_total * (550/lambda_c)^alpha,  K_550 = 4400 m2 kg-1,  alpha = 1.76
  sigma_s,c = omega_0,c * sigma_t,c ;  sigma_a,c = (1 - omega_0,c) * sigma_t,c
  g = 0.63 (or per-channel 0.657/0.637/0.626 for B/G/R), single value, no biome split
Cost: one extra r16float field. Two shader FMAs replace the distance test and the biome branch.

WHY THIS AND NOT THE ALTERNATIVES THE QUESTION OFFERED. Temperature is wrong because it is a property of the parcel's current thermal state, not of the aerosol in it: a soot parcel cools by mixing in seconds while its composition is conserved, so a temperature-keyed omega_0 would make the same soot visibly change colour as it cools, which is unphysical. Soot volume fraction is wrong because it keys on concentration, not composition: a dilute flaming plume and a dense smouldering plume can carry identical soot density and have omega_0 differing by 0.15. Smoke age is wrong at this scale because the measured aging rate (+0.04 in 2 h, Reid p. 834) is negligible over the 1.7-17 min it takes to cross a 1 km domain. Composition is the only key that is both conserved under advection and actually correlated with the optics (r = 0.94-0.97, Pokhrel 2016).

BIOME BOUNDARIES AND MIXED FUELS. No special case is needed, and that is the whole point. f is a ratio of two conserved advected scalars, so mixing is linear by construction — a plume crossing a boundary or fed by mixed fuels simply carries the mass-weighted f. Biome must NOT appear in the optics; it enters only upstream, through how much flaming vs smouldering a fuel produces. If per-fuel refinement is wanted later, refine f_src, never omega_0. Pokhrel 2016 is explicit that fuel type is the wrong axis: 'SSA and AAE cannot be directly predicted based on fuel type because they depend strongly on burn conditions.'

CALIBRATION TARGET (this is how you check the solver, not a value to hardcode). With correct flaming/smouldering behaviour, a grass fire should land at effective f ~ 0.16 -> omega_0(550) ~ 0.82 and a conifer/boreal fire with heavy duff smouldering at f ~ 0.10 -> omega_0(550) ~ 0.88. Those reproduce Reid Table 5's measured fresh-smoke biome values (grass/savanna 0.821 +- 0.05, temperate/boreal 0.88 +- 0.05) as an EMERGENT result. The spec's old ordering was right; its magnitudes were 0.06-0.07 high. Directly over an active flame front, f approaches 0.22 and omega_0(550) falls to ~0.76 — the near-flame darkening the spec wanted, now sourced, continuous, and with no 30 m cliff.

VALIDATION STATUS TO CARRY. Mark omega_0 and its wavelength dependence CALIBRATED — the functional form and coefficients are measured (Pokhrel 2016, r = 0.94-0.97, 12 fuels, 41 burns) and the endmembers are measured (Reid 2005), but the mapping from the solver's flaming/smouldering split to f_src is a project-side calibration against the two targets above. Mark alpha = 1.76 and K_550 = 4400 VALIDATED (Sayer Table 4 ten-site mean; Reid Table 5 range 4050-4700). Mark g = 0.63 +- 0.06 ESTIMATED, not validated: Reid p. 844 states plainly that g 'has never been measured directly and presented in the literature' and rests on a few backscatter-ratio measurements, and the one modern direct measurement (Ahern 2025) is paywalled with no free equivalent. Keep the spec's existing Ahern caveat verbatim and let no number depend on it.

THREE THINGS TO FIX WHILE YOU ARE IN THERE. (1) alpha: change 1.6 -> 1.76. It is the Sayer ten-site mean the spec already cites, and it is what makes the scheme self-consistent — I verified that alpha = 1.76 plus the per-channel omega_0 fits reproduces Pokhrel's independent AAE(f) fit to within 5% across f = 0.08-0.40, while alpha = 1.6 drifts to ~10%. So the renderer gets brown-carbon reddening for free and never evaluates a log. (2) K and its mass basis: 8700 m2/kg is confirmed public-domain (NIST SP 1018-1 p. 89, after Eq. 9.6) but it is per unit FLAMING-COMBUSTION SMOKE mass, which is soot-dominated. Wildland smoke is >90% organic (Kleinman 2020), and its total mass extinction is 4.4 m2/g at 550 nm. If rho_s is total smoke PM, 8700 makes the plume roughly twice as opaque as measured. Label the field explicitly and pick the matching K. (3) IMPLEMENTATION TRAP: never blend omega_0 itself as a mass-weighted scalar — it is a ratio, and mass-averaging ratios is wrong. Mix sigma_s and sigma_a separately (or mix f, which is a proper mass ratio), then form omega_0 = sigma_s/(sigma_s + sigma_a).

FALLBACK LADDER, with bias directions stated. If the solver cannot split flaming from smouldering per cell, use Pokhrel Table 1 (p. 9554), SSA = k0 + k1*MCE^k2 with k0/k1/k2 = 0.920/-0.632/26.877 at 405 nm, 0.933/-1.637/58.492 at 532, 0.941/-1.687/56.45 at 660 — but this is measurably inferior (r = 0.64 vs 0.96) and its known bias is that it fails hardest exactly where it matters, at MCE > 0.92 'where SSA changes rapidly'. If even MCE is unavailable, use a single fresh-smoke omega_0(550) = 0.85 (midpoint of Kleinman's measured near-fire 0.8-0.9) with no near-flame reduction and no biome split; the stated bias is then too bright directly over the flame front and too dark in the smouldering tail, bounded by Reid's phase range 0.65-0.99 — a known bias that can be named in the UI, which is what the project's policy asks for. Do NOT retain 0.70-at-30 m under any of these branches: it is unsourced in magnitude and refuted in mechanism.
