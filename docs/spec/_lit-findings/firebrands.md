# Firebrand properties & drag  (status: partially-closed)

## [corrected] OPEN QUESTION #9 hazard (i): 'it is not established whether the tabulated σ values were originally entered as areal densities or as ρ_p × half-thickness — if the latter, every non-eucalypt row is a factor of 2 low in σ and √2 low in v_t.'

**Correct value:** RESOLVED BY ARITHMETIC — there is NO factor-of-2 error. The σ values were entered as areal density σ = m/A_perp, consistent with the stated σ = 2ρ_pδ. Proof: back-solve C_D = 2σg/(ρ_a v_t²) from each tabulated (σ, v_t) pair with ρ_a = 1.2, g = 9.81:
  Grassland  low end (0.1, 0.9)  → C_D = 2.02 ;  high end (0.4, 1.8)  → C_D = 2.02
  Chaparral  (0.5, 2.0) → 2.04 ;  (3.0, 5.0) → 1.96
  UK mixed   (0.2, 1.3) → 1.93 ;  (1.0, 3.0) → 1.82
  Eucalypt   (4.0, 5.8) → 1.94
  W US conifer (1.5, 3) → 2.73 ; (6.0, 8) → 1.53   [widest, most rounded range]
Four of five rows recover a single value C_D ≈ 2.0, and grassland recovers it to 1% at BOTH ends. Forward check at C_D = 2.0: grassland σ 0.1–0.4 → v_t 0.90–1.81 (tabulated 0.9–1.8, exact); chaparral 0.5–3.0 → 2.02–4.95 (tabulated 2–5); UK mixed 0.2–1.0 → 1.28–2.86 (tabulated 1.3–3). C_D = 2.0 is equivalent to the reduced form v_t = √(σg/ρ_a).
Had any row been entered as ρ_pδ (i.e. σ/2), reconciling that row would require C_D ≈ 4 and the rows would NOT share a common C_D. They do. Therefore: the σ column IS areal density; the columns ARE mutually consistent; the sole defect is that they were generated at an undocumented C_D = 2.0 that appears nowhere in §2.2's table (which lists 1.0/1.3/1.5) nor in its sanity check (1.4).

**Citation:** Derived arithmetic on the spec's own table, C:\Users\garet\Documents\Code\ForestFire\docs\spec\40-spotting.md §2.1 table and §2.2 formula v_t = √(2σg/(ρ_a C_D)). Reproduction script: C:\Users\garet\AppData\Local\Temp\claude\C--Users-garet-Documents-Code-ForestFire\d16981fb-a2e0-444e-8072-d0d687ecaeeb\scratchpad\forensic.py

## [corrected] OPEN QUESTION #10: cylinder C_D = 1.0 and flat plate/disc C_D = 1.3 (orientation-averaged), with no source recorded after Haider–Levenspiel was disclaimed.

**Correct value:** BOTH ARE TOO HIGH, by roughly a factor of 2, because they omit the fact that a randomly-oriented convex body presents on average only ~half its maximum projected area while A_⊥ in §2.2 is the full plan area. Sourced replacements, referenced to the SAME areas §2.2 uses (plate: plan area L×I; cylinder: broadside area d×L):

  FLAT PLATE / DISC:  C_D = 0.95  (range 0.75 at flatness f=0.10 → 1.12 at f=0.015; use 0.95 for the realistic firebrand range f ≈ 0.02–0.06)
  CYLINDER AR 4:1:    C_D = 0.47  (0.43 at AR 2:1 → 0.54 at AR 13:1 — nearly AR-independent on broadside area)
  SPHERE / COMPACT:   C_D = 0.463 → the tabulated 0.47 is CONFIRMED to 3 s.f.

Derivation (Bagheri & Bonadonna Eqs. 27/28/34, valid Re 10³–3×10⁵ and ρ' = 150–2130; firebrands have ρ' = ρ_p/ρ_a ≈ 360/1.2 = 300, inside range):
  f = S/I (flatness), e = I/L (elongation), L≥I≥S; F_N = f²e(d_eq³/(L·I·S)); log₁₀k_N = 0.45[−log₁₀F_N]^0.99; C_D|d_eq = 0.463·k_N on A_eq = πd_eq²/4. Change of reference area is exact from the force balance: C_D|plan = C_D|d_eq · A_eq/A_plan.
  Plate 50×30×2δ=3 mm: V=4.5e-6 m³, d_eq=20.48 mm, f=0.100, e=0.60, F_N=0.01146, k_N=7.37, C_D|d_eq=3.413, A_eq=3.294e-4, A_plan=1.5e-3 → C_D|plan = 3.413×0.2196 = 0.750
  Plate 50×30×1 mm: f=0.033, F_N=0.00127, k_N=19.45 → C_D|plan = 0.951
  Plate 30×20×0.3 mm: f=0.015, F_N=0.00029, k_N=37.5 → C_D|plan = 1.116
  Cylinder AR 4:1 (h=4d): V=πd³, d_eq=1.8171d, f=1, e=0.25, d_eq³/(LIS)=1.5, F_N=0.375, k_N=1.561, C_D|d_eq=0.723, A_eq=2.593d², A_broadside=4d² → C_D|broadside = 0.723×2.593/4 = 0.469

INDEPENDENT VALIDATION against measured terminal velocities (Almeida et al. 2021 Table 3), inverting σ = v_t²ρ_a C_D/(2g) and then σ = ρ_p·t:
  P. pinaster needle, v_t = 3.31 m/s, C_D = 0.47 → σ = 0.315 kg/m² → equivalent circular diameter 1.11 mm at ρ_p = 360 (real needle ≈ 1 mm). 
  Q. robur leaf, v_t = 1.69, C_D = 0.95 → σ = 0.166 → thickness 0.24 mm at leaf-tissue ρ_p ≈ 700 (real ≈ 0.2 mm).
  Q. suber leaf, v_t = 1.94 → σ = 0.219 → 0.31 mm (real ≈ 0.3 mm).
  E. globulus leaf, v_t = 2.36 → σ = 0.324 → 0.46 mm (real ≈ 0.3–0.5 mm).
Four species, two shape classes, agreement within ~20–30%. C_D = 1.3 would require every leaf to be ~37% thicker than measured. Corroborating context: Wang, Hu, Xu & Wu (2013) measured the average drag coefficient of freely tumbling plates at Re_T = 4855–6473 referenced to the full plate area c·w (their Eq. 2.2); the plotted range of C̄_D in their Fig. 4(b) spans 0.4–1.0 and decreases with aspect ratio — i.e. below 1.3 throughout.

Sanity-check reconciliation: §2.2's own check (ρ_p = 300, δ = 3 mm, σ = 1.8) at C_D = 0.95 gives v_t = √(2·1.8·9.81/(1.2·0.95)) = 5.57 m/s, which lands inside Hall et al.'s measured 5.2–5.8 m/s WITHOUT the ad-hoc 1.4. The current text's 1.4 gives 4.58 m/s and the tabulated 1.3 gives 4.76 m/s, both short of the measurement.

**Citation:** Bagheri, G. & Bonadonna, C. (2016) 'On the drag of freely falling non-spherical particles', Powder Technology 301:526–544, doi:10.1016/j.powtec.2016.06.015. FREE full preprint: https://arxiv.org/pdf/1810.08787 — Eq. (14) k_N ≡ C_D/0.463; Eq. (27) F_N; Eq. (28) log k_N = 0.45[−log F_N]^0.99 for 150<ρ'<2130 (mean err 10.9%, max 43.6%, Table 5); Eq. (34) Re-dependent form; Table 3 p.10 Newton's-regime wind-tunnel sample (48 disks, d_eq 16.2–24.3 mm, f 0.1–0.9, ρ'=1280; 72 cylinders, e 0.1–0.7, ρ' 560–1300). Validation data: Almeida, M., Porto, L. & Viegas, D. (2021) 'Characterization of Firebrands Released From Different Burning Tree Species', Front. Mech. Eng. 7:651135, doi:10.3389/fmech.2021.651135 (open access), Table 3 terminal velocities (cork 1.94±0.17, eucalyptus 2.36±0.45, oak 1.69±0.25, pine 3.31±0.37 m/s). Corroboration: Wang, W.B., Hu, R.F., Xu, S.J. & Wu, Z.N. (2013) 'Influence of aspect ratio on tumbling plates', J. Fluid Mech. 733:650–679, Eq. (2.2), Table 4, Fig. 4(b) — free copy https://web.xidian.edu.cn/rfhu/files/20140306_205453.pdf

## [confirmed] §2.2: 'We do not resolve brand orientation… we use a fixed orientation-averaged C_D per shape class' — modelling choice asserted without support.

**Correct value:** CONFIRMED and now sourced. Bagheri & Bonadonna measured, with computer-vision tracking in a 4 m vertical wind tunnel, the mean projected area normal to the flow of freely suspended non-spherical particles and found it 'very close to the average of projected areas of particles in random orientations' — concluding that 'for a freely falling particle at high ρ′, the preferred orientation is very close to the average of its random orientations.' They further found no correlation between k_N and ρ′ once ρ′ > 100, so the orientation-averaged C_D is density-ratio-independent in the firebrand regime (ρ′ ≈ 300). This is exactly the assumption §2.2 makes, and it is now a measurement rather than an assertion. Two caveats to state: (a) the residual spread of k_N from orientation variability is ±10% (max +20%) above and −13% (max −37%) below the random-orientation mean; (b) their high-speed imaging confirms plates at these Re tumble and glide, so a plate firebrand's horizontal drift is not purely wind-advected — §2.2 neglects aerodynamic lift, which is a real, unquantified bias toward under-predicted lateral dispersion.

**Citation:** Bagheri & Bonadonna (2016), arXiv:1810.08787 — §5.2.3 and Fig. 19, Fig. 20 (mean projected area vs random-orientation average); §5.1.2 and Fig. 13 (k_S,max +10%/+20%, k_S,min −13%/−37%); §5.2.3 ('when ρ′ > 100 the drag coefficient is no more affected by ρ′')

## [confirmed] §2.2: 'Hölzer & Sommerfeld (2008) report a mean relative deviation of 383% for the Haider–Levenspiel correlation… We therefore do not rely on the correlation.' — single-source disclaimer.

**Correct value:** CONFIRMED by an independent, free source with a different dataset. Bagheri & Bonadonna benchmark Haider & Levenspiel against their own wind-tunnel measurements of freely falling particles in AIR (the firebrand-relevant regime) and report mean error 91.1%, max 242% in the Newton's regime; 54.9%/242% across all Newton-regime data including liquids; 19.4%/244% across all Re. They attribute the overestimation specifically to H&L having been fitted at low particle-to-fluid density ratio (1 < ρ′ < 15), which is exactly the wrong regime for firebrands in air (ρ′ ≈ 300). The spec's decision to abandon H&L is therefore correct AND the reason is now precisely stated. Note the spec's 383% figure is Hölzer & Sommerfeld's number for their own dataset; Bagheri's 91% is a separate, air-specific measurement — cite both, they are not in conflict.

**Citation:** Bagheri & Bonadonna (2016), arXiv:1810.08787 — Table 5 p.19 (Newton's regime, wind tunnel, 150≤ρ′≤2130: Haider & Levenspiel mean 91.1%, max 242%); Table 6 p.21 (54.9%/242%); Table 7 p.24 (19.4%/244%); §5.2.1 text ('these large overestimations… is due to the fact that they are based on experiments at much lower density (low ρ′)')

## [corrected] §2.1 table, W. US conifer row: shape class 'plate / bluff', m̄ = 0.05–3.5 g, σ = 1.5–6 kg/m², v_t = 3–8 m/s — 'order-of-magnitude estimates assembled from mixed sources'.

**Correct value:** SHAPE CLASS IS WRONG and the row can now be built from primary measurement. NIST's real-scale tree burns state flatly: 'For all of the Douglas-fir experiments performed, the firebrands were cylindrical in shape. In fact, the geometry of the collected firebrands was similar for both species.' Measured mean dimensions:
  Douglas-fir 2.6 m (10% MC): 3 mm diameter × 40 mm length
  Douglas-fir 5.2 m (18% MC): 4 mm diameter × 53 mm length
  Korean pine 4.0 m (11% MC): 5.0 mm diameter × 34 mm length (550 brands measured)
Mass: 'a large percentage… less than 0.3 g'; largest mass class 2.1–2.3 g (2.6 m DF) and 3.5–3.9 g (5.2 m DF and Korean pine).
Bulk density of real collected embers (ponderosa/Douglas-fir pile burn, gas pycnometer on a 20 g subsample of 86,000 imaged particles): ρ_p = 360 ± 9 kg m⁻³ — lower than unburnt wood (Douglas-fir 530–560, ponderosa 350–450) because of thermal degradation. (Note: the paper states 360 ± 9 in §II C and 360 ± 5 in §III A 1 — quote ±9, the value given with the method.)

RECONSTRUCTED ROW (cylinder class, σ referenced to broadside area d×L):
  σ = (π/4)ρ_p d = 0.785 × 360 × d → d=3 mm: 0.848 ; d=4 mm: 1.131 ; d=5 mm: 1.414 kg m⁻²
  C_D = 0.47
  v_t = √(2σg/(ρ_a C_D)):  0.848 → 5.43 ;  1.131 → 6.11 ;  1.414 → 7.01 m s⁻¹
  (full Re-dependent solve, Bagheri Eq. 34, gives 5.43 / 6.11 / 7.07 at Re = 2950 / 4414 / 5113 — the constant-C_D form is accurate to <1% here)
  m̄ = ρ_p·πd²L/4 = 0.102 g (3×40 mm), 0.240 g (4×53 mm), 0.240 g (5×34 mm) — consistent with 'most < 0.3 g'
→ σ = 0.85–1.41 kg m⁻² (spec says 1.5–6: TOO HIGH by 1.8–4.3×);  v_t = 5.4–7.0 m s⁻¹ (spec says 3–8: brackets it but is too wide at the low end);  m̄ ≈ 0.1–0.24 g typical, 3.9 g maximum observed.
Brands per kg: Manzello's pan collection captured 0.45% of mass lost for 2.6 m DF (18±4 g of 4 kg) and 2% for Korean pine (33±15 g of 1.58 kg). At m̄ = 0.10 g that is ≈45 brands/kg (DF) and ≈200 brands/kg (Korean pine) COLLECTED — a hard lower bound, since the pan array did not cover the full deposition footprint. The spec's 100–300 brands/kg is not contradicted but is not established either.

**Citation:** Manzello, S.L., Maranghides, A., Shields, J.R., Mell, W.E., Hayashi, Y. & Nii, D. (2009) 'Mass and size distribution of firebrands generated from burning Korean pine (Pinus koraiensis) trees', Fire and Materials 33:21–31, doi:10.1002/fam.977. FREE full text (NIST public-domain repository): https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=861421 — p.25 (Korean pine 5.0 mm × 34 mm, 550 brands, 'the firebrands were cylindrical in shape'); p.27 (Douglas-fir 3 mm × 40 mm and 4 mm × 53 mm; Fig. 4(a)–(c) mass distributions); p.29 ('Firebrands with masses up to 3.5–3.7 g were observed'; Table I mass ratios). Density: Petersen, A.J. & Banerjee, T. (2024) 'Characterizing firebrands and their kinematics during lofting', Phys. Fluids 36(10):106611, doi:10.1063/5.0227024. FREE open-access copy: https://escholarship.org/content/qt9zv0q3q6/qt9zv0q3q6.pdf — §II C ('a mean ember density of 360 ± 9 kg m⁻³', AccuPyc II gas pycnometer) and §III A 1 (comparison to unburnt wood densities 350–450 and 530–560 kg m⁻³)

## [corrected] §2.2: 'For a plate of half-thickness δ and bulk density ρ_p, the areal density is σ = 2ρ_pδ' — applied uniformly across all shape classes.

**Correct value:** NEW DEFECT FOUND, not previously flagged in either open question. σ = 2ρ_pδ is correct ONLY for a plate. For the cylinder shape classes it is wrong:
  Plate,   A_⊥ = L·I, full thickness 2δ:      σ = m/A_⊥ = ρ_p·2δ = 2ρ_pδ  ✓
  Cylinder, A_⊥ = d·L broadside, d = 2δ:      σ = ρ_p(πd²L/4)/(dL) = (π/4)ρ_p d = (π/2)ρ_pδ = 1.571ρ_pδ
Applying the plate formula to a cylinder overstates σ by 4/π = 1.273 (+27.3%) and therefore v_t by √(4/π) = 1.128 (+12.8%). Since the §4.1 `Brand` struct carries a single `halfThk: f32` and §2.4 regresses that single δ for all shape classes, the σ→v_t conversion MUST branch on shape class. Recommended form for the spec:
  σ = k_shape · ρ_p · δ,   k_shape = 2.000 (plate/disc), 1.571 (cylinder), 2.000 (convoluted ribbon, treated as plate).
This matters most for the W. US conifer and eucalypt simple-cylinder rows, which are exactly the shape classes NIST and Hall measured.

**Citation:** C:\Users\garet\Documents\Code\ForestFire\docs\spec\40-spotting.md §2.2 ('Terminal velocity' paragraph) and §4.1 (`halfThk : f32, // δ, m`); geometry, with shape classes taken from Manzello et al. (2009) p.25/p.27 (conifer brands are cylinders, not plates)

## [corrected] §2.1 table, Eucalypt row: σ = 1.5–4 kg m⁻², v_t = 5.4 / 5.2 / 5.8 m s⁻¹, with C_D = 1.5 for the convoluted ribbon 'fitted to reproduce Hall et al. (2015) v_t'.

**Correct value:** THE FITTING IS BACKWARDS. v_t depends only on the ratio σ/C_D, so exactly one of the pair can be free. C_D is now the SOURCED quantity (Bagheri Eq. 28, ±11% mean error) and σ is the uncertain one (bark thickness × char density are not measured in the spec). Therefore: fix C_D from the correlation and SOLVE σ from Hall's measured v_t, not the reverse. Inverting σ = v_t²ρ_a C_D/(2g) with ρ_a = 1.2, g = 9.81:
  Flat plate,        v_t = 5.4, C_D = 0.95 → σ = 1.694 kg m⁻²  (full thickness 4.7 mm at ρ_p = 360)
  Simple cylinder,   v_t = 5.2, C_D = 0.47 → σ = 0.777 kg m⁻²  (equivalent diameter 2.75 mm at ρ_p = 360)
  Convoluted cyl.,   v_t = 5.8, C_D = 0.95 → σ = 1.955 kg m⁻²  (full thickness 5.4 mm at ρ_p = 360)
→ Eucalypt σ = 0.78–1.96 kg m⁻², replacing the tabulated 1.5–4. The measured v_t values (5.2/5.4/5.8) and burnout times (122/251/429 s, max 353/785/1304 s) are unchanged — they are the primary data and stay as-is.
The fitted C_D = 1.5 row should be DELETED from the §2.2 shape table and replaced by 'convoluted ribbon cylinder → treat as plate, C_D = 0.95, σ calibrated to 1.96 kg m⁻² from Hall et al. (2015)'. This removes the only remaining free parameter in the drag table.

**Citation:** Hall, J., Ellis, P.F., Cary, G.J., Bishop, G. & Sullivan, A.L. (2015) 'Long-distance spotting potential of bark strips of a ribbon gum (Eucalyptus viminalis)', Int. J. Wildland Fire 24:1109–1117 — as already cited in C:\Users\garet\Documents\Code\ForestFire\docs\spec\40-spotting.md §2.1 (v_t and burnout values retained from the spec; the IJWF article itself is paywalled and I did not bypass it). C_D from Bagheri & Bonadonna (2016) arXiv:1810.08787 Eq. (28). Related free background: Ellis, P.F. (2000) 'The aerodynamic and combustion characteristics of eucalypt bark: a firebrand study', PhD thesis, Australian National University, hdl:1885/49422, doi:10.25911/5d7a2814c478d — full PDF free at https://openresearch-repository.anu.edu.au/bitstreams/1ed6d70b-0b3d-4cb5-a80b-a5449d866cb8/download (I downloaded it; it is a page-image scan with no text layer, so I could not extract locators without OCR — flagged as an unexploited free source)

## [unconfirmed] §2.1 table, Grassland / Chaparral / UK mixed rows: σ, v_t, m̄ and brands-per-kg entries.

**Correct value:** STILL UNSOURCED. I found no primary measurement of firebrand mass, size or areal density for grass, chaparral shrub or UK gorse/heather/bracken fuels that I could read. What I did NOT do is invent one. Two concrete things I can supply:

(1) A SPECIFIC, FREE, NAMED SUBSTITUTE that closes all three rows. Bahrani, B., Hedayati, F., Zhou, A., Quarles, S.L. & Weise, D.R. (2020), 'Data for firebrands generated from selected vegetative fuels', USDA Forest Service Research Data Archive, doi:10.2737/RDS-2020-0035, records per-firebrand MASS, PROJECTED AREA and flying distance for 9,249 firebrands from five wildland fuels burned in a full-scale wind tunnel at 5.36 / 11.17 / 17.88 m s⁻¹: chamise (= the chaparral row's actual dominant species), little bluestem grass (= the grassland row), saw palmetto, loblolly pine and Leyland cypress. σ is then measured directly, per brand, as σ = m/a — no shape or density assumption needed. JFSP project 15-1-04-4, free report at https://www.firescience.gov/projects/15-1-04-4/project/15-1-04-4_final_report.pdf. I could not download the archive myself: www.fs.usda.gov returned HTTP 403 / 'The request is blocked' to every user-agent I tried. This is an access failure on my side, NOT a paywall — the data is free and the integrator on a normal browser should get it.

(2) The method is already validated on the sibling structural dataset. Hedayati et al. (2019) Table 1 reports, for firebrands from burning residential corner assemblies, mean/median mass and mean/median projected area at three wind speeds, and states that the strong mass–area correlation (0.83/0.72/0.90) 'suggests that there is a linear correlation between them… approximated as m = Ka'. K IS σ. Computing it: median m/median a = 0.02 g/1.26 cm² = 0.159 kg m⁻²; 0.06/2.08 = 0.288; 0.14/2.99 = 0.468 kg m⁻² at low/medium/high wind. So σ is genuinely near-constant within a fuel and rises with wind speed (thicker brands survive stronger flows) — which is the shape of the parameterisation the spec needs.

INTERIM VALUES, EXPLICITLY MARKED 'ASSUMED', preserving the tabulated v_t (which is the physically meaningful column) while adopting the corrected C_D. Rescale σ_new = σ_old × C_D_new/2.0:
  Grassland  (thin plate, C_D 0.95): σ = 0.048–0.19 kg m⁻², v_t = 0.9–1.8 m s⁻¹
  Chaparral  (plate, C_D 0.95):      σ = 0.24–1.43 kg m⁻²,  v_t = 2.0–5.0 m s⁻¹
  UK mixed   (plate, C_D 0.95):      σ = 0.095–0.475 kg m⁻², v_t = 1.3–3.0 m s⁻¹
Weak external support for the grassland figure: grass-leaf mass per unit area is ~0.04–0.15 kg m⁻², which is where the rescaled range lands, whereas the current 0.1–0.4 kg m⁻² would require grass fragments 3–10× the areal density of a grass leaf. Weak external support for UK mixed: Almeida et al. (2021) Table 3 measured Q. robur (oak, a UK-mixed component) leaf terminal velocity at 1.69 ± 0.25 m s⁻¹, inside the 1.3–3.0 range.

**Citation:** Bahrani, B., Hedayati, F., Zhou, A., Quarles, S.L. & Weise, D.R. (2020) 'Data for firebrands generated from selected vegetative fuels', Forest Service Research Data Archive, Fort Collins CO, doi:10.2737/RDS-2020-0035 — catalog https://www.fs.usda.gov/rds/archive/catalog/RDS-2020-0035 (free; returned HTTP 403 to my fetcher, not paywalled). JFSP 15-1-04-4 final report: https://www.firescience.gov/projects/15-1-04-4/project/15-1-04-4_final_report.pdf. Method validation: Hedayati, F., Bahrani, B., Zhou, A., Quarles, S.L. & Gorham, D.J. (2019) 'A Framework to Facilitate Firebrand Characterization', Front. Mech. Eng. 5:43, doi:10.3389/fmech.2019.00043 (open access) — Table 1 (mass mean/SD/median 0.09/0.24/0.02, 0.25/1.28/0.06, 0.38/1.44/0.14 g; projected area 2.10/2.72/1.26, 3.90/6.48/2.08, 4.87/7.87/2.99 cm²; correlations 0.83/0.72/0.90) and the text statement 'm = Ka'. Oak leaf v_t: Almeida, Porto & Viegas (2021) Front. Mech. Eng. 7:651135, Table 3

## [corrected] §2.1: brand size is a single characteristic scale (m̄ per biome) with a well-defined mean.

**Correct value:** NOT SUPPORTED for mixed wildland fuels — worth one sentence in the spec because it affects how §4.2 samples spawned brands. Petersen & Banerjee imaged 86,000 individual embers from a ponderosa/Douglas-fir pile burn without pre-selection (the usual practice of hand-picking large brands biases the distribution) and found the PDFs of projected area, longest dimension and equivalent diameter all follow POWER LAWS with slope ≈ −2 across three decades (100 µm to 10 cm), not the lognormal distributions previously reported. They state explicitly that 'we do not observe ember size distributions with a defined mean or mode.' The −2 exponent is the signature of brittle fragmentation. Ember aspect ratio s₂/s₁ is broadly flat over 0.3–1.0. Practical consequence for §4.2: sampling m̄ from a single mean is defensible only because the spec truncates to brands large enough to ignite; the spec should say that the truncation, not a physical mode, is what defines m̄, and that the sampled distribution should be a truncated power law with exponent −2 in projected area rather than a delta or lognormal.

**Citation:** Petersen, A.J. & Banerjee, T. (2024), Phys. Fluids 36:106611, free at https://escholarship.org/content/qt9zv0q3q6/qt9zv0q3q6.pdf — §III A 3 'Ember size' and Figs. 3(b), 3(c), 3(d) (power laws with slope near −2; 'these differ from observations of the past, which most often report lognormal distributions'); §III A 4 and Fig. 3(e) (aspect ratios 0.3 < s₂/s₁ < 1 'in equal proportion'); §II C (86,000 particles, unbiased dilution/imaging method)

## RECOMMENDATION

WHAT THE SPEC SHOULD NOW SAY

§2.2 shape table — replace wholesale. Reference areas must be stated, because that is where the old numbers went wrong:

| Shape class | Reference area A_⊥ | C_D (orientation-avg.) | Source |
|---|---|---|---|
| Sphere / compact cone | πd_eq²/4 | 0.463 | Bagheri & Bonadonna 2016 Eq. (14) — confirms the old 0.47 |
| Cylinder, AR 2:1–13:1 | broadside d×L | 0.47 | B&B Eq. (28), F_N = f²e(d_eq³/LIS) = 0.375 at AR 4:1 → k_N = 1.561 |
| Flat plate / disc, f = 0.02–0.06 | plan area L×I | 0.95 | B&B Eq. (28); 0.75 at f=0.10, 1.12 at f=0.015 |
| Convoluted ribbon cylinder | plan area | 0.95 (treat as plate) | σ, not C_D, is the calibrated quantity |

Delete the sphericity column (φ) — B&B show sphericity is the wrong descriptor and correlate on flatness/elongation instead. Delete the fitted C_D = 1.5. Change the §2.2 sanity check from C_D = 1.4 to 0.95: it then gives 5.57 m/s against Hall's measured 5.2–5.8, which the old 1.4 (4.58 m/s) did not.

§2.2 terminal velocity — make σ shape-dependent: σ = k_shape·ρ_p·δ with k_shape = 2.000 for plates and 1.571 (= π/2) for cylinders. The current uniform 2ρ_pδ overstates cylinder σ by 27% and v_t by 13%.

§2.1 biome table — replace σ and v_t as follows. Conifer and eucalypt are now DERIVED FROM MEASUREMENT; the other three are explicitly ASSUMED:

| Biome | Shape | σ (kg m⁻²) | C_D | v_t (m s⁻¹) | status |
|---|---|---|---|---|---|
| W. US conifer | CYLINDER (was 'plate/bluff' — wrong) | 0.85–1.41 | 0.47 | 5.4–7.0 | calibrated |
| Grassland | thin plate | 0.048–0.19 | 0.95 | 0.9–1.8 | estimated |
| Chaparral | plate | 0.24–1.43 | 0.95 | 2.0–5.0 | estimated |
| Eucalypt | plate / cyl / convoluted | 1.69 / 0.78 / 1.96 | 0.95 / 0.47 / 0.95 | 5.4 / 5.2 / 5.8 | calibrated |
| UK mixed | plate | 0.095–0.475 | 0.95 | 1.3–3.0 | estimated |

Every column now reconciles exactly under v_t = √(2σg/(ρ_a C_D)) with ρ_a = 1.2, g = 9.81. Also correct the conifer m̄ to 0.10–0.24 g typical / 3.9 g maximum observed, and add ρ_p = 360 ± 9 kg m⁻³ as the sourced default char density.

CLOSE OPEN QUESTION #9's hazard (i) OUTRIGHT: there is no factor-of-2 error and no half-thickness ambiguity in the data. The σ column was and is areal density. Record the actual cause instead: the four non-eucalypt rows were generated at an undocumented C_D = 2.0 (equivalently v_t = √(σg/ρ_a)), recoverable to 1% from the grassland row at both ends. Hazard (ii) is closed by the table above.

CLOSE OPEN QUESTION #10: sourced, with the reference-area convention now written down — which was the actual missing piece.

VALIDATION STATUS. The C_D entries should carry **validated**: they come from a peer-reviewed correlation fitted to 300 particles in a 4 m vertical wind tunnel at ρ′ = 150–2130 and Re = 10³–3×10⁵ (10.9% mean error), and they independently reproduce four measured leaf/needle terminal velocities to within 20–30%. The conifer and eucalypt rows should carry **calibrated**. Grassland, chaparral and UK mixed must carry **estimated** and stay marked as placeholders.

IF THE ESTIMATED ROWS CANNOT BE CLOSED, the verifiable substitute is named and free: USDA FS Research Data Archive RDS-2020-0035 (doi:10.2737/RDS-2020-0035), per-firebrand mass AND projected area for 9,249 brands from chamise (chaparral), little bluestem grass (grassland), saw palmetto, loblolly pine and Leyland cypress. σ = m/a falls straight out per brand with no shape or density assumption. I could not retrieve it — www.fs.usda.gov returned HTTP 403 to every user-agent I tried — but this is an access block on my side, not a paywall; a normal browser should get it. Second unexploited free source: the Ellis (2000) ANU thesis PDF (hdl:1885/49422) downloads fine but is a page-image scan needing OCR.

KNOWN BIAS DIRECTION of the interim estimated rows, so it can be corrected for: they preserve the tabulated v_t exactly and adjust σ downward by 0.475×. If a future measurement shows real grass/shrub brands are thicker than a single leaf, σ and v_t both rise together; the σ values are therefore a LOWER bound and in-domain spot distances derived from them are biased LONG (slower fall → longer flight). Independently, neglecting aerodynamic lift on tumbling-and-gliding plates biases lateral dispersion LOW. These two biases act in opposite directions on the spot-distance distribution and should not be assumed to cancel.
