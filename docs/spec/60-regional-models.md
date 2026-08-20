## 7. Regional Fire Models: Eucalypt, Chaparral, UK

Rothermel (1972) is a steady-state, dead-fuel-dominated, packing-ratio-based reaction-intensity model calibrated on cured litter and grass beds. Three of our five biomes break it: eucalypt forest because bark-borne spotting, not flame-front conduction, sets the effective spread rate; chaparral because the fuel is a live-dominated, oil-rich, elevated shrub crown; UK because no fuel model set exists at all. Eucalypt and the UK get their own rate-of-spread (ROS) closures; chaparral ships on Rothermel itself with the SH5/SH7 fuel models plus gates applied outside the Rothermel call (§7.2.3), because no free chaparral-specific ROS model could be obtained. All feed the same surface-layer solver interface: the closure returns `R_head` (m s⁻¹) at the cell, and the 3D canopy/firebrand modules are driven from Byram intensity as usual. Switching closure by biome ID costs one indirect branch per cell; over the 2048² grid (4.19 M cells) even the most expensive of these closures is ~60–120 FLOP/cell, i.e. <0.5 GFLOP per fire step — well under 1 ms on an RTX 4070 Laptop (~15 TFLOP/s fp32) and not a budget concern. The expensive part of this section is validation, not arithmetic.

> **OPEN QUESTION (unverified):** The cost argument above counts arithmetic, which is not the binding constraint for this pass. At an assumed ~40 bytes of per-cell state read + written across the 4.19 M cells, the closure pass moves ~170 MB per fire step, which is ~0.65 ms at the 4070 Laptop's ~256 GB/s memory bandwidth — still inside budget, but bandwidth-bound and roughly 20× tighter than the FLOP figure implies. The 40 B/cell figure is itself an estimate, not a measured layout, and every extra per-cell field the regional closures demand (`H_ns`, both FHS fields, `cure_fraction`, `live_fraction`, shrub height) pushes it up. Before this budget is quoted anywhere else or used for scheduling: fix the actual per-cell state layout for each closure, re-derive the bound from bytes moved rather than FLOPs, and confirm against a GPU timestamp query on the real kernel.

---

### 7.1 Eucalypt / Australian dry forest

#### 7.1.1 McArthur Mk5 Forest Fire Danger Meter (Noble, Bary & Gill 1980)

Retro-fitted equations for McArthur's (1967, 1973a) slide rule. We implement it as the **danger-index / HUD layer and legacy comparison**, not as the primary spread model.

**FFDI** (Noble et al. 1980; reproduced in Dowdy et al. 2009, CAWCR TR-010 Eq. 1):

```
FFDI = 2 · exp( −0.450 + 0.987·ln(D) − 0.0345·H + 0.0338·T + 0.0234·V )
```

| Symbol | Meaning | Units |
|---|---|---|
| `FFDI` | Forest Fire Danger Index | dimensionless (0 → >100) |
| `D` | drought factor, 0 < D ≤ 10 | dimensionless |
| `H` | relative humidity at 15:00 LST | % |
| `T` | air temperature at 15:00 LST | °C |
| `V` | 10-m open wind speed | km h⁻¹ |

**Drought factor** (Noble et al. 1980):

```
D = min[ 10 , 0.191·(KBDI + 104)·(N+1)^1.5 / ( 3.52·(N+1)^1.5 + P − 1 ) ]
```
`KBDI` = Keetch–Byram Drought Index (mm, 0–203.2), `N` = days since last rain (d), `P` = rainfall in that event (mm).

Noble et al. themselves admit this is not an exact fit to McArthur's step function; Sirakoff (1985) and Griffiths (1999) showed the resulting FFDI can differ by up to **two fire-danger classes**. Use Griffiths' limited form:

```
D = min[ 10 , 10.5·(1 − e^(−(SMD+30)/40)) · (41x² + x) / (40x² + x + 1) ]
x = N^1.3 / (N^1.3 + P − 2)        for N ≥ 1 and P > 2 mm
x = 0.8^1.3 / (0.8^1.3 + P − 2)    for N = 0 and P > 2 mm
x = 1                              otherwise
```
where the rainfall event is the run of consecutive days with >2 mm within the previous 20 days that yields the lowest `x`, `P` is that event's total (mm) and `N` is the number of days since the event's largest daily fall. Finkele et al. (2006) additionally cap `x` at `x_lim` = 1/(1 + 0.1135·SMD) for SMD < 20 mm and 75/(270.525 − 1.267·SMD) for SMD ≥ 20 mm.

`SMD` = soil moisture deficit (mm), i.e. KBDI or Mount's Soil Dryness Index. The `x` sub-cases follow Griffiths (1999)/Finkele et al. (2006) as implemented in the xclim reference code; note that the 1.5 exponent belongs to the Noble et al. drought factor above and must not be carried across into this form.

**KBDI**, SI form (Keetch & Byram 1968; Crane 1982):

```
dQ = (203.2 − Q)·(0.968·e^(0.0875·T_max + 1.5552) − 8.30) · 10⁻³ / (1 + 10.88·e^(−0.001736·R_ann))
```
`Q` = drought index (mm water deficit), `T_max` = daily max temperature (°C), `R_ann` = mean annual rainfall (mm), `dQ` in mm d⁻¹. Rainfall is applied net of a 5.1 mm threshold on the first day of a wet spell. Mount's SDI (Mount 1972) systematically yields larger deficits and hence higher D (Finkele et al. 2006); we expose the choice as a scenario parameter and default to KBDI.

**Fine dead fuel moisture** from McArthur's table, Viney's (1992) approximation:

```
M = 5.658 + 0.04651·H + 3.151×10⁻⁴·H³/T − 0.184·T^0.77       [M in %, H in %, T in °C]
```
(Cruz et al. 2015 prints 0.184; several implementations use 0.1854 — the difference is <0.1 % M and immaterial.)

**Rate of spread on flat ground** (Noble et al. 1980, Eq. 5.27 in Cruz et al. 2015):

```
R = 0.0012 · FFDI · w          [R in km h⁻¹, w = fine fuel load in t ha⁻¹]
```
Flame height `H_f ≈ 13R + 0.24w − 2` (m). At the canonical `w` = 12.5 t ha⁻¹, R = 0.015·FFDI km h⁻¹.

**Honest limit:** the Mk5 ROS relation under-predicts established wildfire fronts under dry, windy conditions **by a factor of three or more** (Cheney 1985; Cheney & Gould 1996; Burrows 1994 measured MAE 1.13 m min⁻¹ / 56 % with 66 % of cases under-predicted over 35 jarrah fires). Its wind response saturates because it was parameterised on litter-bed fires without near-surface/elevated fuels. Do not use it to drive the simulation.

#### 7.1.2 Dry Eucalypt Forest Fire Model / Project Vesta (Cheney et al. 2012) — the primary model

Fuel-hazard-score (FHS) version, Eq. 9 of Cheney et al. 2012 (= Eq. 5.28 in Cruz et al. 2015; constants cross-checked against the CSIRO Spark implementation):

```
R = 30 · f(M)                                                                    ,  U10 ≤ 5 km/h
R = [ 30 + 1.5308·(U10 − 5)^0.8576 · FHS_s^0.9301 · (FHS_ns · H_ns)^0.6366 · B1 ] · f(M)
                                                                                 ,  U10 > 5 km/h
f(M) = 18.35 · M^(−1.495)                                     (Burrows 1999 moisture damping)
```

| Symbol | Meaning | Units | Range |
|---|---|---|---|
| `R` | head-fire ROS | **m h⁻¹** (÷3600 for m s⁻¹) | 2.5–260 m min⁻¹ observed |
| `U10` | 10-m open wind speed | km h⁻¹ | 5–60 |
| `FHS_s`, `FHS_ns` | surface / near-surface fuel hazard score | dimensionless | 0–4.0 |
| `H_ns` | near-surface fuel height | **cm** | 5–40 |
| `M` | fine dead fuel moisture content | % oven-dry | 3–20 (validated ≤10) |
| `B1` | bias correction | — | 1.03 |

Dead fuel moisture from T (°C) and RH (%), by diurnal period (Cheney et al. 2012 Eq. 5.30):

| Period | Hours | Equation |
|---|---|---|
| 1 | 12:00–16:59, clear sky, Oct–Mar | `M = 2.76 + 0.124·H − 0.0187·T` |
| 2 | 09:00–11:59 and 17:00–19:59 | `M = 3.60 + 0.169·H − 0.0450·T` |
| 3 | 20:00–08:59 | `M = 3.08 + 0.198·H − 0.0483·T` |

**Why Vesta over McArthur:** the wind exponent is 0.86 on `(U10 − 5)` and the model carries explicit fuel-structure terms, so it reproduces the near-linear-to-superlinear wildfire wind response McArthur misses. Validation: MAE 2.16 m min⁻¹ (35 %, bias −0.03) on 16 experimental fires; MAE 26.4 m min⁻¹ (54 %, +6.8 bias) on 25 wildfires; Kilinc et al. on 181 wildfires (0.2–260 m min⁻¹) gave MAE 25 m min⁻¹ (122 % MAPE, −0.7 bias). **Cost:** the model is strongly sensitive to `H_ns` — doubling near-surface height multiplies the wind-driven term by 2^0.6366 = 1.55 (+55 %), and raises R by somewhat less because of the additive 30 m h⁻¹ term (≈ +54 % at U10 = 30 km h⁻¹, FHS_s = FHS_ns = 3.5) — so our procedural understorey generator must emit `H_ns` and both FHS fields as first-class per-cell fields, not derive them from a single "fuel load" scalar. Vesta Mk 2 (Cruz et al. 2022) supersedes Mk 1 for operational use; we keep Mk 1 because its equation form is fully published and Mk 2's added complexity buys accuracy we cannot validate in a game-scale simulation. Flag this in the docs.

#### 7.1.3 Ribbon-bark spotting

Bark type, not flame length, is what makes eucalypt fires exceptional. Two mechanisms, both fed into the Lagrangian firebrand module with distinct source terms:

- **Fibrous / stringybark** (*E. obliqua, E. marginata, E. macrorrhyncha*): bark ignites easily and sheds continuously along the trunk. Produces *profuse short-range* spotting (≤500–750 m) with near-flat trajectories, plus vertical fire propagation into the crown. Its effect is a **rate multiplier**: coalescence of dense spot showers builds a deep flaming zone and a "pseudo flame front" that advances faster than any flame-contact model predicts (McArthur 1967; Ellis 2011). With `M` < 4 % even glowing particles ignite receptor beds.
- **Smooth decorticating / ribbon bark** (*E. viminalis, E. globulus, E. delegatensis, E. rubida*): long streamers hang from upper branches, detach, and **curl into hollow tubes that burn for up to ~40 min** (Hodgson 1967). Low mass-to-area ratio → low terminal velocity (~1–3 m s⁻¹) and long residence in the plume. Combined with a strong convection column and strong winds aloft, this yields authenticated **~30 km** spotting (Hodgson 1967; McArthur 1969; Cruz et al. 2012, Black Saturday Kilmore East).

Implementation: per-tree-species bark class drives (a) a brand-generation rate proportional to canopy-voxel heat release above threshold, (b) a brand shape class — disc (fibrous, high drag, short burnout ~60–200 s) vs cylinder/ribbon (low drag, burnout 600–2400 s). Ribbon brands need a long lifetime tail, so budget the particle pool for ~10⁵–2×10⁵ live brands with 32-byte state; that is ~6 MB and negligible against the 8 GB VRAM. Categorise landings as short (<750 m), medium (1–5 km, produces pseudo-fronts) and long (>5 km, isolated new fire) for the HUD.

**Validation data:** Project Vesta experimental fires (Gould et al. 2007a; McCaw et al. 2012, 116 fires, jarrah/karri, 2.5–16 m min⁻¹); Burrows (1994, 1999) jarrah dataset (35 fires); Cheney & Gould (1996); documented wildfires — Kilmore East 2009 (Cruz et al. 2012) with reconstructed runs of 68–153 m min⁻¹, average fireline intensities up to ~88 000 kW m⁻¹, and spotfires up to 33 km ahead of the front; Cheney & Bary (1969) spotting observations.

---

### 7.2 Mediterranean chaparral

> **CLOSED** (was: *"what is the documented direction and magnitude of Rothermel's bias in chaparral, and does a better free chaparral-specific model exist?"*, premised on "the literature widely states it underpredicts"). **The premise was wrong.** There is no single signed bias: the sign is set by the *fuel model*, not by the spread equation. The only published field validation of Rothermel in Californian chaparral gives both signs on the same fire with the same equation — with the operational reverse-fitted shrub model (FBPS fuel model 4) observed spread was ~80 % of predicted (regression slope 0.82, R² = 0.60, n = 28 spread events), i.e. it runs **high by ~1.25×**; with a physically inventoried custom chamise fuel model (CHAMISE2) observed spread was ~380 % of predicted, i.e. it runs **low by ~3.8×** (Weise, Gelobter, Regelbrugge & Millar 1997, *The Bee Fire: A Case Study Validation of BEHAVE in Chaparral Fuels*, Proc. Symp. Fire in California Ecosystems: 114–120; Abstract p.114, Table 2 p.117, Eqs. 2–3 and text pp.118–119, https://research.fs.usda.gov/download/treesearch/53320.pdf). The unqualified claim that Rothermel under-predicts chaparral is therefore deleted from this section; it holds only for laboratory live-fuel beds and for inventory-derived custom fuel models. **No free chaparral-specific ROS model exists to ship instead** — Rothermel & Philpot (1973) SCAL coefficients are paywalled, Cohen's FIRECAST (GTR PSW-90) is only Rothermel+Albini driven by those SCAL models, Lindenmuth & Davis (RM-101) is Arizona shrub live oak with slope deliberately excluded and requires net solar radiation and foliar phosphate as inputs, the Riverside Fire Lab custom models publish no SAV and no M_x so cannot be instantiated, and Albini & Anderson (1981/82) could not be located free. **Chaparral therefore ships Rothermel (1972) with Scott & Burgan (2005) SH5 (mature chamise) and SH7 (senescent / high-load mixed manzanita–ceanothus), validation status `substituted`** per §0.7.3 — see §7.2.3 for the four signed biases and the required external gates.

#### 7.2.1 How Rothermel fails here, and in which direction

Rothermel treats live fuel as an *inert heat sink* via a moisture damping coefficient and a live moisture of extinction — it has no representation of (i) volatile terpene/oil emission from live foliage, which produces an ignitable gas phase well below the "extinction" moisture, (ii) the fact that chaparral burns as an elevated, aerated shrub crown with packing ratios far below litter beds, or (iii) the fuel-structure discontinuity of a stand that ignites in a dead surface layer and transitions to an elevated live crown layer (§7.2.3).

**Laboratory evidence (live fuel beds).** Weise et al. (2016) burned 240 laboratory fires in high-bulk-density live chaparral beds (chamise, ceanothus, manzanita, scrub oak; North Mountain Experimental Area, CA, 2003–2006). Of the 123 fires that actually spread, Rothermel at default settings predicted spread in exactly **1** (chamise: predicted-no/actual-yes 69, predicted-yes/actual-yes 1; broadleaf: 53 and 0), classification AUC 0.507 (chamise) and 0.500 (broadleaf) — indistinguishable from chance (Table 5 p.987). Pearson r between observed and predicted ROS (chamise / broadleaf, Fig. 5 p.988): Rothermel **0.11** (p = 0.23, not significant) / undefined; Rothermel2 (raised live M_x) 0.33 / 0.06; Cohen 0.33 / 0.04; Wilson 0.42 / 0.05; Catchpole 0.49 / 0.26; **Pagni–Koo 0.62 / 0.68**; Balbi 0.70 / 0.47 — variants span 0.04–0.49. Error measures (Table 7 p.988): mean bias −0.23 (chamise), −0.15 (broadleaf), −0.19 m min⁻¹ (all), NMAE 0.98–1.00 and FAC2 0.00–0.01, i.e. predicted ROS was effectively zero; Pagni by contrast gives FAC2 0.86 and NMAE 0.43–0.49. Raising the live moisture of extinction does **not** fix this: the four moisture-modified variants all improved classification (AUC 0.53–0.69, spread correctly predicted 49–69 % of the time) without reaching usable accuracy, and the authors conclude that "factors other than moisture of extinction are influencing the performance (or lack thereof) of the Rothermel model in these live fuel beds" (Abstract p.980, Discussion p.989). Only the physically based models (Pagni, Balbi) fell within a factor of two of actual rates. [Weise, D.R.; Koo, E.; Zhou, X.; Mahalingam, S.; Morandini, F.; Balbi, J.-H. 2016. *Fire spread in chaparral — a comparison of laboratory data and model predictions in burning live fuels.* Int. J. Wildland Fire 25(9):980–994, doi:10.1071/WF15177, https://research.fs.usda.gov/download/treesearch/52537.pdf]

**This laboratory result is not the field-scale bias and must never be quoted as one.** The authors state the dataset "is limited in its applicability to field-scale wildland fire spread. With their higher bulk density, these fuel beds are more akin to forest litter fuel beds" (Discussion p.989).

**Field evidence (the only published one).** On the Bee Fire (9,620 ac / 3,848 ha chamise chaparral, San Bernardino NF, 29 Jun – 2 Jul 1996; 28 spread events reconstructed from successive perimeters; observed ROS 3–265 ch hr⁻¹ = 1–89 m min⁻¹), Rothermel driven by FBPS fuel model 4 **over-predicted**: OROS = 25.4 + 0.82·(FBPS4), R² = 0.60, intercept not significantly different from zero at α = 0.05, so the unit-independent result is the slope — observed spread was ~80 % of predicted. Driven by the physically inventoried custom chamise model CHAMISE2 the same equation **under-predicted** by ~3.8× (OROS = 31.5 + 3.79·(CHAMISE2)); CHAMISE2's predicted range 2–57 ch hr⁻¹ cannot reach the observed upper range at all, against FBPS4's 9–274 ch hr⁻¹. Carry the caveats: n = 1 fire, a heat-wave rather than Santa Ana fire, and 4 of 28 events (polygons 2, 7, 18, 22, all with generally downslope wind) had influential residuals and were not fit by the regression (Weise et al. 1997, Bee Fire, Abstract p.114, Table 2 p.117, Eqs. 2–3 and text pp.118–119).

**Independent, non-Californian corroboration.** In Arizona oak chaparral, Rothermel with a constant moisture of extinction "accounts for only 12 percent of the variation in the research data" and the NFDRS variant for 21 percent; "The latest version includes a variable moisture of extinction which does not work in Arizona oak chaparral." The same study documents a seasonal bias direction that matters to any simulator with a weather model: contemporary wind- and fine-fuel-moisture-weighted models "predict an ROS that is too high for the cool half of the year (November–April) and too low for the warm half (May–October)" (Lindenmuth, A.W.; Davis, J.R. 1973. *Predicting fire spread in Arizona's oak chaparral.* USDA FS Res. Paper RM-101, model comparison pp.3–4, Discussion p.8, https://research.fs.usda.gov/download/treesearch/33437.pdf).

Meanwhile fuel model 4 was **reverse-fitted** to expected chaparral behaviour rather than built from field inventory (Anderson 1982), and at landscape scale HFire and FARSITE — both Rothermel-driven, with Riverside Fire Lab chaparral fuel models — modelled the Day and Calabasas fires "as being much larger than the actual fires" and over-predicted the Simi Fire too, though suppression is unmodelled in both cases (Peterson, S.H. et al. 2009. *Using HFire for spatial modeling of fire in shrublands.* USDA FS Res. Paper PSW-RP-259, Discussion; preprint https://www.physics.ucsb.edu/~complex/pubs/HFire1.pdf). So Rothermel+FM4 is physically wrong *and* biased high at field scale — a known, signed, correctable bias rather than an uncontrolled one, which is why §7.2.3 ships SH5/SH7 in place of FM4.

#### 7.2.2 Standard fuel models — SH5/SH7 ship, FM4 does not

| Model | 1-h | 10-h | 100-h | live woody | SAV dead-1h / live | depth | M_x,dead |
|---|---|---|---|---|---|---|---|
| FM4 "Chaparral 6 ft" (Anderson 1982) | 5.01 | 4.01 | 2.00 | 5.01 t ac⁻¹ | 2000 / 1500 ft⁻¹ | 6.0 ft | 20 % |
| FM4 in SI | 11.23 | 8.99 | 4.48 | 11.23 t ha⁻¹ (Σ 35.93) | 6562 / 4921 m⁻¹ | 1.83 m | 20 % |
| SH5 (Scott & Burgan 2005, #145) | 3.60 | 2.10 | 0.00 | 2.90 t ac⁻¹ | 750 / 1600 ft⁻¹ | 6.0 ft | **15 %** |
| SH7 (#147) | 3.50 | 5.30 | 2.20 | 3.40 t ac⁻¹ | 750 / 1600 ft⁻¹ | 6.0 ft | **15 %** |

(SH5 characteristic SAV 1252 ft⁻¹, packing ratio 0.00206; SH7 1233 ft⁻¹, 0.00344.)

Every SH5/SH7 value in the table above is verified against Scott, J.H.; Burgan, R.E. 2005. *Standard Fire Behavior Fuel Models: A Comprehensive Set for Use with Rothermel's Surface Fire Spread Model.* USDA FS RMRS-GTR-153, Table 7 pp.17–18 and per-model pages SH5 p.45 / SH7 p.47 (https://research.fs.usda.gov/download/treesearch/9521.pdf). Not shown in the table, from the same pages: both carry live-herb load 0.00 t ac⁻¹ and live-herb SAV 9999 ft⁻¹ (n/a), heat content 8,000 BTU lb⁻¹, depth range 4–6 ft (tabulated 6.0 ft), fine fuel load 6.5 t ac⁻¹ (SH5) and 6.9 t ac⁻¹ (SH7), and — load-bearing for §7.2.3 — **both are static, not dynamic** fuel models (fuel model type "N/A"), so no live-to-dead curing transfer occurs inside them.

**Why the substitution is defensible rather than merely convenient.** Scott & Burgan's own crosswalk from the original 13 lists both SH5 and SH7 as replacements for original fuel model 4 "Chaparral", each "For slightly lower spread rate and flame length" (shrub-type crosswalk pp.13–14). Since observed ROS was ~80 % of the FM4 prediction on the Bee Fire (§7.2.1), moving FM4 → SH5/SH7 shifts the prediction **down, toward the observed value**. SH5/SH7 also carry dead M_x = 15 % against FM4's 20 %, so they stop carrying fire at a lower dead-fuel moisture — more conservative in the marginal conditions that dominate chaparral prescribed fire — and their packing ratios (0.00206, 0.00344) fall inside the measured mature-chamise range 0.00068–0.00374 (Countryman, C.M.; Philpot, C.W. 1970. *Physical characteristics of chamise as a wildland fuel.* USDA FS Res. Paper PSW-66, Fuel Bed Porosity pp.8–9, https://research.fs.usda.gov/download/treesearch/28638.pdf), which FM4's does not by construction.

#### 7.2.3 Formulation: Rothermel + SH5/SH7 ships; Anderson et al. (2015) preferred but blocked

**Shipping formulation.** Rothermel (1972) surface spread, driven by Scott & Burgan (2005) **SH5** for mature chamise and **SH7** for senescent / high-load mixed manzanita–ceanothus stands. **Do not ship FM4.** Validation status per §0.7.3: **`substituted`** — not `calibrated` and not `validated`, because (a) SH5/SH7 are generic dry-climate shrub models standing in for a chaparral-specific model that does not exist in free form (§7.2 callout lists each candidate and the ground on which it was rejected); (b) exactly one published field validation of Rothermel in Californian chaparral exists (Weise et al. 1997, Bee Fire, n = 28 spread events on a single non-Santa-Ana fire, R² = 0.60, 4 of 28 events unfit) and one fire is not a calibration set; (c) SH5/SH7 are behaviour-fitted, not inventory-derived, by their authors' own account — "we adjusted the parameters of many draft fuel models to better coordinate fire behavior outputs of related fuel models" (Scott & Burgan 2005, development method p.3) — so they carry no measurement provenance of their own and must never be exported as measurements of chaparral.

**Four signed biases, to be surfaced in the HUD and in export metadata. They do not all point the same way and must not be stacked:**

| # | Term | Sign & magnitude | Source |
|---|---|---|---|
| 1 | Fuel-model | **+20 to +25 %** (runs fast) | Observed ROS was ~80 % of the FM4 prediction on the Bee Fire (slope 0.82); SH5/SH7 are the documented FM4 replacements "for slightly lower spread rate and flame length", so the shipped configuration lands at or a little above observed. Weise et al. 1997 pp.117–119; Scott & Burgan 2005 pp.13–14. Rests on a single fire — quote it as "the only published field validation", never as a general figure |
| 2 | Heat content | **−11 to −12 %** (runs slow) *if left uncorrected* | SH5/SH7 assume h = 8,000 BTU lb⁻¹ (18.6 MJ kg⁻¹); measured chamise fine fuel is 8,968 (foliage) and 8,995 BTU lb⁻¹ (<¼ in) = 20.9 MJ kg⁻¹, coarser classes 8,327/8,393 BTU lb⁻¹. Reaction intensity is linear in h. Countryman & Philpot 1970, PSW-66, Heat Content and Table 5 p.10 |
| 3 | Missing crown layer | **≈ −30 %** under wind (runs slow) | Measured chaparral crown-layer ROS exceeds surface-layer ROS by ~33 % (crown base height 0.6 m) to ~44 % (0.7 m) at 1 m s⁻¹ wind and is equal to it with no wind. Cobian-Iniguez et al. 2022 (below). **Partially cancels bias 1 — a downstream reader must not add them** |
| 4 | LFM insensitivity | structural, uncorrectable inside the fuel model | SH5 places 5.70/8.60 = 66 % and SH7 11.00/14.40 = 76 % of load in the dead category, against a measured mature-chamise dead fraction of 24.4 % — 2.7–3.1× too much. So only ~34 % (SH5) / ~24 % (SH7) of the load responds to live fuel moisture at all, sensitivity to RH and dead-fuel moisture is correspondingly exaggerated, and both models are static so no curing transfer occurs. Scott & Burgan 2005 Table 7 pp.17–18; Countryman & Philpot 1970 p.6 and Table 4. **This is the single largest qualitative distortion and the reason the LFM gate is applied outside the Rothermel call** |

**Take bias 2 as a correction, not as a disclosure:** set fine-fuel heat content h = **9,000 BTU lb⁻¹ (20.9 MJ kg⁻¹)** for the chaparral biome, citing Countryman & Philpot 1970 Table 5 p.10, and record the override in export metadata. It is exact, cited, and one line of code. The cause is ether extractives (waxes, oils, terpenes, fats) at 8–12 % of foliage weight and 3.4–8.8 % of woody weight, with extract heat values up to 17,378 BTU lb⁻¹ (foliage) and 24,533 BTU lb⁻¹ (wood) (ibid., Chemical Composition p.10). If the override is *not* applied, publish the −11 % instead.

**Honest limit — chaparral is a dual-layer crown fire and this formulation has no crown layer.** Chaparral fire "typically ignites in a dead surface fuel layer and transitions to an elevated live crown layer where it continues to spread", and "most fire models represent chaparral fire as surface fire, therefore omitting key behavior processes driving this fire system". In a low-velocity wind tunnel with a live chamise crown over a dead excelsior surface layer, surface ROS was 2.70 / 1.70 / 1.12 / 0.91 cm s⁻¹ against crown ROS 3.58 / 2.45 / 1.08 / 1.03 cm s⁻¹ (1 m s⁻¹ wind vs none, crown base height 0.6 vs 0.7 m), and peak heat release rose from 328 to 526 kW (CBH 0.6 m) and 243 to 503 kW (CBH 0.7 m) when wind was added (Cobian-Iniguez, J.; Aminfar, A.H.; Saha, S.; Awayan, K.; Weise, D.R.; Princevac, M. 2022. *The transition and spread of a chaparral crown fire.* Journal of Combustion 2022:5630594, doi:10.1155/2022/5630594, Abstract p.1, Introduction p.2, results and Fig. 6 pp.8–10, https://research.fs.usda.gov/download/treesearch/65059.pdf). Four consequences to publish: (i) there is no surface-to-crown transition criterion, so chaparral's sharp go/no-go behaviour is replaced by a continuous response and must be reinstated externally by the LFM gate and the wind floor below; (ii) head ROS under wind is low by roughly a third relative to a true crowning layer — bias 3 above; (iii) crown base height, the variable that measurably controls transition and heat release, has no representation in Rothermel at all; (iv) the fireline intensity handed to the canopy/firebrand modules is a *surface-layer* intensity and understates crown-layer heat release.

**Preferred formulation, blocked on an unobtainable source.** The formulation below is preferred on physical grounds but **may not be coded** — its five constants have never been read by anyone working on this spec, and the source could not be obtained. It is recorded here so it can be promoted if the paper is later obtained; it is not the shipping model. It would drop the surface+canopy split for chaparral, represent a mature stand as one 2D shrub layer with a height field mapped onto the canopy voxel column for radiation/plume purposes, and drive it with a wind-power-law shrubland closure of the Anderson et al. (2015) generic-shrubland form:

```
R = a · (WF · U10)^b · H^c · exp(−d · MC)        [R in m min⁻¹]
R = R0 + 0.2·U10·(R(U10=5) − R0)                  for U10 < 5 km/h
```
with `a` = 5.67, `d` = 0.076, `R0` = 5 m min⁻¹ (zero-wind ROS), `WF` = wind adjustment factor (0.67 open heath-shrubland, 0.35 under a woodland overstorey), `H` = mean vegetation height (m), `MC` = elevated **dead** fuel moisture (%), `U10` in km h⁻¹. **Uncertainty flag: the exponents `b` (≈0.9, stated as "just less than 1.0" and lower than Catchpole et al. 1998's 1.2) and `c` (≈0.2) were not machine-readable in the CSIRO guide PDF — read them from Anderson et al. (2015) Eq. 5 before coding. Do not ship guessed values.**

> **OPEN QUESTION (unverified):** `b` ≈ 0.9 and `c` ≈ 0.2 are still unread guesses, and two independent passes have now failed to obtain Anderson et al. (2015), so neither could confirm or refute them. `a` = 5.67, `d` = 0.076 and `R0` = 5 m min⁻¹ come from the same source and carry the same provenance risk. `b` in particular sets the wind response, which is the dominant term under Santa Ana conditions. This is why the block above is demoted to *preferred but blocked* and chaparral ships on Rothermel + SH5/SH7 instead. To close: obtain Anderson et al. (2015), *Int. J. Wildland Fire* 24:443–460, read Eq. 5 directly, and record all five constants with a page citation. No code may be written against this closure until that is done.

Model performance of the blocked closure, as published: MAE 3.5 m min⁻¹ (77 %) on experimental/prescribed fires, 9.1 m min⁻¹ (33 %) on wildfires. Note it was fitted to Australian/NZ/European/South African heath-shrubland, **not** to Californian chaparral, so even once its constants are read, applying it to chamise is an out-of-envelope extrapolation and must be labelled as such in the HUD and the export metadata.

**Required compensation 1 — the LFM gate.** Gate ignition and sustained spread on **live fuel moisture** rather than on a Rothermel live `M_x` (bias 4 above is exactly why this must sit outside the Rothermel call). Use **LFM = 79 %**, now double-sourced. Dennison & Moritz (2009) fitted piecewise regressions of cumulative area burned against chamise LFM — chamise (*Adenostoma fasciculatum*) only, 13 Los Angeles County Fire Department sites, 1981–2006, Countryman & Dean (1979) sampling methodology, interpolated to daily resolution, "large fire" = ≥1000 ha, 29 qualifying fires — and obtained breakpoints of 79.0, 77.2, 78.4 and 76.2 % for fires whose centroids lay within 5, 10, 15 and 20 km of an LFM site, i.e. "a breakpoint for LFM exists in the relatively narrow 76–79 % range"; 79 % is the maximum of these. Fits below the breakpoint were much stronger (multiple R² = 0.92–0.96) than above (0.68–0.76), and the closest interpolated LFM at which a large fire occurred ranged from a maximum of 78.5 % down to a minimum of 53.2 %. [Dennison, P.E.; Moritz, M.A. 2009. *Critical live fuel moisture in chaparral ecosystems.* Int. J. Wildland Fire 18(8):1021–1027, doi:10.1071/WF08055, Abstract p.1021, Methods p.1023, Fig. 2 and Results p.1024, Discussion p.1026, https://sbfiresafecouncil.org/wp-content/uploads/2020/05/dennison_moritz_ijwf_2009-1.pdf] Independently, Drucker et al. (2023) optimised the LFMC threshold per bioregion against MODIS burned area over 2000–2021 and obtained **South Coast = 79 %** exactly, alongside Bay Area 70 %, Central Coast 82 %, Sierra Nevada 88 %, Klamath 92 %, Modoc 98 % [Drucker, J.R.; Farguell, A.; Clements, C.B.; Kochanski, A.K. 2023. *A live fuel moisture climatology in California.* Frontiers in Forests and Global Change 6:1203536, doi:10.3389/ffgc.2023.1203536, Table 4 p.8, §3.3 p.9, open access]. Implement as a smooth sigmoid multiplier on R centred at 79 % with ~10 % width, plus a hard no-go below the dead-fuel ignition threshold. **The ~10 % width is a modelling choice, not a published confidence interval** — Dennison & Moritz explicitly decline to bracket the threshold: "The uncertainty bracketing the 79 % threshold could not be [estimated] … the 79 % threshold should still be a useful guideline." **Do not use 79 % outside southern California**; the free per-region optima span 70–98 %.

**Required compensation 2 — an explicit wind go/no-go floor.** Rothermel has no ignition threshold, so the discontinuity must be imposed externally. Chaparral does not burn well below roughly **3.1–3.6 m s⁻¹** (7–8 mph): "Wind is a limiting factor; a velocity of at least 7 to 8 m.p.h. is needed for fuel to burn well", with a linear no-spotting response of ~4 in min⁻¹ (20 ft hr⁻¹) of ROS per additional mph at 20 ft (Lindenmuth & Davis 1973, RM-101, Wind Velocity findings p.7). Wind was also the single most important variable for spread success across the 240 laboratory chaparral fires of §7.2.1.

**Mature stand parameters — measured values, not literature composites:**

| Property | Chamise (*Adenostoma fasciculatum*) | Manzanita / Ceanothus mixed |
|---|---|---|
| Total above-ground load | mean **22 t ha⁻¹** (0.45 lb ft⁻², "about 10 tons per acre"), range 8.8–54.7 t ha⁻¹ (0.18–1.12 lb ft⁻²), 16 mature shrubs, southern California [C&P70 pp.6–7] | unverified — see open question below |
| Dead fraction | **0.244** by weight, range 0.051–0.377; >⅓ of the weight of the two smallest size classes is dead, i.e. dead fuel is concentrated in the fine classes [C&P70 p.6, Table 4] | unverified — see open question below |
| Fuel particle density | 46.7 lb ft⁻³ = **748 kg m⁻³** [C&P70 p.7] | assumed identical; not separately measured |
| Whole-shrub SAV | mean 690 ft⁻¹ = **2,264 m⁻¹**, range 385–1,334 ft⁻¹ = 1,263–4,377 m⁻¹ [C&P70 pp.7–8] | unverified |
| Packing ratio, stand | **0.00068–0.00374** (beds occupy 0.07–0.37 % of their volume) [C&P70 pp.8–9] | unverified |
| Bulk density, **stand-level** (β·ρ_p) | **0.51–2.80 kg m⁻³**, derived from the two rows above [C&P70 pp.7–9] | unverified |
| Bulk density, **individual crown** | **2.43–7.63 kg m⁻³**, packing ratio 0.0034–0.011, 4-yr shrubs, 5 chamise + 5 manzanita [Li17 p.61, Table 1] | same source and same range (manzanita included in that sample) |
| Live fuel moisture, annual cycle | **58–60 % (Sep–Oct min) → 105–125 % (April max)**, 2000–2021 climatology across the three chamise-dominated bioregions [Dru23 §3.1 pp.5–6] | **UNCONFIRMED for southern California** — see open question below |
| Ether extractive content | 8–12 % of foliage weight, 3.4–8.8 % of woody weight; measured heat content foliage 8,968, <¼ in 8,995, ¼–½ in 8,327, ½–1 in 8,393 BTU lb⁻¹ = 20.9 / 20.9 / 19.4 / 19.5 MJ kg⁻¹ [C&P70 p.10, Table 5] | unverified |

**Bulk density is two different quantities and the spec means both, separately.** Stand-level bulk density (0.51–2.80 kg m⁻³) is packing ratio × particle density over the fuel bed; individual-crown bulk density (2.43–7.63 kg m⁻³) is measured over a single shrub crown. They differ by up to an order of magnitude and the crown-fire literature uses the second. Any field, HUD label or export column carrying "bulk density" for chaparral must state which.

Sources for the table: **[C&P70]** Countryman, C.M.; Philpot, C.W. 1970. *Physical characteristics of chamise as a wildland fuel.* USDA FS Res. Paper PSW-66 (https://research.fs.usda.gov/download/treesearch/28638.pdf). **[Li17]** Li, J.; Mahalingam, S.; Weise, D.R. 2017. *Experimental investigation of fire propagation in single live shrubs.* Int. J. Wildland Fire 26(1):58–70, doi:10.1071/WF16042 (https://research.fs.usda.gov/download/treesearch/53603.pdf); underlying data free at doi:10.2737/RDS-2016-0031. **[Dru23]** Drucker et al. 2023, Front. For. Glob. Change 6:1203536, Table 1 p.3 for regions, species, n and dates.

> **OPEN QUESTION (unverified):** The manzanita/ceanothus column is not measured for southern California. The previous entries (loads 25–60 t ha⁻¹, dead fraction 0.10–0.35, LFM 60–70 % → 150 %, height 2–4 m) were literature composites without a traceable source and have been removed rather than left standing. The only free measured manzanita LFM climatology is *Arctostaphylos manzanita* in the **Klamath and Sierra Nevada** bioregions — not SoCal chaparral — giving maxima 128–138 % (May in the Sierra Nevada, June in the Klamath) and minima **83–84 %** in Sep–Oct (Drucker et al. 2023 §3.1 pp.5–6), i.e. a minimum ~20 points above the removed figure. No free species-specific ceanothus climatology was obtained. Also unverified for both columns: available fine fuel (<6 mm) load and stand height. **Cheap to close:** Varga, K.; Jones, C. 2026. *A 32-year species-specific live fuel moisture content dataset for southern California chaparral.* Scientific Data 13(1):438, doi:10.1038/s41597-026-06794-3, PMCID PMC13009464, open access — it covers chamise, old-growth chamise, black sage and bigpod ceanothus; a fetch attempt hit a PMC CAPTCHA, so retrieve the PDF from nature.com or the PMC OA bulk service. Until then the mixed-shrub column must be driven by SH7 alone and labelled unverified in the HUD and export metadata.

**Validation data:** the Bee Fire reconstruction (Weise et al. 1997, 28 spread events, observed 1–89 m min⁻¹) — the only field-scale validation of Rothermel in Californian chaparral and the source of the +25 % fuel-model bias; the Weise et al. (2016) laboratory live-fuel bed dataset (240 fires), usable for classification and moisture-response behaviour but **explicitly not for field-scale spread rates**; the Cobian-Iniguez et al. (2022) wind-tunnel surface-vs-crown ROS pairs for the missing-crown-layer bias; Li et al. (2017) / RDS-2016-0031 for single-shrub bulk density and packing ratio; Drucker et al. (2023) 2000–2021 California LFMC climatology and per-bioregion burned-area thresholds, plus the Varga & Jones (2026) 32-year species-specific southern California archive once obtained, for the moisture cycle; the USDA FS chaparral prescribed-fire ROS dataset (Weise et al. 2010, northern California); Peterson et al. (2009) HFire/FARSITE landscape reconstructions of the Day, Calabasas and Simi fires, noting suppression is unmodelled in both the observations and the simulations; documented Santa Ana wind events (Cedar 2003, Thomas 2017) for order-of-magnitude head-fire ROS (>2 km h⁻¹).

---

### 7.3 UK mixed field & forest

No published UK fuel model set exists. We build one and say so.

#### 7.3.1 Canadian FWI System (Van Wagner 1987; Van Wagner & Pickett 1985)

This is the correct moisture backbone for the UK: the **Met Office Fire Severity Index (MOFSI)**, used operationally for CROW Act access restrictions in England & Wales, is built on the FWI component of the Canadian system (de Jong et al. 2016, NHESS 16:1217). We implement the full daily system; all inputs are noon-LST `T` (°C), `H` (RH %), `W` (10-m wind, km h⁻¹), `ro` (24-h rain, mm).

**FFMC** (fine fuel moisture code, 0–101):
```
m_o = 147.2·(101 − F_o)/(59.5 + F_o)
rain (ro > 0.5):  r_f = ro − 0.5
  m_r = m_o + 42.5·r_f·exp(−100/(251 − m_o))·(1 − exp(−6.93/r_f))
  if m_o > 150:  m_r += 0.0015·(m_o − 150)²·√r_f        ;  cap m_r ≤ 250
E_d = 0.942·H^0.679 + 11·exp((H−100)/10) + 0.18·(21.1 − T)·(1 − exp(−0.115·H))
E_w = 0.618·H^0.753 + 10·exp((H−100)/10) + 0.18·(21.1 − T)·(1 − exp(−0.115·H))
if m > E_d:  k_o = 0.424·[1 − (H/100)^1.7] + 0.0694·√W·[1 − (H/100)^8]
             k_d = k_o·0.581·exp(0.0365·T);   m = E_d + (m − E_d)·10^(−k_d)
if m < E_w:  k_l = 0.424·[1 − ((100−H)/100)^1.7] + 0.0694·√W·[1 − ((100−H)/100)^8]
             k_w = k_l·0.581·exp(0.0365·T);   m = E_w − (E_w − m)·10^(−k_w)
FFMC = 59.5·(250 − m)/(147.2 + m)
```
`m` = litter moisture (% oven-dry), `F_o` = previous FFMC.

**DMC** (duff moisture code, open-ended):
```
if T < −1.1: T = −1.1
K = 1.894·(T + 1.1)·(100 − H)·L_e·10⁻⁶                    [log drying rate, d⁻¹]
rain (ro > 1.5): r_e = 0.92·ro − 1.27
  M_o = 20 + exp(5.6348 − P_o/43.43)
  b = 100/(0.5 + 0.3·P_o)          for P_o ≤ 33
  b = 14 − 1.3·ln(P_o)             for 33 < P_o ≤ 65
  b = 6.2·ln(P_o) − 17.2           for P_o > 65
  M_r = M_o + 1000·r_e/(48.77 + b·r_e)
  P_r = 244.72 − 43.43·ln(M_r − 20)
DMC = (P_r or P_o) + 100·K
```
`P_o` = previous DMC, `M` = duff moisture (%), `L_e` = effective day length (h).

**DC** (drought code):
```
if T < −2.8: T = −2.8
V = 0.36·(T + 2.8) + L_f          ;  V ≥ 0                 [potential evapotranspiration, 0.1 mm d⁻¹]
rain (ro > 2.8): r_d = 0.83·ro − 1.27
  Q_o = 800·exp(−D_o/400);  Q_r = Q_o + 3.937·r_d;  D_r = 400·ln(800/Q_r)
DC = (D_r or D_o) + 0.5·V
```

**ISI, BUI, FWI:**
```
f(W) = exp(0.05039·W)
f(F) = 91.9·exp(−0.1386·m)·(1 + m^5.31/4.93×10⁷)
ISI  = 0.208·f(W)·f(F)
BUI  = 0.8·DMC·DC/(DMC + 0.4·DC)                                   , DMC ≤ 0.4·DC
     = DMC − (1 − 0.8·DC/(DMC + 0.4·DC))·[0.92 + (0.0114·DMC)^1.7] , DMC > 0.4·DC
f(D) = 0.626·BUI^0.809 + 2                    , BUI ≤ 80
     = 1000/(25 + 108.64·exp(−0.023·BUI))     , BUI > 80
B    = 0.1·ISI·f(D)
FWI  = exp(2.72·(0.434·ln B)^0.647)  if B > 1 ; else FWI = B
DSR  = 0.0272·FWI^1.77
```

Day-length factors are tabulated for ~46°N: `L_e` = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0] and `L_f` = [−1.6, −1.6, −1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, −1.6, −1.6] (Jan→Dec). **The UK spans 50–59°N, outside that calibration.** Use the continuous latitude/day-of-year day-length formulation of Dowdy et al. (2009, CAWCR TR-010 Appendix A) instead of the table, and note in the export metadata that FWI *class thresholds* must be percentile-recalibrated for the UK (de Jong et al. 2016 use a percentile calibration; FFMC, ISI and FWI carry the most skill for GB fire activity, with the skill varying by season and land cover).

#### 7.3.2 UK fuel carriers

Loads in kg m⁻² (×10 for t ha⁻¹). Calluna values are from the northern-European generalised fuel models of Davies-lab work (iForest 17:109-119, 2024) and the Scottish FDRS report (Hutton 2021/22); SAV values are **assigned, not measured** — no UK species has a published SAV inventory — and are the largest single source of uncertainty in this fuel set.

| Fuel | Load: fine dead | Load: live | Moss/litter | Depth (m) | SAV (m⁻¹, assigned) | Spread threshold FMC |
|---|---|---|---|---|---|---|
| Calluna, pioneer (0–6 yr) | 0.03–0.08 | 0.10–0.30 | 0.1–0.4 | 0.10–0.20 | 5000–7000 | dead 26–33 % |
| Calluna, early building (7–10 yr) | 0.141 | 0.624 | ~0.5 | 0.187 | 5000–7000 | dead 26–33 % |
| Calluna, tall building (10–14 yr) | 0.212 | 0.259 + stems | 0.761 | 0.381 | 4500–6500 | dead 26–33 % |
| Calluna, mature (14–20 yr) | 0.220 | 1.214 | 1.019 | 0.557 | 4000–6000 | dead 26–33 % |
| Calluna, degenerate (>21 yr) | 0.25–0.45 | 1.0–1.8 (gappy) | 1.0–1.5 | 0.5–0.8 | 4000–6000 | dead 26–33 % |
| Bracken, cured litter (spring/autumn) | 0.30–1.20 | ~0 | 0.1–0.3 | 0.10–0.30 | 6000–9000 | <20 % |
| Bracken, green fronds (Jun–Sep) | 0.05–0.15 | 0.4–1.0 | — | 0.8–1.8 | 6000–9000 | live 200–300 % → non-carrying |
| Gorse (*Ulex europaeus*), mature | 0.4–1.2 (elevated dead) | 1.5–4.0 | 0.2–0.6 | 1.5–4.0 | 4000–6000 | **ignition <36 %, spread <19 %** |
| Molinia, cured (Dec–Apr) | 0.50–1.20 | ~0 | 0.1–0.3 | 0.3–0.6 | 8000–11000 | <25 % |
| Improved pasture, grazed | 0.02–0.10 | 0.15–0.45 | — | 0.05–0.15 | 8000–11000 | live 150–250 % |
| Cereal stubble | 0.20–0.40 | ~0 | — | 0.15–0.35 | 8000–12000 | <15 % |
| Standing cereal, ripe | 0.30–0.60 | 0.2–0.4 | — | 0.8–1.2 | 8000–12000 | <20 % |
| Broadleaf litter (oak/beech/ash) | 0.30–0.80 | ~0 | 0.1–0.4 | 0.03–0.08 | 4000–6000 | <18 % |

Notes and honest limits:
- **Calluna age class matters more than anything else.** Total heathland fuel loads span 0.23–6.27 kg m⁻² across the growth cycle; composition averages live woody 40 ± 21 %, moss/litter 45 ± 19 %, herbaceous 7 ± 10 %, dead 8 ± 7 %. Scottish moorland means: combined fine ~0.93, coarse ~0.86, moss/litter ~0.84 kg m⁻² (Hutton 2021). Include the moss/litter layer — models omitting it under-predict badly (R² = 0.50 with it included, over 27 experimental burns).
- **Measured spread thresholds** (Hutton 2021) replace a fitted `M_x`: fine dead 26–33 %, fine green 47–65 %, coarse 54–60 %, moss 84–135 %. Corroborated by Davies & Legg: line ignitions fail above ~70 % and develop rapidly below ~60 % live FMC.
- **Gorse is the UK crown-fire analogue.** It carries fire in the *elevated dead* layer independently of surface fuels; ignition fails above 36 % elevated dead FMC and only spreads below 19 % (Pearce/Anderson NZ gorse experiments, same species). Route gorse through the chaparral configuration of §7.2.3 — Rothermel with SH7 plus the external moisture gate — not through a UK grass/heath closure. Note that this inherits the chaparral biases of §7.2.3 (no crown layer, dead-fraction-inflated fuel model) *and* substitutes a Californian shrub fuel model for a UK species with no measured SAV, so gorse is `substituted` on top of `substituted`; label it accordingly wherever it exports numbers. The single-crowning-layer closure it previously pointed at is blocked on an unobtainable source and may not be coded.
- **Bracken is a switch, not a curve.** Cured frond litter in March–April and October–November is among the most flammable UK fuels; green summer fronds at 200–300 % FMC are effectively fireproof. Model with a phenology state variable, not with FWI-driven moisture alone.
- **Molinia loads (0.5–1.2 kg m⁻²) are 1.7–4× the Canadian FBP reference fine-fuel load of 0.30 kg m⁻²**, which is one concrete reason the unmodified FWI/FBP mapping mis-ranks UK grass-moor fires.

#### 7.3.3 Spatial structure

The UK's fire behaviour is dominated by a fine-grained anthropogenic mosaic, so the 0.5 m surface grid is essential here, not a luxury (a 2 m hedgerow is 4 cells wide; at 2 m resolution it would be unrepresentable).

- **Hedgerows**: linear fuel corridors, 1.5–4 m tall, hawthorn/blackthorn/hazel with a dense dead interior — treat as a rasterised line feature carrying the gorse/shrub closure at 3–8 cells width, with its own canopy-voxel column. Dual role: they carry fire between otherwise isolated fields *and* act as porous windbreaks. Apply a wind-reduction factor of 0.3–0.6 within ~5 h (h = hedge height) leeward, using an optical-porosity parameter (0.2–0.5); do not model them as solid.
- **Dry stone walls** (0.9–1.5 m): zero fuel, 1–3 cells wide — true fuel breaks that also generate a leeward recirculation eddy which can *pull* embers down. Represent as fuel-load = 0 plus a local wind perturbation, not as a hard barrier.
- **Ditches, farm tracks, metalled lanes**: 2–8 cells of zero fuel. Their effectiveness is a function of flame length vs gap width, so let the physics decide rather than hard-coding "breaks stop fire".
- **Enclosed field mosaic**: typical English/Welsh fields are 2–10 ha, so a 1 km² domain contains 10–50 fields with differing fuel state (grazed pasture, standing crop, stubble). This mosaic — not fuel moisture — is what usually bounds UK fire size (99 % of GB fires affect <1 ha; Gazzard et al. 2016).
- **Broadleaf woodland (oak/ash/beech/birch)**: in leaf, foliar moisture 100–200 % and closure >70 % give a wind adjustment factor of 0.10–0.15 and near-permanent non-carrying status — the model should *suppress* fire here, which is correct and worth showing. Before leaf-out (roughly Mar–early May), leaf litter is exposed to sun and wind and readily carries a fast, low-intensity surface fire. Implement as a leaf-phenology field driving (a) live foliar moisture, (b) litter shading/wind exposure factors, (c) crown-base fuel availability. This single switch produces the correct, and initially counter-intuitive, seasonal reversal.

#### 7.3.4 The UK fire-season paradox

UK fire activity is genuinely bimodal: a **spring peak (Mar–Apr)** and a **summer peak (Jul–Sep)**. England's FRS attended ~156 wildfires per day in April and ~142 per day in July on 2010–2018 averages — two comparable peaks with completely different physics:

- **Spring peak**: dead, fully cured, unshaded fuel from the previous season (Molinia litter, bracken litter, dormant Calluna dead fraction, broadleaf litter before leaf-out), low live-fuel load, long day length, low humidity in continental easterlies. **FFMC and ISI are high while DMC and DC are near their overwintered minima.** BUI is low, so **FWI itself understates spring danger** — this is the crux. A model driven by FWI alone cannot reproduce the spring peak.
- **Summer peak**: drought-driven. DC and BUI accumulate, live fuels and deep organic layers dry, peat and duff become available, fires become deeper-burning and longer-lived (Saddleworth Moor and Winter Hill, 2018; the 19 July 2022 40 °C day).

**Our formulation:** danger = FWI system **×** a phenology/curing multiplier. Carry an explicit per-fuel `cure_fraction ∈ [0,1]` and `live_fraction` driven by growing-degree-days and day length, and drive the surface closure from (FFMC → dead fine moisture, ISI → wind-moisture spread term, cure_fraction → available fine load, BUI/DC → depth of burn and residence time in organic layers). This reproduces both peaks with one parameter set. de Jong et al. (2016) support the weighting: FFMC, ISI and FWI have the greatest predictive skill for GB fire activity, with performance varying by season and land cover.

**Validation data:** de Jong et al. (2016) — FWI vs. 1980s–2010s GB fire records, including the finding that on 2 May 2011 half of all wildfires occurred where FWI exceeded its 99th percentile; the Scottish FDRS experimental burn series (Hutton 2021: 10 field burns, ROS 0.06–0.24 m s⁻¹ = 3.6–14.4 m min⁻¹, shrub loads 0.79–3.17 kg m⁻², total 1.23–4.42 kg m⁻², Byram intensities 1400–14 700 kW m⁻¹); the 27 northern-European experimental heathland burns behind the iForest (2024) fuel models; the UK national temperate fuel-moisture database (Sci. Data 11, 2024) for FMC time series of heather, gorse, bracken and moor grass; EFFIS burned-area products and Home Office incident statistics for seasonality; case reconstructions of Saddleworth Moor 2018, Winter Hill 2018, Wareham Forest 2020 and the July 2022 events. There is **no UK experimental dataset for hedgerow, stubble or broadleaf-litter fire spread** — those three fuel models are unvalidated extrapolations and must be labelled as such wherever the simulator exports numbers.
