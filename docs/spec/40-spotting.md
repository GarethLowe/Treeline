## Firebrand Transport & Spotting

Spotting is the only mechanism in this simulator that moves fire across a discontinuity in the fuel bed. Everything else — surface ROS, radiative preheat, plume convection — is local and continuous. Spotting is non-local and stochastic, and in two of our five biomes (eucalypt, chaparral) it is the *dominant* spread mechanism at high intensity, not a correction to it. It therefore gets a real Lagrangian solver rather than a distance nomogram.

---

### 1. The Albini reference models (calibration target, not the runtime model)

We implement Albini's models as an **offline calibration and validation harness**, not as the runtime spread mechanism. They are the only spotting models with decades of operational use, so the Lagrangian solver in §2 must reproduce them to within a factor of ~2 for the cases they cover (US conifer, flat/mountain terrain, single torching trees). Constants below are taken from the BehavePlus reference implementation (`firelab/behave`, `src/behave/spot.cpp`), which is the canonical numerical statement of Albini 1979 / 1983. **Albini's models are in US customary units throughout and we do not attempt to re-derive them in SI** — we convert at the boundary. Re-fitting them in SI silently changes the answers.

#### 1.1 Torching trees (Albini 1979, GTR INT-56)

Steady flame height and duration from a torching group:

$$h_f = a_h\,D^{b_h}\,N^{0.4} \qquad t_f = a_t\,D^{b_t}\,N^{-0.2}$$

| Symbol | Meaning | Units |
|---|---|---|
| $h_f$ | steady flame height | ft |
| $t_f$ | steady flame duration (dimensionless in Albini's formulation; reported as min by BehavePlus) | – |
| $D$ | diameter at breast height | in |
| $N$ | number of torching trees | – |
| $a_h,b_h,a_t,b_t$ | species coefficients | – |

Species coefficients (subset; 14 species in the full table):

| Species | $a_h$ | $b_h$ | $a_t$ | $b_t$ |
|---|---|---|---|---|
| Engelmann spruce / Douglas-fir / subalpine fir / w. hemlock | 15.7 | 0.451 | 12.6 / 10.7 / 10.7 / 6.30 | −0.256 / −0.278 / −0.278 / −0.249 |
| **Ponderosa pine**, lodgepole, w. white pine | 12.9 | 0.453 | 12.6 | −0.256 |
| Grand fir, balsam fir | 16.5 | 0.515 | 10.7 | −0.278 |
| Slash / longleaf / pond / shortleaf / loblolly pine | 2.71 | 1.000 | 11.9 → 13.5 | −0.389 → −0.544 |

Lofted firebrand height:

$$z_b = F_0\,t_f^{\,F_1}\,h_f + \tfrac{1}{2}h_t \quad \text{[ft]}$$

where $h_t$ is tree height (ft) and $(F_0,F_1)$ is selected by the flame ratio $R = h_t/h_f$:

| Case | $F_0$ | $F_1$ |
|---|---|---|
| $R \ge 1.0$ | 4.24 | 0.332 |
| $0.5 \le R < 1.0$ | 3.64 | 0.391 |
| $R < 0.5$, $t_f < 3.5$ | 2.78 | 0.418 |
| $R < 0.5$, $t_f \ge 3.5$ | 4.70 | 0.000 |

#### 1.2 Wind-driven surface fire (Albini 1983, RP INT-309)

$$f = 322\,(0.474\,U_{20})^{-1.01} \qquad I_B = \left(\frac{L_f}{0.45}\right)^{1/0.46} \qquad z_b = 1.055\sqrt{f\,I_B}$$

$U_{20}$ = 20-ft windspeed (mi h⁻¹); $L_f$ = flame length (ft); $I_B$ = Byram fireline intensity (Btu ft⁻¹ s⁻¹); $z_b$ = firebrand height (ft); $f$ is Albini's dimensional thermal-energy/windspeed function.

Drift during the lofting phase — the horizontal displacement accumulated *while the brand is still rising in the line thermal*, which the flat-terrain formula does not include:

$$\Delta x_{\text{drift}} = 2.78\times10^{-4}\,U_{20}\,z_b^{\,0.643} \quad \text{[mi]}$$

#### 1.3 Burning piles (Albini 1981)

$$z_b = 12.2\,h_{f,\text{pile}} \quad \text{[ft]}$$

i.e. a pile lofts brands to 12.2 flame heights — much more efficiently per unit flame height than a torching tree, because the pile is a compact, steady, non-entraining source.

#### 1.4 Common drift/deposition phase

All three sources share the same downwind transport, which assumes the brand descends at terminal velocity through a logarithmic wind profile scaled on the downwind canopy:

$$x_{\text{flat}} = 7.18\times10^{-4}\,U_{20}\sqrt{h_c}\left[0.362 + \frac{1}{2}\sqrt{\frac{z_b}{h_c}}\,\ln\!\frac{z_b}{h_c}\right] \quad \text{[mi]}$$

with a floor on the cover height to keep the logarithm well-behaved:

$$h_c \leftarrow \max\!\left(h_c,\ 2.2\,z_b^{\,0.337}-4.0\right) \quad \text{[ft]}$$

Total = $x_{\text{flat}}$ (+ $\Delta x_{\text{drift}}$ for the surface-fire case). Mountain terrain applies a fixed-point correction over a sinusoidal ridge–valley profile. Seed $x_0 = x_{\text{flat}}/L_{rv}$ and iterate 6 times:

$$x_{k+1} = \frac{x_{\text{flat}}}{L_{rv}} - \frac{E_{rv}}{10\pi\cdot 1000}\left[\cos(\pi x_k - \tfrac{\pi}{2}\ell) - \cos(\tfrac{\pi}{2}\ell)\right]$$

The iterate is dimensionless; the mountain spot distance is $x_{\text{mtn}} = x_6\,L_{rv}$ (mi). If $E_{rv}$ or $L_{rv}$ is zero, $x_{\text{mtn}} = x_{\text{flat}}$.

$L_{rv}$ = ridge-to-valley horizontal distance (mi), $E_{rv}$ = ridge-to-valley elevation (ft), $\ell \in \{0,1,2,3\}$ encodes source position (valley bottom / mid-slope / ridge top).

**Honest limits.** Albini's models predict a *maximum* distance for a single brand under steady wind — not a distribution, not a rate, not an ignition probability. They are calibrated on US conifers and have no eucalypt bark, chaparral or gorse parameterisation. Using the torching-tree coefficients for *Eucalyptus obliqua* or *Ulex europaeus* is outside the validated envelope and we will not do it.

---

### 2. The runtime model: Lagrangian burning brands

Because we already integrate a 3D plume with resolved vertical velocity and temperature, the Albini plume sub-model is redundant — we can advect brands in the actual simulated flow. This is the recommended approach and it costs us one compute pass (§4).

#### 2.1 Generation rate

Brand production is tied to the **mass consumption rate of brand-producing fuel components**, not to fireline intensity directly. Intensity is a poor predictor because two fuels with identical $I_B$ (grass vs stringybark forest) differ by orders of magnitude in brand yield.

$$\dot N_{\text{cell}} = \sum_j \frac{Y_j\,\dot m_j}{\bar m_j} \qquad [\text{brands s}^{-1}]$$

$\dot m_j$ = mass loss rate of component $j$ in the cell/voxel (kg s⁻¹), taken directly from the surface and canopy solvers; $Y_j$ = brand yield (dimensionless, mass fraction of consumed component leaving as intact lofted brands); $\bar m_j$ = mean brand mass (kg). $Y_j/\bar m_j$ is exactly the "specific firebrand production" (brands per kg dry mass burned) measured by Adusumilli, Chaplen & Blunck (2021, *Front. Mech. Eng.* 7:655593, "Firebrand Generation Rates at the Source for Trees and a Shrub"), who found sagebrush produces ~6× more brands per kg than ponderosa pine at comparable moisture content, that Douglas-fir and ponderosa are comparable, and that specific production rises **exponentially with decreasing fuel moisture** over 15–60% MC. Total production for 2.7–4.2 m Douglas-fir was ≲2000 brands per burn.

| Biome | Dominant brand source | Shape class | $\bar m$ (g) | Brands per kg consumed | $\sigma$ (kg m⁻²) | $C_D$ | $v_t$ (m s⁻¹) | Burnout (s) | Status |
|---|---|---|---|---|---|---|---|---|---|
| W. US conifer | cylindrical bark/twig fragment, cone, needle clump | **cylinder** | **0.10–0.24** typ. (3.9 max) | 100–300 *(assumed)* | **0.85–1.41** | 0.47 | **5.4–7.0** | 30–200 *(assumed)* | `calibrated` |
| Grassland | culm/leaf fragment | thin plate | 0.005–0.05 *(assumed)* | 300–800 *(assumed)* | **0.048–0.19** *(assumed)* | 0.95 | 0.9–1.8 | 5–25 *(assumed)* | `estimated` |
| Chaparral | leaf, twig, shredded bark | plate | 0.02–1.0 *(assumed)* | 400–1200 *(assumed)* | **0.24–1.43** *(assumed)* | 0.95 | 2–5 | 20–120 *(assumed)* | `estimated` |
| **Eucalypt** | **ribbon / stringy bark** | flat plate, simple cyl., convoluted cyl. | 0.5–20 | 50–200 *(assumed)* | **1.69 / 0.78 / 1.96** | **0.95 / 0.47 / 0.95** | **5.4 / 5.2 / 5.8** | **251 / 122 / 429** (max 785 / 353 / **1304**) | `calibrated` |
| UK mixed | gorse/heather fragment, oak leaf, bracken frond | plate | 0.01–0.3 *(assumed)* | 200–600 *(assumed)* | **0.095–0.475** *(assumed)* | 0.95 | 1.3–3 | 10–60 *(assumed)* | `estimated` |

Every row reconciles exactly under the §2.2 relation $v_t = \sqrt{2\sigma g/(\rho_a C_D)}$ with $\rho_a$ = 1.2 kg m⁻³, $g$ = 9.81 m s⁻². **Default brand bulk density $\rho_p$ = 360 ± 9 kg m⁻³** — measured by gas pycnometry on a 20 g subsample of embers collected from a ponderosa/Douglas-fir pile burn, and lower than unburnt wood (Douglas-fir 530–560, ponderosa 350–450 kg m⁻³) because of thermal degradation (Petersen & Banerjee 2024, *Phys. Fluids* 36:106611, §II C, open access: `escholarship.org/content/qt9zv0q3q6/qt9zv0q3q6.pdf`).

The **W. US conifer** row is derived from NIST's real-scale tree burns, which report that *all* collected Douglas-fir and Korean pine firebrands were **cylindrical**, with mean dimensions 3 mm × 40 mm (2.6 m Douglas-fir, 10% MC), 4 mm × 53 mm (5.2 m Douglas-fir, 18% MC) and 5.0 mm × 34 mm (Korean pine, 550 brands measured); most masses below 0.3 g, largest observed 3.5–3.9 g (Manzello et al. 2009, *Fire and Materials* 33:21–31, pp. 25, 27, 29 — free NIST full text: `tsapps.nist.gov/publication/get_pdf.cfm?pub_id=861421`). Applying $\sigma = (\pi/4)\rho_p d$ (§2.2, cylinder referenced to broadside area) at $\rho_p$ = 360 gives σ = 0.85 / 1.13 / 1.41 kg m⁻² and $v_t$ = 5.4 / 6.1 / 7.0 m s⁻¹ for d = 3 / 4 / 5 mm; a full Re-dependent solve (Bagheri & Bonadonna 2016 Eq. 34, Re = 2950–5113) reproduces these to <1%.

**Eucalypt** terminal velocities and burnout times are measured values from Hall et al. (2015, *IJWF* 24:1109) for *E. viminalis* ribbon gum burned tethered in a vertical wind tunnel at terminal velocity, and are the primary data. Because $v_t$ depends only on the ratio $\sigma/C_D$, exactly one of that pair can be free: $C_D$ is the sourced quantity (§2.2), so σ is **solved** from the measured $v_t$ as $\sigma = v_t^2\rho_a C_D/(2g)$, giving 1.69 / 0.78 / 1.96 kg m⁻² (full thickness 4.7 mm, equivalent diameter 2.75 mm, full thickness 5.4 mm at $\rho_p$ = 360). The grassland, chaparral and UK mixed rows remain **order-of-magnitude estimates assembled from mixed sources and are calibration parameters, not measurements** — they are exposed in the biome config and must be tuned against observed spot distributions.

Brand size is **not** a single characteristic scale with a defined mean. Imaging 86,000 embers from a pile burn without the usual hand-picking bias, Petersen & Banerjee (2024) found the PDFs of projected area, longest dimension and equivalent diameter all follow **power laws with slope ≈ −2** across three decades (100 µm to 10 cm) — the signature of brittle fragmentation — and state explicitly that they observe no size distribution with a defined mean or mode (§III A 3, Figs. 3(b)–(d)); aspect ratio $s_2/s_1$ is broadly flat over 0.3–1.0 (§III A 4, Fig. 3(e)). $\bar m$ above is therefore defined by the spec's own **truncation to brands large enough to ignite**, not by a physical mode, and §4.2 should sample a truncated power law of exponent −2 in projected area rather than a delta or a lognormal.

> **CLOSED (was OPEN QUESTION on the σ column, hazards (i) and (ii)):** Hazard (i) is **resolved: there is no factor-of-2 error and no half-thickness ambiguity.** The σ column was entered as areal density $m/A_\perp$ throughout, provable by back-solving $C_D = 2\sigma g/(\rho_a v_t^2)$ from the original (σ, $v_t$) pairs: grassland recovered $C_D$ = 2.02 at *both* ends of its range, chaparral 2.04/1.96, UK mixed 1.93/1.82, eucalypt 1.94 — a single shared constant, which entry as $\rho_p\delta$ could not produce (it would require $C_D \approx 4$ and no shared value). The actual defect was different and is now recorded: those four rows had been generated at an **undocumented $C_D$ = 2.0** (equivalently $v_t = \sqrt{\sigma g/\rho_a}$) that appeared nowhere in §2.2. Hazard (ii) is closed by the table above, which is now internally consistent at the sourced $C_D$ values. **What changed:** the conifer shape class (plate → **cylinder**), its σ (1.5–6 → **0.85–1.41** kg m⁻²), $v_t$ (3–8 → **5.4–7.0** m s⁻¹) and $\bar m$ (0.05–3.5 → **0.10–0.24 g** typical, 3.9 g max); the eucalypt σ (1.5–4 → **1.69 / 0.78 / 1.96**); and the three estimated rows rescaled by $C_{D,\text{new}}/2.0$ = 0.475 at fixed $v_t$. **Status:** conifer and eucalypt rows are `calibrated` per §0.7.3 (constants traced to obtainable primary sources — Manzello et al. 2009 pp. 25/27/29; Petersen & Banerjee 2024 §II C; Hall et al. 2015 — with no benchmark dataset for the assembled model). Grassland, chaparral and UK mixed are `estimated` and must not ship as defaults without the decision recorded here.

> **OPEN QUESTION (unverified):** The **grassland, chaparral and UK mixed rows remain unsourced**. No primary measurement of firebrand mass, size or areal density for grass, chaparral shrub or UK gorse/heather/bracken fuels has been obtained; their σ, $\bar m$ and burnout entries are marked *(assumed)* above and their σ values are only a rescaling of the earlier numbers to the corrected $C_D$ at fixed $v_t$. **The brands-per-kg column is unverified for every row, including conifer:** Manzello et al.'s pan array collected 0.45% of mass lost for 2.6 m Douglas-fir (18 ± 4 g of 4 kg) and 2% for Korean pine (33 ± 15 g of 1.58 kg), which at $\bar m$ = 0.10 g is ≈45 and ≈200 brands per kg *collected* — a hard lower bound only, since the array did not cover the full deposition footprint. The tabulated 100–300 is not contradicted but is not established. **To close:** USDA FS Research Data Archive **RDS-2020-0035** (doi:10.2737/RDS-2020-0035, Bahrani et al. 2020) records per-firebrand mass *and* projected area for 9,249 brands from chamise (the chaparral row's dominant species), little bluestem grass (grassland), saw palmetto, loblolly pine and Leyland cypress burned in a full-scale wind tunnel at 5.36 / 11.17 / 17.88 m s⁻¹, so σ = m/a falls out per brand with no shape or density assumption; the dataset is free (catalog at `fs.usda.gov/rds/archive/catalog/RDS-2020-0035`, free report at `firescience.gov/projects/15-1-04-4/project/15-1-04-4_final_report.pdf`) but returned HTTP 403 to automated retrieval — this is an access block, not a paywall, and a normal browser should get it. That σ is near-constant within a fuel and rises with wind speed is already demonstrated on the sibling structural dataset (Hedayati et al. 2019, *Front. Mech. Eng.* 5:43, Table 1: median m/a = 0.159 / 0.288 / 0.468 kg m⁻² at low/medium/high wind, mass–area correlation 0.83/0.72/0.90, stated as $m = Ka$ — $K$ *is* σ). **Known bias direction:** the estimated rows hold $v_t$ fixed and scale σ down by 0.475×, so if real grass/shrub brands prove thicker than a single leaf both σ and $v_t$ rise together; the tabulated σ are a **lower bound** and in-domain spot distances derived from them are biased **long**.

#### 2.2 Equations of motion and shape factor

$$m\frac{d\mathbf v}{dt} = -\tfrac{1}{2}\rho_a C_D A_\perp |\mathbf v - \mathbf u|(\mathbf v - \mathbf u) + m\mathbf g\left(1 - \frac{\rho_a}{\rho_p}\right)$$

$\mathbf v$ = brand velocity (m s⁻¹), $\mathbf u$ = local fluid velocity from the wind + plume field (m s⁻¹), $\rho_a$ = air density (kg m⁻³, from local $T$), $\rho_p$ = brand bulk density (kg m⁻³), $A_\perp$ = projected area (m²), $m$ = brand mass (kg), $\mathbf g$ = (0,0,−9.81) m s⁻². The buoyancy term is retained but negligible ($\rho_a/\rho_p \sim 3\times10^{-3}$).

We do **not** resolve brand orientation. Tumbling brands sample orientations on a timescale far below the transport timescale, so we use a fixed orientation-averaged $C_D$ per shape class. **This is a measurement, not an assumption.** Bagheri & Bonadonna (2016) tracked freely suspended non-spherical particles in a 4 m vertical wind tunnel with computer vision and found the mean projected area normal to the flow "very close to the average of projected areas of particles in random orientations", concluding that at high density ratio the preferred orientation of a freely falling particle is essentially its random-orientation average (§5.2.3, Figs. 19–20); they further found no dependence of drag on $\rho'$ once $\rho' > 100$, so the orientation-averaged $C_D$ is density-ratio-independent in the firebrand regime ($\rho' = \rho_p/\rho_a \approx 300$). Two caveats to carry: (a) residual spread from orientation variability is **+10% (max +20%) above and −13% (max −37%) below** the random-orientation mean (§5.1.2, Fig. 13); (b) their high-speed imaging confirms plates at these $Re$ **tumble and glide**, so a plate brand's horizontal motion is not purely wind-advected — we neglect aerodynamic lift, a real and unquantified bias toward **under-predicted lateral dispersion**. That bias acts opposite to the long-biased spot distances of §2.1's estimated rows; the two should not be assumed to cancel.

The standard sphericity-based alternative is Haider & Levenspiel (1989, *Powder Technol.* 58:63–70), parameterised on sphericity $\phi$ (surface area of volume-equivalent sphere / actual surface area):

$$C_D = \frac{24}{Re}\left(1 + A\,Re^{B}\right) + \frac{C}{1 + D/Re}, \qquad Re = \frac{\rho_a |\mathbf v - \mathbf u| d_{eq}}{\mu}$$

with $A,B,C,D$ functions of $\phi$ only. **Caveat, stated plainly:** Hölzer & Sommerfeld (2008, *Powder Technol.* 184:361–365) report a mean relative deviation of 383% for the Haider–Levenspiel correlation across their full dataset (versus 14.1% for their own correlation), with average errors of ~348–383% and maximum errors exceeding 1000% for cuboids and disks. An independent measurement on a different dataset agrees: Bagheri & Bonadonna (2016) benchmark Haider–Levenspiel against their own wind-tunnel measurements of particles falling freely **in air** — the firebrand-relevant regime — and report mean error 91.1% / max 242% in the Newton's regime (Table 5, p. 19), 54.9% / 242% over all Newton-regime data (Table 6, p. 21) and 19.4% / 244% over all $Re$ (Table 7, p. 24), attributing the overestimation specifically to the correlation having been fitted at low particle-to-fluid density ratio (1 < $\rho'$ < 15), which is the wrong regime for firebrands in air ($\rho' \approx 300$). The two figures are not in conflict — 383% is Hölzer & Sommerfeld's number for their own dataset, 91% is Bagheri's air-specific one. We therefore do **not** rely on the correlation for any of our shape classes, and use fixed orientation-averaged $C_D$ values throughout. **The reference area is normative and must be stated with each value** — that convention is where the previous entries went wrong:

| Shape class | Reference area $A_\perp$ | $C_D$ (orientation-avg.) | Source |
|---|---|---|---|
| Sphere / compact cone | $\pi d_{eq}^2/4$ | 0.463 | B&B Eq. (14) — confirms the former 0.47 to 3 s.f. |
| Cylinder, AR 2:1–13:1 | broadside $d\times L$ | 0.47 | B&B Eq. (28), $F_N = f^2e\,(d_{eq}^3/LIS)$ = 0.375 at AR 4:1 → $k_N$ = 1.561; nearly AR-independent (0.43 at 2:1, 0.54 at 13:1) |
| Flat plate / disc, flatness $f$ = 0.02–0.06 | plan area $L\times I$ | 0.95 | B&B Eq. (28); 0.75 at $f$ = 0.10, 1.12 at $f$ = 0.015 |
| Convoluted ribbon cylinder | plan area | 0.95 (treated as plate) | σ, not $C_D$, is the calibrated quantity (§2.1) |

Values are from Bagheri, G. & Bonadonna, C. (2016), "On the drag of freely falling non-spherical particles", *Powder Technol.* 301:526–544, doi:10.1016/j.powtec.2016.06.015, free preprint arXiv:1810.08787 — $k_N \equiv C_D/0.463$ (Eq. 14), $F_N$ from flatness $f = S/I$ and elongation $e = I/L$ (Eq. 27), $\log_{10}k_N = 0.45[-\log_{10}F_N]^{0.99}$ valid for 150 < $\rho'$ < 2130 and $Re$ = 10³–3×10⁵ with mean error 10.9% (Eq. 28, Table 5). Change of reference area is exact from the force balance, $C_D|_{\text{plan}} = C_D|_{d_{eq}}\cdot A_{eq}/A_{\text{plan}}$. Sphericity $\phi$ is deliberately **not** used as the shape descriptor: B&B show flatness and elongation correlate the drag and sphericity does not.

> **CLOSED (was OPEN QUESTION on the cylinder and flat-plate $C_D$):** Sourced, and the missing piece turned out to be the **reference-area convention**. The former cylinder 1.0 and flat-plate 1.3 were each roughly a factor of 2 too high because a randomly-oriented convex body presents on average only ~half its maximum projected area, while $A_\perp$ in this section is the *full* plan (or broadside) area. **What changed:** cylinder 1.0 → **0.47** (broadside $d\times L$), flat plate/disc 1.3 → **0.95** (plan $L\times I$), sphere 0.47 → **0.463** (confirmed), the fitted convoluted-ribbon 1.5 → **0.95** with σ moved to being the calibrated quantity, and the sanity-check value 1.4 → 0.95. The sphericity column is deleted. **Independent validation** against measured terminal velocities (Almeida, Porto & Viegas 2021, *Front. Mech. Eng.* 7:651135, open access, Table 3): inverting $\sigma = v_t^2\rho_a C_D/(2g)$ then $\sigma = \rho_p t$ recovers *P. pinaster* needle 1.11 mm equivalent diameter from $v_t$ = 3.31 m s⁻¹ (real ≈ 1 mm), *Q. robur* leaf 0.24 mm from 1.69 (real ≈ 0.2), *Q. suber* 0.31 mm from 1.94 (real ≈ 0.3) and *E. globulus* 0.46 mm from 2.36 (real ≈ 0.3–0.5) — four species, two shape classes, agreement within 20–30%, where $C_D$ = 1.3 would have required every leaf to be ~37% thicker than measured. Corroborating: Wang et al. (2013, *JFM* 733:650, Eq. 2.2, Fig. 4(b)) measured $\bar C_D$ of freely tumbling plates at $Re_T$ = 4855–6473 referenced to the full plate area and found 0.4–1.0 throughout, i.e. below 1.3. **Status: `validated`** per §0.7.3 — a peer-reviewed correlation fitted to ~300 particles in a 4 m vertical wind tunnel at $\rho'$ = 150–2130 and $Re$ = 10³–3×10⁵ (10.9% mean error), reproducing four independently measured terminal velocities to within 20–30%; `test/validation/` must assert the four Almeida terminal velocities to that tolerance.

**Terminal velocity.** The areal density $\sigma = m/A_\perp$ (kg m⁻²) is **shape-dependent**, because $A_\perp$ is the plan area for a plate but the broadside area for a cylinder. With $\delta$ the half-thickness everywhere in this document (§2.4, §4.1):

$$\sigma = k_{\text{shape}}\,\rho_p\,\delta, \qquad k_{\text{shape}} = \begin{cases} 2.000 & \text{plate / disc / convoluted ribbon (full thickness }2\delta)\\ \pi/2 = 1.571 & \text{cylinder of diameter }d = 2\delta \end{cases}$$

For the cylinder, $\sigma = \rho_p(\pi d^2L/4)/(dL) = (\pi/4)\rho_p d$. Applying the plate form uniformly — as this section previously did — overstates cylinder σ by $4/\pi$ = 1.273 and $v_t$ by $\sqrt{4/\pi}$ = 1.128, which is exactly wrong for the W. US conifer and simple-cylinder eucalypt classes that NIST and Hall measured. Since §4.1 carries a single `halfThk` and §2.4 regresses that one δ for every class, **the σ→$v_t$ conversion must branch on the shape nibble of `packed`.** Falling with tumbling-average $C_D$:

$$v_t = \sqrt{\frac{2\,\sigma\,g}{\rho_a C_D}} = \sqrt{\frac{2\,k_{\text{shape}}\,\rho_p\,\delta\,g}{\rho_a C_D}}$$

This is the single most important physical statement in the section: **$v_t$ depends only on areal density, not on lateral extent.** A brand can be made arbitrarily large in plan area — carrying arbitrarily large thermal mass and burnout time — without increasing its terminal velocity. Eucalypt ribbon bark exploits exactly this: strips up to ~10 m long, low areal density, $v_t \approx 5$ m s⁻¹, burnout up to 1304 s. Sanity check: a plate ($k_{\text{shape}}$ = 2) with $\rho_p$ = 300 kg m⁻³, $\delta$ = 3 mm (6 mm total thickness) gives $\sigma$ = 1.8 kg m⁻²; with $\rho_a$ = 1.2 and the tabulated plate $C_D$ = 0.95, $v_t = \sqrt{2(1.8)(9.81)/(1.2\cdot0.95)} = 5.6$ m s⁻¹ — inside the measured 5.2–5.8 m s⁻¹, with no ad-hoc adjustment. The check now uses the same $C_D$ as the table above; the former 1.4 gave 4.6 m s⁻¹ and missed the measurement low.

#### 2.3 Lofting

No special lofting model is needed: the brand simply rises wherever $u_z > v_t$. Maximum loft height falls out of the integration. For the analytic extension above the voxel domain top (§4.3) and for cross-checking, we use the Heskestad far-field plume centreline:

$$u_z(z) \approx 1.03\,\dot Q_c^{1/3}\,(z-z_0)^{-1/3}$$

$\dot Q_c$ = convective heat release rate of the plume source (kW), $z$ = height above source (m), $z_0$ = virtual origin (m), $u_z$ in m s⁻¹. The coefficient is $3.4\,[g/(c_p\rho_\infty T_\infty)]^{1/3}$ with $g$=9.81 m s⁻², $c_p$=1005 J kg⁻¹ K⁻¹, $\rho_\infty$=1.2 kg m⁻³, $T_\infty$=293 K. Setting $u_z = v_t$: a 10 MW torching tree lofts a $v_t$=5 m s⁻¹ brand to ~87 m; a 100 MW crown-fire segment to ~870 m. Both are the right order for observed spotting.

#### 2.4 Combustion mass loss in flight

Brands burn by surface regression. We track a single characteristic half-thickness $\delta$ (m):

$$\frac{d\delta}{dt} = -\beta_0\,\frac{1 + 0.3\,Re^{1/2}}{1 + 0.3\,Re_t^{1/2}}\,\chi(\text{MC})$$

$\beta_0$ = reference regression rate at terminal-velocity conditions (m s⁻¹), $Re_t$ = Reynolds number at terminal velocity, $\chi$ = moisture retardation factor. The Ranz–Marshall-form $Re^{1/2}$ enhancement captures the fact that a brand accelerating through the plume at 20 m s⁻¹ burns faster than one drifting at $v_t$. Normalising by $Re_t$ means $\beta_0$ is directly calibrated from published wind-tunnel burnout times *measured at terminal velocity* (Hall et al. 2015) — no unit conversion or unmeasured constant is required:

$$\beta_0 = \delta_0 / t_{\text{burnout}}$$

Mass and terminal velocity then evolve together, and this is the key coupling: as $\delta$ shrinks, $\sigma$ shrinks, $v_t \propto \sqrt\sigma$ falls, and the brand's descent decelerates — a burning brand stays aloft longer than a cold one of the same initial size. Sardoy et al. (2008, *Combust. Flame* 154:478) showed with 10,000 disc-shaped Lagrangian brands that this produces a **bimodal ground distribution**: flaming brands land short, char-oxidising brands land long, with the separation set by char content $\nu_c$. Our solver reproduces this behaviour structurally; we should expect it and not treat it as a bug.

#### 2.5 Burnout criterion

A landing brand is a viable ignition source only if it is still an active oxidiser. Two conditions, both required:

$$\delta > 0 \quad \wedge \quad \frac{m}{m_0} > f_{\text{glow}}$$

We set $f_{\text{glow}} = 0.20$, anchored to Ellis (2011, *IJWF* 20:897), who combusted *E. obliqua* stringybark samples to ~20% of initial mass before dropping them on litter beds and still obtained ignitions. Brands failing either test are killed and contribute only to the ash/soot field.

---

### 3. Landing and ignition probability

There is **no well-validated multivariate ignition-probability function for firebrands in the literature.** Published studies are single-factor or two-factor and use different fuel beds, brand preparations and ignition definitions. We therefore fit a logistic surrogate and state it as a calibrated construct, not a citation:

$$P_{ig} = \left[1 + \exp\!\big(-(b_0 + b_1\ln m + b_2 M + b_3 U_s + b_4\rho_b + b_5 S)\big)\right]^{-1}$$

$m$ = brand mass at landing (g), $M$ = receptor fuel moisture (% oven-dry), $U_s$ = surface windspeed at 0.1 m (m s⁻¹), $\rho_b$ = receptor bulk density (kg m⁻³), $S \in \{0,1\}$ = flaming vs glowing state. Anchors used to constrain the coefficients:

| Anchor | Source |
|---|---|
| $P_{ig} \to 1$ for flaming brands on fine fuels below ~10% MC | Plucinski & Anderson (2008, *IJWF* 17:628) |
| Glowing 0.5–1.6 g stringybark brands ignite *P. radiata* litter at 2–8% MC | Ellis (2011, *IJWF* 20:897) |
| Grasses > litter; *Pinus* litters most flammable among litters; ignition frequency falls with increasing bulk density and MC | Ganteaume et al. (2009, *IJWF* 18:951) |
| Wind increases the glowing→flaming transition probability — the effect is on the **brand**, not the fuel | Plucinski et al.; hence $b_3$ enters via $S$ as well as directly |
| Hot-particle ignition thresholds for cellulosic beds (particle size × temperature trade-off) | Hadden et al. (2011) |

$b_4 < 0$ (denser beds ignite less readily — reduced oxygen ingress) and $b_2 < 0$ are firm; $b_1 > 0$ is firm; the magnitudes are biome-tunable. **The coefficients are fitted, and the uncertainty on a single-brand $P_{ig}$ is easily ±0.2 absolute.** This is acceptable because we integrate over $10^4$–$10^5$ brands and the *aggregate* spot-fire rate is far better conditioned than any individual draw.

A successful draw writes an ignition into the 0.5 m surface grid. Because a single surface cell ignition on a 0.5 m grid is well below the ~1 m² minimum area for a self-sustaining spot fire in most fuels, we require **coalescence**: an ignition seeds a sub-grid smouldering source with an energy budget, and only promotes to a live surface-fire cell if it survives a residence check against local moisture and wind. Without this, we massively over-predict spot-fire counts.

---

### 4. GPU implementation

#### 4.1 Buffer layout

Fixed pool of $N_{\max} = 131{,}072$ slots (2¹⁷). 48 bytes per brand, std430-compatible, 16-byte aligned:

```wgsl
struct Brand {                    // 48 B
  pos      : vec3<f32>,           // 0   world m
  halfThk  : f32,                 // 12  δ, m — σ = k_shape·ρ_p·δ, branch on shape (§2.2)
  vel      : vec3<f32>,           // 16  m/s
  massFrac : f32,                 // 28  m/m0
  areaEq   : f32,                 // 32  d_eq, m
  weight   : f32,                 // 36  super-particle multiplicity
  age      : f32,                 // 40  s
  packed   : u32,                 // 44  shape:4 | fuel:4 | biome:4 | flags:4 | rngSeed:16
}
```

Total 6.29 MB. Auxiliary: `alive: array<u32>` (0.5 MB), `freeList: array<u32>` (0.5 MB), scan partials (~1 KB), `indirectArgs` (12 B). Under 8 MB against an 8 GB budget — irrelevant.

#### 4.2 Atomic-free spawning and compaction

Atomics on a single global counter serialise and make results non-deterministic across runs, which makes debugging spot behaviour miserable. We use **prefix sums** instead:

1. **Count pass.** One thread per burning surface cell / canopy voxel computes $n_i = \lfloor \dot N_i \Delta t \rfloor$ + stochastic remainder (counter-based hash RNG keyed on `(cellIndex, frameIndex)` — stateless, no buffer, reproducible). Writes `spawnCount[i]`.
2. **Exclusive scan** over `spawnCount` (workgroup-local Hillis–Steele in shared memory, then a workgroup-offset scan, then a scatter — three dispatches, the standard portable pattern; WebGPU subgroup ops are not yet guaranteed across Chrome/Edge versions so we do not depend on them).
3. **Spawn pass.** Cell $i$ writes its $n_i$ brands to `freeList[base_i + k]`, $k \in [0,n_i)$. No contention, fully deterministic. Brand size is drawn from a **truncated power law of exponent −2 in projected area** (§2.1), truncated below at the ignition-viable size — not from a delta at $\bar m$ and not from a lognormal.
4. **Compaction.** After integration, an exclusive scan over the `alive` flag produces a dense `activeIndices` list and, in the last element, the live count — written directly into `indirectArgs` for `dispatchWorkgroupsIndirect` next frame. Dead slots are recycled into `freeList` by the complementary scan in the same pass.

We do **not** compact the brand records themselves (no gather/scatter of 48-byte payloads). We compact only the 4-byte index list. This trades some cache-line waste for eliminating 6 MB of traffic per frame — clearly the right side of the trade at these sizes.

**Population control:** if the scan reports demand above $N_{\max}$, we do not grow the pool. We double the super-particle `weight` of newly spawned brands and halve the spawn count. Cost stays flat; statistical resolution degrades gracefully. This is what keeps a Black Saturday-scale dense-spotting scenario from falling off a cliff.

#### 4.3 Sampling the wind and plume fields

$\mathbf u$ is assembled from three sources, sampled per substep:

- **Plume/canopy region** ($z \le 128$ m): trilinear `textureSampleLevel` from a `texture_3d<f32>` (rgba16float, 128×128×64 = 8 m horizontal / 2 m vertical) holding the sim's velocity field, downsampled from the canopy voxel grid. One sample. rgba16float 3D at that resolution is 8.4 MB (1,048,576 texels × 8 B). If 4 MB is the actual budget, drop to rgba8unorm with a velocity scale factor, or halve the vertical resolution to 128×128×32.

> **OPEN QUESTION (unverified):** Which of those three options is normative has not been decided, and the choice is not free. rgba8unorm needs a per-frame velocity scale factor and costs precision in the low-speed ambient field where brand drift is most sensitive to it; halving the vertical resolution takes the plume sampling from 2 m to 4 m, which is coarse relative to the vertical velocity gradient a brand traverses while lofting. It is also not established that 4 MB *is* the budget — §4.1's "under 8 MB" figure covers the brand buffers only and does not include this texture. To close: confirm the VRAM line item for the brand-transport wind texture against the global budget in `10-webgpu-architecture.md` §6.2, then pick one option and state it here.
- **Above the voxel top:** analytic Heskestad plume (§2.3) blended over 16 m with the ambient profile, using the plume centreline position advected by the mean wind.
- **Ambient:** log wind profile $u(z) = (u_*/\kappa)\ln((z-d)/z_0)$ with $\kappa$=0.41, plus the gust field from the meteorology module. Evaluated analytically, no fetch.

Total: **one 3D texture fetch plus ~150 ALU ops per brand per substep.**

**Integrator.** Drag relaxation time $\tau = \sigma/(\tfrac12\rho_a C_D|\mathbf v-\mathbf u|)$ is ~0.004–0.017 s for the thin-plate classes ($\sigma$ = 0.048–0.19 kg m⁻², $C_D$ = 0.95, §2.1) in a 20 m s⁻¹ plume — at or below our 1/60 s = 0.0167 s frame time, so explicit Euler would need substepping. Instead we use a semi-analytic exponential integrator, unconditionally stable:

$$\mathbf v_{n+1} = \mathbf u + (\mathbf v_n - \mathbf u)\,e^{-\Delta t/\tau_n} + \mathbf g\tau_n(1-e^{-\Delta t/\tau_n})$$

One `exp()` per brand per step buys us a single substep instead of 4. Net win.

#### 4.4 Cost estimate (RTX 4070 Laptop, WebGPU/Chrome)

| Pass | Work | Est. |
|---|---|---|
| Spawn count + scan | 3 dispatches over ≤131k u32 | 0.02 ms |
| Integrate + burn + land | 100k threads, 1 3D fetch + ~150 ALU + 1 exp | 0.15–0.30 ms |
| Landing ignition scatter | ~10²–10³ threads, `atomicOr` into 2048² bitmask | <0.01 ms |
| Alive scan + indirect args | 3 dispatches over 131k u32 | 0.02 ms |
| **Total @ 100k brands** | | **≈0.2–0.35 ms/frame** |

Roughly **2% of a 16.7 ms frame**. The pass is certainly not ALU-bound or bandwidth-bound: 100k fetches × 8 B ≈ 0.8 MB per frame against ~250 GB s⁻¹ of memory bandwidth. Firebrands are cheap; the expensive parts of this simulator are elsewhere. There is no case for reducing the brand count below 100k on performance grounds.

> **OPEN QUESTION (unverified):** The stated bound is wrong even though the total is plausible. At these sizes the arithmetic and the memory traffic both cost microseconds, and texture-fetch latency over 100k threads is hidden by occupancy — so 0.2–0.35 ms is not a latency-bound figure, it is dominated by per-dispatch and barrier overhead on browser WebGPU (roughly 8 dispatches here at the ~7 µs of command overhead used in `50-meteorology.md`, plus the pipeline barriers between the scan stages). That reframing matters for optimisation: reducing the brand count or the fetch cost buys nothing, while fusing the scan dispatches does. To close: measure with timestamp queries at 10k, 100k and 131k brands — if the three come out within noise of each other, the cost is fixed overhead and the table should be restated as a per-dispatch budget rather than a per-brand one.

---

### 5. Why spotting changes fire behaviour qualitatively

Three regimes, and they are not a continuum:

**Isolated long-range spotting.** Sparse brands land kilometres ahead. Each is an independent ignition that grows as its own fire. Effect on the main front's ROS: essentially zero until the spot fires are large enough to merge, which may take hours. Operationally dangerous, dynamically uninteresting.

**Dense short-range spotting → pseudo-continuous spread.** This is the regime that breaks quasi-steady ROS models. When brand density ahead of the front is high enough that spot ignitions occur within the front's own advance distance during one brand flight time, the fire no longer propagates by flame contact at all — it propagates by *sequential ignition of the next spot before the previous one has finished growing*. The observed ROS becomes $\approx d_{\text{spot}} / t_{\text{flight}}$, decoupled from Rothermel entirely. In the Kilmore East fire (Cruz et al. 2012, *For. Ecol. Manage.* 284:269), profuse spotting up to 500 m ahead of the solid flame front produced ROS of 68–153 m min⁻¹ and fireline intensities to 88,000 kW m⁻¹ — "substantially higher than expected" from the surface model. Longer-range spotting reached 33 km.

**Coalescence and the ROS jump.** Two or more spot fires merging produce a concave fire perimeter. The radiative and convective view factors in the concavity are far higher than for a convex front, so the merged front accelerates *above* both parents' ROS — a genuine super-linear jump, not a bookkeeping artefact. Our explicit view-factor radiation model reproduces this without extra machinery, which is a significant argument for having built it that way. The step change in ROS at coalescence is one of the outputs the measurement HUD should surface.

**Why eucalypt and chaparral are the extreme cases.** Eucalypt for the reason established in §2.2: ribbon and stringy bark decouple brand size from terminal velocity, so it produces brands that are simultaneously long-lived (429 s mean, 1304 s max burnout for convoluted cylinders) and slow-falling ($v_t \approx 5.8$ m s⁻¹). Hall et al. (2015) note the maximum burnout is consistent with spotting beyond 20 km at 60 km h⁻¹ transport wind. No other genus produces a brand with that combination — conifer brands, which are cylinders rather than plates (§2.1), burn out in 30–200 s. Additionally, eucalypt fires burn into a receptor bed (dry sclerophyll litter, often <8% MC on severe days) with near-unity ignition probability, so essentially every viable brand that lands starts a fire. Chaparral is extreme for a different reason: extremely high intensity per unit area from near-total live-fuel involvement drives strong updrafts, and the fuel bed is spatially continuous and uniformly receptive, so short-range spotting merges almost immediately.

**Domain-scale honesty.** Our domain is 1 km × 1 km. **Long-range spotting cannot be represented** — a brand lofted to 800 m in a 15 m s⁻¹ wind exits the domain in ~70 s. We therefore: (a) simulate in-domain spotting fully, which correctly captures the dense short-range regime that dominates ROS; (b) log every exiting brand's state (position, velocity, mass, temperature, remaining burn time) to the CSV/JSON export so the long-range flux is *measurable* even though it is not *simulated*; (c) provide no domain wrapping, since a toroidal domain would make brands re-enter behind the fire and produce entirely spurious behaviour. Users must understand that in-domain spot counts are a lower bound on real spotting activity.
