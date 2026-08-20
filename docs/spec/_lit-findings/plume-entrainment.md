# Plume entrainment convention  (status: closed)

## [corrected] OPEN QUESTION as posed: "alpha_e = 0.08–0.11, convention (top-hat vs Gaussian) and geometry (line vs axisymmetric) unstated." NOTE: docs/spec/30-canopy-heat-crown.md §7.5 as it stands on disk has ALREADY been rewritten (marked "CLOSED — 2026-08-18") and now states the Gaussian line-plume convention explicitly. The old 0.08–0.11 range is gone. I verified the replacement text line by line rather than the stale question.

**Correct value:** LINE (2D) plume, GAUSSIAN convention: alpha = 0.11 ± 15 % (i.e. 0.0935–0.1265). Literature-supported envelope 0.095 ≲ alpha ≲ 0.13. The old 0.08–0.11 was Gaussian-shaped but its lower half sits below every published measurement, so the spec's diagnosis of a low-side (under-entrainment) bias is correct.

**Citation:** Richardson, J. & Hunt, G.R. (2022) "What is the entrainment coefficient of a pure turbulent line plume?" J. Fluid Mech. 934, A11, eq. (7.1), p. 934 A11-26; range 0.095 ≲ alpha ≲ 0.13 in §7 conclusion item (ii), same page. Open Access CC BY. doi:10.1017/jfm.2021.1070. Free full text: https://www.repository.cam.ac.uk/items/79da878c-c6d6-404a-ba6f-360d26668c39 (bitstream https://api.repository.cam.ac.uk/server/api/core/bitstreams/c19e4203-1e11-4b10-b8d9-f309f3f670c8/content)

## [confirmed] Spec §7.5: Gaussian convention is u_e = alpha_e * w_c with w(x,z)=w_c exp(-x^2/b^2), g'(x,z)=g'_c exp(-x^2/(lambda b)^2), b the 1/e velocity half-width.

**Correct value:** Verbatim from source. Entrainment closure: "u_e = alpha w_c" (1.1), where u_e is the horizontal entrainment velocity and w_c the time-averaged CENTRELINE velocity. Profiles (2.3a,b): w(x,z)=w_c(z)exp(-x^2/b^2), g'(x,z)=g'_c(z)exp(-x^2/(lambda b)^2); b and lambda*b are the half-widths at which velocity and buoyancy fall to 1/e. Integral fluxes Q=∫w dx, M=∫w^2 dx, B=∫w g' dx (2.1a–c); dQ/dz = 2 u_e (2.2a) — the factor 2 is entrainment into BOTH sides of the line plume.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, eqs (1.1) p. 934 A11-2; (2.1a–c), (2.2a–c), (2.3a,b) pp. 934 A11-4.

## [confirmed] Spec §7.5: top-hat convention is u_e = alpha_T M/Q, uniform w_T = M/Q over width 2 b_T = Q^2/M.

**Correct value:** Verbatim from source: "One convention assumes 'top-hat' profiles whereby the plume is modelled as having a uniform average velocity w_T = M/Q and buoyancy g'_T = B_0/Q across a finite width 2 b_T = Q^2/M and zero vertical velocity and buoyancy outside. The top-hat entrainment coefficient alpha_T is then defined such that u_e = alpha_T M/Q." Note the spec omits g'_T = B_0/Q; add it for completeness.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, §2.1, p. 934 A11-4.

## [corrected] Spec §7.5: "the equivalent is alpha_T = 0.16, via alpha_T = 2^(1/4)(1+lambda^2)^(1/4) alpha_G = 1.486 alpha_G at lambda = 1.2 (the familiar sqrt(2) factor is the lambda = 1 simplification)."

**Correct value:** THE 0.16 IS RIGHT; THE 1.486 FACTOR IS NOT WHAT THE SOURCE SAYS AND IS NOT UNIQUE. What R&H actually state: "alpha_T = sqrt(2) alpha on taking lambda = 1 as is a typical simplification in the top-hat model" (§2.1) and, in the conclusions, "alpha = 0.11 ± 15 % ... corresponding to alpha_T = 0.16 for 'top-hat' profiles". sqrt(2) x 0.11 = 0.1556 -> 0.16 at 2 s.f. The spec's lambda-dependent factor is derivable — it is what you get by equating the volume flux in R&H's top-hat solution (2.5a) Q=(2 alpha_T)^(2/3) B0^(1/3) z with the Gaussian solution (2.6a) Q=2^(5/6)(1+lambda^2)^(1/6) alpha^(2/3) B0^(1/3) z, giving alpha_T = 2^(1/4)(1+lambda^2)^(1/4) alpha = 1.4861 alpha = 0.1635 at lambda=1.2 — BUT equating the MOMENTUM flux (2.5b) vs (2.6b) instead gives alpha_T = 2^(-1/2)(1+lambda^2) alpha = 1.7253 alpha = 0.1898. The two agree only at lambda = 1. So for lambda != 1 the simplified top-hat model cannot reproduce both Q and M, and "the" conversion factor is ambiguous by ~16 %. CORRECT, UNAMBIGUOUS RESOLUTION (algebra checked against (2.5)/(2.6)): if the top-hat momentum equation retains the profile shape factor, dM/dz = sqrt((1+lambda^2)/2) * B0 Q / M  [= 1.10454 * B0 Q / M at lambda=1.2], instead of the lambda=1 form dM/dz = B0 Q/M, then the top-hat and Gaussian formulations reproduce Q(z) AND M(z) identically for every lambda, and the conversion is exactly alpha_T = sqrt(2) alpha_G, lambda-independent -> alpha_T = 0.1556 (0.1343–0.1838 over the 0.095–0.13 envelope).

**Citation:** Richardson & Hunt (2022) JFM 934 A11: sqrt(2) statement and eqs (2.5a–c), (2.6a–c) on p. 934 A11-5; "corresponding to alpha_T = 0.16 for 'top-hat' profiles" in §7, p. 934 A11-26. Ambiguity and shape-factor fix derived directly from (2.5a–c) vs (2.6a–c) — reproducible algebra, not a literature claim.

## [confirmed] Spec §7.5: "lambda = 1.2 (FIXED, not a free parameter; range 1.0–1.3)".

**Correct value:** lambda = 1.2. Verbatim: "we concluded 1.0 ≲ lambda ≲ 1.3, a narrower range than 0.88 ≲ lambda ≲ 1.4 implied by reported measurements. At present, lambda = 1.2 appears to be an appropriate representative value". Also "we consider lambda = 1.2 (average value, rounded to 2 s.f.) to be the representative value". Per-dataset lambda (Table 4): Lee & Emmons 1.1, Kotsovinos 1.28, Ramaprian & Chandrasekhara 1.25, Yuan & Cox 1.13, Paillat & Kaminski 1.30, Parker et al. 1.15, R&H 1.03.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, §7 p. 934 A11-26; §4 text and Table 4, p. 934 A11-18.

## [confirmed] Spec §7.5: "Best single measurement alpha = 0.108 ± 2 %".

**Correct value:** alpha = 0.108 ± 2 % (95 % confidence interval), from measurements of plume scalar width lambda*b paired with entrainment velocity u_e.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, abstract p. 934 A11-1 and §7 p. 934 A11-27; Table 4 entry "Present work 0.108 1.03", p. 934 A11-18.

## [confirmed] Spec §7.5 mandatory CI regression: "at alpha = 0.11, lambda = 1.2 these are b = 0.1241z, lambda*b = 0.1489z, w_c = 2.157 B0^(1/3), g'_c = 2.743 B0^(2/3) z^-1, Q = 0.4746 B0^(1/3) z".

**Correct value:** Exactly right, all five, to 4 s.f. Verbatim: "we use the coefficient values that can be calculated from alpha = 0.11 and lambda = 1.2 ... These values for alpha and lambda yield the following set: C_b = 0.1241, C_lambda_b = 0.1489, C_w = 2.157, C_g = 2.743 and C_Q = 0.4746 (to four significant figures ... to minimise rounding errors)." Dimensional forms are set by (2.7a–c) b = C_b z, w_c = C_w B0^(1/3), g'_c = C_g B0^(2/3) z^-1 and (2.11a–d) lambda*b = C_lambda_b z, Q = C_Q B0^(1/3) z. Also usable: C_M = M/(B0^(2/3) z) and C_Q = 2 C_e (entrainment into two sides). This is a genuinely convention-independent test — a sqrt(2) slip breaks C_b and C_Q immediately.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, §3 p. 934 A11-7 (immediately following eq. (3.2a,b)); definitions (2.7a–c) p. 934 A11-5 and (2.11a–d) p. 934 A11-5.

## [confirmed] Spec §7.5 NUMERICAL TRAP note: "0.16 is both the correct top-hat value and the rejected Rouse et al. (1952) Gaussian value... Rouse is itself a line-fire plume experiment... Chen & Rodi's (1980) refit gives 0.144... R&H remove the Rouse entries from their curated list."

**Correct value:** All four sub-claims verified. (a) Table 1 lists "Rouse et al. (1952) / Various authors / 0.16", "Rouse et al. (1952) / Brooks (1973) / 0.14", "Rouse et al. (1952) / Chen & Rodi (1980) / 0.144"; Table 1 caption states Rouse et al. give no alpha themselves but "their reported measurements imply alpha = 0.16", and that all Table 1 entries are in the Gaussian convention of (1.1), "converted from different plume theory conventions when necessary". (b) Rouse is a fire experiment: "Rouse et al. (1952) measured w(x) and g'(x) at different heights in a thermal plume created by a line of gas burners." (c) "alpha = 0.160 decreases to alpha = 0.144 and lambda = 0.88 increases to lambda = 1.04" under the Chen & Rodi refit. (d) Table 4 caption: "entries for Rouse et al. (1952) and Yokoi (1960) have been removed because of concerns regarding the interpretation of their data."

**Citation:** Richardson & Hunt (2022) JFM 934 A11: Table 1 and caption, p. 934 A11-3; §4.2 pp. 934 A11-11; Table 4 caption, p. 934 A11-18. Primary: Rouse, H., Yih, C.S. & Humphreys, H.W. (1952) Tellus 4(3), 201–210; Chen, C.J. & Rodi, W. (1980) Vertical Turbulent Buoyant Jets: A Review of Experimental Data, Pergamon.

## [confirmed] Spec §7.5 extrapolation note: "the two fire-driven datasets in R&H's curated list — Lee & Emmons (1961) alpha = 0.13; Yuan & Cox (1996) alpha = 0.126 — sit at the top of the range, so a fit landing in 0.115–0.13 is physically well-motivated."

**Correct value:** Confirmed, with one caveat to add. Table 4 (curated list): Lee & Emmons 0.13, Kotsovinos 0.10, Ramaprian & Chandrasekhara 0.115, Yuan & Cox 0.126, Paillat & Kaminski 0.120, Parker et al. 0.095, present work 0.108. Lee & Emmons and Yuan & Cox are the two highest and both ARE line fires (titles: "A study of natural convection above a line fire", JFM 11, 353–369; "An experimental study of some line fires", Fire Safety J. 27(2), 123–139). CAVEAT WORTH ADDING TO THE SPEC: R&H Appendix B shows these fire plumes are strongly non-Boussinesq near the source (Yuan & Cox measured ~1000 K excess, rho/rho_e ~ 0.23) and that "the scalings expected for a Boussinesq pure plume begin at the visible flame height (approximately)". So alpha = 0.11–0.13 applies ABOVE the visible flame tip, not within the flame zone — directly relevant because §7.5 injects Q_dot at the surface flame.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, Table 4 p. 934 A11-18; reference list p. 934 A11-33/34; Appendix B, p. 934 A11-29.

## [confirmed] Spec closure note: "van Reeuwijk et al. (2016), Phys. Rev. Fluids 1, 074301 gives an axisymmetric top-hat alpha_p = 0.105" — and the open question's premise that "alpha = 0.11 ± 15 % (van Reeuwijk et al., JFM 2022)" is the axisymmetric consensus.

**Correct value:** Spec is right; the open question's premise is a misattribution. van Reeuwijk, M., Salizzoni, P., Hunt, G.R. & Craske, J. (2016) is AXISYMMETRIC DNS and reports alpha_j = 0.067 (jet) and alpha_p = 0.105 (pure plume), defined on INTEGRAL (top-hat-type) characteristic scales r_m = Q/M^(1/2), w_m = M/Q with Q = 2∫w r dr, M = 2∫w^2 r dr (pi-free scaled fluxes), via the entrainment assumption -[ru]_inf = alpha r_m w_m (eq. 5), equivalently alpha = (1/2Q) dQ/dzeta (eq. 6). They quote the literature ranges 0.065 < alpha_j < 0.084 and 0.10 < alpha_p < 0.16 for axisymmetric flows. There is NO van Reeuwijk et al. JFM 2022 giving 0.11 ± 15 %: that number is Richardson & Hunt (2022) JFM 934 A11 for the LINE plume in the GAUSSIAN convention. The near-agreement of 0.105 (axisymmetric, integral/top-hat) and 0.11 (line, Gaussian) is coincidental — different geometry AND different convention — and must not be used as cross-validation, exactly as the spec warns.

**Citation:** van Reeuwijk, Salizzoni, Hunt & Craske (2016) "Turbulent transport and entrainment in jets and plumes: A DNS study", Phys. Rev. Fluids 1, 074301: eqs (1)–(3) p. 1, eqs (5)–(6) and literature ranges p. 1–2, values alpha_j = 0.067 / alpha_p = 0.105 in Table I (p. 5) and §IV text (p. 6). Free preprint: arXiv:1603.09078v2, https://arxiv.org/abs/1603.09078

## [confirmed] Spec §7.5 opening: "for a line source of strength I (kW m^-1) the centreline excess temperature falls as Delta_T ∝ I^(2/3) z^(-1)".

**Correct value:** Consistent with the same source and convention. R&H (2.7c): g'_c = C_g B0^(2/3) z^(-1) with C_g = 2.743 at alpha=0.11, lambda=1.2. Under Boussinesq g' ∝ Delta_T and B0 ∝ I, so Delta_T ∝ I^(2/3) z^(-1). Note also (2.7b) w_c = C_w B0^(1/3) with C_w = 2.157 — the line-plume centreline velocity is INDEPENDENT of z, a second cheap assertion for the CI regression.

**Citation:** Richardson & Hunt (2022) JFM 934 A11, eq. (2.7a–c) p. 934 A11-5; coefficients §3 p. 934 A11-7.

## RECOMMENDATION

HEADLINE FOR THE INTEGRATOR: docs/spec/30-canopy-heat-crown.md §7.5 has already been rewritten and marked "CLOSED — 2026-08-18". I checked its every numeric claim against the free CC BY full text of Richardson & Hunt (2022) JFM 934 A11 and the free arXiv preprint of van Reeuwijk et al. (2016). Ten of eleven claims are verbatim correct, including the five CI-regression constants to 4 s.f. ONE defect remains and needs a patch.

THE ONE DEFECT — the top-hat conversion sentence. The spec says "alpha_T = 2^(1/4)(1+lambda^2)^(1/4) alpha_G = 1.486 alpha_G at lambda = 1.2 (the familiar sqrt(2) factor is the lambda = 1 simplification)". That factor is not in the source and is not unique. R&H state only "alpha_T = sqrt(2) alpha on taking lambda = 1" (§2.1, p. A11-5) and "alpha = 0.11 ... corresponding to alpha_T = 0.16" (§7, p. A11-26). The 1.486 comes from equating VOLUME flux between R&H's top-hat solution (2.5a) and Gaussian solution (2.6a); equating MOMENTUM flux, (2.5b) vs (2.6b), gives 2^(-1/2)(1+lambda^2) = 1.725 instead. The two agree only at lambda = 1, because the simplified lambda=1 top-hat model cannot reproduce both Q(z) and M(z) of a lambda=1.2 Gaussian plume. Left as written, an implementer taking the top-hat path could legitimately land on alpha_T = 0.1556, 0.1635 or 0.1898 — a 22 % spread, which is larger than the entire published uncertainty in alpha and would reintroduce exactly the bias this question exists to remove.

REPLACEMENT TEXT (paste-ready): "If the implementation is written in top-hat form (u_e = alpha_T M/Q, uniform w_T = M/Q and g'_T = B_0/Q over width 2 b_T = Q^2/M), the conversion is alpha_T = sqrt(2) alpha_G = 0.156, independent of lambda — PROVIDED the top-hat momentum equation retains the profile shape factor, dM/dz = sqrt((1+lambda^2)/2) * B_0 Q / M = 1.1045 * B_0 Q / M at lambda = 1.2. With that factor the top-hat and Gaussian formulations reproduce Q(z) and M(z) identically. If the shape factor is dropped (the lambda = 1 simplification, R&H eq. 2.5), the two forms are no longer equivalent and no single alpha_T reproduces both fluxes: matching dilution Q gives alpha_T = 2^(1/4)(1+lambda^2)^(1/4) alpha_G = 0.163, matching momentum M gives alpha_T = 2^(-1/2)(1+lambda^2) alpha_G = 0.190. Do not use the simplified form."

ADMISSIBLE RANGE AND §7.7 FIT BOUNDS — keep the spec's, they are correct. Convention stated explicitly: GAUSSIAN, LINE (2D) plume, u_e = alpha_e w_c with w_c the centreline vertical velocity and b the 1/e velocity half-width (R&H eq. 1.1, 2.3a,b).
  - alpha_e = 0.11, lambda = 1.2 (lambda FIXED, not fitted; range 1.0-1.3).
  - Nominal uncertainty +/-15 % => [0.0935, 0.1265] (R&H eq. 7.1).
  - Soft bounds / published envelope: 0.095 <= alpha_e <= 0.13 (R&H §7(ii); spans Parker et al. 0.095 to Lee & Emmons 0.13 in Table 4). Warn if the fit exits this.
  - Hard optimiser bounds: 0.090-0.140. Defensible as a deliberately slightly-wider clamp so the optimiser can express dissatisfaction rather than rail silently; keep the spec's rule that landing outside the soft bounds emits a warning.
  - A fit landing high, 0.115-0.13, is expected and physically motivated, not suspicious: the only two FIRE datasets in R&H's curated list are the two highest values (Lee & Emmons 0.13, Yuan & Cox 0.126).

TWO ADDITIONS I RECOMMEND. (1) Add g'_T = B_0/Q to the top-hat definition list — the spec currently omits the buoyancy scale, which is where lambda actually enters. (2) Add the Appendix B caveat: the fire-plume alpha values apply only ABOVE the visible flame height; R&H show the Yuan & Cox fire plume is strongly non-Boussinesq near source (~1000 K excess, rho/rho_e ~ 0.23) and only reaches Boussinesq pure-line-plume scaling at roughly the visible flame tip. Since §7.5 injects Q_dot = I_B * Delta_s at the surface flame, the closure is being applied inside a region where the source data does not support it. This is a real, nameable, one-directional model limitation and should be recorded as such.

VALIDATION STATUS. The CONSTANT is `validated`: alpha_e = 0.11 +/- 15 %, Gaussian, line plume, sourced to a primary open-access measurement paper with an equation-level locator, and cross-checked against that paper's own curated re-analysis of all eight prior datasets. The MODEL that uses it remains `calibrated`, for three stated reasons: alpha_e stays a fitted knob in §7.7; 0.11 is for a PURE line plume in a quiescent, unstratified, Boussinesq environment while we apply it to a wind-tilted plume from a spreading front in a stratified atmosphere; and it is applied from the flame base upward whereas the fire data only support it above the flame tip. No substitute model is needed — the constant is fully obtainable and now sourced.

RETAIN THE CI REGRESSION AS WRITTEN — it is the strongest thing in the section and I verified all five constants to 4 s.f. against R&H §3, p. A11-7 (C_b = 0.1241, C_lambda_b = 0.1489, C_w = 2.157, C_g = 2.743, C_Q = 0.4746 at alpha = 0.11, lambda = 1.2). Consider adding a sixth assertion: w_c is independent of z for a line plume (R&H eq. 2.7b), which is free to test and catches an axisymmetric/line geometry mix-up that the width tests alone would not.

Sources (all free, no paywall bypassed): Richardson & Hunt (2022) JFM 934 A11, Open Access CC BY, doi:10.1017/jfm.2021.1070, full text at https://www.repository.cam.ac.uk/items/79da878c-c6d6-404a-ba6f-360d26668c39 ; van Reeuwijk, Salizzoni, Hunt & Craske (2016) Phys. Rev. Fluids 1, 074301, free preprint https://arxiv.org/abs/1603.09078 . No repository files were modified.
