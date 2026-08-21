# ForestFire — history

What was tried, what broke, and what the failure taught. Kept out of
[HANDOFF.md](../HANDOFF.md) so that file stays a description of the present.

Every section here is a completed episode. Nothing in this file is a to-do.

## The canopy was on a different clock from the fire, 2026-08-21

**Symptom, for three sessions:** the 3D canopy would not ignite under any surface fire. Van
Wagner's curve read 94 % crown fraction burned on a stand where the voxel field reported
0 flaming of 1.2 M, and the hottest voxel in the whole canopy sat at 373.1 K.

**What we concluded, wrongly, twice.** First that the plume's near field collapses (its
half-width falls 2.19 m -> 0.30 m over 4 m) and starves the crowns. Then, after fixing a NaN in
`crown-probe.mjs`'s own convection call, that the plume works but "every heated voxel is finding
the cold side of the plume and none is finding the core", and that the next step was a per-voxel
gas readback to find an `acrossM` sign error.

**What it actually was.** `FireSim.step` consumes `timeScale` internally as substeps and
advances the world by `scale x dt`. Its callers passed their own unscaled `dt` on to
`canopy.step` and `smoke.step`. Both parameters are `Seconds`, so the branded unit types --
which exist precisely to make unit errors compile errors -- could not see it, because this is
not a unit error. It is the *same* unit carrying a different quantity. At the default 8x the
canopy received an eighth of the drying time the fire drying it received.

Drying is enthalpy-limited, so the crowns were not under-heated, they were under-*clocked*:
they reached the water boiling plateau and stayed there forever, which is why the hottest voxel
in the canopy was pinned to five significant figures at `WATER_BOILING_K = 373.124`.

**The fix is four lines.** `FireSim.step` returns the simulated time it advanced; the two call
sites pass that to the canopy and the smoke field instead of their own `dt`. Before and after,
same GPU, same fire (SB4, 6 m/s, 480 s of surface time):

| | before | after |
|---|---|---|
| voxels flaming / ever ignited | 0 / 0 | 112 / 412 |
| hottest canopy voxel | 373.1 K | 998.3 K |
| hot-gas voxels pinned at the plateau | 251 of 297 | 0 |

**Three things this cost us, and what now catches each.**

1. **A marginal statistic is not a joint one.** "Hottest gas 1193 K" and "hottest voxel 373 K"
   were both true and, read together, suggested the hot voxels were elsewhere. They are
   `atomicMax` over different voxels. The pair that settled it was *gated on one condition* --
   voxels in gas >= 800 K, and the hottest of those -- which is the only form that describes a
   single population. Prefer gated pairs to marginals when the question is about one voxel.
2. **A CPU oracle fed assumed inputs is not an oracle.** `crown-probe.mjs` was written on the
   right principle ("if the CPU says ignite and the GPU says no, the bug is wiring") and then
   handed 53 kW/m2 of irradiance where the `?debug` probe reports 2.49. That one unmeasured
   constant flipped its answer to NO IGNITION and pointed every session at the physics. Fed the
   measured values, the same oracle ignites the same voxel in 1.83 s. The script now says so at
   the top, and carries measured numbers.
3. **The comment asserting the invariant outlived the invariant.** `main.ts` said "M3 on the
   same encoder and the same clock as the surface fire" directly above the line that broke the
   clock. Guarded now by a source-text test in `test/app/fire.test.ts`, in the same style as the
   WGSL mirror tests -- nothing else can catch it, since both values type-check and stepping any
   of it needs a GPU.

The plume defects the first two sessions found are real and remain open, recorded in
`docs/spec/30-canopy-heat-crown.md` 7.5: the Mercer & Weber integration still starts at ground
level rather than above the flaming zone, and the LUT's 4.13 m rows do not resolve the near
field. Neither was the cause of anything.

## The contract-first bet paid off

Eight agents built eight packages **in parallel, none of them seeing another's code**, each
coding against the frozen interfaces in `src/contracts/`. On first assembly:

- `npm run typecheck` → **zero errors**
- `npm test` → **935 passed, 0 failed** across 48 files

Both load-bearing acceptance criteria are met, and tested harder than specified:

- **WP1.4 (trees)** — geometry-measured crown base height and foliar biomass match each
  stem's *physical* fuel parameters within 10%, across every species in every biome, across
  many seeds, *and through the mesh cache* (the path the renderer actually takes). It also
  ships "the measurement is actually sensitive" tests that prove the check can fail, so it
  is not passing vacuously. This is what stops the picture and the physics drifting apart.
- **WP1.7 (sky)** — solar position agrees with an independent ephemeris well inside the 0.1°
  criterion; equinox declination, solstice obliquity, equation-of-time extrema, and published
  London/Los Angeles sunrise-sunset times all check out. It already includes slope-aspect
  insolation tests explicitly labelled *"the M5 coupling"* — south-facing slopes take more
  load than north-facing, with self-shadowing. The fire-physics coupling is live.

## 📊 MEASURED — RTX 4070 Laptop, clean sweep, 2026-08-19

Chrome forced onto the discrete GPU (`chrome://flags/#force-high-performance-gpu`) with WebGPU
developer features on, so timestamps are unquantised. Boot reports **"NVIDIA GeForce RTX 4070
Laptop GPU — discrete GPU (as requested)"**.

| quality | GPU render | submit wall clock | rAF | verdict |
|---|---|---|---|---|
| 0 | 3.67 ms | 7.29 ms | 16.66 | FITS |
| 1 | 4.32 ms | 8.04 ms | 16.66 | FITS |
| 2 | 5.50 ms | 9.13 ms | 16.66 | FITS |
| 3 | 6.81 ms | 10.24 ms | 16.67 | FITS |
| 4 | 8.25 ms | 11.74 ms | 16.66 | FITS |
| **5** | **8.25 ms** | 11.47 ms | 16.67 | **FITS — 60.0 fps** |

**Quality 5 uses half the 16.67 ms budget with no fire burning.** That is the headroom M4's
volumetrics has to fit inside.

Quality 4 and 5 read identically because they differ *only* in `froxelMarchSteps` and
`nearFieldParticleBudget` (see `QUALITY_TABLE` in `src/contracts/gpu.ts`), both of which are M4
features that do not exist yet. Not a bug; they will diverge when M4 lands.

An earlier `19.9 ms` figure and a `quality 2: 937.95 ms` figure were both **contaminated** and
are withdrawn — see the methodology rules below.

**How to run `?bench` so the numbers mean something.**

- **Do not build, test, or edit anything while the sweep runs.** Vite HMR restarts it, and CPU
  contention dominates the measurement.
- Expect the first level's warmup to be slow (tens of seconds): it is compiling pipelines.
  That is what warmup is for, and it is why warmup figures must never be reported.
- The whole sweep is 6 levels x 390 frames. Budget several minutes.
- Read the result from the on-page textarea, not the console — the console can serve cached
  messages from a previous page session, which is its own way of lying. It did exactly that
  twice during this work.
- **The Chrome tab must be composited.** `requestAnimationFrame` does not fire for a
  background tab, so the boot screen reports "First frame — deferred until it is" and the sim
  clock never advances. `document.hidden` is the check. `?debug` works fine hidden, because
  everything it does is compute and readback.

## ✅ Profiler attribution — FIXED

Every phase used to read 0.000 ms except `render`, so a frame could be measured but not
apportioned. Three subsystems opened their own passes outside the scheduler: `FireSim.step`
(on its own encoder, deliberately), `IFoliageRenderer.cull` and `IEnvironmentLighting.update`.

`src/gpu/attribution.ts` wraps a `GPUCommandEncoder` in a proxy that routes `beginComputePass`
and `beginRenderPass` through the profiler under a fixed phase. No contract widened, no
subsystem touched, ~40 lines. The `surface` phase went from 0.000 ms to **35 ms at 8x time
scale** the first time it was switched on — cost that had always been there and had never been
visible.

`MAX_TIMED_PASSES` was raised 64 → 256: the solver encodes two passes per substep and the HUD's
time-scale control multiplies substeps by up to 16, so 64 overflowed immediately.

## ✅ WP 2.3 / WP 2.4 reconciled — intensity and consumed fraction are real

`intensityTexture` and `consumedTexture` had been structurally zero since both packages landed.
WP 2.4 declared two per-cell atomic accumulators for the propagation shader to scatter into;
**WP 2.3 never bound them and never called the writers.**

The accumulators are gone. WP 2.3 already stamped arrival time when phi crosses zero; it now
also stamps the *normal rate of spread at that instant* into a new `rosArrival` field, which is
the one quantity that cannot be recovered afterwards. `FireOutputs` binds arrival and rosArrival
read-only and derives Byram `I = I_R · t_r · R` plus the burnout curve. One writer, one reader,
no per-cell atomics — order-independent by construction rather than by atomic discipline.

Verified on the RTX 4070, `?debug`:

```
burnt area        88.0 m2   (order-of-magnitude expectation 111.2 m2)
perimeter         33.0 m
WP 2.4 fields     peak intensity 530.0 kW/m over 352/4096 texels, max consumed 32.5 %
GPU validation    no errors raised
PASS
```

**530.0 kW/m from the GPU field against 523 kW/m from the independent CPU Rothermel oracle —
1.3 %.** Two entirely separate code paths agreeing on fireline intensity. The 352 burning texels
match the control block's burnt-cell count exactly.

### Three latent bugs this activated, all invisible to `npm test`

Constructing `FireOutputs` for the first time ran WGSL and GPU calls that had never executed.

| # | Bug | Why it was invisible |
|---|---|---|
| 1 | `const ARRIVAL_NEVER: f32 = 3.40282347e+38` | Dawn range-checks a decimal literal **before** rounding, so both usual spellings of FLT_MAX are rejected. The `burnout` shader module was invalid, every pipeline from it was invalid, and **every command buffer containing one was discarded** — taking the surface solver's innocent compute passes with it. Fixed with the hex float `0x1.fffffep+127`, which is exact. Do not "simplify" it back to decimal. |
| 2 | `aggregateBuffer` created `STORAGE \| COPY_SRC` | `resolve()` zeroes it with `encoder.clearBuffer`, which needs `COPY_DST`. Same whole-command-buffer discard. |
| 3 | Readback interlock starved | Skipping the staging copy while a map was in flight meant the copy was *never* encoded: map → skip → map → skip. Every aggregate read zero, which looks exactly like a fire that is not burning. Fixed with a `copyPending` handshake so copy and map alternate. |

> **The lesson, again, and it is now four for four.** An invalid WebGPU operation does not
> throw. It discards the entire command buffer and prints a warning — and Chrome stops printing
> warnings after a few, then serves stale ones from a previous page session. **Never diagnose a
> GPU result from the console.**

### The tool that ends this class of bug

`FireSim` now installs an `uncapturederror` listener into `gpuErrors` (exported from
`src/app/fire.ts`) and the `?debug` self-test prints the first six. It named bug 1 in one
iteration; the same shape of bug cost three iterations and a wrong report to the user last time.
`?debug` also now reads the WP 2.4 output textures back, because a green suite cannot see them —
Vitest has no WebGPU, so the burnout shader never reaches a compiler there.

**Whole repo: 0 type errors, 1710 tests passing, 272 validation cases, 0 failing.**

## 📊 MEASURED WITH EVERYTHING RUNNING — 2026-08-20

First frame timing with the surface solver, canopy, smoke field and volumetrics all live, on the
RTX 4070, window focused, fire burning:

```
fps / frame    60 / 10.1 ms gpu, 13.5 ms submit     quality 5 (auto)
  surface      1.033 ms
  canopy       0.611 ms
  fluid        0.625 ms      <- WP 4.1 smoke advection
  brands       0.000 ms
  render       7.872 ms      <- includes the froxel march and composite
render target  2560x1362 @ 100%
```

**60 fps at quality 5 with the whole simulation running.** The 8.25 ms render-only figure from
the earlier clean bench is now 7.9 ms with volumetrics added, and the three simulation phases
together cost 2.3 ms — comfortably inside spec §7.9's 4.50 ms simulation allowance. Every phase
reads a real number now, which is the profiler attribution fix earning its keep.

### What the first proper look showed

Smoke **is** visibly rendering — a drifting layer that obscures the middle distance — and the
exposure fix is working (exposure 4.07e-3, up from 2.41e-3, and the scene reads correctly lit).

**Two things the screenshot found that no probe would have:**

1. **Grass renders blue-violet, not green.** In the foreground, under full sun, the grass is
   clearly the wrong hue while tree bark and needles beside it look right. Suspect the grass
   draw path taking sky/ambient irradiance without the direct sun term — `foliageRenderer`
   receives `setIrradiance(direct, diffuse)` as two scalars, and if grass weights the diffuse
   (blue) term and drops the beam, this is exactly what it would look like. **Not yet
   investigated.**
2. `?fireView` (WP 2.6's debug isochrone overlay) paints flat colour over the whole scene and is
   ON by default. It is not a rendering bug, but it hides everything M4 draws — use
   `?fireView=off` for any visual judgement.

## ✅ M3 COMPOSED — the canopy chain runs end to end

Seven work packages were "delivered and not composed": the sparse voxel store (3.1), pyrolysis
kinetics (3.2), radiative transfer (3.3), convection (3.4) and firebrands (3.6) all shipped
complete, tested, and constructed by nobody. **Three pieces were missing between them**, and
none of the seven owned any of them:

| missing piece | where it went |
|---|---|
| Something to produce the emitter buffer WP 3.3 consumes | `shaders/sim/canopy/radiation/emit_surface.wgsl` + `src/sim/canopy/radiation/surfaceEmitters.ts` |
| The extinction field and brick list WP 3.3 reads at build time | `src/sim/canopy/radiation/build.ts` (pure, CLI-tested) |
| **The voxel pass itself** — WP 3.4's header literally says *"whoever wires this into WP 3.1's voxel pass must profile it"*, and there was no such pass | `shaders/sim/canopy/voxel_step.wgsl` + `src/sim/canopy/voxelStep.ts` |

`src/app/canopy.ts` owns the lot and runs the three channels at their three different rates:
plume on weather change, radiation at 7.5 Hz, voxel step and firebrands every step. Verified on
a real GPU via `?debug`:

```
prime run         240.0 s simulated at timeScale 8, 1 ignition(s)
  surface         3049 m2 burnt, 28928 active cells, peak 920 kW/m
voxel store       1,197,920 voxels in 1,234,792 slots, 10,122/32,768 bricks (30.9 %)
foliage mass      2793.3 t deposited, 12.79 t clipped
surface state     4 BURNING, 3746 BURNT of 4096 sampled at the domain centre
surface emitters  747 flame panels
irradiance        peak 5.93 kW/m2 over 3826/4096 cells sampled at 8 m AGL
canopy voxels     6 flaming, 6 ever ignited
PASS — flame panels radiate, the gather resolves a field, and the voxel pass reads it.
GPU validation    no new errors during the prime run
```

The voxelisation independently reproduces WP 3.1's own measured table (it predicted 1,199,320
voxels and 10,117 bricks; the composed build gives 1,197,920 and 10,122), and the 3D radiation
field and the empirical Van Wagner criterion agree that this fire does **not** crown — 920 kW/m
against a critical 3514 kW/m, and 5.93 kW/m² at 8 m is well under the ~20–40 kW/m² sustained
that crown ignition needs. Two independent models, same answer.

The 6 flaming voxels are **convective**, not radiative: the count is identical in a run where
the irradiance field was zero. That is the spec's own claim (§7.5: convection ignites fuel in
~1 s and is the fast channel) showing up in the numbers.

### Four bugs this composition exposed, all of them silent

| # | Bug | Why it hid |
|---|---|---|
| 1 | **`SurfaceSolver.step` mapped a staging buffer the same encoder had written** | The readback ring defers its `mapAsync` by one call, assuming the caller submits in between. `FireSim.step` loops once per unit of `timeScale` on ONE encoder, so at the shipping default of 8 the map landed on a buffer that encoder had already copied into and **the whole command buffer was discarded. At the default settings the fire did not spread at all** — and the `?debug` self-test passed throughout, because it pins `timeScale` to 1. Fixed with an explicit `readback` flag: only the last substep on an encoder encodes one. |
| 2 | Two pipelines sharing one `layout: 'auto'` bind group | An implicit layout is only ever compatible with the pipeline that created it. Because the canopy rides on the fire's encoder, the invalid dispatch discarded **the surface solver's passes too** — a fire that stops spreading, three subsystems from the cause. |
| 3 | **The radiation grid was in absolute world Y** | `RAD_ORIGIN_Y = 0` over a 128 m span, and this project's terrain sits at 1942–2078 m. The entire radiative field was a kilometre and a half underground: every emitter outside it, every gather returning zero, nothing reporting an error. WP 3.1 had already called height-above-ground *forced* for the voxel store; radiation now matches. |
| 4 | `canopyPoolC` declared and never used | `layout: 'auto'` drops an untouched binding, so the bind group supplying it failed with "binding index 4 not present in the bind group layout". Pool C is the flux pool, so the pass now writes the net volumetric source into it — which is what it is for. |

> Bugs 1, 2 and 4 are all the same shape as the four before them: **an invalid WebGPU operation
> discards the entire command buffer and only warns.** The `gpuErrors` buffer added earlier
> named 2, 3 and 4 in one iteration each. Before it existed, this class of bug cost three
> iterations and a wrong report to the user. **Read `gpuErrors`, never the console.**

## 🔥 Fire spreads. `?debug` self-test PASSES.

```
burnt area     88.0 m2   (order-of-magnitude expectation 111.2 m2)
perimeter      30.0 m
active cells   4096 (0.098 % of the grid)   <- the active-set optimisation works
rosCache       max R_head 11.56 m/min  vs CPU oracle 11.407  (1.3 %)
phi @ ignition 12/256 negative, min -4.892 m   <- the 5 m ignition disc
dispatch overflow  no
```

**Six real bugs stood between "all tests green" and "fire spreads". `npm test` could not see
one of them** — Vitest runs under Node, so no WGSL ever reaches a compiler and every GPU test
skips.

| # | Bug | Effect |
|---|---|---|
| 1 | `active` used as a variable in two classify shaders — a **WGSL reserved word** | Shader module invalid, `SurfaceSolver` threw. Third instance after `target` and `layout`; `test/app/wgsl-reserved.test.ts` now lexes every `.wgsl` against the W3C list |
| 2 | `workgroupBarrier` in non-uniform control flow (`advance()`) | An early `return` made both barriers illegal. Uniform at runtime, but unprovable through an `atomicLoad`. Now guards writes with `inRange` so every invocation reaches both barriers |
| 3 | **`mapAsync` called at ENCODE time in `SurfaceSolver.readback()`** | **The root cause.** The staging copy was encoded and mapped in the same breath, so the caller's later submit contained a copy into a pending-map buffer. WebGPU discarded the **entire command buffer** — every compute pass in it — with only a warning. The ignition was spliced off the queue and lost with it. Fixed by deferring the map to the next step, by which time the caller has submitted |
| 4 | Readback ring exhausted in `selfTest` | 600 submits with no yield; `mapAsync` callbacks are macrotasks and never ran. **The test reported "nothing burnt" whether or not anything burnt** |
| 5 | `?debug` deadlocked before any diagnostic | Runs a 120-frame smoke test first; rAF never fires in a non-compositing tab |
| 6 | My own probe: `rosCache` lacked `COPY_SRC` | `copyTextureToBuffer` was invalid and poisoned the whole encoder, zeroing every other probe batched with it. **It confidently reported the wrong broken stage for three iterations** |

> **The lesson worth carrying.** Bugs 3, 4 and 6 are all the same shape: **an invalid
> operation silently invalidates an entire command buffer, and WebGPU only warns.** Nothing
> throws, nothing returns an error, and the symptom appears somewhere else entirely. When a
> GPU result is empty, suspect the *submit*, not the algorithm. Give each probe its own
> encoder so one bad copy cannot poison the rest — and never trust "no console errors" after
> Chrome prints *"too many warnings, no more warnings will be reported for this GPUDevice"*.

**Foliage bind-group mismatch — FIXED.** `foliage.treeDraw` and `foliage.grassDraw` both
failed pipeline creation, so **no tree and no blade of grass rendered at all** while terrain,
sky and the fire view were unaffected — the scene looked bare rather than broken.

WP 1.5's shader put the material sampler at `@binding(3)`; WP 1.6's real layout has the crack
field there and the sampler at 4. The WP 1.5 author had flagged the guess and predicted the
remedy exactly — *"if WP 1.6 numbers them differently the fix is this file and nothing
else"* — and it was one binding index. `stubMaterials.ts` was corrected to match, because a
stub that disagrees with the real layout makes a package's own tests pass against a fiction.

Not yet composed: canopy voxels, radiation, convection, firebrands (WP 3.1–3.4, 3.6). Crown
fire (3.5) is wired, being pure CPU.

## 🧹 CLEANUP PHASE 1 — in progress

Executing `docs/CLEANUP-SPEC.md`. Steps 1.1-1.4 done and verified (`?debug` PASS, `gpuErrors`
empty, `npm run validate` green against the real kernel).

**1.1 — validation now runs against the shipping kernel.** `sim/validation/kernel.ts` had
pointed at the WP 2.5 stub since it was written, so all 272 cases characterised a module nothing
imported. Repointed at `sim/rothermel/`. **All 18 published cases pass against the real kernel**
— GR2 D2L2 reproduces published ROS to 0.32%. The 662-line stub is gone; its Cheney grass model
moved to `sim/rothermel/grass.ts` (real, cited physics WP 5.7 will need). Sweep trimmed 242 -> 9
representative models, and `SWEEP_MODELS` now throws on an unresolvable code rather than
silently sweeping fewer.

Three things the swap exposed:
- The harness and production disagree on units for `rateOfSpread` and `firelineIntensity` (SI vs
  English). Resolved in the adapter so cases keep reading as physics; the English values are
  `rateOfSpreadFtMin` / `firelineIntensityBtu`.
- `midflame-waf` claimed `validated` on the strength of a unit test. §0.7.3 says only a published
  case in this suite confers that, so its three Albini & Baughman anchors moved into the harness.
  **21 published cases now, up from 18.**
- `wind-limit-none` **downgraded to `calibrated`** — its own tolerance text says "Structural, not
  numeric", which by §0.7.3 cannot confer `validated`.

**1.2 — the third Rothermel.** `sim/surface/rothermel.ts` 496 -> 437 lines. The contract-level
duplicate API (`rothermelROS`, `byramIntensity`, `flameLength`, `windToFeetPerMinute`) is gone.
`buildCoefficients` and `kernel()` STAY and are not duplication: the first factors the algebra
into its moisture-independent half for the GPU LUT, which `rothermelIntermediates` cannot do
because it takes moisture as an input; the second is the CPU mirror of the shader's per-cell
evaluation and is what makes the LUT testable without a GPU. `test/sim/surface/rothermel.test.ts`
deleted — `kernel.test.ts` covers every trap it did, against the shipping model.

**1.3 — dead stubs.** Nine listed; **five were genuinely dead, four were not.**
`camera/terrainStub.ts` (`TerrainSampler`, `StubTerrain`), `world/vegetation/terrainStub.ts`,
`sim/firebrands/stubs.ts` (`StubEmitter`) and `sim/propagation/stub.ts` (`uploadRosCache`) all
had live production callers the audit missed — restored per the spec's escape hatch, with
`StubEmitter` inlined next to the system that consumes it. Tests now share one
`test/fixtures/world.ts`.

**1.4 — devchecks and the duplicate mat4. This one found a real bug.**
`render/foliage/cullMath.ts` carried its own Gribb-Hartmann plane extraction. Same derivation and
same packed layout as `camera/math.ts`'s, but it hard-coded the **non-reversed-Z** near/far
assignment while the renderer ships `REVERSED_Z = true`. **Under reversed-Z those two planes are
swapped, so the foliage culler's near and far planes were inverted and neither rejected
anything** — trees behind the camera were being submitted every frame. The four side planes were
correct, which is exactly why it looked fine. Deleted; the cull path now uses the camera's
reversed-Z-aware extractor.

Also gone: three `devcheck.ts`/`.html` harness pairs (~1,113 lines), the second wgpu-matrix
adapter, `core/smoke.ts`. `cullOracle.ts` moved into `test/`.

**1.5 — the boot smoke test** left the bundle (`core/smoke.ts`, 298 lines). `?debug` covers what
it checked, and the `looksIntegrated` adapter warning — the part that catches the iGPU problem —
stays in `core/device.ts`.

**1.6 — provenance collapsed.** Eleven files, 2,005 lines, into one 188-line `src/provenance.ts`
holding 48 models as a flat table. Full references, known biases and open questions moved to
`docs/spec/_provenance-notes.md` (510 lines). Spec §0.7.4 survives: the HUD still shows the
weakest contributor per subsystem and `?debug` still dumps every model with its locator.

Records were extracted by RUNNING the modules, not by parsing them, so no citation was lost to a
regex — and when the first pass did miss eight records (their citations were named consts, not
inline objects) that showed up as `— — —` in the rendered report and was fixed from the source
map rather than left.

Two consequences worth knowing:
- The late-registration side channel is gone. `FireSim`/`CanopySim` no longer carry a
  `provenance` array and `registerFireProvenance` no longer exists; the table is static.
- The §0.7.3 over-claim check now reads the whole table, so it had to be **scoped to models this
  suite carries cases for**. It cannot speak for models validated elsewhere against their own
  anchors — solar position against an ephemeris, blackbody colour against CIE illuminant A — and
  complaining about those would push a correct claim down to `calibrated` to silence a test that
  was never their arbiter.

**1.7 — single-implementer interfaces gone.** `IWorldRenderer`, `ICanopySolver`, `IDevice`,
`IFrameLoop`, `IQualityController`, `ICameraRig`, `IFirebrandSystem` deleted;
`WorldRendererDeps` takes the concrete `FrameProfiler`, `FoliageRenderer`, `SkyRenderer`,
`EnvironmentLighting`. The "DO NOT EDIT DURING A FAN-OUT" banner is gone from
`contracts/index.ts`.

**`src/gpu/attribution.ts` is DELIBERATELY KEPT — this item is skipped, not forgotten.** The
spec's rationale is that the encoder `Proxy` "existed only because contracts were frozen". That
is half the story. It exists because **25 `beginComputePass` call sites sit several layers below
the entry points**: threading a profiler into `FireSim.step` does nothing unless
`SurfaceSolver.step`, `FireOutputs.resolve`, `SurfaceRosPasses.encodeSubstep`,
`CanopyRadiation.encode`, `CanopyVoxelStep.encode`, `SurfaceEmitterPass.encode`,
`FirebrandSystem.step` and `SmokeField.step` all take one too. Replacing a 40-line proxy with a
parameter threaded through ten signatures is a bigger diff and more code, and it puts the
per-phase attribution fix — which the spec itself says must not regress — at risk for no gain.
Revisit only if something else needs those signatures widened anyway.

**1.8 (partial) — dead infrastructure.** Empty `src/audio/` and `src/ui/` removed with their
aliases in `vite.config.ts` and `tsconfig.json`, and the COOP/COEP cross-origin-isolation plugin
deleted: it was there for `SharedArrayBuffer` in Web Workers, and there are no workers and no
`SharedArrayBuffer` anywhere in the tree.

`src/` 47,894 -> 45,030 lines so far (-2,864). Remaining: 1.8's barrels, math consolidation,
options bags, boot stages and bench report; 1.9's test posture.

---

# Moved out of HANDOFF.md, 2026-08-21

HANDOFF.md had grown to 655 lines against its own 150-line rule, and the cost was not only
length: it asserted in one place that the scene had no cast shadows and in another that sun
occlusion had shipped. Everything below is a **completed episode** and was moved here whole.
Where a section has since been overtaken, the correction is marked inline as `[LATER]`.

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


## WP 4.5 — near-field flames

`src/render/flames/flameRenderer.ts` + `shaders/render/flames/flames.wgsl`. Before this,
**nothing in the renderer drew fire**: WP 2.6's overlay put a false-colour stain on the ground
and the froxel march carried the smoke, but the flame itself was absent. Neither debug view
reads as fire — arrival is a magenta stain, intensity is pale magma — so a different colormap
was never the answer.

Two stages, reading only the public `IFireOutputs` textures so this watches the solver rather
than duplicating it:

- **`csGather`** — one thread per `FLAME_STRIDE` x `FLAME_STRIDE` block of surface cells;
  blocks whose centre is `STATE_BURNING` append a billboard. Scanning at a stride is what makes
  it cheap: the surface grid is 2048² = 4.2 M cells and a metre of burning ground does not need
  four flames on it. Overflow past `MAX_FLAMES` is **dropped and counted, never wrapped** —
  wrapping would overwrite live flames and thin the front with no indication. `?debug` prints
  the count.
- **`vsFlame`/`fsFlame`** — instanced quads, billboarded about the vertical axis only (a flame
  stands up; a spherical billboard shears into the ground when you look down at it), leaning
  downwind, additively blended and depth-tested but not depth-writing.

**No textures, and no new constants.** The shape is procedural noise; the colour is the
blackbody LUT from `render/volumetrics/blackbody.ts`, `validated` against CIE illuminant A; the
base temperature is `DEFAULT_FLAME_TEMPERATURE_K` (1200 K, §7.4) passed in from the radiation
package rather than repeated; the height is Byram flame length. A flame here is the same
physics as the glow the froxel march emits.

`test/render/flames/flames.test.ts` pins the flame-length relation across all **three** places
it now lives — the CPU kernel, `burnShade.wgsl` and `flames.wgsl`. Three copies is one more
than comfortable and WGSL never reaches a compiler under Node.

### Known limits

- Each billboard is independent: flames do not lean into each other or merge, and there is no
  vorticity. §7.4's flame *sheet* is what the radiation package models for heat transfer; this
  is its visible counterpart, not a fluid solve.
- **Flames do not light anything.** Fire lighting the scene is WP 4.4 and still unbuilt, so a
  night fire illuminates no grass and casts no light on trunks. This is the next obvious gap.
- No bloom, so the brightest cores clamp flat at the ACES shoulder — Phase 3 rung 3.


## Fireline intensity latched after burnout — fixed

Found by looking at the intensity debug view through the headless runner: the burnt interior
was *brighter* than the advancing edge. A fireline is a ring, not a disc.

`burnout.wgsl` gated the intensity write on `arrival < ARRIVAL_NEVER` — "the fire ever reached
this cell" — so every cell latched at its arrival intensity for the rest of the run. The state
enum three lines below already had the right test (`dt < model.residenceTime`); the intensity
write just never used it. Byram's I is a property of the flaming front.

**This was not only cosmetic.** `emit_surface.wgsl` builds the canopy's radiant panels from
this texture, so cells that stopped burning minutes earlier were still heating the crowns above
them, and Van Wagner crown initiation reads the same field. The M3 probe's "irradiance peak
5.93 kW/m2 over 3826/4096 cells" was measured under the old behaviour — **re-measure it**, the
irradiated fraction should fall a long way.

> **[LATER] Re-measured 2026-08-21: peak 2.49 kW/m2 over 3295/4096 cells.** Both fell, as
> predicted. Worth knowing that the stale 53 kW/m2 hard-coded in `crown-probe.mjs` was never
> either figure, and sent three sessions after a plume bug that did not exist.

Tests and validation stayed green across the change (1763 / 51).


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

> **[LATER] Not true on the current machine**, where it reports `nvidia / blackwell`,
> `discrete (as requested)`. Read the adapter line the runner prints; it is the only authority.

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


### Two rendering gaps that are not M4's and matter more than colour

> **[LATER] Both of these were closed and this section went stale where it sat.** Cleanup
> phase 3 rung 1 shipped `render/shadow/sunOcclusion.ts`, so "there are no cast shadows
> anywhere" stopped being true, while the same file said so two sections apart. The exposure
> gap the second bullet describes was fixed in the same breath that described it.

- **There are no cast shadows anywhere.** The only occlusion in the scene is AO baked into bark
  furrows. Sunlit and canopy-shaded ground render identically, which is most of what makes a
  forest read as three-dimensional. Spec §7.9 budgets 2.20 ms for "terrain + shadow cascades";
  nothing has been built.
- **Exposure was metering every biome at 0.22 reflectance.** A closed conifer canopy is 0.08-0.15
  — one of the darkest natural land covers there is — so the shipping world rendered about 0.8
  stops under and read as murky. `BIOME_MEAN_ALBEDO` now meters per biome, and
  `test/app/exposure.test.ts` (which `exposure.ts` had claimed existed for months, and did not)
  pins it.
