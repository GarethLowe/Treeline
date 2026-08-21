# ForestFire — Handoff

Read [SPEC.md](SPEC.md) first, then [CLAUDE.md](CLAUDE.md) for how this project is built.
Completed episodes — what broke and what it taught — live in [docs/HISTORY.md](docs/HISTORY.md).
This file is the **present tense only**. If a thing is finished, it belongs in HISTORY.

## Where things stand

| Milestone | State |
|---|---|
| **M0 — Specification** | Complete. ~29,600 words, adversarially verified, 42 errors corrected. |
| **M0b — Toolchain** | Complete. Node 24 + Vite + strict TS + Vitest. |
| **M1 — Walkable world** | Complete and integrated. Boots end to end on a real GPU. |
| **M2 — Surface fire solver** | Complete and reconciled. GR2 D2L2 reproduces published ROS to 0.32%; the GPU intensity field agrees with the CPU oracle to 1.3%. |
| **M3 — Canopy, crown fire, firebrands** | Composed and GPU-verified. **The canopy ignites** — 112 voxels flaming, 412 ever ignited under an SB4 fire. |
| **M4 — Volumetric fire and smoke** | In progress. Smoke field, blackbody colour, froxel march/composite, ground burn scars, near-field flames and tree/grass char are in and GPU-verified. Gaps below. |
| **M5 — Meteorology and biomes** | In progress. WP 5.2 (Canadian FWI) in, `calibrated`. WP 5.1 solar `validated` from M1. Five packages remain. |
| **M6** | Not started. Work packages in `docs/spec/90-workpackages.md`. |
| **Cleanup phases 1 and 2** | Done. Four phase-1 items skipped after inspection; see HISTORY. |
| **Cleanup phase 3** | Rung 1 (sun occlusion) in and GPU-verified. Rungs 2–4 (TAA, bloom, smoke self-shadowing) remain. |

Whole repo, as of 2026-08-21: **0 type errors, 1770 tests passing / 1 skipped, 51 validation
cases green (21 of them `published`), `?debug` PASS with no GPU errors.**

### Next, in order

1. **Owner: load `http://127.0.0.1:5173` in your own Chrome and look at the grass.** Phase 2's
   five fixes are in and `?debug` passes, but hue is judged by eye. Sign-off gates phase 3.
2. **Cleanup phase 3** — TAA, then bloom, then smoke self-shadowing. One rung at a time, owner
   looks between rungs.
3. **Finish M4** (below). Resume after phase 3 rung 2, since TAA and WP 4.3 share machinery.
4. M5's remaining five packages, then M6.

### Running it

```bash
npm run dev          # then open in your OWN Chrome, not the in-app pane
npm run headless     # drive a real Chrome unattended: screenshots, console, GPU errors
```

`?debug` is the ground truth for anything Node cannot check: GPU smoke test, M2 solver
self-test, M3 canopy chain probe, M4 volumetrics probe, a WGSL compilation audit of every
module the boot path creates, and the provenance report. `?bench&hud=0` sweeps quality 0–5 over
a fixed camera path. `?fuel=SB4&wind=6&fireScale=16` is the crowning case used for canopy work.
Boot takes ~14 s; tree geometry dominates. CLAUDE.md documents the rest of the commands.

**If it renders black**, in order of likelihood: exposure (an HUD `exposure` line reading
`1e-5`-ish in daylight is the auto-exposure maths, not the renderer — nudge the EV slider to
confirm in two seconds), then the sky pass, then depth.

## Built but not yet visible

The simulation is ahead of the picture. These are the gaps between what is computed and what
the owner can actually see, which is the order CLAUDE.md says to work in:

- **Nothing renders a crowning canopy.** The voxels burn now, but the draw path still shows
  surface flames only, so a stand at CFB 94 % looks like a ground fire. The biggest gap.
- **Fire lights nothing (WP 4.4).** Flames are emissive but cast no light on grass or trunks, so
  a night fire illuminates nothing.
- **No bloom**, so flame cores, the sun disc and sky clamp flat at the ACES shoulder — rung 3.
- **No sun-transmittance volume** (§7.1.4), so the plume does not self-shadow: a thick column is
  lit evenly instead of bright on top and dark underneath — rung 4.
- **Shadows are a top-down occlusion map, not cascades** — no side-lit trunk shadows.
- **No scorch on stems, and it was attempted.** Char reaches about flame height; scorch goes far
  higher and is a different relation, and the spec conflates the two (WP 4.6's acceptance
  criterion says "char height matches computed *scorch* height"). Blocked on a constant, below.
- **No 32-texel vertical burn profile** (§7.6(c)). The burn coordinate is computed analytically
  per vertex, which needs no texture. The profile earns its place when scorch lands and a stem
  has two bands rather than one.

## Still to do

**M4.** Temporal reprojection (4.3), fire lighting (4.4), the crowning-canopy draw, smoke
self-shadowing, and the curl-noise detail warp — structure is currently limited by the 4 m field.

**M5.** Five packages. WP 5.2's FWI is `calibrated`, not `validated`: `DMC` and `DC` reproduce
the Van Wagner & Pickett (1985) worked example to seven significant figures, but `FFMC`, `ISI`,
`BUI` and `FWI` are not asserted against published figures because those targets were
**recalled, not read** and the implementation disagrees (FFMC 87.3675 vs 87.692980; ISI 4.0787
vs 10.853661). A hand-calculation agrees with the implementation, so the targets are the likely
error — but §0.7 forbids `validated` either way. The cross-walk to size-class moisture is
`estimated` (§6.7): 10 h and 100 h are interpolated because the FWI system does not resolve
them — first thing to suspect if UK spread rates come out wrong.

Two pinned properties belong to the model, not this transcription. Do **not** "fix" either;
both are published-constant artefacts: the FFMC scale and its inverse are not exact inverses
(residual under 0.06 of a code unit), and FWI has a real ~0.05 % discontinuity at BUI = 80.

**Decision waiting on the owner.** `fireView` defaults to `'arrival'`, WP 2.6's false-colour
overlay. It was to be turned off once WP 4.5 drew real flames; WP 4.5 has now landed, so the
condition is met and the default has not been revisited.

**Deferred deliberately.** Exposure and the grass base-darkening at `grassDraw.wgsl:120` are
untouched: a large part of the frame was being metered through the grass-hue bug, so both want
re-judging against a correct picture rather than before one.

## Constants that are not sourced yet

Each blocks a `validated` status, and §0.7.1 forbids shipping a recalled constant — this
project has already shipped one wrong FWI figure that way. **Free sources only; never bypass a
paywall.**

| Wanted | For | Lead |
|---|---|---|
| **Forestry Technical Report 33**, or the `cffdrs` R package test fixtures | promote FWI from `calibrated`, or fix the transcription | — |
| **RMRS-GTR-292** or the CJFR paper | the scorch-height coefficient. Atchley et al. (2024) is open access and confirms the $I^{2/3}$ law, but its printed 0.385 is dimensionally wrong in SI and gives 6.4–44.8 m against Van Wagner's reported 2–17 m. The quoted 0.1483 reproduces that range but was recalled, not read | Springer redirects to auth, the USDA mirror bot-checks; neither was worked around |
| **Andreae (2019) Table 1** | soot yield, `estimated`, scales plume opacity linearly | open access, unread |
| **RMRS-GTR-371** (Andrews 2018) | the wind limit. The paywalled 2013 paper was never read; BEHAVE source encodes what is applied. Blocks M2 | free |
| **NIST fire research** | firebrands: whether ember thickness was entered as full or half thickness (2x error if wrong), and drag coefficients that lost their source. Blocks M3 | public domain |
| A freely-documented **chaparral** model | confirm the known bias of the substituted Rothermel SH5/SH7. Blocks M5's chaparral biome | — |
| **Smoke optics** | near-flame vs aged scattering. The 30 m threshold is an authored guess; wants a rule from soot age or temperature, both already computed. Blocks M4 | — |
| **Meteorology directions** | five sense-bearing claims never individually re-checked. A backwards sign makes fire run downhill | — |

Plume entrainment is the one such question that was closed, in
`docs/spec/30-canopy-heat-crown.md`. It is a good model for what these should produce.

**Two plume defects are real and open**, recorded in the same file at §7.5. Neither caused the
crown-fire failure they were blamed for: `solvePlume` starts at ground level rather than above
the flaming zone (Mercer & Weber 1994 takes its source conditions at a height above the flame
tip — get the paper before changing the initial condition), and the LUT's 4.13 m rows do not
resolve the near field.

## Open questions

```bash
npm run spec:status
```

Regenerates [`docs/spec/_open-questions.md`](docs/spec/_open-questions.md) from the callouts
embedded in the spec documents.

## Decisions already locked — do not relitigate

Full text in `docs/spec/00-overview.md` §0.2, §0.6 and §0.7. The ones that get questioned:

- **SI internally. Moisture is a fraction, never a percent. Angles in radians.** Branded types
  in `src/contracts/units.ts` make violations a compile error.
- Chaparral ships on Rothermel SH5/SH7, **not** the unverifiable Anderson 2015 model: prefer a
  model *known* to be approximate over one merely unverified, because a known bias can be
  stated and corrected for.
- Every model carries a validation status, surfaced in the HUD and written into exports.
- No suppression simulation. No run recording/replay.

## Environment

1. **The in-app browser pane runs the Intel iGPU, not the RTX 4070**, under
   `msedgewebview2.exe`, which has no per-app GPU preference — even with
   `powerPreference: 'high-performance'` on AC power. Functional verification there is fine;
   **any frame timing from it is ~10x off and meaningless**. Fix with `GpuPreference=2;` for
   `msedgewebview2.exe` under `HKCU:\Software\Microsoft\DirectX\UserGpuPreferences`, or use
   your own Chrome. The pane may also not composite at all, in which case
   `requestAnimationFrame` never fires and boot reports "First frame — skipped".
2. **`npm run headless` gets the DISCRETE adapter on this machine** — measured 2026-08-21,
   `nvidia / blackwell`, `discrete (as requested)`. CLAUDE.md says otherwise; it described a
   different machine. **The adapter line the runner prints every run is the only authority**,
   and a real measurement discarded on the strength of either note is discarded wrongly.
3. **Node may not be on the session PATH** (installed after the shell started), so
   `.claude/launch.json` calls `node.exe` by absolute path. Machine-specific: fix it there
   first on a new machine, or use plain `node` if the PATH is sane.

## Nothing was downloaded

`scripts/fetch-assets.mjs` was written but **not run**. It would fetch CC0 PBR material sets
from Poly Haven / ambientCG into `public/assets/materials/`. Everything runs on procedurally
generated materials, so the download is optional — read the script, check the licences, and run
it if you want photographic materials.
