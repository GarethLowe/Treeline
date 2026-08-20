## 6. Fire Meteorology and Dynamic Fuel Moisture

This section specifies the atmospheric driver that sits above the surface and canopy solvers. It is a *diagnostic* meteorology module: it does not integrate the Navier–Stokes equations for the ambient atmosphere (the fire's own buoyant flow is handled by the plume/convection model in §4). Its job is to produce, every simulation step, a spatially varying midflame wind vector for the surface layer, a 3D ambient wind field for firebrand and smoke advection, a surface energy budget for fuel heating, and evolving dead/live fuel moisture fields.

> **CLOSED — directional re-check, partially closed.** The pattern that prompted this callout
> — a sense error surviving review because the citation is right and only the direction is
> wrong — has now been checked claim by claim against free primary sources. Findings and full
> quotations: `docs/spec/_lit-findings/met-directions.md`. Eight directions confirmed, four
> corrected, three still open.
>
> **Confirmed in the source's own words (8).** Lee-separation flow *reverses* (runs back up
> the lee slope) and the ≈ 17° separation threshold is well placed — Finnigan et al. (2020),
> p. 9 (MS lines 249–251) and p. 14 (MS lines 388–391). Stable flow is forced *around*
> terrain, unstable/neutral goes *over* it, i.e. the `α_h/α_v` sense in §6.2 and channel (i)
> of §6.4 — Finnigan et al. (2020), p. 14 (MS lines 397–399). Anabatic upslope by day,
> katabatic downslope by night, and katabatic shallower than anabatic — AH-360 Ch. 7, PDF
> p. 120 (printed p. 114) and PDF p. 121 (printed p. 115). Stability sets `σ_u` and hence
> gust amplitude, §6.4 channel (ii) — AH-360 PDF p. 55 and PDF p. 71 (printed p. 65). An
> inversion traps and its breaking matters — AH-360 Ch. 2, PDF p. 36 (printed p. 30).
> `Φ_season` peaks at the end of the spring flush and declines through the growing season —
> Weise, Results p. 3.
>
> **Corrected (4).**
> 1. **§6.4 channel (iii) was inverted.** It asserted that a stable, low `z_i` *raises*
>    effective surface preheating. It does the opposite, and by a different mechanism:
>    stability acts on the **convective indraft**, not on re-entrained preheat. Stable ⇒
>    suppressed column ⇒ weaker low-level indraft ⇒ *lower* intensity; unstable ⇒ the
>    reverse. Rewritten and quoted in §6.4.
> 2. **§6.6 wetting/drying hysteresis was inverted.** Vapour-phase adsorption is the
>    *slower* branch, not the faster one: `τ_wetting ≈ 2.2 × τ_drying`, replacing the
>    published `0.7 ×`. The old factor made fine fuels recover from a humidity rise roughly
>    three times too fast, damping exactly the overnight RH-recovery behaviour it should
>    sustain. The §6.6 rainfall term is unaffected — direct liquid wetting is genuinely fast
>    and is a separate path.
> 3. **§6.3 reversal timing had the wrong phase reference.** "30–60 min after local
>    sunset/sunrise" replaced by slope-normal direct-beam illumination, which §6.5 already
>    computes: minutes after the sun strikes *that* slope, and onset of downslope flow as
>    soon as *that* slope goes into shadow — which on an east-facing slope precedes local
>    sunset by hours.
> 4. **§6.2 lee-separation length was too short.** 3–6 × ridge height widened to ≈ 4–12 H;
>    the only free measurement located is 2–4× larger than the old figure.
>
> **Still open (3).** (a) §6.2 reverse-flow magnitude `0.2–0.4 U_ridge` — no free source
> states lee reverse-flow speed as a fraction of ridge-top speed. (b) §6.8 drought exponent
> `p` = 0.7/0.35 — the *sense* (shallow-rooted far more drought-responsive than deep-rooted)
> is sourced, the magnitudes are not. (c) §6.4 Haines Index provenance — NWCG appears to have
> deprecated it, but every `nwcg.gov` and `fs.usda.gov/pnw` fetch returned HTTP 403. Each
> carries its own `OPEN QUESTION` callout at the point of use.
>
> **Validation status (§0.7.3).** §6.2 terrain flow and lee separation: **`estimated`**
> (direction and threshold sourced, magnitudes tuned). §6.3 slope winds: **`calibrated`**
> (direction, phase and depth ordering traced to AH-360 with page citations; no benchmark
> dataset). §6.4 stability→surface channels (i)–(iii): **`calibrated`**; column-collapse
> trigger and Haines usage remain **`estimated`**. §6.6 hysteresis ratio: **`calibrated`**
> for the 10-h class (measured pair), **`estimated`** for its extrapolation to the other
> classes. §6.8 `Φ_season` phase: **`calibrated`** for shrub strata, **`estimated`** for tree
> foliage; drought exponent `p`: **`estimated`**.
>
> **Sign-flip regression tests** (behavioural, so they catch an inversion regardless of the
> constants), to sit alongside the §6.2 test already specified:
> - Hold weather fixed and step RH 20 % → 90 %: 1-h MC must approach EMC *more slowly* than
>   under the reverse step 90 % → 20 %.
> - Same fuels and wind, stable vs unstable preset: surface ROS **and** gust amplitude must
>   both be *lower* under the stable preset.
> - Clear-sky day on a bipolar E/W ridge: the east slope must reverse to downslope flow while
>   the west slope is still upslope.

### 6.1 Wind field

#### 6.1.1 Above-canopy profile

The reference input is the 10 m open-terrain wind, `U10` (m s⁻¹). Above the roughness sublayer we use the neutral log law with stability correction (Monin–Obukhov):

    U(z) = (u* / κ) · [ ln((z − d)/z₀) − ψ_m((z−d)/L) + ψ_m(z₀/L) ]

| Symbol | Meaning | Units |
|---|---|---|
| `U(z)` | mean horizontal wind speed at height `z` | m s⁻¹ |
| `u*` | friction velocity | m s⁻¹ |
| `κ` | von Kármán constant = **0.40** | – |
| `z` | height above ground | m |
| `d` | zero-plane displacement | m |
| `z₀` | aerodynamic roughness length | m |
| `L` | Obukhov length (negative = unstable) | m |
| `ψ_m` | Businger–Dyer stability function | – |

Businger–Dyer (Dyer 1974): unstable (`ζ = (z−d)/L < 0`), `x = (1 − 16ζ)^{1/4}`,
`ψ_m = 2 ln((1+x)/2) + ln((1+x²)/2) − 2 arctan x + π/2`; stable (`0 ≤ ζ ≤ 1`), `ψ_m = −5ζ`.

`u*` is obtained by inverting the profile at the reference height. A power law `U(z) = U_ref (z/z_ref)^p` is retained only as a cheap fallback for the low-quality tier (`p` = 0.14 open grass, 0.20 shrub, 0.28 forest edge); it is not used for physics because it has no defensible `z₀`.

**Vegetation aerodynamic parameters.** `h` = mean vegetation height (m). Values from Wieringa (1993), Cionco (1965), Massman (1987); the general rules `z₀ ≈ 0.1h`, `d ≈ 0.65h` are used where species-specific data are absent.

| Vegetation (biome) | `h` (m) | `z₀` (m) | `d` (m) | Canopy attenuation `a` |
|---|---|---|---|---|
| Short pasture (UK, grassland) | 0.1–0.3 | 0.01–0.03 | 0.06–0.2 | – |
| Tall/tussock grass (savanna) | 0.6–1.2 | 0.05–0.10 | 0.4–0.8 | 0.9–1.3 |
| Heather / bracken (UK) | 0.3–0.8 | 0.03–0.08 | 0.2–0.5 | 0.8–1.5 |
| Gorse thicket (UK) | 1.5–2.5 | 0.15–0.30 | 1.0–1.6 | 1.5–2.5 |
| Chaparral (Mediterranean) | 1.5–3.0 | 0.20–0.40 | 1.0–2.0 | 1.5–2.5 |
| Ponderosa, open (Western US) | 18–25 | 1.0–2.0 | 12–16 | 1.0–2.0 |
| Mixed conifer, dense | 20–30 | 1.5–2.5 | 13–20 | 2.5–4.0 |
| Eucalypt dry sclerophyll | 15–25 | 1.0–2.0 | 10–16 | 1.5–3.0 |
| UK broadleaf, in leaf | 15–20 | 1.0–1.8 | 10–13 | 2.5–4.0 |
| UK broadleaf, leaf-off | 15–20 | 0.7–1.2 | 9–12 | 1.2–2.0 |

Hedgerows are not represented by a `z₀`; they are treated as porous barriers with a bleed-through fraction 0.3–0.6 and a lee-shelter length of 8–12 × barrier height, applied as a multiplicative mask on the surface wind field. This is a geometric heuristic, not a validated model.

#### 6.1.2 Within-canopy attenuation

Below canopy top `h` we use the exponential profile (Cionco 1965; Inoue 1963):

    U(z) = U(h) · exp[ −a (1 − z/h) ],  0 ≤ z ≤ h

`a` (dimensionless attenuation coefficient) is tabulated above. `a` scales roughly with plant-area index: `a ≈ 0.6·PAI` is a usable closure when the canopy voxel grid supplies PAI directly, which is the preferred path since we already carry leaf/needle area per voxel.

#### 6.1.3 Midflame wind and the Wind Adjustment Factor

The surface solver is calibrated to Rothermel (1972), which requires *midflame* wind. We use the BehavePlus WAF models (Andrews 2012, RMRS-GTR-266, eqs. 1, 2, 8, 12), which derive from Albini & Baughman (1979). **These equations are dimensionally inhomogeneous — the literal `20` is 20 ft — so `H` must be converted to feet inside the WAF kernel and the result is dimensionless.**

Unsheltered (crown fill portion `f` < 0.05):

    WAF = 1.83 / ln( (20 + 0.36·H) / (0.13·H) )     [H = fuel bed depth, ft]

Sheltered (`f` ≥ 0.05):

    WAF = 0.555 / ( sqrt(f·H) · ln( (20 + 0.36·H) / (0.13·H) ) )   [H = canopy height, ft]
    f = CR · F,   F = CC / 3

where `CC` = canopy cover (fraction, horizontal), `CR` = crown ratio (fraction), `f` = crown fill portion (fraction of the volume under canopy top occupied by crowns). Midflame wind `U_mf = WAF · U_{20+H}`, where `U_{20+H}` is the wind 20 ft above the vegetation top.

The underlying log profile in these models assumes `d = 0.64H`, `z₀ = 0.13H` — a *higher* `z₀` than the Wieringa values in the table above. We keep both: the Albini–Baughman constants inside the WAF kernel (so our ROS matches BehavePlus for the same inputs, which is a calibration requirement), and the Wieringa values for the outer boundary-layer profile driving firebrand and plume transport. This is an acknowledged internal inconsistency of ~10–20 % in the sub-canopy wind between the two paths; it is preferable to breaking calibration against the reference implementation.

Sheltered WAF is unreliable at low `CC` and low `CR` (Andrews 2012 explicitly flags this: at `CC` = 1 %, the equation returns WAF > 1). We clamp `f ≥ 0.05` before applying the sheltered branch and clamp `WAF ∈ [0.05, 0.6]`.

#### 6.1.4 Gusts

Ad-hoc noise is rejected: it has no correct energy at the timescales (5–60 s) that control run-and-flank behaviour. We synthesise the longitudinal gust component from the **von Kármán spectrum**:

    S_u(n) = 4 σ_u² (L_u / Ū) / [ 1 + 70.8 (n L_u / Ū)² ]^{5/6}

| Symbol | Meaning | Units |
|---|---|---|
| `S_u(n)` | one-sided power spectral density of `u′` | m² s⁻² Hz⁻¹ |
| `n` | frequency | Hz |
| `σ_u` | standard deviation of longitudinal velocity | m s⁻¹ |
| `L_u` | integral length scale | m |
| `Ū` | mean wind at the reference height | m s⁻¹ |

`L_u` from ESDU 85020: `L_u ≈ 25 z^{0.35} z₀^{−0.063}` (m; ≈ 70 m at `z` = 10 m, `z₀` = 0.03 m). Turbulence intensity `I_u = σ_u/Ū`:

- Neutral: `σ_u ≈ 2.5 u*` ⇒ `I_u ≈ 1 / ln((z−d)/z₀)` (≈ 0.15–0.17 for open grass at z = 10 m with z₀ = 0.01–0.03 m; 0.25–0.35 forest edge).
- Unstable: `σ_u/u* = (12 + 0.5 |z_i/L|)^{1/3}` (Panofsky et al. 1977), `z_i` = mixing height (m).
- Stable: `σ_u/u* ≈ 2.0`, and gusts become intermittent rather than continuous — the spectral model is a poor description of nocturnal intermittency and we say so; we add a Markov on/off intermittency mask under strong stability.

> **CLOSED — normative, by decision.** Both loose ends resolved.
>
> **(i) Reference height is 10 m above the DISPLACEMENT PLANE, not 10 m AGL.** That is,
> `z − d ≡ 10 m` everywhere in this document, so the neutral turbulence intensity is
>
> ```
> I_u = 1 / ln(10 / z₀)
> ```
>
> This is the only choice that works across the full vegetation range. A fixed 10 m AGL
> reference makes `(z − d)` negative over forest (`d` = 10–20 m), which is not a modelling
> approximation but an undefined logarithm — the code would produce NaN, or worse, silently
> clamp. Referencing to the displacement plane also makes the quoted 0.15–0.17 for open
> grass *exactly* consistent with the formula rather than approximately so, since for short
> pasture `d` is 0.06–0.2 m and the two readings differ by ~1–2 %.
>
> Consequence to carry: the **reference wind speed the user sets is defined at 10 m above
> the displacement plane**, so over closed forest the anemometer height it corresponds to is
> physically 20–30 m AGL. This is close to, but not the same as, the fire-service "20-ft
> wind" (6.1 m above the vegetation). Where published data is quoted in 20-ft wind, convert
> explicitly at the point of use and mark the conversion — do not assume they are
> interchangeable.
>
> **(ii) §6.1.4 is the authority; §6.9's control table follows it.** The gustiness defaults
> in the control table are derived from the §6.1.1 roughness lengths via the formula above,
> not authored independently. **Grassland default `I_u` = 0.16** (the midpoint of 0.15–0.17
> at `z₀` = 0.01–0.03 m), superseding the 0.14 previously tabulated in §6.9. Any future
> change to the roughness table must regenerate these defaults rather than being applied to
> them by hand — two independently-maintained numbers for one physical quantity is how they
> drifted apart in the first place.

Implementation: precompute a 2¹⁶-sample `u′` time series by inverse FFT with random phases (offline, at scenario load, <5 ms on CPU) and loop it; superimpose a spatially coherent 2D gust field generated as filtered noise with the same spectral slope, advected across the domain by Taylor's frozen-turbulence hypothesis at `Ū`. Runtime cost is one texture fetch per surface cell — negligible.

### 6.2 Terrain-modified flow

**Recommendation: a mass-consistent diagnostic solver (WindNinja approach; Forthofer et al. 2014), plus an explicit empirical lee-separation term.**

Rationale, and the honest limitation: a mass-consistent model minimises `∫ [α_h²((u−u⁰)² + (v−v⁰)²) + α_v²(w−w⁰)²] dV` subject to `∇·**u** = 0`, which reduces to a single elliptic (Poisson) equation for the Lagrange multiplier `λ`:

    ∂/∂x(∂λ/∂x)/α_h² + ∂/∂y(∂λ/∂y)/α_h² + ∂/∂z(∂λ/∂z)/α_v² = ∇·**u**⁰

with `**u**⁰` the initial (interpolated, terrain-draped) field, and `α_h/α_v` the Gauss precision moduli whose ratio encodes stability (`α_h/α_v` ≈ 1 neutral, falling to ≈ 0.1 for strongly stable flow that is forced around rather than over terrain — equivalently `α_v/α_h` up to ≈ 10, since a large `1/α_v²` in the operator above makes vertical adjustment cheap and sends flow over the ridge, which is the unstable limit). This reproduces ridge-crest acceleration and valley channelling well. **It cannot generate lee-side flow separation or recirculation**, because a divergence-free least-squares correction of an attached field stays attached. Forthofer et al. (2014) showed exactly this deficiency against the momentum solver. We therefore add a diagnostic separation term: where the downwind terrain slope exceeds ≈ 17° (0.3), inject a reversed near-surface flow of magnitude 0.2–0.4 `U_ridge` over a lee length of ≈ 4–12 × ridge height, blended with a smoothstep. This is a heuristic and is flagged as such in the HUD's model-provenance readout.

**Direction, threshold and length — sourced.** The *reversal sense* is confirmed: inside the separation bubble the near-surface mean flow runs back toward the ridge, i.e. **up the lee slope**, opposite the flow crossing the crest — "downwind a 'separation bubble' forms with reversed mean flow and enhanced turbulence levels" (Finnigan, Ayotte, Harman et al., *Boundary-Layer Flow Over Complex Topography*, Boundary-Layer Meteorol. 2020, free author copy, p. 9, MS lines 249–251), and in fire-domain terms the same roll eddy gives "a moderate to strong upslope wind opposite in direction to that flowing over the rim" (Schroeder & Buck, *Fire Weather*, USDA Agriculture Handbook 360 = NWCG PMS 425-1, Ch. 6, PDF p. 104 / printed p. 97–98). The **17°** trigger sits between the two measured critical angles — separation on rough 2D ridges above ~15°, on axisymmetric hills above ~20° (Finnigan et al. 2020, p. 14, MS lines 388–391) — so it is well placed for a single constant, though the same passage notes a roughness dependence at the separation point that one constant cannot carry.

The **lee length was corrected from 3–6 H to ≈ 4–12 H.** The only free measurement located gives a separation region of 4 L–5.2 L on a ridge of `H/L` = 0.36, i.e. `L` = 2.8 H, which is ≈ 11–14 ridge heights (Tolladay & Chemel, *Numerical Modelling of Neutral Boundary-Layer Flow across a Forested Ridge*, arXiv:2105.06260 — geometry `H` = 30 m, `L` = 84 m, p. 5, MS line 226; 5.2 L flow visualisation, p. 10, MS line 699; 4 L simulated extent vs 3 L for the coarser run, p. 15, MS line 1147). That case is a *forested* ridge, where canopy drag promotes earlier separation and a longer bubble, so 3–6 H may remain defensible over bare terrain — but nothing was found to support it, and the one free measurement is 2–4× larger, so the band is widened rather than split by a cover flag we cannot source.

**Applicability caveat.** The recirculation is a stable/neutral-wind feature. LES shows that "convectively driven turbulence eliminates recirculation zones that would otherwise persist in the lee of steep terrain" at the wind speeds studied (Finnigan et al. 2020, MS line 635), so applying the separation term unconditionally over-fires it in unstable conditions. Gate its amplitude on the stability preset alongside `α_h/α_v`.

> **OPEN QUESTION (unverified):** The injected reverse-flow magnitude **0.2–0.4 `U_ridge`** is
> not sourced. No open publication was located that states reverse-flow speed inside a
> hill-lee separation bubble as a fraction of ridge-top speed; the nearest free evidence is
> qualitative — lee-side flow at Big Southern Butte is "highly unsteady, with 180°
> fluctuations in wind direction at some locations over the 10 min averaging period", and
> mass-consistent solvers "over-predict wind speed on the lee side", i.e. real lee speeds are
> well below what a COM solve gives (Wagenbrenner, Forthofer, Page & Butler 2019,
> *Development and Evaluation of a RANS Solver in WindNinja…*, Atmosphere 10(11):672, free
> USFS copy — lee-side unsteadiness p. 20, Fig. 17 discussion; COM over-prediction, Section 4
> summary p. 22). The fraction is therefore an engineering choice and carries `estimated`
> alongside `α_h/α_v`. **What would close it:** a measured or LES-derived ratio of mean
> reverse-flow speed to crest speed for an isolated ridge at a stated `H/L` and roughness —
> the Wagenbrenner RANS case has the fields to extract it if the raw output is obtainable.

**Stability preset → `α_h/α_v` mapping (NORMATIVE).** The sense is: large `α_h/α_v` makes
vertical adjustment cheap and sends flow *over* terrain (the unstable limit); small
`α_h/α_v` makes vertical adjustment expensive and forces flow *around* terrain (the stable
limit). The table below fixes the mapping so it cannot be re-derived — possibly inverted —
by an implementer reading the prose. This sense is now sourced, not merely asserted: "At such
large Froude Numbers the airflow goes over the hill rather than being blocked and forced to go
around the hill by the stratification" (Finnigan et al. 2020, p. 14, MS lines 397–399) — high
Fr = weak stratification = over; low Fr = strong stable stratification = blocked, around.

| Preset | Pasquill class | `α_h/α_v` | Behaviour |
|---|---|---|---|
| Very unstable | A–B | 3.0 | Flow readily lifts over ridges; strong vertical mixing |
| Unstable | B–C | 2.0 | Mostly over terrain |
| Neutral | D | 1.0 | Isotropic adjustment — the reference case |
| Stable | E–F | 0.3 | Flow begins to deflect around obstacles |
| Very stable | F–G | 0.1 | Strongly blocked; flow goes around, not over |

> **STATUS: `estimated`.** These endpoints are **tuned, not derived.** WindNinja and its
> MATHEW lineage expose the stability ratio as a user input rather than computing it, and no
> published calibration against Pasquill class or Obukhov length was located. The *sense* is
> now confirmed against a primary source (Finnigan et al. 2020, p. 14, MS lines 397–399,
> quoted above) and is unambiguous; the *magnitudes* remain engineering choices. Per §0.7
> the terrain-flow model therefore reports `estimated` in the HUD until a calibration source
> is found or a sensitivity study bounds the effect.
>
> **Mandatory regression test**, which is the real guard here — it tests behaviour rather
> than the constant, so it catches an inverted mapping regardless of the numbers: place an
> isolated axisymmetric ridge in a uniform approach flow and assert that under the
> **very stable** preset the near-surface streamlines deflect **around** it (horizontal
> deviation exceeds vertical), and under **very unstable** they pass **over** it (vertical
> exceeds horizontal). This must fail loudly if the ratio is ever inverted, because the
> failure mode is silent otherwise and it corrupts exactly the stable nocturnal conditions
> §6.3 identifies as the cause of unexpected overnight fire runs.

Coarse LES/RANS is rejected: at 10 m resolution over 1 km with 40 vertical levels the CFL-limited timestep is ~0.05 s, and a RANS pressure solve per step would cost 10–50 ms — it consumes the entire frame budget that the fire and volumetric renderer need. Pure slope-heuristic speedup (`S = 1 + 0.5·sinα` style) is retained only as the lowest quality tier; it produces no channelling and no lee reversal.

**Resolution and cost.** Horizontal 10 m (100 × 100), 40 stretched vertical levels (2 m at the surface to 50 m at the top, domain top ≈ 800 m) ⇒ 400 k cells. Solve with geometric multigrid (V-cycle, red–black Gauss–Seidel, 2 pre / 2 post smooths, 6 levels) in WebGPU compute. Per V-cycle the finest level dominates: ~400 k cells × ~8 B effective traffic × 8 smoothing passes ≈ 26 MB, ≈ 60 MB including coarse levels, restriction and prolongation. At an achievable ~150 GB s⁻¹ on the RTX 4070 Laptop (256 GB s⁻¹ peak) that is **≈ 0.4 ms per V-cycle**; 5 V-cycles to 10⁻⁴ residual ≈ **2 ms**, plus ~250 dispatches (6 levels × ~10 dispatches per level for red–black 2 pre / 2 post plus restriction and prolongation, × 5 V-cycles) × ~7 µs ≈ 1.8 ms of command overhead. **Budget ≈ 4 ms per solve.** Fusing the red–black colour passes and the residual-plus-restriction into single kernels is the first optimisation if this proves tight. We re-solve at 1 Hz (or when the mean wind vector changes by >5° or >10 % in speed) and slerp/lerp between the two most recent fields, giving an amortised **≈ 0.07 ms/frame at 60 fps** (4 ms ÷ 60 frames). FFT is rejected because the terrain-following coordinate makes the elliptic operator non-constant-coefficient; multigrid handles this natively.

> **OPEN QUESTION (unverified):** The corrected budget above changes which resource binds, and the paragraph is still framed around the one that does not. At ~250 dispatches the solve is **command-submission bound, not bandwidth bound** — ~1.8 ms of overhead against ~2 ms of memory traffic, so halving the arithmetic or the traffic buys almost nothing while halving the dispatch count buys nearly half the solve. Three things must be settled before this budget is relied on: (i) the ~7 µs per-dispatch figure is an assumption, not a measurement, and browser WebGPU overhead varies by roughly an order of magnitude across backends (D3D12 vs Vulkan) and with whether the passes share an encoder — measure it on the target configuration before accepting 4 ms; (ii) the 6-level V-cycle is asserted but not shown to be constructible, since 100×100×40 with 2 m–50 m vertical stretching coarsens to ~3×3×1 by level 6 and the grid anisotropy likely forces semi-coarsening, which changes both the level count and the per-level dispatch count that the 1.8 ms rests on; (iii) 5 V-cycles to 10⁻⁴ is a textbook convergence rate for a well-conditioned constant-coefficient Poisson problem, and this operator is neither — the actual iteration count on stretched terrain-following coordinates is unmeasured. If the real figure is 8–10 V-cycles the solve is ~8 ms, which still amortises at 1 Hz but no longer leaves room to raise the re-solve rate.

10 m is finer than WindNinja's typical 100–200 m operational mesh. Mass-consistency does not break at 10 m, but it adds no genuine skill below the scale of resolved terrain features — the extra resolution buys visual and advection smoothness, not accuracy.

### 6.3 Thermal (slope) winds

Diurnal slope flow runs **upslope by day and downslope by night** — "They flow upslope during the day as the result of surface heating, and downslope at night because of surface cooling" (Schroeder & Buck, *Fire Weather*, AH-360, Ch. 7 'Convective Winds', PDF p. 120 / printed p. 114) — and is a classic cause of unexpected overnight fire runs (Whiteman 2000; Sharples 2009).

**Reversal timing is keyed to slope-normal illumination, not to a global clock.** The reversal is driven off the slope-normal direct-beam term §6.5 already computes, with a short lag on each transition:

- **Morning (downslope → upslope):** onset is of order **minutes** after the direct beam first strikes *that* slope — "Upslope winds begin as a gentle upflow soon after the sun strikes the slope. Therefore, they begin first on east-facing slopes after daybreak" and "upslope winds begin within minutes after the sun strikes the slope" (AH-360 Ch. 7, PDF p. 123 / printed p. 117, and PDF p. 124 / printed p. 118).
- **Evening (upslope → downslope):** the trigger is **shadow arrival on that slope**, which on an east-facing slope precedes local sunset by hours — "The transition from upslope to downslope wind begins soon after the first slopes go into afternoon shadow and cooling of the surface begins" — proceeding as "(1) dying of the upslope wind, (2) a period of relative calm, and then (3) gentle laminar flow downslope", i.e. of order tens of minutes to ~1 h from full shading to established katabatic flow (AH-360 Ch. 7, PDF p. 121 / printed p. 115).

This replaces the previous "roughly 30–60 min after local sunset/sunrise", which used the wrong phase reference: an astronomical sunrise/sunset clock is aspect-blind, and gets the overnight-run hour wrong on exactly the aspect-dependent slopes that matter. Carry the asymmetry it also lost: the *valley*-scale flow completes its "180-degree change in direction … some time after sunset" (AH-360 Ch. 7, PDF p. 124 / printed p. 118), so the slope and valley components reverse at different times and must not share one phase term.

We drive the flow diagnostically from the slope-normal surface energy imbalance:

    U_s = C_s · [ (g/θ₀) · Δθ · h_s · sin β / (C_D + k_e) ]^{1/2}

| Symbol | Meaning | Units |
|---|---|---|
| `U_s` | equilibrium along-slope jet speed | m s⁻¹ |
| `g` | 9.81 | m s⁻² |
| `θ₀` | ambient potential temperature | K |
| `Δθ` | slope-layer potential temperature deficit/excess | K |
| `h_s` | slope-flow layer depth | m |
| `β` | slope angle | rad |
| `C_D` | drag coefficient ≈ 0.005–0.02 | – |
| `k_e` | entrainment coefficient ≈ 0.01 | – |
| `C_s` | tuning constant ≈ 0.7 | – |

Typical outputs, which we clamp to: anabatic 1–4 m s⁻¹ with `h_s` 50–200 m; katabatic 1–3 m s⁻¹ with `h_s` 20–80 m. The **ordering is confirmed** — katabatic is shallower and slower than anabatic: "Downslope winds are very shallow and of a slower speed than upslope winds. The cooled denser air is stable and the downslope flow, therefore, tends to be laminar" (AH-360 Ch. 7, PDF p. 121 / printed p. 115); the katabatic depth clamp sits inside the reviewed 10–100 m band, described as "extremely shallow … only ~10-100-m deep with jet peaks as low as 1m" (Finnigan et al. 2020, §4.1, MS lines 1261–1264). **The speed clamps are a deliberate choice, not a derivation.** Stull gives anabatic "3 to 5 m s–1, and depths are hundreds of meters" and katabatic "3 to 8 m s–1" with "depths are 10 to 100 m … roughly 5% of the vertical drop distance" (Stull, *Practical Meteorology*, §17.3 Thermally Driven Circulations, anabatic and katabatic subsections) — so both our bands sit ~1–2 m s⁻¹ low, and Stull's bands would let katabatic exceed anabatic where AH-360 says it cannot. We follow AH-360 because it is the fire-domain source and because the slower, laminar nocturnal branch is the conservative reading; this is recorded as a choice between two sources, not as agreement. `Δθ` is computed from the net radiation surplus/deficit of §6.5 integrated over the preceding hour. This is a bulk parameterisation, not a resolved flow; it is added vectorially to the mass-consistent field before the divergence correction so the composite stays divergence-free.

### 6.4 Plume rise and atmospheric stability

The total heat release rate per unit fireline length follows from Byram (1959): `I_B = H · w · R` (kW m⁻¹), with `H` = low heat of combustion (kJ kg⁻¹, ≈ 18 600), `w` = fuel consumed (kg m⁻²), `R` = ROS (m s⁻¹). This is Byram's fireline intensity — the total rate of heat release per unit length of fire front; the convective fraction `χ_c` is applied separately below, and `N_c` below uses the total `I_B`, not `χ_c I_B`. The buoyancy flux for a line source of length `Λ` (m), taking a convective fraction `χ_c` ≈ 0.5–0.7 of `I_B`:

    F_b = g · χ_c · I_B · Λ / (π ρ_a c_p T_a)          [m⁴ s⁻³]

with `ρ_a` ≈ 1.2 kg m⁻³, `c_p` = 1005 J kg⁻¹ K⁻¹, `T_a` = ambient temperature (K). Briggs (1975) final rise:

- Neutral/unstable: `Δh = 1.6 F_b^{1/3} x_f^{2/3} / u`, with `x_f = 49 F_b^{5/8}` for `F_b` < 55 m⁴ s⁻³ and `x_f = 119 F_b^{2/5}` for `F_b` ≥ 55 m⁴ s⁻³.
- Stable, windy: `Δh = 2.6 (F_b/(u·S))^{1/3}`. (Some texts use 2.4; EPA ISC/AERMOD use 2.6. We use 2.6 and expose it as a tunable.)
- Stable, calm (`u` < 1 m s⁻¹): `Δh = 5.0 F_b^{1/4} S^{−3/8}`.

Stability parameter `S = (g/T_a)(∂θ/∂z)` (s⁻²); `∂θ/∂z = ∂T/∂z + Γ_d`, `Γ_d` = 0.0098 K m⁻¹. Defaults: `∂θ/∂z` = 0.02 K m⁻¹ (E), 0.035 K m⁻¹ (F). Plume rise is capped at the mixing height `z_i`; when `Δh` would exceed `z_i` the plume is trapped and spread horizontally, which is what produces the characteristic smoke-lid look and, physically, the loss of convective ventilation.

**Regime.** Byram's convection number:

    N_c = 2 g I_B / [ ρ_a c_p T_a (U − R)³ ]

`N_c` > ~2–10 → plume-dominated (buoyancy wins; column erect, spread erratic and multidirectional, spotting dominant). `N_c` ≲ 2 → wind-driven (elongated head fire). Column collapse is modelled as: plume rises, meets a capping inversion or entrains dry mid-level air, loses buoyancy, and the downdraft imposes an outflow. We trigger a collapse event when the plume top hits `z_i` **and** `N_c` > 10 **and** mid-level dewpoint depression exceeds 13 K, then impose a radial outflow of 0.3–0.6 × plume vertical velocity at the surface for 60–180 s. This is a phenomenological trigger. There is no quantitative validated criterion for column collapse in the literature; we are explicit that this is a plausible-looking heuristic, not physics.

**Haines Index** (Haines 1988) is computed and displayed as a diagnostic, and used only to modulate the collapse probability and gust intermittency — not to alter ROS directly. `HI = A + B`, each scored 1/2/3:

| Variant | Stability term A | A breakpoints (K) | Moisture term B | B breakpoints (K) |
|---|---|---|---|---|
| Low (950–850 hPa) | `T₉₅₀ − T₈₅₀` | ≤3 / 4–7 / ≥8 | `T₈₅₀ − Td₈₅₀` | ≤5 / 6–9 / ≥10 |
| Mid (850–700 hPa) | `T₈₅₀ − T₇₀₀` | ≤5 / 6–10 / ≥11 | `T₈₅₀ − Td₈₅₀` | ≤5 / 6–12 / ≥13 |
| High (700–500 hPa) | `T₇₀₀ − T₅₀₀` | ≤17 / 18–21 / ≥22 | `T₇₀₀ − Td₇₀₀` | ≤14 / 15–20 / ≥21 |

> **OPEN QUESTION (unverified):** The Haines Index may be **deprecated**, in which case the
> provenance label above should read `deprecated by NWCG` rather than `diagnostic`. Search
> results indicate that NWCG's Fire Weather Subcommittee has recommended discontinuing HI in
> fire-weather forecasts and NWCG training on the grounds that it is unsupported for
> predicting large fire growth and is not a stability metric, and that Potter (USFS PNW)
> published 'The Haines Index – it's time to revise it or replace it'. **Neither claim is
> verified:** both primary pages returned HTTP 403 to every fetch attempt —
> `nwcg.gov/6mfs/weather-fire-behavior/replacing-haines-index-and-lightning-activity-level`
> and `fs.usda.gov/pnw/pubs/journals/pnw_2018_potter001.pdf` — so this is search-index level
> only and is flagged, not closed. The exposure is limited: §6.4 uses HI as a displayed
> diagnostic and a modulator of collapse probability and gust intermittency, never on ROS,
> which is the low-risk use. **What would close it:** one successful fetch of either page
> from a network NWCG does not 403, or a mirrored copy of the Potter paper. Until then the
> HI display and its modulation term carry `estimated`. Do not promote HI to a driver, and do
> not remove it, on the strength of an unfetched page.

**Feedback onto surface fire.** Stability affects surface behaviour through three explicit channels, all already in our model, and **all three act in the same direction: unstable raises surface fire behaviour, stable suppresses it.**

**(i) `α_h/α_v` in the mass-consistent solve** — stable flow channels around terrain rather than climbing over it (§6.2; sense sourced to Finnigan et al. 2020, p. 14, MS lines 397–399).

**(ii) `σ_u`, and hence gust amplitude, via §6.1.4** — "winds tend to be turbulent and gusty when the atmosphere is unstable, and this type of airflow causes fires to behave erratically", and "A steady wind is indicative of stable air. Gusty wind, except where mechanical turbulence is the obvious cause, is typical of unstable air" (AH-360 Ch. 4 'Atmospheric Stability' opening page, PDF p. 55; visual stability indicators, PDF p. 71 / printed p. 65). This matches §6.1.4's Panofsky closure numerically: `σ_u/u*` = 2.0 stable, 2.5 neutral, ≥ 3.5 for `|z_i/L|` ≳ 100 unstable.

**(iii) The convective indraft**, set by how freely the column can rise. **This channel was previously specified inverted** — it claimed a stable, low `z_i` keeps hot gas near the fuel and *raises* effective preheating. It does the opposite, and the mechanism is the low-level indraft, not re-entrained preheat. In the source's own words: "Atmospheric stability may either encourage or suppress vertical air motion. The heat of fire itself generates vertical motion, at least near the surface, but the convective circulation thus established is affected directly by the stability of the air. In turn, the indraft into the fire at low levels is affected, and this has a marked effect on fire intensity" (AH-360 Ch. 4 opening page, PDF p. 55). Unstable ⇒ "hot gases rising from a fire will encounter little resistance, will travel upward with ease, and can develop a tall convection column" (AH-360, PDF p. 61 / printed p. 55) ⇒ stronger low-level indraft ⇒ higher intensity. Stable, low `z_i` ⇒ suppressed column ⇒ **weaker** indraft ⇒ **lower** surface intensity; observationally, "Within the thermal belt, wildfires can remain quite active during the night. Below the thermal belt, fires are in cool, humid, and stable air, often with downslope winds" (AH-360 Ch. 2, PDF p. 35 / printed p. 29). A trapping/re-entrainment term may be retained only as a second-order modifier on **plume-collapse outflow** (the collapse trigger above), never as a net positive on surface preheating.

**Inversion sign, stated explicitly.** The spec previously said an inversion traps without saying which way its breaking goes. It goes up: **inversion present ⇒ suppressed surface fire** (cool, humid, stable surface air, smoke shading, weak indraft); **inversion breakup ⇒ step increase in spread and gustiness**, because it removes exactly that suppression and coincides with the onset of mixing. "The behavior of a fire burning beneath an inversion may change abruptly when the inversion is destroyed" (AH-360 Ch. 2, inversion dissipation passage, PDF p. 36 / printed p. 30).

There is no empirical ROS multiplier applied for stability; that would double-count.

### 6.5 Solar load

**Sun position: Michalsky (1988) / Astronomical Almanac low-precision algorithm** — accuracy ≈ 0.01° over 1950–2050, ~30 FLOP, trivially portable to WGSL. Full NREL SPA (Reda & Andreas 2004) is unnecessary at our fidelity.

    n  = JD − 2451545.0                       (days since J2000, JD from UTC)
    L  = 280.460 + 0.9856474 n                (mean longitude, deg, mod 360)
    g  = 357.528 + 0.9856003 n                (mean anomaly, deg, mod 360)
    λ  = L + 1.915 sin g + 0.020 sin 2g       (ecliptic longitude, deg)
    ε  = 23.439 − 0.0000004 n                 (obliquity, deg)
    α  = atan2(cos ε · sin λ, cos λ)          (right ascension, rad)
    δ  = asin(sin ε · sin λ)                  (declination, rad)
    GMST = 6.697375 + 0.0657098242 n + UT     (hours, mod 24; UT in decimal hours)
    LMST = GMST + longitude_east/15
    HA   = LMST·15° − α                       (hour angle, deg)
    sin(elev) = sin φ sin δ + cos φ cos δ cos HA      (φ = latitude, rad)

Solar zenith `Z = 90° − elev`; azimuth `γ_s` from the standard atan2 form.

**Direct/diffuse split.** Extraterrestrial normal irradiance `G_on = 1367 · [1 + 0.033 cos(360 n_d/365)]` W m⁻²; horizontal `G₀ = G_on cos Z`. Clearness index `k_t = G/G₀`, where `G` is global horizontal, set from the user cloud-cover control via `G = G₀ (1 − 0.75 c^{3.4})` (Kasten & Czeplak 1980), `c` = cloud fraction. Diffuse fraction from **Erbs et al. (1982)**:

    k_t ≤ 0.22:            K_d = 1.0 − 0.09 k_t
    0.22 < k_t ≤ 0.80:     K_d = 0.9511 − 0.1604 k_t + 4.388 k_t² − 16.638 k_t³ + 12.336 k_t⁴
    k_t > 0.80:            K_d = 0.165

**Slope-aspect correction.** Incidence angle on a plane of slope `β` and aspect `γ` (measured from south, or adjust convention consistently):

    cos θ_i = cos β cos Z + sin β sin Z cos(γ_s − γ)

Absorbed shortwave at the fuel surface:

    S_abs = a_f [ G_bn cos θ_i + G_d · (1 + cos β)/2 + ρ_g G · (1 − cos β)/2 ]

`a_f` = fuel shortwave absorptivity (0.60 cured grass, 0.80 dark litter, 0.85 charred/needle litter), `G_bn` = direct normal, `G_d` = diffuse horizontal, `ρ_g` = ground albedo (0.15–0.25). Canopy shading multiplies `G_bn` by `exp(−k·PAI/cos Z)` using the canopy voxel PAI along the sun ray — we already have the ray-march machinery for the radiative transfer solver, so this is free.

**Fuel temperature above air.** Energy balance on a fine fuel element:

    ρ_f c_f δ · dT_f/dt = S_abs + ε_f(L↓ − σT_f⁴) − h_c (T_f − T_a) − λ_v E

with `ρ_f c_f δ` = areal heat capacity of the fuel element (J m⁻² K⁻¹), `ε_f` ≈ 0.95, `σ` = 5.670×10⁻⁸ W m⁻² K⁻⁴, `L↓` = downwelling longwave (W m⁻²), `λ_v E` = latent flux (W m⁻², small for cured fuel), and the convective coefficient from a cylinder correlation `h_c = (k_air/D)·(0.32 + 0.51 Re^{0.52})` (Nelson 2000), `D` = particle diameter (m), `Re = U D/ν`, `ν` = 1.5×10⁻⁵ m² s⁻¹, `k_air` = 0.026 W m⁻¹ K⁻¹. In practice this gives `T_f − T_a` ≈ +15–25 K for a 2 mm fine fuel in full sun at `U` < 1 m s⁻¹, falling to +3–5 K at `U` > 5 m s⁻¹ — consistent with the magnitudes assumed by NFDRS's fuel-stick temperature tables. We integrate this on the surface grid at 1 Hz, not per frame.

### 6.6 Dead fuel moisture — US biomes

**Equilibrium moisture content, Simard (1968)**, as used by NFDRS. `H` = relative humidity (%), `T` = air temperature **in °F** (use the fuel temperature `T_f` from §6.5, not air temperature — this is the standard NFDRS practice and matters by several percent MC), EMC in % oven-dry weight:

    H < 10:          EMC = 0.03229 + 0.281073 H − 0.000578 H T
    10 ≤ H < 50:     EMC = 2.22749 + 0.160107 H − 0.014784 T
    H ≥ 50:          EMC = 21.0606 − 0.483199 H + 0.005565 H² − 0.00035 H T

Nelson's (1984) formulation is more physical (it works from water potential and handles sorption hysteresis explicitly), but Simard is what the Rothermel-based ROS calibration in §3 was fitted against, so Simard is the operational choice; Nelson is not implemented.

**Timelag response.** For each size class,

    dm/dt = (EMC − m) / τ

`m` = moisture content (% oven-dry), `τ` = timelag (h) defined as the time to close 1 − 1/e ≈ 63.2 % of the gap.

| Class | Diameter | `τ` drying (h) | `τ` wetting (h) | Represents |
|---|---|---|---|---|
| 1-hr | < 6 mm (¼ in) | 1 | 2.2 | grass, needle litter, fine twigs |
| 10-hr | 6–25 mm | 10 | 22 | small branchwood |
| 100-hr | 25–75 mm | 100 | 220 | medium branchwood |
| 1000-hr | 75–200 mm | 1000 | 2200 | logs, deep duff |

**Wetting is SLOWER than drying, not faster.** This is a correction: the table previously carried `τ_wetting` = 0.7 × `τ_drying`, which has the hysteresis backwards. Vapour-phase sorption relaxes more slowly in adsorption (wetting) than in desorption (drying) — "Adsorption response times were longer and diffusivities lower than for fuels in desorption" (Anderson, H.E. 1990, 'Moisture diffusivity and response time in fine forest fuels', Can. J. For. Res. 20:315–325, abstract; tested at 26.7 °C with RH stepped 90 → 20 % and back). The factor is taken from the one free measured pair: for a standard 10-h fuel stick "Its response times were approximately 20 h (adsorption) and 9 h (desorption)" (Zhao, Yebra, Cary & Hughes, 'Evaluation of a 10-h fuel stick and a moisture meter for measuring fine dead fuel moisture and response times', Int. J. Wildland Fire 35(4):WF25174, 'Key results'), i.e. **`τ_wetting` ≈ 2.2 × `τ_drying`**, within a plausible 1.5–2.2 × band. The old 0.7 was a factor-of-3 error in the wrong direction on the 1-hr class, and its practical effect was to make fine fuels recover from a humidity rise far too quickly — damping overnight and RH-recovery spread at exactly the hours it should be sustained.

Status per §0.7.3: `calibrated` for the 10-hr row, whose ratio is the measured pair above; **`estimated` for the 1-hr, 100-hr and 1000-hr rows**, where the same 2.2 × is applied by extrapolation because no free per-class measurement was located. We also flag that measured 1-hr timelags in the field range 0.5–2 h depending on packing and shading — the class label is a convention, not a measurement.

This applies to the **vapour-sorption relaxation only.** Direct liquid wetting by rain is genuinely fast and is handled separately by the rainfall term below (`c_r · P`), which is unaffected by this correction and must not have the 2.2 × applied to it.

Numerically, integrate exactly rather than by Euler, because we run at a 1 s tick and `τ` = 1000 h spans seven orders of magnitude:

    m(t+Δt) = EMC + (m(t) − EMC)·exp(−Δt/τ)

**Rainfall.** For 1-hr and 10-hr fuels we add a direct wetting term: `Δm = min(m_sat − m, c_r · P)` with `P` = rain in the step (mm), `c_r` ≈ 15 % MC per mm for fine fuel and 3 % per mm for 10-hr, `m_sat` ≈ 250 % for fine litter. After rain ceases, drying follows the same exponential relaxation toward EMC; the visible "drying curve" is therefore automatic and has the correct shape (fast for 1-hr, days for 100-hr). 100-hr and 1000-hr fuels use a 24-h running average of EMC and precipitation rather than instantaneous values, per NFDRS.

### 6.7 Dead fuel moisture — UK biome (Canadian FWI)

For the UK biome the timelag-class framework is replaced by the Canadian FWI codes (Van Wagner 1987), which are the operational standard for UK vegetation and, crucially, handle the deep organic layers (peat, moorland duff, leaf mould) that timelag classes describe badly. Inputs are noon-LST temperature `T` (°C), RH `H` (%), 10 m wind `W` (km h⁻¹), 24-h rain `P` (mm).

**FFMC** (fine fuel, ~0.3 kg m⁻²; equivalent to roughly a 16-h timelag fuel):

    m = 147.2(101 − F₀)/(59.5 + F₀)
    if P > 0.5:  P_f = P − 0.5
        m += 42.5 P_f e^{−100/(251−m)} (1 − e^{−6.93/P_f})
        if m > 150: m += 0.0015 (m−150)² √P_f      ;  m ← min(m, 250)
    E_d = 0.942 H^{0.679} + 11 e^{(H−100)/10} + 0.18(21.1 − T)(1 − e^{−0.115H})
    E_w = 0.618 H^{0.753} + 10 e^{(H−100)/10} + 0.18(21.1 − T)(1 − e^{−0.115H})
    if m > E_d:  k₀ = 0.424[1 − (H/100)^{1.7}] + 0.0694 √W [1 − (H/100)⁸]
                 k_d = 0.581 k₀ e^{0.0365T};   m = E_d + (m − E_d)·10^{−k_d}
    if m < E_w:  k₁ = 0.424[1 − ((100−H)/100)^{1.7}] + 0.0694 √W [1 − ((100−H)/100)⁸]
                 k_w = 0.581 k₁ e^{0.0365T};   m = E_w − (E_w − m)·10^{−k_w}
    FFMC = 59.5 (250 − m)/(147.2 + m)

**DMC** (loosely compacted duff, ~5 kg m⁻²):

    K = 1.894 (T + 1.1)(100 − H) L_e × 10⁻⁴        [T clamped ≥ −1.1 °C]
    if P > 1.5:  r_w = 0.92P − 1.27
                 M₀ = 20 + 280/e^{0.023 P₀}
                 b = 100/(0.5 + 0.3P₀)          for P₀ ≤ 33
                 b = 14 − 1.3 ln P₀             for 33 < P₀ ≤ 65
                 b = 6.2 ln P₀ − 17.2           for P₀ > 65
                 M_r = M₀ + 1000 r_w/(48.77 + b r_w)
                 P₀ ← 43.43(5.6348 − ln(M_r − 20))
    DMC = max(0, P₀ + K)

`L_e` = effective day length (h) by month. UK (lat ≥ 30 °N) uses the Canadian standard vector `[6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0]` for Jan–Dec.

**DC** (deep compact organic, ~25 kg m⁻²):

    V = 0.36(T + 2.8) + L_f                        [T clamped ≥ −2.8 °C]; PE = max(0, V/2)
    if P > 2.8:  r_d = 0.83P − 1.27
                 Q₀ = 800 e^{−D₀/400}
                 D₀ ← max(0, D₀ − 400 ln(1 + 3.937 r_d/Q₀))
    DC = max(0, D₀ + PE)

`L_f` (north of 20 °N) = `[−1.6, −1.6, −1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, −1.6, −1.6]`.

**When we use which.** US conifer, grassland, chaparral, eucalypt → Simard EMC + timelag classes, because the ROS models for those biomes (Rothermel/Scott & Burgan, Cheney et al. 1998, Rothermel 1991 chaparral) all take fuel moisture by size class. UK → FWI codes, converted back to size-class moisture for the surface solver via `m_1h = 147.2(101 − FFMC)/(59.5 + FFMC)`, `m_10h`/`m_100h` interpolated from DMC via the inverse of the DMC moisture relation `M = 20 + 280 e^{−0.023·DMC}`, and `m_1000h` / duff from DC via `Q = 800 e^{−DC/400}` (mm of water in a 100 mm-equivalent layer) mapped to % MC. **This cross-walk is our own construction and is not a validated published mapping** — it is dimensionally reasonable and monotonic, and it is the pragmatic way to drive one solver from two moisture systems, but it is a modelling choice, not literature.

Startup values: FFMC = 85, DMC = 6, DC = 15 (Van Wagner's spring defaults); note these are Canadian spring conditions and are not appropriate for a UK late-summer scenario — our UK presets start from FFMC 88 / DMC 30 / DC 250.

### 6.8 Live fuel moisture and drought

**Drought index.** KBDI in SI units (Keetch & Byram 1968; Crane 1982 SI rederivation; Alexander 1990 correction to the 8.30 constant):

    Q_t = Q_{t−1} − P_net
    ΔQ = [ (203.2 − Q_t)(0.968 e^{0.0875 T_max + 1.5552} − 8.30) Δt ] / [ 1 + 10.88 e^{−0.001736 R} ] × 10⁻³
    KBDI_t = Q_t + ΔQ

`Q` = moisture deficit (mm, 0–203.2), `T_max` = daily max temperature (°C), `R` = mean annual rainfall (mm), `Δt` = 1 day. `P_net` is net rainfall: only rain in excess of 5.1 mm of the first day of a consecutive wet spell counts (canopy interception). US biomes use KBDI; the UK biome uses DC directly (they measure the same thing; running both would be redundant).

**Live fuel moisture.** LFM (`% oven-dry`) is driven by a seasonal curve modulated by drought, not by a free slider:

    LFM = LFM_min + (LFM_max − LFM_min) · Φ_season(DOY) · (1 − D)^{p}

`Φ_season` = a per-biome phenology curve (0–1, peak at the end of the spring flush), `D` = normalised drought (`KBDI/203.2`, or `DC/1000` clamped to 1), `p` ≈ 0.7 for shallow-rooted shrubs and ≈ 0.35 for deep-rooted trees.

**Phenology phase — confirmed.** LFM rises steeply through greenup and then declines through the growing season, so the peak sits at the end of the spring flush: "For most shrub species, live fuel moisture followed a 'typical' pattern. Fuel moisture increased rapidly due to the spring 'greenup' and then gradually decreased over the growing season" (Weise, D.R., 'Assessing live fuel moisture for fire management applications', USDA FS, Results, p. 3, 2nd column). The same source limits how far that carries: "Tree foliage live fuel moisture did not appear to exhibit the same seasonal trends that shrub fuels did." The shrub rows of the table below are therefore `calibrated`; the **conifer and broadleaf foliage rows (peak DOY 175/180) are `estimated`** — one curve per biome is a weaker model for tree foliage than for shrubs, and nothing was found to support those two peak dates.

**Drought exponent `p` — sense sourced, magnitudes not.** That shallow-rooted vegetation is far more drought-responsive than deep-rooted vegetation is supported: drought indices correlate strongly with plant moisture status for "herbaceous shallow-rooted species" and show "comparatively poor relationships … with the moisture dynamics of deep-rooted *Pinus brutia* trees", with the same split reported for KBDI against herbaceous versus "deep-rooted sclerophyllous species at the same location" (Nolan et al., 'Decoupling between soil moisture and biomass drives seasonal variations in live fuel moisture across co-occurring plant functional types', Fire Ecology 18:6 (2022), Discussion, p. 9; Qi, Dennison, Jolly et al., 'Monitoring Live Fuel Moisture Using Soil Moisture and Remote Sensing Proxies', Fire Ecology 8(3):71 (2012), Introduction, p. 73, KBDI/CWBI paragraph). So `p_shrub` > `p_tree` is the right way round. The values are not sourced — see the callout below.

> **OPEN QUESTION (unverified):** The **exponent values `p` = 0.7 (shallow-rooted shrubs) and
> `p` = 0.35 (deep-rooted trees)** are not sourced, and the power-law *form* `(1 − D)^p` is not
> either. No free publication was located that fits a power law of LFM on a normalised
> KBDI/DC, or that yields these two numbers. The nearest published chaparral result is
> described only as "a strong, nonlinear relationship" between a cumulative water-balance
> index and LFM (Dennison et al. 2003, as reported in Qi et al. 2012, Introduction, p. 73),
> with no functional form and no exponent given. Only the *ordering* `p_shrub` > `p_tree` is
> supported. Both values therefore carry `estimated`, on the same footing as `α_h/α_v` in
> §6.2, and **must not be presented in the HUD or exports as sourced.** **What would close
> it:** a paired LFM and drought-index time series for one shrub and one tree species at a
> common site, long enough to regress `ln(LFM/LFM_max)` on `ln(1 − D)` and either recover an
> exponent or reject the power-law form.

| Biome / stratum | LFM_min (%) | LFM_max (%) | Peak DOY (N. hemi.) | Critical threshold |
|---|---|---|---|---|
| Ponderosa/mixed-conifer foliage | 85 | 140 | 175 | ~100 % (crown fire onset softens) |
| Understorey shrub (US conifer) | 60 | 200 | 150 | 80 % |
| Grassland — expressed as **curing** | 0 % cured | 100 % cured | — | 70 % cured (spread becomes reliable) |
| Chaparral (chamise) | 55 | 130 | 130 | **77 %** (Countryman & Dennis 1974) |
| Chaparral (manzanita/ceanothus) | 60 | 150 | 135 | 80 % |
| Eucalypt foliage | 90 | 140 | 330 (S. hemi. spring) | 100 % |
| UK heather (*Calluna*) | 70 | 180 | 180 | 90 % |
| UK bracken (dead fronds dominate) | 15 | 120 | 200 | — |
| UK gorse | 70 | 160 | 150 | 90 % |
| UK broadleaf foliage | 100 | 180 | 180 | not a carrier |

For grass biomes, LFM is expressed as **degree of curing** `C` (%), which enters ROS via the curing coefficient (Cheney et al. 1998, as used in the CSIRO grassland model):

    Φ_c = 1.12 / (1 + 59.2 e^{−0.124(C − 50)})

Cruz et al. (2015) revised this relationship using senescing-grassland experiments and found the original **under**predicts spread in partially cured grassland (Cheney et al. 1998 gives MBE ≈ −0.27, and fires were observed to propagate at curing levels as low as 20 %, where Φ_c is near zero); we implement Cheney's form as default (it matches the ROS calibration in §3) with the Cruz variant selectable. The chamise 77 % threshold is a widely cited operational rule of thumb; its physical basis is weaker than usually implied, and we treat it as a soft transition (smoothstep over 70–85 %) rather than a hard switch.

### 6.9 User-facing weather controls

| Control | Physically sets | Range | Conifer | Grassland | Chaparral | Eucalypt | UK |
|---|---|---|---|---|---|---|---|
| Date (D/M) | solar declination, `L_e`/`L_f`, `Φ_season` | any | 1 Aug | 15 Feb (S) | 1 Sep | 1 Feb | 20 Jul |
| Local time | hour angle, diurnal RH/T/slope-wind phase | 0–24 h | 14:00 | 15:00 | 14:00 | 15:00 | 15:00 |
| Latitude | `φ` in solar geometry; FWI day-length band | −60…60° | 39 °N | −34 | 34 °N | −37 | 53 °N |
| 10 m wind speed | `U10` → `u*` → WAF chain → `U_mf` | 0–25 m s⁻¹ | 5 | 8 | 7 | 9 | 6 |
| Wind direction | inflow bearing for the mass-consistent solve | 0–360° | — | — | — | — | — |
| Gustiness | `I_u` in the von Kármán synthesis | 0.05–0.40 | 0.20 | 0.14 | 0.18 | 0.20 | 0.22 |
| Air temperature | Simard EMC, FFMC/DMC/DC, `T_a` in energy balance | −10…48 °C | 30 | 34 | 32 | 36 | 24 |
| Relative humidity | Simard EMC, FFMC `E_d/E_w` | 3–100 % | 20 | 18 | 15 | 15 | 45 |
| Cloud cover | `k_t` → direct/diffuse split; night `L↓` | 0–1 | 0.1 | 0.1 | 0.0 | 0.1 | 0.4 |
| Lapse rate / stability preset | `∂θ/∂z`, `S`, `α_h/α_v`, `σ_u/u*` | −0.02…+0.04 K m⁻¹ | Neutral | Unstable | Unstable | Very unstable | Neutral |
| Mixing height | plume cap `z_i` | 200–4000 m | 2500 | 3000 | 2500 | 3500 | 1200 |
| Rain rate / hours since rain | FFMC/DMC/DC rain routines, `P_net`, timelag wetting | 0–20 mm h⁻¹; 0–720 h | 240 h dry | 400 h | 800 h | 500 h | 96 h |
| Drought | KBDI (US) or DC (UK) → LFM, duff availability | 0–203.2 mm / 0–1000 | 130 | 150 | 175 | 165 | DC 320 |
| Curing (grass biomes only) | `C` in `Φ_c` | 0–100 % | 70 | 95 | 60 | 80 | 55 |
| LFM override (per stratum) | bypasses `Φ_season` | 30–250 % | off | — | off | off | off |
| Slope-wind strength | `C_s` | 0–1.5 | 0.7 | 0.7 | 0.7 | 0.7 | 0.7 |
| Shelter mode | forces sheltered/unsheltered WAF branch | auto/on/off | auto | off | auto | auto | auto |

A single "Dryness" master slider is exposed for casual use; it drives RH, KBDI/DC, curing and LFM together along a per-biome curve, with every derived value shown numerically so the physical state remains inspectable. It is a *view* onto the state variables, never a hidden multiplier on ROS.
