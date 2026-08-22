# ForestFire — Handoff

Read [SPEC.md](SPEC.md) first, then [CLAUDE.md](CLAUDE.md) for how this project is built.
Completed episodes — what broke and what it taught — live in [docs/HISTORY.md](docs/HISTORY.md).
This file is the **present tense only**. If a thing is finished, it belongs in HISTORY.

## ⏸ PARKED — 2026-08-22

**Stopped by the owner, and not because it stopped working.** The simulation is in the best
shape it has been in; the *thing being built* is not what the owner wants. In their words: the
spec was over-specified into procedural accuracy, and what the screen actually shows is a smoky
mess. The target is Far Cry 2/3 fire, enhanced — not a validated wildfire simulator.

That is a fair read of the evidence and not a change of taste. Every session this month was
spent on physical correctness, and each fix was real: crown fire ignites, smoke rises, the fuel
bed is heterogeneous, the clocks agree. None of it made the picture better, because the picture
was never the thing being worked on.

**Do not resume from this file's "Next, in order".** It orders work for the old goal. Anything
below it is still accurate as a description of what exists — read it as an inventory, not a
plan.

### The gap, stated plainly

Far Cry 2's fire is not a simulation. It is a cheap propagation rule on a coarse grid, carrying
excellent art: dense particles, strong emissive lighting that visibly changes the scene, heat
shimmer, wind-driven embers, and fuel that visibly deforms and blackens. Its convincingness is
almost entirely in the presentation layer.

That is precisely the layer this project has least of, and it is not an accident — the
scientific work was specified first and the rendering was scheduled behind it. The four things
that most separate this from the reference are all still unbuilt: **fire lighting the scene**
(WP 4.4), **bloom**, **TAA**, and a **sun-transmittance volume** so smoke is not a flat grey
wash. The soot yield that sets smoke opacity is `estimated` against an unread source, which is
why the plume reads as fog.

### What carries over to a Far Cry-shaped goal

Worth keeping whatever the new specification says: terrain synthesis, vegetation placement and
species, procedural tree geometry, the material and foliage renderers, the sun-occlusion pass,
the volumetric froxel march, the flame billboards, `?debug`'s probe discipline, the headless
runner, and the seeded reproducible world.

Probably over-built for it: Rothermel validated to 0.32 %, the Canadian FWI transcription, the
provenance and validation-status machinery, canopy voxel kinetics at 1.2 M voxels, and the
firebrand transport model. None of that is wrong — it is precision the target does not spend.

The propagation solver is the interesting middle case. A narrow-band level set on a 0.5 m grid
is more than a game needs, but it is built, it is fast, and it produces a believable perimeter
shape. Keeping it and cheapening what feeds it would be a defensible starting point.

## Where things stand

| Milestone | State |
|---|---|
| **M0 — Specification** | Complete. ~29,600 words, adversarially verified, 42 errors corrected. |
| **M0b — Toolchain** | Complete. Node 24 + Vite + strict TS + Vitest. |
| **M1 — Walkable world** | Complete and integrated. Boots end to end on a real GPU. |
| **M2 — Surface fire solver** | Complete and reconciled. GR2 D2L2 reproduces published ROS to 0.32%; the GPU intensity field agrees with the CPU oracle to 1.3%. |
| **M3 — Canopy, crown fire, firebrands** | Two channels of three. **The canopy ignites, is drawn, and consumes its foliage** — 551 voxels flaming, 3,249 stems with crown consumption. **Firebrands are switched off**, below. |
| **M4 — Volumetric fire and smoke** | In progress. Smoke field, blackbody colour, froxel march/composite, ground burn scars, near-field flames and tree/grass char are in and GPU-verified. Gaps below. |
| **M5 — Meteorology and biomes** | In progress. WP 5.2 (Canadian FWI) in, `calibrated`. WP 5.1 solar `validated` from M1. Five packages remain. |
| **M6** | Not started. Work packages in `docs/spec/90-workpackages.md`. |
| **Cleanup phases 1 and 2** | Done. Four phase-1 items skipped after inspection; see HISTORY. |
| **Cleanup phase 3** | Rung 1 (sun occlusion) in and GPU-verified. Rungs 2–4 (TAA, bloom, smoke self-shadowing) remain. |

Whole repo, as of 2026-08-22: **0 type errors, 1799 tests passing / 1 skipped, 51 validation
cases green (21 of them `published`), `?debug` PASS with no GPU errors.** Frame cost after the
cadence change: surface 0.034 ms, canopy 0.061 ms, 1.1 ms GPU total.

### Next, in order

1. **Owner: look at it.** Two sessions of unjudged work — crown flames, foliage consumption,
   the depth-aware smoke upsample, rising smoke, a flame growth envelope, a default clock of
   2x, and now a heterogeneous fuel bed that makes the conifer biome burn as litter rather
   than grass. `npm run dev`, right-click to ignite. Opinions wanted on crown billboard
   density (`CROWN_FLAME_KEEP`, currently 0.35) and on whether 2x is the right default.

2. **Close the crown-fire loop, or decide not to.** The last open coupling. The surface heats
   the canopy, the canopy reports what burned, and that measurement changes nothing: it does
   not alter lateral spread, seed canopy emitters, or ignite surface cells ahead of the front,
   so the 3D solver is a diagnostic. The cheap defensible route is to drive spread from the
   empirical Van Wagner/Cruz transition already implemented and keep the voxel field as the
   higher-fidelity layer until it demonstrably does better. A project-shape decision, not a bug.

3. **Delete the ROS bridge.** `FireSim.bridge` copies `ellipseCache` (a storage buffer) into
   `rosCache` (an rgba16float texture) every update — 8 B/cell over 4.19 M cells, **33.5 MB
   copied between byte-identical representations**, plus 33.5 MB of VRAM for the destination.
   `propagation.wgsl` reads it **only** through `textureLoad` and never samples it, so the
   texture buys nothing the buffer does not already have. Bind the buffer at group 0 binding 7
   as `array<vec2<u32>>` and unpack with `unpack2x16float`; `stub.ts` needs the same treatment
   for its standalone path. Verified 2026-08-22, not started: it touches a GPU bind group and
   the diff it belongs with was already large.

4. **Per-cell moisture.** The fuel bed is now heterogeneous in MODEL but uniform in moisture.
   That is M5's field and the honest place for it; deriving one from shade or aspect today
   would be a physical claim with nothing behind it.

5. **Then the visual ladder** — TAA with WP 4.3 (they share jitter and motion vectors), bloom,
   fire lighting, smoke self-shadowing. Below the couplings deliberately: these make a correct
   fire look better, and none of them makes a wrong fire right.

**Open question worth answering before more engine work:** an external review argues the
project locked scope — five biomes, full meteorology, 1 km² at 0.5 m, 1440p/60 — before proving
a vertical slice, and that the interaction model is an engineering control panel rather than
anything playable. That is a fair reading of `docs/spec/00-overview.md` §0.2's locked decisions.
Whether to relitigate them is the owner's call and nobody else's.

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

- **Fire lights nothing (WP 4.4).** Flames are emissive but cast no light on grass or trunks, so
  a night fire illuminates nothing. The biggest remaining gap.
- **No bloom**, so flame cores, the sun disc and sky clamp flat at the ACES shoulder — rung 3.
- **No sun-transmittance volume** (§7.1.4), so the plume does not self-shadow: a thick column is
  lit evenly instead of bright on top and dark underneath — rung 4.
- **Shadows are a top-down occlusion map, not cascades** — no side-lit trunk shadows.
- **No scorch on stems, and it was attempted.** Char reaches about flame height; scorch goes far
  higher and is a different relation, and the spec conflates the two (WP 4.6's acceptance
  criterion says "char height matches computed *scorch* height"). Blocked on a constant, below.
- **Crown consumption is per STEM, not per metre of crown.** `csBurnState` samples the canopy
  column through each trunk, so a tree browns as a whole rather than from the bottom of its
  crown upward. §7.6(c)'s 32-texel vertical profile is what resolves that, and it earns its
  place at the same time scorch does — one band becomes two.
- **No TAA**, so foliage shimmers; both draw paths already emit dither assuming TAA resolves it.

**Firebrands (WP 3.6) are switched off at the frame loop** and have never spawned a brand.
`FirebrandSystem.setEmitters` has no caller in `src/` and the ignition mask the brand shader
writes has no consumer, so the loop is open at both ends and running it integrated an empty
pool at frame rate to produce zeros — which is also exactly what a working spotting model
reports on a fire not throwing embers. `FIREBRANDS_ENABLED` in `app/canopy.ts` turns it back
on, and should be flipped in the same change that supplies emitters AND consumes the mask, not
before. Its constants are unsourced besides, so a wired subsystem would still be `estimated`.

## What the fire now reads

The surface bed is per-cell, rasterised from `UnderstoryField`'s canopy closure and understory
cover — both already computed at world build — through each species' own `surfaceFuelModel`.
Closed canopy takes the stand's litter model, open ground the cover species', and a cell with
neither is non-burnable, which is fuel model id 0 and was already in the LUT. Measured on the
shipping conifer world: **TL8 58.2 %, GR2 41.8 %**, against an independent 61 % canopy cover
from the sun-occlusion pass.

An explicit `?fuel=` override still writes a uniform bed, which is what a controlled comparison
and every published benchmark want.

Still uniform, deliberately: **moisture**, which is M5's field, and **load**, because the
surface shaders never read `packCell`'s `mass` fields — they are packed and never sampled, so
scaling them would look like heterogeneity and change nothing.

## Still to do

**M4.** Temporal reprojection (4.3), fire lighting (4.4), smoke self-shadowing, and the
curl-noise detail warp — smoke structure is currently limited by the 4 m field.

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
2. **`npm run headless` gets the DISCRETE adapter on this machine** — measured 2026-08-22,
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
