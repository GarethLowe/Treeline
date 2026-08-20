# ForestFire — Work Package Decomposition

## 90. Implementation Model

> **SUPERSEDED — execution is now SEQUENTIAL.** This section was written for parallel
> fan-out and describes how M1 and M2 were actually built. **From M4 onward, implementation
> runs sequentially**; see [CLAUDE.md](../../CLAUDE.md) for the governing policy. The
> contract-first discipline below survives intact and is still mandatory — freezing
> interfaces before implementing against them is what made the packages compose, and it
> costs nothing when one agent does the work in order. What changes is only *who* does the
> packages and *when*.
>
> **Measured, on real milestones:** parallel fan-out cost ≈2–3× the tokens (every agent
> re-reads the spec and writes throwaway sibling stubs — M1 was 2.15M subagent tokens across
> 8 agents, against 336k for the single agent that integrated them) and produced a class of
> bug sequential work does not: two packages each internally correct, neither reconciled with
> the other. The camera package shipped `REVERSED_Z = true` while the foliage package shipped
> `depthCompare: 'less'` with a comment predicting exactly the resulting failure. Parallelism
> bought ≈3–4× wall clock, and this project is not wall-clock bound.
>
> **Still parallel:** verification, adversarial review, benchmark sweeps, and read-only
> research. Those have no shared mutable state, and parallel verification has repeatedly
> caught real errors here — including one agent rejecting an inverted fuel-moisture
> hysteresis produced by an earlier agent and already reported as fact.
>
> **Never parallel:** GPU passes sharing depth conventions, bind group layouts, render pass
> structure or buffer layouts.

### 90.1 The Contract-First Principle

Interfaces are frozen in `src/contracts/` before any implementation begins, and stay frozen
for the duration of the phase. Under the original parallel model this was what made
simultaneous work possible at all; under sequential execution it remains mandatory for a
different reason — it stops a later package quietly reshaping an earlier one's assumptions,
which is how a phase turns into a rewrite. The mechanism:

> **`src/contracts/` is written first, frozen before fan-out, and owned by nobody during it.**

It contains *only* type declarations, buffer layout constants, and pure interface
definitions — no implementation, no imports from anywhere else in the tree. Every work
package imports from `src/contracts/` and from nothing outside its own directory.

A work package is therefore implementable by an agent that has read the spec and the
contracts, and has never seen any sibling package. Integration is not a merge negotiation;
it is a link step that either type-checks or does not.

**Rules binding every work package:**

1. **File ownership is exclusive.** Each package lists the files it owns. No package
   writes to a file owned by another. If two need the same thing, it belongs in contracts.
2. **Contracts are read-only during fan-out.** An agent that believes a contract is wrong
   *stops and reports* rather than editing it. Contract changes are serialised through the
   integrator between waves, because a contract edit invalidates every sibling in flight.
3. **Every package ships its own test.** The acceptance test is written against the
   contract, so it can be written and run before siblings exist.
4. **Stubs, never mocks of siblings.** Where a package needs data another will eventually
   produce, it consumes a deterministic stub generator that lives in its own directory.

### 90.2 Module Map & Ownership Boundaries

```
src/
  contracts/     Frozen interfaces, buffer layouts, enums, units. Zero dependencies.
  core/          Device bring-up, frame loop, timestep accumulator, resource lifetime.
  gpu/           Pass scheduler, bind group cache, timestamp profiling, quality controller.
  world/         Terrain, biomes, vegetation placement, procedural tree geometry.
  sim/           Surface solver, canopy solver, radiation, firebrands, fuel models.
  weather/       Wind field, solar position, fuel moisture, plume and stability.
  render/        PBR forward, foliage, volumetrics, lighting, sky, post.
  audio/         Procedural fire and wind synthesis.
  ui/            HUD, controls, ignition/edit tools, measurement probes, export.
shaders/         WGSL, mirroring the src/ subtree.
test/            Validation harness and benchmark cases.
```

### 90.3 Two Classes of Work Package

- **Pure packages** (no GPU, no rendering) — fuel model databases, Rothermel algebra,
  FWI codes, solar position, EMC equations, space-colonisation tree generation. These are
  ordinary TypeScript, unit-testable on the CLI under Vitest, and are the highest-value
  targets for agent fan-out: fully verifiable without a browser.
- **Device packages** (WebGPU) — require a live adapter, so acceptance is verified by a
  headless-Chrome harness or by a scripted in-browser check. These fan out just as well but
  their acceptance criteria must be expressed as measurable numbers (timing, pixel checks,
  buffer readbacks), never "looks right".

**Wherever a physical model can be expressed as a pure package with a WGSL port as a
separate package, do that.** It splits one hard job into one verifiable job and one
mechanical job, and the pure version becomes the oracle the WGSL port is tested against.

---

## 91. Milestone Fan-Out

Each table row is one agent's complete assignment. *Consumes* and *Provides* name contract
symbols, not files.

### M1 — Walkable Procedural World (8 packages)

| ID | Scope | Consumes | Provides | Acceptance |
|---|---|---|---|---|
| 1.1 | Device bring-up, frame loop, fixed-timestep accumulator, pass scheduler, timestamp profiler, quality controller | — | `IDevice`, `IPassScheduler`, `IFrameProfiler` | Reports adapter name and limits; proves the discrete GPU was selected, not the iGPU; profiler resolves per-pass microseconds |
| 1.2 | Seeded terrain: heightfield synthesis, drainage/canyon carving, relief control, slope and aspect derivation, height/normal query | `TerrainParams` | `ITerrainField`, height/normal/slope/aspect textures | Deterministic for a seed; slope statistics match the requested relief setting; CPU query matches GPU texture within tolerance |
| 1.3 | Biome definitions and seeded vegetation placement: species distribution, density, clustering, per-stem parameter derivation | `ITerrainField`, `BiomeParams` | `IVegetationSet` (per-stem species, position, age, DBH, height, crown base height, crown bulk density) | Stem density and basal area match requested values within 5%; distributions respond correctly to slope, aspect and moisture |
| 1.4 | Procedural tree geometry: space colonisation per species, needle/leaf placement, LOD chain, impostor baking | `IVegetationSet` | `ITreeMeshSet` | Generated crown base height and foliar biomass match the stem's *physical* parameters within 10% — geometry is derived from fuel data, not authored independently |
| 1.5 | Foliage rendering: GPU-driven culling, instancing, LOD selection, GPU grass generation with density falloff | `ITreeMeshSet`, `IVegetationSet` | `IFoliageRenderer` | 80k trees plus 1 km² grass at 6 ms or less; draw calls under budget; no popping at LOD transitions |
| 1.6 | PBR material pipeline: CC0 texture ingest, atlas/array packing, terrain splatting by slope/aspect/biome | `BiomeParams` | `IMaterialSystem` | Material set loads within VRAM budget; correct sRGB/linear handling verified against reference values |
| 1.7 | Sky and atmosphere: physically-based sky model, sun/moon position, full diurnal cycle | `SolarState` | `ISkyRenderer`, `IEnvironmentLighting` | Sun position matches an ephemeris for given date/latitude/longitude within 0.1 degrees; sky radiance plausible across the day |
| 1.8 | Cameras and input: first-person controller with terrain collision, free/drone camera, transitions | `ITerrainField` | `ICameraRig` | Walker stays on terrain across the full domain; no tunnelling on steep slopes; both modes reachable and stable |

### M2 — Surface Fire Solver (6 packages)

| ID | Scope | Consumes | Provides | Acceptance |
|---|---|---|---|---|
| 2.1 | **Pure.** Fuel model database (Anderson 13, Scott and Burgan 40, custom UK set) plus complete Rothermel algebra in TypeScript | `FuelModel` | `rothermelROS()`, `byramIntensity()`, `flameLength()` | Reproduces published ROS tables for standard fuel models within stated tolerance. **This is the oracle for 2.2.** |
| 2.2 | WGSL port of 2.1 onto the 2048² surface grid; state buffer layout; ping-pong | `SurfaceLayout`, 2.1 as oracle | Surface solver compute passes | GPU output matches the 2.1 oracle within f32 tolerance across a parameter sweep |
| 2.3 | Front propagation scheme, shape-artifact mitigation, active-cell compaction and indirect dispatch | Surface solver passes | `ISurfaceSolver` | Emergent perimeter matches elliptical fire-shape theory; no octagonal artifacts; cost scales with burning area, not domain area |
| 2.4 | Fuel consumption and burnout curves; per-cell residence time; intensity and flame-length output fields | `ISurfaceSolver` | `IFireOutputs` | Cells burn down over time rather than flipping state; total consumption matches fuel loading |
| 2.5 | Validation harness and benchmark case library | 2.1, `ISurfaceSolver` | `test/validation/` | Runs on the CLI; reports deviation per benchmark; fails the build on regression |
| 2.6 | Placeholder fire visualisation (superseded at M4) | `IFireOutputs` | Debug fire view | Fire front visible and legible; no impact on solver timing |

### M3 — Canopy Heat Transfer, Crown Fire, Firebrands (6 packages)

| ID | Scope | Acceptance |
|---|---|---|
| 3.1 | Sparse canopy voxel structure: brick pool, indirection grid, allocation and eviction | Occupancy and VRAM within budget for a fully-vegetated domain; allocation stable under fire growth |
| 3.2 | **Pure.** Ignition and pyrolysis kinetics, moisture evaporation heat sink, thermally-thin/thick criterion, ignition-delay integral | Ignition delays match published piloted-ignition data for the tested fuels |
| 3.3 | Radiative transfer: view-factor formulation with Beer–Lambert extinction through leaf area density; the chosen GPU propagation scheme | Irradiance falls as expected with distance and intervening leaf area; converges; within its millisecond budget |
| 3.4 | Convective transport: plume-advected hot gas into and above the canopy; heat transfer coefficients | Plume tilt responds correctly to wind; convective heating dominates the near field as expected |
| 3.5 | Van Wagner crown initiation and active-crowning criteria; torching; passive/active/independent classification; crown fraction burned | Crown initiation occurs at the correct critical surface intensity for given crown base height and foliar moisture; bulk-density threshold behaviour correct |
| 3.6 | Lagrangian firebrands: generation, drag with shape factor, lofting, in-flight burnout, landing ignition probability | Maximum spotting distances fall within the Albini envelope; 100k brands within their millisecond budget |

### M4 — Volumetric Fire and Smoke Rendering (6 packages)

| ID | Scope | Acceptance |
|---|---|---|
| 4.1 | Froxel volume: dimensions, depth distribution, population from sim soot and temperature fields | Volume populated correctly, verified by buffer readback against sim state |
| 4.2 | Blackbody Planck emission to RGB; Henyey–Greenstein scattering; transmittance; raymarch integration | Flame colour for a given temperature matches the blackbody locus within a stated delta-E |
| 4.3 | Temporal reprojection with jitter; ghosting mitigation on a fast-moving front | Volumetrics within 4 ms at 1440p; no visible ghosting at maximum head-fire rate of spread |
| 4.4 | Fire lighting the scene: cell aggregation into representative lights, clustered shading and/or irradiance volume | Illumination visibly tracks the fire; within its millisecond budget with thousands of emitters |
| 4.5 | Near-field flame-sheet/particle layer driven by sim state; compositing without double-counting | Close-up grass flame convincing at 10 cm scale; no double-brightening where layers overlap |
| 4.6 | Progressive burn materials: green to scorch to char to ash driven by sim char fraction; ember emission from residual temperature | Char height on trunks matches computed scorch height; transitions continuous, no texture explosion |

### M5 — Fire Meteorology and Five Biomes (7 packages)

| ID | Scope | Acceptance |
|---|---|---|
| 5.1 | **Pure.** Solar position, insolation, slope-aspect correction, fuel temperature | Sun position within 0.1 degrees of ephemeris; insolation matches reference for test sites |
| 5.2 | **Pure.** Dead fuel moisture: equilibrium moisture content, timelag classes; Canadian FWI FFMC/DMC/DC/ISI/BUI/FWI | FWI outputs match published worked examples exactly |
| 5.3 | **Pure.** Live fuel moisture, curing curves, drought index | Seasonal curves match published species data |
| 5.4 | Terrain-modified wind field: mass-consistent solve, log profile, canopy attenuation | Field divergence-free to tolerance; ridge speedup and valley channelling present; within millisecond budget |
| 5.5 | Spectral gust model; slope and valley thermal winds | Gust spectrum matches the target spectral form; anabatic/katabatic reversal occurs at the right time of day |
| 5.6 | Plume rise, atmospheric stability, column collapse | Plume height responds correctly to intensity and lapse rate; collapse triggers under the right conditions |
| 5.7 | Biome packs: eucalypt (McArthur/Vesta), chaparral, UK (heather, bracken, gorse; hedgerow corridors; wall and ditch breaks; spring and summer peaks) | Each reproduces its own literature benchmarks; the UK model reproduces both seasonal peaks |

### M6 — Tools, HUD, Export, Audio, Atmospherics (6 packages)

| ID | Scope | Acceptance |
|---|---|---|
| 6.1 | Ignition tools: point, line, ring, drip-torch patterns | Ignition lands at the picked world position; patterns produce the expected perimeter shapes |
| 6.2 | Environment editing: in-world fuel and moisture painting, firebreak cutting | Edits take effect on the next substep; solver responds correctly at break boundaries |
| 6.3 | Measurement HUD: rate of spread, intensity, flame length, scorch height, placeable heat-flux probes, time-series | Displayed values match harness-computed values for the same state |
| 6.4 | CSV/JSON export: burn area, perimeter, intensity over time | Exported series match in-sim measurements; well-formed and parseable |
| 6.5 | Procedural spatial audio: intensity-driven roar, granular crackle, canopy wind, distance attenuation and occlusion | Loudness tracks fireline intensity; CPU cost within budget; no clicks or dropouts |
| 6.6 | Atmospheric effects: heat shimmer, smoke obscuration, ember and ash fall, light shafts, sun reddening | Visibility through smoke tracks computed soot density; within remaining frame budget |

---

## 92. Sequential Phase Procedure

Supersedes the wave structure below for M4 onward.

1. **Freeze contracts.** Extend `src/contracts/` for the phase and type-check it standalone.
2. **Order the packages by dependency**, and put the ones that define shared conventions
   first — depth convention, bind group layouts, buffer formats. Everything downstream then
   inherits a decision rather than inventing a second one.
3. **Implement one package. Type-check it. Test it.** Do not start the next with a red build.
4. **Reuse, do not stub.** The previous package's code exists — import it. Writing a stub for
   something already implemented is the parallel model's overhead leaking into the sequential
   one, and it is pure waste.
5. **Every 2–3 packages, run the full suite**, not just the new tests. A regression found
   three packages later costs far more than one found immediately.
6. **Load the page.** `npm test` never touches a GPU — Vitest runs under Node, WGSL never
   reaches a compiler, and every GPU test skips. Four real bugs shipped through a green
   943-test suite this way. A phase is not done until it has run in a browser.
7. **Then verify in parallel.** Adversarial review, benchmark sweeps, validation runs — these
   are read-only and genuinely benefit from independent perspectives.
8. **Regenerate the dashboard** with `npm run spec:status` and close or downgrade any open
   question the phase touched.

## 92b. Wave Structure (historical — parallel model, M1 and M2)

Within a milestone, packages are not all simultaneously *integratable* — some consume
contracts that a sibling produces the implementation for. Because they code against the
contract rather than the implementation, they can still **start** together; only
integration is ordered. The integrator's sequence per milestone:

1. Freeze or extend `src/contracts/` for the milestone. Type-check it standalone.
2. Fan out all packages in the milestone simultaneously.
3. Integrate in dependency order, running each package's acceptance test as it lands.
4. Run the full validation harness. A regression blocks the milestone.
5. Run the milestone's end-to-end check in the browser with the frame profiler enabled.
6. Only then unfreeze contracts for the next milestone.

Total: **39 work packages across 6 milestones**, the largest single wave being M1 at 8.
