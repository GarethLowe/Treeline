## 7. 3D Canopy Heat Transfer & Crown Fire

### 7.1 Van Wagner's criteria as envelope, not engine

Van Wagner (1977) gives two independent thresholds. We implement both, but as **validators and HUD diagnostics**, not as the mechanism that drives spread. The 3D voxel model must *reproduce* them; if it does not, the 3D model is miscalibrated (§7.7).

**Initiation.** The critical surface fireline intensity that will ignite the canopy:

$$I_0 = \left[\frac{h\, \mathrm{CBH}}{100}\right]^{3/2} \equiv \big(0.01\,\mathrm{CBH}\,(460 + 25.9\,\mathrm{FMC})\big)^{3/2}$$

with $h = 460 + 25.9\,\mathrm{FMC}$ the heat of ignition of foliage (kJ kg⁻¹), $\mathrm{FMC}$ foliar moisture content (% oven-dry mass), $\mathrm{CBH}$ canopy base height (m), $I_0$ in kW m⁻¹. Verified against Scott & Reinhardt (2001, eq. 11) worked example: CBH = 3 m, FMC = 100 % → $I_0 = 875$ kW m⁻¹. The divisor 100 is an empirical constant fitted to **a single red-pine observation** — this is the weakest number in operational fire science and must be exposed as a tunable in our biome table.

Byram (1959) flame length, used for the HUD and for the flame-sheet emitter geometry (§7.4):
$$L_f = 0.0775\,I^{0.46}\quad [\text{m}],\ I\ \text{in kW m}^{-1}$$
(check: $I=875 \Rightarrow L_f = 1.75$ m, matching Scott & Reinhardt fig. 4b).

**Active crowning.** Van Wagner's horizontal mass-flow criterion: solid flame forms in the canopy when
$$S = R_{\text{crown}}\,\mathrm{CBD} \ \ge\ S_0 = 0.05\ \text{kg m}^{-2}\ \text{s}^{-1}$$
$R_{\text{crown}}$ = after-crowning forward ROS (m s⁻¹), $\mathrm{CBD}$ = canopy bulk density (kg m⁻³). In m min⁻¹:
$$R'_{\text{active}} = \frac{3.0}{\mathrm{CBD}}\quad [\text{m min}^{-1}]$$
(CBD = 0.2 → 15 m min⁻¹.) $S_0 = 0.05$ derives from **one** fire in a red pine plantation, cross-checked against Thomas (1963) laboratory beds.

**Classification** (Van Wagner 1977; Alexander 1988): surface fire if $I_{\text{surf}} < I_0$; passive crown (torching) if $I_{\text{surf}} \ge I_0$ but $R_{\text{crown}} < R'_{\text{active}}$; active crown if both exceeded. Independent crown fire ($R_{\text{crown}}$ sustained with $I_{\text{surf}} < I_0$) is documented so rarely (Huff 1988; Van Wagner 1993) that no model exists — we let the 3D solver produce it emergently if it wants and label it, but we do not calibrate to it.

**Crown fraction burned.** Canonical form $\mathrm{CFB} = 1 - e^{-a x}$, $x = R - R'_{\text{init}}$ (m min⁻¹). Van Wagner (1989) fixed $a = 0.23$; Van Wagner (1993) made it dynamic,
$$a = \frac{-\ln(0.1)}{0.9\,(R'_{\text{active}} - R'_{\text{init}})} = \frac{2.3026}{0.9\,\Delta R}$$
(jack pine: $\Delta R = 10.74 \Rightarrow a = 0.238$; mature stand $\Delta R = 23.69 \Rightarrow a = 0.108$ — both reproduce Scott & Reinhardt Appendix A exactly). Scott & Reinhardt's variant drops the 0.9 and scales against $R'_{SA}$.

**Recommendation: do not implement CFB as a spread-rate modifier.** Our 3D canopy produces crown consumption directly (fraction of canopy voxels reaching char). We compute CFB *from* the voxel field as an output only, so the HUD can be compared against NEXUS/FARSITE. Cruz & Alexander (2010) identify "reduction in crown fire rate of spread based on unsubstantiated crown fraction burned functions" as one of four principal sources of the systematic **under-prediction bias** in linked Rothermel–Van Wagner systems (the others: incompatible model linkages, under-biased component ROS models, uncalibrated custom fuel models). Reproducing that bias would be a defect, not fidelity.

**Envelope warning (state in the UI).** Van Wagner's criteria were fitted to boreal/Canadian conifer with FMC ≈ 95–135 % (Cruz & Alexander 2014). Applying $I_0$ to (a) chaparral, where there is no meaningful CBH because fuel is vertically continuous, (b) eucalypt, where bark spotting rather than crown continuity governs, and (c) UK broadleaf/gorse, is **outside the validated envelope**. For those three biomes we compute $I_0$ for display but calibrate against Cruz's fuel-strata-gap formulation, Project Vesta (Cheney et al. 2012), and gorse/heather ROS data respectively.

### 7.2 Voxel state vector and memory layout

Grid: 512 × 512 × 64 at 2 m = 16.78 M voxels dense. Canopy occupies a thin, terrain-following band; measured occupancy for a mixed-conifer stand on 1 km of rolling terrain is 10–18 %.

**Sparsity: brick pool + indirection grid.** Brick = 8³ voxels (16 m cube). Indirection grid 64 × 64 × 8 = 32 768 `u32` slots = 128 KB, `0xFFFFFFFF` = empty. Pool capacity 8192 bricks = 4.19 M voxels (25 % headroom over worst-case occupancy). Allocation is a one-time build-pass over the tree/shrub geometry plus an on-demand grow path when firebrands ignite outside the initial hull.

> **OPEN QUESTION (unverified):** The 8192-brick pool is sized from *voxel* occupancy (10–18 %), but allocation granularity is a whole 8³ brick. A thin, terrain-following canopy band clips the corner of far more bricks than its voxel fraction suggests, so brick occupancy can greatly exceed voxel occupancy and 8192 of 32 768 slots may **overflow rather than carry headroom**. The stated "25 % headroom" is also a conflation: 4.19 M / 16.78 M = 25 % is the fraction of the *dense grid* being allocated, whereas headroom over an 18 % worst-case occupancy is 39 %. Close this by instrumenting the build-pass on real terrain: report the brick-level occupancy histogram (fraction of the 32 768 slots touched, and mean voxel fill per touched brick) for the mixed-conifer 1 km case, then size the pool from that measurement. Until then, treat the 8192 figure, the §7.2 budget line (A = 67.1 MB, B = 33.6 MB, C = 16.8 MB → 117.6 MB) and the ≈161 MB canopy subsystem total as provisional, and make the on-demand grow path plus an explicit allocation-failure policy mandatory rather than optional.

**Structure-of-arrays, three bindings** (this is not stylistic — WebGPU's default `maxStorageBufferBindingSize` is 128 MiB and Chrome will not silently raise it; request the higher adapter limit *and* keep each pool under 128 MiB so the fallback path works):

| Pool | Field | Type | Bytes |
|---|---|---|---|
| **A — hot** (RW each step) | $T$ solid temperature (K) | f16 | 2 |
| | $\phi_{\text{fol}}$ foliage dry-mass fraction remaining | u16 (norm) | 2 |
| | $\phi_{0-3}$ 0–3 mm roundwood fraction | u16 | 2 |
| | $\phi_{3-6}$ 3–6 mm roundwood fraction | u16 | 2 |
| | $w_{\text{free}}$ free water (kg m⁻³) | f16 | 2 |
| | $w_{\text{bnd}}$ bound water (kg m⁻³) | f16 | 2 |
| | $\chi$ char mass fraction | u8 | 1 |
| | phase/flags (dry / pyrolysing / flaming / char / ash) | u8 | 1 |
| | $\dot m''_{\text{pyr}}$ pyrolysate flux (kg m⁻² s⁻¹) | f16 | 2 |
| | **subtotal** | | **16** |
| **B — cold** (static after build) | LAD (m² m⁻³, one-sided) | f16 | 2 |
| | $\rho_{d,0}$ initial dry bulk density (kg m⁻³) | f16 | 2 |
| | $\sigma$ SAV (m⁻¹), log-quantised | u8 | 1 |
| | species / fuel-type id | u8 | 1 |
| | clumping $\Omega_c$, bark fraction | 2×u8 | 2 |
| | **subtotal** | | **8** |
| **C — flux** (write-combine) | $\dot q'''_{\text{net}}$ (W m⁻³) | f32 | 4 |

**Budget at 8192 bricks:** A = 67.1 MB, B = 33.6 MB, C = 16.8 MB, indirection 0.13 MB → **117.6 MB**. Add the half-resolution radiation fields (§7.4): SH irradiance volume 256×256×32 × 4 coeff × f16 = 16.8 MB, double-buffered = 33.6 MB; mipped emission+extinction pyramid 256×256×32 × 4 B × 1.14 = 9.6 MB. **Canopy subsystem total ≈ 161 MB VRAM** — ~2 % of the 4070 Laptop's 8 GB, leaving the budget to the surface layer, froxels and textures.

Do **not** require the `shader-f16` WebGPU feature. Store f16 pairs inside `u32` buffers and use core-WGSL `unpack2x16float` / `pack2x16float`; this costs ~2 ALU ops per access and keeps the build running on adapters that expose f16 inconsistently.

### 7.3 Optical properties from LAD

Turbid-medium extinction for a canopy of randomly oriented flat elements (Nilson 1971; Ross 1981; clumping after Chen & Black 1992):
$$\kappa = G(\Omega)\,\Omega_c\,\mathrm{LAD}\quad [\text{m}^{-1}]$$
$G = 0.5$ for a spherical leaf-angle distribution; $\Omega_c \in [0.4, 0.8]$ for conifer shoots, $\approx 0.9$ for broadleaf. Voxel emissivity across a 2 m cell: $\varepsilon_v = 1 - e^{-\kappa \Delta x}$; at LAD = 2, $\Omega_c = 0.6$ → $\kappa = 0.6$ m⁻¹, $\varepsilon_v = 0.70$.

Flame emissivity from optical depth: $\varepsilon_f = 1 - e^{-k_f D}$, $D$ = flame depth (m), $k_f$ = flame absorption coefficient. Published wildland values span **0.3–1.5 m⁻¹** and are genuinely uncertain; we ship $k_f = 0.8$ m⁻¹ as default, which makes flames of depth > 3 m effectively grey-black ($\varepsilon_f > 0.9$), consistent with Àgueda et al. (2010) and Frankman et al. (2013) field radiometry. $k_f$ is one of the two knobs tuned in §7.7.

### 7.4 Radiative transfer

Grey-band, single effective wavelength. Emissive power of a flame element at $T_f$:
$$E_f = \varepsilon_f\,\sigma\,T_f^4,\qquad \sigma = 5.670374 \times 10^{-8}\ \text{W m}^{-2}\text{K}^{-4}$$
$T_f \approx 1200$ K for a wildland flame sheet → $\sigma T_f^4 = 117.6$ kW m⁻².

Irradiance at a receiving voxel from a finite emitter, with intervening leaf area:
$$G(\mathbf{x}) = \int_{A_f} \varepsilon_f \sigma T_f^4 \, \frac{\cos\theta_1 \cos\theta_2}{\pi r^2}\, \exp\!\left(-\!\int_0^r \kappa(s)\,ds\right) dA_f$$
$r$ = separation (m), $\theta_1,\theta_2$ = angles to the two surface normals, $\kappa$ = §7.3. The $1/r^2$ and the Beer–Lambert transmittance are both essential; dropping either produces the classic over-long preheating tail.

Absorbed volumetric source in the receiving voxel:
$$\dot q'''_{\text{rad}} = \kappa\,(G - 4\sigma T_s^4)\quad [\text{W m}^{-3}]$$

For the **near field** (< 30 m of the front) we do not integrate numerically. The surface flame front is already a 2D structure in the surface layer, so each active surface cell becomes a wind-tilted rectangular flame panel of height $L_f$ (Byram, §7.1) and width $\Delta s = 0.5$ m, and we use the analytic differential-element-to-rectangle view factor (Siegel & Howell):
$$F = \frac{1}{2\pi}\left[\frac{X}{\sqrt{1+X^2}}\arctan\frac{Y}{\sqrt{1+X^2}} + \frac{Y}{\sqrt{1+Y^2}}\arctan\frac{X}{\sqrt{1+Y^2}}\right],\ \ X=\tfrac{a}{c},\ Y=\tfrac{b}{c}$$

**Avoiding O(N²).** With ~5 × 10³ emitting cells and ~2.5 × 10⁶ receiving voxels, all-pairs is 1.25 × 10¹⁰ pairs × (~30 ALU + a 20-tap transmittance march ≈ 130 ops) ≈ 1.6 × 10¹² ops per step. Against a realistic ~3 TFLOP s⁻¹ sustained on a 4070 Laptop through WebGPU, that is **~0.5 s/frame. Rejected outright.**

| Method | Work per radiation step | Est. ms (4070 Laptop, WebGPU) | Verdict |
|---|---|---|---|
| All-pairs view factors | 1.6 × 10¹² ops | ~500 | Reject |
| Discrete ordinates S₈ (80 dirs) | 2 × 10⁸ cell-dir updates, but wavefront-sequential: ~(nx+ny+nz) ≈ 1088 dispatches × 80 dirs | ALU ~2 ms, **dispatch overhead 20–400 ms** | Reject — sweep dependency is pathological in WebGPU |
| SH light-propagation-volume (LPV-style, 30–60 iters) | 2.1 M cells × 6 nbrs × 4 coeff × 40 iters ≈ 2 × 10⁹ | 1–3 | Reject as transport (numerical diffusion destroys long-range through-gap IR, the exact signal we need); **keep as storage format** |
| P₁ / diffusion, $\nabla\!\cdot\!\left(\frac{1}{3\kappa}\nabla G\right) - \kappa(G - 4\sigma T^4)=0$, 20 Jacobi | 4.2 × 10⁷ cell-updates | 0.3–0.6 | Reject as primary — invalid for $\kappa \Delta x \ll 1$ (canopy gaps, crown-to-crown lines of sight). Use *inside* dense crowns only |
| **Cone-traced gather into SH volume** | 3.1 × 10⁵ active half-res cells × 8 cones × 24 mip taps ≈ 6 × 10⁷ samples | **0.6–1.2** | **Recommended** |

**Recommended pipeline** (runs at 7.5 Hz, i.e. every 4th 30 Hz canopy step, with temporal reprojection and exponential blend $\alpha = 0.35$):
1. Rasterise emission $E$ (W m⁻³) and extinction $\kappa$ into a 256×256×32 (4 m) dense pair-texture; build 5 mips (mip-averaging $\kappa$ is the standard voxel-cone-tracing approximation, Crassin et al. 2011 — it under-shadows thin gaps, accepted).
2. Per active half-res cell, march 8 cones (Fibonacci-distributed over the sphere, jittered per-frame) accumulating $L$ and transmittance; project into L1 SH (4 coefficients).
3. Per canopy voxel, evaluate SH against the local LAD anisotropy → $G$, then $\dot q'''_{\text{rad}}$.
4. Add the analytic near-field panel term (step 1's mips cannot resolve a 0.5 m flame sheet).

Cone tracing is chosen because cost is independent of emitter count, it preserves directionality through gaps (which LPV and P₁ do not), and it is a pure gather — no atomics, no sweep ordering, ideal for WebGPU.

### 7.5 Convection

The coupled wind field (see the meteorology section) carries a gas enthalpy scalar. Buoyant plume rise on the froxel grid uses the Morton–Taylor–Turner entrainment closure; for a line source of strength $I$ (kW m⁻¹) the centreline excess temperature falls as $\Delta T \propto I^{2/3} z^{-1}$ with entrainment coefficient $\alpha_e$ (**calibration knob #2**). Atmospheric stability modulates plume rise and hence how far downwind hot gas is delivered into the canopy.

**Entrainment coefficient — convention is normative.** $\alpha_e$ is defined in the **Gaussian
convention for a LINE (2D) plume**. With self-similar profiles $w(x,z) = w_c(z)\exp(-x^2/b^2)$ and
$g'(x,z) = g'_c(z)\exp(-x^2/(\lambda b)^2)$, the entrainment velocity is $u_e = \alpha_e w_c$, where
$w_c$ is the **centreline** vertical velocity and $b$ the $1/e$ velocity half-width.

$$\alpha_e = 0.11 \pm 15\,\%,\qquad \lambda = 1.2\ \text{(FIXED, not a free parameter; range 1.0–1.3)}$$

Richardson & Hunt (2022), *J. Fluid Mech.* **934**, A11, eq. (7.1) — open access, CC BY. Best single
measurement $\alpha = 0.108 \pm 2\,\%$; literature-supported spread $0.095 \le \alpha \le 0.13$.

If the implementation is written in **top-hat** form instead ($u_e = \alpha_T M/Q$, uniform
$w_T = M/Q$ over width $2b_T = Q^2/M$), the equivalent is $\alpha_T = 0.16$, via
$\alpha_T = 2^{1/4}(1+\lambda^2)^{1/4}\alpha_G = 1.486\,\alpha_G$ at $\lambda = 1.2$
(the familiar $\sqrt{2}$ factor is the $\lambda = 1$ simplification).

> **NUMERICAL TRAP.** 0.16 is *both* the correct top-hat value *and* the rejected Rouse et al. (1952)
> Gaussian value. Do not let those be conflated. Rouse et al. is itself a line-*fire* plume experiment
> whose implied Gaussian $\alpha = 0.16$ Richardson & Hunt explicitly **reject** — Chen & Rodi's (1980)
> refit of the same data gives 0.144, and R&H remove the Rouse entries from their curated list over
> concerns about the data's interpretation. 0.16 is not a live Gaussian benchmark.

**§7.7 fit bounds** (Gaussian): initial simplex point 0.11; soft bounds 0.095–0.13 (the published
envelope); hard optimiser bounds 0.090–0.140, emitting a warning if the fit lands outside the soft
bounds, since anything beyond that is outside every published line-plume measurement.

Two extrapolation notes. The two **fire-driven** datasets in R&H's curated list — Lee & Emmons (1961),
$\alpha = 0.13$; Yuan & Cox (1996), $\alpha = 0.126$ — sit at the **top** of the range, so a fit landing
in 0.115–0.13 is physically well-motivated for a fire application rather than suspicious. And
cross-wind entrainment in a bent-over plume is a genuinely different, larger closure that this
coefficient does not cover; if the model later needs it that is a new open question, not a re-tuning
of $\alpha_e$.

**Mandatory CI regression — this, not the config value, is the real defence against a convention
error.** Assert the convention-independent observables from R&H §3, which at $\alpha = 0.11$,
$\lambda = 1.2$ are $b = 0.1241z$, $\lambda b = 0.1489z$, $w_c = 2.157B_0^{1/3}$,
$g'_c = 2.743B_0^{2/3}z^{-1}$, $Q = 0.4746B_0^{1/3}z$. Test the solved plume field against these to
±5 %. A $\sqrt{2}$ convention slip fails this immediately regardless of what number sits in the
$\alpha_e$ field. A secondary diagnostic: a convention bug shows up as $\alpha_e$ railing against the
upper fit bound.

> **CLOSED — 2026-08-18.** The previous range of 0.08–0.11 was defensible in **neither** convention:
> Gaussian-shaped, but its lower half (0.08–0.095) sits below every published value, so the old prior
> actively biased the fit toward **under-entrainment** — too-tall, too-narrow, too-hot plumes and
> over-delivery of convective heat to the canopy downwind. A real bias of roughly 20–30 % at the low
> end, not a cosmetic one. Two citation errors were also corrected: the $0.11 \pm 15\,\%$ figure is
> **Richardson & Hunt (2022)**, not van Reeuwijk et al. — and it is a line-plume Gaussian value, where
> van Reeuwijk et al. (2016), *Phys. Rev. Fluids* **1**, 074301 gives an *axisymmetric top-hat*
> $\alpha_p = 0.105$. Those two numbers are similar but are different quantities for different
> geometries in different conventions; their near-agreement is coincidental and must never be used as
> cross-validation. **Status: the constant is `validated`; the model using it remains `calibrated`,**
> because $\alpha_e$ stays a fitted knob and because 0.11 applies to a *pure* line plume in a
> quiescent, unstratified environment, whereas we apply it to a wind-tilted plume from a spreading
> front in a stratified atmosphere.

Convective exchange to a fuel element, volumetric form:
$$\dot q'''_{\text{conv}} = h\,A_v\,(T_g - T_s),\qquad A_v = 2\,\mathrm{LAD}\ \text{(both leaf faces)}\ [\text{m}^2\text{m}^{-3}]$$

$h$ from Hilpert's cylinder-in-crossflow correlation, $\mathrm{Nu} = C\,\mathrm{Re}^m \mathrm{Pr}^{1/3}$, $\mathrm{Re} = u d/\nu$, $h = \mathrm{Nu}\,k_g/d$:

| Re range | C | m |
|---|---|---|
| 0.4–4 | 0.989 | 0.330 |
| 4–40 | 0.911 | 0.385 |
| 40–4 000 | 0.683 | 0.466 |
| 4 000–40 000 | 0.193 | 0.618 |
| 40 000–400 000 | 0.027 | 0.805 |

Use Churchill & Bernstein (1977) if a single continuous branchless expression is preferred in WGSL:
$$\mathrm{Nu} = 0.3 + \frac{0.62\,\mathrm{Re}^{1/2}\mathrm{Pr}^{1/3}}{\left[1+(0.4/\mathrm{Pr})^{2/3}\right]^{1/4}}\left[1+\left(\frac{\mathrm{Re}}{282000}\right)^{5/8}\right]^{4/5}$$

Worked point: pine needle $d = 1$ mm, $u = 2$ m s⁻¹, gas at 600 K ($\nu = 5.2\times10^{-5}$ m² s⁻¹, $k_g = 0.0469$ W m⁻¹K⁻¹, Pr = 0.70) → Re = 38, Nu = 3.3, **$h = 154$ W m⁻²K⁻¹**, consistent with the measured $h > 100$ W m⁻²K⁻¹ reported for sub-millimetre fuel elements.

**Why convection dominates the near field, radiation the preheating.** Take a voxel with LAD = 2 ($A_v = 4$ m² m⁻³, $\kappa = 0.6$ m⁻¹), CBD = 0.15 kg m⁻³, FMC = 100 %. Energy to ignition per 8 m³ voxel: sensible $1.2\,\text{kg}\times1500\,\text{J kg}^{-1}\text{K}^{-1}\times300\,\text{K} = 0.54$ MJ plus drying $1.2\,\text{kg}\times(4186\times80 + 2.26\times10^6) = 3.1$ MJ ≈ **3.6 MJ**.
- Immersed in 1100 K gas: $\dot q''' = 154 \times 4 \times 800 = 493$ kW m⁻³ → 3.9 MW/voxel → **~0.9 s**.
- 20 m ahead, view factor ~0.03, transmittance ~0.5: $G = 106 \times 0.03 \times 0.5 = 1.6$ kW m⁻², $\dot q'''_{\text{rad}} = \kappa G = 0.6 \times 1.6 = 0.95$ kW m⁻³ → 7.6 kW/voxel → **~470 s (~8 min)**.

Between two and three orders of magnitude apart, and that is the physical content of the statement: radiation sets up the drying front over minutes; convection does the actual ignition in seconds. Finney et al. (2015) go further and argue that intermittent buoyancy-driven convective bursts, not steady radiation, are what actually ignite fine fuels — our plume advection is deliberately unsteady (gust-modulated) to capture this.

### 7.6 Intra-particle conduction, ignition and pyrolysis

**Biot number.** $\mathrm{Bi} = h L_c / k_s$, $L_c = V/A$ ( = $d/4$ for a cylinder), $k_s \approx 0.20$ W m⁻¹K⁻¹ for moist wood across the grain. Needle $d = 1$ mm, $h = 154$: $\mathrm{Bi} = 0.19$ — **marginally thermally thick**, not the free pass usually assumed. A 6 mm twig at $h = 80$: $\mathrm{Bi} = 0.6$, clearly thick.

**Recommendation:** lumped (thermally thin) treatment for foliage and 0–3 mm with a Bi-correction factor $1/(1+\mathrm{Bi}/4)$ on the effective $h$; a 3-node radial sub-model for the 3–6 mm class only (3 extra f16 per voxel, +6 B — affordable, but only enable it in conifer/eucalypt biomes).

Thermal diffusivity $\alpha_s = k/(\rho c) = 0.20/(500 \times 1500) = 2.7\times10^{-7}$ m² s⁻¹; thermal penetration depth over 10 s is $\sqrt{\alpha_s t} = 1.6$ mm, which is the physical justification for the 3 mm class boundary.

**Ignition delay.** Thermally thick, constant net flux (Quintiere 2006):
$$t_{ig} = \frac{\pi}{4}\,k\rho c\,\frac{(T_{ig}-T_0)^2}{\dot q''^2_{\text{net}}}$$
with $k\rho c = 1.5\times10^5$ W² s m⁻⁴ K⁻², $T_{ig}-T_0 = 300$ K, $\dot q''_{\text{net}} = 50$ kW m⁻² → $t_{ig} = 4.2$ s (literature range 5–20 s for wood at that flux — we are at the fast end because $k\rho c$ for foliage is lower than for solid timber). For time-varying flux use the integral form $\int_0^{t_{ig}} \dot q''_{\text{net}}(t)\,dt \ge \sqrt{\tfrac{\pi}{4}k\rho c}\,(T_{ig}-T_0)\,\sqrt{t_{ig}}$, evaluated incrementally per voxel.

**Ignition criterion — comparison and recommendation.**

| Criterion | Pros | Cons |
|---|---|---|
| Critical temperature $T_{ig} \approx 600$ K (327 °C) | 1 comparison; free | Grid-resolution dependent; no moisture coupling; produces spurious ignition of thin, hot-but-empty voxels |
| Critical mass flux $\dot m''_{\text{crit}} \approx 2.5$ g m⁻² s⁻¹ (McAllister 2011/2013 report 1–3 g m⁻² s⁻¹, rising with external flux and oxidiser velocity) | Physically the right condition for establishing a diffusion flame; couples naturally to a pyrolysis model | Needs a pyrolysis rate to produce $\dot m''$ |
| Arrhenius single-step $\dot m = -A\,m\,e^{-E/RT}$ | Smooth, gives a real drying/pyrolysis front, gives $\dot m''$ for the above | Constants are lumped/effective, not chemistry |

**Recommended: Arrhenius mass loss for the rate, gated by critical mass flux for flaming ignition.** Voxel transitions to *flaming* when $\dot m''_{\text{pyr}} \ge 2.5$ g m⁻² s⁻¹ **and** local $O_2$ is not depleted; $T_{ig} = 600$ K is retained only as a cheap early-out.

Kinetics, three-stage (Larini et al. 1998 / Morvan & Dupuy 2004 multiphase set; $R = 8.314$ J mol⁻¹K⁻¹). **NOTE: these are NOT Grishin's (1997) values.** Grishin's own pairs are pyrolysis $A = 3.63\times10^4$ s⁻¹ with $E/R = 9\,400$ K ($E = 78.1$ kJ mol⁻¹) and evaporation $A = 6\times10^5$ K^½ s⁻¹ with $E/R = 6\,000$ K ($E = 49.9$ kJ mol⁻¹). Pick one lineage and use both members of the pair from it; do not cite Grishin (1997) for $E/R = 7\,250$ K or $5\,800$ K.

| Stage | Rate law | $A$ | $E/R$ (K) | $E$ (kJ mol⁻¹) | Heat |
|---|---|---|---|---|---|
| Free-water evaporation | $\dot m_w = -A_w m_w T^{-1/2} e^{-E_w/RT}$ | 6.0 × 10⁵ K^½ s⁻¹ | 5 800 | 48.2 | −2.26 MJ kg⁻¹ (latent) + 4186 J kg⁻¹K⁻¹ sensible to 373 K |
| Pyrolysis | $\dot m_s = -A_p m_s e^{-E_p/RT}$ | 3.63 × 10⁴ s⁻¹ | 7 250 | 60.3 | −0.42 MJ kg⁻¹ |
| Char oxidation | $\dot m_c = -A_c \rho_{O_2} \sigma \chi\, e^{-E_c/RT}$ | 430 m s⁻¹ | 9 000 | 74.8 | +32 MJ kg⁻¹ (char) |

**Honesty flag (implement as a blocking TODO):** these three $A$/$E$ pairs are the standard multiphase-wildfire set, but I could **not re-verify them from a primary source during drafting** — verify against Larini et al. (1998) and Morvan & Dupuy (2004, *Combustion and Flame*) before coding — and note that the $A$/$E$ pairing in the table above is itself the mixed-lineage case this paragraph warns against, so closing this TODO means adopting one source's pair wholesale, not patching one column. Two independent facts do check out and constrain them: di Blasi (1998), as reported in Sullivan's (2009) review, gives *true* cellulose kinetics of $E_a \approx 240$ kJ mol⁻¹ for volatilisation (endothermic ≈ 300 J g⁻¹) and $E_a \approx 150$ kJ mol⁻¹ for char formation (exothermic ≈ 1 kJ g⁻¹). The wildland values above are **four times lower in $E$ and are therefore effective, not mechanistic** — they are tuned so the reaction proceeds over the right temperature window at coarse spatial resolution. Never mix $A$ from one study with $E$ from another: the kinetic compensation effect makes them a correlated pair, and doing so shifts the pyrolysis onset by hundreds of kelvin.

**Moisture as heat sink and the drying front.** Per voxel, free water at $T < 373$ K absorbs $c_w \Delta T$ ($c_w = 4186$ J kg⁻¹K⁻¹); at 373 K it absorbs $L_v = 2.26$ MJ kg⁻¹ with the solid temperature pinned (all incoming enthalpy goes to phase change) until $w_{\text{free}} = 0$. Bound water (below fibre saturation, ~30 % MC) requires an extra desorption enthalpy of ~0.3 MJ kg⁻¹ and is released over 373–450 K rather than isothermally. Because the temperature pin is per-voxel and radiation is long-range, a **drying front runs ahead of the thermal front** by several voxels — this is the mechanism that lets the model reproduce the empirical fact that low-FMC crowns ignite at much lower surface intensity, and it is what $I_0$ is a curve fit to.

**Time integration.** The lumped convective ODE has $\tau = \rho_s c_s (V/A)/h = 500 \times 1500 \times 2.5\times10^{-4}/154 = 1.2$ s. Explicit Euler at 30 Hz is stable but marginal at high $h$; use the exponential integrator $T^{n+1} = T_g + (T^n - T_g)e^{-\Delta t/\tau}$, which is unconditionally stable and lets us drop to 10 Hz for distant voxels (LOD by distance-to-front).

### 7.7 Calibration bridge: making the 3D physics agree with Rothermel

The failure mode to design against is two solvers fighting: the Rothermel-calibrated surface layer says the head fire moves at 12 m min⁻¹, the 3D canopy independently drives surface fuel ignition and says 20 m min⁻¹, and the result is neither physics nor calibration.

**Coupling contract (asymmetric by design).**
- **Surface → canopy (full):** each active surface cell exports $I_B = H\,w\,R$ (kW m⁻¹), residence time, flame length $L_f$, and tilt. These define (a) the radiative flame panel of §7.4 and (b) the plume enthalpy source $\dot Q = I_B\,\Delta s$ injected into the wind field.
- **Canopy → surface (bounded, two channels only):**
  1. Burning crown voxels add downward radiant + convective flux to the surface fuel. This enters the surface model **not** as a ROS multiplier but as a reduction in the heat of pre-ignition $Q_{ig}$ in the Rothermel denominator, bounded so that the resulting ROS never exceeds $R_{\text{crown}}$ from the canopy front. This is the only correct place to inject it: Rothermel already contains the surface flame's own radiation implicitly, and adding a second radiation term at the same length scale double-counts.
  2. Firebrand ignitions, which are discrete new ignition points and cannot double-count.
- Everything else is one-way. The canopy never overrides surface ROS.

**Calibration procedure (offline, per biome, results frozen into a JSON constants table shipped with the build).**
1. Construct 1D "calibration stands": flat, uniform surface fuel model (FM 10 / GR2 / SH7 / Vesta / UK-gorse), uniform CBD, CBH, FMC, steady wind, no terrain.
2. Sweep 20-ft/10-m wind to sweep $I_{\text{surf}}$ across two decades. Record the **emergent** initiation intensity $\hat I_0$ = lowest $I_{\text{surf}}$ at which any canopy voxel reaches the flaming gate of §7.6.
3. Fit **exactly two** free parameters — the flame-sheet absorption coefficient $k_f$ (§7.3) and the plume entrainment coefficient $\alpha_e$ (§7.5) — by offline Nelder–Mead minimising
$$J = \sum_{\text{CBH} \times \text{FMC}} \left[\ln \hat I_0(\text{CBH},\text{FMC}) - \ln I_0(\text{CBH},\text{FMC})\right]^2$$
over CBH ∈ {0.5, 1, 2, 3, 5, 8} m × FMC ∈ {80, 100, 120, 140} %. Two parameters against 24 targets — this is a genuine fit, not an interpolation.
4. Separately sweep CBD ∈ {0.05 … 0.40} kg m⁻³ at wind sufficient for crowning and fit **one** parameter, the crown-to-crown radiative coupling range multiplier, so that the emergent transition from intermittent to continuous crown involvement occurs at $R_{\text{crown}} = 3.0/\mathrm{CBD}$ ± 20 %.
5. Ship as CI regression tests: $|\ln \hat I_0 - \ln I_0| < 0.14$ (±15 %) across the 24-point grid, and the CBD threshold within ±20 %. Any commit that moves the canopy physics must re-pass.
6. **Biomes outside the Van Wagner envelope** (chaparral, eucalypt, UK gorse/heather) skip steps 3–4 and instead fit $k_f$, $\alpha_e$ against observed head-fire ROS: Anderson et al. (2015) for chaparral, Cheney et al. (2012) / Project Vesta for eucalypt, and — with an explicit "extrapolated" badge in the HUD — Rothermel SH/GR analogues for UK gorse, where no crown-fire dataset exists.

The result is a model where the surface ROS is Rothermel's by construction, the crown thresholds are Van Wagner's by calibration, and everything between them — 3D preheating geometry, plume tilt, torching under a gust, spotting — is emergent.
