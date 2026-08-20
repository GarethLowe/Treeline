# Model provenance — full notes

Generated from the per-package records when they were collapsed into `src/provenance.ts` on 2026-08-20. The code carries id, status, subsystem and the primary locator; everything else — full references, known biases, open questions — lives here.

## Sky & solar position  
*owner: `render/sky`*

### Solar position (Michalsky 1988 / Astronomical Almanac low-precision)

- **id** `michalsky-solar-position` · **status** `validated`
- Michalsky 1988 — Michalsky, J.J. (1988). The Astronomical Almanac's algorithm for approximate solar position (1950-2050). Solar Energy 40(3):227-235. With the 1989 erratum, Solar Energy 41:113.  
  *Eqs. 1-13*
- Meeus 1998 — Meeus, J. (1998). Astronomical Algorithms, 2nd ed. Willmann-Bell.  
  *Ch. 7 (Julian day), Ch. 15 p. 102 (rise/set altitude), Eq. 16.4 (refraction)*
- **validated by** `test/render/sky/solar.test.ts` — <= 0.02 deg in elevation and azimuth against an independent NOAA-formulation implementation over a grid of dates, times and sites; the contract requires 0.1 deg

### Direct/diffuse irradiance split (Haurwitz clear sky, Kasten-Czeplak cloud, Erbs split)

- **id** `erbs-haurwitz-irradiance` · **status** `calibrated`
- Haurwitz 1946 — Haurwitz, B. (1946). Insolation in relation to cloudiness and cloud density. Journal of Meteorology 3:123-124.  
  *clear-sky global horizontal fit*
- Kasten & Czeplak 1980 — Kasten, F. and Czeplak, G. (1980). Solar and terrestrial radiation dependent on the amount and type of cloud. Solar Energy 24:177-189.  
  *G = G_clear (1 - 0.75 c^3.4)*
- Erbs et al. 1982 — Erbs, D.G., Klein, S.A. and Duffie, J.A. (1982). Estimation of the diffuse radiation fraction for hourly, daily and monthly-average global radiation. Solar Energy 28:293-302.  
  *hourly diffuse fraction correlation, three k_t branches*
- **OPEN:** Spec §6.5 applies the Kasten-Czeplak cloud reduction to extraterrestrial rather than clear-sky irradiance, which yields ~1140 W/m2 clear-sky noon DNI. A clear-sky model (Haurwitz) is inserted ahead of it here; see the note in solar.ts.

### Analytic daylight sky (Preetham/Perez)

- **id** `preetham-sky` · **status** `substituted`
- Preetham et al. 1999 — Preetham, A.J., Shirley, P. and Smits, B. (1999). A Practical Analytic Model for Daylight. SIGGRAPH 1999, 91-100.  
  *Appendix A.1-A.2 (zenith values and distribution coefficients)*
- Perez et al. 1993 — Perez, R., Seals, R. and Michalsky, J. (1993). All-weather model for sky luminance distribution. Solar Energy 50(3):235-245.  
  *five-parameter luminance distribution*
- **substituted for** hosek-wilkie-2012: Hosek & Wilkie (2012) is the better model but ships as a ~1080-entry fitted dataset. Entering a thousand constants that cannot be checked line by line against an obtainable source is what §0.7.1 forbids; Preetham's twenty-odd printed coefficients can be.  
  **known bias:** Overpredicts luminance near the horizon and its chromaticity degrades below ~10 deg solar elevation (too yellow-green at sunset). Mitigated by driving absolute level from measured irradiance rather than from the model, and by easing turbidity down at low sun.

### Twilight and night-sky illuminance sequence

- **id** `twilight-illuminance` · **status** `calibrated`
- Brown 1952 — Brown, D.R.E. (1952). Natural Illumination Charts. US Navy Bureau of Ships, Report 374-1. Reproduced in the IES Lighting Handbook and in Schlyter, "Radiometry and photometry in astronomy".  
  *400 lx at 0 deg, 3.4 lx at -6 deg, 0.008 lx at -12 deg, 0.0008 lx at -18 deg*

### Lunar position, phase and moonlight

- **id** `schlyter-moon` · **status** `calibrated`
- Schlyter — Schlyter, P. Computing planetary positions — a tutorial with worked examples. Sections 4-13 (moon elements, perturbations, topocentric correction).  
  *moon orbital elements and the 12 + 5 + 2 perturbation terms*
- Allen 2000 — Allen's Astrophysical Quantities, 4th ed. (ed. A.N. Cox), Springer. Lunar magnitude-phase relation m = -12.73 + 1.49|phi| + 0.043 phi^4.  
  *lunar photometry table*

## Vegetation & placement  
*owner: `world/vegetation`*

### Biome species parameter table (WP 1.3)

- **id** `vegetation-species-table` · **status** `calibrated`
- Scott & Burgan 2005 — Scott, J.H. & Burgan, R.E. (2005). Standard Fire Behavior Fuel Models: A Comprehensive Set for Use with Rothermel’s Surface Fire Spread Model. USDA Forest Service RMRS-GTR-153.  
  *Fuel model table, as transcribed in docs/spec/20-surface-spread.md §4.3*  
  <https://www.fs.usda.gov/rm/pubs/rmrs_gtr153.pdf>
- Van Wagner 1977 — Van Wagner, C.E. (1977). Conditions for the start and spread of crown fire. Canadian Journal of Forest Research 7: 23–34.  
  *Initiation and active-crowning criteria, as transcribed in docs/spec/30-canopy-heat-crown.md §7.1*
- Cruz & Alexander 2014 — Cruz, M.G. & Alexander, M.E. (2014). Assessing the validity of crown fire initiation models. International Journal of Wildland Fire (as cited in the project specification).  
  *Validated foliar-moisture envelope FMC ≈ 95–135 %, docs/spec/30-canopy-heat-crown.md §7.1*
- Hutton 2021 / iForest 2024 — Scottish Fire Danger Rating System experimental burn series (Hutton 2021/22) and the northern-European generalised heathland fuel models, iForest 17: 109–119 (2024).  
  *UK fuel carrier table, docs/spec/60-regional-models.md §7.3.2*
- Countryman & Philpot 1970; Dennison & Moritz 2009; Weise et al. 2016 — Literature composite for mature chaparral stand structure and the live-fuel-moisture annual cycle, as assembled in the project specification.  
  *Mature stand parameter table, docs/spec/60-regional-models.md §7.2.3*
- Cheney et al. 2012 (Project Vesta); Hodgson 1967 — Cheney, N.P., Gould, J.S., McCaw, W.L. & Anderson, W.R. (2012). Predicting fire behaviour in dry eucalypt forest in southern Australia. Forest Ecology and Management 280: 120–131. Bark-class spotting mechanisms after Hodgson (1967).  
  *Bark classes and spotting behaviour, docs/spec/60-regional-models.md §7.1.3*
- Burns & Honkala 1990 — Burns, R.M. & Honkala, B.H. (tech. coords.) (1990). Silvics of North America, Volume 1: Conifers. USDA Forest Service Agriculture Handbook 654.  
  *Species accounts for Pinus ponderosa and Pseudotsuga menziesii (mature size ranges)*  
  <https://www.srs.fs.usda.gov/pubs/misc/ag_654/table_of_contents.htm>
- **OPEN:** Eucalypt foliar moisture content has no value anywhere in the specification; the range used is an engineering estimate (see ESTIMATED_SPECIES_FIELDS).
- **OPEN:** Crown base fraction has no obtainable per-species source. Ranges are reasoned from stand structure and the CBH sweep grid in §30 §7.7 step 3 (0.5–8 m over the height ranges used here), not transcribed.

### Per-stem allometry: age → height → DBH → crown (WP 1.3)

- **id** `vegetation-allometry` · **status** `estimated`
- McMahon 1973 — McMahon, T.A. (1973). Size and shape in biology. Science 179: 1201–1204. Elastic-similarity scaling for self-supporting columns, H ∝ D^(2/3).  
  *Elastic similarity result, used here only as the FORM of the height–diameter law*
- Richards 1959 — Richards, F.J. (1959). A flexible growth function for empirical use. Journal of Experimental Botany 10: 290–300. (Chapman–Richards growth form.)  
  *Growth-curve form only; the shape constants used here are not from this source*
- Burns & Honkala 1990 — Burns, R.M. & Honkala, B.H. (tech. coords.) (1990). Silvics of North America, Volume 1: Conifers. USDA Forest Service Agriculture Handbook 654.  
  *Species accounts for Pinus ponderosa and Pseudotsuga menziesii (mature size ranges)*  
  <https://www.srs.fs.usda.gov/pubs/misc/ag_654/table_of_contents.htm>
- **OPEN:** Chapman–Richards shape constants (k, p) per growth form are engineering estimates chosen so that a stem reaches ~90 % of mature height at age 0.75. No source.
- **OPEN:** The competition→crown-recession weighting is an engineering estimate. Real crown recession is driven by light extinction, which this package does not model.
- **OPEN:** Crown bulk density is interpolated within the species range rather than computed from a biomass equation. Jenkins et al. (2003) RMRS/NE-319 component equations would close this for the North American species; nothing equivalent exists for the UK set.

### Terrain-modulated seeded stem placement (WP 1.3)

- **id** `vegetation-placement` · **status** `estimated`
- Weiss 2001 — Weiss, A.D. (2001). Topographic Position and Landforms Analysis. Poster, ESRI User Conference. Defines the Topographic Position Index used here as a valley-bottom proxy.  
  *TPI definition (elevation minus neighbourhood mean elevation)*
- **OPEN:** Slope, aspect, elevation and valley-position weights are engineering estimates chosen for plausible landscape structure. They are deliberately excluded from every fire-behaviour derivation.

### Fuel-strata-gap ladder-fuel test (WP 1.3)

- **id** `vegetation-ladder-fuel` · **status** `estimated`
- Van Wagner 1977 — Van Wagner, C.E. (1977). Conditions for the start and spread of crown fire. Canadian Journal of Forest Research 7: 23–34.  
  *Initiation and active-crowning criteria, as transcribed in docs/spec/30-canopy-heat-crown.md §7.1*
- **OPEN:** BLOCKING BEFORE M3: the gap threshold (default 2.0 m) has no obtainable source. §30 §7.1 names Cruz’s fuel-strata-gap formulation as the calibration target for biomes outside the Van Wagner envelope; obtain Cruz et al. (2006) and replace BiomeLadderFuelConfig.gapThresholdM with the published criterion.

## Tree geometry  
*owner: `world/trees`*

### Space-colonisation branching skeleton

- **id** `tree-space-colonisation` · **status** `calibrated`
- Runions et al. 2007 — Runions, A., Lane, B., Prusinkiewicz, P. (2007). Modeling Trees with a Space Colonization Algorithm. Eurographics Workshop on Natural Phenomena.  
  *Sec. 3, "The space colonization algorithm"*  
  <http://algorithmicbotany.org/papers/colonization.egwnp2007.html>

### Pipe-model branch radii (da Vinci exponent 2.3)

- **id** `tree-pipe-model` · **status** `calibrated`
- Shinozaki et al. 1964 — Shinozaki, K., Yoda, K., Hozumi, K., Kira, T. (1964). A quantitative analysis of plant form — the pipe model theory. Japanese Journal of Ecology 14(3).  
  *Part I, pp. 97-105*
- **OPEN:** The 2.3 exponent is the value spec §7.5 step 5 prescribes; the source range in the literature is 2.0-2.5 and species-dependent.

### Specific leaf area and foliage-card coverage

- **id** `tree-foliage-sla` · **status** `estimated`
- ForestFire spec §7.5 — ForestFire design specification, docs/spec/70-rendering-audio.md §7.5 (procedural tree generation).  
  *Step 6, foliage element sizing*
- **OPEN:** SLA per species is an engineering estimate. It sets foliage card size and the leaf-area figure M3 radiative transfer will consume. It does NOT affect the derived-vs-declared crown bulk density check, because measure.ts divides by the same constant it multiplied by.

## Surface fire behaviour  
*owner: `sim/rothermel`*

### Rothermel (1972) surface fire spread

- **id** `rothermel-surface` · **status** `validated`
- Rothermel 1972 — Rothermel, R.C. 1972. A mathematical model for predicting fire spread in wildland fuels. USDA Forest Service Research Paper INT-115. Intermountain Forest and Range Experiment Station.  
  *Eqs. 12, 14, 24, 27, 29, 30, 36, 37, 42, 47-51, 88*  
  <https://www.fs.usda.gov/rm/pubs_int/int_rp115.pdf>
- Albini 1976 — Albini, F.A. 1976. Estimating wildfire behavior and effects. USDA Forest Service General Technical Report INT-30. Intermountain Forest and Range Experiment Station.  
  *Size-class weighting g_ij, p. 88; refit of the reaction-velocity exponent A*  
  <https://www.fs.usda.gov/rm/pubs_int/int_gtr030.pdf>
- Andrews 2018 (RMRS-GTR-371) — Andrews, P.L. 2018. The Rothermel surface fire spread model and associated developments: a comprehensive explanation. USDA Forest Service RMRS-GTR-371.  
  *§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)*  
  <https://research.fs.usda.gov/treesearch/download/55928.pdf>
- **validated by** `test/sim/rothermel/kernel.test.ts — "spec §4.2 acceptance test — GR2, scenario D2L2"` — R = 38 ft/min = 11.7 m/min = 35 ch/h to the quoted precision, plus sigma, rho_b, beta, beta_op, C, B, E, phi_w, live M_x and I_R each to the precision the spec quotes them at
- **OPEN:** Spec §4.4 states that using f_ij instead of Albini’s g_ij for net load "inflates I_R by 10-30%". The direction is wrong: g_ij >= f_ij by construction (each class takes its whole size-class bin sum), so f_ij under-predicts. The §4.2 acceptance value only reproduces with g_ij, which is what is implemented.

### Byram (1959) fireline intensity and flame length

- **id** `byram-intensity` · **status** `calibrated`
- Byram 1959 — Byram, G.M. 1959. Combustion of forest fuels. In: Davis, K.P., ed. Forest fire: control and use. New York: McGraw-Hill: 61-89.  
  *Fireline intensity I = H·w·R; flame length L = 0.0775·I^0.46*
- Anderson 1969 — Anderson, H.E. 1969. Heat transfer and fire spread. USDA Forest Service Research Paper INT-69.  
  *Flaming residence time t_r = 384/sigma*  
  <https://www.fs.usda.gov/rm/pubs_int/int_rp069.pdf>
- Andrews 2018 (RMRS-GTR-371) — Andrews, P.L. 2018. The Rothermel surface fire spread model and associated developments: a comprehensive explanation. USDA Forest Service RMRS-GTR-371.  
  *§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)*  
  <https://research.fs.usda.gov/treesearch/download/55928.pdf>
- **OPEN:** Flame length was fitted to grass and low-intensity fires and over-predicts above ~2 m in forest and shrub fuels (spec §4.7). Treat as a rendering cue there, not a measurement.

### Albini & Baughman (1979) wind adjustment factor

- **id** `midflame-waf` · **status** `validated`
- Albini & Baughman 1979 — Albini, F.A.; Baughman, R.G. 1979. Estimating windspeeds for predicting wildland fire behavior. USDA Forest Service Research Paper INT-221.  
  *Midflame wind adjustment factor, sheltered and unsheltered forms*  
  <https://www.fs.usda.gov/rm/pubs_int/int_rp221.pdf>
- Andrews 2018 (RMRS-GTR-371) — Andrews, P.L. 2018. The Rothermel surface fire spread model and associated developments: a comprehensive explanation. USDA Forest Service RMRS-GTR-371.  
  *§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)*  
  <https://research.fs.usda.gov/treesearch/download/55928.pdf>
- **validated by** `test/sim/rothermel/kernel.test.ts — "midflame wind adjustment (spec §4.5)"` — reproduces the three spec §4.5 sanity values (0.362, 0.547, 0.133) to 3 decimals

### No hard wind limit (author-recommended default)

- **id** `wind-limit-none` · **status** `calibrated`
- Andrews 2018 (RMRS-GTR-371) — Andrews, P.L. 2018. The Rothermel surface fire spread model and associated developments: a comprehensive explanation. USDA Forest Service RMRS-GTR-371.  
  *§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)*  
  <https://research.fs.usda.gov/treesearch/download/55928.pdf>
- Andrews, Cruz & Rothermel 2013 — Andrews, P.L.; Cruz, M.G.; Rothermel, R.C. 2013. Examination of the wind speed limit function in the Rothermel surface fire spread model. International Journal of Wildland Fire 22(7): 959-969. doi:10.1071/WF12122  
  *Abstract (full text paywalled; restated in RMRS-GTR-371 §3.2.7 p. 25)*  
  <https://www.frames.gov/catalog/16000>
- **validated by** `test/sim/rothermel/kernel.test.ts — "wind limit (spec §4.5)"` — Structural, not numeric: 0.9*I_R is computed and reported but never applied; the legacy toggle caps the WIND and re-evaluates R = R_0*(1 + phi_E(U_capped)) rather than clamping R, and acts before the elliptical decomposition so LB follows the capped wind. This is what firelab/behave does (surfaceFire.cpp:75, :250-295, :384-392).
- **OPEN:** GTR-371 §5.4.4 p. 83 quotes I_R ~ 156 BTU/ft2/min for its GR1 worked example, but the moisture scenario behind that number was not obtainable, so the value is not asserted here — asserting it would mean guessing the inputs that produce it.

### Length-to-breadth ratio, BehavePlus form

- **id** `length-to-breadth-behaveplus` · **status** `substituted`
- Andrews 2018 (RMRS-GTR-371) — Andrews, P.L. 2018. The Rothermel surface fire spread model and associated developments: a comprehensive explanation. USDA Forest Service RMRS-GTR-371.  
  *§3.2 pp. 8-25 (assembled equations), §3.2.7 p. 25 (wind limit), §4.1 p. 27 (effective wind), §6.2 pp. 87-88 (length-to-breadth)*  
  <https://research.fs.usda.gov/treesearch/download/55928.pdf>
- **substituted for** Anderson (1983) INT-305 exponential L/B relation preferred by spec §4.6: Spec §4.6 flags the Anderson exponents (0.2566/0.1548) as unverified and `estimated`; firelab/behave uses 0.1147/0.0692 for the same form, a factor-of-2.237 disagreement that means one of the two is on the wrong wind unit. Per spec §0.7.2, a documented approximate model beats an unverified preferred one.  
  **known bias:** Linear in wind, so it under-predicts elongation at high wind relative to the exponential forms (LB = 8 at 28 mi/h midflame here, versus the exponential form reaching the LB=8 cap nearer 12 mi/h). Fires are rounder than they should be in strong wind.

## Canopy storage  
*owner: `sim/canopy/storage`*

### Sparse canopy voxel store (per-column runs) and crown voxelisation

- **id** `canopy-voxel-store` · **status** `calibrated`
- ForestFire spec §30 §7.2 — ForestFire design specification, docs/spec/30-canopy-heat-crown.md, §7.2 "Voxel state vector and memory layout".  
  *§7.2 brick pool sizing and the OPEN QUESTION this package closes*
- **OPEN:** CLOSED by measurement (WP 3.1): §7.2 asked whether an 8192-brick pool at 8³ granularity carries headroom or overflows. Measured on the shipping worlds at 512×512×64: dense conifer touches 10 117 of 32 768 brick slots at 23.2 % mean fill — a 23 % OVERFLOW of the proposed pool, and a ×4.32 amplification over occupied voxels. Voxel occupancy is 7.1 %, below the 10–18 % the spec assumed. The brickmap was replaced by per-column vertical runs (×1.03 amplification, 36.0 MiB total against the brickmap's 138.4 MiB).
- **OPEN:** OPEN: crown roundwood (0–3 mm, 3–6 mm) is stored as zero because M1 vegetation carries foliage bulk density only. Van Wagner CBD is a foliage quantity so crown initiation is unaffected, but total crown consumption will be under-predicted until WP 3.2 sources a branchwood split. Not guessed (§0.7.1).

### Leaf area density and extinction from crown bulk density

- **id** `canopy-foliage-optics` · **status** `estimated`
- Rothermel 1972 — Rothermel, R.C. 1972. A mathematical model for predicting fire spread in wildland fuels. USDA Forest Service Research Paper INT-115.  
  *Oven-dry fuel particle density ρ_p = 32 lb ft⁻³ (= 512.6 kg m⁻³), used throughout*  
  <https://www.fs.usda.gov/rm/pubs_int/int_rp115.pdf>
- ForestFire spec §30 §7.3 — ForestFire design specification, docs/spec/30-canopy-heat-crown.md, §7.3 "Optical properties from LAD", which carries Nilson (1971), Ross (1981) and Chen & Black (1992).  
  *§7.3: κ = G·Ω_c·LAD, G = 0.5 spherical; Ω_c ∈ [0.4, 0.8] conifer shoots, ≈0.9 broadleaf*
- **OPEN:** Foliage particle thickness per species has no obtainable free source; σ is derived from an assumed dimension per growth form. ±50 % on σ is largely absorbed by the §7.7 k_f calibration for I₀, but not by the shape of the radiative preheating tail.
- **OPEN:** Ω_c is the midpoint of the §7.3 published range: ±0.2 on conifer, i.e. ±33 % on κ.

## Canopy kinetics  
*owner: `sim/canopy/kinetics`*

### Critical-mass-flux ignition gate, inverted to a temperature threshold

- **id** `canopy-ignition-massflux-threshold` · **status** `validated`
- McAllister, Finney & Cohen 2010 — McAllister, S.; Finney, M.; Cohen, J. 2010. Critical mass flux for flaming ignition of dead, dry wood as a function of external radiant heat flux and oxidizer flow velocity. In: Viegas, D.X., ed. Proceedings of the VI International Conference on Forest Fire Research, Coimbra, Portugal. USDA Forest Service, Missoula Fire Sciences Laboratory.  
  *Table 1 — dry poplar at 1 m/s: t_ig = 75.3 / 30.0 / 16.7 / 9.7 s at 20 / 30 / 40 / 50 kW m^-2; critical mass flux 1.288 / 1.527 / 1.733 / 2.193 g m^-2 s^-1*  
  <https://research.fs.usda.gov/treesearch/39357>
- McAllister et al. 2011 — McAllister, S.; Grenfell, I.; Hadlow, A.; Jolly, W.M.; Finney, M.; Cohen, J. 2011. Critical mass flux for flaming ignition of wood as a function of external radiant heat flux and moisture content. USDA Forest Service, Missoula Fire Sciences Laboratory.  
  *Table 1 — poplar, ignition time (s) at 20/30/40/50 kW m^-2: 75.3/28.0/16.7/9.7 at 0.2% MC, 90.7/38.7/20.7/12.7 at 8% MC, 106.3/48.3/22.7/13.3 at 18.5% MC; sustained-ignition critical mass flux 1.305-2.978 g m^-2 s^-1 across the matrix*  
  <https://research.fs.usda.gov/treesearch/40243>
- Dietenberger 1996 — Dietenberger, M.A. 1996. Ignitability analysis using the cone calorimeter and LIFT apparatus. USDA Forest Service, Forest Products Laboratory, Madison WI. Public domain (work of U.S. Government employees on official time).  
  *p. 195 — critical irradiance for piloted ignition 17 kW m^-2 (LIFT), 10.5 kW m^-2 extrapolated to turbulent free convection at h_c = 0.01 kW m^-2 K^-1; p. 196 — significant volatile release begins at 553 K; derived surface ignition temperatures 290-356 C*  
  <https://research.fs.usda.gov/treesearch/8878>
- Quintiere 2006, via spec §7.6 — Quintiere, J.G. 2006. Fundamentals of Fire Phenomena. Wiley. Thermally-thick piloted ignition delay t_ig = (pi/4) k rho c (T_ig - T_0)^2 / q_net^2, as restated in docs/spec/30-canopy-heat-crown.md §7.6.  
  *ForestFire spec §7.6, "Ignition delay"*
- **validated by** `test/sim/canopy/kinetics/ignition.test.ts` — Reproduces McAllister & Finney & Cohen (2010) dry-poplar piloted-ignition delays at 20, 30, 40 and 50 kW m^-2 to within 4.3% (max residual 4.1% at 40 kW m^-2, RMS 2.6%) with two constants fitted to the four points; reproduces the Dietenberger (1996) critical irradiances of 17 kW m^-2 (LIFT, to 0.1%) and 10.5 kW m^-2 (free convection, to 10.1%) from a steady-state surface balance at T_ig = 620 K and emissivity 0.88, with no fitting beyond the apparatus convective coefficient.
- **OPEN:** The four-point delay fit needs an effective thermal inertia of 2.7e5 W^2 s m^-4 K^-2, about 4x the Wood Handbook value for yellow-poplar (k*rho*c ~ 6.3e4). The FUNCTIONAL FORM is what the 4.3% residual validates; the absolute constant carries the apparatus, the finite sample thickness and the pilot in it. This is the stated reason the canopy uses the thermally-THIN branch for foliage and the 0-3 mm class, where Bi < 0.2 and no such constant is needed.
- **OPEN:** Critical mass flux ships as the dry-fuel mean, 1.64 g m^-2 s^-1. McAllister measures it rising with both external flux and moisture content across 1.29-2.98 g m^-2 s^-1. The moisture dependence is deliberately NOT folded into the constant, because the gate is only reached after the voxel is dry and doing so would double-count the drying stage. The flux dependence is not modelled at all; over the full measured 1.29-2.98 g m^-2 s^-1 span T_ig moves from 678 to 721 K, i.e. +/-22 K about the shipping value of 690 K.
- **OPEN:** Spec §7.6 recommends T_ig = 600 K be retained as a cheap early-out. At canopy bulk densities 600 K corresponds to ~0.21 g m^-2 s^-1, about 7x below the lowest measured critical mass flux, so it is only safe as an early-out and never as the criterion.

### Moisture evaporation heat sink and drying front

- **id** `canopy-moisture-heat-sink` · **status** `validated`
- NIST Chemistry WebBook — NIST Chemistry WebBook, SRD 69: Water, phase change data.  
  *dvapH = 40.65 kJ/mol at the normal boiling point; M = 18.01528 g/mol -> 2.2564e6 J/kg*  
  <https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185&Mask=4>
- McAllister et al. 2011 — McAllister, S.; Grenfell, I.; Hadlow, A.; Jolly, W.M.; Finney, M.; Cohen, J. 2011. Critical mass flux for flaming ignition of wood as a function of external radiant heat flux and moisture content. USDA Forest Service, Missoula Fire Sciences Laboratory.  
  *Table 1 — poplar, ignition time (s) at 20/30/40/50 kW m^-2: 75.3/28.0/16.7/9.7 at 0.2% MC, 90.7/38.7/20.7/12.7 at 8% MC, 106.3/48.3/22.7/13.3 at 18.5% MC; sustained-ignition critical mass flux 1.305-2.978 g m^-2 s^-1 across the matrix*  
  <https://research.fs.usda.gov/treesearch/40243>
- ForestFire spec §30 §7.6 — ForestFire design specification, docs/spec/30-canopy-heat-crown.md §7.6.  
  *Kinetics table and the honesty flag; the statement that Grishin's own pairs are pyrolysis A = 3.63e4 s^-1 with E/R = 9400 K and evaporation A = 6e5 K^1/2 s^-1 with E/R = 6000 K*
- **validated by** `test/sim/canopy/kinetics/evaporation.test.ts` — Latent heat 2.2564e6 J/kg, within 0.01% of NIST dvapH/M; assembled sink reproduces the spec §7.6 worked voxel (3.1 MJ for 1.2 kg at FMC 100%) to 3.8%, the residual being the bound-water desorption term the spec omits from that arithmetic. Energy conservation through the drying pin holds to 1e-9 relative at any timestep.
- **OPEN:** Bound-water desorption enthalpy 3.0e5 J/kg is `estimated` — spec §7.6 states it, no primary source was obtained. It is 3-11% of the total sink at canopy moisture contents.
- **OPEN:** Against the McAllister moisture series the lumped sink OVER-predicts the moisture effect on a thermally-thick sample: predicted delay ratios 1.48 and 2.10 at 8% and 18.5% MC versus measured means 1.28 and 1.47. That is expected and is not a defect of this model — a thick sample dries only a surface layer, a lumped particle must dry all of itself. Dropping the latent term and keeping only the sensible rho*c scaling reproduces the same thick data to within 5%, which is asserted in test as the bound on applying this sink outside the thin regime.

### Single-step Arrhenius pyrolysis and evaporation kinetics (Grishin lineage)

- **id** `canopy-pyrolysis-kinetics-grishin` · **status** `estimated`
- ForestFire spec §30 §7.6 — ForestFire design specification, docs/spec/30-canopy-heat-crown.md §7.6.  
  *Kinetics table and the honesty flag; the statement that Grishin's own pairs are pyrolysis A = 3.63e4 s^-1 with E/R = 9400 K and evaporation A = 6e5 K^1/2 s^-1 with E/R = 6000 K*
- Sullivan 2009 — Sullivan, A.L. 2009. A review of wildland fire spread modelling, 1990-present, 1: Physical and quasi-physical models. International Journal of Wildland Fire 18: 349-368. Author preprint, arXiv:0706.3074.  
  *§2 — reports di Blasi (1998) and Ball et al. (1999): true cellulose volatilisation E_a ~ 240 kJ mol^-1, endothermic ~300 J g^-1; char formation E_a ~ 150 kJ mol^-1, exothermic ~1 kJ g^-1. Also records that Grishin, IUSTI and PIF97 all use Arrhenius laws and that the later models adopted values "following on from the values used by Grishin".*  
  <https://arxiv.org/abs/0706.3074>
- **OPEN:** Grishin (1997) could not be obtained. The A/E pairs are transcribed from spec §7.6's own statement of what Grishin's pairs are, which is a secondary source. Both members of each pair come from that one statement, which is the property that matters: the kinetic compensation effect makes A and E a correlated pair, so mixing lineages shifts the pyrolysis onset by hundreds of kelvin.
- **OPEN:** These are EFFECTIVE, not mechanistic. Sullivan (2009) reporting di Blasi (1998) gives true cellulose volatilisation at E_a ~ 240 kJ mol^-1 against this set's 78.1 kJ mol^-1 — a factor of three. The wildland values are tuned so the reaction proceeds over the right temperature window at coarse resolution, and must never be quoted as chemistry.
- **OPEN:** Char oxidation is NOT implemented. Spec §7.6 gives A_c = 430 m/s with E/R = 9000 K, a pair belonging to neither lineage the same section discusses. It does not affect ignition delay, so shipping nothing is more honest than shipping a third mixed pair. Canopy consumption after flaming is WP 3.1/3.5 territory.
- **OPEN:** Heat of pyrolysis 4.2e5 J/kg and char yield 0.20 come from the same unobtainable table and are likewise `estimated`. Neither affects ignition delay by more than 0.1%.

## Canopy radiation  
*owner: `sim/canopy/radiation`*

### Turbid-medium canopy extinction and grey emissivity

- **id** `canopy-radiation-optics` · **status** `calibrated`
- Nilson 1971 — Nilson, T. (1971). A theoretical analysis of the frequency of gaps in plant stands. Agricultural Meteorology 8: 25-38.  
  *Eq. 1-3, the Poisson gap model that gives P0 = exp(-G*LAI/cos(theta))*
- Ross 1981 — Ross, J. (1981). The Radiation Regime and Architecture of Plant Stands. Dr W. Junk, The Hague.  
  *G-function; G = 0.5 for a spherical leaf-angle distribution, independent of beam direction*
- Chen & Black 1992 — Chen, J.M. & Black, T.A. (1992). Foliage area and architecture of plant canopies from sunfleck size distributions. Agricultural and Forest Meteorology 60: 249-266.  
  *Clumping index Omega_c; 0.4-0.8 for conifer shoots*
- CODATA 2018 — NIST Reference on Constants, Units and Uncertainty (CODATA 2018). Stefan-Boltzmann constant.  
  *sigma = 5.670374419e-8 W m^-2 K^-4, exact under the 2019 SI redefinition*  
  <https://physics.nist.gov/cgi-bin/cuu/Value?sigma>
- Hottel & Sarofim 1967 — Hottel, H.C. & Sarofim, A.F. (1967). Radiative Transfer. McGraw-Hill.  
  *Mean beam length L_m = 3.6 V/A (the 0.9 correction on the optically thin 4V/A)*
- Siegel & Howell — Siegel, R. & Howell, J.R. Thermal Radiation Heat Transfer. NASA reference editions are in the public domain (e.g. NASA SP-164).  
  *Grey-medium radiative transfer; divergence of radiative flux = kappa*(G - 4*sigma*T^4)*
- **OPEN:** Omega_c is a per-species constant in the 0.4-0.9 range with no measurement for the project's procedural stands; it is taken from the published ranges by species class.

### Grey flame sheet, emissivity from optical depth

- **id** `flame-grey-emitter` · **status** `estimated`
- Frankman et al. 2013 — Frankman, D. et al. (2013). Measurements of convective and radiative heating in wildland fires. International Journal of Wildland Fire 22(2): 157-167. USDA Forest Service co-authored, freely available via treesearch.  
  *Field radiometry of flame emissive power and radiant fraction*  
  <https://www.fs.usda.gov/treesearch/pubs/43325>
- CODATA 2018 — NIST Reference on Constants, Units and Uncertainty (CODATA 2018). Stefan-Boltzmann constant.  
  *sigma = 5.670374419e-8 W m^-2 K^-4, exact under the 2019 SI redefinition*  
  <https://physics.nist.gov/cgi-bin/cuu/Value?sigma>
- **OPEN:** k_f = 0.8 m^-1 is the §7.3 shipping default within a genuinely uncertain published range of 0.3-1.5 m^-1. It is fitted offline by §7.7 step 3, so it is a knob, not a constant, and the model cannot rise above `calibrated` until that fit is run.
- **OPEN:** Flame depth D = R*t_r is not exposed by IFireOutputs (which carries intensity, state, arrival time and consumed fraction only), so DEFAULT_FLAME_DEPTH_M = 1.0 m stands in. DECISION per §0.7.3: shipped as `estimated` because only the product k_f*D enters eps_f, and k_f is fitted against emergent crown-initiation intensity, so a systematic bias in D is absorbed by that fit rather than left in the physics. It must still be replaced by the real R*t_r when the surface layer exposes either quantity.
- **OPEN:** T_f = 1200 K is the §7.4 nominal wildland flame-sheet temperature and is not varied with fuel or intensity.

### Next-event-estimation gather over a clustered emitter list

- **id** `canopy-radiation-transport` · **status** `substituted`
- Siegel & Howell — Siegel, R. & Howell, J.R. Thermal Radiation Heat Transfer. NASA reference editions are in the public domain (e.g. NASA SP-164).  
  *Grey-medium radiative transfer; divergence of radiative flux = kappa*(G - 4*sigma*T^4)*
- Crassin et al. 2011 — Crassin, C., Neyret, F., Sainz, M., Green, S. & Eisemann, E. (2011). Interactive Indirect Illumination Using Voxel Cone Tracing. Computer Graphics Forum 30(7).  
  *Mip-averaged extinction under-shadows thin gaps; the accepted voxel-tracing trade*
- **substituted for** The §7.4 recommended pipeline: emission+extinction rasterisation, 5-level mip pyramid, 8 jittered cones per half-res cell projected into an L1 SH volume, plus a separate analytic near-field rectangle view-factor term.: Cone tracing buys emitter-count independence, and our emitters are already compacted to a few hundred 16 m clusters by the surface active set, so that independence buys nothing here. Aiming every ray at a real emitter removes the emitter-finding variance entirely, and removes the emission rasterisation, the mip build, three of four SH coefficients and the separate near-field pass with it: 9.0 MB of fields against 43.2 MB.  
  **known bias:** ONE-SIDED DEFICIT — irradiance is under-estimated, never over-estimated, so crown ignition is biased LATE. Four contributions. (a) Finite-emitter softening replaces r^2 by r^2 + a^2 with a ~ 4.6 m for a full 16 m bin: -5% at 23 m, -1.3% at 46 m, exact beyond, worse than -20% inside 10 m — accepted because §7.5's own worked numbers put convection two to three orders of magnitude above radiation there. (b) The unmarched tail beyond the ray budget is restored at the marched set's mean transmittance raised to the ratio of mean path lengths, an exponent >= 1, so it can only under-restore. (c) The overflow catch-all keeps the weakest bins' power but smears it over the domain. (d) 133 ms of staleness at 7.5 Hz, which at an extreme 1 m s^-1 head fire is 0.13 m of front displacement: -1.3% at 20 m, -5.3% at 5 m. The one term that can raise G is (e) 4 m mip-averaged extinction under-shadowing a thin gap, bounded at +3.3% for a 2 m gap in a kappa = 0.6 canopy. Energy itself is conserved exactly in the continuum limit: integrating kappa*G over all space around an unsoftened point emitter returns its power exactly, which gather.test.ts asserts numerically. With softening it returns LESS — measured 0.75 / 0.40 / 0.14 of the emitted power at kappa = 0.05 / 0.2 / 0.6 — because at kappa = 0.6 the mean free path is 1.67 m and almost everything would have been reabsorbed inside the softening radius of the emitter itself, i.e. inside the already-burning cluster, whose energy budget belongs to the pyrolysis model, not to radiation. Of the absorption beyond 2a — the part that actually preheats unburnt fuel — a measured >= 84% survives at every kappa tested.
- **OPEN:** §6.3 schedules canopyRadiation at rate 1/1 on a 1/120 s substep while §7.4 asks for every 4th 30 Hz canopy step. We take §7.4 (7.5 Hz), which is 16x cheaper.
- **OPEN:** Plume soot IR absorption is omitted: the plume field belongs to WP 3.4 and coupling it would make the extinction field non-static, restoring a per-step rasterisation pass. The omission raises G behind and above the front, the opposite direction to (a)-(d).
- **OPEN:** The measured cost is a traffic-and-sampler analysis of the real reference run, not a wall-clock measurement on the target GPU. See budget.test.ts.

## Canopy convection  
*owner: `sim/canopy/convection`*

### MTT line-plume rise (Gaussian convention)

- **id** `canopy-plume-mtt-line` · **status** `calibrated`
- Richardson & Hunt 2022 — Richardson, J.; Hunt, G.R. 2022. What is the entrainment coefficient of a pure turbulent line plume? Journal of Fluid Mechanics 934, A11. Open access, CC BY.  
  *Eq. (7.1) — Gaussian, line plume: alpha = 0.11 +/- 15 %, lambda = 1.2 fixed. Sec. 3 — the convention-independent observables asserted by the CI regression. Best single measurement alpha = 0.108 +/- 2 %; curated spread 0.095-0.13.*  
  <https://doi.org/10.1017/jfm.2021.1070>
- Morton, Taylor & Turner 1956 — Morton, B.R.; Taylor, G.I.; Turner, J.S. 1956. Turbulent gravitational convection from maintained and instantaneous sources. Proc. R. Soc. Lond. A 234, 1-23.  
  *The entrainment assumption u_e = alpha w_c and the plume flux equations*  
  <https://doi.org/10.1098/rspa.1956.0011>
- ForestFire spec §6.4 — docs/spec/50-meteorology.md §6.4 Plume rise and atmospheric stability.  
  *Convective fraction chi_c = 0.5-0.7 of Byram I_B; stability dtheta/dz defaults 0.02 / 0.035 K/m*
- **OPEN:** ACCEPTED ERROR — cross-wind entrainment is not modelled. Entrainment is alpha_e·w_c only; the wind advects the centreline but adds no shear entrainment. Once u/w_c >~ 1 the plume is bent over and the real closure is larger, so rise height is OVER-predicted and dilution UNDER-predicted. Spec §7.5 states this is a different closure and a new open question, not a re-tuning of alpha_e. Bound: unquantified above u/w_c ~ 1; below it the term is small by construction. This is the largest known error in the plume.
- **OPEN:** ACCEPTED ERROR — near-source excess temperature is clamped at 900 K over ambient (the §7.4 1200 K flame sheet), not resolved. The similarity solution is singular at the source. Below roughly one flame depth the profile is a clamp, not a solution.
- **OPEN:** ACCEPTED ERROR — unstable stratification (dtheta/dz < 0) is clamped to neutral. An unstable line plume has no level-off height and this model has nothing to say about the mid-level dry-air entrainment that actually terminates it. Spec §6.4 owns column collapse.
- **OPEN:** alpha_e remains calibration knob #2 of spec §7.7. Soft bounds 0.095-0.13, hard 0.090-0.140. A fit landing at the upper rail is the documented secondary diagnostic for a convention slip.

### Convective fraction of fireline intensity (chi_c = 0.6)

- **id** `canopy-plume-convective-fraction` · **status** `estimated`
- ForestFire spec §6.4 — docs/spec/50-meteorology.md §6.4 Plume rise and atmospheric stability.  
  *Convective fraction chi_c = 0.5-0.7 of Byram I_B; stability dtheta/dz defaults 0.02 / 0.035 K/m*
- **OPEN:** chi_c = 0.6 is the midpoint of spec §6.4's unsourced 0.5-0.7 range. It scales B_0 linearly and hence w_c and Delta T_c as B_0^(1/3) and B_0^(2/3), i.e. the 0.5-0.7 range is +/-8 % on centreline velocity and +/-16 % on centreline excess temperature.
- **OPEN:** HOLD FIXED during §7.7 calibration: degenerate with alpha_e.

### Convective heat transfer coefficient (Churchill-Bernstein, cylinder in crossflow)

- **id** `canopy-convective-coefficient` · **status** `calibrated`
- Churchill & Bernstein 1977 — Churchill, S.W.; Bernstein, M. 1977. A correlating equation for forced convection from gases and liquids to a circular cylinder in crossflow. J. Heat Transfer 99(2), 300-306.  
  *The single continuous correlation Nu = 0.3 + 0.62 Re^1/2 Pr^1/3 / [1+(0.4/Pr)^2/3]^1/4 · [1+(Re/282000)^5/8]^4/5, valid Re·Pr > 0.2. Reproduced verbatim in spec §7.5.*
- Sutherland 1893 (air constants) — Sutherland, W. 1893. The viscosity of gases and molecular force. Phil. Mag. S.5 36, 507-531. Air constants as tabulated in White, F.M., Viscous Fluid Flow, and in NASA/NIST reference data: mu_ref = 1.716e-5 Pa s, T_ref = 273.15 K, S_mu = 110.4 K; k_ref = 0.0241 W/m/K, S_k = 194 K.  
  *Viscosity and conductivity two-constant forms for air*
- ForestFire spec §7.5 — docs/spec/30-canopy-heat-crown.md §7.5 Convection.  
  *Worked point (d = 1 mm, u = 2 m/s, gas 600 K -> Re 38, Nu 3.3, h 154 W/m2/K); A_v = 2·LAD; near-field convection vs preheating radiation comparison*
- **validated by** `test/sim/canopy/convection/heatTransfer.test.ts` — spec §7.5 worked point h = 154 W/m2/K reproduced to 1 %
- **OPEN:** ACCEPTED ERROR — Pr held at 0.70 rather than computed from c_p(T). Air Pr spans 0.69-0.72 over 300-1200 K and Nu depends on Pr with an effective exponent ~0.39, so this is +/-1.2 % on h.
- **OPEN:** ACCEPTED ERROR — Sutherland air properties instead of tabulated values: -1.4 % on nu and -1.6 % on k at 600 K against the values §7.5 quotes, netting under 1 % on h.
- **OPEN:** ENVELOPE — a cylinder correlation applied to needles, flat leaves and twigs. The shape error is not bounded here and is larger than every numerical approximation above it combined. This is why the model is calibrated rather than validated.
- **OPEN:** The Biot correction 1/(1+Bi/4) of §7.6 is applied by WP 3.2 to the h produced here, not here.

## Crown fire  
*owner: `sim/canopy/crown`*

### Van Wagner (1977) crown fire initiation and active crowning

- **id** `van-wagner-crown` · **status** `validated`
- Van Wagner 1977 — Van Wagner, C.E. 1977. Conditions for the start and spread of crown fire. Canadian Journal of Forest Research 7(1): 23-34. doi:10.1139/x77-004  
  *Crown initiation I_0 = (0.01·CBH·(460+25.9·FMC))^1.5; critical mass flow rate S_0 = 0.05 kg m^-2 s^-1; the three-way surface/passive/active/independent classification*  
  <https://www.frames.gov/catalog/5319>
- Scott & Reinhardt 2001 — Scott, J.H.; Reinhardt, E.D. 2001. Assessing crown fire potential by linking models of surface and crown fire behavior. USDA Forest Service Research Paper RMRS-RP-29. Rocky Mountain Research Station. 59 p.  
  *Crown initiation intensity (worked example CBH = 3 m, FMC = 100% -> I_0 = 875 kW/m); R_active = 3.0/CBD; Appendix A crown fraction burned coefficients (jack pine a = 0.238, mature stand a = 0.108)*  
  <https://research.fs.usda.gov/download/treesearch/4623.pdf>
- Van Wagner 1993 — Van Wagner, C.E. 1993. Prediction of crown fire behavior in two stands of jack pine. Canadian Journal of Forest Research 23(3): 442-449. doi:10.1139/x93-062  
  *Dynamic crown fraction burned coefficient a = -ln(0.1)/(0.9·(R_active - R_init)); independent crown fire as an observationally near-absent category*  
  <https://www.frames.gov/catalog/13066>
- Cruz & Alexander 2010 — Cruz, M.G.; Alexander, M.E. 2010. Assessing crown fire potential in coniferous forests of western North America: a critique of current approaches and recent simulation studies. International Journal of Wildland Fire 19(4): 377-398. doi:10.1071/WF08132  
  *The four principal sources of systematic under-prediction bias in linked Rothermel-Van Wagner systems (NEXUS, FARSITE, FlamMap, FFE-FVS, BehavePlus)*  
  <https://www.frames.gov/catalog/8109>
- Alexander & Cruz 2013 — Alexander, M.E.; Cruz, M.G. 2013. Assessing the effect of foliar moisture on the spread rate of crown fires. International Journal of Wildland Fire 22(4): 415-427. doi:10.1071/WF12008  
  *Digest and critique of the FMC effect: "a much less discernible effect of FMC on crown fire rate of spread" in experimental crown fires than the models assume*  
  <https://www.frames.gov/catalog/13947>
- Alexander & Cruz 2014 — Alexander, M.E.; Cruz, M.G. 2014. Crown fire behaviour characteristics and prediction in conifer forests: a state-of-knowledge synthesis. USDA Forest Service / Fire Management Today. Free-access restatement of the Van Wagner criteria and envelope.  
  *Foliar moisture envelope of the fires Van Wagner fitted (approx. 95-135%)*  
  <https://www.frames.gov/documents/catalog/cruz_and_alexander_2014b.pdf>
- ForestFire spec §30 §7.1 — ForestFire design specification, docs/spec/30-canopy-heat-crown.md §7.1.  
  *"Van Wagner's criteria as envelope, not engine"; the CFB recommendation; the envelope warning for chaparral, eucalypt and UK gorse/heather*
- **validated by** `test/sim/canopy/crown/vanWagner.test.ts` — I_0 = 875 kW/m at CBH = 3 m, FMC = 100% to 0.1 kW/m; R_active = 3.0/CBD to 1e-12 (0.25 m/s at CBD = 0.2); Van Wagner (1993) a = 0.238 and 0.108 for the two Scott & Reinhardt Appendix A stands, to 3 decimals
- **OPEN:** The 1/100 divisor in I_0 is an empirical constant fitted to a SINGLE red-pine observation (spec §7.1: "the weakest number in operational fire science"). It is exposed as CrownTuning.initiationScale so a biome can move it; the default reproduces Van Wagner unchanged.
- **OPEN:** S_0 = 0.05 kg m^-2 s^-1 derives from ONE fire in a red pine plantation, cross-checked only against Thomas (1963) laboratory beds. R_active = 3.0/CBD is the same constant restated in m/min, not independent corroboration of it.
- **OPEN:** Cruz & Alexander (2010) show that linked Rothermel-Van Wagner systems carry a systematic UNDER-prediction bias from four sources: incompatible model linkages; component ROS models that are themselves under-biased; reduction of crown fire ROS by unsubstantiated crown-fraction-burned functions; and uncalibrated custom surface fuel models. This module addresses the third directly — CFB is returned as an output only and never as a spread multiplier, and evaluateCrownFire prefers the measured voxel consumption fraction over the Van Wagner curve whenever the canopy solver supplies one. The first two are properties of the assembled system, not of this file, and spec §7.7 is the defence: the 3D canopy drives ignition and is calibrated to reproduce I_0, rather than I_0 being applied as a gate on a Rothermel ROS.
- **OPEN:** Alexander & Cruz (2013) find the FMC effect on crown fire spread rate far weaker than the models assume — possibly masked by the high convective and radiant fluxes of real crown fires. I_0 keeps its 25.9 kJ/kg/% FMC term because that is what Van Wagner published and this module exists to reproduce him; but a HUD reading whose only variation comes from FMC should be read with that critique attached.
- **OPEN:** Van Wagner was fitted to boreal/Canadian conifer at FMC ~95-135%. Chaparral (no meaningful CBH — fuel is vertically continuous), eucalypt (bark spotting, not crown continuity, governs) and UK broadleaf/gorse are all outside it. envelopeWarnings() returns this as data for the HUD; spec §7.7 step 6 routes those biomes to Cruz's fuel-strata-gap formulation, Project Vesta and gorse/heather ROS data instead.
- **OPEN:** Independent crown fire is documented so rarely (Huff 1988; Van Wagner 1993) that no model exists. It is only reachable here when the caller passes a measured crown consumption fraction — i.e. when the voxel field is observing a burning crown — and it is labelled, never calibrated to. It also has no dwell requirement: a stand that crowns and then loses surface intensity for one step will report "independent" for that step. Add hysteresis if the HUD reading turns out to flicker.
- **OPEN:** Stand canopy base height is aggregated as the mean of per-stem Stem.crownBaseM (Van Wagner's stand-mean definition). The operational Scott & Reinhardt / FuelCalc "effective" CBH — lowest height where the vertical bulk density profile exceeds 0.011 kg m^-3 — generally sits LOWER, so this aggregate under-predicts torching. WP 3.1's 2 m voxel field is what makes the effective definition computable; switch when it lands.
- **OPEN:** Stem.hasLadderFuels is measured by M1 to drive torching but has no effect unless the caller supplies StandAggregationOptions.ladderFuelCbhM. The ladder height is an M5 / WP 3.1 quantity and inventing one here would be the guess §0.7.1 forbids. Until it is wired, torching is under-predicted in ladder-fuelled stands — the same direction as the CBH bias above, so the two do not cancel.

## Firebrands  
*owner: `sim/firebrands`*

### Orientation-averaged drag, non-spherical brands

- **id** `firebrand-drag` · **status** `validated`
- Bagheri & Bonadonna 2016 — Bagheri, G.; Bonadonna, C. 2016. On the drag of freely falling non-spherical particles. Powder Technology 301:526-544. doi:10.1016/j.powtec.2016.06.015  
  *Eq. 14, Eq. 27-28, Table 5; §5.1.2 Fig. 13; §5.2.3 Figs. 19-20*  
  <https://arxiv.org/abs/1810.08787>
- Almeida, Porto & Viegas 2021 — Almeida, M.; Porto, L.; Viegas, D. 2021. Characterization of firebrands released from different burning tree species. Frontiers in Mechanical Engineering 7:651135.  
  *Table 3 (measured terminal velocities, four species)*  
  <https://www.frontiersin.org/articles/10.3389/fmech.2021.651135/full>
- **validated by** `test/sim/firebrands/brands.test.ts — "inverts the four Almeida (2021) measured terminal velocities"` — inverting sigma = v_t^2 rho_a C_D/(2g) at rho_p = 360 recovers all four published thicknesses to within 6% (1.11 / 0.24 / 0.31 / 0.46 mm), across two shape classes
- **OPEN:** The four Almeida thicknesses are recovered EXACTLY as the spec quotes them, but read as half-thickness for the plates and as diameter for the cylinder, at the ember density rho_p = 360. Comparing those against a real leaf, which is quoted as FULL thickness, implicitly needs fresh-foliage density (~700 kg/m3) instead. The C_D validation is unaffected — it is a ratio — but the spec paragraph should say which thickness it means.
- **OPEN:** Aerodynamic lift is neglected: B&B high-speed imaging confirms plates at these Re tumble AND glide, so lateral dispersion is under-predicted by an unquantified amount. That bias acts opposite to the long-biased spot distances of the estimated size rows and the two must not be assumed to cancel.
- **OPEN:** Residual orientation spread about the random-orientation mean is +10% (max +20%) and -13% (max -37%) on C_D (B&B §5.1.2), which is +-5%/-20% on a single brand v_t.

### Brand size, areal density and burnout — conifer and eucalypt

- **id** `firebrand-size-measured` · **status** `calibrated`
- Manzello et al. 2009 — Manzello, S.L.; Maranghides, A.; Shields, J.R.; Mell, W.E.; Hayashi, Y.; Nii, D. 2009. Mass and size distribution of firebrands generated from burning Korean pine (Pinus koraiensis) trees. Fire and Materials 33:21-31.  
  *pp. 25, 27, 29 — all collected brands cylindrical, 3-5 mm x 34-53 mm*  
  <https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=861421>
- Petersen & Banerjee 2024 — Petersen, D.; Banerjee, T. 2024. Size and mass distributions of firebrands. Physics of Fluids 36:106611.  
  *§II C (rho_p = 360 +/- 9 kg/m3 by pycnometry); §III A 3 Figs. 3(b)-(d)*  
  <https://escholarship.org/content/qt9zv0q3q6/qt9zv0q3q6.pdf>
- Hall et al. 2015 — Hall, J.; Ellis, P.F.; Cary, G.J.; Bishop, G.; Sullivan, A.L. 2015. Long-distance spotting potential of bark strips of a ribbon gum (Eucalyptus viminalis). International Journal of Wildland Fire 24:1109.  
  *measured v_t 5.2-5.8 m/s and burnout 122-429 s (max 1304 s), tethered*
- **OPEN:** The §2.1 table quotes v_t = 6.1 m/s for the d = 4 mm conifer cylinder. That is a transcription slip: v_t scales as sqrt(d) and the d = 3 mm / 5 mm entries (5.4 / 7.0) both reproduce exactly, so the middle entry is 6.27. This implementation uses 6.27 and the test asserts the arithmetic rather than the printed digit.
- **OPEN:** The brands-per-kg column is unverified for EVERY row including conifer. Manzello's pan array collected 0.45-2% of mass lost, which at m-bar = 0.10 g is 45-200 brands/kg COLLECTED — a hard lower bound only, since the array did not cover the deposition footprint. The tabulated 100-300 is not contradicted but is not established.

### Brand size — grassland, chaparral, UK mixed

- **id** `firebrand-size-estimated` · **status** `estimated`
- Hedayati et al. 2019 — Hedayati, F.; Bahrani, B.; Zhou, A.; Quarles, S.L.; Gorham, D.J. 2019. A framework to facilitate firebrand characterization. Frontiers in Mechanical Engineering 5:43.  
  *Table 1 — median m/a = 0.159/0.288/0.468 kg/m2 at low/medium/high wind*  
  <https://www.frontiersin.org/articles/10.3389/fmech.2019.00043/full>
- **substituted for** per-fuel measured areal density for grass, chaparral and UK gorse/heather: No primary measurement obtained. USDA FS RDS-2020-0035 (Bahrani et al. 2020) records per-brand mass AND projected area for 9,249 brands from chamise, little bluestem, saw palmetto, loblolly pine and Leyland cypress, so sigma = m/a falls out per brand with no shape or density assumption. It is free but returned HTTP 403 to automated retrieval — an access block, not a paywall. Closing this open question is a browser fetch away.  
  **known bias:** These rows hold v_t fixed and scale sigma to the corrected C_D, so the tabulated sigma are a LOWER bound: if real grass/shrub brands are thicker than one leaf, sigma and v_t rise together and in-domain spot distances derived from them are biased LONG. This implementation takes the UPPER end of each sigma range for that reason.
- **OPEN:** sigma, m-bar and burnout for grassland, chaparral and UK mixed are (assumed) throughout and must be tuned against observed spot distributions before they ship as defaults.

### Brand generation rate from component mass loss

- **id** `firebrand-generation` · **status** `estimated`
- Adusumilli, Chaplen & Blunck 2021 — Adusumilli, S.; Chaplen, J.E.; Blunck, D.L. 2021. Firebrand generation rates at the source for trees and a shrub. Frontiers in Mechanical Engineering 7:655593.  
  *specific firebrand production per kg dry mass burned; sagebrush ~6x ponderosa at comparable MC; production rises exponentially with decreasing moisture over 15-60% MC*  
  <https://www.frontiersin.org/articles/10.3389/fmech.2021.655593/full>
- **substituted for** a measured per-species brands-per-kg table: The FORM is sourced — production is tied to mass consumption of the brand-producing component, not to fireline intensity, because two fuels with identical I_B (grass vs stringybark forest) differ by orders of magnitude in brand yield. The VALUES are not.  
  **known bias:** Unknown sign. The exponential rise of specific production with decreasing moisture is NOT implemented, so brand counts on the driest (most dangerous) days are under-predicted relative to Adusumilli. That is the conservative direction and it is deliberate.

### Landing ignition probability (logistic surrogate)

- **id** `firebrand-ignition` · **status** `estimated`
- Ellis 2011 — Ellis, P.F. 2011. Fuelbed ignition potential and bark morphology explain the notoriety of the eucalypt messmate stringybark for intense spotting. IJWF 20:897.  
  *glowing 0.5-1.6 g stringybark brands ignite P. radiata litter at 2-8% MC; the f_glow = 0.20 burnout floor is anchored here*
- Plucinski & Anderson 2008 — Plucinski, M.P.; Anderson, W.R. 2008. Laboratory determination of factors influencing successful point ignition in the litter layer of shrubland vegetation. IJWF 17:628.  
  *P_ig -> 1 for flaming brands on fine fuels below ~10% MC*
- Ganteaume et al. 2009 — Ganteaume, A.; Lampin-Maillet, C.; Guijarro, M.; et al. 2009. Spot fires: fuel bed flammability and capability of firebrands to ignite fuel beds. IJWF 18:951.  
  *ignition frequency falls with increasing bulk density and moisture*
- **substituted for** a validated multivariate firebrand ignition-probability function: There is none in the literature. Published studies are single- or two-factor and use different fuel beds, brand preparations and ignition definitions, so no multivariate fit can be traced to a source. The coefficients here are fitted by hand to the anchors above.  
  **known bias:** Uncertainty on a single-brand P_ig is easily +-0.2 absolute. Tolerable only because we integrate over 1e4-1e5 brands and the aggregate spot rate is far better conditioned than any individual draw. The coalescence gate is a further estimated construct: without it spot-fire counts are massively over-predicted, with it they are gated on an engineering minimum sustaining area of 1 m2.

### Albini spotting models (calibration harness, not the runtime model)

- **id** `albini-spot-envelope` · **status** `calibrated`
- Albini 1983 — Albini, F.A. 1983. Potential spotting distance from wind-driven surface fires. USDA Forest Service Research Paper INT-309.  
  *§1.2 loft height and §1.4 flat-terrain deposition, as coded in BehavePlus*  
  <https://www.fs.usda.gov/rm/pubs_int/int_rp309.pdf>
- firelab/behave — BehavePlus reference implementation, src/behave/spot.cpp.  
  *the canonical numerical statement of Albini 1979/1983*  
  <https://github.com/firelab/behave>
- **OPEN:** Albini folds a characteristic brand terminal velocity into his constants and predicts a MAXIMUM distance for a single brand under steady wind — not a distribution, not a rate, not an ignition probability. He has no eucalypt bark, chaparral or gorse parameterisation and using the torching-tree coefficients for E. obliqua or Ulex europaeus is outside the validated envelope. We do not do it.

## Smoke & volumetrics  
*owner: `sim/smoke, render/volumetrics`*

### Smoke particulate yield per kg of fuel consumed

- **id** `smoke-soot-yield` · **status** `estimated`
- Andreae 2019 — Andreae, M. O. (2019), Emission of trace gases and aerosols from biomass burning - an updated assessment, Atmos. Chem. Phys. 19:8523-8546, doi:10.5194/acp-19-8523-2019.  
  *Table 1 (PM2.5 emission factors by biome) — NOT READ, see openQuestions*  
  <https://acp.copernicus.org/articles/19/8523/2019/>
- **OPEN:** OPEN: the 0.013 / 0.030 kg per kg yields are recalled, not read. Andreae (2019) Table 1 is open access and is the intended source; until it is read and the figures quoted with a page, spec §0.7 makes this model `estimated` and it may not be promoted. The value scales plume opacity LINEARLY, so it is the first thing to check against a photograph.

### Smoke composition endmembers (EC/OC by combustion regime)

- **id** `smoke-composition` · **status** `calibrated`
- Reid et al. 2005 — Reid, J. S., Koppmann, R., Eck, T. F., and Eleuterio, D. P. (2005), A review of biomass burning emissions part II, Atmos. Chem. Phys. 5:799-825 / 827-849, doi:10.5194/acp-5-827-2005.  
  *Section 2.4, p. 834 — flaming-dominated omega_0 = 0.75, smouldering 0.90*  
  <https://acp.copernicus.org/articles/5/827/2005/>
- Pokhrel et al. 2016 — Pokhrel, R. P., et al. (2016), Parameterization of single-scattering albedo (SSA) and absorption Angstrom exponent (AAE) with EC/OC for aerosol emissions from biomass burning, Atmos. Chem. Phys. 16:9549-9561, doi:10.5194/acp-16-9549-2016.  
  *Fig. 4a-c, p. 9555 — the SSA(f) fits the endmembers were inverted through*  
  <https://acp.copernicus.org/articles/16/9549/2016/>

### Blackbody flame colour (Planck integrated against CIE 1931)

- **id** `blackbody-emission` · **status** `validated`
- Wyman et al. 2013 — Wyman, C., Sloan, P.-P., and Shirley, P. (2013), Simple Analytic Approximations to the CIE XYZ Color Matching Functions, Journal of Computer Graphics Techniques 2(2):1-11.  
  *Multi-lobe piecewise-Gaussian fit, Table 1*  
  <https://jcgt.org/published/0002/02/01/>
- CODATA 2018 — CODATA recommended values of the fundamental physical constants (2018).  
  *h, c, k_B — giving c_1L = 1.1910429e-16 W m^2 sr^-1 and c_2 = 1.438777e-2 m K*
- **validated by** `test/render/volumetrics/blackbody.test.ts` — CIE 1931 chromaticity of the Planckian locus at 2856 K (CIE illuminant A) to within 0.006 in x and y, and monotonic blue/red ratio across 800-2500 K.

## Fire weather  
*owner: `weather`*

### Canadian Forest Fire Weather Index System (FFMC, DMC, DC, ISI, BUI, FWI)

- **id** `canadian-fwi` · **status** `calibrated`
- Van Wagner 1987 — Van Wagner, C. E. (1987), Development and structure of the Canadian Forest Fire Weather Index System, Forestry Technical Report 35, Canadian Forestry Service, Ottawa.  
  *Equations for FFMC, DMC, DC, ISI, BUI and FWI*
- Van Wagner & Pickett 1985 — Van Wagner, C. E., and Pickett, T. L. (1985), Equations and FORTRAN program for the Canadian Forest Fire Weather Index System, Forestry Technical Report 33, Canadian Forestry Service, Ottawa.  
  *The reference implementation and its worked example*
- **OPEN:** OPEN: only DMC and DC are checked against published figures, and both reproduce the Van Wagner & Pickett (1985) worked example (17.0 C, 42 %, 6.5 km/h, 0 mm, April, from 85/6/15) to seven significant figures — 8.5450511 and 19.013999. FFMC, ISI, BUI and FWI are NOT checked: the figures they were first written against were recalled rather than read, and the implementation disagrees with them (FFMC 87.3675 vs 87.692980, ISI 4.0787 vs 10.853661). An independent hand-calculation of the FFMC equations agrees with the implementation, and an ISI gap that size cannot follow from a 0.33 FFMC difference, so the recalled targets are the likely error. Obtain Forestry Technical Report 33 (or the cffdrs R package test fixtures, which carry the same day) and either promote this model to `validated` or fix the transcription. Until then §0.7 forbids `validated`.

### FWI codes to timelag-class fuel moisture

- **id** `fwi-size-class-crosswalk` · **status** `estimated`
- ForestFire spec §6.7 — ForestFire specification, docs/spec/50-meteorology.md §6.7.  
  *"This cross-walk is our own construction and is not a validated published mapping"*
- **OPEN:** OPEN: the 10 h and 100 h classes are linearly interpolated between the FFMC and DMC ends because the FWI system does not resolve them. Monotonic and dimensionally reasonable, but unvalidated — the first thing to suspect if UK spread rates come out wrong.
