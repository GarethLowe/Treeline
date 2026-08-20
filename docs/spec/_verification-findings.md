# Verification Findings

Adversarial review pass over the drafted spec sections. Each finding was
confirmed against primary sources by an independent agent. Corrections are
applied to the section files; this file is the audit trail.


---

## Surface Fire Spread Physics  
`20-surface-spread.md` — **5 finding(s)**

> The section is unusually sound for a draft of this scope — I attacked all 15 flagged claims plus the surrounding text and only five things broke, none of them structural. The Rothermel constant set is essentially correct (β_op, Γ′_max, ξ, η_M, η_s, B, E, φ_s, ε, Q_ig, A all match BEHAVE source verbatim), the entire 13-row Scott & Burgan fuel table checks out against the canonical parameter set, the Andrews/Cruz/Rothermel 2013 wind-limit recommendation is quoted accurately rather than the more common "they removed the limit" misreading, the CSIRO grassland coefficients are right down to the eaten-out branch, and the elliptical level-set Hamiltonian is genuinely correct — the derived focal offset c = (R_head − R_back)/2 provably equals √(b²−a²) given the stated HB and a = b/LB, so "ignition point at the rear focus" is self-consistent rather than the usual hand-wave. The biggest weakness is the §4.2 worked example, which is the one place the author stopped checking: it is declared "the acceptance test for the kernel" but its stated inputs (fully cured) do not correspond to the scenario it is validated against (D2L2, two-thirds cured), and its stated answer (~12 m/min) does not follow from its own stated intermediates (~18 m/min). That is the dangerous kind of error, because an implementer will tune the kernel until it reproduces 12 m/min from fully cured GR2 and thereby bake in a ~50% compensating bias. A secondary theme is that all five errors are transcription/arithmetic rather than conceptual — 0.1333 for 0.133, /(1+S_T) for ×(1−S_T), an inverted unit factor, one mis-evaluated WAF — which suggests the physics reasoning was done carefully and the numeric typing was not, so the remaining risk is concentrated in whatever numbers a reviewer did not evaluate by hand rather than in the model choices.


### 1. [certain] §4.2 wind factor: "C = 7.47 · exp(−0.1333·σ^0.55)" (and claim 2 in the flagged list), with worked value C = 1.218×10⁻³ and φ_w = 22.4 at σ = 2000, U = 440 ft/min.

**Problem:** The Rothermel (1972) Eq. 48 coefficient is 0.133, not 0.1333. Confirmed verbatim in the canonical BEHAVE implementation (firelab/behave, src/behave/surfaceFire.cpp): `windC_ = 7.47 * exp(-0.133 * pow(sigma, 0.55));`. The extra digit is not a rounding of 0.133 — it changes C by +2.4% at σ = 2000 and propagates directly into φ_w and R. All the other constants on the same line (0.02526/0.54, 0.715/3.59e-4, 7.47, 0.55) are correct, which makes this look like a transcription slip rather than a deliberate refit.

**Correction:** C = 7.47 · exp(−0.133·σ^0.55).  Worked values at σ = 2000 ft⁻¹: C = 1.247×10⁻³, B = 1.531, E = 0.3487, φ_w = 22.9 (not C = 1.218×10⁻³, φ_w = 22.4).


### 2. [certain] §4.2: "w_n = w₀ / (1 + S_T),   S_T = 0.0555   (Eq. 24)"

**Problem:** Rothermel's net (mineral-free) fuel load is a *subtraction* of the mineral fraction, not a division: w_n = w₀(1 − S_T). Confirmed in BEHAVE (src/behave/surfaceFuelbedIntermediates.cpp): `wnDead[i] = loadDead_[i] * (1.0 - totalSilicaContent_);` with `totalSilicaContent_ = 0.0555`. The draft's form gives 0.94737·w₀ instead of 0.94450·w₀ — only a 0.3% error in I_R, so it will never be caught by an acceptance test, but it is the wrong equation and will silently disagree with BehavePlus at the fourth digit forever.

**Correction:** w_n = w₀ · (1 − S_T),   S_T = 0.0555   (Rothermel 1972, Eq. 24)


### 3. [certain] §4.1 unit table, fuel load row: "Fuel load w₀ | kg m⁻² | lb ft⁻² | ×0.204816 (English→SI)"

**Problem:** 0.204816 is the SI→English factor (1 kg m⁻² = 0.204816 lb ft⁻²); the English→SI factor is 4.88243 (1 lb ft⁻² = 0.45359237 kg / 0.09290304 m² = 4.88243 kg m⁻²). Every other row in the table is stated in the English→SI direction (×0.3048 ft→m, ×3.28084 ft⁻¹→m⁻¹, ×0.00508 ft min⁻¹→m s⁻¹, ×2.326 BTU lb⁻¹→kJ kg⁻¹, ×0.189275 BTU ft⁻² min⁻¹→kW m⁻²), so this row is both mislabelled and inconsistent with its neighbours. Since §4.1 is the normative spec for the kernel's entry/exit conversion, an implementer following the table literally gets fuel loads wrong by a factor of 23.8.

**Correction:** Fuel load w₀ | kg m⁻² | lb ft⁻² | ×4.88243 (English→SI); ×0.204816 (SI→English)


### 4. [certain] §4.2 worked check: "GR2, fully cured, M_f = 6%, U = 5 mi h⁻¹ = 440 ft min⁻¹ … w₀ = 1.10 t ac⁻¹ … Resulting R ≈ 12 m min⁻¹, against ~35 ch h⁻¹ (11.8 m min⁻¹) … for scenario D2L2. This is the acceptance test for the kernel."

**Problem:** The stated result does not follow from the stated inputs, and the stated inputs are not scenario D2L2. Working Rothermel through with the draft's own numbers (σ = 2000, β = 0.001578, β/β_op = 0.238, w_n = 0.04770 lb ft⁻², η_M = 0.5563 at r = 0.4, η_s = 0.4174, Γ′_max = 15.40, A = 0.3250, Γ′ = 12.38, I_R = 1097 BTU ft⁻² min⁻¹, ξ = 0.03362, ε = 0.9333, Q_ig = 316.96, ρ_b = 0.0505) gives R = I_R·ξ·(1+φ_w)/(ρ_b·ε·Q_ig) = 59 ft min⁻¹ ≈ 18 m min⁻¹ ≈ 54 ch h⁻¹ — roughly 50% above the quoted 12 m min⁻¹, not a match to it. The ~35 ch h⁻¹ target is right, but it belongs to D2L2, where L2 sets live herbaceous moisture to 60%, i.e. T = 0.667 (two-thirds cured), not fully cured. Recomputing with dead 1-h = 0.767 t ac⁻¹ and live herb = 0.333 t ac⁻¹ at 60% (live M_x from Eq. 88 ≈ 4.7, η_M,live ≈ 0.745, f_dead = 0.700, σ ≈ 1820) gives R ≈ 38 ft min⁻¹ ≈ 11.7 m min⁻¹ ≈ 35 ch h⁻¹, which does match. As written the acceptance test would be coded against the wrong fuel state and the kernel would be 'calibrated' by introducing a compensating bug.

**Correction:** Worked check (GR2, scenario D2L2: dead 1-h M_f = 6%, live herbaceous M_f = 60% ⇒ T = 0.667, so w_dead,1h = 0.10 + 0.667×1.00 = 0.767 t ac⁻¹ and w_live,herb = 0.333 t ac⁻¹; U = 5 mi h⁻¹ = 440 ft min⁻¹, 0% slope). Weighted σ ≈ 1820 ft⁻¹, ρ_b = 0.0505 lb ft⁻³, β = 0.001578, β_op = 0.007164, β/β_op = 0.220; C = 1.944×10⁻³, B = 1.454, E = 0.372, φ_w ≈ 23.8; live M_x (Eq. 88) ≈ 4.7; I_R ≈ 1.15×10³ BTU ft⁻² min⁻¹. Resulting R ≈ 38 ft min⁻¹ = 11.7 m min⁻¹ ≈ 35 ch h⁻¹, matching the Scott & Burgan GR2 D2L2 value. (For reference, the *fully cured* GR2 case at the same wind gives R ≈ 18 m min⁻¹ ≈ 54 ch h⁻¹.)


### 5. [certain] §4.5 sanity values: "a 20 m ponderosa stand at CC = 0.6, CR = 0.5 → f = 0.10, WAF ≈ 0.12"

**Problem:** Arithmetic slip. With H = 20 m = 65.62 ft and f = 0.10: √(f·H) = √6.562 = 2.562; (20 + 0.36·65.62)/(0.13·65.62) = 43.62/8.530 = 5.114; ln = 1.632; WAF = 0.555/(2.562×1.632) = 0.133. The two unsheltered sanity values in the same sentence (GR2 → 0.362, SH7 → 0.547) are exactly right, so this one reads as a checkable reference number and is 11% low.

**Correction:** a 20 m ponderosa stand at CC = 0.6, CR = 0.5 → f = 0.10, WAF ≈ 0.133


---

## 3D Canopy Heat Transfer & Crown Fire  
`30-canopy-heat-crown.md` — **2 finding(s)**

> This section is unusually sound for a draft of this length: I checked every fire-science citation the author flagged against primary sources and the four Van Wagner / Scott & Reinhardt claims (I0 = [CBH(460+25.9 FMC)/100]^1.5 with the 875 kW/m example, S0 = 0.05 kg/m2/s and R'active = 3.0/CBD, Byram 0.0775 I^0.46, and the dynamic a = -ln(0.1)/(0.9 dR) with a = 0.238/0.108) reproduce RMRS-RP-29 eq. 11/13/14/26 and Appendix A verbatim, including the "single observation" provenance of the 100 divisor and the S&R variant that drops the 0.9 in favour of R'_SA. The Cruz & Alexander (2010) four bias sources, the 95-135% FMC envelope from Cruz & Alexander (2014), the di Blasi/Sullivan (arXiv:0706.3074) 240 kJ/mol and 150 kJ/mol figures, the McAllister 1-3 g/m2/s critical mass flux, the Hilpert C/m table, and the Churchill-Bernstein and Siegel & Howell forms are all correct as written. The engineering arithmetic is equally clean - Re/Nu/h/Bi, the 600 K air properties, Quintiere's 4.2 s, tau = 1.2 s, the thermal penetration depth, sigma*T^4 = 117.6 kW/m2, the entire brick-pool and SH-volume memory budget, the 1.143 3D mip factor, and the 128 MiB maxStorageBufferBindingSize default (which I checked against the live W3C spec, not memory) all hold; the cone-trace timing is defensible because the 9.6 MB emission/extinction pyramid fits inside AD106's 32 MB L2, so it is not VRAM-bandwidth bound. The biggest weakness is the pyrolysis kinetics table: the author correctly flags it as unverified, but the specific defect is worse than "unverified" - the pre-exponentials are Grishin's while the activation temperatures are not, which is the exact A/E mixing error the surrounding paragraph warns against. Two secondary concerns I could not raise to the level of confirmed errors but which the author should re-derive: (a) the brick pool is sized from *voxel* occupancy (10-18%) but allocation is at 8^3 brick granularity, and a thin terrain-following canopy band will partially fill far more than 25% of the 32768 bricks, so 8192 may overflow rather than carry headroom (and "25% headroom" conflates "25% of the dense grid" with headroom, which is really 39%); (b) the line-plume entrainment coefficient of 0.08-0.11 sits below the modern consensus of alpha = 0.11 +/- 15% (van Reeuwijk et al., JFM 2022) and well below Rouse's classical 0.16, though top-hat vs Gaussian convention could account for the offset, so state the convention explicitly.


### 1. [likely] §7.6 kinetics table attributes A_w = 6.0e5 K^0.5/s with E_w/R = 5800 K and A_p = 3.63e4 /s with E_p/R = 7250 K jointly to "Grishin 1997; Morvan & Dupuy 2004 form".

**Problem:** The pre-exponentials are Grishin's, but the activation temperatures are not. Grishin's published set (reproduced with the constants spelled out in Barovik & Taranchuk, Math. Model. Anal. 15(2):161-174, 2010, and independently in the Perminov/Tomsk literature) is k01 = 3.63e4 s^-1 with E1/R = 9400 K for pyrolysis and k02 = 6e5 K^1/2 s^-1 with E2/R = 6000 K for evaporation. The draft has therefore paired Grishin's A values with E values from a different lineage (the Larini/Porterie/Morvan French multiphase set) - precisely the compensation-effect mixing the draft's own paragraph warns against. The magnitude matters: exp(-7250/T) vs exp(-9400/T) at T = 600 K differs by a factor of ~36 in pyrolysis rate, which shifts the pyrolysis onset by roughly 100-150 K at fixed rate.

**Correction:** Replace the source line with: "Kinetics, three-stage (Larini et al. 1998 / Morvan & Dupuy 2004 multiphase set; R = 8.314 J mol-1 K-1). NOTE: these are NOT Grishin's (1997) values. Grishin's own pairs are pyrolysis A = 3.63e4 s-1 with E/R = 9400 K (E = 78.1 kJ/mol) and evaporation A = 6e5 K^1/2 s-1 with E/R = 6000 K (E = 49.9 kJ/mol). Pick one lineage and use both members of the pair from it; do not cite Grishin (1997) for E/R = 7250 K or 5800 K."


### 2. [certain] §7.5, radiative preheat example: "20 m ahead, view factor ~0.03, transmittance ~0.5: G = 3.5 kW m-2, q'''_rad = 2.1 kW m-3 -> 17 kW/voxel -> ~200 s."

**Problem:** The arithmetic is inconsistent with the section's own emissive power by a factor of 2. Section 7.4 gives sigma*T_f^4 = 117.6 kW/m2 at 1200 K, and section 7.3 gives eps_f > 0.9 for flame depth > 3 m, so E_f = 106 kW/m2. Then G = 106 x 0.03 x 0.5 = 1.6 kW/m2, not 3.5. Downstream, q'''_rad = kappa*G = 0.6 x 1600 = 0.95 kW/m3, giving 7.6 kW per 8 m3 voxel and 3.6 MJ / 7.6 kW = ~470 s. The stated 3.5 kW/m2 would require a source emissive power of ~233 kW/m2, i.e. a grey flame at ~1430 K, which contradicts the T_f = 1200 K used two subsections earlier. (The qualitative conclusion is unaffected - the ratio becomes ~520x rather than ~235x, still two orders of magnitude.)

**Correction:** Replace the bullet with: "- 20 m ahead, view factor ~0.03, transmittance ~0.5: G = 106 x 0.03 x 0.5 = 1.6 kW m-2, q'''_rad = kappa*G = 0.6 x 1.6 = 0.95 kW m-3 -> 7.6 kW/voxel -> ~470 s (~8 min)." and change the following sentence to "Between two and three orders of magnitude apart, ..."


---

## Regional Models: Eucalypt, Chaparral, UK  
`60-regional-models.md` — **5 finding(s)**

> The section is unusually sound for a draft of this length — I could not break the FFDI equation, the Noble drought factor, the KBDI SI form, the Viney moisture approximation, the Mk5 ROS/flame-height pair, the complete Vesta Mk1 coefficient set and its unit conventions, the 35 %/54 % validation split, the entire Canadian FWI System (every code, every constant, the 46 °N day-length tables, the BUI/f(D)/FWI/DSR chain), the Scott & Burgan SH5/SH7 parameters, the Anderson 1982 FM4 imperial loadings, the iForest Calluna fuel models, de Jong et al.'s GB findings including the MOFSI/FWI statement and the 2 May 2011 99th-percentile result, the NZ gorse 36 %/19 % thresholds, Dennison & Moritz's 79 % LFM threshold, Weise et al.'s correlation figures, or the eucalypt spotting/bark-class material — all of which check out against primary sources, and the Dowdy Appendix A continuous latitude/day-of-year day-length formulation the draft leans on for the UK really does exist. The errors found are a genuine equation error (the Griffiths drought factor exponent, 1.3 not 1.5 — the one place where the author's own uncertainty flag was justified), one arithmetic overstatement, one misquoted published ROS range, one bad unit conversion, and one unimplementable time-period table. The section's biggest remaining weakness is not error but unverifiability: the Anderson et al. (2015) shrubland exponents b and c are explicitly unread guesses (≈0.9 and ≈0.2) sitting behind the entire chaparral closure, and I could not obtain the paper to confirm or refute them — that gap should be closed before any code is written, because the whole §7.2.3 recommendation rests on numbers nobody has yet seen. Secondarily, the performance framing ('<0.5 GFLOP per fire step, well under 1 ms') counts arithmetic rather than the binding constraint: at ~40 bytes of state read+written per cell over 4.19 M cells the closure pass is ~170 MB of traffic, which is ~0.65 ms at the 4070 Laptop's ~256 GB/s — still fine, but the headroom is bandwidth-limited and roughly 20× tighter than the FLOP argument implies.


### 1. [certain] Griffiths (1999) limited drought factor: `x = N^1.5 / (N^1.5 + P - 2)   for N ≥ 1, P > 2 mm ;  x = 1 otherwise`

**Problem:** The exponent in the Griffiths/Finkele rainfall-event term is 1.3, not 1.5. (The 1.5 exponent belongs to the *Noble et al.* drought factor, where it appears as (N+1)^1.5 — the draft has carried it across into the Griffiths form.) The x = 1 'otherwise' branch also swallows the separate N = 0 case, which Finkele et al. (2006) handle with an effective event age of 0.8 d. Verified against the xclim reference implementation of Finkele et al. (2006)/Griffiths (1999) (`x_ = N**1.3 / (N**1.3 + P - 2.0)`) and against the published description of the formulation (event age w, rainfall event P, w^1.3/(w^1.3 + P − 2) for w ≥ 1 and P > 2 mm). Shipping 1.5 makes the drought factor recover too fast after rain and therefore biases FFDI high across the whole eucalypt scenario set.

**Correction:** D = min[ 10 , 10.5·(1 − e^(−(SMD+30)/40)) · (41x² + x) / (40x² + x + 1) ]
x = N^1.3 / (N^1.3 + P − 2)        for N ≥ 1 and P > 2 mm
x = 0.8^1.3 / (0.8^1.3 + P − 2)    for N = 0 and P > 2 mm
x = 1                              otherwise
where the rainfall event is the run of consecutive days with >2 mm within the previous 20 days that yields the lowest x, P is that event's total (mm) and N is the number of days since the event's largest daily fall. Finkele et al. (2006) additionally cap x at x_lim = 1/(1 + 0.1135·SMD) for SMD < 20 mm and 75/(270.525 − 1.267·SMD) for SMD ≥ 20 mm.


### 2. [certain] "the model is extremely sensitive to `H_ns` — doubling near-surface height raises R by ~65 %"

**Problem:** Arithmetically inconsistent with the equation stated three lines above it. H_ns enters as (FHS_ns·H_ns)^0.6366, so doubling H_ns multiplies that factor by 2^0.6366 = 1.555, i.e. +55 % on the wind-driven term — and less than that on R itself, because the additive 30 m h⁻¹ zero-wind term is unaffected. At the model's own worked conditions (U10 = 30 km h⁻¹, FHS_s = FHS_ns = 3.5, H_ns 20→40 cm) R rises from ~1225 to ~1890 m h⁻¹, i.e. +54 %, not 65 %. The overstatement matters because it is the stated justification for making H_ns a first-class per-cell field.

**Correction:** "the model is strongly sensitive to `H_ns` — doubling near-surface height multiplies the wind-driven term by 2^0.6366 = 1.55 (+55 %), and raises R by somewhat less because of the additive 30 m h⁻¹ term (≈ +54 % at U10 = 30 km h⁻¹, FHS_s = FHS_ns = 3.5) — so our procedural understorey generator must emit `H_ns` and both FHS fields as first-class per-cell fields"


### 3. [certain] "Kilmore East 2009 (Cruz et al. 2012) with reconstructed 60–170 m min⁻¹ runs and 33 km spotting"

**Problem:** Misquotes the published range. Cruz et al. (2012, For. Ecol. Manage. 284:269–285) reconstruct rates of fire spread varying between 68 and 153 m min⁻¹, with average fireline intensities up to ~88 000 kW m⁻¹; the 33 km spotting figure is correct. Since this dataset is listed as validation data, the ROS envelope needs to be the published one, not a widened one.

**Correction:** "Kilmore East 2009 (Cruz et al. 2012) with reconstructed runs of 68–153 m min⁻¹, average fireline intensities up to ~88 000 kW m⁻¹, and spotfires up to 33 km ahead of the front"


### 4. [certain] FM4 in SI row: "11.23 | 8.99 | 4.51 | 11.21 t ha⁻¹ (Σ 35.9)"

**Problem:** Two of the four SI conversions are wrong and mutually inconsistent. 1 short ton/acre = 2.24170 t ha⁻¹, so 2.00 t ac⁻¹ = 4.48 t ha⁻¹ (not 4.51) and 5.01 t ac⁻¹ = 11.23 t ha⁻¹ — the draft converts the identical 5.01 t ac⁻¹ figure to 11.23 in the dead-1h column and 11.21 in the live-woody column. The dead-1h/10h/100h/live loadings themselves (5.01/4.01/2.00/5.01 t ac⁻¹), SAVs (2000/1500 ft⁻¹), depth (6 ft) and Mx (20 %) are correct per Anderson (1982) GTR INT-122.

**Correction:** FM4 in SI | 11.23 | 8.99 | 4.48 | 11.23 t ha⁻¹ (Σ 35.93) | 6562 / 4921 m⁻¹ | 1.83 m | 20 %


### 5. [certain] Vesta dead fuel moisture periods: "1: 12:00–17:00 …", "2: other daylight hours", "3: night (20:00–08:59)"

**Problem:** Periods 2 and 3 overlap, so the table cannot be implemented as written: 06:00–08:59 is 'other daylight hours' (period 2) but is also inside the stated night window 20:00–08:59 (period 3). The reference implementation (CSIRO Spark's Vesta model) defines period 2 as 09:00–11:59 and 17:00–19:59 only, with 20:00–08:59 taking the night equation regardless of daylight. Left as-is, an implementer will apply the daytime equation through early-summer dawn hours and get systematically low morning fuel moisture.

**Correction:** | Period | Hours | Equation |
| 1 | 12:00–16:59, clear sky, Oct–Mar | `M = 2.76 + 0.124·H − 0.0187·T` |
| 2 | 09:00–11:59 and 17:00–19:59 | `M = 3.60 + 0.169·H − 0.0450·T` |
| 3 | 20:00–08:59 | `M = 3.08 + 0.198·H − 0.0483·T` |


---

## Firebrand Transport & Spotting  
`40-spotting.md` — **6 finding(s)**

> The section is unusually sound on its citations and its physics — the parts most likely to be sloppy are the parts that hold up. I verified every Albini constant against the actual firelab/behave `spot.cpp` source and all of them match exactly: the ponderosa (12.9, 0.453) / (12.6, −0.256) pair and the whole 14-species table, the four (F0, F1) lofting rows and their exact branch conditions (ratio ≥ 1.0, ≥ 0.5, then duration < 3.5), z_b = F0·t_f^F1·h_f + h_t/2, f = 322(0.474·U20)^−1.01, I_B = (L_f/0.45)^(1/0.46), z_b = 1.055√(f·I_B), the 2.78e−4 drift, the 7.18e−4 flat-terrain formula, the h_c = max(h_c, 2.2·z_b^0.337 − 4.0) floor, and z_b = 12.2·h_f for burning piles. Report numbers (GTR INT-56 1979, RN INT-309 1981, RP INT-309 1983) are right, and the 0.474 factor is correctly described as converting 20-ft mi/h to 10-m m/s. Hall et al. (2015, IJWF 24:1109) is quoted verbatim-correct including all six mean and maximum burnout times; Cruz et al. (2012, FEM 284:269) is correct on 68–153 m/min, 88,000 kW/m, 500 m short-range and 33 km long-range spotting; Ellis (2011, IJWF 20:897), Ganteaume et al. (2009, IJWF 18:951), Sardoy et al. (2008, Combust. Flame 154:478, 10,000 disk brands, bimodal) and Haider & Levenspiel (1989, Powder Technol. 58:63–70) all check out. I re-derived the two physics claims the author expected to be attacked and both are right: v_t = √(2σg/(ρ_a C_D)) does depend only on areal density and the 1.8 kg/m² case really does give 4.6 m/s; and the Heskestad coefficient 3.4[g/(c_p ρ_∞ T_∞)]^(1/3) really does evaluate to 1.028 with Q_c in kW, lofting a 5 m/s brand to 87 m at 10 MW and 874 m at 100 MW. The WGSL struct genuinely lays out to 48 bytes under WebGPU alignment rules, 131,072 × 48 B is 6.29 MB, the bit-packing sums to 32, and the perf estimate is conservative rather than optimistic (the actual ALU and bandwidth costs are microseconds; 0.2–0.35 ms is dominated by dispatch and barrier overhead, which is the honest way to budget it on browser WebGPU). The biggest weakness is not physics or citations but a factor-of-two thickness convention that is inconsistent between §2.2 and §2.4/§4.1 — δ is the half-thickness everywhere except in the terminal-velocity derivation, which silently makes it the full thickness. Because v_t and the burning-brand v_t ∝ √σ coupling are described as "the single most important physical statement in the section", that one convention error propagates into the entire biome parameter table and into the loft-height and spot-distance results. Fix that, the Adusumilli/Blunck attribution, and the 8 MB texture figure, and the section is in good shape.


### 1. [certain] "$Y_j/\bar m_j$ is exactly the 'specific firebrand production' (brands per kg dry mass burned) measured by Hedayati et al. / Manzello (2021, *Front. Mech. Eng.* 7:655593), who found sagebrush produces ~6× more brands per kg than ponderosa pine..."

**Problem:** Misattribution. Front. Mech. Eng. 7:655593 (2021) is "Firebrand Generation Rates at the Source for Trees and a Shrub" by Sampath Adusumilli, James E. Chaplen and David L. Blunck. Neither Hedayati nor Manzello is an author. Hedayati et al.'s framework paper is a different article (Front. Mech. Eng. 5:43, 2019). All the *numbers* the draft quotes (sagebrush ~6x ponderosa at similar MC; Douglas-fir and ponderosa comparable; specific production increasing exponentially with decreasing MC; ≤2000 firebrands total for 2.7-4.2 m Douglas-fir) are correct — only the author attribution is wrong.

**Correction:** $Y_j/\bar m_j$ is exactly the "specific firebrand production" (brands per kg dry mass burned) measured by Adusumilli, Chaplen & Blunck (2021, *Front. Mech. Eng.* 7:655593, "Firebrand Generation Rates at the Source for Trees and a Shrub"), who found sagebrush produces ~6x more brands per kg than ponderosa pine at comparable moisture content, that Douglas-fir and ponderosa are comparable, and that specific production rises exponentially with decreasing fuel moisture. Total production for 2.7-4.2 m Douglas-fir was ≲2000 brands per burn.


### 2. [certain] "trilinear `textureSampleLevel` from a `texture_3d<f32>` (rgba16float, 128×128×64 = 8 m horizontal / 2 m vertical) holding the sim's velocity field... rgba16float 3D at that resolution is 4 MB."

**Problem:** Arithmetic error, factor of 2. 128 x 128 x 64 = 1,048,576 texels; rgba16float is 4 channels x 2 bytes = 8 B/texel; 1,048,576 x 8 = 8,388,608 B = 8.39 MB, not 4 MB. (4 MB would be correct only for rg16float or rgba8.) The conclusion that the footprint is negligible survives, but the stated number is wrong and would be wrong again if the resolution is later scaled.

**Correction:** rgba16float 3D at that resolution is 8.4 MB (1,048,576 texels x 8 B). If 4 MB is the actual budget, drop to rgba8unorm with a velocity scale factor, or halve the vertical resolution to 128x128x32.


### 3. [certain] §2.2: "For a plate of areal density $\sigma = \rho_p\delta$ (kg m⁻²)... Sanity check: $\sigma = 1.8$ kg m⁻² ($\rho_p$ = 300 kg m⁻³, $\delta$ = 6 mm), $\rho_a$ = 1.2, $C_D$ = 1.4 gives $v_t$ = 4.6 m s⁻¹" — while §2.4 and the `Brand` struct both define $\delta$ as the *half*-thickness (`halfThk : f32, // 12  δ, m`).

**Problem:** Internal inconsistency of a factor of 2 in mass, sqrt(2) in terminal velocity. The force balance $mg = \tfrac12\rho_a C_D A v_t^2$ with $m = \rho_p t A$ requires $t$ = FULL plate thickness, so $\sigma = 2\rho_p\delta$ when $\delta$ is the half-thickness. As written, a brand carrying $\delta$ = 6 mm in the struct has $\sigma$ = 3.6 kg m⁻² and $v_t$ = 6.5 m s⁻¹, not the 4.6 m s⁻¹ quoted. $\delta$ must stay the half-thickness for §2.4's $\beta_0 = \delta_0/t_\text{burnout}$ (two-sided surface regression) to be right, so §2.2 is the half that is wrong. This propagates into the biome table's $\rho_p\delta$ / $v_t$ columns and into the burning-brand $v_t \propto \sqrt\sigma$ coupling.

**Correction:** For a plate of half-thickness $\delta$ and bulk density $\rho_p$, the areal density is $\sigma = 2\rho_p\delta$ (kg m⁻²), so $v_t = \sqrt{4\rho_p\delta g/(\rho_a C_D)}$. Sanity check: $\rho_p$ = 300 kg m⁻³, $\delta$ = 3 mm (6 mm total thickness) gives $\sigma$ = 1.8 kg m⁻²; with $\rho_a$ = 1.2, $C_D$ = 1.4, $v_t = \sqrt{2(1.8)(9.81)/(1.2\cdot1.4)} = 4.6$ m s⁻¹.


### 4. [certain] "Drag relaxation time $\tau = m/(\tfrac12\rho_a C_D A|\mathbf v-\mathbf u|)$ is ~0.02 s for a thin plate in a 20 m s⁻¹ plume — below our 1/60 s frame time, so explicit Euler would need substepping."

**Problem:** The stated numbers contradict the stated conclusion: 1/60 s = 0.0167 s, so tau = 0.02 s is ABOVE the frame time, not below it, and at that tau explicit Euler would be marginally stable rather than requiring 4 substeps. tau = sigma/(0.5*rho_a*C_D*|dv|); with |dv| = 20 m/s, rho_a = 1.2, C_D = 1.3 the denominator is 15.6, so tau = 0.02 s corresponds to sigma ≈ 0.31 kg m⁻². The argument only works for the genuinely thin classes (grass/leaf, sigma = 0.1-0.4 kg m⁻²).

**Correction:** Drag relaxation time $\tau = \sigma/(\tfrac12\rho_a C_D|\mathbf v-\mathbf u|)$ is ~0.006-0.013 s for the thin-plate classes ($\sigma$ = 0.1-0.2 kg m⁻²) in a 20 m s⁻¹ plume — below our 1/60 s = 0.0167 s frame time, so explicit Euler would need substepping.


### 5. [likely] "Hölzer & Sommerfeld (2008) report Haider–Levenspiel deviations up to ~2000% for disc/plate particles (~40% for cylinders and cuboids)."

**Problem:** The ~40% figure for cylinders and cuboids is not what Hölzer & Sommerfeld report for Haider–Levenspiel. They report a mean relative deviation of 383% for Haider–Levenspiel (and 384% for Ganser) over their whole dataset, with average errors in the 348-383% range and maximum errors exceeding 1000% specifically for cuboids and disks. The low double-digit figures (14.1% overall, ~29% for cuboids and cylinders) belong to Hölzer & Sommerfeld's OWN new correlation, not to Haider–Levenspiel. As written the draft makes Haider–Levenspiel look usable for cylinders, which is the opposite of the source's finding — and the draft's shape table does keep a Haider–Levenspiel-justified cylinder entry on that basis.

**Correction:** **Caveat, stated plainly:** Hölzer & Sommerfeld (2008, *Powder Technol.* 184:361-365) report a mean relative deviation of 383% for the Haider–Levenspiel correlation across their full dataset (versus 14.1% for their own correlation), with average errors of ~348-383% and maximum errors exceeding 1000% for cuboids and disks. We therefore do not rely on the correlation for any of our shape classes, and use fixed orientation-averaged $C_D$ values throughout.


### 6. [likely] "Mountain terrain applies a fixed-point correction over a sinusoidal ridge–valley profile, iterated 6 times: $x_{k+1} = \frac{x_{\text{flat}}}{L_{rv}} - \frac{E_{rv}}{10\pi\cdot 1000}[\cos(\pi x_k - \tfrac{\pi}{2}\ell) - \cos(\tfrac{\pi}{2}\ell)]$"

**Problem:** Incomplete as a spec: the iterate $x_k$ is dimensionless (normalised by $L_{rv}$), and BehavePlus returns `mountainDistance = x * ridgeToValleyDistance`. The draft never states the final rescale, nor the seed $x_0 = x_\text{flat}/L_{rv}$. Anyone implementing exactly what is written gets a "distance" in units of ridge-to-valley lengths — off by a factor of $L_{rv}$ (typically 0.1-5 mi), which for the stated purpose ("canonical numerical statement of Albini 1979/1983") is a materially wrong result rather than a notation quibble.

**Correction:** Mountain terrain applies a fixed-point correction over a sinusoidal ridge–valley profile. Seed $x_0 = x_{\text{flat}}/L_{rv}$ and iterate 6 times: $x_{k+1} = \frac{x_{\text{flat}}}{L_{rv}} - \frac{E_{rv}}{10\pi\cdot 1000}\left[\cos(\pi x_k - \tfrac{\pi}{2}\ell) - \cos(\tfrac{\pi}{2}\ell)\right]$. The iterate is dimensionless; the mountain spot distance is $x_{\text{mtn}} = x_6\,L_{rv}$ (mi). If $E_{rv}$ or $L_{rv}$ is zero, $x_{\text{mtn}} = x_{\text{flat}}$.


---

## Fire Meteorology & Dynamic Fuel Moisture  
`50-meteorology.md` — **5 finding(s)**

> This section is unusually accurate on published constants and holds up under direct checking against primary sources: the WAF equations, crown-fill definitions (F = CC/3, f = CR·F) and the Albini-Baughman D0 = 0.64H / z0 = 0.13H all match RMRS-GTR-266 equations [1]/[2]/[8]/[9]/[10]/[12] verbatim, including the 5 % crown-fill switch and the WAF = 1.66 pathology at 1 % CC that the draft cites; the Simard coefficients, every FFMC/DMC/DC constant (verified against the cffdrs reference implementation, including the DMC 1.894 x 1e-04 that a widely mirrored wiki gets wrong as 1e-06), the Briggs coefficients (which back-substitute to the canonical 21.4 F^3/4/u and 38.7 F^3/5/u), the SI KBDI form, the Erbs polynomial (extracted verbatim from the 1982 paper), the Michalsky constants and 0.01 deg accuracy claim, all nine Haines breakpoints, the dimensional consistency of Byram's Nc, and the Forthofer et al. (2014) lee-side limitation are all correct as stated. The biggest weakness is a pattern: wherever the draft asserts a *direction* rather than a constant, it has a real chance of being backwards — the Cruz et al. (2015) curing finding is stated with the sign flipped, and the mass-consistent stability ratio alpha_h/alpha_v is inverted in a way that contradicts the draft's own variational functional two lines above it. Both are the kind of error that survives review because the citation is right and only the sense is wrong, and both would silently produce wrong physics rather than an obvious failure. Secondarily, the GPU cost model is optimistic in its bookkeeping (dispatch count understated ~6x), and one illustrative turbulence-intensity value contradicts the draft's own roughness table. Nothing here undermines the architecture; the fixes are all local edits.


### 1. [certain] "Cruz et al. (2015) revised this relationship using senescing-grassland experiments and found the original overpredicts spread at low curing"

**Problem:** The direction is reversed. Cruz et al. (2015), 'Effects of curing on grassfires: II' (IJWF 24:838-848), state in the abstract: existing Australian curing models 'were found to under-predict the rate of forward fire spread in partially cured grasslands.' The Cheney et al. (1998) function scored a mean bias error of -0.27 (i.e. under-prediction), and the experiments showed propagation down to 20% curing, well below where the Cheney curve collapses to near zero. Implementing the draft as written would push the modeller to correct in the wrong direction.

**Correction:** Cruz et al. (2015) revised this relationship using senescing-grassland experiments and found the original **under**predicts spread in partially cured grassland (Cheney et al. 1998 gives MBE ≈ −0.27, and fires were observed to propagate at curing levels as low as 20 %, where Φ_c is near zero); we implement Cheney's form as default (it matches the ROS calibration in §3) with the Cruz variant selectable.


### 2. [certain] "the Gauss precision moduli whose ratio encodes stability (`α_h/α_v` ≈ 1 neutral, up to 10 for strongly stable flow that is forced around rather than over terrain)"

**Problem:** The ratio is inverted relative to the draft's own functional and elliptic equation. With J = ∫[α_h²((u−u⁰)²+(v−v⁰)²) + α_v²(w−w⁰)²]dV, the stationarity condition gives w−w⁰ ∝ λ_z/α_v², matching the draft's operator term (∂λ/∂z)/α_v². Setting α_h/α_v = 10 makes 1/α_v² = 100/α_h², so the vertical correction dominates and air is sent OVER the terrain — which is the unstable/neutral limit, not the stable one. The mass-consistent literature (Sherman 1978 MATHEW and successors) states the mapping explicitly: when adjustment in the vertical predominates the air goes over the barrier rather than around it. Stable flow forced around terrain requires the horizontal adjustment to dominate, i.e. α_v >> α_h.

**Correction:** …and `α_h/α_v` the Gauss precision moduli whose ratio encodes stability (`α_h/α_v` ≈ 1 neutral, falling to ≈ 0.1 for strongly stable flow that is forced around rather than over terrain — equivalently `α_v/α_h` up to ≈ 10, since a large `1/α_v²` in the operator above makes vertical adjustment cheap and sends flow over the ridge, which is the unstable limit).


### 3. [certain] "5 V-cycles to 10⁻⁴ residual ≈ 2 ms, plus ~40 dispatches × ~7 µs ≈ 0.3 ms of command overhead. Budget ≈ 2.5 ms per solve."

**Problem:** The dispatch count is too low by roughly 5-7x for the solver the draft specifies. A 6-level V-cycle with 2 pre- and 2 post-smooths needs, at an absolute minimum, 2 pre + 1 residual/restrict + 2 post + 1 prolong/correct = 6 dispatches per level, i.e. ~36 per V-cycle; with the red-black Gauss-Seidel the draft specifies, each smooth splits into 2 colour passes, giving ~10 per level and ~60 per V-cycle. Over 5 V-cycles that is 180-300 dispatches, not 40. At the draft's own 7 µs figure the command overhead is 1.3-2.1 ms, not 0.3 ms, so the per-solve budget is roughly 4 ms rather than 2.5 ms. (The amortised <0.05 ms/frame conclusion survives, since the solve runs at 1 Hz, but the stated per-solve budget does not.)

**Correction:** 5 V-cycles to 10⁻⁴ residual ≈ 2 ms, plus ~250 dispatches (6 levels × ~10 dispatches per level for red–black 2 pre / 2 post plus restriction and prolongation, × 5 V-cycles) × ~7 µs ≈ 1.8 ms of command overhead. **Budget ≈ 4 ms per solve.** Fusing the red–black colour passes and the residual-plus-restriction into single kernels is the first optimisation if this proves tight.


### 4. [certain] "Neutral: `σ_u ≈ 2.5 u*` ⇒ `I_u ≈ 1 / ln((z−d)/z₀)` (0.10 open grass, 0.25–0.35 forest edge)."

**Problem:** The 0.10 value contradicts the draft's own formula and its own roughness table. With the stated 10 m reference height and the table's short-pasture/grassland z₀ = 0.01–0.03 m, I_u = 1/ln(10/z₀) = 0.145 (z₀ = 0.01) to 0.172 (z₀ = 0.03). Recovering 0.10 would require z₀ ≈ 0.00045 m, which is snow- or water-surface roughness, not grass. This understates gust amplitude by ~70 % for exactly the biome (grassland) whose spread is most gust-sensitive, and it is also inconsistent with the §6.9 control table, which defaults grassland gustiness to 0.14. The forest-edge figure of 0.25–0.35 is fine.

**Correction:** - Neutral: `σ_u ≈ 2.5 u*` ⇒ `I_u ≈ 1 / ln((z−d)/z₀)` (≈ 0.15–0.17 for open grass at z = 10 m with z₀ = 0.01–0.03 m; 0.25–0.35 forest edge).


### 5. [likely] "The convective heat release rate per unit fireline length follows from Byram (1959): `I_B = H · w · R` (kW m⁻¹)"

**Problem:** H·w·R is Byram's fireline intensity — the TOTAL rate of heat release per unit length of fire front — not the convective component. The draft then correctly multiplies by a convective fraction χ_c ≈ 0.5–0.7 to form F_b, and separately uses the unmodified I_B in Byram's convection number N_c (which is defined on total intensity). As written the prose says I_B is already convective, so an implementer following it literally would apply χ_c twice to the buoyancy flux, depressing plume rise by ~15–25 % in Δh, and would be using a mislabelled quantity in N_c.

**Correction:** The total heat release rate per unit fireline length follows from Byram (1959): `I_B = H · w · R` (kW m⁻¹), with `H` = low heat of combustion (kJ kg⁻¹, ≈ 18 600), `w` = fuel consumed (kg m⁻²), `R` = ROS (m s⁻¹). This is Byram's fireline intensity — the total rate of heat release per unit length of fire front; the convective fraction `χ_c` is applied separately below, and `N_c` below uses the total `I_B`, not `χ_c I_B`.


---

## WebGPU Compute Architecture  
`10-webgpu-architecture.md` — **7 finding(s)**

> This section is unusually sound on exactly the things that are normally wrong: every one of the fifteen WebGPU default limits is correct verbatim against the current W3C spec table, the D3D12 hard caps (65535 workgroups/dimension, workgroup Z 64, 3D texture 2048, and the raisable 1024 invocations / 32 KiB groupshared / 16384 2D texture) are all correct, the web3dsurvey Windows figures match the site exactly (2147483643 storage-binding and 2147483644 maxBufferSize at 93%, 1 GiB at 100%), the Chrome claims (100 µs timestamp quantization, the powerPreference/iGPU wording which is near-verbatim from Chrome's troubleshooting doc, subgroups shipping in 134 with subgroupMinSize/MaxSize on adapter info) all check out, and the hardware numbers are right — 128-bit GDDR6 @16 Gbps = 256 GB/s, ~19–20 TFLOP/s FP32, and the 660 µs worst-case surfaceSpread actually reconciles to ~126 MB ÷ 190 GB/s = 662 µs, which is a genuinely honest estimate rather than a guess. The f16 ulp analysis, the fixed-point temperature encoding (200 + 0.02u → 1510.7 K), the Merrill & Garland 2016 decoupled-lookback attribution with its correct forward-progress caveat, the 3.375× halo amplification and 17.3 KB shared-memory figure, and the AudioWorklet 128-sample/2.667 ms quantum are all correct. The biggest weakness is the determinism argument: §6.4/§6.5 rest the no-ping-pong-for-t_ign simplification and the reproducibility guarantee on a property atomicMin does not have (commutativity makes concurrent *writes* order-independent, not concurrent read-modify-write), and since determinism is advertised as a user-facing guarantee for the CSV/JSON export, that hole is the one finding worth fixing before anything else. Everything remaining is arithmetic hygiene — a MiB/MB conflation running through the volume sizing, a threading factor dropped from the WASM justification, a brick-pool allocation whose stated derivation double-counts a constraint, and one misattributed grassland citation.


### 1. [certain] §6.4: "Note the maxComputeWorkgroupsPerDimension = 65535 cap applies to indirect dispatch too and is **not validated** — an out-of-range indirect value is clamped or undefined, so the args kernel must clamp explicitly."

**Problem:** The behaviour is fully specified, and it is neither clamping nor undefined. WebGPU §16.1.2 (Queue-timeline steps for dispatchWorkgroupsIndirect) says: "If workgroupCountX, workgroupCountY, or workgroupCountZ is greater than this.device.limits.maxComputeWorkgroupsPerDimension, return." The entire dispatch is silently skipped — no work executes, no error is raised, no partial/clamped grid runs. This matters operationally: 'clamped' would mean you lose the tail of the work and see a partially-updated field, whereas the real behaviour is that you lose 100% of the pass and the fire simply stops advancing with no diagnostic. The conclusion (clamp in the args kernel) is right; the stated reason is wrong.

**Correction:** Note that maxComputeWorkgroupsPerDimension applies to indirect dispatch too, but is not validated at encode time. Per WebGPU §16.1.2, if any of workgroupCountX/Y/Z read from the indirect buffer exceeds device.limits.maxComputeWorkgroupsPerDimension the dispatch is **silently skipped in its entirety** on the queue timeline — it is not clamped, it is not undefined, and no error is surfaced. The args kernel must therefore both clamp explicitly and fold any excess into the Y dimension, and should raise a HUD warning when it does so, because otherwise a whole substep of work vanishes with no symptom other than a stalled fire.


### 2. [certain] §6.4 (Ping-pong) / §6.5: "the arrival-time formulation writes it with atomicMin(&tign[i], t_ms), which is idempotent, commutative and associative over u32, so read-write aliasing within a pass is safe and the result is independent of workgroup scheduling order… it is what buys us determinism (§6.5)."

**Problem:** Commutativity/associativity/idempotence of min make the *set of writes* order-independent — i.e. write-write aliasing is safe, so no ping-pong is needed for a write-only field. They say nothing about *reads*. If any invocation in the same dispatch reads tign (which a spread pass computing arrival = t_ign[source] + d/ROS necessarily does), it may observe either the pre-update or post-update value depending on which workgroup ran first, and that scheduling-dependent read then propagates into state evolution. That is precisely the class of nondeterminism §6.5 claims to have excluded, and it is load-bearing for the 'same-device, frame-rate-independent reproducibility' guarantee. As written the section asserts a property atomicMin does not have.

**Correction:** t_ign does not need ping-pong **provided it is write-only within any pass that writes it**: atomicMin(&tign[i], t_ms) makes the set of concurrent writes order-independent (min is commutative, associative and idempotent), so write-write aliasing is safe. This does *not* extend to read-write aliasing: an invocation that reads tign in the same dispatch that atomicMin-writes it may observe either the pre- or post-update value depending on workgroup scheduling order, which would break the determinism guarantee of §6.5. Therefore surfaceSpread reads its ignition-front inputs only from the ping-ponged phase / burnt-fraction state (parity N) and treats tign as a write-only sink; tign is read back only in a later pass (emissionInject, statsReduce, renderer).


### 3. [certain] §6.6: "20,000 trees × 30 ms = 600 s of single-threaded JS becomes ~150 s across 16 worker threads in WASM — the difference between a 10 s and a 40 s world-generation screen."

**Problem:** The arithmetic is internally contradictory. 600 s across 16 threads is 37.5 s even with no WASM speedup at all; applying the paper's own honest 2–8× (say 4×) WASM factor gives ~9.4 s. The quoted ~150 s is 600/4 — the WASM speedup applied with the 16-way threading forgotten. It also contradicts the very next clause, whose '10 s vs 40 s' figures are exactly the correct numbers (600/16/4 ≈ 9.4 s versus 600/16 = 37.5 s). Left as-is the sentence makes the WASM investment look like it still leaves a 2.5-minute load screen, which undercuts the argument the paragraph is making.

**Correction:** It *is* repaid by tree meshing, where 20,000 trees × 30 ms = 600 s of single-threaded JS becomes ~38 s across 16 worker threads in JS, and ~10 s across 16 worker threads in WASM (600 s ÷ 16 threads ÷ ~4× measured WASM speedup ≈ 9.4 s) — the difference between a 10 s and a 40 s world-generation screen.


### 4. [certain] §6.2: wind field "= 4.19 MiB, ping-pong = 8.4 MiB"; froxel volume "= 33.55 MiB, ping-pong = 67.1 MiB"; and "we deliberately do not advect at 2 m (512×512×64 = 134.2 MiB per copy, 268 MiB ping-pong)".

**Problem:** These are decimal megabytes labelled as MiB. 128×128×32 × 8 B = 4,194,304 B = 4.00 MiB (4.19 MB). 256×256×64 × 8 B = 33,554,432 B = 32.0 MiB (33.55 MB). 512×512×64 × 8 B = 134,217,728 B = 128 MiB — which §6.1 itself correctly calls 128 MiB in the very same document when discussing the storage-buffer cap, so the section contradicts itself on the identical byte count. The error is systematic (~4.9% inflation) and propagates into the VRAM budget table.

**Correction:** Wind field: 128×128×32 rgba16float = 4,194,304 B = 4.0 MiB, ping-pong = 8.0 MiB. Smoke/temperature froxel volume: 256×256×64 rgba16float = 33,554,432 B = 32.0 MiB, ping-pong = 64.0 MiB. The rejected 2 m alternative: 512×512×64 = 134,217,728 B = 128 MiB per copy, 256 MiB ping-pong. In the VRAM budget table, 'Smoke/T froxel volume ×2' = 64 MiB (not 67) and the Simulation subtotal = 267 MiB (not 270). (Same slip in the coarse-moisture line: 128×128 rgba16float = 0.125 MiB each, so ×2 textures = 0.25 MiB, not 0.5 MiB.)


### 5. [certain] §6.9: "Spread rates remain calibrated to Rothermel 1972 / Scott & Burgan 2005 and to Cheney et al. 2012 for grass."

**Problem:** Misattribution. Cheney, Gould, McCaw & Anderson (2012), Forest Ecology and Management 280: 120–131, 'Predicting fire behaviour in dry eucalypt forest in southern Australia', is the Project Vesta *dry eucalypt forest* model — it is the reference for the Eucalypt/Australian dry forest biome, not for grass. The grassland spread model is Cheney, Gould & Catchpole (1998), IJWF 8(1): 1–13, 'Prediction of fire spread in grasslands' (the model with the 5 km/h critical wind speed and the curing/pasture-type functions). Citing the eucalypt paper as the grass calibration source will send an implementer to the wrong equations for the Grassland/savanna biome.

**Correction:** Spread rates remain calibrated to Rothermel (1972) / Scott & Burgan (2005), to Cheney, Gould & Catchpole (1998, IJWF 8(1):1–13) for grass, and to Cheney, Gould, McCaw & Anderson (2012, For. Ecol. Manage. 280:120–131; Project Vesta) for dry eucalypt forest — none of which resolve that mechanism either.


### 6. [certain] §6.2: "Brick grid 64×64×8 = 32,768 slots; only the lowest two vertical slabs (0–32 m AGL) can be occupied, and typical forest occupancy is ~50 %, so we allocate a pool of 8192 bricks = 4,194,304 voxels."

**Problem:** Non-sequitur: the two constraints are applied as if they compound, but 8192 is exactly the number of *addressable* slots after the two-slab restriction (64×64×2 = 8,192), i.e. 100% occupancy, not 50%. Applying the stated ~50% occupancy to those 8,192 reachable slots gives 4,096 bricks. As written the brickmap's sparsity buys literally nothing — the pool is a dense allocation of the entire reachable volume — while still paying the indirection-lookup cost on every canopy access. This doubles the canopy line in the VRAM budget (40 MiB vs 20 MiB).

**Correction:** Brick grid 64×64×8 = 32,768 slots, of which only the lowest two vertical slabs (0–32 m AGL) are reachable = 64×64×2 = 8,192 slots. Typical forest occupancy of those reachable slots is ~50 %, so we allocate a pool of 4,096 bricks = 2,097,152 voxels (4.0 MiB per f16 field, 20 MiB for the five fields) with a free-list and a documented allocation-failure policy that degrades to the coarse mip. If a dense allocation is preferred instead, state it as such: 8,192 bricks is 100 % of the reachable volume and the brickmap then buys indirection flexibility, not memory savings.


### 7. [likely] §6.2 surface-state table: "slope tan φ, aspect | 2 × f16 | precomputed from h once; f16 is ample (aspect to 0.03°)".

**Problem:** No single-f16 encoding of a full 360° aspect achieves 0.03°. Worst-case resolution is 0.25° if stored in degrees (values in [256,512) have ulp 0.25), ~0.22° if stored in radians (ulp 2^-8 rad near 2π), and ~0.35° if stored as a normalised turn in [0,1). The figure is roughly an order of magnitude optimistic. The conclusion ('f16 is ample') survives — 0.25° of aspect error is far below the uncertainty in any solar-load or wind-alignment term — but the quoted number does not, and it is the kind of number that gets copied into a later precision-budget argument. (The adjacent 'f16 at 500 m elevation has 0.24 m ulp' is fine under a half-ulp/relative-epsilon convention: 2^-11 × 500 = 0.244 m.)

**Correction:** slope tan φ, aspect | 2 × f16 | precomputed from h once; f16 is ample (aspect to ~0.25° worst case, well below the resolution of the solar-load and wind-alignment terms that consume it)


---

## Rendering, Procedural Content & Audio  
`70-rendering-audio.md` — **12 finding(s)**

> The section is architecturally sound and most of the flagged claims survive checking: Mulholland & Croarkin's 8.7 ± 1.1 m²/g at 632.8 nm (→ 8700 m² kg⁻¹), Byram's SI flame-length form L = 0.0775 I^0.46, Rothermel's 18,600 kJ kg⁻¹ = 8000 Btu lb⁻¹, Cetegen & Ahmed's f = 1.5 D^−1/2 (and the 0.47 Hz at D = 10 m it implies), the full Hillaire/Bruneton atmosphere parameter set, Koschmieder's 3.912 = ln 50, Maekawa's ΔL = 10 log₁₀(3 + 20N) with N = 2δ/λ, the non-core status of multiDrawIndirect and the 56-bucket consequence, the ICFME 800–1200 °C crown-fire band, the Planck/CODATA constants, the Gladstone–Dale 2.93×10⁻⁴, and the froxel arithmetic (160×90×128 × 8 B = 14.7 MB, ×3 = 44 MB) are all correct, as are every budget-table sum, the LOD triangle/instance table, the impostor and probe-volume memory figures, and the 630 M tri s⁻¹ figure, which is a plausible ~20 % of an AD106's ~6.5 G tri s⁻¹ setup rate even after a depth prepass. The biggest weakness is the citation-and-constant layer rather than the architecture: the aerosol optics are quoted from Sayer et al. 2014 with numbers that are not in that paper (g and SSA both misstated, near-source data described as aged), the Ångström exponent conflates extinction with absorption, and three attributions (Kang→"Kim", Salvi→"Karis", ribbon bark→stringybark species) are wrong. Two findings are load-bearing for correctness rather than provenance: the emission source term is dimensionally inconsistent with the integration formula and would overbrighten the far plume by up to ~44×, and the design assumes r8unorm/r16float storage textures that core WebGPU does not provide without the optional texture-formats-tier1 feature — the same class of API-limit error the draft carefully avoids for multiDrawIndirect. The performance estimates are aggressive (7.4 M vegetation triangles in 3.6 ms and 3.0 M alpha-tested grass triangles in 1.2 ms both imply >2 G tri s⁻¹ sustained through a G-buffer pass) but the author explicitly labels them unmeasured and defers baselining to M4, so I have not reported them as errors.


### 1. [certain] §7.1.3: "Volumetric emission source per froxel: L_e = ε_c σ_SB T^4 / π · C(T), ε_c = 1−exp(−σ_a,c Δs)", used as the emission part of S in §7.1.4 where "S = per-slice source (emission + in-scatter, W m⁻³ sr⁻¹)".

**Problem:** Dimensional inconsistency that overbrightens emission by a factor of Δs. ε_c is dimensionless and σ_SB T^4/π is a radiance, so L_e has units W m⁻² sr⁻¹ — it is the radiance already emitted by a slab of thickness Δs. Feeding it into the Hillaire analytic form T·(S − S e^{−σ_t d})/σ_t multiplies it by ≈(1−e^{−σ_t d})/σ_t ≈ d. With the §7.1.1 depth distribution d runs 1.0 m near-field to ~44 m at 1 km, so far-field plume emission comes out up to ~44× too bright and the near/far brightness ratio is wrong by the slice-thickness ratio.

**Correction:** Use a true volumetric source: $$S_{e,c} = \sigma_{a,c}\,\frac{\sigma_{SB}T^4}{\pi}\,\mathbf{C}(T)\qquad[\mathrm{W\,m^{-3}\,sr^{-1}}]$$ and feed $S = S_e + S_{scat}$ into the §7.1.4 integral. If the slab form $L_e = \varepsilon_c\,\sigma_{SB}T^4\mathbf{C}(T)/\pi$ with $\varepsilon_c = 1-\exp(-\sigma_{a,c}\Delta s)$ is preferred, it is an already-integrated radiance and must be accumulated directly as $L \mathrel{+}= T\,L_e$, never passed through $(S - S e^{-\sigma_t d})/\sigma_t$.


### 2. [certain] §7.1.4: "a dedicated 128³ `r8unorm` sun-transmittance volume over the domain (2 MB, one compute pass marching along sun-aligned rows)"; §7.1.2: sim exposes 3D `r16float` soot/temperature textures; §7.6: per-tree `r8unorm` profile texture and `r8` canopy voxel state.

**Problem:** Core WebGPU does not permit STORAGE_BINDING on `r8unorm` or `r16float`, so a compute pass cannot write these textures. The core storage-texture format set is rgba8unorm/snorm/uint/sint, rgba16uint/sint/float, r32uint/sint/float, rg32uint/sint/float, rgba32uint/sint/float (plus bgra8unorm via the `bgra8unorm-storage` feature). `r8unorm` and `r16float` gain read-only/write-only storage access only with the optional `texture-formats-tier1` feature, and read-write only with `texture-formats-tier2`. The draft correctly identifies multiDrawIndirect as non-core but then assumes a storage-format capability that is equally non-core.

**Correction:** Add to the WebGPU constraints: "`r8unorm` and `r16float` are not core WebGPU storage-texture formats — they require the optional `texture-formats-tier1` feature (read-only/write-only) or `texture-formats-tier2` (read-write). We therefore either (a) request `texture-formats-tier1` where available, or (b) fall back to `r32float` for compute-written volumes (128³ sun transmittance → 8 MB, sim soot/T fields → 2× the stated footprint), or (c) write `r8unorm`/`r16float` volumes as render attachments layer-by-layer, which is core-legal since both are RENDER_ATTACHMENT-capable."


### 3. [certain] §7.1.2 table: "AERONET smoke models give ω₀(550) ≈ 0.88–0.92 for aged smoke (Sayer et al. 2014)" and "g(550) ≈ 0.62–0.63", "this is column-averaged aged aerosol", justifying g = 0.60.

**Problem:** Both numbers and the characterisation are wrong. Sayer et al. (2014), ACP 14:11493–11523, Table 4 covers ten NEAR-SOURCE smoke sites, not aged/transported aerosol. Reported g is 0.66–0.71 at 440 nm and 0.61–0.67 at 675 nm across all ten sites, i.e. ≈0.64–0.69 at 550 nm — the draft's "0.62–0.63" is below the source range, and the chosen g = 0.60 is below it further, so the stated justification does not support the value. Midvisible SSA spans ~0.86–0.96, not 0.88–0.92: boreal wood/peat sites (Bonanza Creek 0.95–0.96, Moscow 0.95, Tomsk 22 0.94–0.95, Yakutsk 0.95–0.96) are markedly less absorbing than the grass/shrub/crop sites (Mongu 0.86–0.87, Jabiru 0.87–0.88, Cuiaba 0.89, Skukuza 0.89–0.90). Since the sim's flagship biome is Western US conifer, the draft has adopted the savanna end of the range for forest smoke.

**Correction:** Replace the two table notes with: "Sayer et al. (2014, ACP 14:11493–11523, Table 4) give, for ten near-source AERONET smoke sites, g = 0.66–0.71 at 440 nm and 0.61–0.67 at 675 nm (≈0.64–0.69 at 550 nm), and midvisible SSA 0.86–0.96 — 0.94–0.97 at boreal wood/peat sites, 0.86–0.90 at grass/shrub/crop sites." Set $g = 0.65$; set $\omega_0$(550) = 0.95 for conifer/boreal-forest smoke and 0.88 for grass/shrub smoke, retaining the reduction to ~0.70 within 30 m of flame as a modelling choice, not a cited value.


### 4. [certain] §7.1.2 table: "α | 1.2 | – | Ångström absorption exponent; 1.0 for pure black carbon, 1.5–3 for brown carbon", applied in σ_t,c = K_633 ρ_s (633/λ_c)^α.

**Problem:** Two errors. (i) α there scales total EXTINCTION, so it is the extinction Ångström exponent, not the absorption Ångström exponent (AAE); the "1.0 for BC, 1.5–3 for BrC" figures quoted are AAE values and do not apply to σ_t. (ii) The value is too low: Sayer et al. (2014) Table 4 gives extinction α = 1.42–1.97 for smoke (ten-site mean 1.76), with α_abs = 1.43–2.20 separately. Since the draft explicitly makes this exponent the mechanism that reddens the scene through the plume, α = 1.2 systematically under-reddens.

**Correction:** "$\alpha$ | 1.6 | – | Extinction Ångström exponent. Sayer et al. (2014) Table 4: $\alpha$ = 1.42–1.97 for smoke across ten AERONET sites (mean 1.76). Distinct from the absorption Ångström exponent $\alpha_{abs}$ (1.43–2.20 at the same sites; ≈1.0 for pure black carbon, 1.5–3 for brown carbon), which governs $\sigma_a$ only."


### 5. [certain] §7.8: "Air absorption: one-pole lowpass, f_c = 22050 exp(−r/380) Hz, matching ISO 9613-1 at 20 °C/50 % RH (~0.5 dB/100 m at 500 Hz, ~9 dB/100 m at 4 kHz)."

**Problem:** Both quoted ISO figures are wrong, and the filter does not produce either. Evaluating ISO 9613-1 at 20 °C, 50 % RH, 101.325 kPa gives 2.73 dB/km = 0.27 dB/100 m at 500 Hz and 29.7 dB/km = 2.97 dB/100 m at 4 kHz — the 4 kHz claim is ~3× too high and the 500 Hz claim ~2× too high. Separately, the stated one-pole at r = 100 m has f_c = 16.9 kHz, giving 0.24 dB of attenuation at 4 kHz — roughly 12× less than the correct ISO value. A fixed exponential f_c(r) also cannot reproduce ISO's approximately f²·r dependence across the domain.

**Correction:** "**Air absorption**: ISO 9613-1 at 20 °C / 50 % RH / 101.325 kPa gives α = 0.27 dB/100 m at 500 Hz, 0.47 at 1 kHz, 0.99 at 2 kHz, 2.97 at 4 kHz and 10.5 at 8 kHz. Implement either (a) explicit per-band gains $10^{-\alpha(f)r/20}$ on a 3-band shelf split at 500 Hz / 4 kHz, or (b) a distance-dependent one-pole fitted at a 4 kHz anchor, $f_c(r) = f_a/\sqrt{10^{\alpha(f_a)r/10}-1}$ with $f_a = 4$ kHz and $\alpha(4\,\text{kHz}) = 0.0297$ dB/m — giving $f_c \approx 4.0$ kHz at 100 m and 2.3 kHz at 200 m. The previously stated $f_c = 22050e^{-r/380}$ under-attenuates by more than an order of magnitude."


### 6. [certain] §7.1.3 table: "High-intensity surface, shrub | 1250–1450 | Dry-eucalypt flame temperatures measured in this band (Wotton et al. 2012)".

**Problem:** Wotton et al. (2012), Int. J. Wildland Fire 21(3):270–281, report a maximum flame temperature of ~1100 °C (~1373 K) near the flame base, decaying roughly exponentially with height normalised by flame height to ~300 °C (~573 K) at the visible flame tip. So 1450 K (1177 °C) is above the maximum they observed, the band's true span is ~573–1373 K rather than a narrow 200 K window, and the paper's headline number is a base-of-flame peak, not a representative flame temperature.

**Correction:** "High-intensity surface, shrub | ~573–1373 | Orange-yellow at base, dull red at tip | Dry-eucalypt fires: maximum ~1100 °C (1373 K) at the flame base, decaying exponentially with normalised height to ~300 °C (573 K) at the visible flame tip (Wotton et al. 2012, IJWF 21:270–281)."


### 7. [certain] §7.2: "32×32×16 irradiance volume … 1/8 of probes updated per frame in round-robin ⇒ 0.5 s full refresh."

**Problem:** Arithmetic error. Updating 1/8 of the probes per frame completes a full cycle in 8 frames; at the 60 fps target that is 0.133 s, not 0.5 s. The 4× discrepancy also means the pass costs ~4× more than a 0.5 s refresh would, which is relevant to the 0.10 ms line item.

**Correction:** "1/8 of probes updated per frame in round-robin ⇒ full refresh in 8 frames = 0.13 s at 60 fps." (If a 0.5 s refresh is what is wanted for cost reasons, update 1/30 of the probes per frame instead.)


### 8. [certain] §7.2: "P_i = χ_rad ṁ_i h_c  [W]" with "ṁ_i = mass consumption rate (kg s⁻¹), h_c = 18,600 kJ kg⁻¹".

**Problem:** Unit error of a factor 1000. kg s⁻¹ × 18,600 kJ kg⁻¹ yields kW, not W. If implemented literally against the stated units the aggregated fire lights are 1000× too dim, and since the same constant feeds the physics radiative term the error propagates.

**Correction:** $$P_i = \chi_{rad}\,\dot{m}_i\,h_c \quad[\mathrm{kW}],\qquad h_c = 18{,}600\ \mathrm{kJ\,kg^{-1}}$$ or equivalently use $h_c = 1.86\times10^{7}$ J kg⁻¹ to obtain $P_i$ in W. (The 18,600 kJ kg⁻¹ = 8000 Btu lb⁻¹ value itself is correct per Rothermel 1972.)


### 9. [certain] §7.1.3: "do not use the Kim et al. 2002 Planckian-locus cubic fit, whose stated validity floor is 1667 K"; §7.1.3 table: "Below Kim-fit validity".

**Problem:** Misattribution. The cubic Planckian-locus approximation with those coefficients and the 1667–25000 K validity range is Kang, Moon, Hong, Lee, Cho & Kim (2002), 'Design of advanced color temperature control system for HDTV applications', J. Korean Phys. Soc. 41(6):865–871 — cited in the literature and in reference implementations (e.g. colour-science's `colour.temperature.kang2002`) as Kang et al. 2002. "Kim et al." is a widely propagated error naming the last author. The coefficients and the 1667 K floor as quoted in the draft are themselves correct.

**Correction:** Replace both occurrences: "…do not use the Kang et al. (2002) Planckian-locus cubic fit (Kang, Moon, Hong, Lee, Cho & Kim, *J. Korean Phys. Soc.* 41(6):865–871), whose stated validity range is 1667–25000 K…" and in the table, "Below Kang-fit validity; LUT required".


### 10. [certain] §7.1.5: "Neighbourhood variance clipping (Karis 2014) of history against the 3×3×1 froxel box mean ± 1.25σ in the current frame."

**Problem:** Misattribution. Karis (2014, 'High Quality Temporal Supersampling', SIGGRAPH Advances) introduced neighbourhood min/max AABB clamping/clipping in YCoCg. Variance clipping specifically — building the clip box from the neighbourhood mean μ and standard deviation σ as μ ± γσ — is Salvi, 'An Excursion in Temporal Supersampling', GDC 2016 (which recommends γ ≈ 1).

**Correction:** "**Neighbourhood variance clipping** (Salvi 2016, *An Excursion in Temporal Supersampling*) of history against the 3×3×1 froxel box mean ± 1.25σ in the current frame, performed in YCoCg after Karis (2014)."


### 11. [certain] §7.5 species table: "Eucalypt — *E. obliqua / marginata* … Bark: **Decorticating ribbons**", plus "Eucalypt ribbon bark is modelled as explicit strip geometry".

**Problem:** Botanically wrong for both named species, which matters because the firebrand emitter samples this geometry. E. obliqua (messmate stringybark) has persistent, thick, rough, stringy/fibrous bark on trunk and larger branches; E. marginata (jarrah) has rough, vertically grooved fibrous bark shed in long flat strips. Neither decorticates in ribbons — decorticating ribbon bark is the signature of smooth-barked gums (E. viminalis ribbon gum, E. rubida candlebark, E. globulus). The firebrand rationale survives (stringybark is the classic long-range spotting source in Australian dry forest), but the modelled bark morphology, shed dynamics and brand geometry are wrong as specified.

**Correction:** Either keep the species and change the bark cell to "**Persistent stringybark** — thick fibrous bark shedding in long flat strips" (and rename the geometry from 'ribbon strips' to 'stringybark strips'; it remains the dominant long-range firebrand source in Australian dry forest), or, to keep true ribbon bark, change the species to *E. viminalis* (ribbon gum) / *E. rubida* (candlebark), which are genuinely decorticating.


### 12. [certain] §7.4: "`vertexIndex >> 3` gives blade id; 7 vertices (3 segments + tip) = 5 triangles".

**Problem:** Internally inconsistent: `>> 3` divides by 8, so it only yields a correct blade id if 8 vertices are emitted per blade. With 7 vertices per blade the blade id drifts by one every eight blades and the intra-blade vertex index is wrong, corrupting the whole grass field. (The downstream triangle count is self-consistent: 600 k blades × 5 tri = 3.0 M.)

**Correction:** Either "`bladeId = vertexIndex >> 3`, `v = vertexIndex & 7`; 8 vertices per blade (3 segments + tip, with one degenerate) = 5 triangles", or "`bladeId = vertexIndex / 7u`, `v = vertexIndex % 7u`; 7 vertices per blade = 5 triangles".
