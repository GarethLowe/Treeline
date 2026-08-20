# ForestFire — Design Specification

A physically-based 3D forest and grass fire simulation running in the browser on WebGPU,
explorable in first person and from a free camera, with fire behaviour derived from
published fire science rather than authored by eye.

## Contents

| Document | Covers |
|---|---|
| [00 — Overview & Locked Decisions](docs/spec/00-overview.md) | Goals, the twelve locked decisions, target hardware, frame and step budget, what is explicitly out of scope |
| [10 — WebGPU Compute Architecture](docs/spec/10-webgpu-architecture.md) | Device limits, byte-level buffer layouts, VRAM budget, the per-substep pass schedule, active-set indirect dispatch, decoupled timesteps, CPU/worker strategy, profiling |
| [20 — Surface Fire Spread Physics](docs/spec/20-surface-spread.md) | The Rothermel (1972) formulation as implemented, Scott & Burgan / Anderson fuel models, dead-live weighting, wind limit and midflame adjustment, front propagation on the 0.5 m grid, Byram intensity, consumption and burnout, CFL stability |
| [30 — Canopy Heat Transfer & Crown Fire](docs/spec/30-canopy-heat-crown.md) | Sparse voxel canopy, radiative (infrared) transfer with Beer–Lambert extinction, convective plume coupling, conduction and ignition delay, pyrolysis kinetics, Van Wagner crown initiation and active crowning, the calibration bridge to the surface layer |
| [40 — Firebrand Transport & Spotting](docs/spec/40-spotting.md) | Albini spotting envelopes, Lagrangian brand generation, drag with shape factors, lofting, in-flight burnout, landing ignition probability, GPU particle implementation |
| [50 — Fire Meteorology & Fuel Moisture](docs/spec/50-meteorology.md) | Wind profiles and canopy attenuation, terrain-modified flow, spectral gusts, slope and valley thermal winds, plume rise and atmospheric stability, solar load, dynamic dead and live fuel moisture |
| [60 — Regional Models](docs/spec/60-regional-models.md) | Eucalypt (McArthur Mk5 and Project Vesta), Mediterranean chaparral, and the bespoke UK model (Canadian FWI codes, heather/bracken/gorse fuel characterisation, hedgerow and field structure, spring and summer season peaks) |
| [70 — Rendering, Procedural Content & Audio](docs/spec/70-rendering-audio.md) | Froxel volumetrics, blackbody flame colour, scattering and temporal reprojection, fire lighting the scene, vegetation at scale, procedural tree generation from fuel parameters, progressive burn materials, atmospherics, procedural audio |
| [90 — Work Package Decomposition](docs/spec/90-workpackages.md) | The contract-first parallel implementation model, module ownership map, and all 39 work packages with their acceptance criteria |
| [**Specification Status**](docs/spec/_open-questions.md) | **Live dashboard** of every open question, normative decision and known trap, regenerated from the documents by `npm run spec:status` |
| [Verification Findings](docs/spec/_verification-findings.md) | Audit trail: every error the adversarial review pass found in the drafts, with its correction |

## How this document was produced

Each physics and architecture section was drafted by a specialist working from primary
sources, then attacked by an independent adversarial reviewer instructed to find wrong
equations, wrong constants, misattributed models, impossible performance claims and
incorrect API limits — checking against primary literature and the live W3C WebGPU
specification rather than from memory.

That pass found **42 confirmed errors**, all of which are corrected in the sections and
recorded in the findings document. They were overwhelmingly transcription and arithmetic
slips rather than conceptual mistakes, but several were consequential — including a worked
example that, if used as the kernel's acceptance test as written, would have caused an
implementer to tune in a compensating ~50% bias.

## Reading it as an implementer

- **Units are not decorative.** Rothermel's coefficients are dimensional fits in
  BTU-lb-ft-min. The solver stores SI and converts at the kernel boundary. Section 20
  gives the conversion table; get it wrong and nothing downstream is meaningful.
- **`> **OPEN QUESTION (unverified):**` callouts are load-bearing.** They mark numbers or
  conventions that no one has yet confirmed against a primary source. Do not write code
  that depends on one without closing it first.
- **Where a model is used outside its validated envelope, the section says so.** That is
  deliberate. Honest limits beat false confidence in a simulation whose whole claim is
  physical defensibility.
