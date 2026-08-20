# Meteorology direction claims (status: partially-closed)

## [confirmed] §6.2 — downwind of a ridge, near-surface flow REVERSES relative to the mean wind (spec injects 'a reversed near-surface flow').

**Correct:** Direction is right: inside the separation bubble the near-surface mean flow runs back toward the ridge, i.e. UP the lee slope, opposite the flow crossing the crest. Source words: "If the hill is steep enough downwind a 'separation bubble' forms with reversed mean flow and enhanced turbulence levels." Fire-domain statement of the same thing: "it may start to rotate the air below and form a large, stationary roll eddy. This often results in a moderate to strong upslope wind opposite in direction to that flowing over the rim." Caveat worth carrying: the recirculation is a stable/neutral-wind feature — LES shows "convectively driven turbulence eliminates recirculation zones that would otherwise persist in the lee of steep terrain at the wind speeds they studied", so applying it unconditionally over-fires it in unstable conditions.

**Citation:** Finnigan, Ayotte, Harman et al., 'Boundary-Layer Flow Over Complex Topography' (Boundary-Layer Meteorol. 2020), free author copy https://tahoe.ucdavis.edu/sites/g/files/dgvnsk4286/files/inline-files/BL_flow_over_CX_topography_Review_v38_final.pdf — p. 9 (MS lines 249–251) for the separation-bubble quote; MS line 635 for the convective-elimination quote. Schroeder & Buck, 'Fire Weather', USDA Agriculture Handbook 360 (= NWCG PMS 425-1), free at https://gacc.nifc.gov/nwcc/content/products/intelligence/Fire_Weather_Agriculture_Handbook_360.pdf — Ch. 6, PDF p. 104 (printed p. 97–98), roll-eddy passage and its figure caption "An upslope wind may be observed at the surface on the lee side."

## [confirmed] §6.2 — separation is triggered where downwind slope exceeds ≈17° (0.3).

**Correct:** Threshold is well placed. Source words: "That comparison showed that separation on rough 2D ridges occurred at slope angles greater than ~15 degrees. But on axisymmetric hills, the critical angle was ~20 degrees. In all the cases reviewed, the nature of the surface roughness at or just upwind of the separation point was critically important." 17° sits between the 2D-ridge and axisymmetric-hill critical angles; a roughness dependence exists that the spec's single constant does not carry.

**Citation:** Finnigan et al. review (as above), p. 14, MS lines 388–391 (summarising Finnigan 1988; Wood 1995 analytic critical slope).

## [unconfirmed] §6.2 — magnitude of the injected reverse flow is 0.2–0.4 × U_ridge.

**Correct:** Could not confirm from any free source. No open publication located that states reverse-flow speed inside a hill-lee separation bubble as a fraction of ridge-top speed. Nearest free evidence is qualitative: at Big Southern Butte "The observed lee side flow is highly unsteady, with 180° fluctuations in wind direction at some locations over the 10 min averaging period", and mass-consistent solvers "over-predict wind speed on the lee side" (i.e. real lee speeds are much lower than a COM solve gives). Treat 0.2–0.4 as an engineering choice and flag it `estimated`, as §6.2 already does for α_h/α_v.

**Citation:** Wagenbrenner, Forthofer, Page & Butler (2019), 'Development and Evaluation of a RANS Solver in WindNinja…', Atmosphere 10(11):672, free USFS copy — lee-side unsteadiness p. 20 (Fig. 17 discussion); COM over-prediction on lee side, Section 4 summary p. 22. https://ninjastorm.firelab.org/windninja/publications/windninja_cfd.pdf

## [corrected] §6.2 — lee-separation length is 3–6 × ridge height.

**Correct:** Likely too short by roughly 2×. Measured and modelled separation regions on a ridge of H/L = 0.36 run 4L–5.2L: "Using flow visualisation techniques, Finnigan and Brunet (1995) were able to identify a separation region 5.2 L in length" and "The separation region extends over 4 L in length over the ground surface for all cases for WRF-C … compared with 3 L for WRF-R4". With H/L = 0.36 (L = 2.8H) that is ≈11–14 ridge heights, not 3–6. The cited case is a forest-covered ridge, where canopy drag promotes earlier separation and a longer bubble, so 3–6 H may still be defensible for a bare ridge — but the spec cites no source and the only free measurement found is 2–4× larger. Recommend widening to ≈4–12 H or explicitly restricting 3–6 H to unforested terrain.

**Citation:** Tolladay & Chemel, 'Numerical Modelling of Neutral Boundary-Layer Flow across a Forested Ridge', arXiv:2105.06260 — geometry H = 30 m, L = 84 m, H/L = 0.36 (p. 5, MS line 226); 5.2L flow-visualisation figure (p. 10, MS line 699); 4L vs 3L simulated extents (p. 15, MS line 1147).

## [confirmed] §6.2/§6.4(i) — stable flow is forced AROUND terrain, unstable/neutral flow goes OVER it (the already-corrected α_h/α_v sense).

**Correct:** Spot-check passes; the corrected sense holds. Source words: "At such large Froude Numbers the airflow goes over the hill rather than being blocked and forced to go around the hill by the stratification." (High Froude number = weak stratification/strong wind = over; low Fr = strong stable stratification = blocked, around.) The regression test §6.2 specifies (very stable ⇒ horizontal deviation exceeds vertical) is the right test.

**Citation:** Finnigan et al. review (as above), p. 14, MS lines 397–399.

## [confirmed] §6.3 — anabatic upslope by day, katabatic downslope by night.

**Correct:** Direction correct. Source words: "Slope winds are local diurnal winds present on all sloping surfaces. They flow upslope during the day as the result of surface heating, and downslope at night because of surface cooling."

**Citation:** AH-360 (as above), Ch. 7 'Convective Winds', PDF p. 120 (printed p. 114), 'Slope Winds'.

## [corrected] §6.3 — the reversal occurs 'roughly 30–60 min after local sunset/sunrise on the slope in question'.

**Correct:** Phase reference is wrong, and the morning lag is too long. Evening: "The transition from upslope to downslope wind begins soon after the first slopes go into afternoon shadow and cooling of the surface begins." — the trigger is SHADOW ARRIVAL on that slope, which on an east-facing slope precedes local sunset by hours, not follows it by 30–60 min; the transition then proceeds as "(1) dying of the upslope wind, (2) a period of relative calm, and then (3) gentle laminar flow downslope." Morning: "Whereas upslope winds begin within minutes after the sun strikes the slope…" and "Upslope winds begin as a gentle upflow soon after the sun strikes the slope. Therefore, they begin first on east-facing slopes after daybreak" — minutes after direct illumination of that slope, not 30–60 min after astronomical sunrise. Correct formulation: drive the reversal off slope-normal direct-beam illumination (which §6.5's solar geometry already provides) with a short lag — order minutes at onset of illumination, order tens of minutes to ~1 h after full shading — not off a global sunrise/sunset clock. Note the fire-relevant asymmetry the current wording loses: valley-scale flow completes its "180-degree change in direction … some time after sunset", so slope and valley components reverse at different times.

**Citation:** AH-360 (as above), Ch. 7: evening transition and 3-stage sequence, PDF p. 121 (printed p. 115); morning onset 'within minutes after the sun strikes the slope', PDF p. 123 (printed p. 117); 'begin first on east-facing slopes after daybreak' and the 180° valley shift, PDF p. 124 (printed p. 118).

## [confirmed] §6.3 — typical speeds/depths: anabatic 1–4 m s⁻¹ with h_s 50–200 m; katabatic 1–3 m s⁻¹ with h_s 20–80 m.

**Correct:** Ordering (katabatic shallower than anabatic) is right; absolute speeds sit at the low end of published values. Source words: "Downslope winds are very shallow and of a slower speed than upslope winds. The cooled denser air is stable and the downslope flow, therefore, tends to be laminar." Stull: anabatic "Typical speeds are 3 to 5 m s–1, and depths are hundreds of meters"; katabatic "Typical speeds are 3 to 8 m s–1", "Typical depths are 10 to 100 m, where the depth is roughly 5% of the vertical drop distance from the hill top", and "Katabatic flows are shallower and less turbulent than anabatic flows." Review literature agrees on depth: "Katabatic flows on open slopes tend to be extremely shallow so a current extending kilometres or more in the downwind direction will be only ~10-100-m deep with jet peaks as low as 1m." Katabatic 20–80 m is inside 10–100 m; anabatic 50–200 m is shallow versus 'hundreds of meters'; both speed clamps are ~1–2 m s⁻¹ below the textbook bands. Note the tension: AH-360 says katabatic is slower than anabatic while Stull's band lets it be faster — the spec follows AH-360, which is the fire-domain source, so this is defensible but should be labelled a choice.

**Citation:** AH-360 (as above), Ch. 7, PDF p. 121 (printed p. 115). Stull, 'Practical Meteorology' (free open textbook), §17.3 Thermally Driven Circulations, anabatic and katabatic subsections — https://geo.libretexts.org/Bookshelves/Meteorology_and_Climate_Science/Practical_Meteorology_(Stull)/17:_Regional_Winds/17.02:_Section_3-. Finnigan et al. review (as above), §4.1, MS lines 1261–1264.

## [confirmed] §6.4 channel (ii) — stability sets σ_u and hence gust amplitude.

**Correct:** Direction correct: unstable ⇒ gustier ⇒ more erratic fire; stable ⇒ steadier. Source words: "winds tend to be turbulent and gusty when the atmosphere is unstable, and this type of airflow causes fires to behave erratically", and "A steady wind is indicative of stable air. Gusty wind, except where mechanical turbulence is the obvious cause, is typical of unstable air." This matches §6.1.4's Panofsky closure numerically (σ_u/u* = 2.0 stable, 2.5 neutral, ≥3.5 for |z_i/L| ≳ 100 unstable).

**Citation:** AH-360 (as above), Ch. 4 'Atmospheric Stability' opening page, PDF p. 55; visual stability indicators, PDF p. 71 (printed p. 65).

## [corrected] §6.4 channel (iii) — 'a stable, low z_i keeps hot gas near the fuel and raises effective preheating', i.e. stability INCREASES surface spread through the trapping channel.

**Correct:** INVERTED, and the missing mechanism is the indraft, not re-entrained preheat. The source's own words: "Atmospheric stability may either encourage or suppress vertical air motion. The heat of fire itself generates vertical motion, at least near the surface, but the convective circulation thus established is affected directly by the stability of the air. In turn, the indraft into the fire at low levels is affected, and this has a marked effect on fire intensity." Unstable ⇒ "hot gases rising from a fire will encounter little resistance, will travel upward with ease, and can develop a tall convection column" ⇒ stronger low-level indraft ⇒ higher intensity. Stable ⇒ suppressed column ⇒ weaker indraft ⇒ lower intensity; observationally, "Within the thermal belt, wildfires can remain quite active during the night. Below the thermal belt, fires are in cool, humid, and stable air, often with downslope winds." So the third channel should be signed: low z_i / strong stability ⇒ REDUCED convective indraft and reduced surface intensity, not raised preheating. If a trapping term is kept at all it must be a second-order modifier on plume-collapse outflow (§6.4's collapse trigger), not a net positive on surface preheating.

**Citation:** AH-360 (as above), Ch. 4 opening page, PDF p. 55 (indraft/intensity passage); dry-adiabatic tall-column passage, PDF p. 61 (printed p. 55); thermal-belt passage, Ch. 2, PDF p. 35 (printed p. 29).

## [confirmed] §6.4 — an inversion traps, and its breaking matters.

**Correct:** Direction correct, with the caveat that the spec never states which way the break goes. Source words: "The behavior of a fire burning beneath an inversion may change abruptly when the inversion is destroyed." The change is an increase: it removes exactly the suppression named above (cool, humid, stable surface air; smoke shading) and coincides with mixing and gustiness. Recommend the spec say explicitly: inversion present ⇒ suppressed surface fire; inversion breakup ⇒ step increase in spread and gustiness. NWCG's PMS 437 states the operational indicator in the same sense (haze/visibility abating during the burn period indicates an increase in fire behavior; above-average mixing heights go with warmer, drier, gustier conditions), but nwcg.gov returned HTTP 403 to every fetch attempt, so that wording is search-index level only and is not quoted here as verified.

**Citation:** AH-360 (as above), Ch. 2, inversion dissipation passage, PDF p. 36 (printed p. 30).

## [unconfirmed] §6.4 — Haines Index is computed and displayed as a diagnostic.

**Correct:** Not part of the five questions, but surfaced while sourcing them and it bears on the section: NWCG's Fire Weather Subcommittee has recommended discontinuing the Haines Index in fire-weather forecasts and NWCG training, on the grounds that it is unsupported for predicting large fire growth and is not a stability metric; Potter (USFS PNW) published 'The Haines Index – it's time to revise it or replace it'. Both primary pages (nwcg.gov, fs.usda.gov/pnw) returned HTTP 403 to fetch, so this is flagged rather than closed. §6.4 already uses HI only as a display/modulation term, which is the low-risk use, but the provenance label should probably say 'deprecated by NWCG' rather than 'diagnostic'.

**Citation:** Unverified fetch: NWCG 6MFS 'Replacing Haines Index and Lightning Activity Level' (https://www.nwcg.gov/6mfs/weather-fire-behavior/replacing-haines-index-and-lightning-activity-level) and Potter, B.E., 'The Haines Index – it's time to revise it or replace it', USFS PNW (https://www.fs.usda.gov/pnw/pubs/journals/pnw_2018_potter001.pdf) — both HTTP 403 from this environment; re-check before acting.

## [corrected] §6.6 — for dead fine fuels WETTING is faster than DRYING; τ_wetting = 0.7 × τ_drying.

**Correct:** INVERTED. Vapour-phase sorption is SLOWER in wetting (adsorption) than in drying (desorption). Source words: "Adsorption response times were longer and diffusivities lower than for fuels in desorption." (Anderson 1990, tested 26.7 °C, RH stepped 90→20 % and back.) A recent measurement gives the factor: for a standard 10-h fuel stick "Its response times were approximately 20 h (adsorption) and 9 h (desorption)" — i.e. τ_wetting ≈ 2.2 × τ_drying. Correct table direction: τ_wetting ≈ 1.5–2.2 × τ_drying (10-h class: ~20 h wetting vs ~9 h drying), not 0.7 ×. This is a factor-of-3 error in the wrong direction on the 1-h class, and it makes fine fuels recover from a humidity rise far too quickly — i.e. it damps overnight/RH-recovery spread when it should sustain it. Note this applies to the vapour-sorption relaxation only; direct liquid wetting by rain is genuinely fast and is already handled separately by the §6.6 rainfall term (c_r · P), so that term needs no change.

**Citation:** Anderson, H.E. (1990) 'Moisture diffusivity and response time in fine forest fuels', Can. J. For. Res. 20:315–325 — abstract, verbatim sentence, free via USFS/JFSP FRAMES catalog https://www.frames.gov/catalog/32053. Zhao, Yebra, Cary & Hughes, 'Evaluation of a 10-h fuel stick and a moisture meter for measuring fine dead fuel moisture and response times', Int. J. Wildland Fire 35(4):WF25174 — 'Key results', quoted verbatim on the Northern Rockies Fire Science Network summary page https://nrfirescience.org/resource/28716.

## [confirmed] §6.8 — phenology phase: Φ_season peaks at the end of the spring flush, so LFM is maximal in late spring and declines through the summer (peak DOY 130–180 N. hemi., 330 S. hemi.).

**Correct:** Phase and sign correct. Source words: "For most shrub species, live fuel moisture followed a 'typical' pattern. Fuel moisture increased rapidly due to the spring 'greenup' and then gradually decreased over the growing season." The same source flags a real limitation of the spec's one-curve-per-biome model: "Tree foliage live fuel moisture did not appear to exhibit the same seasonal trends that shrub fuels did" — so the conifer/broadleaf rows of §6.8's table (peak DOY 175/180) rest on weaker ground than the shrub rows.

**Citation:** Weise, D.R., 'Assessing live fuel moisture for fire management applications', USDA FS, free at https://research.fs.usda.gov/download/treesearch/23263.pdf — Results, p. 3 (2nd column), 'typical pattern' paragraph.

## [unconfirmed] §6.8 — LFM falls with drought as (1−D)^p, with p ≈ 0.7 for shallow-rooted shrubs and ≈ 0.35 for deep-rooted trees.

**Correct:** The SENSE is supported; the EXPONENT is not. Sense: drought indices predict live moisture strongly for shallow-rooted vegetation and weakly for deep-rooted vegetation, so a larger drought sensitivity for shrubs than for trees is the right way round. Source words: "Dimitrakapoulos and Bemmerzouk (2003) reported strong relationships between plant moisture status and drought indices for herbaceous shallow-rooted species …, and comparatively poor relationships of the same indices with the moisture dynamics of deep-rooted Pinus brutia trees. Pellizzaro et al. (2007a) compared LFMC with the Keetch-Byram Drought Index (KBDI) … finding strong correlations … for herbaceous species …, while observing weak correlations for deep-rooted sclerophyllous species at the same location." Exponent: no free source found that fits a power law of LFM on normalised KBDI/DC, or that yields 0.7/0.35. The published chaparral relationship is described only as "a strong, nonlinear relationship" between a cumulative water-balance index and LFM (Dennison et al. 2003), with no exponent given. p = 0.7/0.35 must be labelled `estimated`/tuned, like α_h/α_v — it may not be presented as sourced.

**Citation:** Nolan et al. / 'Decoupling between soil moisture and biomass drives seasonal variations in live fuel moisture across co-occurring plant functional types', Fire Ecology 18:6 (2022), open access — Discussion, p. 9, https://fireecology.springeropen.com/counter/pdf/10.1186/s42408-022-00136-5.pdf. Qi, Dennison, Jolly et al., 'Monitoring Live Fuel Moisture Using Soil Moisture and Remote Sensing Proxies', Fire Ecology 8(3):71 (2012), open access — Introduction, p. 73, KBDI/CWBI paragraph.

## RECOMMENDATION

Two of the five are inverted and both are in the same family as the errors the earlier review caught — right citation, wrong sense.

FIX FIRST (wrong sign, silent failure):
1. §6.4 channel (iii). Flip it. Stability's third channel acts through the CONVECTIVE INDRAFT, not through re-entrained preheat: stable/low z_i suppresses the column, weakens the low-level indraft, and lowers intensity; unstable does the reverse. AH-360 Ch. 4's opening paragraph states this explicitly and should be quoted in the spec so it cannot be re-derived backwards. Add the missing explicit sign on inversion breakup (present = suppressed, breaking = step increase).
2. §6.6 timelag table. τ_wetting is not 0.7 × τ_drying; adsorption is the SLOWER branch, ~1.5–2.2 ×. Replace the 0.7/7/70/700 column with a >1 multiplier (10-h class measured at ~20 h wetting vs ~9 h drying). Leave the rainfall term alone — liquid wetting is genuinely fast and is a separate path.

FIX SECOND (wrong phase reference, not wrong sign):
3. §6.3 timing. Drive the reversal off slope-normal direct-beam illumination — which §6.5 already computes — not off a global sunrise/sunset clock: onset of upslope flow is minutes after the sun strikes THAT slope; onset of downslope flow begins as soon as that slope goes into shadow, which can precede local sunset by hours on east-facing slopes. The current "30–60 min after local sunset/sunrise" gets the overnight-run hour wrong on exactly the aspect-dependent slopes that matter.

RELABEL (numbers not sourceable):
4. §6.2 lee magnitude 0.2–0.4 U_ridge: no free source found — mark `estimated` alongside α_h/α_v. Lee length 3–6 H is short: the only free measurement (5.2 L on an H/L = 0.36 ridge ≈ 14 H) is 2–4× larger; widen to ≈4–12 H or restrict 3–6 H to unforested terrain and say so. The 17° threshold and the reversal direction are both sourced and correct, as is the stable-goes-around/unstable-goes-over mapping.
5. §6.8 exponent p = 0.7/0.35: direction sourced (shallow-rooted are far more drought-responsive than deep-rooted), magnitudes not. Mark `estimated`. Phenology phase is confirmed for shrubs; the tree rows are weaker — the same source notes tree foliage does not follow the shrub seasonal pattern.

TESTS worth adding, in the spirit of §6.2's existing regression test (they catch a sign flip regardless of the constants):
- Hold weather fixed, step RH 20 %→90 %: 1-h MC must approach EMC more SLOWLY than the reverse step 90 %→20 %.
- Same fuels and wind, stable vs unstable preset: surface ROS and gust amplitude must both be LOWER under the stable preset.
- Clear-sky day on a bipolar E/W ridge: the east slope must reverse to downslope flow while the west slope is still upslope.

Unresolved and worth one follow-up when nwcg.gov is reachable: NWCG appears to have deprecated the Haines Index outright (§6.4 uses it as a displayed diagnostic). Every nwcg.gov and fs.usda.gov/pnw fetch returned HTTP 403 from this environment, so that is flagged, not closed. Note AH-360 = NWCG PMS 425-1, so the free GACC-hosted PDF is a usable substitute for the PMS 425-1 chapters. No repository file was modified.
