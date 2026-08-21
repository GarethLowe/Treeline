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
