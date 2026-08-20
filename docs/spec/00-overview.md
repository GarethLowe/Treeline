# ForestFire — Design Specification

## 0. Overview & Locked Decisions

A comprehensive 3D forest and grass fire simulation running in the browser on WebGPU,
explorable in first person and from a free/drone camera, with fire behaviour that is
physically derived rather than authored.

### 0.1 Goals

1. **Physically defensible fire behaviour.** Rate of spread, fireline intensity and
   flame length must be reproducible against published fire-behaviour data, not tuned
   by eye. Where a model is used outside its validated envelope, the code and this
   document say so explicitly.
2. **Multi-scale fire.** The same simulation must handle grass fire, brush and shrub
   fire, and tree/crown fire, including the transitions between them (surface fire →
   torching → passive crown → active crown).
3. **Heat transfer as a first-class mechanism.** Not just adjacency-based spread:
   explicit radiative (infrared) preheating, convective transport by the buoyant plume,
   conduction into fuel particles, and firebrand spotting.
4. **Visual realism driven by simulation state.** Flame colour comes from computed
   temperature; smoke comes from computed soot; char and ash come from computed
   consumption. The image is an expression of the physics, never a parallel authored layer.
5. **Real-time on consumer hardware.** 60 fps at 1440p on an RTX 4070 Laptop.

### 0.2 Locked Decisions

These were settled during specification and are not to be relitigated during implementation.

| Area | Decision |
|---|---|
| Runtime | Browser, WebGPU. No game engine. |
| Language | TypeScript (strict) + WGSL. Vite dev server and build. |
| Fire model | **Hybrid**: fine 2D surface layer calibrated against Rothermel (1972) / Scott & Burgan (2005), coupled to a 3D voxel canopy with explicit radiative, convective and conductive heat transfer, plus Lagrangian firebrands. |
| Domain | 1 km × 1 km. Surface grid 0.5 m (2048²). Canopy voxels 2 m (512×512×64, sparse). |
| Biomes | Western US conifer; grassland/savanna; Mediterranean chaparral; eucalypt dry forest; UK mixed field & forest. |
| Fire rendering | Hybrid: froxel raymarch of the sim's own soot/temperature fields (blackbody Planck emission, Henyey–Greenstein scattering) **plus** a near-field particle/flame-sheet layer. Fire lights the scene. |
| Assets | Procedural geometry (space-colonisation trees, GPU grass) + curated CC0 PBR textures. |
| Weather | Full fire meteorology: terrain-modified gusty wind, diurnal solar load, atmospheric stability, dynamic fuel moisture. |
| Interaction | Ignition & environment editing tools; measurement HUD; CSV/JSON export. |
| Immersion | Progressive burn materials, atmospheric camera effects, procedural spatial audio, full diurnal cycle. |
| Performance | 60 fps @ 1440p with dynamic quality scaling. Simulation timestep decoupled from render rate. |
| Validation | Automated harness against published benchmark cases. |

### 0.3 Explicitly Out of Scope

- **Suppression simulation** — no water/retardant drops, crews, engines or backburning.
- **Run recording, replay and batch parameter sweeps.** World generation is seeded and
  reproducible; individual fire runs are not recorded or scrubbable.

### 0.4 Target Hardware

| | |
|---|---|
| GPU | NVIDIA RTX 4070 Laptop, 8 GB VRAM, ~256 GB/s bandwidth |
| CPU | Intel i9-13900HX, 24 cores / 32 threads |
| RAM | 32 GB |
| OS / Browser | Windows 11, Chrome/Edge with WebGPU |

The machine is a **hybrid-GPU laptop**. The Intel UHD iGPU is present and WebGPU may
select it by default; the adapter request must specify `powerPreference: 'high-performance'`
and the boot path must report the selected adapter so a silent fallback to the iGPU is
never mistaken for a performance regression.

### 0.5 Frame and Step Budget

Target frame 16.6 ms at 1440p:

| Stage | Budget |
|---|---|
| Geometry, shadows, PBR forward pass | ~6.0 ms |
| Volumetric fire/smoke | ~4.0 ms |
| Simulation (all compute passes) | ~3.0 ms |
| Post, UI, headroom | ~3.6 ms |

Simulation substepping is decoupled from render rate: physics accuracy must not degrade
when frames become expensive. Under load, the dynamic quality controller reduces froxel
resolution, particle counts and foliage LOD — never the simulation timestep.

#### 0.5.1 Performance beats exactness — NORMATIVE tie-breaking rule

**60 fps is the requirement. Exactness is the preference.** Where the two conflict, take the
frame rate. This is the project owner's explicit direction and it binds every work package.

**Build the top end first, then expose a slider.** The full-fidelity path is written first and
is the reference implementation — you cannot degrade gracefully from something that does not
exist, and a cheap-only implementation has nothing to be measured against. Quality is then a
**user-facing control**: levels 0–5 (`QUALITY_TABLE`, §6.7 of the architecture doc), pinnable
by the user, with the automatic controller acting only as a safety net when an unpinned frame
budget is missed.

So the ordering is: **implement level 5, verify it is correct, then define what levels 4 down
to 0 remove.** Not the reverse.

Concretely, when a design choice trades accuracy for cost:

1. **Make it a quality level, not a permanent decision.** Anything that can be dialled
   belongs on the slider. Only make a cut unconditional when the expensive version buys
   nothing observable at any setting.
2. **State the error each level accepts**, in the spec and in the model's `ModelProvenance`.
   A cheap approximation with a known bound is fine; an unbounded one is not.
3. **Do not spend frame time on accuracy nobody can see or measure**, at any level.
   Radiative transfer resolved to 1% inside a 2 m voxel is waste even at level 5.
4. **Default the shipping configuration to whatever actually holds 60 fps on the target
   GPU** — which is a measurement, not a guess. Until it is measured, default to level 5 and
   let the auto-scaler correct it.

**Where this rule does NOT apply**, because the trade is illusory:

- **Getting a published constant right is free.** Every σ-dependent Rothermel coefficient is
  precomputed CPU-side into a LUT; the shader does no `exp` and no size-class binning. A
  correct constant and a wrong one cost the same. Correctness here is never the thing to cut.
- **The simulation timestep is already cheap.** CFL on the 0.5 m surface grid at an extreme
  1 m s⁻¹ head fire permits ~0.5 s steps, so the fire solver wants ~2–10 Hz, not 60 Hz, and
  is amortised across many frames by construction. Degrading it would save little and would
  invalidate every measurement the HUD exports (§0.7.4). Keep the existing rule: the quality
  controller does not touch `h` or `n_sub`.

**Therefore the savings must come from rendering, which is ~60% of the frame budget against
the simulation's ~18%.** The first levers, in order: froxel resolution and march step count,
near-field particle budget, canopy radiation ray count and update frequency (the radiation
field evolves far slower than the frame rate — update it every N frames), foliage LOD
distances, and shadow resolution.

**Measure before trading.** Every figure in the budget table above is an estimate, and
several §10 open questions record that some are framed against the wrong bound. No accuracy
may be traded away on the strength of a predicted cost — profile the pass on the target GPU
first, then cut what is actually expensive.

### 0.6 Units — Normative, Project-Wide

Fire science is a minefield of mixed unit systems: Rothermel's coefficients are dimensional
fits in BTU-lb-ft-min, McArthur's are in km/h and mm, the Canadian FWI codes are in °C and
mm with their own internal scales, and moisture is quoted as a percentage in almost every
source paper but must be a fraction in almost every equation. Unit errors in this domain do
not announce themselves — they produce a fire that spreads, looks plausible, and is wrong.

The following rules are normative and bind every section of this specification and every
work package.

1. **State is stored in SI.** Every persistent field — fuel load, moisture, temperature,
   wind, rate of spread, intensity — is SI in memory and on the GPU.
2. **Empirical kernels convert at their own boundary.** The Rothermel kernel converts SI to
   English on entry and back on exit; the McArthur and Vesta kernels convert to their native
   units likewise. This preserves every published coefficient exactly as printed, so the
   implementation stays checkable against the source papers. The conversion is a handful of
   multiplies and is not a measurable cost.
3. **Moisture is a fraction inside the simulation, always.** Oven-dry-mass fraction, range
   `[0, ~4]`. Percent exists only in fuel-model source tables and in HUD/export
   presentation.
4. **Angles are radians internally**, degrees only at UI boundaries. Slope is stored as its
   tangent where equations use `tan φ`, since that is what the physics actually consumes.
5. **Time is seconds; simulated clock time is tracked separately** from wall time and from
   the render frame counter.
6. **Conventions are enforced by the type system.** `src/contracts/units.ts` declares
   branded numeric types. A `MoisturePercent` cannot be passed where a `MoistureFraction`
   is expected, and neither can be passed where a raw `number` is expected without an
   explicit, named conversion. This is the single highest-leverage use of TypeScript in the
   project: it converts the most likely and least detectable class of error in the whole
   simulation from a silent physical inaccuracy into a compile failure.

Any equation in this specification stated in non-SI or percent form is marked inline at the
point of use, and carries its converted form alongside.

### 0.7 Model Provenance & Validation Policy — Normative

The project claims physical defensibility. That claim is only worth something if it is
*checkable per model*, because the five biomes and the various sub-models are not equally
well supported by available data. This section binds how that is handled.

#### 0.7.1 Sources must be obtainable

Only sources that can be legitimately obtained may be used: USDA Forest Service and other
government agency publications, open-access journals, author preprints, agency technical
reports, and reference implementations whose source code encodes the constants (BEHAVE,
CSIRO Spark, the `cffdrs` and `xclim` packages). Paywalled results are used only where a
free equivalent documents the same formulation.

**A constant whose source cannot be obtained may not be entered into the code as a guess.**

#### 0.7.2 When a model cannot be verified, substitute one that can

If the preferred model's constants cannot be confirmed, it is replaced by a simpler,
fully-documented model, and the substitution is recorded — in this specification, in the
model registry, and visibly in the running simulation.

The live instance of this: the Anderson et al. (2015) shrubland formulation preferred for
chaparral (§60 §7.2.3) rests on five constants nobody involved has read. It is therefore
**not** the shipping chaparral model. Chaparral ships on Rothermel with the SH5/SH7 fuel
models, which are fully documented and free, and which the literature openly describes as
underpredicting chaparral spread. The simulation is then conservative and honest rather
than confident and unverifiable. If the paper is later obtained, the better model can be
promoted and its status upgraded.

The general rule: **prefer a model that is known to be approximate over one that is merely
unverified.** A known bias can be stated, bounded, and corrected for. An unknown one cannot.

#### 0.7.3 Every model carries a validation status

| Status | Meaning |
|---|---|
| `validated` | Reproduces published benchmark data within a stated tolerance, and there is an automated test in `test/validation/` asserting it |
| `calibrated` | Constants traced to an obtainable primary source with a page citation, but no benchmark dataset exists to test the assembled model against |
| `substituted` | A simpler verifiable model standing in for a preferred one that could not be verified. Records what it replaced and the known direction of its bias |
| `estimated` | Constants are engineering estimates. Must not appear in a shipping default without an explicit decision recorded here |

#### 0.7.4 Confidence is surfaced to the user, not buried

The measurement HUD displays the validation status of every model contributing to a
displayed quantity, and **every CSV/JSON export carries per-quantity provenance** — model
name, status, and source citation — alongside the numbers.

This is not decoration. A rate of spread whose confidence cannot be traced is worth much
less than one whose can, and the difference between a validated grassland spread rate and a
substituted chaparral one must not be invisible at the point of use. It also makes the
specification's open questions self-documenting: anything still `estimated` is visible in
the product, not buried in a document nobody re-reads.

#### 0.7.5 Open questions are load-bearing

`> **OPEN QUESTION (unverified):**` callouts in these documents mark numbers or conventions
that no one has confirmed. Work packages must not write code that depends on one without
first closing it, or explicitly downgrading the affected model's status per §0.7.3.
