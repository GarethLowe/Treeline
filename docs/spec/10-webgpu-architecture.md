## 6. WebGPU Compute Architecture

### 6.1 The limit envelope we must design inside

WebGPU is not Vulkan. The *default* device limits are the intersection of every conformant implementation, and a device only receives more if it is explicitly requested via `requiredLimits` at `requestDevice()` — an adapter reporting a high limit does **not** grant it. The limits that constrain this project:

| Limit | Spec default | Adapter value, Chrome/D3D12/NVIDIA Ada, Win11 | Raisable? |
|---|---|---|---|
| `maxStorageBufferBindingSize` | 134,217,728 (128 MiB) | 2,147,483,643 (≈2 GiB) on ~93% of Windows devices; 1,073,741,824 universally | Yes, must request |
| `maxBufferSize` | 268,435,456 (256 MiB) | 2,147,483,644 (≈2 GiB) on ~93% of Windows devices | Yes, must request |
| `maxComputeInvocationsPerWorkgroup` | 256 | 1024 (D3D12 hard cap) | Yes |
| `maxComputeWorkgroupSizeX` / `Y` | 256 / 256 | 1024 / 1024 | Yes |
| `maxComputeWorkgroupSizeZ` | 64 | 64 | **No** — D3D12 hard cap |
| `maxComputeWorkgroupStorageSize` | 16,384 B | 32,768 B (D3D12 groupshared cap) | Yes |
| `maxComputeWorkgroupsPerDimension` | 65,535 | 65,535 | **No** — D3D12 hard cap |
| `maxStorageBuffersPerShaderStage` | 8 | ≫8 (D3D12 resource binding tier 3) | Yes |
| `maxStorageTexturesPerShaderStage` | 4 | ≫4 | Yes |
| `maxBindGroups` | 4 | 4 | **Treat as hard** |
| `maxTextureDimension2D` | 8,192 | 16,384 | Yes |
| `maxTextureDimension3D` | 2,048 | 2,048 | **No** — D3D12 hard cap |
| `minStorageBufferOffsetAlignment` | 256 B | 256 B | Only *lowerable*, don't |
| `maxUniformBufferBindingSize` | 65,536 B | larger | Yes |

Design consequences, in order of severity:

1. **The 128 MiB binding cap is the one that bites.** The surface grid has *N* = 2048² = 4,194,304 cells. A 32-byte array-of-structures cell is exactly 134,217,728 B — *exactly* at the default cap, so a single extra byte per cell fails validation on a default device. We do not rely on raising it: every buffer is split per-field (SoA), so the largest single binding is 16.0 MiB. Where a field genuinely must be large, it is either (a) split into four 512-row tiles bound as four separate bindings, or (b) promoted to a **storage texture**, which is governed by `maxTextureDimension*` and total memory, not by `maxStorageBufferBindingSize`. That is the principal reason the 3D fields (smoke/temperature, wind) are textures, not buffers.
2. `maxComputeWorkgroupsPerDimension = 65535` is hard. A naïve 1D dispatch of one invocation per canopy voxel (512×512×64 = 16,777,216) at `@workgroup_size(64)` needs 262,144 workgroups and **fails validation**. All large dispatches are 2D or 3D, or indirect off a compacted list.
3. `maxTextureDimension3D = 2048` is hard, so 512×512×64 and 256×256×64 volumes are fine, but we can never go to a dense 2048³ voxel field.
4. `maxBindGroups = 4` forces a frequency-of-change layout: **group 0** per-frame uniforms (time, wind base, sun vector, step index); **group 1** immutable world (terrain, fuel model IDs, LUTs); **group 2** ping-pong sim state (bound as one of two pre-baked bind groups per parity); **group 3** pass-local (active lists, counters, indirect args). No pass may need a fifth.

We request: `maxStorageBufferBindingSize: 1 GiB`, `maxBufferSize: 1 GiB`, `maxComputeInvocationsPerWorkgroup: 1024`, `maxComputeWorkgroupSizeX/Y: 1024`, `maxComputeWorkgroupStorageSize: 32768`, `maxStorageBuffersPerShaderStage: 16`, `maxStorageTexturesPerShaderStage: 8`, plus features `shader-f16`, `timestamp-query`, and `subgroups` if present. Every one is wrapped in a `Math.min(requested, adapter.limits.x)` clamp and a capability tier fallback, because requesting a limit the adapter cannot meet **rejects device creation outright**.

### 6.2 Data layout

**Principle: full 0.5 m resolution only for fields with a 0.5 m correlation length.** Dead fuel moisture, wind, and solar load have correlation lengths of tens of metres; storing them per surface cell would cost 32 MiB per field for information that is not there. They live on coarse grids and are sampled with bilinear/trilinear interpolation.

**Surface state, N = 4,194,304 cells @ 0.5 m** (all SoA, all separate buffers):

| Field | Format | B/cell | MiB | Rationale |
|---|---|---|---|---|
| terrain height *h* | f32 | 4 | 16.0 | f16 at 500 m elevation has 0.24 m ulp; slope from 0.5 m differences would be pure cancellation noise. f32 mandatory. |
| slope tan φ, aspect | 2 × f16 | 4 | 16.0 | precomputed from *h* once; f16 is ample (aspect to ~0.25° worst case, well below the resolution of the solar-load and wind-alignment terms that consume it) |
| fuel model ID, flags | 2 × u8 | 2 | 8.0 | flags = hedgerow / road / water / under-canopy / heather-bracken-gorse |
| load scale, depth scale | 2 × u8 | 2 | 8.0 | per-cell multipliers on the model's *w₀*, *δ*; absolute values live in a 64-entry uniform LUT |
| **static subtotal** | | **12** | **48.0** | |
| arrival time *t*ᵢ𝑔ₙ | u32, ms | 4 | 16.0 | integer ms since sim start; updated by `atomicMin`, exact and order-independent |
| phase | u8 | 1 | 4.0 | unburnt / preheating / flaming / smouldering / burnt-out |
| burnt fraction | f16 | 2 | 8.0 | drives the green→scorch→char→ash material blend |
| residual smouldering mass | f16 | 2 | 8.0 | kg m⁻² |
| **dynamic subtotal ×2 (ping-pong)** | | | **72.0** | |
| ROS, Iᵦ output texture | `rg16float` 2048² | 4 | 16.0 | consumed by renderer + HUD, single-buffered |

Surface total **136 MiB**; largest single binding 16.0 MiB.

**Coarse fields:** dead/live fuel moisture by class (US 1 h/10 h/100 h/live-herb/live-woody; UK FFMC/DMC/DC) on a 128×128 grid at 7.8125 m, `rgba16float` = 131,072 B = 0.125 MiB each, ×2 textures = 0.25 MiB. Solar/aspect load, same grid, 0.13 MiB.

**Canopy, sparse brickmap.** Bricks of 8³ = 512 voxels at 2 m ⇒ brick = 16 m cube. Brick grid 64×64×8 = 32,768 slots, of which only the lowest two vertical slabs (0–32 m AGL) are reachable = 64×64×2 = 8,192 slots. Typical forest occupancy of those reachable slots is ~50 %, so we allocate a pool of 4,096 bricks = 2,097,152 voxels (4.0 MiB per f16 field, 20 MiB for the five fields) with a free-list and a documented allocation-failure policy that degrades to the coarse mip. If a dense allocation is preferred instead, state it as such: 8,192 bricks is 100 % of the reachable volume and the brickmap then buys indirection flexibility, not memory savings.

> **OPEN QUESTION (unverified):** The ~50 % figure is an assumed *brick* occupancy, and it has never been measured against a generated world. Occupancy at 8³ = 16 m brick granularity is not the same quantity as canopy *voxel* occupancy (elsewhere estimated at 10–18 %): a thin, terrain-following canopy band clips a large number of bricks while filling each of them sparsely, so the fraction of the 8,192 reachable slots that must be allocated could be well above 50 % — in which case a 4,096-brick pool overflows rather than carrying headroom. Until brick occupancy is instrumented on several real terrains (dense conifer, open savanna, steep relief), treat 4,096 as provisional and 8,192 (the dense, always-sufficient allocation) as the fallback. Whichever is chosen, the allocation-failure policy — degrade that brick to the coarse mip, surface it in the HUD, never silently drop canopy — must exist before the brickmap is written, because a pool overflow with no policy is a silent physics hole, not a crash.

| Field | Format | B/vox | MiB (4,096 bricks) |
|---|---|---|---|
| bulk density ρᵦ | f16 | 2 | 4.0 |
| moisture content *m* (fraction of oven-dry) | f16 | 2 | 4.0 |
| temperature *T* | **u16 fixed-point** | 2 | 4.0 |
| char fraction | f16 | 2 | 4.0 |
| extinction σₜ for renderer | f16 | 2 | 4.0 |
| indirection `r32uint` 64×64×8 + free-list | u32 | — | 0.13 |

*T* is **not** f16: at *T* = 1200 K the f16 ulp is 1.0 K, and a per-substep increment of ΔT ≈ 0.1 K would be silently annihilated by round-to-nearest. Store instead

  *T* = *T*₀ + *s*·*u*,  *T*₀ = 200 K, *s* = 0.02 K, *u* ∈ [0, 65535] ⇒ range [200 K, 1510.7 K], resolution 0.02 K.

This is the single place in the sim where naïve f16 produces a *qualitatively wrong* result (stalled preheating), so it is worth the explicit conversion.

**Wind field:** 128×128×32 (7.8125 m × 7.8125 m × 4 m, 128 m column), `rgba16float` (u, v, w, TKE) = 4,194,304 B = 4.0 MiB, ping-pong = 8.0 MiB.

**Smoke/temperature field for the renderer:** 256×256×64 at 4 m horizontal, 2 m vertical, `rgba16float` (T, soot mass fraction, water vapour, unused) = 33,554,432 B = 32.0 MiB, ping-pong = 64.0 MiB. We deliberately do **not** advect at 2 m (512×512×64 = 134,217,728 B = 128 MiB per copy — the same byte count §6.1 calls the default storage-buffer cap — 256 MiB ping-pong, ~4× the bandwidth): the froxel raymarcher reconstructs sub-4 m structure with curl-noise detail, which is visually superior per byte to a 2 m advected field that is itself numerically diffused.

**Firebrands:** `MAX_BRANDS` = 2¹⁸ = 262,144, 32 B/brand AoS = 8.0 MiB, ×2 for compaction = 16.0 MiB. Layout: `pos` 3×f32 (12 B), `vel` 3×f16 (6 B), `d` f16, `mass` f16, `char` f16, `age` f16 (8 B), `seed|flags` u32 (4 B), pad 2 B.

**SoA vs AoS — the actual number.** Ada's L2 sector is 32 B. A subgroup of 32 invocations reading one f16 field across 32 consecutive surface cells touches 64 B = 2 sectors: 100 % of fetched bytes used. The same 32 invocations reading one f16 out of a 32 B AoS struct touch 32 sectors = 1024 B to consume 64 B: **16× bandwidth waste**. Grids are therefore strictly SoA. Firebrands are the *exception* and are AoS, because every particle invocation touches every field of exactly one particle: a 32 B struct is two 16 B loads, whereas SoA would be seven independent scattered streams.

**VRAM budget (8 GiB card, target ≤ 4.5 GiB resident to avoid driver PCIe paging, which manifests as random 10 ms stalls rather than an OOM):**

| Block | MiB |
|---|---|
| Surface (static + dynamic ×2 + output) | 136 |
| Coarse moisture / solar | 1 |
| Canopy bricks (5 fields) + indirection | 20 |
| Wind ×2 | 8 |
| Smoke/T froxel volume ×2 | 64 |
| Firebrands ×2 | 16 |
| Active lists, counters, indirect args, scan scratch | 2 |
| **Simulation subtotal** | **247** |
| HDR + G-buffer + motion + TAA history @1440p | 130 |
| Shadow atlas (4 × 2048² d32) | 64 |
| Scattering LUTs, blue-noise, BRDF | 16 |
| CC0 PBR material set (24 materials × 4 maps × 2048² BC7) | ~500 |
| Procedural geometry: tree meshes, grass blade buffers, instance data | ~320 |
| **Renderer subtotal** | **~1030** |
| **Total** | **~1277 MiB ≈ 1.25 GiB** |

### 6.3 Pass schedule

Fixed base substep *h* = 1/120 s = 8.333 ms. Multi-rate: not every pass runs every substep. Bandwidth estimates assume 190 GB s⁻¹ effective (RTX 4070 Laptop, 128-bit GDDR6 @ 16 Gbps = 256 GB s⁻¹ peak, ~75 % achievable through Dawn/D3D12), and ~19 TFLOP s⁻¹ FP32. "Typical" = a mature fire with a ~2 km perimeter, ≈4 % of the surface grid and ≈40,000 canopy voxels active.

| # | Pass | Rate | Dispatch | WG size | Typical µs | Worst µs | Depends on |
|---|---|---|---|---|---|---|---|
| 0 | `clearCounters` + build indirect args | 1/1 | (1,1,1) | 64 | 2 | 2 | — |
| 1 | `tileClassify` (surface active set) | 1/1 | (128,128) cells→(8,8) wg | 16×16 | 3 | 8 | P8 of prev step |
| 2 | `surfaceSpread` (Rothermel + slope/wind, atomicMin arrival) | 1/4 | indirect, *n*ₜ wg | 16×16 | 35 | 660 | 1 |
| 3 | `canopyRadiation` (view factors, 32 rays × 16 steps) | 1/1 | indirect, *n*ᵦ wg | 8×8×8 | 80 | 900 | 2 |
| 4 | `canopyThermal` (conduction, pyrolysis, mass loss) | 1/1 | indirect, *n*ᵦ wg | 8×8×8 | 5 | 60 | 3 (**barrier**) |
| 5 | `windUpdate` (log profile, terrain modification, gust field) | 1/8 | (16,16,8) | 8×8×4 | 6 (amort.) | 45 | — |
| 6 | `plumeAdvect` (semi-Lagrangian, buoyancy, no pressure solve) | 1/2 | indirect brick list | 8×8×8 | 40 (amort.) | 530 | 4, 5 |
| 7 | `brandLaunch` (append, atomicAdd) | 1/1 | indirect from P1 list | 256 | 5 | 15 | 2 |
| 8 | `brandIntegrate` (drag, burn, plume lift) | 1/1 | indirect from live count | 256 | 8 | 88 | 5, 7 |
| 9 | `brandCompact` (decoupled-lookback scan + scatter) | 1/1 | ⌈*n*/1024⌉ | 256 | 8 | 20 | 8 (**barrier**) |
| 10 | `brandLand` (ignition scatter, `atomicMin` on *t*ᵢ𝑔ₙ) | 1/1 | indirect | 256 | 3 | 10 | 9 |
| 11 | `emissionInject` (surface → froxel soot/T sources) | 1/1 | indirect tiles | 16×16 | 10 | 90 | 2, 4 |
| 12 | `statsReduce` (HUD: max ROS, perimeter, area, flux probes) | 1/1 | hierarchical | 256 | 6 | 15 | 11 |
| | **Total per substep** | | | | **≈205** | **≈2400** | |

At 2 substeps per rendered frame (= real time at 60 fps) the simulation costs **≈0.41 ms/frame typical, ≈4.8 ms worst case**, leaving 12–16 ms for the renderer. The worst case is the honest number to plan against, and it is why the active set is load-bearing rather than a nicety.

> **OPEN QUESTION (unverified):** Only one line of this table has been reconciled against a physical bound: `surfaceSpread`'s 660 µs worst case, which is ~126 MB of traffic ÷ 190 GB s⁻¹ = 662 µs and is therefore a genuine bandwidth estimate. The other eleven passes' typical and worst figures are unvalidated, and the largest single line — `canopyRadiation` at 900 µs — is reasoned from ray count and ALU rather than from the bandwidth bound that actually governs a 32-ray × 16-step gather over the brick pool; a pass framed by FLOPs when it is bound by traffic can be wrong by an order of magnitude in either direction. The ≈205 µs typical / ≈2400 µs worst totals, the ≈4.8 ms per-frame worst case, and the "leaves 12–16 ms for the renderer" conclusion all inherit that uncertainty. **Before any budget here is committed to, every pass must be baselined with per-pass timestamp queries in a developer build (§6.7), and each figure must be accompanied by whichever bound — bandwidth or ALU — was found to dominate.** Until then treat this table as a design intent, not a measurement.

**Overlap and barriers.** WebGPU gives no explicit barrier API: dependencies are inferred per *pass*, and consecutive `GPUComputePassEncoder`s in one encoder are conservatively serialised on the same queue. There is therefore no way to *force* overlap — the only lever is putting independent work into the **same** pass via multiple `dispatchWorkgroups` calls with no intervening bind-group change on a shared resource, which Dawn can leave unfenced. P5 (wind) and P2 (surface spread) are genuinely independent within a substep and are issued back-to-back inside one pass. P3→P4 and P8→P9 are true RAW hazards and get their own passes. The corollary: **reduce pass count**, because each pass boundary is a full barrier plus ~2–5 µs of Dawn CPU encoding. Twelve passes × 2 substeps = 24 passes/frame ≈ 60–120 µs of pure encode overhead; this is why P0–P1 and P11–P12 are fused where the dependency graph allows.

> **OPEN QUESTION (unverified):** The claim that issuing independent `dispatchWorkgroups` calls inside one pass "which Dawn can leave unfenced" yields real P2/P5 overlap is an assertion about a specific implementation, not a WebGPU guarantee — the spec gives no barrier semantics at this granularity and Dawn's fencing behaviour can change between Chrome versions without notice. If it does not hold, the two dispatches serialise and the wind pass's cost stops being amortised, which moves the per-substep total. This must be confirmed on the target build with a GPU capture (PIX or Nsight, looking for overlapping dispatch ranges) before any pass is merged on the strength of it, and the merge must be written so that serialisation is merely slower, never incorrect.

### 6.4 Techniques

**Indirect dispatch off a two-level active set — the single biggest win.** The fire front is spatially coherent, so we compact at *tile* granularity, not cell granularity. Surface tiles are 16×16 cells (8 m × 8 m), giving 128×128 = 16,384 tiles. A tile is active if any cell in it, or in its 1-tile neighbourhood, is preheating/flaming/smouldering.

Per-cell compaction would be the wrong call here and it is worth saying why with numbers: a 4.19 M-element exclusive prefix sum costs ~2 × 4.19 M × 4 B = 33.5 MB of traffic ≈ 180 µs, to save perhaps 40 µs of wasted work inside half-full tiles. Tile compaction costs 16,384 elements ≈ 3 µs and captures ~95 % of the benefit.

The append itself uses one atomic per workgroup, not one per tile, via subgroup ballot:

```wgsl
// tileClassify: one invocation per tile, @workgroup_size(64)
let active = tileHasFire(tid);
let mask   = subgroupBallot(active);            // 'subgroups' feature
let nSub   = countOneBits(mask.x) + countOneBits(mask.y);
var base   = 0u;
if (subgroupElect()) { base = atomicAdd(&counters.tileCount, nSub); }
base = subgroupBroadcastFirst(base);
let slot = base + subgroupExclusiveAdd(select(0u, 1u, active));
if (active) { tileList[slot] = tid; }
```
Fallback without `subgroups`: a workgroup-shared 64-entry ballot reduced with `workgroupBarrier()` and one `atomicAdd` per workgroup. Cost of the fallback ≈ +2 µs; cost of naïve per-invocation `atomicAdd` ≈ +25 µs at 16 k tiles because they serialise on one cache line.

A second kernel converts the count to `GPUDispatchIndirect` args `(ceil(n), 1, 1)` in a buffer with usage `INDIRECT | STORAGE`. Note that `maxComputeWorkgroupsPerDimension` applies to indirect dispatch too, but is not validated at encode time. Per WebGPU §16.1.2, if any of `workgroupCountX`/`Y`/`Z` read from the indirect buffer exceeds `device.limits.maxComputeWorkgroupsPerDimension` the dispatch is **silently skipped in its entirety** on the queue timeline — it is not clamped, it is not undefined, and no error is surfaced. The args kernel must therefore both clamp explicitly and fold any excess into the Y dimension, and should raise a HUD warning when it does so, because otherwise a whole substep of work vanishes with no symptom other than a stalled fire.

**Where a real prefix sum is needed:** firebrand compaction, 262 k elements. Here we use single-pass decoupled lookback (Merrill & Garland 2016) — one kernel, 256 threads/workgroup, 4 elements/thread, a partition-descriptor buffer with `atomicStore`/`atomicLoad` flag+aggregate+inclusive-prefix. Honest caveat: decoupled lookback assumes forward progress between workgroups, which WebGPU **does not guarantee**. It works in practice on Ada under D3D12 (workgroups launch in order), but the fallback is a conventional three-kernel scan (reduce → scan-block-sums → downsweep), costing ~2.5× more at this size (20 µs vs 8 µs). Ship the three-kernel version as the default and gate lookback behind a runtime probe.

**Shared-memory tiling for stencils.** `canopyRadiation` and `plumeAdvect` load an 8³ brick plus a 2-voxel halo = 12³ = 1728 voxels to produce 512 outputs — 3.375× amplification, but every one of the 125-tap near-field stencil reads then hits `var<workgroup>` instead of L2. At 5 fields × 2 B × 1728 = 17.3 KB this exceeds the *default* `maxComputeWorkgroupStorageSize` of 16,384 B, which is precisely why we request 32,768. On a device that refuses, the fallback halves the halo to 1 voxel (10³ = 1000 voxels, 10.0 KB) and drops the near-field radius from 4 m to 2 m — a physics degradation, so it is surfaced in the HUD.

**Subgroups.** Feature `subgroups`, stable in Chrome from version 134. On Ada `subgroupMinSize == subgroupMaxSize == 32`. Used for: the ballot-compaction above, `subgroupAdd` in `statsReduce` (replaces the first two levels of the shared-memory reduction tree, ~30 % faster), and `subgroupBroadcastFirst` to hoist uniform tile parameters out of registers. Never assume a size — always branch on `subgroupMaxSize`.

**Ping-pong.** Two pre-created bind groups (parity 0 and 1) referencing the same pipeline layout, swapped per substep with zero per-frame bind-group creation. `t_ign` does not need ping-pong **provided it is write-only within any pass that writes it**: `atomicMin(&tign[i], t_ms)` makes the set of concurrent writes order-independent (min is commutative, associative and idempotent), so write-write aliasing is safe. This does *not* extend to read-write aliasing: an invocation that reads `tign` in the same dispatch that `atomicMin`-writes it may observe either the pre- or post-update value depending on workgroup scheduling order, which would break the determinism guarantee of §6.5. Therefore `surfaceSpread` reads its ignition-front inputs only from the ping-ponged phase / burnt-fraction state (parity *N*) and treats `tign` as a write-only sink; `tign` is read back only in a later pass (`emissionInject`, `statsReduce`, renderer).

### 6.5 Decoupled timesteps and determinism

Fixed step *h* = 1/120 s. Per rendered frame with wall-clock delta Δ*t*_wall (seconds):

  *A* ← min(*A* + Δ*t*_wall · *r*, *A*max),  *n*_sub = ⌊*A*/*h*⌋,  *A* ← *A* − *n*_sub·*h*

where *A* = accumulator (s), *r* = time-lapse rate (dimensionless, 1 = real time, up to 60 for multi-hour runs), *A*max = 4*h* = 33.3 ms (spiral-of-death clamp — beyond this we drop simulated time and report it in the HUD rather than compounding a stall). Rendering interpolates between substep states with α = *A*/*h* for the froxel volume only; the surface arrival-time field is already continuous in time by construction, so it needs no interpolation.

**Determinism, honestly scoped.** Bit-exact reproducibility across GPUs is *not achievable* in WebGPU: WGSL permits fused multiply-add contraction and does not pin transcendental accuracy, and Dawn's HLSL output varies by driver. What we can and do guarantee is **same-device, frame-rate-independent reproducibility**, which is what a user comparing two runs actually needs:

1. All scatter-accumulation uses integer atomics on fixed-point values (`atomicMin` on u32 ms for arrival, `atomicAdd` on u32 with scale 2¹⁰ J m⁻³ for radiant energy deposition). WebGPU core has **no float atomics at all** — `atomic<T>` admits only `u32`/`i32` — so this is forced anyway, and it is a blessing: integer reduction is exactly associative, so results do not depend on workgroup completion order.
2. All randomness is stateless: `PCG3D(cellIndex, stepIndex, streamId)`, never a stored RNG state. Firebrand launch, gust turbulence and fuel heterogeneity are therefore invariant to dispatch order and to how many substeps a frame happened to run.
3. Every physics quantity advances only in whole *h* increments. Quality scaling (§6.7) never touches *n*_sub or *h*.

Residual nondeterminism: floating-point reductions in `statsReduce` (HUD numbers may differ in the 6th significant figure) and the radiation ray-march accumulation order. Neither feeds back into state evolution.

> **OPEN QUESTION (unverified):** Same-device reproducibility is advertised to the user — the CSV/JSON export is meaningless without it — but nothing above has been demonstrated empirically, and the guarantee now rests on an invariant that no tool enforces: that **no pass ever reads `tign` in the same dispatch that `atomicMin`-writes it** (§6.4). WGSL will compile a violation happily, and the resulting nondeterminism is scheduling-dependent, so it will not reproduce on demand and will not show up in a single test run. Two things must close this before the export is presented as reproducible data: (1) a mechanical check — a distinct binding or a review rule that keeps the write-only `tign` sink and the read-only ignition-front inputs textually separate — rather than a convention; and (2) an actual determinism test in CI that runs the same seed and ignition script twice at deliberately different frame rates (e.g. uncapped vs 30 fps) and diffs the exported arrival-time field bit-for-bit. It is also unconfirmed whether "same device" survives a driver or Chrome update, since Dawn's HLSL output may change; until tested, exports should record adapter info and browser version.

### 6.6 CPU side (24 cores / 32 threads, i9-13900HX)

The physics stays on the GPU without exception; a per-frame readback of the sim state would cost more in latency than the whole solve. The CPU's jobs are **generation, meshing, audio, and orchestration**.

| Work | Where | Threads | Notes |
|---|---|---|---|
| Terrain synthesis (FBM + hydraulic erosion, 2048²) | Worker pool, **WASM** | 12 | erosion is 10⁵ droplet iterations of pointer-chasing; measured 4–8× over JS with SIMD128 and, more importantly, no GC pauses |
| Fuel-model / biome assignment, hedgerow & road network | Worker pool, JS | 4 | graph work, allocation-heavy, JIT handles it fine |
| Space-colonisation tree meshing (~20,000 trees) | Worker pool, **WASM** | 16 | ~10–50 ms/tree in JS; the attractor-point k-d tree query is the hot loop. Output: transferable `ArrayBuffer` of interleaved vertices |
| GPU grass: only the per-chunk instance seeds | Worker pool, JS | 4 | blades themselves are generated in the vertex shader |
| Audio synthesis | **AudioWorklet**, main audio thread | 1 (realtime) | never a Worker |
| Frame orchestration, encoding, UI | Main thread | 1 | |

**Audio specifically:** procedural fire is three filtered pink-noise bands (roar 20–200 Hz, hiss 2–8 kHz, combustion rumble 40–120 Hz) plus a Poisson crackle grain scheduler, synthesised in an `AudioWorkletProcessor` at the 128-sample quantum (2.67 ms @ 48 kHz). Parameters (nearest-front distance, integrated fireline intensity, wind speed) are pushed through a lock-free SPSC ring buffer in a `SharedArrayBuffer` with `Atomics.store`/`Atomics.load`. **Not** `postMessage` — its delivery jitter (5–30 ms, worse under GC) is audible as amplitude stepping on a continuous roar.

**Cross-origin isolation.** `SharedArrayBuffer` requires `crossOriginIsolated === true`, which requires both response headers on the top-level document:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp     # or credentialless
```

Every cross-origin subresource then needs `Cross-Origin-Resource-Policy: cross-origin` or a `crossorigin` attribute; since all assets (CC0 textures) are self-hosted this is free. Two bonuses worth having anyway: `performance.now()` resolution improves from 100 µs to 5 µs, and WASM threads (`pthread`/`wasm-bindgen-rayon`) become available. In Vite, set `server.headers` for dev and the equivalent on the static host for production.

**Is WASM worth it?** Only for the two workloads above. Modern TurboFan on `Float32Array` numeric code lands within 1.5–2× of WASM, so the ~1 day of toolchain integration is not repaid by glue code. It *is* repaid by tree meshing, where 20,000 trees × 30 ms = 600 s of single-threaded JS becomes ~38 s across 16 worker threads in JS, and ~10 s across 16 worker threads in WASM (600 s ÷ 16 threads ÷ ~4× measured WASM speedup ≈ 9.4 s) — the difference between a 10 s and a 40 s world-generation screen. Be sceptical of blanket "WASM is 10× faster" claims; the honest measured range for this class of code is 2–8×.

> **OPEN QUESTION (unverified):** The ~10 s figure carries two assumptions that have not been measured for *this* workload. First, the ~4× WASM speedup is borrowed from the hydraulic-erosion measurement in the table above; the tree-mesher's hot loop is a k-d tree attractor query, a different memory-access profile, and the honest range quoted in this very sentence is 2–8× — at the low end the WASM screen is ~19 s and the investment barely beats plain JS workers. Second, the 16-way divide assumes 16 *effective* threads on a 24-core/32-thread part where 16 of the cores are E-cores and the WASM path additionally requires `crossOriginIsolated` for `pthread`s; near-linear scaling to 16 is an assumption, not a result. Both must be settled by prototyping the mesher on one representative tree and measuring JS vs WASM single-thread, then measuring the scaling curve out to 16 workers, before the world-generation budget or the WASM toolchain decision is fixed.

### 6.7 Profiling and dynamic quality scaling

Request the optional feature `timestamp-query`. Per pass, attach

```js
pass = encoder.beginComputePass({ timestampWrites: {
  querySet, beginningOfPassWriteIndex: 2*i, endOfPassWriteIndex: 2*i + 1 }});
```

then `encoder.resolveQuerySet(querySet, 0, 2*P, resolveBuf, 0)` (u64 nanoseconds per query) → `copyBufferToBuffer` into a **3-deep ring** of `MAP_READ` staging buffers. Never `mapAsync` a buffer touched in the current frame; read frame *n*−3.

**The honesty problem:** Chrome quantises timestamp query results to **100 µs** as a timing-attack mitigation. Nine of our twelve passes are below that. A shipping build therefore *cannot* resolve per-pass microseconds. Three mitigations, all of which we use:

1. **Phase grouping.** Wrap passes into 5 timed phases (surface, canopy, fluid, brands, render) each ≥ 300 µs, so quantisation is ≤ 30 % of a sample and averages out.
2. **EMA over ≥ 120 frames** with a decay of 0.98; the quantisation error is uncorrelated with the signal, so the mean converges to within ~10 µs.
3. **Dev builds** enable `chrome://flags/#enable-webgpu-developer-features`, which removes quantisation and gives true per-pass numbers. All per-pass µs figures in §6.3 are to be *measured this way and never trusted from a shipping build*.

Additionally, `device.queue.onSubmittedWorkDone()` gives a CPU-timeline wall clock for the whole submit — cheap, always available, and the ground truth the quality controller actually reads.

**Quality controller.** Let *m* = 30-frame median GPU frame time (ms), τ = 16.67 ms. Quality level *q* ∈ {0…5} drives, monotonically: render resolution scale *s* ∈ {0.60, 0.70, 0.80, 0.90, 1.0, 1.0}, froxel march steps *N*ₘ ∈ {24, 32, 48, 64, 96, 128}, near-field particle budget, and radiation ray count *N*ᵣ ∈ {8, 8, 16, 16, 32, 32}. Asymmetric hysteresis:

  if *m* > 0.92τ for 20 consecutive frames → *q* ← *q* − 1
  if *m* < 0.75τ for 90 consecutive frames → *q* ← *q* + 1

Fast down, slow up: this is what stops the visible resolution pumping that a symmetric controller produces at a marginal operating point. **The controller never changes *h* or *n*_sub** — degrading the physics to hold framerate would silently invalidate every measurement the HUD exports. *N*ᵣ is the one physics-adjacent knob it touches, and it is floored at 8 because below that the view-factor Monte Carlo estimator's variance biases crown-fire initiation *early* (fewer rays ⇒ noisier flux ⇒ more spurious threshold crossings); the HUD annotates any CSV/JSON export made at *q* < 2.

### 6.8 Pitfalls that will specifically bite this project

1. **Hybrid-GPU laptops default to the Intel iGPU.** Per Chrome's own documentation, Chrome "always uses the same GPU adapter that's been allocated for other Chrome workloads, which for laptops is generally the integrated graphics card", and consequently `powerPreference: 'high-performance'` "doesn't have any impact when calling `requestAdapter()`" on Windows. On this machine that means the i9-13900HX's Xe-LPG iGPU: roughly 1/8 the compute and 1/4 the bandwidth — a 6 fps experience. Mitigation is threefold: (a) still pass `powerPreference: 'high-performance'`, because it does work on macOS and on some configurations; (b) inspect `adapter.info` (`vendor`, `architecture`, `description`) and if it is not a discrete NVIDIA/AMD part, show a **blocking** modal with the three fixes — `chrome://flags/#force-high-performance-gpu`, Windows Settings → System → Display → Graphics → chrome.exe → High performance, and NVIDIA Control Panel per-application setting; (c) never silently run at 6 fps and let the user conclude the simulation is slow.
2. **Storage-buffer count.** Several passes touch more than the default 8 storage buffers per stage. Raise the limit, *and* have a packed fallback that suballocates several logical fields into one buffer at 256 B-aligned offsets (`minStorageBufferOffsetAlignment`).
3. **No float atomics, no 64-bit integers** in core WGSL. Every accumulation is u32 fixed-point with a documented scale and a saturation check, or restructured as a gather.
4. **`workgroupBarrier()` must be reached by every invocation in the workgroup** — WGSL's uniformity analysis rejects a barrier in non-uniform control flow, and the compiler error is often reported at a confusing location. This breaks the obvious shared-memory tiling idiom `if (outOfBounds) { return; } … workgroupBarrier();`. Always use a predicate flag and let all invocations fall through to the barrier.
5. **A binding's *size*, not just the buffer's, is validated** against `maxStorageBufferBindingSize`. Binding a 200 MiB sub-range of a 1 GiB buffer fails on a default device even though the buffer was created successfully.
6. **Windows TDR.** A single dispatch exceeding ~2 s triggers a driver reset → `device.lost`. The worst-case full-domain `canopyRadiation` at low quality on a weak adapter can approach this. Chunk any dispatch estimated above ~50 ms across frames, and implement `device.lost` handling that rebuilds all resources rather than showing a black canvas.
7. **Pipeline compilation hitches.** Dawn compiles lazily; the first ignition can stall 200 ms while the spread and radiation pipelines compile. Create every pipeline with `createComputePipelineAsync()` and `await` them all behind the world-generation screen.
8. **`shader-f16` is a feature, not a guarantee.** It is present on Ada but not universal. The portable fallback for f16 *storage* is manual packing with `pack2x16float`/`unpack2x16float` into `u32`, which is core WGSL — arithmetic stays f32, which for our fields costs nothing since we convert on load anyway.
9. **No VRAM query exists in WebGPU.** Budget conservatively (§6.2); exceeding VRAM produces driver-level paging over PCIe that appears as sporadic 10 ms frame spikes with no error, not as an allocation failure.
10. **`maxBindGroups = 4` and `maxImmediateSize = 64 B`.** Immediate data (WebGPU's push constants, 64 B default) is newly specified and not yet universally shipped; do not build the per-tile-offset path on it. Use dynamic uniform buffer offsets instead (`maxDynamicUniformBuffersPerPipelineLayout = 8`).

### 6.9 Stated model limitations of this architecture

Two deliberate compromises, flagged so they are not later mistaken for bugs:

- **No pressure projection in the plume solver.** We advect the smoke/temperature field with the terrain-modified wind plus a parameterised buoyant vertical velocity (Briggs 1975 plume-rise scaling, with atmospheric stability entering through the Brunt–Väisälä frequency), rather than solving ∇·**u** = 0. A 256×256×64 Jacobi/multigrid pressure solve would cost 1.5–3 ms per substep — more than the entire rest of the simulation — and would still be too coarse to resolve the relevant vorticity. The consequence is real and should be stated: fire-induced indraft and the counter-rotating vortex pairs that drive fingering and lateral fire spread (Clark et al. 1996) are **not** reproduced. Spread rates remain calibrated to Rothermel (1972) / Scott & Burgan (2005), to Cheney, Gould & Catchpole (1998, IJWF 8(1):1–13) for grass, and to Cheney, Gould, McCaw & Anderson (2012, For. Ecol. Manage. 280:120–131; Project Vesta) for dry eucalypt forest — none of which resolve that mechanism either; but the coupled feedback is absent by construction, and any run in which it would dominate is outside this model's envelope.
- **Radiative transfer uses a two-level view-factor approximation** (explicit 5×5×5 near field, coarse mip for the far field) rather than a full ray-traced form-factor integral. Below *N*ᵣ = 8 rays the Monte Carlo variance biases crown-fire initiation early, as noted in §6.7.
