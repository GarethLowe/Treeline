# ForestFire — working instructions

Read [SPEC.md](SPEC.md) first. [HANDOFF.md](HANDOFF.md) has current state.

**Active steer (2026-08-20):** [docs/CLEANUP-SPEC.md](docs/CLEANUP-SPEC.md) is the current
work order — teardown, then visual fixes, then the visual ladder — and it gates resuming M4.
When choosing between tasks of equal correctness value, do the one the owner can *see* first.

## Execution model: sequential build, parallel verification

**This project builds SEQUENTIALLY. Do not fan out implementation work to parallel agents.**

This overrides any default preference for multi-agent orchestration, including ultracode.
It is a deliberate decision by the project owner, made after measuring both modes on real
milestones, and it is not to be re-litigated each session.

### Why

M1 was built by 8 parallel agents against frozen contracts. It worked — 175 files, zero type
errors, 943 tests passing on first assembly — but it cost:

- **~2–3× the tokens.** Every agent independently re-reads SPEC.md, the overview, the work
  package table and the contracts, then writes throwaway stubs of its siblings' work. M1 cost
  2.15M subagent tokens across 8 agents; the single integration agent that wired it all
  together, reconciled the depth convention and found six contract problems cost 336k and 18
  tool calls.
- **A whole class of integration bug that sequential work does not produce.** The camera
  package shipped `REVERSED_Z = true`; the foliage package shipped `depthCompare: 'less'`,
  with a comment correctly predicting that this combination draws nothing. Both were
  internally right. Nobody reconciled them. Same shape of failure in the ground-material
  vocabulary mismatch and a material id map that silently resolved unknown ids to slot 0.

Parallelism buys wall-clock time (≈3–4×). This project is not wall-clock bound.

### What stays parallel

Only work with **no shared mutable state and no integration surface**:

1. **Verification and testing.** Independent reviewers, adversarial fact-checkers, benchmark
   runs, validation sweeps. Parallel verification has repeatedly caught real errors here —
   including one agent catching an inverted fuel-moisture hysteresis that a previous agent
   had produced and that had already been reported as fact.
2. **Read-only research.** Literature sourcing, primary-source verification. These edit
   nothing.
3. **Pure, CLI-testable modules with a frozen contract and zero GPU surface** — a fuel model
   database, solar position, pyrolysis kinetics. Use judgement, and prefer sequential when in
   doubt.

**Never parallel:** GPU passes that share depth conventions, bind group layouts, render pass
structure or buffer layouts. That is exactly where the mismatches live.

### How to build a phase sequentially

1. Read the spec section and the frozen contracts.
2. Implement one package. **Test it. Type-check it.** Do not move on with a red build.
3. Implement the next, *reusing what you just learned and wrote* rather than stubbing it.
4. After every 2–3 packages, run the full suite — not just the new tests.
5. When the phase is done, run parallel verification against it (see above).

The point of sequential is that context carries forward. Do not artificially discard it by
re-reading the spec for each package or by writing stubs for code that already exists.

## Non-negotiables

- **Units are normative.** SI internally. Moisture is a **fraction**, never a percent. Angles
  in **radians**. Temperature in **kelvin**. The branded types in `src/contracts/units.ts`
  make violations a compile error — that is deliberate, do not cast around them.
- **`src/contracts/` is frozen during a phase.** Report problems; do not edit mid-build.
- **Free, obtainable sources only** for any physical constant — USDA/treesearch, NIST,
  open-access, agency reports, reference implementations. Never bypass a paywall. **A
  constant you cannot source may not be guessed**; mark the model `estimated` and say so.
- **Every model carries a validation status** (`validated` / `calibrated` / `substituted` /
  `estimated`) surfaced in the HUD and written into exports. Only `published` benchmark cases
  confer `validated`.
- **Performance:** build the top-fidelity path first, expose quality as a user-facing slider
  (levels 0–5), auto-scale as a safety net. 60 fps is the requirement, exactness the
  preference — but a correct published constant is **free** (coefficients are precomputed
  into LUTs) so never cut correctness to save time. See spec §0.5.1.

## Build discipline — added 2026-08-20 after the August audit

An audit found ~25% of src/ was leftover parallel-era scaffolding, the validation suite
pointed at a stub, and the most visible bug came from a silent fallback. These rules exist so
none of that regrows:

- **One implementation per physical model.** The CPU kernel (e.g. `sim/rothermel/kernel.ts`)
  is the single oracle; GPU paths precompute LUTs *from it* and are tested *against it*.
  Never write a second copy of a model's algebra — not as a stub, not "temporarily".
- **No silent fallbacks.** An unresolved id, missing map key, or out-of-range lookup warns
  visibly (boot screen or `gpuErrors`) or throws. The `?? 0` material-slot fallback shipped
  two rendering bugs; don't reproduce the pattern.
- **No scaffolding without a teardown date.** No stubs for code that exists, no barrel
  `index.ts` files, no interface with one implementer, no options bag with one caller, no
  config nobody sets. If a temporary aid is genuinely needed, delete it in the same phase.
- **File headers ≤ 5 lines.** Keep "why" notes (depth convention, unit boundaries, WGSL
  gotchas); no usage essays, no handoff prose. The reader is the next sequential session,
  which has HANDOFF.md.
- **Prefer deletion.** Before writing a helper, grep for it — `clamp` existed four times.
  A change that removes lines while passing the same tests is a good change.
- **HANDOFF.md is current state, ≤ ~150 lines.** War stories and fixed-bug post-mortems go
  to `docs/HISTORY.md` with one-line pointers. A 500-line handoff is a tax on every session.

### The verification pyramid — where each bug class is caught

1. **Compile time:** branded unit types. 2. **`npm test`:** CPU physics vs published data,
   and shader-mirror text checks (WGSL constants/layouts vs TS oracles — these have caught
   real bugs 3-for-3; extend them for every new shader). 3. **Real GPU (`?debug`):** every
   new GPU pass ships a probe — own encoder, pipeline-creation asserted, one readback
   assertion — and `gpuErrors` must end empty. 4. **The owner's eyes:** any change with
   visible output ends by asking the owner for a screenshot from their own Chrome.
   Look-wrong reports are real defects, not polish.

**Mock-WebGPU tests never count as GPU verification.** A passing fake is indistinguishable
from a passing driver, and this project has proven that hides the platform's worst failure
mode (silent command-buffer discard). The existing recording spies stay — they cover real
CPU logic (profiler ring buffer, environment cache) and disclaim being GPU proof — but new
GPU behaviour gets a `?debug` probe, never a new fake. CLEANUP-SPEC **1.11** (still open)
adds a headless real-GPU runner so the probe tier runs on every GPU-touching change.

## Verifying

```bash
npm run typecheck     # both browser and build-tooling projects
npm test              # full suite
npm run validate      # fire behaviour against published data, with per-case deviation
npm run spec:status   # regenerate the open-questions dashboard from the spec documents
npm run dev           # http://127.0.0.1:5173  ·  ?debug for smoke test  ·  ?bench for timings
npm run headless      # drive a real Chrome unattended: screenshots, console, GPU errors
```

**Tests do not touch a GPU.** Vitest runs under Node, which has no WebGPU, so WGSL never
reaches a compiler and every GPU-only test skips. Four real bugs shipped through a green
943-test suite this way: two WGSL reserved keywords (`target`, `layout`), an sRGB texture
view rejected for carrying storage usage, and a `requestAnimationFrame` deadlock. **A green
suite is necessary, not sufficient — load the page before claiming something works.**

## Tooling — what a fresh machine needs

This project is developed on Windows. Nothing below is bundled; a new machine needs each one
installed before the corresponding workflow works.

| Tool | Needed for | If missing |
|---|---|---|
| **Node 22+** | everything. `scripts/headless.mjs` relies on a **global `WebSocket`**, which is Node 21+. | the runner throws `WebSocket is not defined` |
| **Google Chrome** | `npm run headless`. Paths are probed in `CHROME_CANDIDATES` at the top of the script — add yours there if it lives elsewhere. | "no Chrome found", with the list it searched |
| **Python 3** | `scripts/frame-stats.py` | frame statistics unavailable; screenshots still work |
| **Pillow** (`pip install pillow`) | faster PNG decode in `frame-stats.py` | falls back to a stdlib decoder automatically — slower, same numbers |

### The visual feedback loop

```bash
npm run dev                                             # terminal 1
node scripts/headless.mjs http://127.0.0.1:5173/?hud=0 --shot frame.png
python scripts/frame-stats.py frame.png
```

`scripts/headless.mjs` drives a real Chrome over the DevTools Protocol. **Headless Chrome
composites**, so `requestAnimationFrame` fires and frames are genuinely produced — which is the
one thing the in-app browser pane never does. Flags: `--wait <js>` (default: the boot screen
hid itself, i.e. a frame rendered), `--eval <js>`, `--shot <png>`, `--timeout`, `--quiet`. It
exits non-zero on timeout or console errors, so it works as a check and not only as a viewer.

**Chrome reports invalid pipelines as console WARNINGS, and the runner captures them.** That is
not a detail: `createRenderPipeline` does not throw on a bad bind-group layout, it returns an
invalid pipeline, every draw using it is dropped, and the screen goes black with a green test
suite and an empty `gpuErrors`. That exact bug shipped on 2026-08-20. `installShaderAudit` in
`src/app/shaderAudit.ts` now wraps pipeline creation in validation error scopes unconditionally,
so it is caught in the shipping path too.

**Its results are functional, not temporal.** The adapter Chrome picks here is the Intel iGPU,
so the runner prints the adapter every run and every frame time from it is ~10x off. Real
numbers still need the owner's own Chrome.

## Environment

- **The in-app browser pane runs the Intel iGPU, not the RTX 4070.** Chrome ignores
  `powerPreference` on Windows entirely (crbug 369219127). Functional verification there is
  fine; **any frame time from it is ~10× off and meaningless.** The boot screen warns when
  the adapter looks integrated — read that line before trusting a measurement. Real numbers
  need the owner's own Chrome.
- The preview pane may not composite, in which case `requestAnimationFrame` never fires and
  no frame renders. Boot completes anyway and reports "First frame — skipped".
- `.claude/launch.json` calls `node.exe` by **absolute path** because the session PATH predates
  the Node install. **This is machine-specific and will not survive a move** — fix the path
  there first on a new machine, or replace it with plain `node` if the PATH is sane.
