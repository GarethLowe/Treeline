## 4. Surface Fire Spread Physics

The surface layer is the pacing element of the whole simulation: it sets the fireline intensity that the canopy module uses for crown-initiation tests, it sources the buoyant plume, and it defines the flaming band the renderer draws. This section specifies it completely.

### 4.1 Unit convention

Rothermel's coefficients are dimensional fits in the **BTU-lb-ft-min** system. Converting them to SI changes ~20 constants and every published cross-check breaks. **Decision: the solver stores state in SI, but the Rothermel kernel converts to English units on entry and back on exit.** This is the same choice WRF-Fire makes (Mandel et al. 2011) and it costs ~8 multiplies per cell.

| Quantity | SI (storage) | English (kernel) | Factor |
|---|---|---|---|
| Fuel load `w₀` | kg m⁻² | lb ft⁻² | ×4.88243 (English→SI); ×0.204816 (SI→English) |
| Load from tables | t ac⁻¹ | lb ft⁻² | ×0.0459137 |
| SAV `σ` | m⁻¹ | ft⁻¹ | ×3.28084 (ft⁻¹→m⁻¹) |
| Depth `δ` | m | ft | ×0.3048 |
| Wind `U` | m s⁻¹ | ft min⁻¹ | ×0.00508 |
| ROS `R` | m s⁻¹ | ft min⁻¹ | ×0.00508 |
| Heat content `h` | kJ kg⁻¹ | BTU lb⁻¹ | ×2.326 |
| Reaction intensity `I_R` | kW m⁻² | BTU ft⁻² min⁻¹ | ×0.189275 |
| Particle density `ρ_p` | 512.6 kg m⁻³ | 32 lb ft⁻³ | — |

### 4.2 The Rothermel (1972) formulation as implemented

Final spread rate, in the direction of the combined wind/slope vector:

```
R = I_R · ξ · (1 + φ_w + φ_s) / (ρ_b · ε · Q_ig)      [ft min⁻¹]
```

**Heat source — reaction intensity** (Rothermel 1972 Eq. 27):

```
I_R = Γ′ · w_n · h · η_M · η_s                        [BTU ft⁻² min⁻¹]
```

- `Γ′` — optimum reaction velocity [min⁻¹]
- `w_n` — net (mineral-free) fuel load [lb ft⁻²]
- `h` — low heat of combustion [BTU lb⁻¹], 8000 for all Scott & Burgan models except GR6 (9000)
- `η_M`, `η_s` — moisture and mineral damping [–]

```
Γ′      = Γ′_max · (β/β_op)^A · exp[A·(1 − β/β_op)]
Γ′_max  = σ^1.5 / (495 + 0.0594·σ^1.5)                [min⁻¹]      (Eq. 36)
A       = 133 · σ^−0.7913                                          (Albini 1976 refit
                                                        of Rothermel Eq. 39,
                                                        A = (4.774·σ^0.1 − 7.27)⁻¹)
β_op    = 3.348 · σ^−0.8189                                        (Eq. 37)
β       = ρ_b / ρ_p ,   ρ_b = w₀ / δ                  [–], [lb ft⁻³]
w_n     = w₀ · (1 − S_T),   S_T = 0.0555                           (Rothermel 1972, Eq. 24)
η_s     = 0.174 · S_e^−0.19,  S_e = 0.0100  ⇒  η_s = 0.4174, capped at 1  (Eq. 30)
η_M     = 1 − 2.59·r_M + 5.11·r_M² − 3.52·r_M³,  r_M = M_f/M_x ∈ [0,1]   (Eq. 29)
```

`σ` = characteristic surface-area-to-volume ratio [ft⁻¹]; `β` = packing ratio (fuel volume fraction); `M_f` = fuel moisture, oven-dry-mass fraction; `M_x` = moisture of extinction. `η_M` is clamped to `[0,1]`; `r_M ≥ 1` gives `η_M = 0` and the cell cannot burn.

> **NORMATIVE — moisture convention.** The review found this section stating moisture two
> ways: `M_f` and `M_x` are declared here as oven-dry-mass *fractions*, but the §4.3 fuel
> table tabulates `M_x` in *percent* (15, 20, 25, 35), the §4.2 worked check quotes "6%"
> and "60%", §4.3's dynamic-transfer equation `T = clamp(1.333 − 0.0111·M_herb%, 0, 1)` is
> explicitly in percent, and §4.4's Eq. 88 mixes a convention-free ratio with an additive
> `− 0.226` and an `M_x,dead` floor that are correct on only one convention. A single stray
> ×100 anywhere in that chain either zeroes `η_M` (nothing burns) or drives `r_M → 0`
> (everything burns), and the §4.2 acceptance test cannot catch it because it exercises one
> fuel model at one moisture.
>
> **Resolved by decision, not by research:**
>
> 1. **Moisture is a fraction everywhere inside the simulation.** `M_f`, `M_x`, `M_herb`,
>    live and dead moisture, and every field in the per-cell state are oven-dry-mass
>    fractions in `[0, ~4]`. Percent appears in exactly two places: the fuel-model table
>    source data, and the HUD/export presentation layer.
> 2. **Conversion happens at those two boundaries only**, in the table parser and the
>    formatter — never inside a kernel, never in a shader.
> 3. **The convention is enforced by the type system, not by discipline.** `src/contracts/`
>    declares `MoistureFraction` and `MoisturePercent` as distinct branded types. Passing
>    one where the other is expected is a compile error, so the failure mode becomes a
>    build break rather than a plausible-looking fire that spreads at the wrong rate.
> 4. **Equations in this document are written in fractions.** Where a published equation is
>    stated in percent — the `1.333 − 0.0111·M_herb%` transfer above, and the Vesta and FWI
>    equations in §60 — it is marked inline and the fraction form given alongside.
>
> Legacy percent-form constants are retained in the text so they stay checkable against the
> source papers; only the implementation is normatively fraction-based.

**Propagating flux ratio** (Eq. 42):

```
ξ = exp[(0.792 + 0.681·√σ)·(β + 0.1)] / (192 + 0.2595·σ)     [–]
```

**Wind factor** (Eqs. 47–50):

```
φ_w = C · U^B · (β/β_op)^−E
C   = 7.47 · exp(−0.133·σ^0.55)
B   = 0.02526 · σ^0.54
E   = 0.715 · exp(−3.59×10⁻⁴·σ)
```

`U` = **midflame** wind speed [ft min⁻¹] (§4.5). `C`, `B`, `E` are dimensionless fits with `σ` in ft⁻¹.

**Slope factor** (Eq. 51):

```
φ_s = 5.275 · β^−0.3 · tan²φ_slope        [–],  φ_s = 0 for downslope
```

**Heat sink**:

```
ε    = exp(−138/σ)                        [–]   effective heating number   (Eq. 14)
Q_ig = 250 + 1116·M_f                     [BTU lb⁻¹]                       (Eq. 12)
```

**Worked check (GR2, scenario D2L2: dead 1-h `M_f` = 6%, live herbaceous `M_f` = 60% ⇒ `T` = 0.667, so `w_dead,1h` = 0.10 + 0.667×1.00 = 0.767 t ac⁻¹ and `w_live,herb` = 0.333 t ac⁻¹; U = 5 mi h⁻¹ = 440 ft min⁻¹, 0% slope).** Weighted `σ ≈ 1820 ft⁻¹`, `ρ_b = 0.0505 lb ft⁻³`, `β = 0.001578`, `β_op = 0.007164`, `β/β_op = 0.220`; `C = 1.944×10⁻³`, `B = 1.454`, `E = 0.372`, `φ_w ≈ 23.8`; live `M_x` (Eq. 88) ≈ 4.7; `I_R ≈ 1.15×10³ BTU ft⁻² min⁻¹`. Resulting `R ≈ 38 ft min⁻¹ = 11.7 m min⁻¹ ≈ 35 ch h⁻¹`, matching the Scott & Burgan GR2 D2L2 value. (For reference, the *fully cured* GR2 case at the same wind gives `R ≈ 18 m min⁻¹ ≈ 54 ch h⁻¹`.) **This is the acceptance test for the kernel.**

### 4.3 Fuel model parameterisation

Scott & Burgan (2005, RMRS-GTR-153) and Anderson (1982, the "13") use an *identical parameter schema* — five load classes, three SAV values, depth, `M_x`, `h`. So there is no "mapping" problem: both are instances of one struct, and Anderson's 13 are loaded as extra rows in the same table. Constants shared across the whole S&B set: 10-h SAV = 109 ft⁻¹, 100-h SAV = 30 ft⁻¹, `S_T` = 0.0555, `S_e` = 0.0100, `ρ_p` = 32 lb ft⁻³.

| Code | 1-h | 10-h | 100-h | Herb | Woody | σ₁ₕ | σ_herb | σ_wood | δ | M_x | Type | Biome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | *t ac⁻¹* | | | | | *ft⁻¹* | | | *ft* | *%* | | |
| GR1 | 0.10 | 0 | 0 | 0.30 | 0 | 2200 | 2000 | — | 0.4 | 15 | dyn | Grass, UK pasture |
| GR2 | 0.10 | 0 | 0 | 1.00 | 0 | 2000 | 1800 | — | 1.0 | 15 | dyn | Grass, UK pasture |
| GR4 | 0.25 | 0 | 0 | 1.90 | 0 | 2000 | 1800 | — | 2.0 | 15 | dyn | Grass/savanna |
| GS1 | 0.20 | 0 | 0 | 0.50 | 0.65 | 2000 | 1800 | 1800 | 0.9 | 15 | dyn | Savanna, chaparral edge |
| SH2 | 1.35 | 2.40 | 0.75 | 0 | 3.85 | 2000 | — | 1600 | 1.0 | 15 | static | Chaparral (young) |
| SH5 | 3.60 | 2.10 | 0 | 0 | 2.90 | 750 | — | 1600 | 6.0 | 15 | static | Chaparral (mature) |
| SH7 | 3.50 | 5.30 | 2.20 | 0 | 3.40 | 750 | — | 1600 | 6.0 | 15 | static | Chaparral, eucalypt understorey, gorse |
| TU1 | 0.20 | 0.90 | 1.50 | 0.20 | 0.90 | 2000 | 1800 | 1600 | 0.6 | 20 | dyn | Conifer w/ understorey |
| TU5 | 4.00 | 4.00 | 3.00 | 0 | 3.00 | 1500 | — | 750 | 1.0 | 25 | static | Dense conifer understorey |
| TL2 | 1.40 | 2.30 | 2.20 | 0 | 0 | 2000 | — | — | 0.2 | 25 | static | Broadleaf litter (UK) |
| TL5 | 1.15 | 2.50 | 4.40 | 0 | 0 | 2000 | — | 1600 | 0.6 | 25 | static | Conifer litter |
| TL8 | 5.80 | 1.40 | 1.10 | 0 | 0 | 1800 | — | — | 0.3 | 35 | static | Long-needle ponderosa litter |
| SB1 | 1.50 | 3.00 | 11.00 | 0 | 0 | 2000 | — | — | 1.0 | 25 | static | Slash, blowdown |

Anderson-13 correspondences for authoring convenience: FM1↔GR1/GR2, FM2↔GS1, FM3↔GR4/GR7, FM4↔SH5/SH7, FM5↔SH2, FM8↔TL2/TL3, FM9↔TL8/TL9, FM10↔TU5, FM11–13↔SB1–SB4.

**Dynamic load transfer.** For dynamic models, live herbaceous load migrates to a *dead* 1-h class as the grass cures (Scott & Burgan 2005):

```
T = clamp(1.333 − 0.0111·M_herb%, 0, 1)
w_dead,1h += T·w_herb ;  w_live,herb ← (1−T)·w_herb ;  σ of transferred load = σ_herb
```

`M_herb = 30%` ⇒ fully cured; `M_herb = 120%` ⇒ fully green; `M_herb = 60%` ⇒ T = 0.667, matching the "two-thirds cured" D2L2 scenario in the source document.

**Per-cell state (2048², r/w each sim tick):** `fuelModelId:u8`, `flags:u8`, remaining mass fraction per class (5×`unorm8`), dead moisture 1-h/10-h/100-h (3×`unorm8`), live herb/woody moisture (2×`unorm8`), plus separate `r32float` textures for `φ` and `t_ign`, and an `rgba16float` cache of `(R_head, LB, headingX, headingY)`. Total ≈ **113 MB** — comfortable inside 8 GB alongside the canopy voxels and froxel buffers.

> **OPEN QUESTION (unverified):** the 113 MB figure has not been re-derived and does not obviously reconcile with the field list above it. Counting the listed fields at 2048² = 4,194,304 cells gives 12 B of `u8` state (1 + 1 + 5 + 3 + 2) + 8 B for the two `r32float` textures + 8 B for the `rgba16float` cache = 28 B/cell = 117.4 MB (112 MiB) — and it is not stated whether "113 MB" means decimal MB or MiB, nor whether any of these fields need ping-pong (§4.6's `φ` almost certainly does, which adds 16.8 MB and is not in the count). Re-derive this against the actual struct layout, state the MB/MiB convention explicitly, and settle the ping-pong question before this line is used as an input to the VRAM budget, because a surface-state figure that is low by one ping-pong buffer propagates straight into the total.

**Critical optimisation.** Every σ-dependent coefficient (`β_op`, `A`, `Γ′_max`, `ξ`, `C`, `B`, `E`, `ε`, `η_s`, `t_r`) depends only on the *fuel model*, not the cell. Precompute them into a uniform array of ~53 entries. For dynamic models σ shifts with curing, so store a 16-entry LUT over cure fraction and lerp. Rothermel then factorises as

```
R = R₀(fuel, moisture) · (1 + φ_w + φ_s)
```

`R₀` is re-evaluated only on the moisture tick (1 Hz sim time); `φ_w`/`φ_s` are evaluated every substep from the live gusty wind field. Per-cell per-substep cost collapses to ~20 FLOP + 2 `pow` calls.

> **OPEN QUESTION (unverified):** this framing counts the wrong bound. ~20 FLOP × 4.19 M cells is ~84 MFLOP per substep — nanoseconds of ALU on a part rated near 20 TFLOP/s — so arithmetic is not what sets the cost of this pass; memory traffic is. The pass must read the per-cell fuel/moisture state and the wind field and write the ROS cache, and §4.8 separately budgets the level-set advance at ~134 MB per substep on bandwidth grounds, i.e. the binding constraint there is roughly four orders of magnitude tighter than the FLOP argument implies. The two `pow` calls are also not free on a transcendental-limited SFU path and may dominate the ALU term. Re-state this optimisation's payoff in bytes read+written per cell per substep, and confirm by profiling that the precomputed-coefficient array actually lands in constant/uniform cache rather than adding a dependent load, before the ~20 FLOP number is quoted anywhere as a performance budget.

### 4.4 Dead/live weighting and live moisture of extinction

Fuel classes are aggregated by *surface area* within a category and by category surface area between them (Rothermel 1972; Albini 1976). For class `j` in category `i` (i ∈ {dead, live}):

```
A_ij = σ_ij · w₀,ij / ρ_p        [ft² ft⁻²]   surface area per unit ground area
f_ij = A_ij / Σ_j A_ij            (within-category weight)
f_i  = (Σ_j A_ij) / Σ_i Σ_j A_ij  (category weight)
σ_i  = Σ_j f_ij·σ_ij ;   σ = Σ_i f_i·σ_i
```

Net load `w_n` uses Albini's **size-class** weights `g_ij` instead — `f_ij` summed into six σ bins (>1200; 192–1200; 96–192; 48–96; 16–48; <16 ft⁻¹) and assigned wholly to the largest class present in each bin. Skipping this and using `f_ij` for load is the single most common reimplementation bug; it inflates `I_R` in multi-class beds by 10–30%.

**Live moisture of extinction** (Rothermel 1972 Eq. 88). `M_x` for live fuel is not tabulated; it is derived from how dry the fine dead fuel is:

```
W   = Σ_dead w₀,ij·exp(−138/σ_ij) / Σ_live w₀,ij·exp(−500/σ_ij)
M′_f = Σ_dead w₀,ij·exp(−138/σ_ij)·M_f,ij / Σ_dead w₀,ij·exp(−138/σ_ij)
M_x,live = max[ 2.9·W·(1 − M′_f/M_x,dead) − 0.226 , M_x,dead ]
```

Note the asymmetric exponents: **−138** for dead, **−500** for live. `M_x,live` is a fraction. Physically this says live fuel only becomes available once the fine dead fuel is well below its own extinction moisture — the mechanism behind the sharp chaparral and eucalypt intensity thresholds.

### 4.5 Wind speed: midflame adjustment, effective wind, and the wind limit

`U` in `φ_w` is **midflame** wind, not the 10 m meteorological wind. Chain: `U_10m → U_20ft = U_10m/1.15 → U_mid = WAF · U_20ft`.

**Wind adjustment factor** (Albini & Baughman 1979; Andrews 2012, RMRS-GTR-266):

```
Unsheltered (crown fill f < 0.05):
  WAF = 1.83 / ln[ (20 + 0.36·H) / (0.13·H) ]          H = fuel bed depth, ft

Sheltered (f ≥ 0.05):
  WAF = 0.555 / [ √(f·H) · ln( (20 + 0.36·H) / (0.13·H) ) ]   H = canopy height, ft
  f = F·CR ,  F = CC/3 ,  CC = canopy cover fraction, CR = crown ratio
```

Sanity values: GR2 (`H` = 1 ft) → WAF = 0.362; SH7 (`H` = 6 ft) → WAF = 0.547; a 20 m ponderosa stand at CC = 0.6, CR = 0.5 → f = 0.10, WAF ≈ 0.133. These bracket the operational 0.1–0.6 range correctly.

**Effective wind speed.** With wind and slope combined as vectors, invert Rothermel Eq. 47 on the resultant magnitude `φ_E = |φ_w·ŵ + φ_s·ŝ|`:

```
U_eff = [ φ_E / (C · (β/β_op)^−E) ]^(1/B)      [ft min⁻¹]
```

This inversion is exactly GTR-371 §4.1 "Effective Wind Speed" p.27: `U_E = [φ_E·(β/β_op)^E / C]^(1/B)` with `φ_E = φ_w + φ_s`. `U_eff` is what drives the ellipse length-to-breadth ratio (§4.6) — using raw wind there is wrong on slopes.

**Wind limit.** Rothermel's original cap is on the **effective midflame wind**, not on the spread rate: `U_eff ≤ 0.9·I_R` (`U_eff` in ft min⁻¹, `I_R` in BTU ft⁻² min⁻¹) — Rothermel 1972 p.33; Albini 1976a ("maximum reliable wind"); Andrews 2018, RMRS-GTR-371 §3.2.7 p.25 and Table 6b p.18, which states it literally as "Wind limit (ft/min) = 0.9 I_R". Andrews, Cruz & Rothermel (2013) corrected an error in one assumption of that derivation and obtained the revised alternate

```
U_eff ≤ 96.8 · I_R^(1/3)        [U_eff in ft min⁻¹, I_R in BTU ft⁻² min⁻¹]
```

(GTR-371 §3.2.7 p.25, restating Andrews, Cruz & Rothermel 2013, *Int. J. Wildland Fire* 22(7):959–969, doi:10.1071/WF12122). The two forms cross at `I_R = (96.8/0.9)^1.5 ≈ 1116 BTU ft⁻² min⁻¹` — arithmetic from the two cited formulas, not from a source: below that the revised limit is the *looser* of the two, above it the tighter. Neither BEHAVE nor legacy BehavePlus contains the constant 96.8 at all; the alternate exists only on paper.

Both limits were judged too restrictive. **The authors — Rothermel included — recommend that no wind limit be imposed**, citing lab fires to 60 mi h⁻¹ that showed none, and BehavePlus ships that as a user option (GTR-371 §3.2.7 p.25, §5.4.4 p.83, §7.4.1 item 2 p.105). The 2013 abstract states the substitute as limiting rate of spread to effective midflame wind speed:

```
R_head ← min(R_head, U_eff)     both in ft min⁻¹; U_eff is the effective (wind+slope) midflame wind
```

(Andrews, Cruz & Rothermel 2013 abstract, IJWF 22(7):959–969 — free via https://www.frames.gov/catalog/16000). It is a physical sanity rail that essentially never binds: in GTR-371's own GR1 example, `R` = 8.2 ft min⁻¹ against `U_eff` = 792 ft min⁻¹ (9 mi h⁻¹ midflame), a ratio of ~0.01 (GTR-371 §5.4.4 pp.83–84).

**Decision: impose no hard wind limit by default — the published author recommendation — keep `R_head ← min(R_head, U_eff)` as an inert sanity rail against pathological wind fields, and expose the `0.9·I_R` cap as a debug toggle for cross-checking against BehavePlus.** Rationale: the `0.9·I_R` cap binds absurdly early in light grass. GTR-371's own GR1 worked example puts the limit at **1.6 mi h⁻¹** midflame (§5.4.4 p.83, `I_R` ≈ 156 BTU ft⁻² min⁻¹); even the far heavier GR2 D2L2 case of §4.2 (`I_R` ≈ 1.15×10³) reaches only `0.9·I_R` = 1035 ft min⁻¹ ≈ 11.8 mi h⁻¹ (arithmetic from that `I_R`). Either way it produces a visibly wrong plateau where the fire simply stops accelerating — unacceptable in an interactive simulation whose whole point is showing wind-driven runs. The modern reference implementation already behaves this way: `firelab/behave` resets `isWindLimitEnabled_ = false` at the top of every spread-rate call and no code in the tree ever sets it true, so it computes and reports the limit but does not apply it (surfaceFire.cpp:75, :252).

**Pipeline placement — normative, and definitive from both reference implementations.** Any cap acts on the pair `(U_eff, R_head)` **before** the elliptical decomposition of §4.6. `LB` is then computed from the capped `U_eff`, and `HB`/`a`/`b`/`c` and the §4.6 support-function Hamiltonian from the capped `R_head`. Flank and backing rates are **never** capped separately — they are already functions of the capped head quantities — and the cap is never applied inside the Hamiltonian. Order: `φ_w`, `φ_s` → vector-combine → `φ_E` → `U_eff` → cap → `LB` → ellipse. (firelab/behave surfaceFire.cpp:250–295; legacy BehavePlus xfblib.cpp:2359–2510, :2552; GTR-371 §6.2 pp.87–88, where every directional rate is a function of `R_head` and `U_E`.)

**Semantics of the legacy toggle.** If the `0.9·I_R` cap is implemented, implement it as BEHAVE does — cap the *wind* and re-evaluate, do not clamp the ROS:

```
if (U_eff > 0.9·I_R) { U_eff = 0.9·I_R ;  φ_E = C·U_eff^B·(β/β_op)^−E ;  R_head = R₀·(1 + φ_E) }
```

Clamping `R` directly gives different numbers and will not reproduce BehavePlus (firelab/behave surfaceFire.cpp:384–392; xfblib.cpp:2485–2495). **Do not port** behave's unconditional `if (phiS_ > 0.9·I_R) phiS_ = 0.9·I_R` clamp (surfaceFire.cpp:469–474): it compares the dimensionless slope factor against a wind speed and is absent from legacy BehavePlus. If a BehavePlus cross-check ever disagrees on steep slopes at very low `I_R`, that is why.

> **CLOSED — wind limit (was OPEN QUESTION: the 2013 paper unread).** Closed against RMRS-GTR-371, which restates both the 2013 derivation result and the 2013 recommendation, cross-checked line-by-line against two independent reference implementations that agree with each other exactly. Four things changed:
>
> 1. **What the cap acts on.** The `0.9·I_R` limit caps the effective midflame *wind*, not the spread rate. The previous text read `U ≤ 0.9·I_R` without saying which wind, and the toggle was implied to be a ROS clamp; both are corrected above.
> 2. **The revised alternate constant, previously unknown, is `96.8·I_R^(1/3)`** in the same units (GTR-371 §3.2.7 p.25). The exponent is one-third — verified from the PDF text-layer glyph baselines, so it is `I_R^(1/3)`, not `I_R/3`.
> 3. **Placement is *before* the elliptical decomposition** (previous text did not know). Confirmed in both implementations; flank and backing rates are derived from already-capped head quantities and are never capped separately.
> 4. **`U_eff` in the rail is effective midflame wind in ft min⁻¹, not the 20-ft wind** — the earlier assumption was right and stands uncorrected. No 1.15× and no WAF enters the cap. Only the NFDRS fire-danger branch uses plain midflame wind without the slope combination (GTR-371 §7.4.1 item 2 p.105).
>
> **Validation status (§0.7.3).** The wind-limit constants, units, wind height and pipeline placement are **`validated`**: traced to a free primary source (RMRS-GTR-371) and reproducing its published GR1 worked example. The §0.7.3 test in `test/validation/` that carries this status is the GR1 assertion — `I_R` ≈ 156 BTU ft⁻² min⁻¹ ⇒ `0.9·I_R` = 140.8 ft min⁻¹ = 1.6 mi h⁻¹ (GTR-371 §5.4.4 p.83) — and it must exist before the status is claimed in export metadata. The shipping default (no hard limit) is likewise **`validated`**: it is the model authors' published recommendation and is what firelab/behave actually does. The optional `R_head ← min(R_head, U_eff)` rail carries the weaker status **`substituted`**: it is sourced only to the 2013 abstract's one-sentence recommendation and appears in no reference implementation; its known bias is that it is inert at realistic spread rates (`R/U_eff` ~ 0.01–0.2), so it costs nothing and buys nothing beyond the pathological-wind guard.
>
> **Not obtained:** the 2013 full text (IJWF paywall, no free equivalent located). Nothing above depends on it — GTR-371 restates both the derivation result and the recommendation, and the abstract carries the substitute verbatim.
>
> Sources: Andrews, P.L. 2018, *The Rothermel surface fire spread model and associated developments*, USDA FS RMRS-GTR-371, §3.2.7 p.25, Table 6b p.18, §4.1 p.27, §5.4.4 pp.83–84, §6.2 pp.87–88, §7.4.1 p.105 — https://research.fs.usda.gov/treesearch/download/55928.pdf ; Andrews, Cruz & Rothermel 2013, IJWF 22(7):959–969, doi:10.1071/WF12122 (abstract); firelab/behave `src/behave/surfaceFire.cpp` :75, :250–295, :384–392, :465–476 — https://github.com/firelab/behave/blob/master/src/behave/surfaceFire.cpp ; legacy BehavePlus `xfblib.cpp` :2359–2510, :2552–2558 — https://www.frames.gov/documents/behaveplus/software/xfblib.cpp

### 4.6 Making it a 2D field on the 0.5 m grid

Three candidate propagation schemes:

**Cellular automaton.** A cell ignites its 8 neighbours after `d/R` seconds. Trivially parallel and cheap. **Rejected.** The fatal flaw is structural: the 8-neighbour ignition rule makes the reachable set the unit ball of a polygonal metric, so an isotropic fire on flat homogeneous fuel produces an **octagon**, not a circle, and the error does not shrink with grid refinement — it is O(1), not O(Δx). Going to 16 or 24 neighbours yields a 16-gon at 2–3× the cost; per-direction correction factors (Alexandridis et al. 2008) are a calibration hack that must be re-fit whenever the anisotropy changes, which for us is every frame because the wind gusts.

**Marker / front tracking** (FARSITE-style, Finney 1998). Vector perimeter, Huygens expansion at each vertex. Geometrically exact and has no grid anisotropy at all. **Rejected on integration grounds.** Topology management — merging perimeters, clipping crossovers, rezoning vertex density — is serial, branch-heavy pointer work that maps badly onto a compute shader. We have Lagrangian firebrands seeding new independent ignitions continuously (locked decision), so merges are frequent, not exceptional. It would force a CPU round-trip per frame.

**Recommendation: narrow-band level set** (Osher & Sethian 1988), as used by WRF-Fire and ELMFIRE, and supported by Bova, Mell & Hoffman's (2016) comparison of the two families.

```
∂φ/∂t + S(n̂)·|∇φ| = 0 ,    n̂ = ∇φ/|∇φ|
φ < 0 burned/burning, φ > 0 unburnt, front at φ = 0
```

It is Eulerian, so it lives on the same 2048² texture as the fuel state, the heat-release field feeding the plume, and the soot source for the froxel raymarch — zero impedance mismatch. Topology change (merging spot fires, burning around a lake) is automatic. **Cost:** numerical diffusion smears the front over 2–3 cells, and you must reinitialise `φ` toward a signed distance function periodically.

**Defeating grid anisotropy.** Because `n̂` comes from the continuous gradient, it takes all directions, not eight — the residual anisotropy is discretisation error, O(Δx²) with a second-order scheme, not a structural O(1) bias. This only holds with a proper scheme: use **ENO2 spatial reconstruction with a local Lax–Friedrichs Hamiltonian and TVD-RK2 in time**. First-order upwind alone still imprints 5–8% axis/diagonal asymmetry. Reinitialise with GPU jump-flooding (~11 passes over the band) every ~32 steps rather than PDE relaxation.

*Acceptance test:* no-wind, flat, homogeneous GR2, single point ignition, 500 m of spread. Measure `|r_axis − r_diag| / r_mean`. **Target < 2%.** Expect ~1% with ENO2+RK2, ~6% with first-order upwind, ~8% (and clearly octagonal) with an 8-neighbour CA.

**Elliptical shape theory.** A wind-driven fire on uniform fuel grows as an ellipse with the ignition point at the **rear focus**. Length-to-breadth from Anderson (1983), as used by FARSITE/FlamMap/ELMFIRE:

```
LB = min[ 0.936·exp(0.1147·U_eff) + 0.461·exp(−0.0692·U_eff) − 0.397 , 8 ]
```

with `U_eff` in **mi h⁻¹** — the effective midflame wind of §4.5, already capped if the `0.9·I_R` debug toggle is on, since any cap acts on `(U_eff, R_head)` *before* this decomposition. (Alexander 1985 gives the alternative `L/B = 1.0 + 0.0012·W^2.154` with `W` the 10 m open wind in km h⁻¹, valid to 50 km h⁻¹ where L/B ≈ 6.5; we use Anderson because it takes midflame wind directly and is fuel-type agnostic.) Then:

```
HB   = (LB + √(LB²−1)) / (LB − √(LB²−1))       head-to-back ratio
R_b  = R_head / HB                              backing rate
b    = (R_head + R_b)/2      semi-major (along heading)
c    = (R_head − R_b)/2      focal offset
a    = b / LB                semi-minor (flank rate)
```

`R_head` here is the capped head rate from §4.5; `R_b`, `a`, `b`, `c` are derived from it and are never capped again.

> **CLOSED — settled against the primary source, 2026-08-19.** The exponents above were
> **wrong in this document**, and `firelab/behave` was right. Anderson (1983), INT-305,
> **p. 7, Eq. 17** (obtained free via FRAMES) states it verbatim:
> `l/w = 0.936 EXP(0.1147U) + 0.461 EXP(-0.0692U)`, *"where U = windspeed at 1.5 ft or
> midflame miles per hour"*. The spec's `0.2566 / 0.1548` are Anderson's relation
> reparameterised for wind in **m s⁻¹** but applied to a number in **mi h⁻¹** — the exact
> unit error the open question predicted, and in this document rather than in the reference
> implementation. The effect was not subtle: `LB` hit its cap of 8 at 8.6 mi h⁻¹ midflame
> instead of 19.1, so every moderate-wind fire was far too elongated.
>
> Three independent cross-checks confirm the reading is not an OCR artefact:
> 1. Anderson's Eq. 18 on the next line, `d/b = 1/(0.534·EXP[−0.1147U]) = 1.873·EXP[0.1147U]`,
>    reuses the same exponent and is internally consistent — `1/0.534 = 1.873`. A garbled
>    digit would not close like that.
> 2. Anderson writes that Fons' linear fit `l/w = 1.0 + 0.5U` has *"nearly twice the slope"*
>    of Eq. 17. Over Fons' 2–12 mi h⁻¹ range, Eq. 17 has mean slope 0.233 against Fons' 0.5
>    — a ratio of 2.15, i.e. "nearly twice". With `0.2566` the mean slope would be 1.9, four
>    times Fons' rather than half.
> 3. Anderson's fig. 6 plots Eq. 17 on a y-axis topping out at 10 over a 0–12 mi h⁻¹ x-axis.
>    With `0.2566` the curve would leave the plot at 8 mi h⁻¹ (`l/w` = 20 at 12).
>
> **Status per §0.7.3: `calibrated`** — constants now traced to an obtainable primary source
> with a page and equation citation, but no benchmark dataset exists for the assembled
> ellipse relation, so it is not `validated`. The validation suite's coverage table reports
> `anderson-1983-lb` as *not validated here*, which is correct and must stay that way until a
> published LB dataset is asserted against.
>
> *Superseded text, retained so the error is traceable:* the exponents were previously given
> as `0.2566 / 0.1548`, attributed to Anderson (1983) but unchecked, and both reference
> implementations disagreed with them — and with each other. GTR-371 §6.2 p.87 and legacy BehavePlus (xfblib.cpp:2552–2558) use the much simpler `LB = 1 + 0.25·U_E` with `U_E` in mi h⁻¹. `firelab/behave` (fireSize.cpp:93–108) uses the same functional form as above but with exponents `0.1147` / `0.0692` — smaller by exactly 2.237, the mi h⁻¹-per-m s⁻¹ factor — while the surrounding code (fireSize.cpp:20–21) has just converted the wind to mi h⁻¹. So either this document's exponents or behave's are on the wrong wind unit, and one of the two is wrong by a factor of 2.237 in the exponent, which is not a small error in `LB`. Source this against Anderson 1983, INT-305 (free on treesearch) before §4.6 ships; the wind-limit pass above deliberately did not touch it. Until then this relation's status per §0.7.3 is **`estimated`** — constants not yet traced to an obtainable source — and it must not be a shipping default without an explicit decision recorded here. Reference points: firelab/behave `src/behave/fireSize.cpp` :20–21, :93–108 — https://github.com/firelab/behave/blob/master/src/behave/fireSize.cpp ; xfblib.cpp:2552–2558; Andrews 2018 RMRS-GTR-371 §6.2 p.87 and Table 26 p.86.

**Getting the emergent perimeter to be the right ellipse** is the part that is easy to get wrong. Do **not** set `S(n̂)` to the ellipse radius in direction `n̂` — that is a different curve. The correct normal speed is the **support function** of the ellipse taken about the rear focus (Richards 1990):

```
let μ = n̂ · ŵ                     (ŵ = unit heading direction)
S(n̂) = c·μ + √( b²·μ² + a²·(1 − μ²) )
```

Check: `μ = 1` → `b + c = R_head`; `μ = −1` → `b − c = R_b`; `μ = 0` → `a = R_flank`. This Hamiltonian is convex, so the level-set viscosity solution coincides exactly with the Huygens envelope — the emergent perimeter *is* the analytic ellipse, to discretisation error. That single equation is what buys correct fire shape without any per-direction fudge factors.

```wgsl
fn hamiltonian(n: vec2f, e: EllipseParams) -> f32 {
  let mu = dot(n, e.heading);                 // e.heading is unit
  return e.c * mu + sqrt(e.b*e.b*mu*mu + e.a*e.a*(1.0 - mu*mu));
}
```

### 4.7 Intensity, flame length, residence time, burnout

**Residence time** (Anderson 1969):
```
t_r = 384 / σ        [min],  σ in ft⁻¹
```
σ = 2000 → 11.5 s; σ = 1500 → 15.4 s.

**Heat per unit area** and **Byram (1959) fireline intensity**, in the Rothermel/Albini form:
```
H_A = I_R · t_r                     [BTU ft⁻²]
I_B = H_A · R = (384/σ)·I_R·R       [BTU ft⁻¹ min⁻¹]
I_B [kW m⁻¹] = I_B[BTU ft⁻¹ min⁻¹] × 0.0577
```
Equivalently Byram's original `I_B = H·w_a·R` with `H` heat yield [kJ kg⁻¹], `w_a` fuel consumed [kg m⁻²], `R` [m s⁻¹].

**Flame length** (Byram 1959):
```
L = 0.0775 · I_B^0.46      [m],  I_B in kW m⁻¹
  = 0.45  · I_B^0.46       [ft], I_B in BTU ft⁻¹ s⁻¹
```
**Validity caveat:** this relation was fitted to grass and low-intensity fires. It increasingly overestimates flame length above ~2 m in forest and shrub fuels. For the chaparral and eucalypt biomes treat `L` as a rendering cue, not a measurement, and label it as such in the HUD.

**Flame depth** falls out for free and is what the renderer actually needs:
```
D = R · t_r        [m]
```
Cells with `(t − t_ign) < t_r` are *flaming*; this produces a band of exactly width `D` rather than a one-cell line.

**Burnout.** Cells must burn down, not flip. Energy is budgeted exactly — total release per unit area is `H_A`, fixed by Rothermel — and only the *time distribution* is modelled. Use a normalised gamma pulse:
```
q̇(t) = H_A · (t′/τ²)·exp(−t′/τ),   t′ = t − t_ign,  τ = t_r/2
∫₀^∞ q̇ dt = H_A exactly ;  peak at t′ = τ
```
This gives a smooth ramp-up/decay for fire lighting and plume forcing instead of a step. Per-class mass is drawn down as `m_j(t) = m_j(0)·exp(−t′/τ_j)` with `τ_1h = t_r`, and coarse classes (10-h, 100-h) held on a separate smouldering timescale `τ_smoulder ≈ 10–20 min` feeding the soot field but contributing negligibly to `I_B`. **Flag: the smouldering timescales are an engineering fit, not a validated model** — Rothermel says nothing about post-frontal consumption, and coarse-fuel burnout is properly the domain of Albini/Reinhardt duff-consumption models we are not implementing.

### 4.8 Numerical stability

Explicit level-set advance is CFL-limited by the maximum characteristic speed of the Hamiltonian, which for our ellipse is `max S(n̂) = b + c = R_head`:

```
Δt ≤ CFL · Δx / R_max ,   Δx = 0.5 m,  CFL = 0.4
```

CFL = 0.4 (not 0.9) because in 2D the dimensionally-split LLF stencil needs ≤ 1/2, and we want headroom for the RK2 stage.

| Regime | `R_max` | `Δt_max` |
|---|---|---|
| Timber litter (TL2/TL5) | 0.02 m s⁻¹ | 10 s |
| Conifer understorey (TU5) | 0.15 m s⁻¹ | 1.3 s |
| Chaparral run (SH7, 30 km h⁻¹) | 1.0 m s⁻¹ | 0.20 s |
| Grass head fire (GR4, 40 km h⁻¹) | 3.0 m s⁻¹ | 0.067 s |
| Design ceiling (extreme grass) | 5.0 m s⁻¹ | **0.040 s** |

That is a 250× spread, so **`Δt` must be adaptive**. Compute `R_max` by GPU workgroup reduction over the active band, read back asynchronously with one frame of latency, and apply a 1.25× safety margin to absorb the staleness:

```
Δt = clamp(0.4·Δx / (1.25·R_max_prev), 5 ms, 250 ms)
n_sub = ceil(Δt_frame_sim / Δt)
```

**Substepping budget.** Full-grid RK2 with ENO2 moves ~16 B/cell/stage × 4.19M × 2 stages ≈ 134 MB per substep; at ~180 GB/s achievable on a 128-bit 8 GB Ada laptop part under Dawn, that is **≈0.75 ms per substep**. At 1× real time and `Δt` = 67 ms the solver runs once every four frames — free. At 10× time acceleration in grass, `n_sub` ≈ 3 → 2.3 ms, acceptable. Beyond ~4 substeps per frame, enable **narrow-band compaction**: an indirect-dispatch active-cell list rebuilt every 16 steps with a 4-cell margin, which cuts cost roughly in proportion to band area (typically 1–5% of the domain for a single fire). Start with the full-grid path — it is simpler and correct — and gate the compaction behind profiling.

**Hard rule: never silently exceed CFL.** A violated level set does not merely lose accuracy, it produces front stalling and oscillation that read as physical behaviour. Cap `n_sub` at 8; if more are required, reduce the time-acceleration factor and surface the clamp in the HUD.

### 4.9 Validity envelope — where we are outside the data

Stated plainly, because these limits govern how much to trust the numbers the HUD exports:

- **Rothermel (1972) was fitted to wind-tunnel fires in uniform, cured, dead fuel beds** with winds below roughly 2 m s⁻¹, no slope, and no live fuel. Live-fuel handling, slope, and high wind are all extrapolations bolted on afterwards. It is a spread-rate correlation, not a combustion model.
- **`φ_s` is validated to about 30% slope.** Above that it grows as tan² with no restraint and over-predicts severely. Clamp `tan φ_slope` at 0.7 (35°).
- **Grass is systematically under-predicted.** Cheney, Gould & Catchpole (1998) found measured grassland spread substantially exceeds Rothermel at high wind. **Recommendation: for the grassland/savanna biome, source `R` from the CSIRO model and use Rothermel only for `I_R`, `t_r` and consumption.** For natural/undisturbed pasture, with `U₁₀` in km h⁻¹ and output m s⁻¹:
  ```
  U₁₀ ≥ 5:  R = (1.4 + 0.838·(U₁₀ − 5)^0.844)·Φ_M·Φ_C / 3.6
  U₁₀ < 5:  R = (0.054 + 0.269·U₁₀)·Φ_M·Φ_C / 3.6
  Φ_M = exp(−0.108·M_g)                        M_g ≤ 12%
      = 0.684 − 0.0342·M_g                     M_g > 12%, U₁₀ ≤ 10
      = 0.547 − 0.0228·M_g                     M_g > 12%, U₁₀ > 10
  Φ_C = 0 if cure < 20%, else 1.036/(1 + 103.989·exp(−0.0996·(cure − 20)))
  ```
  (cut/grazed: 1.1/0.715/0.054/0.209; eaten-out: 0.55/0.3575/0.027/0.1045.)
- **Eucalypt has no validated Rothermel fuel model.** SH7/TU5 are proxies chosen for plausible intensity, nothing more. The defensible source is Project Vesta (Gould et al. 2007; Cheney et al. 2012), which is structured completely differently — fuel *hazard scores* rather than loads. Recommendation: treat the eucalypt biome as calibrated-by-eye against Vesta ROS curves, and say so in the export metadata.
- **UK fuels are unmodelled in the US system.** Heather, bracken and gorse have no S&B analogue; gorse is approximated by SH7 with reduced depth. Moisture arrives from the Canadian FWI FFMC, so the `M_f` feeding `η_M` must come from the FFMC moisture inversion `m = 147.2·(101 − FFMC)/(59.5 + FFMC)` rather than from US timelag classes (owned by the weather section). This is a documented cross-system graft with no validation behind it.
- **Hedgerows as linear fuel corridors** are a 0.5 m-grid geometry feature, not a physics feature — they work because the grid resolves them, but no fuel model was ever fitted to a hedge.
