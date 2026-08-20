## 7. Rendering, Procedural Content & Audio

Target: 2560×1440, 60 Hz (16.67 ms). Budget split is **11.5 ms render / 4.5 ms simulation compute / 0.7 ms slack** on the RTX 4070 Laptop. All timings below are engineering estimates derived from published costs for equivalent techniques on desktop Ada parts, uplifted ~25–30 % for Dawn/WebGPU command overhead and browser compositing. They are **not measured** and must be re-baselined in M4.

---

### 7.1 Volumetric fire and smoke

> **NORMATIVE — the volumetric/particle trade, and its one hard condition.**
>
> Per §0.5.1: **build the top end first, then expose a slider.** The full froxel raymarch is
> written first and is the reference implementation — level 5 is the thing every cheaper tier
> is measured against, and it cannot be a fallback from something that was never built.
>
> The project owner's direction for this section is the **degradation path**, not the
> starting point: where volumetrics cost the frame rate, **soft particles are preferred over
> fighting to keep the raymarch**. So M4 must be built so the volumetric pass can shrink or
> drop out entirely without the image falling apart — but it is built, and built properly,
> first.
>
> **The condition, which is not negotiable: particles must remain SIM-DRIVEN.**
>
> "Soft particles" describes a change of *integration method* — billboard splatting instead
> of froxel raymarching — not a change of *data source*. A particle system is cheap and
> perfectly legitimate here as long as every property it renders is read from the simulation:
>
> | Particle property | Read from |
> |---|---|
> | Spawn rate and position | Fireline intensity and the active-cell set (`IFireOutputs`) |
> | Colour and brightness | Blackbody Planck curve at the local **computed** temperature |
> | Opacity / density | Computed soot field |
> | Velocity | The plume and wind velocity fields, not authored curves |
> | Lifetime and fade | Residence time and the burnout curve |
>
> Built that way, the cheap path is still an expression of the physics; the renderer merely
> integrates it more coarsely. Built the other way — authored spawn rates, hand-tuned colour
> ramps, noise-driven motion — it becomes a decorative layer that can disagree with the
> simulation, and the project's central claim goes with it. **The volumetric pass is not what
> makes the picture honest; the data source is.** That distinction is what makes this trade
> safe to take.
>
> **Recommended tier structure** (quality levels per §6.7 of the architecture doc):
>
> | Level | Smoke column | Near-field flame |
> |---|---|---|
> | 4–5 | Full froxel raymarch of the soot/temperature fields | Particles + flame sheets |
> | 2–3 | Reduced-resolution froxel, fewer march steps, longer temporal reuse | Particles |
> | 0–1 | **Particles only** — splatted, sorted, soft-depth, sim-driven | Particles |
>
> The plume column is the part that most needs volume, because it is large, translucent and
> viewed against the sky; near-field flame is the part particles serve best, because it is
> small, bright and detail-rich. If something must be cut first, cut march steps and froxel
> resolution before cutting the near-field layer.
>
> **Accept and record the error.** Splatted particles lose correct ordered self-occlusion
> within the plume and correct in-scatter between smoke and fire. State that bound in the
> model's `ModelProvenance`; do not present the cheap tier as the physically-integrated one.
> The HUD already annotates exports taken at degraded quality (§6.7), and this is exactly the
> case that mechanism exists for.

#### 7.1.1 Froxel volume

Frustum-aligned voxel grid, 16×16 px tiles → **160 × 90 × 128** froxels = 1.84 M. Storage `rgba16float` (scattered radiance RGB + extinction σ_t) = 14.7 MB, plus integrated result (14.7 MB) and one history buffer (14.7 MB) ⇒ **44 MB**.

Depth distribution is piecewise: linear near-field so the fire front is not smeared, exponential far-field so the plume top stays in range.

$$z(s)=\begin{cases} z_0 + (s/N_1)\,(z_1-z_0), & s<N_1\\[2pt] z_1\left(z_f/z_1\right)^{(s-N_1)/(N-N_1)}, & s\ge N_1\end{cases}$$

with $z_0=0.5$ m, $z_1=64$ m, $z_f=1024$ m, $N_1=64$, $N=128$. Near slices are 1.0 m thick; far slices grow by 4.4 %/slice (2.8 m at 64 m, 44 m at 1 km). Beyond $z_f$ a quarter-res analytic raymarch of the same 3D fields covers the horizon plume.

#### 7.1.2 Population from sim fields

The sim exposes three 3D textures over the 1 km domain: **total dry smoke aerosol mass concentration** $\rho_s$ (kg m⁻³, `r16float`), the **aerosol composition scalar** $f = m_{EC}/(m_{EC}+m_{OC})$ (–, `r16float`), and gas temperature $T$ (K, `r16float`), all on the 2 m canopy lattice (512×512×64) with a 4 m coarse mip for the far field. Each froxel centre $\mathbf{p}$ trilinearly samples all three, after a divergence-free detail warp:

$$\mathbf{p}' = \mathbf{p} + A\,\nabla\times \mathbf{N}\!\left(\mathbf{p}/L + t\,\mathbf{u}\right)$$

$A=1.2$ m (warp amplitude), $L=6$ m (noise length scale), $\mathbf{u}$ = local wind unit vector, $\mathbf{N}$ = 3-channel value noise. This adds sub-voxel structure without inventing mass — it displaces, it does not create.

Extinction, per RGB channel $c$:

$$\sigma_{t,c} = K_{550}\,\rho_s\left(\frac{550\,\text{nm}}{\lambda_c}\right)^{\alpha},\qquad \sigma_{s,c}=\omega_{0,c}\,\sigma_{t,c},\ \ \sigma_{a,c}=(1-\omega_{0,c})\,\sigma_{t,c}$$

Single-scattering albedo is keyed on **aerosol composition**, not on distance to flame and not on biome:

$$\omega_{0,R}=\mathrm{clamp}(0.985-1.042f,\,0,\,1),\quad \omega_{0,G}=\mathrm{clamp}(0.981-1.018f,\,0,\,1),\quad \omega_{0,B}=\mathrm{clamp}(0.935-0.920f,\,0,\,1)$$

| Symbol | Value | Units | Source / note |
|---|---|---|---|
| $K_{550}$ | 4400 (range 4050–4700) | m² kg⁻¹ | **Mass basis: total dry smoke PM.** Reid et al. (2005, ACP 5:827–849) Table 5 p. 843 gives total mass extinction efficiency $\sigma_s+\sigma_a$ at 550 nm for all eight fresh/aged × biome columns: 4.05–4.70 m² g⁻¹, mean 4.4 — remarkably invariant across biome and age. Combustion phase moves the $\sigma_s/\sigma_a$ **split**, not the total. Scaled to 633 nm at $\alpha$ = 1.76 this is ≈3440 m² kg⁻¹, consistent with the 3500–5000 band quoted for mixed wildland smoke. Use $K_{633}$ = 8700 ± 1100 m² kg⁻¹ **only** if $\rho_s$ is strictly the EC/soot component (NIST SP 1018-1 §9 p. 89, text following Eq. 9.6, citing Mulholland & Croarkin 2000) — applied to total smoke PM it makes the plume ≈2× too opaque, because wildland smoke is >90 % organic (Kleinman et al. 2020, ACP 20:13319, Abstract). |
| $\alpha$ | 1.76 | – | Extinction Ångström exponent. Sayer et al. (2014, ACP 14:11493–11523) Table 4 p. 11501, ten-site mean: $\alpha$ = 1.95, 1.42, 1.91, 1.88, 1.89, 1.62, 1.66, 1.97, 1.54, 1.74 (range 1.42–1.97, mean 1.758). This value also makes the scheme self-consistent in absorption: $\alpha$ = 1.76 combined with the per-channel $\omega_{0}$ fits reproduces Pokhrel et al. (2016) Fig. 4d's independent AAE($f$) fit to within 5 % over $f$ = 0.08–0.40, so brown-carbon reddening of $\sigma_a$ falls out with no separate exponent to evaluate. Sayer's Table 4 caption notes these are computed at $\tau_{f,550}$ = 0.5, $\tau_{c,550}$ = 0.03 and will vary with AOD. |
| $\lambda_{R,G,B}$ | 600, 550, 450 | nm | |
| $f$ | 0.22 emitted by flaming mass loss; 0.08 by smouldering | – | $f = m_{EC}/(m_{EC}+m_{OC})$, a conserved mass ratio of two advected scalars. Endmembers from Reid et al. (2005) §2.4 p. 834, at 550 nm per unit dry PM: flaming-dominated $\sigma_s$ = 3.4, $\sigma_a$ = 1.1 m² g⁻¹ ⇒ $\omega_0$ = 0.75 ("we would expect a mean $\omega_0$ value of 0.75"); smouldering-dominated $\sigma_s$ = 3.7, $\sigma_a$ = 0.4 m² g⁻¹ ⇒ $\omega_0$ = 0.90. Inverting those through the Pokhrel 532 nm fit gives the source-term values 0.22 and 0.08. |
| $\omega_{0,c}$ | $0.985-1.042f$ (R), $0.981-1.018f$ (G), $0.935-0.920f$ (B) | – | Pokhrel et al. (2016, ACP 16:9549–9561) Fig. 4a–c p. 9555, in-panel fits over 12 fuels / 41 burns: SSA(405) = 0.91 − 0.87$f$ ($r$ = −0.97), SSA(532) = 0.98 − 1.01$f$ ($r$ = −0.97), SSA(660) = 0.99 − 1.07$f$ ($r$ = −0.96), all constrained to SSA ≤ 1 (§3.2). Coefficients linearly interpolated to the channel wavelengths above; the interpolation is ours, the coefficients are theirs. Composition is the right key because flaming emits EC-rich and smouldering OC-rich aerosol (Pokhrel §3.1). |
| $g$ | 0.63 ± 0.06 | – | Single value, no biome split and no $f$-dependence. Reid et al. (2005) Table 5 p. 843 fresh-smoke $g$: grass/savanna 0.55 ± 0.06, tropical 0.59 ± 0.06, temperate/boreal 0.60 ± 0.06 — the biome spread (0.05) is smaller than the stated uncertainty, so a biome split in $g$ is not resolved by the data. Sayer et al. (2014) Table 4 ten-site means g(440) = 0.689, g(675) = 0.641 give aged 0.687/0.667/0.656 for B/G/R; Reid §5 p. 844 puts fresh smoke 0.02–0.04 below the aged climatology ⇒ 0.657/0.637/0.626 per channel if a per-channel $g$ is wanted. Near-source $g$ remains genuinely uncertain (Ahern et al. 2025 find real refractive indices larger than commonly assumed). |

The $\lambda^{-\alpha}$ dependence is what reddens everything seen through the plume — it is not a special case, it falls out of per-channel extinction.

**Implementation trap:** never blend $\omega_0$ itself as a mass-weighted scalar. It is a ratio, and mass-averaging ratios is wrong. Mix $\sigma_s$ and $\sigma_a$ separately, or mix $f$ — which is a proper mass ratio — and form $\omega_0 = \sigma_s/(\sigma_s+\sigma_a)$ afterwards.

**No aging term is carried,** because the domain is entirely fresh smoke (see the callout below). If the domain is ever extended past ~1 h of plume travel, the correct term is a **scattering-only** growth: Kleinman et al. (2020) Abstract report that "as absorption remained nearly constant with age, the time evolution of single scatter albedo was controlled by age-dependent scattering", with mass scattering efficiency increasing 56 % in 2 h (σ = 20 %, range 33–97 %, §4.3 p. 13332). Over ≤17 min that is <8 % on $\sigma_s$ and is neglected. It is never an $\omega_0$ ramp.

**Fallback if the solver cannot split flaming from smouldering per cell:** use Pokhrel et al. (2016) Table 1 p. 9554, SSA $= k_0 + k_1\,\mathrm{MCE}^{k_2}$ with $(k_0,k_1,k_2)$ = (0.920, −0.632, 26.877) at 405 nm, (0.933, −1.637, 58.492) at 532 nm, (0.941, −1.687, 56.45) at 660 nm — measurably inferior ($r$ = 0.64 vs 0.96) and biased worst at MCE > 0.92, where SSA changes fastest. Failing that, a single fresh-smoke $\omega_0$(550) = 0.85 (midpoint of Kleinman et al. 2020's measured near-fire 0.8–0.9), whose stated bias is too bright over the flame front and too dark in the smouldering tail. The 0.70-at-30 m rule is not a fallback under any branch: it is unsourced in magnitude and refuted in mechanism.

> **CLOSED — literature, 2026-08-19.** The distance switch and the biome switch are both **deleted**; one composition-keyed rule replaces them, and nothing branches.
>
> **What was wrong.** (1) The 30 m threshold is refuted as a mechanism, not merely uncited. Measured aging is far too slow to produce any variation inside a 1 km domain: Reid et al. (2005) §2.4 p. 834, citing Abel et al. (2003), give "an increase in $\omega_0$ by 0.04 in two hours … and by 0.06 in 5 hours"; Reid §5 p. 843 defines fresh smoke as ≤5 min old and aged smoke as an hour to several days. A 1 km domain at 1–10 m s⁻¹ is crossed in 1.7–17 min, so the **whole domain is fresh smoke** and the aging-driven change in $\omega_0$ across it is <0.01 — below `r16float` quantisation. The spec had the regimes inverted, using aged column values as the default and fresh only within 30 m. (2) The biome split is deleted outright: Pokhrel et al. (2016) Abstract states that "SSA and AAE cannot be directly predicted based on fuel type because they depend strongly on burn conditions." Biome enters only upstream, through how much flaming vs smouldering a fuel produces. (3) The old magnitudes were 0.06–0.07 too **high** because they were aged column-AERONET values applied to a fresh-smoke domain; the ordering (conifer brighter than grass) was correct in sign.
>
> **Corrected values.** $\omega_0$ is now the per-channel linear function of $f$ tabulated above (Pokhrel et al. 2016 Fig. 4a–c, $r$ = 0.94–0.97 over 12 fuels and 41 burns), driven by endmembers $f_{src}$ = 0.22 flaming / 0.08 smouldering (Reid et al. 2005 §2.4 p. 834). Directly over an active flame front $f \to 0.22$ and $\omega_0$(550) → **0.76**, not 0.70 — the near-flame darkening the spec wanted, now sourced, continuous, and with no 30 m cliff. Independently, Kleinman et al. (2020) Abstract measured near-fire SSA of 0.8–0.9 across nine wildfire flights, with the lowest fresh-smoke values 0.8–0.85 (§4.3 p. 13332–13333). Also corrected here: $\alpha$ 1.6 → **1.76** (Sayer ten-site mean, and the value that makes $\sigma_a$'s wavelength dependence self-consistent), $K$ rebased to **$K_{550}$ = 4400 m² kg⁻¹ per unit total dry smoke PM** (Reid Table 5), and $g$ 0.65 → **0.63 ± 0.06** (Reid Table 5 fresh-smoke values; 0.65 was inside the band but was the aged figure).
>
> **Calibration target — a check on the solver, not a value to hardcode.** With correct flaming/smouldering behaviour a grass fire should land at effective $f \approx 0.16$ ⇒ $\omega_0$(550) ≈ 0.82, and a conifer/boreal fire with heavy duff smouldering at $f \approx 0.10$ ⇒ $\omega_0$(550) ≈ 0.88. Those reproduce Reid Table 5's measured fresh-smoke values (grass/savanna 0.821 ± 0.05, temperate/boreal 0.88 ± 0.05) as an **emergent** result rather than a switch.
>
> **Cost:** one extra `r16float` field over the 2 m lattice. Two shader FMAs replace the distance test and the biome branch.
>
> **Validation status (§0.7.3).** The smoke optical model is **`calibrated`**: $\alpha$ = 1.76, $K_{550}$ = 4400 and the $\omega_0(f)$ coefficients are all traced to obtainable primary sources with page citations, but the assembled model — solver flaming/smouldering split → $f_{src}$ → rendered $\omega_0$ — has no benchmark dataset behind it, and the mapping from the solver's mass-loss split to $f_{src}$ is a project-side calibration against the two targets above. $\alpha$ and $K_{550}$ are promoted to `validated` when the two-target check lands in `test/validation/` as an automated assertion; until then the whole model carries the lower status. $g$ = 0.63 ± 0.06 is **`estimated`** and is tracked separately below.
>
> **Sources.** Pokhrel, R. P., et al. (2016), *Parameterization of single-scattering albedo (SSA) and absorption Ångström exponent (AAE) with EC/OC for aerosol emissions from biomass burning*, ACP 16:9549–9561, Fig. 4 p. 9555, §3.1–3.2, doi:10.5194/acp-16-9549-2016. Reid, J. S., et al. (2005), ACP 5:827–849, §2.4 p. 834, §5 pp. 843–844, Table 5 p. 843, doi:10.5194/acp-5-827-2005. Kleinman, L. I., et al. (2020), *Rapid evolution of aerosol particles and their optical properties downwind of wildfires in the western US*, ACP 20:13319–13341, Abstract and §4.3 pp. 13332–13333, doi:10.5194/acp-20-13319-2020. Sayer, A. M., et al. (2014), ACP 14:11493–11523, Table 4 p. 11501, doi:10.5194/acp-14-11493-2014. McGrattan, K., et al., *Fire Dynamics Simulator Technical Reference Guide, Vol. 1*, NIST SP 1018-1, §9 p. 89.

> **OPEN QUESTION (unverified):** $g$ is the residue. Reid et al. (2005) §5 p. 844 states plainly that the asymmetry parameter "has never been measured directly and presented in the literature" and that the published values rest on a few backscatter-ratio measurements; the one modern direct measurement, Ahern et al. (2025, *J. Geophys. Res. Atmos.* 130, e2024JD042091, doi:10.1029/2024JD042091), is paywalled with no free equivalent found in the NOAA CSL FIREX-AQ publication list, the NOAA institutional repository, NASA ESD/ESPO mirrors or preprint servers, so its finding of larger-than-assumed real refractive indices could not be checked. $g$ = 0.63 is therefore **`estimated`** per §0.7.3, and no other number in this section may be derived from it. Its ± 0.06 band is wide enough to absorb a moderate revision, which bounds the exposure. Close it by obtaining Ahern et al. (2025) or an agency-report equivalent. Separately and **not** an open question: a distance- or metre-scale-plume-age-resolved near-flame SSA profile does not exist in the free literature and is closed as unanswerable-as-posed — the region is inaccessible to aircraft and too hot and optically thick for in-situ extinction cells and photoacoustic instruments, so the finest published resolution is combustion-phase (Reid 2005) or 5–60 min plume age (Kleinman 2020). The composition-keyed rule above replaces it and is measurable and measured.

**WebGPU constraint (important):** `r8unorm` and `r16float` are **not** core WebGPU storage-texture formats. The core storage-texture set is `rgba8unorm`/`snorm`/`uint`/`sint`, `rgba16uint`/`sint`/`float`, `r32uint`/`sint`/`float`, `rg32uint`/`sint`/`float`, `rgba32uint`/`sint`/`float` (plus `bgra8unorm` via the `bgra8unorm-storage` feature). `r8unorm` and `r16float` gain read-only/write-only storage access only with the optional `texture-formats-tier1` feature, and read-write only with `texture-formats-tier2`. Every compute-written volume in this section is therefore conditional: the `r16float` soot/composition/temperature fields above, the 128³ `r8unorm` sun-transmittance volume (§7.1.4), and the `r8unorm` per-tree profile and `r8` canopy voxel state (§7.6). We either (a) request `texture-formats-tier1` where available, (b) fall back to `r32float` for compute-written volumes (128³ sun transmittance → 8 MB, sim soot/T fields → 2× the stated footprint), or (c) write the `r8unorm`/`r16float` volumes as render attachments layer-by-layer, which is core-legal since both are RENDER_ATTACHMENT-capable. This is the same class of API-limit constraint as the `multiDrawIndirect` case in §7.4 and is treated the same way: no core-path dependency on an optional feature.

> **CLOSED — measured 2026-08-18.** The survey this called for has been run, by the boot
> path in `src/main.ts`, which reports adapter feature availability on every launch.
>
> On the target Windows 11 / Chromium configuration, **every optional feature we want is
> available — including on the weaker adapter.** The survey was taken on the machine's
> Intel UHD (gen-12lp) iGPU, not the RTX 4070, which makes it a lower bound: `timestamp-query`,
> `float32-filterable`, `shader-f16`, `texture-formats-tier1`, `texture-formats-tier2`,
> `subgroups` and `indirect-first-instance` were all granted.
>
> **Decision: take path (a).** Request `texture-formats-tier1` and use the `r8unorm` /
> `r16float` storage path. Every footprint quoted in §7.1.2, §7.1.4 and §7.6 stands as
> written; the `r32float` fallback is not needed and is not carried in the VRAM budget.
> Two consequences beyond this section: `shader-f16` is available, so the half-precision
> ALU and bandwidth savings assumed elsewhere are real rather than conditional; and
> `subgroups` is available, so the faster prefix-sum path for active-cell compaction in
> `10-webgpu-architecture.md` §6.4 is the default rather than the optimistic branch.
>
> The fallback paths (b) and (c) are retained in the text above and must still be
> implemented, because feature availability is a property of the user's adapter, not of
> ours — but they are now the contingency, not the expected case. The boot report is the
> mechanism that makes a downgrade visible rather than silent.

#### 7.1.3 Blackbody emission

Spectral radiance:

$$B_\lambda(T)=\frac{2hc^2}{\lambda^5}\left[\exp\!\left(\frac{hc}{\lambda k_B T}\right)-1\right]^{-1}\ \ \left[\text{W m}^{-2}\text{sr}^{-1}\text{m}^{-1}\right]$$

with $h=6.62607015\times10^{-34}$ J s, $c=2.99792458\times10^{8}$ m s⁻¹, $k_B=1.380649\times10^{-23}$ J K⁻¹; equivalently $c_{1L}=2hc^2=1.1910429\times10^{-16}$ W m² sr⁻¹ and $c_2=hc/k_B=1.438777\times10^{-2}$ m K.

**Practical approximation — recommended:** *do not* evaluate Planck at runtime, and *do not* use the Kang et al. (2002) Planckian-locus cubic fit (Kang, Moon, Hong, Lee, Cho & Kim, *J. Korean Phys. Soc.* 41(6):865–871), whose stated validity range is 1667–25000 K — smouldering combustion at 800–1100 K sits below it. Instead, at load time integrate numerically against the CIE 1931 2° colour-matching functions over 380–780 nm at 5 nm steps:

$$X=\int \bar{x}(\lambda)\varepsilon_\lambda B_\lambda(T)\,d\lambda,\quad\text{likewise }Y,Z$$

normalise to unit luminance, convert XYZ→linear sRGB (sRGB D65 matrix), and store 256 entries over $T\in[500,2500]$ K in a 1D `rgb9e5ufloat` LUT (3 kB, one texture fetch). Absolute magnitude is restored by the Stefan–Boltzmann law, $\sigma_{SB}=5.670374419\times10^{-8}$ W m⁻² K⁻⁴.

Volumetric emission source per froxel:

$$S_{e,c} = \sigma_{a,c}\,\frac{\sigma_{SB}T^4}{\pi}\,\mathbf{C}(T)\qquad\left[\mathrm{W\,m^{-3}\,sr^{-1}}\right]$$

with $\mathbf{C}(T)$ the LUT chroma. This is a true volumetric source and is fed into the §7.1.4 integral as $S = S_e + S_{scat}$. If the slab form $L_e = \varepsilon_c\,\sigma_{SB}T^4\,\mathbf{C}(T)/\pi$ with $\varepsilon_c = 1-\exp(-\sigma_{a,c}\,\Delta s)$ and $\Delta s$ the slice thickness (m) is preferred instead, note that it is an *already-integrated radiance* (W m⁻² sr⁻¹) and must be accumulated directly as $L \mathrel{+}= T\,L_e$, never passed through $(S - S e^{-\sigma_t d})/\sigma_t$ — doing so multiplies it by the slice thickness a second time, which with the §7.1.1 depth distribution ($d$ = 1.0 m near-field to ~44 m at 1 km) overbrightens the far plume by up to ~44× and gets the near/far brightness ratio wrong by the slice-thickness ratio.

Absorption rises toward the blue faster than extinction does, because $\omega_{0,B} < \omega_{0,G} < \omega_{0,R}$ compounds with $\sigma_t\propto\lambda^{-1.76}$: the effective absorption Ångström exponent implied by §7.1.2 runs ≈3.4 at $f$ = 0.08 to ≈1.8 at $f$ = 0.40, matching Pokhrel et al. (2016) Fig. 4d's independent AAE($f$) fit to within 5 % and tending to AAE = 1 for pure black carbon as Bond & Bergstrom (2006) §9.1 recommend. So the emission is stronger in blue, an optically thin flame is *bluer* than a blackbody and a thick one saturates to grey-body — this reproduces the observed thin-blue-base / thick-orange-core structure for free, and the smouldering tail is the bluest-absorbing (reddest-transmitting) smoke in the scene.

| Combustion regime | Gas/particle T (K) | Perceived colour | Notes |
|---|---|---|---|
| Glowing char, smouldering duff | 800–1100 | Dull cherry → deep orange-red | Below Kang-fit validity; LUT required |
| Grass / litter surface flaming | 1100–1350 | Orange | |
| High-intensity surface, shrub | ~573–1373 | Orange-yellow at base, dull red at tip | Dry-eucalypt fires: maximum ~1100 °C (1373 K) at the flame base, decaying exponentially with normalised height to ~300 °C (573 K) at the visible flame tip (Wotton et al. 2012, IJWF 21:270–281) |
| Active crown fire, transient peaks | 1300–1600 | Yellow, white-cored | ICFME crown-fire gas temperatures 1073–1473 K |

**Stated limit:** real wildland flame spectra are not thermal continua. They carry Na-D (589 nm) and K (766/770 nm) alkali lines and C₂ Swan bands from biomass, which is part of why wildland flame reads orange rather than the yellow-white a 1400 K greybody predicts. We add a small fixed additive Na/K tint (weight ≤ 0.06 of peak emission) that is **calibrated against photographs, not spectroradiometry**. This is the least defensible part of the emission model and should be labelled as such in the UI.

#### 7.1.4 Scattering and integration

Henyey–Greenstein:

$$p(\cos\theta)=\frac{1}{4\pi}\frac{1-g^2}{\left(1+g^2-2g\cos\theta\right)^{3/2}}$$

$\theta$ = angle between incoming and outgoing directions (rad), $g=0.63$ per §7.1.2 (Reid et al. 2005 Table 5 p. 843, fresh smoke; `estimated` status — see the open question there). Single HG is chosen over dual-lobe or Draine: the measured smoke $g$ is well inside the range where single HG matches Mie closely, and it costs one `pow`.

Two in-scatter terms per froxel: (i) **sun** — irradiance $E_\odot=1361\,\mathrm{W\,m^{-2}}$ attenuated by a dedicated 128³ `r8unorm` sun-transmittance volume over the domain (2 MB, one compute pass marching along sun-aligned rows, 0.15 ms — subject to the storage-format constraint in §7.1.2) multiplied by the CSM tap for solid geometry shadowing; (ii) **fire** — the ≤ 8 brightest representative lights from the cluster list of §7.2, each evaluated with the same HG lobe. Fire-lit smoke is the single most important visual cue in a night burn and cannot be faked with ambient.

Front-to-back integration uses the analytic per-slice form (Hillaire 2015):

$$L \mathrel{+}= T\cdot\frac{S-S\,e^{-\sigma_t d}}{\sigma_t},\qquad T \mathrel{*}= e^{-\sigma_t d}$$

$S$ = per-slice source (emission + in-scatter, W m⁻³ sr⁻¹), $d$ = slice length (m), $T$ = running transmittance.

#### 7.1.5 Temporal reprojection without ghosting

Jitter the slice depth by a per-frame Halton(2,3) offset $\xi\in[0,1)$ of one slice and reproject the previous frame's froxel through the previous view-projection. Baseline blend $\alpha=0.06$. Three anti-ghosting mechanisms, in order of importance:

1. **Sim-driven reactivity.** The simulation already knows where it is changing. Export a per-voxel $|\partial T/\partial t|$; set $\alpha = \max(0.06,\ \min(0.8,\ |\partial T/\partial t| / 100\ \mathrm{K\,s^{-1}}))$. A fast-moving head fire self-disables history. This is strictly better than any screen-space heuristic and is only available because we own the solver.
2. **Neighbourhood variance clipping** (Salvi 2016, *An Excursion in Temporal Supersampling*) of history against the 3×3×1 froxel box mean ± 1.25σ in the current frame, performed in YCoCg after Karis (2014).
3. **Extinction disocclusion**: if $|\sigma_t-\sigma_t^{prev}| / (\sigma_t+\sigma_t^{prev}+10^{-4}) > 0.25$, force $\alpha=0.6$.

#### 7.1.6 Budget (1440p, "high")

| Pass | ms |
|---|---|
| Froxel injection (soot/$f$/T sample + curl warp) | 0.45 |
| Sun-transmittance volume 128³ | 0.15 |
| Scattering eval (sun + ≤8 fire lights + CSM tap) | 1.60 |
| Temporal resolve + z-integration | 0.35 |
| Full-res apply/composite | 0.25 |
| Far-field raymarch (>1024 m, quarter res) | 0.30 |
| **Total** | **3.10** |

Quality lever: 128 → 96 → 64 slices reduces this to 2.4 / 1.7 ms.

---

### 7.2 Fire lighting the scene

**Recommendation: GPU light aggregation + clustered forward shading + a slow irradiance volume for bounce.** Rejected: shadow-mapped point lights (256 cube maps is impossible), and pure irradiance-volume-only (too coarse for the sharp near-field falloff at a flame front).

**Aggregation.** Each active surface cell / canopy voxel emits radiant power

$$P_i = \chi_{rad}\,\dot{m}_i\,h_c \quad[\mathrm{kW}],\qquad h_c = 18{,}600\ \mathrm{kJ\,kg^{-1}}$$

$\dot m_i$ = mass consumption rate (kg s⁻¹), $h_c=18{,}600$ kJ kg⁻¹ (Rothermel 1972 low heat content, = 8000 Btu lb⁻¹) — note kg s⁻¹ × kJ kg⁻¹ yields **kW**, not W; use $h_c = 1.86\times10^{7}$ J kg⁻¹ if $P_i$ in W is wanted. $\chi_{rad}=0.25$ (radiative fraction; measurements for wildland fuels span 0.10–0.35 — Frankman et al. 2013 — and this is a genuine uncertainty affecting both lighting and the physics' radiative term, so it is one shared constant, not two). Cells are binned into 8 m cells, a power-weighted centroid and total $P$ computed by atomics, then the top **256** by $P/r^2$ are kept in a compact light buffer. Each is a sphere light of radius $r=(3V/4\pi)^{1/3}$ with chroma from the same $\mathbf{C}(T)$ LUT — geometry, physics and lighting all read one table.

**Clustering.** 32×18×32 = 18,432 clusters, exponential depth, standard Olsson et al. 2012 build. Average 6 lights/cluster in a heavy burn.

**Occlusion.** No shadow maps. Instead, 8 fixed steps of the 2 m canopy opacity volume from the shading point toward each of the 4 nearest lights, at half res with bilateral upsample. This gives correct trunk-shadowing and canopy dapple; it does **not** give sharp contact shadows, which is an accepted approximation.

**Bounce.** 32×32×16 irradiance volume over the domain, 2-band SH (4 RGB coefficients, `rgb9e5` ×4 = 262 kB), 1/8 of probes updated per frame in round-robin ⇒ full refresh in 8 frames = 0.13 s at 60 fps. Adequate because indirect fire bounce is diffuse and slow. (If a 0.5 s refresh is what is wanted for cost reasons, update 1/30 of the probes per frame instead.)

| Pass | ms |
|---|---|
| Cell binning + top-256 selection | 0.10 |
| Cluster build + light assignment | 0.25 |
| Added per-pixel shading cost (6 lights avg) | 0.60 |
| Volumetric-opacity light occlusion (half res) | 0.40 |
| Irradiance volume slice | 0.10 |
| **Total** | **1.45** |

---

### 7.3 Near-field flame detail

Two sub-layers, both **driven by** solver state, not authored:

- **Flame sheets** for surface fire. Every flaming surface cell (0.5 m) emits a camera-facing extruded strip anchored to the terrain, height set by Byram's flame length $L = 0.0775\,I^{0.46}$ (Byram 1959; $I$ = fireline intensity, kW m⁻¹; $L$ in m), tilted by the wind/slope-modified flame angle the solver already computes. Vertex animation uses the *same* velocity field the plume solver integrates, sampled trilinearly — so a gust bends the sheets and the fire simultaneously.
- **Particles** for spark/tongue detail. GPU append buffer; spawn rate one particle per 2 g of fuel consumed, capped at 64 k live. Advection $\dot{\mathbf v} = \mathbf{a}_{drag} + \hat{z}\,g\,(T/T_\infty - 1)$, $g=9.81$ m s⁻², $T_\infty$ = ambient (K).

**Soft depth blend:** $\alpha \mathrel{*}= \mathrm{saturate}\!\left((z_{scene}-z_{frag})/d_{soft}\right)$, $d_{soft}=0.35$ m, killing the intersection line against grass and trunks.

**No double counting.** The rule is that *extinction lives only in the froxels; emission is split*. Injection multiplies emission by $w(z)=\mathrm{smoothstep}(2\,\mathrm{m},8\,\mathrm{m},z)$; the near-field layer uses $1-w(z)$. Particles/sheets are alpha-blended into the HDR target with depth **before** the froxel apply pass, so the volume in front of them still attenuates them correctly ($C \leftarrow C\,T(z) + S(z)$). Soot mass is never removed from the froxels — only its self-emission is handed over.

Cost: 0.55 ms (sheets + particles + sort-free OIT via weighted blending), plus 0.15 ms for firebrand/ash sprites (§7.7).

---

### 7.4 Vegetation at scale

**GPU-driven, zero per-object CPU work.** An 80 k-entry instance buffer (32 B each: position, scale, rotation quat, species id, burn-state index = 2.6 MB) is processed by one compute pass: frustum sphere cull → Hi-Z occlusion cull against a depth pyramid built from the previous frame's depth reprojected → LOD select by projected screen height → atomic append into per-(species, LOD) instance lists with counts written into an indirect args buffer.

**WebGPU constraint (important):** core WebGPU has no `multiDrawIndirect` — it exists only as `chromium-experimental-multi-draw-indirect` behind `#enable-unsafe-webgpu`. We therefore issue **one `drawIndexedIndirect` per (species × LOD) bucket**: 14 species × 4 LODs = **56 indirect draws**, a fixed CPU cost independent of scene content, with all counts GPU-authored. If the extension is present we collapse to 4 draws as an opt-in fast path; we do not depend on it.

| LOD | Distance (m) | Tris/instance | Typical instances | Tris |
|---|---|---|---|---|
| L0 full mesh | 0–20 | 25,000 | 40 | 1.0 M |
| L1 reduced | 20–60 | 8,000 | 300 | 2.4 M |
| L2 branch-cards | 60–150 | 1,500 | 2,500 | 3.8 M |
| L3 octahedral impostor | >150 | 2 | ~77,000 | 0.15 M |
| **Trees total** | | | | **≈ 7.4 M** |

Impostors: 12×12 octahedral atlas per species, albedo + packed normal/depth, BC7 (requires the `texture-compression-bc` feature — present on all desktop Windows WebGPU adapters), 2048² per species ⇒ ~8 MB/species, 112 MB for 14. Parallax-corrected by the stored depth so silhouettes hold at the L2→L3 switch; cross-fade over 15 m using dither + TAA.

**Grass** is fully GPU-generated — no vertex buffer. `bladeId = vertexIndex >> 3`, `v = vertexIndex & 7`; **8 vertices per blade** (3 segments + tip, with one degenerate) = 5 triangles; position from a hash of blade id over a jittered grid; bend from the wind field plus per-blade phase. Density falloff

$$\rho(d)=\rho_0\,\mathrm{clamp}\!\left(\frac{d_1-d}{d_1-d_0},0,1\right),\quad \rho_0=400\ \mathrm{blades\,m^{-2}},\ d_0=12\ \mathrm{m},\ d_1=45\ \mathrm{m}$$

≈ 600 k blades ⇒ **3.0 M triangles**, 1.2 ms. Beyond 45 m the field becomes a normal-mapped ground shell whose albedo/roughness read the same burn-state texture, so a burnt scar is continuous across the transition.

**Frame totals:** ~10.5 M triangles, **< 100 draw calls** (56 tree + 4 grass + ~20 terrain/water/props + fullscreen passes), static props packed into render bundles. At 60 fps that is 630 M tri s⁻¹ through a depth prepass + G-buffer — comfortably inside a 4070 Laptop's geometry throughput; the binding constraint is fill and alpha-test overdraw on foliage, which the depth prepass mitigates. Vegetation G-buffer budget **3.6 ms**, grass **1.2 ms**, culling **0.35 ms**.

> **OPEN QUESTION (unverified):** The 3.6 ms vegetation G-buffer and 1.2 ms grass line items imply well over 2 G tri s⁻¹ sustained through a G-buffer pass (7.4 M and 3.0 M triangles at those times), which is aggressive for an AD106 under Dawn/WebGPU even behind a depth prepass. The triangle-throughput framing also counts the wrong bound for grass: it is alpha-tested foliage, where fill and overdraw dominate rather than triangle setup, so a per-triangle argument cannot establish the 1.2 ms figure either way. Both numbers flow directly into the §7.9 totals and therefore into the claim that "Balanced" fits inside 16.67 ms. Measure both passes on the target part in M4 — before any quality tier, LOD distance or dynamic-scaling threshold is fixed against them.

---

### 7.5 Procedural tree generation

**Recommendation: space colonisation (Runions et al. 2007) for the woody skeleton, L-system rewriting only for the terminal two branch orders (twig/leaf-cluster).** Reason: our physics prescribes a *target vertical profile of canopy bulk density*, and space colonisation lets us set that profile directly as the attractor density field. An L-system produces self-similar structure but hitting a prescribed CBD(z) with one requires parameter search per species per stand — unacceptable. L-systems are retained only where self-similarity is genuinely what we want and no physics constrains it (twig branching), where they are cheaper than SC.

**The derivation chain (geometry from fuel, one dataset):**

1. Physics supplies per tree: total height $H$ (m), crown base height $CBH$ (m), crown diameter $CD$ (m), foliar biomass $W_f$ (kg), species shape function $s(z)$.
2. Crown cross-section $A(z)=\tfrac{\pi}{4}CD^2 s(z)$ (m²); crown volume $V_c=\int_{CBH}^{H}A(z)\,dz$ (m³).
3. Vertical foliage weighting $w(z)$ (species beta-distribution) normalised so $\int_{CBH}^{H} w = 1$. Then per-tree bulk density $CBD_{tree}(z) = W_f\,w(z)/A(z)$ (kg m⁻³).
4. **Attractor field**: place $N(z)\,\Delta z = CBD_{tree}(z)A(z)\Delta z / m_{att}$ attractors, $m_{att}=W_f/N_{tot}$ with $N_{tot}\in[3000,8000]$. The skeleton therefore grows densest exactly where fuel mass is densest — the mesh *is* the fuel distribution, sampled.
5. **Branch radii** by the pipe model (Shinozaki et al. 1964; da Vinci exponent): $r_{parent}^{\,n}=\sum_i r_{child,i}^{\,n}$, $n=2.3$. Terminal radius $r_0$ set so total woody volume × wood density matches the 1-h/10-h/100-h fuel loads the solver carries.
6. **Foliage**: each terminal segment carries $m_{att}$ kg of foliage → $n=m_{att}/m_{leaf}$ leaves, or for conifers $n/k$ fascicles of $k$ needles. Leaf area follows specific leaf area $SLA$ (m² kg⁻¹): $A_{leaf,tree}=SLA\cdot W_f$, which is also what the radiative view-factor and drag terms consume.
7. **Ladder fuels**: run space colonisation a *second* time in $[0, CBH]$ with attractor density from the understorey shrub/sapling load. Ladder fuel is thus visible geometry and a physics term simultaneously.
8. **Bark**: shared triplanar procedural set — plate scale (m), furrow depth (mm), fissure anisotropy, base colour — 5 scalars per species, no unique textures.

| Biome / species | $H$ (m) | $CBH$ (m) | $CD$ (m) | $CBD_{tree}$ peak (kg m⁻³) | $W_f$ (kg) | Crown shape | Foliage unit | Bark |
|---|---|---|---|---|---|---|---|---|
| W-US conifer — *Pinus ponderosa* | 22 | 6.5 | 6.5 | 0.09 | 22 | Rounded conic | 3-needle fascicle, 20 cm | Thick orange plates |
| W-US mixed — *Pseudotsuga menziesii* | 26 | 2.5 | 6.0 | 0.16 | 35 | Narrow conic | Single needle, 2.5 cm | Deep grey furrows |
| Grassland/savanna — *Quercus* / *Acacia* | 8 | 2.0 | 9.0 | 0.05 | 15 | Umbrella | Small leaf, 3 cm | Rough dark |
| Chaparral — *Adenostoma fasciculatum* | 2.2 | 0.15 | 2.0 | 1.8 (fuel-bed) | 3.5 | Hemispheric shrub | Sclerophyll, 1 cm | Fine woody stems |
| Eucalypt — *E. obliqua / marginata* | 25 | 8.0 | 8.0 | 0.10 | 28 | Open irregular | Pendulous lanceolate, 10 cm | **Persistent stringybark** — thick fibrous bark shedding in long flat strips |
| UK broadleaf — *Quercus robur* | 20 | 4.0 | 12.0 | 0.12 | 45 | Broad rounded | Lobed, 10 cm | Deeply fissured |
| UK carrier — *Calluna vulgaris* | 0.4 | 0.02 | 0.5 | 3.5 (fuel-bed) | 0.3 | Low mat | Scale leaf, 2 mm | n/a |
| UK carrier — *Ulex europaeus* | 1.8 | 0.1 | 1.6 | 1.5 (fuel-bed) | 1.8 | Dense spiny | Spine, 2 cm | n/a |

Eucalypt stringybark is modelled as explicit strip geometry because it is the dominant long-range firebrand source in Australian dry forest — the firebrand emitter samples the stringybark strips directly, so what you see shedding is what the Lagrangian brand model launches. Note that *E. obliqua* (messmate stringybark) and *E. marginata* (jarrah) carry persistent rough fibrous bark shed as long flat strips; they do **not** decorticate in ribbons. True ribbon bark is the signature of the smooth-barked gums (*E. viminalis*, *E. rubida*, *E. globulus*), which are not the species modelled here — if a ribbon-shedding morphology is wanted later, the species row must change with it, because the shed dynamics and brand geometry differ.

**Stated limits.** Canopy bulk density is defined and measured at *stand* level (Scott & Reinhardt 2001; Cruz et al. 2003). Disaggregating to individual crowns requires dividing by canopy cover fraction; where cover is poorly known this introduces error of order 1/cover. Published per-crown CBD for UK broadleaf and for *Calluna*/*Ulex* is sparse — those rows are extrapolated from stand loads and flagged low-confidence in the parameter file.

---

### 7.6 Progressive burn materials

Per-element state is **four scalars**, not textures: scorch $s$, char $c$, ash $a$, and residual surface temperature $T_s$ (K). Define a monotone burn coordinate

$$b = \mathrm{clamp}(s + c + a,\ 0,\ 3),\qquad a=\mathrm{smoothstep}(0.75,1.0,u)$$

with $u$ = mass consumption fraction. Materials sample a **4-layer `texture_2d_array`** (green, scorch, char, ash; albedo BC7 + ORM BC7), taking layers $\lfloor b\rfloor$ and $\lfloor b\rfloor+1$ and lerping by $\mathrm{frac}(b)$ — **two fetches, one shared texture set for the whole world**.

| Layer | Albedo (linear RGB) | Roughness | Normal detail |
|---|---|---|---|
| Green foliage | 0.09, 0.16, 0.05 | 0.55 | Vein normal |
| Heat-scorched brown | 0.14, 0.08, 0.03 | 0.68 | Curl/shrink normal |
| Black char | 0.035, 0.033, 0.032 | 0.85 | Alligator crack |
| Grey ash | 0.62, 0.61, 0.59 | 0.96 | Powder |

> **OPEN QUESTION (unverified):** **Char height and scorch height are two different quantities and this spec conflates them.** WP 4.6's acceptance criterion in `90-workpackages.md` reads "char height on trunks matches computed *scorch* height". Char is bark blackened by the flame and reaches roughly flame height; scorch is foliage killed by the convective plume without burning, and reaches several times higher. The implementation currently ships **char only**, from Byram (1959) flame length $L = 0.0775\,I^{0.46}$, which is already `calibrated` in the provenance table — so no new constant was introduced. Foliage above flame height therefore stays green where a real crown would be brown.
>
> Closing this needs Van Wagner (1973), *Height of crown scorch in forest fires*, Can. J. For. Res. 3:373–378, read directly. What is established so far, from Atchley et al. (2024), *Fire Ecology* 20:71 (open access, DOI 10.1186/s42408-024-00291-x; USDA treesearch 80197), which is readable and was read:
>
> - Scorch height goes as $I^{2/3}$ — verbatim, "the mean $Ht_s$ increases as a function of the $I$ raised to the two thirds".
> - Van Wagner's data covered 16–300 kcal s⁻¹ m⁻¹ (67–1255 kW m⁻¹) and scorch heights of 2–17 m.
> - It was fitted in jack pine and red pine plantations at roughly 1 m s⁻¹ midflame wind, and "neglects the influences of variations in canopy structure, subcanopy winds, and ambient air temperature".
> - That paper states a coefficient of **0.385** with units $[\mathrm{m}^{1/3}\,\mathrm{kW}^{-2/3}]$, and warns the coefficient changes with the unit system.
>
> **The 0.385 could not be used, for two independent reasons.** Dimensionally, $0.385 \cdot I^{2/3}$ with $I$ in kW m⁻¹ yields $\mathrm{m}^{-1/3}$, not metres, so it cannot attach to $h_s = c\,I^{2/3}$ as printed — the paper also defines a rate of combustion $C_r$ in kW m⁻², which is a candidate for what it actually multiplies. Numerically, $0.385\,I^{2/3}$ over Van Wagner's own 67–1255 kW m⁻¹ range gives 6.4–44.8 m against his reported 2–17 m. The widely-quoted 0.1483 gives 2.45–17.2 m over that range, matching the reported data — **but that value was recalled, not read, and §0.7.1 forbids shipping a recalled constant.** The equations in the Atchley PDF are set in a symbol font that does not extract, Springer redirects to an auth endpoint, and the USDA mirror of the original (RMRS-GTR-292) returns a bot-check page. Obtain one of those and read the equation before implementing.

**Alligator cracking** is one tiling 2-channel texture (Worley distance field $D$ + cell id), not per-object art. Crack width opens with char:

$$m_{crack}=\mathrm{smoothstep}\!\left(0.5-0.35c,\ 0.5,\ D\right),\qquad h_{crack}=3\ \mathrm{mm}\times c$$

applied as a normal perturbation and an AO darkening.

**Embers** fall out physically: cracks expose the hot interior, so emission is *inverted* against the crack mask —

$$L_{emit}=\varepsilon\,\frac{\sigma_{SB}T_s^4}{\pi}\,\mathbf{C}(T_s)\,(1-m_{crack}),\qquad \varepsilon=0.90,\ T_s>700\ \mathrm{K}$$

reusing the §7.1.3 LUT. Embers therefore glow in the crack floors and fade as $T_s$ decays — no separate ember system, no authored emissive mask.

**Avoiding a texture explosion:** (a) one shared 4-layer array; (b) one shared crack field; (c) per-tree state is a **32-texel 1D vertical profile** in an `r8unorm` texture (80 k instances × 32 B = 2.6 MB), so a tree can be charred to 4 m and green above — this is the whole trick, a 1D profile rather than a 2D per-instance map; (d) grass and ground sample the 2048² surface-state texture directly by world XZ, at zero extra storage; (e) canopy voxel state is stored at 4 m (256×256×32, 2 channels `r8` = 4.2 MB) and trilinearly sampled, which is finer than the eye resolves at crown scale.

The `r8unorm` per-tree profile texture in (c) and the `r8` canopy voxel state in (e) are both subject to the storage-format constraint in §7.1.2: if either is written by a compute pass it requires `texture-formats-tier1`, otherwise it must be written as a render attachment or widened to a core storage format.

---

### 7.7 Atmospheric effects

**Heat shimmer.** Air refractive index via Gladstone–Dale, $n-1 \propto \rho \Rightarrow (n-1)=2.93\times10^{-4}\,(T_0/T)(P/101.325\ \mathrm{kPa})$ with $T_0=273.15$ K. We integrate the transverse gradient along the froxel ray and apply it as a screen-space UV offset to the **opaque scene colour only** (applied before volumetric emission composite, so flames do not refract themselves):

$$\boldsymbol{\delta}_{uv}= k\!\int \nabla_{\!\perp}\!\left(T_0/T\right)ds$$

$k$ tuned so a 1200 K plume at 20 m yields 3–6 px displacement at 1440p. **This is a first-order approximation** — true ray bending is an ODE and the correct treatment is ray marching with curvature; the visual difference at these scales is small but the model is calibrated by eye, not validated. 0.20 ms (reuses froxel data).

**Obscuration.** Falls out of §7.1 transmittance. HUD reports Koschmieder visibility $V=3.912/\sigma_{ext}$ (m; contrast threshold 0.02). Sun reddening through the plume needs no special case: the sun disc is multiplied by $e^{-\tau_c}$ per channel from the sun-transmittance volume and $\tau\propto\lambda^{-1.76}$ (§7.1.2; Sayer et al. 2014 Table 4 ten-site mean) does the rest.

**Light shafts** are the sun in-scatter term already computed per froxel with a CSM tap — no separate radial-blur pass.

**Ember and ash fall** render the physics' Lagrangian firebrand particles directly (≤20 k), 2–6 px sprites, emissive from each brand's own temperature through the same LUT; brands below 600 K become grey ash with higher drag. 0.15 ms. Again: one dataset, drawn.

**Sky.** Hillaire 2020 production sky/atmosphere: transmittance LUT 256×64 (static), multiscattering LUT 32×32 (static), sky-view LUT 192×108 (per frame), aerial-perspective LUT 32×32×32. Earth parameters (Bruneton/Hillaire): Rayleigh scattering $\beta_s=(5.802,\,13.558,\,33.100)\times10^{-6}$ m⁻¹ at (680, 550, 440) nm, scale height 8 km; Mie $\beta_s=3.996\times10^{-6}$ m⁻¹, $\beta_e=4.40\times10^{-6}$ m⁻¹, $g_{Mie}=0.80$, scale height 1.2 km; ozone absorption $(0.650,\,1.881,\,0.085)\times10^{-6}$ m⁻¹ in a 25 ± 15 km tent. Solar irradiance 1361 W m⁻², sun angular radius 0.2725°. Sun position comes from the **same** NOAA solar-position routine the weather module uses for diurnal fuel heating, so sky, shadows and fuel moisture are all consistent with date/latitude/longitude. 0.35 ms/frame.

---

### 7.8 Procedural audio

48 kHz, one `AudioContext`, all noise and grain synthesis inside a **single `AudioWorkletProcessor`** (128-frame quantum). `ScriptProcessorNode` is deprecated and main-thread; per-grain `AudioBufferSourceNode`s are rejected outright — thousands of node allocations per second will stall the graph. Total node count is held under ~60.

**Bus A — roar.** Xorshift white noise → 2-pole lowpass → peaking biquad → gain, with amplitude modulated by the puffing LFO.

- Lowpass cutoff: $f_c = 400 + 900\,(I/1000)^{0.4}$ Hz, $I$ = local fireline intensity (kW m⁻¹).
- Puffing (large-scale pulsation): $f_{puff} = 1.5\,D^{-1/2}$ Hz (Cetegen & Ahmed 1993, pool-fire correlation), $D$ = effective fire diameter (m). A 10 m front pulses at ~0.47 Hz — the characteristic slow breathing of a large fire. **Applied outside its validated envelope**: the correlation is for axisymmetric pool fires, not line fires; we use it because nothing better exists and it produces the right perceptual rate.
- Level: acoustic power $P_{ac}=\eta_{ac}\dot{Q}$ with $\dot Q$ = heat release rate (W) and $\eta_{ac}\approx10^{-6}$. **This is the weakest number in the section** — acoustic efficiency of open wildland flames is essentially uncharacterised; $10^{-6}$ is borrowed from enclosed combustor noise literature and is exposed as a calibration slider. SPL: $L_p = 10\log_{10}\!\big(P_{ac}/(4\pi r^2 \cdot 10^{-12})\big)$ dB.

**Bus B — crackle (granular).** Grains are generated inside the worklet: 3–12 ms exponentially decaying band-passed noise bursts, Poisson arrivals at rate $\lambda = k_c\,\dot m$, $k_c\approx 800$ grains per kg s⁻¹, hard cap 400 grains s⁻¹. Grain centre frequency binds to the fuel's surface-area-to-volume ratio the solver already carries: $f_g = 300 + 0.35\,\sigma$ Hz ($\sigma$ in m⁻¹) — grass ($\sigma\approx 11{,}500$ m⁻¹) crackles at ~4.3 kHz, 100-h branch wood ($\sigma\approx 100$ m⁻¹) pops at ~335 Hz. Mean concurrency at cap: $400\times 8\ \mathrm{ms}=3.2$ grains, peak ~20.

**Bus C — canopy wind.** Two noise bands (60–300 Hz body, 1–4 kHz hiss) with $G_{hf}\propto U^{2.2}$ ($U$ = wind speed at listener height, m s⁻¹, sampled from the actual wind field), plus a short comb filter whose depth tracks local canopy density.

**Spatialisation.** Fire is aggregated into **≤ 8 acoustic sources** using the §7.2 binning at 32 m radius. Each is a `PannerNode` (`HRTF` on headphones, `equalpower` on speakers), `distanceModel:'inverse'`, `refDistance:8`, `rolloffFactor:1.0`, followed by:
- **Air absorption**: ISO 9613-1 at 20 °C / 50 % RH / 101.325 kPa gives α = 0.27 dB/100 m at 500 Hz, 0.47 at 1 kHz, 0.99 at 2 kHz, 2.97 at 4 kHz and 10.5 at 8 kHz. Implement either (a) explicit per-band gains $10^{-\alpha(f)r/20}$ on a 3-band shelf split at 500 Hz / 4 kHz, or (b) a distance-dependent one-pole fitted at a 4 kHz anchor, $f_c(r) = f_a/\sqrt{10^{\alpha(f_a)r/10}-1}$ with $f_a = 4$ kHz and $\alpha(4\,\text{kHz}) = 0.0297$ dB/m — giving $f_c \approx 4.0$ kHz at 100 m and 2.3 kHz at 200 m. The previously stated $f_c = 22050e^{-r/380}$ under-attenuates by more than an order of magnitude and must not be used.
- **Terrain occlusion**: DDA raycast on the 2048² heightfield source→listener at 10 Hz; if occluded, Maekawa barrier attenuation $\Delta L = 10\log_{10}(3+20N)$ dB, $N=2\delta/\lambda$ the Fresnel number, $\delta$ = path-length difference (m).

All parameter updates use `setTargetAtTime` with time constant 0.05–0.2 s to avoid zipper noise, pushed at 20 Hz.

**CPU cost.** Audio render thread: 3 noise generators + ≤20 concurrent grains ≈ 4–6 µs per 128-frame quantum against a 2.67 ms budget ⇒ **< 0.5 % of one core**; graph traversal for ~60 nodes dominates and puts realistic total audio-thread load at **1–2 % of one i9-13900HX core**. Main thread: 8 sources × ~6 `AudioParam` calls at 20 Hz plus 8 heightfield raycasts at 10 Hz ≈ 0.05 ms per frame — negligible.

---

### 7.9 Frame budget summary (1440p)

| Pass | High (ms) | Balanced (ms) |
|---|---|---|
| Depth prepass + Hi-Z build | 1.10 | 0.85 |
| GPU culling / LOD select | 0.35 | 0.30 |
| Vegetation G-buffer | 3.60 | 2.60 |
| Grass | 1.20 | 0.70 |
| Terrain + shadow cascades (3 / 2) | 2.20 | 1.50 |
| Light aggregation + clustered shading | 1.45 | 1.10 |
| Froxel volumetrics (128 / 96 slices) | 3.10 | 2.40 |
| Near-field flames + firebrands | 0.70 | 0.55 |
| Sky + aerial perspective | 0.35 | 0.35 |
| Post (shimmer, bloom, tonemap, TAA) | 1.30 | 1.10 |
| **Render total** | **15.35** | **11.45** |
| Simulation compute | — | 4.50 |

"High" leaves no headroom for the solver and is a screenshot/benchmark mode. **"Balanced" is the shipping default.** Dynamic quality scaling acts in this order under a 16.0 ms rolling-average breach: froxel slices (128→96→64), grass $d_0$ (12→8→5 m), shadow cascades (3→2), impostor distance (150→110→80 m), and finally render-scale (1.0→0.85) with the volumetrics staying at half res throughout.