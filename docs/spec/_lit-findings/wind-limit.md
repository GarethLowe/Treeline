# Rothermel wind limit  (status: closed)

## [confirmed] Spec §4.5: "Rothermel's original cap is `U ≤ 0.9·I_R` (`U` in ft min⁻¹, `I_R` in BTU ft⁻² min⁻¹), and it is what BEHAVE ships."

**Correct value:** Original (Rothermel 1972 p.33; Albini 1976a "maximum reliable wind"): the limit is defined by U/I_R > 0.9, hence

    U_limit = 0.9 · I_R     [U in ft min⁻¹, I_R in BTU ft⁻² min⁻¹]

Units confirmed twice over: GTR-371 Table 6b row reads literally "Wind limit (ft/min)  = 0.9 I_R", and the worked example in §5.4.4 (GR1, dead 8%, live 100%, 0 slope) gives a limit of 1.6 mi/h; 1.6 × 88 = 140.8 ft min⁻¹ ⇒ I_R = 156 BTU ft⁻² min⁻¹, which is the right order for sparse GR1. Both reference implementations hard-code exactly this: `windSpeedLimit_ = 0.9 * reactionIntensity_;` and `double maxWind = 0.9 * reactionIntensity;`.

**Citation:** Andrews, P.L. 2018. The Rothermel surface fire spread model and associated developments: a comprehensive explanation. USDA Forest Service RMRS-GTR-371, §3.2.7 "Wind Limit", p.25; Table 6b, p.18; §5.4.4, p.83. Free PDF: https://research.fs.usda.gov/treesearch/download/55928.pdf (record https://research.fs.usda.gov/treesearch/55928). Code: firelab/behave, src/behave/surfaceFire.cpp:467 (`SurfaceFire::calculateWindSpeedLimit`), https://github.com/firelab/behave/blob/master/src/behave/surfaceFire.cpp ; legacy BehavePlus xfblib.cpp:2485 (`FBL_SurfaceFireForwardSpreadRate`), https://www.frames.gov/documents/behaveplus/software/xfblib.cpp

## [corrected] Spec §4.5 OPEN QUESTION (a): "the revised alternate limit's numeric constant (not stated above because it is not known)".

**Correct value:** The Andrews, Cruz & Rothermel (2013) revised alternate wind limit is

    U_limit = 96.8 · I_R^(1/3)     [same units: U in ft min⁻¹, I_R in BTU ft⁻² min⁻¹]

GTR-371 §3.2.7 states it verbatim as: "Andrews et al. (2013) corrected an error in an assumption to give the wind limit as U = 96.8 I_R^{1/3}". Exponent verified from the PDF text-layer glyph baselines on PDF page 33 (the "R" glyph sits 3.7 pt below the baseline = subscript; "1/3" sits 5.6 pt above = superscript), so the reading is 96.8·I_R^(1/3), not 96.8·I_R/3.

Arithmetic consequence the spec should record (my arithmetic from the two cited formulas, not from a source): the revised limit is LESS restrictive than 0.9·I_R only below the crossover I_R = (96.8/0.9)^{3/2} ≈ 1116 BTU ft⁻² min⁻¹; above that it is MORE restrictive. For the GTR-371 GR1 example (I_R ≈ 156) it gives 96.8 × 156^{1/3} ≈ 522 ft min⁻¹ ≈ 5.9 mi h⁻¹, versus 140.8 ft min⁻¹ ≈ 1.6 mi h⁻¹ for the original. Neither reference implementation contains 96.8 anywhere (grepped the whole firelab/behave tree and xfblib.cpp) — the alternate exists only on paper.

**Citation:** Andrews, P.L. 2018. RMRS-GTR-371, §3.2.7, p.25 (PDF page 33), https://research.fs.usda.gov/treesearch/download/55928.pdf — reporting Andrews, Cruz & Rothermel 2013, Int. J. Wildland Fire 22(7):959–969, doi:10.1071/WF12122

## [corrected] Spec §4.5 OPEN QUESTION (b): whether the recommended substitute is really `R ← min(R, U_eff)`.

**Correct value:** Partly right, and weaker than the spec implies. Two published statements by the same authors differ in emphasis and must both be recorded:

1. The 2013 paper's abstract (free, on the publisher's abstract page and on FRAMES) ends: "the authors recommend that, in place of the current wind limit, rate of spread be limited to effective midflame wind speed." So `R ← min(R, U_eff)` with R and U_eff both in ft min⁻¹ IS the 2013 recommendation, and U_eff there is the EFFECTIVE MIDFLAME wind — see the next finding.

2. The same lead author's 2018 GTR states the recommendation flatly as removal, not substitution: "It is now recommended that a wind limit not be imposed (Andrews et al. 2013)" and "The authors (including Rothermel) recommend that the wind limit not be imposed", adding that recent lab experiments to 60 mi h⁻¹ showed no wind limit (B.W. Butler, pers. comm. Oct 2016), and that "if fires spread faster with increasing winds, by whatever mechanism, then it is not appropriate to impose a wind limit on the model predictions." BehavePlus implements this as an option to not apply the limit — NOT as an R ≤ U_eff cap.

Neither reference implementation implements `R ← min(R, U_eff)` (verified by full-tree grep of firelab/behave and of xfblib.cpp). In practice the cap essentially never binds: in GTR-371's own §5.4.4 example, unlimited R = 8.2 ft min⁻¹ at 9 mi h⁻¹ midflame = 792 ft min⁻¹, so R/U_eff ≈ 0.01. It is a physical sanity rail, not an operative limiter.

**Citation:** Andrews PL, Cruz MG, Rothermel RC (2013) IJWF 22(7):959–969, doi:10.1071/WF12122 — abstract (free) via https://www.frames.gov/catalog/16000 and https://www.publish.csiro.au/wf/WF12122 ; Andrews 2018 RMRS-GTR-371 §3.2.7 p.25, §5.4.4 pp.83–84, §7.4.1 item 2 p.105

## [confirmed] Spec §4.5 OPEN QUESTION (c), part 2: whether U_eff in the cap is midflame wind or 20-ft wind.

**Correct value:** MIDFLAME, and specifically the EFFECTIVE midflame wind (wind and slope combined), in ft min⁻¹. The spec's assumption is correct.

GTR-371 §4.1: "The wind factor equation is then used to find the effective midflame wind speed (U_E) that would result in the calculated effective wind factor (φ_E)", with φ_E = φ_w + φ_s and U_E = [φ_E (β/β_op)^E / C]^(1/B) — identical to the spec's inversion.
GTR-371 §3.2.7: "In some cases the wind limit is applied to effective wind speed, which is the combined effect of wind and slope."
GTR-371 §7.4.1 item 2: "The wind limit is applied to midflame wind speed for fire danger and generally to effective wind speed (which includes the effect of slope) for fire behavior."
Code agrees: behave compares `effectiveWindSpeed_` (base units = ft min⁻¹, per behaveUnits.cpp SpeedUnits::toBaseUnits where FeetPerMinute is the no-op base case) directly against `windSpeedLimit_`; xfblib compares `effWind` (ft min⁻¹, built as `windFpm = 88 * midflameWindSpeed`) against `maxWind`, and only divides both by 88 to mi h⁻¹ on output.

So: no 1.15× (10 m → 20 ft) and no WAF factor enters the cap. Only the NFDRS fire-danger branch uses plain midflame wind without the slope combination.

**Citation:** Andrews 2018 RMRS-GTR-371 §4.1 "Effective Wind Speed" p.27; §3.2.7 p.25; §7.4.1 item 2 p.105. Code: firelab/behave src/behave/surfaceFire.cpp:394–399 (`calculateEffectiveWindSpeed`), :281 (comparison), :286 (unit conversion), behaveUnits.cpp:149–167; xfblib.cpp:2368, 2478–2502

## [confirmed] Spec §4.5 OPEN QUESTION (c), part 1: whether the cap is applied before or after the elliptical decomposition of §4.6.

**Correct value:** BEFORE — definitively, in both reference implementations. The cap acts on the head-fire quantities; flank and backing rates are then DERIVED from the already-capped head rate and the already-capped U_eff, and are never capped separately. The spec's worry is well-founded and the correct answer is 'before'.

Order in firelab/behave, SurfaceFire::calculateForwardSpreadRate (surfaceFire.cpp:250–295):
  1. φ_w, φ_s, R0 computed (:262–268)
  2. calculateWindSpeedLimit() → windSpeedLimit_ = 0.9·I_R (:272)
  3. forwardSpreadRate_ = R0 · (1 + φ_w + φ_s) (:275)
  4. calculateDirectionOfMaxSpread() — vector combination (:278)
  5. calculateEffectiveWindSpeed() — invert to U_eff (:279)
  6. if (limit enabled && U_eff > limit) applyWindSpeedLimit() (:281–284)
  7. calculateFireBasicDimensions(effectiveWindSpeed_, forwardSpreadRate_) → LB, backing, flanking (:290–294)

And applyWindSpeedLimit (:384–392) is NOT `R ← min(R, U_eff)`; its semantics are cap-the-wind-then-recompute:
    effectiveWindSpeed_ = windSpeedLimit_;
    phiEffectiveWind = C · windSpeedLimit_^B · (β/β_op)^(−E);
    forwardSpreadRate_ = noWindNoSlopeSpreadRate_ · (1 + phiEffectiveWind);
Legacy BehavePlus is byte-for-byte the same logic (xfblib.cpp:2485–2495: `phiEw = m_windK*pow(maxWind, m_windB); rosMax = ros0*(1+phiEw); effWind = maxWind;`), and its FBL_SurfaceFireLengthToWidthRatio(effectiveWindSpeed) (xfblib.cpp:2552) is called downstream with that capped effective wind. GTR-371 §6.2 confirms the same sequencing analytically: LB = Z = 1 + 0.25·U_E (U_E in mi h⁻¹), e = √(Z²−1)/Z, R_θ = R_H(1−e)/(1−e·cos θ), R_back = R_H(1−e)/(1+e) — every directional rate is a function of the head rate R_H and U_E, so capping those two is the whole cap.

Paste-ready pipeline order for §4.5/§4.6: compute φ_w, φ_s → vector-combine → φ_E → U_eff → apply cap to (U_eff, R_head) → LB from capped U_eff → HB/a/b/c and the §4.6 support-function Hamiltonian from capped R_head. Never apply a cap inside the Hamiltonian or to R_flank/R_back.

Two implementation cautions found in the code, both worth writing into the spec:
  • firelab/behave initialises `isWindLimitEnabled_ = false` inside initializeMembers() (surfaceFire.cpp:75), which is called at the TOP of every calculateForwardSpreadRate() call (:252), and no code anywhere in the repository ever calls setIsWindLimitEnabled(true) (verified by grepping every .cpp/.h in the master tree). The modern BEHAVE library therefore computes and reports windSpeedLimit_ and the isWindLimitExceeded_ flag but does NOT apply the cap — i.e. the reference implementation already ships the 2013 recommendation as its behaviour.
  • calculateWindSpeedLimit() also does, unconditionally and outside the enable flag: `if (phiS_ > windSpeedLimit_) phiS_ = windSpeedLimit_;` (surfaceFire.cpp:469–474). This compares the dimensionless slope factor φ_s against a wind in ft min⁻¹ and is absent from legacy xfblib.cpp. Do not port it; if BehavePlus cross-check numbers ever disagree on steep slopes with very low I_R, this is why.

**Citation:** firelab/behave, src/behave/surfaceFire.cpp:75, 250–295, 384–392, 465–476 and src/behave/fireSize.cpp:15–40, 93–165, https://github.com/firelab/behave/blob/master/src/behave/surfaceFire.cpp ; legacy BehavePlus xfblib.cpp:2359–2510 and :2552–2558, https://www.frames.gov/documents/behaveplus/software/xfblib.cpp ; Andrews 2018 RMRS-GTR-371 §6.2 pp.87–88 and Table 26 p.86

## [unconfirmed] Adjacent, outside this question but found in the same reference code — spec §4.6 gives LB = min[0.936·exp(0.2566·U_eff) + 0.461·exp(−0.1548·U_eff) − 0.397, 8] with U_eff in mi h⁻¹, attributed to Anderson (1983) "as used by FARSITE/FlamMap/ELMFIRE".

**Correct value:** Not investigated as part of this question and NOT to be changed on my say-so, but flagged because the wind-limit cap feeds straight into it: the two reference implementations disagree with the spec and with each other. GTR-371 §6.2 and legacy BehavePlus use LB = 1 + 0.25·U_E with U_E in mi h⁻¹. firelab/behave fireSize.cpp:97 uses 0.936·exp(0.1147·U) + 0.461·exp(−0.0692·U) − 0.397, capped at 8 — the same functional form as the spec but with exponents smaller by a factor of exactly 2.237 (= mi h⁻¹ per m s⁻¹), while the surrounding code (fireSize.cpp:20–21) has just converted the wind to mi h⁻¹. Either the spec's exponents or behave's are on the wrong wind unit; this needs its own sourcing pass against Anderson (1983, INT-305, free on treesearch) before §4.6 ships.

**Citation:** firelab/behave src/behave/fireSize.cpp:20–21, 93–108, https://github.com/firelab/behave/blob/master/src/behave/fireSize.cpp ; xfblib.cpp:2552–2558; Andrews 2018 RMRS-GTR-371 §6.2 p.87 and Table 26 p.86

## RECOMMENDATION

Question is closed on all three sub-parts; the spec's shipping default survives, but its wording and its OPEN QUESTION block should be replaced.

What §4.5 should now say:

**Wind limit.** Rothermel's original cap is on the *effective midflame* wind, not on the spread rate: `U_eff ≤ 0.9·I_R` (U_eff in ft min⁻¹, I_R in BTU ft⁻² min⁻¹) [Rothermel 1972 p.33; Albini 1976a; Andrews 2018 RMRS-GTR-371 §3.2.7 p.25, Table 6b p.18]. Andrews, Cruz & Rothermel (2013) corrected an error in one assumption of that derivation and obtained the alternate `U_eff ≤ 96.8·I_R^(1/3)`, same units [GTR-371 §3.2.7 p.25]. Both were judged too restrictive; the authors, Rothermel included, recommend that no wind limit be imposed, and BehavePlus ships that as a user option [GTR-371 §3.2.7 p.25, §5.4.4 p.83, §7.4.1 p.105]. The 2013 abstract states the substitute as "rate of spread be limited to effective midflame wind speed", i.e. `R_head ← min(R_head, U_eff)` with both in ft min⁻¹ and U_eff the effective (wind+slope) midflame wind — a rail that in practice essentially never binds (GTR-371's GR1 example: R = 8.2 ft min⁻¹ against U_eff = 792 ft min⁻¹).

**Pipeline placement (definitive).** Any cap acts on `(U_eff, R_head)` *before* the elliptical decomposition. LB is then computed from the capped U_eff, and HB / a / b / c / the §4.6 support-function Hamiltonian from the capped R_head. Flank and backing rates are never capped separately — they are already functions of the capped head quantities. Never apply the cap inside the Hamiltonian.

**Semantics of the legacy cap.** If the 0.9·I_R debug toggle is implemented, implement it as BEHAVE does — cap the wind and re-evaluate, not clamp the ROS:
  if (U_eff > 0.9*I_R) { U_eff = 0.9*I_R; phi_E = C*pow(U_eff,B)*pow(beta/beta_op,-E); R_head = R0*(1+phi_E); }
Clamping R directly gives different numbers and will not reproduce BehavePlus.

Validation status: the constants (0.9·I_R; 96.8·I_R^(1/3); ft min⁻¹ / BTU ft⁻² min⁻¹; effective *midflame* wind; cap-before-ellipse) are **validated** against a free primary source (RMRS-GTR-371) and cross-checked line-by-line against two independent reference implementations (firelab/behave and legacy BehavePlus xfblib.cpp), which agree with each other exactly. The shipping default — no hard wind limit — is likewise **validated**: it is the published recommendation of the model's own authors, and firelab/behave already behaves this way (isWindLimitEnabled_ is reset false on every call and is never set true anywhere in the tree). The optional `R ← min(R, U_eff)` rail carries the weaker status **substituted**: it is sourced only to the 2013 abstract's one-sentence recommendation, it appears in no reference implementation, and its known bias is that it is inert at realistic grass/forest spread rates (R/U_eff ~ 0.01–0.2), so shipping it costs nothing and buys nothing except a guard against pathological wind fields. The 2013 full text remains unread (IJWF paywall, no free equivalent located); nothing above depends on it, because GTR-371 restates both the derivation result and the recommendation.

Two code-level cautions for the integrator: (1) do not port firelab/behave's unconditional `if (phiS_ > 0.9*I_R) phiS_ = 0.9*I_R` clamp (surfaceFire.cpp:469–474) — it compares a dimensionless slope factor to a wind speed and is absent from legacy BehavePlus; (2) unrelated but adjacent, §4.6's Anderson LB exponents (0.2566 / 0.1548, mi h⁻¹) disagree with both reference implementations — GTR-371 §6.2 and xfblib use LB = 1 + 0.25·U_E (mi h⁻¹), while behave's fireSize.cpp:97 uses exponents smaller by exactly the 2.237 mi h⁻¹-per-m s⁻¹ factor. That deserves its own sourcing pass against Anderson (1983) INT-305 before §4.6 ships.
