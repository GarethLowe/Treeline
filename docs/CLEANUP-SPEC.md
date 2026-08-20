# Cleanup & Visual-Wins Spec

Owner-approved 2026-08-20, from a three-agent audit (src over-engineering, test/process
overhead, visual quality). Execute **sequentially, in phase order**. Sanctioned maintenance
phase: `src/contracts/` is **unfrozen for Phase 1 only** — listed deletions are approved; do
not add anything new to it.

**Ground rules.** Delete, don't deprecate — no `_old` files, no commented-out code, no shims.
No new abstractions, dependencies, or drive-by refactors beyond what a step names. After every
step: `npm run typecheck` and `npm test` green. After Phases 1 and 2: `?debug` PASS with
`gpuErrors` empty. If a listed "dead" file turns out to have a live caller, skip it, note it in
HANDOFF.md, continue — do not improvise a bigger change.

**Do NOT touch:** `contracts/units.ts`; buffer-layout constants in `contracts/gpu.ts`,
`sim.ts`, `world.ts`; the shader-mirror test cluster (10 files incl. `wgsl-reserved.test.ts`);
`test/contracts/units.test.ts`; `test/weather/fwi.test.ts`; the 18 `published` validation
cases; `scripts/spec-status.mjs`; `app/settings.ts` (except the one Phase 2 default); the
physics in `src/sim/`.

## Phase 1 — scaffolding teardown

**1.1 Point validation at the shipping kernel (FIRST).** `sim/validation/kernel.ts` still
re-exports `./rothermelStub`, so all 272 cases characterise a module nothing imports. Repoint
at `sim/rothermel/`. Run `npm run validate` — **the 18 `published` cases MUST pass; if any
fails, STOP and report**, that is a real physics discrepancy. Re-record baselines
(`UPDATE_BASELINES=1`). Trim `buildSweep` in `cases.ts` (~623–679) from 242 to ~30: one
representative fuel model per fuel type × existing scenarios; keep all `published` and
`structural`. Delete `rothermelStub.ts` (662).

**1.2 Collapse the third Rothermel.** `sim/surface/rothermel.ts` (496, header says "STUB of
WP 2.1") feeds `coefficients.ts` → the GPU LUT. Keep the `buildCoefficients` LUT split (real
optimisation); make it call `sim/rothermel/kernel.ts`. Delete the duplicated algebra and the
now-duplicate assertions in `test/sim/surface/rothermel.test.ts` (keep LUT-packing tests).
GPU-vs-oracle `?debug` checks must still pass.

**1.3 Delete dead stubs** (13 files, ~2,360 lines, zero production callers):
`render/foliage/stubs/` (5), `world/trees/stubStems.ts`, `render/firedebug/stubFire.ts`,
`world/vegetation/terrainStub.ts`, `camera/terrainStub.ts`, `sim/surface/fuelStub.ts` (first
move `NON_BURNABLE_ID` and `FUEL_SIZE_CLASS_ORDER` to `sim/rothermel/fuelModels.ts`),
`sim/burnout/stubs.ts`, `sim/firebrands/stubs.ts`, `sim/propagation/stub.ts` (first move
`toHalf` to its one production caller). Tests get ONE shared `test/fixtures/world.ts` (~80
lines: one fbm terrain sampler, one deterministic stem list) — not per-package fixtures. Also
delete the stale swap-note at `app/worldGen.ts:5–10`.

**1.4 Delete devcheck harnesses and the duplicate mat4.** `devcheck.ts` + `devcheck.html` in
`render/foliage/`, `sim/surface/`, `render/firedebug/` (~1,113; nothing links to them). Delete
`render/foliage/math/mat4.ts` (119) — second wgpu-matrix adapter, use `camera/math.ts`. Move
`render/foliage/cullOracle.ts` (152) into `test/`.

**1.5 Delete the boot smoke test.** `core/smoke.ts` (298) and `core/adapter-advice.ts` (126).
Keep `looksIntegrated` in `core/device.ts` and the boot adapter line — that is the part that
catches the iGPU problem. Remove the smoke special-case in `main.ts` (~117–122).

**1.6 Collapse provenance to one file.** 11 `provenance.ts` files (2,002 lines) → one
`src/provenance.ts`: flat `MODELS: {id, status, ref, locator, url?}[]` plus `weakestStatus()`
and `statusLabel()`. Keep exactly what the HUD (`ui.ts:172–173`) and the `?debug` dump render
— spec §0.7.4 (status surfaced to the user) must survive intact. Move `knownBias` /
substitution prose and the bibliography to `docs/spec/_provenance-notes.md`. Delete
`estimatedSpeciesFieldCount` (zero callers) and the late-registration side channel.

**1.7 Remove single-implementer contract interfaces.** Delete `IWorldRenderer`,
`ICanopySolver`, `IDevice`, `IFrameLoop`, `IQualityController`, `ICameraRig`,
`IFirebrandSystem`; in `WorldRendererDeps` replace `ISkyRenderer`, `IEnvironmentLighting`,
`IFoliageRenderer`, `IFrameProfiler`, `ISurfaceSolver`, `IFuelModelTable` with concrete types.
Then delete `gpu/attribution.ts` (the encoder `Proxy` existed only because contracts were
frozen) and pass the profiler into `FireSim.step`, `FoliageRenderer.cull` and
`EnvironmentLighting.update` directly. **Verify per-phase attribution still reports non-zero
`surface`/`canopy`/`fluid`** — that fix must not regress. Remove the "DO NOT EDIT DURING A
FAN-OUT" banner from `contracts/index.ts`.

**1.8 Mechanical shrinks.**
- Barrels: delete the 22 re-export `index.ts` files except genuinely single-entry ones; point
  imports at real modules (~1,200 lines).
- Math: one `src/math.ts` — splitmix32, `hash1/2/3`, `clamp`, `lerp`, `smoothstep`, one `Vec3`
  tuple. **Seeded output must stay bit-identical**: terrain/vegetation/tree generation is
  pinned to shipped content. Keep both mixers in `math.ts` with a note if that is what it
  takes. Leave the two noise libraries alone if seed-pinned.
- Config bags: inline never-populated options objects (`RuntimeOptions` and its
  thread-throughs, `CrownTuning`, `FoliageConfig` opts path, `MaterialArrayConfig`,
  `PreludeOptions`, `StandAggregationOptions`, `PlumeOptions`, `AtmosphereConfig`,
  `SiteConfig`) as module consts. Rule: an options bag returns the first time a second caller
  needs a different value.
- Boot: replace `app/stages.ts` + `bootScreen.ts` (419) with a ~15-line `await step(name, fn)`
  wrapper + text update + existing `describeError`. Keep the adapter line and which-step-broke
  attribution.
- Bench: keep `src/bench/` (the RTX sweep is load-bearing); replace `report.ts`'s 311 lines of
  markdown with a plain table + CSV dump.
- Dead infra: delete empty `src/audio/`, `src/ui/`, their aliases in `vite.config.ts` /
  `tsconfig.json`, and the COOP/COEP plugin (no workers, no SharedArrayBuffer). Then remove the
  `ArrayBufferView<ArrayBuffer>` SAB generic tax in `camera/math.ts:289`,
  `app/terrainGrid.ts:135`, `render/materials/bake.ts:46`, `sim/canopy/storage/store.ts:83`,
  `world/terrain/generate.ts:45`, and `asUploadable()`.

**1.9 Test posture.** Delete the mock-WebGPU tier: `test/gpu/fake-webgpu.ts` (518),
`test/render/sky/fake-device.ts` (245), and the ~2,000 lines in `test/gpu/` asserting the
fakes' own bookkeeping. Keep `device.test.ts`'s limit-clamping arithmetic. Expand the `?debug`
probe to the real risk class: for every WGSL module assert pipeline creation succeeded; after
each pass's first submit, `onSubmittedWorkDone` + one readback assertion, each probe on its own
encoder. `gpuErrors` must end empty. Keep untouched: shader-mirror cluster, `wgsl-reserved`,
units, FWI, all `sim/` numerics.

**1.10 Headers — opportunistic only.** No dedicated pass over 211 files. Any file touched in
this phase gets its header cut to ≤5 lines (keep genuine "why" notes: reversed-Z, unit
conversions, WGSL gotchas; cut integrator handoff prose, usage examples, cost essays). New
files: ≤5 lines.

**1.11 Real-GPU test runner — added 2026-08-20 AFTER phase 1 was marked complete; still
OPEN.** Add `npm run test:gpu`: Playwright (one new devDependency,
approved) launches headless Chrome (`--headless=new` with WebGPU flags) on this machine's real
GPU, loads `?debug&hud=0`, waits for PASS/FAIL, asserts `gpuErrors` is empty, and exits
nonzero on failure. This is the missing tier that would have caught every silent
command-buffer-discard bug on the day it was written. Keep it out of plain `npm test` (CI
boxes have no GPU); it runs after any GPU-touching change, alongside `typecheck`. If headless
WebGPU proves flaky on this machine, fall back to headed Chrome with a minimized window and
note the constraint in CLAUDE.md.

**Acceptance.** `typecheck` 0 errors · `npm test` green · `npm run validate` green **against
the real kernel** · `?debug` PASS with `gpuErrors` empty · HUD per-phase timings non-zero ·
`src/` smaller by ~9,000–12,000 lines. HANDOFF.md gets a short current-state section; war
stories move to `docs/HISTORY.md`.

## Phase 2 — the 30-line visual fixes

1. **Grass material layer (the blue-violet bug).** `grassMaterialLayer()`
   (`render/foliage/foliageRenderer.ts:911–918`) looks up literal `'grass'`; `materialSlots` is
   keyed by def id and the real id is `'grass-blade'` (`app/biomeMaterials.ts:112–120`). The
   miss falls back to layer 0 = conifer bark. Fix by having `buildFoliageScene` publish the
   resolved grass layer on `FoliageScene` (one resolution point), not by patching the string.
2. **Make the fallback loud.** The silent `?? 0` slot fallback (`foliageRenderer.ts:915`,
   `sceneBuild.ts:168`) has shipped two bugs — an unresolved material id now pushes a visible
   warning (boot screen + console). Add one test that `'grass-blade'` resolves for every biome.
3. **Chromatic foliage light (~20 lines).** `sunIrradiance`/`skyIrradiance` f32 → vec3:
   `layout.ts:245,263–264`, `common.wgsl:50–51`, `foliageRenderer.ts:631–633,852–853`,
   `worldRenderer.ts:324`; `FRAME_UNIFORM_BYTES` 224 → 240. Feed `env.solar.beamColor` and the
   SH DC term so foliage and terrain share one light.
4. **`fireView` default `'arrival'` → `'off'`** (`app/settings.ts:99`, one line).
5. **Grass ambient hemisphere:** `grassDraw.wgsl:148` `ambient = 0.3` → `0.25 + 0.15 * n.y`,
   matching `treeDraw.wgsl:125`.

Do NOT retune exposure or the grass base-darkening (`grassDraw.wgsl:120`) yet — a large part of
the frame was mis-metered by the bark bug; re-judge only after these land.

**Acceptance:** `?debug` PASS, then **stop and ask the owner to load the page in their own
Chrome and screenshot**. Grass hue is judged by eye. Owner sign-off gates Phase 3.

## Phase 3 — visual ladder (one rung per sitting, owner looks between rungs)

Measured headroom: ~6.5 ms at quality 5 with the sim running. Profile each rung on the RTX 4070
before starting the next.

1. **Sun occlusion, the lazy way (~150 lines, target ≪ the 2.20 ms §7.9 budget).** Not a CSM.
   One compute pass rasterises the already-GPU-resident crown discs (`common.wgsl:14–23`:
   posXYZ + cullRadiusM), offset along the sun azimuth, into a 1024² r8 occlusion texture over
   the domain; terrain, grass and tree shaders multiply their direct term by it. The same pass
   marches `heightTex` toward the sun for terrain self-shadowing (already bound in
   `terrain.wgsl` and `grassDraw.wgsl:23`). Recompute only when the sun moves > 0.25°.
   `ponytail:` soft top-down approximation — upgrade path is real cascades if side-lit trunk
   shadows are ever wanted.
2. **TAA (~250 lines, ~0.3 ms).** Owner-requested. Both draw paths already emit
   interleaved-gradient dither assuming TAA resolves it (`treeDraw.wgsl:103–105`,
   `common.wgsl:322–325`, `config.ts:155`). Geometry is static bar wind sway:
   depth-reprojection + neighbourhood clamp, no motion-vector buffer in v1. Share jitter with
   WP 4.3's froxel reprojection.
3. **Bloom (~150 lines, ~0.3 ms).** Down/up pyramid, Karis average on the first tap, composite
   before tonemap. Fire, sun disc and sky currently clamp flat at the ACES shoulder.
4. **Smoke self-shadowing (~120 lines, 0.15 ms §7.1.4 budget).** Sun-transmittance volume;
   insertion point already marked at `froxel.wgsl:162–163`.

**Explicitly deferred:** clustered fire lighting, near-field flames, Hi-Z/depth prepass,
curl-noise smoke warp, Hillaire sky upgrade. M4's remaining packages resume after Phase 3
rung 2, since TAA and WP 4.3 share machinery.
