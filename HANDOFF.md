# ForestFire — Handoff

Read [SPEC.md](SPEC.md) first, then [CLAUDE.md](CLAUDE.md) for how this project is built.
Completed episodes — what broke and what it taught — live in [docs/HISTORY.md](docs/HISTORY.md).

## Where things stand

| Milestone | State |
|---|---|
| **M0 — Specification** | Complete. ~29,600 words, adversarially verified, 42 errors corrected. |
| **M0b — Toolchain** | Complete. Node 24 + Vite + strict TS + Vitest. |
| **M1 — Walkable world** | Complete and integrated. Boots end to end on a real GPU. |
| **M2 — Surface fire solver** | Complete and reconciled. GR2 D2L2 reproduces published ROS to 0.32%; the GPU intensity field agrees with the CPU oracle to 1.3%. |
| **M3 — Canopy, crown fire, firebrands** | Composed and GPU-verified. Emitters -> radiation -> voxel kinetics runs end to end. |
| **M4 — Volumetric fire and smoke** | In progress. Smoke field, blackbody colour, froxel march/composite and ground burn scars are in and GPU-verified. |
| **M5 — Meteorology and biomes** | In progress. WP 5.2 (Canadian FWI) in, `calibrated`. WP 5.1 solar `validated` from M1. Five packages remain. |
| **M6** | Not started. Work packages in `docs/spec/90-workpackages.md`. |
| **Cleanup phase 1** | Complete. See below for the four items skipped and why. |
| **Cleanup phase 2** | Done. Three bugs fixed, two of them found by the first. |
| **Cleanup phase 3** | Rung 1 (sun occlusion) in and GPU-verified. Rungs 2-4 (TAA, bloom, smoke self-shadowing) remain. |
| **M4 — burning vegetation** | Trees and grass now char from the solver's own output. §7.6(c)'s 32-texel profile is still not built; see below. |

Whole repo, as of 2026-08-20: **0 type errors, 1742 tests passing / 1 skipped, 51 validation
cases green (21 of them `published`), `?debug` PASS with no GPU errors, 25 WGSL modules
compiling clean.**

### Next, in order

1. **Owner: load `http://127.0.0.1:5173` in your own Chrome and look at the grass.** Phase 2's
   five fixes are in and `?debug` passes, but hue is judged by eye and the in-app pane does not
   composite, so no screenshot can be taken from this side. Sign-off gates phase 3.
2. **Cleanup phase 3** — sun occlusion, then TAA, then bloom, then smoke self-shadowing. One
   rung at a time, owner looks between rungs.
3. **Finish M4** — temporal reprojection, fire lighting the scene, near-field flames,
   tree/grass burn state. Resume after phase 3 rung 2.
4. M5's remaining five packages, then M6.

### Running it

```bash
npm run dev
```

**Open it in your own Chrome, not the in-app pane** — the pane runs the Intel iGPU (see the
environment gotchas below) and may not composite at all, in which case `requestAnimationFrame`
never fires and boot reports "First frame — skipped".

- `?debug` — GPU smoke test, M2 solver self-test, M3 canopy chain probe, M4 volumetrics probe,
  a WGSL compilation audit of every module the boot path creates, and the provenance report.
  This is the ground truth for anything that cannot be checked under Node.
- `?bench&hud=0` — sweeps quality 0-5 over a fixed camera path and prints per-phase timings
  with p95 and % of the 16.67 ms budget, plus where 60 fps actually lands.

Boot takes ~14 s on the iGPU; tree geometry dominates at ~6.6 s.

**If it renders black**, in order of likelihood: exposure (the HUD's `exposure` line reading
`1e-5`-ish in daylight means the auto-exposure maths, not the renderer — nudge the EV slider
to confirm in two seconds), then the sky pass, then depth.

```bash
npm run validate
```

Per-benchmark expected vs actual vs deviation vs tolerance, plus a coverage table stating
which models the suite confers `validated` on. That table is deliberately conservative: only
`published` cases count. Structural cases guard transcription and baseline cases guard
regression, and the suite says outright that neither is evidence a model reproduces reality.

## Burning vegetation — trees and grass char over time

Owner-requested. Before this, only the *ground* changed as it burned: `burnStateIndex` had sat
in the instance layout since M1 marked "M4 hook", and `render/materials/burn.ts` was fully
built and unit-tested with **no consumer anywhere in `src/`**.

Vegetation now reads WP 2.4's output directly. A burnable material already occupies
`BURN_LAYER_COUNT` consecutive texture-array layers — green, scorch, char, ash — so burning
something is a layer offset and a blend, not a colour tint: the char layer carries its own
albedo, roughness and normal map, and a tint would flatten all three into a multiply.

**The one thing that needed thought is persistence.** WP 2.4's consumed fraction is monotonic
by construction (§7.6(d): ground can never un-burn), so grass can read it directly — a blade
is half a metre in a half-metre fuel cell and burns all at once. A *stem* is different: char
height is a function of flame length, flame length is a function of fireline intensity, and
intensity is **instantaneous**. Read directly it would char a trunk as the front arrived and
un-char it as the front moved on. So `shaders/foliage/burnState.wgsl` keeps the peak intensity
each stem has ever stood in, `atomicMax` into a per-instance buffer — order-free across the
dispatch, and monotonic by the operator rather than by convention.

Char height itself is Byram (1959) flame length, `L = 0.0775 I^0.46` — already this project's
flame length everywhere else, already `calibrated` in the provenance table. **No new physical
constant was introduced**, which is the whole reason this shape was chosen.

Measured through `?debug`, after the canopy probe's prime run:

```
stems             36700
stood in fire     109 (0.30 %)
peak intensity    max 865.0 kW/m, mean of burnt 432.9 kW/m
implied char      max 1.74 m up the stem, mean 1.26 m
```

**The stem count is an independent check on the spatial lookup, and it lands.** The prime run
burnt 3,049 m² of a 1,048,576 m² domain; at the placed density of 350 stems/ha that area holds
about 107 stems, and the readback found 109. A wrong texture, a transposed coordinate or an
off-by-a-grid-scale in the world-to-texel mapping would all still produce a plausible-looking
non-zero count — none of them would land within 2 % of the number derived from burnt area and
stem density. The max intensity (865 kW/m) also sits just under the surface solver's own
reported peak (920 kW/m) exactly as it should, since a stem samples a point and the solver
reports a maximum over the whole field.

1.74 m of char on a 30 m conifer from an 865 kW/m surface fire is the right physical answer:
that is a surface fire blackening the base, not a crown fire.

### What this deliberately does not do

- **No scorch, and it was attempted.** Char reaches about as high as the flame; SCORCH — where
  the convective plume kills foliage without burning it — goes far higher and is a different
  relation. **The spec conflates the two**: WP 4.6's acceptance criterion reads "char height on
  trunks matches computed *scorch* height". Full findings are now an OPEN QUESTION at
  `docs/spec/70-rendering-audio.md` §7.6, in the `npm run spec:status` dashboard. Summary:
  Atchley et al. (2024), *Fire Ecology* 20:71 is open access and readable, and confirms the
  $I^{2/3}$ law, the fitting conditions and Van Wagner's 2-17 m data range over
  67-1255 kW/m — but the coefficient it prints, 0.385, is **dimensionally wrong** for
  $h_s = c I^{2/3}$ in SI and numerically gives 6.4-44.8 m against Van Wagner's own reported
  2-17 m. The widely-quoted 0.1483 reproduces that range almost exactly, **but it was recalled
  rather than read, and §0.7.1 forbids shipping a recalled constant** — this project has
  already shipped one wrong FWI figure that way. Springer redirects to an auth endpoint and
  the USDA mirror of the original returns a bot-check page; neither was worked around. Get
  RMRS-GTR-292 or the CJFR paper and read the equation.
- **No 32-texel vertical profile.** §7.6(c) specifies one, and `burnProfileTextureDescriptor`
  / `sampleBurnProfile` in `materials/burn.ts` implement it. The burn coordinate is currently
  computed analytically per vertex from (consumed, peak intensity, height), which needs no
  texture and no second pass. The profile earns its place when the vertical structure stops
  being a single monotonic falloff — i.e. when scorch lands, since scorch and char give a stem
  two bands rather than one.
- **`burnStateIndex` is still unused.** The instance index serves as the per-stem row, so the
  field is redundant. Left in place rather than churning `INSTANCE_FLOATS` and its layout test.

## The headless runner — `npm run headless` (CLEANUP-SPEC 1.11, now closed)

```bash
node scripts/headless.mjs http://127.0.0.1:5173/ --shot frame.png
```

`scripts/headless.mjs` drives a real Chrome over the DevTools Protocol. **Headless Chrome
composites**, so `requestAnimationFrame` fires and frames are genuinely produced — which the
in-app browser pane never did. Options: `--wait <js>` (default: the boot screen has hidden
itself, i.e. a frame rendered), `--eval <js>`, `--shot <png>`, `--timeout`, `--quiet`. Exit
code is non-zero on timeout or console errors, so it works as a check, not just a viewer.

No new dependency: Node 22 has a global `WebSocket` and `fetch`, and CDP is JSON over one
socket. Puppeteer would have been hundreds of megabytes to do what ~150 lines do.

**Its numbers are functional, not temporal.** The adapter it gets is whatever Chrome picks —
the Intel iGPU here — so it prints the adapter on every run and every frame time from it is
~10x off. Same rule as the pane: real timings need the owner's own Chrome.

It earned its place within a minute of existing, by finding the bug below that had defeated
inspection entirely.

## The black screen — a cached bind group over a destroyed texture

Two separate defects, one visible symptom.

**1. Both foliage pipelines were failing to create.** The sun-occlusion binding was declared
`FRAGMENT` in the tree and grass layouts while the shaders sample it in the **vertex** stage to
emit `sunVis` as a varying. `createRenderPipeline` does not throw for that: it returns an
invalid pipeline and emits a console *warning*. Every draw using it was dropped. The suite was
green, `gpuErrors` was empty, all eight boot stages reported success, and the shader audit
reported every module compiling clean — because nothing was wrong with the WGSL.

**2. `froxel.ts` handed back a bind group pointing at a destroyed texture.** `marchGroupFor`
cached on `smoke.label | height.label`, but binding 4 is the **depth view**. Smoke and height
identities never change, so the cache never invalidated, while `RenderTargets.resize` destroys
`hdr-depth` and creates a new view. WebGPU then rejects the entire command buffer at submit —
"Destroyed texture used in a submit", again only a warning — and the screen goes black with
nothing thrown. The `compositeGroupFor` immediately below it had always compared the HDR view
by identity; the march group just never got the same treatment.

The trigger explains the report exactly: fire spreads, frames slow down, the auto quality
controller drops `resolutionScale`, the targets resize, and the stale bind group kills every
frame from then on. Verified fixed with the runner at `render target 757x341 @ 60%` — the
scaler had dropped resolution and the scene kept rendering, `gpuErrors=0`.

### What now catches this class

- `installShaderAudit` wraps `createRenderPipeline`/`createComputePipeline` in validation error
  scopes and records every failure. It runs **unconditionally**, not just under `?debug`: an
  invalid pipeline is a black screen in the shipping path, so the check has to live there.
  Failures surface as boot-screen warnings and a `console.error` naming the pipeline.
- A GPU validation error raised mid-run now puts itself on screen the first time it happens
  instead of silently discarding command buffers.
- `npm run headless` reproduces frame-loop behaviour without a human.

## Cleanup phase 3 rung 1 — sun occlusion

**Nothing in this scene occluded sunlight.** Sunlit and canopy-shaded ground rendered
identically, which is most of what makes a forest read as three-dimensional.

`src/render/shadow/sunOcclusion.ts` + `shaders/render/shadow/sunOcclusion.wgsl`. Not cascades:
a 1024² top-down visibility map over the domain, one texel per metre, built from two things
already GPU-resident — the foliage instance buffer and the terrain height texture. Two
dispatches, **recomputed only when the sun moves more than 0.25°**, so a static sun pays once.

Measured on the first build, at a 54.5° sun:

```
rebuilds          1
canopy mean       0.631 visibility, min 0.200
canopy shaded     60.9 % of the domain under a crown
ridge mean        0.981 visibility
ridge shaded      3.0 % of the domain behind a ridge
instances         36700 crowns rasterised
```

`min 0.200` is exactly the canopy floor (1 − `CANOPY_OPACITY`), and 60.9 % cover back-solves
through Poisson overlap to a ~2.9 m mean crown radius, which is right for 350 stems/ha at
31.4 m²/ha basal area. `?debug` prints this block: a map stuck at 1.0 (nothing occluded) and
one stuck at 0.0 (dispatch never ran) are indistinguishable by eye and completely different
bugs.

### Three things worth knowing about the design

- **Canopy and terrain occlusion are in separate channels, and that is not a convenience.**
  Ground and grass want both. A tree does not want the canopy term — its own crown is in the
  map, so multiplying its fragments by it would make every tree self-shadow to the canopy
  floor. Trees read `.g` alone, so a stand in a ridge's shadow darkens and one in open sun
  does not.
- **`atomicMax`, not `atomicAdd`.** Overlapping crowns are then order-free and deterministic,
  and a closed canopy saturates at one crown's opacity instead of compounding to black —
  which is what we want anyway, since `CANOPY_OPACITY` already describes a *closed* canopy.
  WebGPU storage textures cannot be atomically written at all, hence the accumulation buffer
  and the resolve pass.
- **`rgba8unorm`, not `r8unorm`.** r8unorm as a *storage* format needs the optional
  `texture-formats-tier1` feature. This adapter grants it; relying on that would have shipped
  a pass that fails on hardware that does not.

**Only the direct term is occluded.** Sky ambient still reaches shaded ground, which is what
keeps a forest floor blue-shifted rather than black.

`common.wgsl` had to be split to make this possible: it *used* the `frame` uniform without
declaring it, so it could not be included by any pipeline that does not bind the foliage
package's group 0. The frame binding and the two helpers that read it (`sphereInFrustum`,
`windDisplacement`) now live in `frameBindings.wgsl`, and `common.wgsl` depends on nothing but
the generated prelude. That is what lets the occlusion pass share `TreeInstance` and
`terrainHeightAt` instead of keeping a second copy of a struct layout.

## Cleanup phase 2 — done

All five fixes from `docs/CLEANUP-SPEC.md` phase 2 are in. `?debug` PASSES, no GPU errors, 24
WGSL modules compile clean (one fewer than before only because `fireView` now defaults off, so
`firedebug.wgsl` is no longer built on the default path).

1. **The grass hue bug is fixed at its cause.** `grassMaterialLayer()` looked up a literal
   `'grass'`; every biome's id is `'grass-blade'`, so the lookup always missed and fell back to
   layer 0 — conifer bark — which is why grass rendered blue-violet. The layer is now resolved
   once, inside `buildFoliageScene`, and published on `FoliageScene.grassLayer`. There is no
   longer a second place that can disagree.
2. **The silent `?? 0` material fallback is loud.** An unresolved id now lands in
   `FoliageScene.unresolvedMaterialIds` and comes out as a boot-screen warning and a
   `console.warn` naming the id and listing the known ones. This fallback has shipped two bugs
   by being survivable. `test/app/biomeMaterials.test.ts` pins that every id every biome asks
   for exists in the library.
3. **Foliage light is chromatic.** `sunIrradiance`/`skyIrradiance` went f32 -> vec3
   (`FRAME_UNIFORM_BYTES` 224 -> 240). The sun tint is the sky's own `beamColor` — airmass
   reddening plus the plume's lambda^-1.76 extinction — and the ambient tint is the DC term of
   the irradiance SH, so foliage and terrain now read the same light. Both tints are
   peak-normalised before scaling, so **magnitudes are unchanged and exposure did not move.**
4. ~~`fireView` defaults to `'off'`~~ **REVERTED — back to `'arrival'`.** The spec's premise
   was that M4's volumetrics replaces WP 2.6's overlay. Only the *smoke* half of M4 is built:
   **near-field flames (WP 4.5) do not exist**, and the froxel volume is 4 m horizontal, so a
   0.5 m flame front is diluted to a peak of roughly 630 K — above the blackbody LUT floor of
   500 K but far below flame temperature, and below ~1500 K a Planckian is outside the sRGB
   gamut anyway. So turning the overlay off left literally nothing drawing fire, and smoke
   erupting from an invisible source. The overlay stays until WP 4.5 lands.
5. Grass ambient is a hemisphere (`0.25 + 0.15 * n.y`), matching `treeDraw.wgsl`.

### Two further grass bugs that fix 1 uncovered

Resolving `'grass-blade'` correctly made grass vanish entirely, which exposed a collision that
the bark fallback had been hiding:

- **The alpha cutout and the blade geometry are two representations of the same thing.**
  `grass-blade`'s alpha channel is a *card* atlas — 12 blade silhouettes across U, each about
  3.5% of its cell wide and randomly offset within it. But the grass draw builds an extruded,
  bent, tapered blade *ribbon* and samples that atlas at `u` in {0, 1}, which are cell
  boundaries and therefore always gap. Mask 0, every fragment discarded. Conifer bark is
  opaque, so while the lookup was falling back to layer 0 the blades drew — that is the only
  reason grass was ever on screen. **The cutout test is gone from `grassDraw.wgsl`; the
  geometry owns the silhouette.** The colour channel is unmasked and correct at any `u`, so
  the texture still supplies what it was authored for.
- **The curing gradient ran upside down.** The atlas shades `mix(deepAlbedo, baseAlbedo, v)` —
  green at `v = 0`, cured straw at `v = 1`, with the blade alive for `v <= height`, so atlas v
  runs base to tip. The geometry set `uv.y = 1.0 - t`, putting straw at the ground and green at
  the tip. Now `uv.y = t`. This matters beyond looks: that gradient is the curing state M5
  drives.

**Not done, deliberately:** exposure and the grass base-darkening at `grassDraw.wgsl:120` are
untouched. A large part of the frame was being metered through the bark bug, so both should be
re-judged against a correct picture, not before one.

## Cleanup phase 1 — done, with four items deliberately skipped

Phase 1 cut `src/` from 47,894 to ~43,500 lines and found two real production bugs:

- **The foliage culler's near and far frustum planes were inverted.** `render/foliage/cullMath.ts`
  carried its own copy of the Gribb-Hartmann extraction, hard-coding the non-reversed-Z near/far
  assignment while the renderer ships `REVERSED_Z = true`. Neither plane rejected anything, so
  trees behind the camera were submitted every frame. The four side planes were correct, which
  is why it looked fine. Now a re-export of `camera/math.ts`.
- **Validation had never run against the shipping kernel.** The swap point in
  `sim/validation/kernel.ts` still pointed at the WP 2.5 stub, so 272 cases characterised a
  module nothing imported. Repointed; all published cases pass.

Four items in `docs/CLEANUP-SPEC.md` were skipped after inspection. Each is a case of the
audit being wrong on the ground, and the spec's own escape hatch says to note and continue:

1. **`src/gpu/attribution.ts` is kept.** The spec calls the encoder `Proxy` an artefact of
   frozen contracts. It is not: 25 `beginComputePass` call sites sit several layers below the
   entry points, so threading a profiler through would mean widening ten signatures — a bigger
   diff, more code, and it puts the per-phase attribution fix the spec says must not regress
   at risk for no gain.
2. **Most of the "never-populated options bags" are populated.** `AtmosphereConfig`,
   `SiteConfig` and `FoliageConfig` are user-facing and patched at runtime; `PreludeOptions`
   has two required fields both varied by tests; `RuntimeOptions` and `PlumeOptions` are
   populated by tests including the §7.7 convergence regression; `CrownTuning` and
   `StandAggregationOptions` are documented calibration knobs whose defaults are deliberate
   holes named in `openQuestions`. Only `MaterialSystemOptions.config` was genuinely dead, and
   it is gone.
3. **`bootScreen.ts` is kept.** The spec wanted it replaced with a ~15-line `await step()`
   wrapper. It is 90% the adapter report, the integrated-GPU warning and the remedy list —
   the diagnostic surface CLAUDE.md tells every session to read before trusting a measurement.
   What was removed instead: the `owner: 'WP 1.6 ...'` strings, which were parallel-build
   archaeology that no longer maps to anything, and three unread `StageTracker` accessors.
4. **`bench/report.ts` is kept as markdown.** The spec wanted a plain table plus CSV. About a
   third of that file is prose explaining how to read the numbers — that iGPU results are not
   results, that the phase rows are phases and not passes because Chrome quantises timestamps
   to 100 µs, and that the rAF row is vsync-locked. Trading that for line count would make it
   easier to misread a benchmark, which is the failure this project keeps having.

**One deletion was reversed:** four of the nine "dead" stubs had live production callers
(`TerrainSampler`, `StubTerrain`, `StubEmitter`, `uploadRosCache`). Two were recovered from
the bundle source map, `StubEmitter` was recreated inline in `system.ts`, and vegetation now
uses the camera package's `TerrainSampler`.

**Phase 1.9's test deletion was also skipped, and replaced.** The spec wanted
`test/gpu/fake-webgpu.ts` and `test/render/sky/fake-device.ts` deleted as false confidence.
Both are honest recording spies whose headers explicitly disclaim validating anything, and the
tests riding on them assert real CPU logic — the profiler's ring-buffer state machine, the
environment cache, solar position, plume optical depth. Deleting them would delete coverage of
the per-phase attribution the spec elsewhere insists must not regress. The gap CLAUDE.md
actually names is different: **WGSL never reaches a compiler under Node.** So `?debug` gained
`src/app/shaderAudit.ts`, which wraps `createShaderModule` and reports
`getCompilationInfo()` for every module the boot path creates. First run: 25 modules, all
clean.

Also done in phase 1: 20 re-export barrels deleted (imports now point at real modules), the
provenance system collapsed from 11 files / 2,005 lines into one 188-line table in
`src/provenance.ts` with the prose in `docs/spec/_provenance-notes.md`, three copies of
`rawBuffer` collapsed into `src/gpu/raw.ts`, and the duplicated scalar helpers moved to
`src/math.ts`.

**`src/math.ts` deliberately does not absorb the RNGs.** `world/terrain/rng.ts` (SplitMix32),
`world/trees/rng.ts` (mulberry32 + Box-Muller) and `world/vegetation/rng.ts` (mulberry32 +
Stafford hashes) are three different algorithms, and there are three different functions named
`hashU32` in this repo — SplitMix32's finaliser in terrain, Wellons' lowbias32 in
`render/materials/noise.ts` (which mirrors a WGSL file), and a PCG hash in
`sim/firebrands/brands.ts`. Merging any of them would silently regenerate every seeded world.

## 🚧 M4 IN PROGRESS — volumetrics

Two of the six packages are in and verified; the froxel raymarch that makes them visible is not.

**WP 4.1 — the advected smoke field.** `src/sim/smoke/` plus `shaders/sim/smoke/smoke.wgsl`.
256 x 256 x 64 rgba16float at 4 m horizontal / 2 m vertical, height above ground, ping-ponged.
Spec §6.1 chose that grid over the 2 m canopy lattice deliberately (128 MiB per copy and 4x the
bandwidth), and §6.4 chose advection by wind plus WP 3.4's parameterised buoyant velocity over a
pressure projection. Injection is folded into the advection invocation rather than run as its
own pass, because a separate injection would have to read and write the same texture.

Verified on GPU:

```
smoke field       peak 5.82e-4 kg/m3, +327.8 K, f = 0.140
  cells with mass L0:328  L1:98  L2:58  L3:12 of 4096 each
  plume LUT       w = 0.10 / 4.44 / 4.44 / 4.44 m/s at rows 0/2/8/16, level-off Infinity m
```

A decaying vertical profile from a ground-level source, and f = 0.140 sits between the flaming
(0.22) and smouldering (0.08) endmembers as a mixed front should. **Composition is carried as
two masses, never as the ratio** — §7.1.2's implementation trap applies one level up to f itself
the moment two parcels mix.

**WP 4.2 (part) — blackbody flame colour.** `src/render/volumetrics/blackbody.ts`. Planck
integrated against the CIE 1931 2° observer into a 256-entry unit-luminance LUT over
500–2500 K, magnitude restored by Stefan–Boltzmann. §7.1.3 forbids the usual Kang cubic because
its validity stops at 1667 K and smouldering char sits below it.

**`validated`** — and genuinely so: it reproduces CIE illuminant A (a Planckian at 2856 K) at
x = 0.44757, y = 0.40745, and the 6500 K locus point, to within 0.006. That check is what pins
down the colour-matching-function fit, which is otherwise the one recalled thing in the file.

It also surfaced a real limit worth knowing: **below ~1500 K a blackbody is outside the sRGB
gamut**, so glowing char clamps to fully saturated red and cannot be shown redder. A display
limit, not a model limit; the test asserts the temperature trend on XYZ for that reason.

**WP 4.2 — the froxel march and composite.** `src/render/volumetrics/froxel.ts` plus
`shaders/render/volumetrics/froxel.wgsl`. A 1/16-resolution frustum march over §7.1.1's
piecewise depth distribution, integrating emission and in-scatter front to back with Hillaire's
analytic per-slice form, composited at full resolution.

**Transmittance is RGB and the composite is a compute pass, not an alpha blend.** Extinction
goes as lambda^-1.76, so the background seen through a plume is *reddened*; a single-alpha blend
collapses that and the plume greys the scene instead — the most recognisable thing about smoke,
thrown away to save a texture. That is why `hdr-color` gained `STORAGE_BINDING`.

Verified on GPU through a headless probe (`?debug`), because the pass only runs inside
`requestAnimationFrame` and this environment never composites:

```
volumetrics       peak scatter 4.67e+2 W/m2/sr over 2135/14400 froxels
  peak RGB        2.04e+3 / 4.17e+1 / 4.01e+1   (red-dominant)
  transmittance   min 0.0000, 2135/14400 froxels attenuated
```

**WP 4.6 (ground) — burn scars.** WP 1.6 had reserved bind group 3 and pointed `materialWgsl`'s
`burnGroup` at it; `terrain.wgsl` now declares it and the ground reads WP 2.4's consumed-fraction
field directly by world XZ, exactly as §7.6(d) specifies. Scorch, char and ash are three
monotone bands of the same consumption fraction, so ground can never un-burn. Residual surface
temperature for ember glow comes from the smoke field, so embers fade on the sim's own clock
rather than on a timer.

### Still to do in M4

- Temporal reprojection (4.3), fire lighting the scene (4.4), near-field flames (4.5)
- Burn state for **trees and grass** — §7.6(c)'s 32-texel 1D vertical profile per tree. Only the
  ground is wired.
- **No sun-transmittance volume**, so the plume does not self-shadow: a thick column is lit
  evenly rather than bright on top and dark underneath. §7.1.4 budgets 0.15 ms for it.
- **No curl-noise detail warp**, so structure is limited by the 4 m field.
- **The soot yield is `estimated` and scales plume opacity linearly.** Andreae (2019) Table 1 is
  open access and is the intended source; it has not been read. First thing to check against a
  photograph.

### Two rendering gaps that are not M4's and matter more than colour

- **There are no cast shadows anywhere.** The only occlusion in the scene is AO baked into bark
  furrows. Sunlit and canopy-shaded ground render identically, which is most of what makes a
  forest read as three-dimensional. Spec §7.9 budgets 2.20 ms for "terrain + shadow cascades";
  nothing has been built.
- **Exposure was metering every biome at 0.22 reflectance.** A closed conifer canopy is 0.08-0.15
  — one of the darkest natural land covers there is — so the shipping world rendered about 0.8
  stops under and read as murky. `BIOME_MEAN_ALBEDO` now meters per biome, and
  `test/app/exposure.test.ts` (which `exposure.ts` had claimed existed for months, and did not)
  pins it.

## 🚧 M5 STARTED — Canadian FWI (WP 5.2)

`src/weather/fwi.ts`: all six codes (FFMC, DMC, DC, ISI, BUI, FWI) plus the cross-walk to the
timelag-class moisture the surface solver takes. Pure, no clock, no SI — the system's
coefficients are fitted to °C/%/km·h⁻¹/mm and converting inside them would turn a published
model into an unpublished one, so the unit boundary is the input struct.

**Status is `calibrated`, not `validated`, and the reason is the interesting part.**

`DMC` and `DC` reproduce the Van Wagner & Pickett (1985) worked example to seven significant
figures — **8.5450511** and **19.013999** — which also confirms the input day and both
day-length tables. `FFMC`, `ISI`, `BUI` and `FWI` are **not** asserted against published
figures. The targets this test was first written against were *recalled, not read*, and the
implementation disagrees (FFMC 87.3675 vs 87.692980; ISI 4.0787 vs 10.853661). An independent
hand-calculation of the FFMC equations agrees with the implementation, and an ISI gap that large
cannot follow from a 0.33 difference in FFMC — so the recalled targets are the likely error, not
the code. Per §0.7 that means no `validated`. **Obtain Forestry Technical Report 33 (or the
`cffdrs` R package test fixtures) and either promote it or fix the transcription.**

Two properties the tests pinned that are the model's, not this transcription's:

- **The FFMC scale and its inverse are not exact inverses.** `F' = 1.00033·F + 0.0196`, because
  250 × 59.5 and 101 × 147.2 differ by 7.8 — the published constants are rounded to four
  significant figures. Residual is under 0.06 of a code unit. Do **not** rescale a constant to
  "fix" it; that silently replaces the published model with a nearby one.
- **FWI has a real ~0.05 % discontinuity at BUI = 80** where its two `f(D)` branches meet.
  Pinned rather than smoothed, for the same reason.

The **cross-walk to size-class moisture is `estimated`** and spec §6.7 says so outright: 10 h and
100 h are interpolated between the FFMC and DMC ends because the FWI system does not resolve
them. First thing to suspect if UK spread rates come out wrong.

## 📌 Parked for the polish pass

- **Temporal AA to kill foliage shimmer.** Owner-requested, deferred until the core is complete.
  Spec §7.9 already budgets 1.30 ms for "Post (shimmer, bloom, tonemap, TAA)", so there is a
  slot for it. Note that WP 4.3's temporal reprojection is a *different* thing — that one is for
  the froxel volume — but the two want the same motion vectors and jitter, so build them together.

## Unfinished work you should know about

### Literature research — 5 of 6 questions still open

A read-only research fan-out was launched to close the sourcing gaps using **free sources
only** (the agreed policy). One completed; five were killed by the usage limit and need
re-running. They are, in rough priority order:

| Question | Why it matters |
|---|---|
| **Wind limit** | The paywalled 2013 paper was never read. Free lead: USDA **RMRS-GTR-371** (Andrews 2018) almost certainly documents it, and the BEHAVE source encodes what is actually applied. Blocks M2. |
| **Chaparral** | Confirm the known bias of the substituted Rothermel SH5/SH7 model, and check whether a better *freely-documented* chaparral model exists. Blocks M5's chaparral biome. |
| **Firebrands** | Two problems: whether ember thickness was entered as full or half thickness (a 2× error if wrong), and drag coefficients that lost their source. NIST fire research is public domain and has measured exactly this. Blocks M3. |
| **Smoke optics** | Near-flame vs aged smoke scattering. The current 30 m distance threshold is an authored guess; wants a physically-motivated rule (soot age or temperature — both already computed). Blocks M4. |
| **Meteorology directions** | Five sense-bearing claims never individually re-checked. A backwards sign here makes fire run downhill instead of up. Blocks M5. |

The one that *did* complete — plume entrainment — is fully closed in
`docs/spec/30-canopy-heat-crown.md` and is a good model for what these should produce.

### Open questions

```bash
npm run spec:status
```

Regenerates [`docs/spec/_open-questions.md`](docs/spec/_open-questions.md) from the callouts
embedded in the spec documents. Currently **20 open**, 4 resolved. None of them block M1.

## Decisions already locked — do not relitigate

Recorded in `docs/spec/00-overview.md` §0.2, §0.6 and §0.7:

- Browser + WebGPU, TypeScript. 1 km², 0.5 m surface / 2 m canopy voxels.
- Hybrid fire model: Rothermel-calibrated surface layer + 3D voxel canopy with explicit
  radiative/convective/conductive transfer + Lagrangian firebrands.
- Five biomes. Chaparral ships on Rothermel SH5/SH7, **not** the unverifiable Anderson 2015
  model — the policy is to prefer a model *known* to be approximate over one merely
  unverified, because a known bias can be stated and corrected for.
- **SI internally. Moisture is a fraction, never a percent. Angles in radians.** Enforced by
  branded types in `src/contracts/units.ts` — mixing them is a compile error.
- Every model carries a validation status, surfaced in the HUD and written into exports.
- No suppression simulation. No run recording/replay.

## Two environment gotchas

1. **The in-app browser pane runs on the Intel iGPU, not the RTX 4070.** It runs under
   `msedgewebview2.exe`, which has no per-app GPU preference set, so Windows gives it the
   power-saving adapter — even with `powerPreference: 'high-performance'` and on AC power.
   Functional verification there is fine; **any frame timing from it is ~10× off and
   meaningless** against the 60 fps target. Either run in your own Chrome, or set
   `GpuPreference=2;` for `msedgewebview2.exe` under
   `HKCU:\Software\Microsoft\DirectX\UserGpuPreferences`. The boot screen warns when the
   adapter looks integrated — check that line before trusting any measurement.

2. **Node is not on this session's PATH** (it was installed after the shell started).
   `.claude/launch.json` therefore calls `node.exe` by absolute path. A fresh terminal will
   have it normally.

## Nothing was downloaded

`scripts/fetch-assets.mjs` was written but **not run**. It would fetch CC0 PBR material sets
from Poly Haven / ambientCG into `public/assets/materials/`. M1 runs entirely on
procedurally-generated materials, so the download is optional — read the script, check the
licences, and run it if you want photographic materials.
