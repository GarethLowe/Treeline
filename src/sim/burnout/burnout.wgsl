// Burnout and output-field resolve — WP 2.4, spec §4.7.
//
// Port of `consumption.ts` + `fields.ts`, which are the oracle. If this and they disagree,
// they are right.
//
// ## Where the inputs come from - RECONCILED 2026-08-19
//
// This file originally declared two per-cell atomic accumulators and two writer functions
// (`record_arrival`, `record_intensity`) for WP 2.3's propagation shader to call. **WP 2.3
// never called them and never bound them**, so `intensityTexture` and `consumedTexture` were
// structurally zero from the day both packages landed, and the HUD listed them as a known
// integration gap rather than reporting a physical result.
//
// The accumulators are gone. Both packages were already writing the same information
// somewhere else: WP 2.3 stamps arrival time into its own `arrivalTime` texture as the level
// set crosses zero, and now also stamps the normal rate of spread at that instant into
// `rosArrival`. Those two textures are bound here read-only and this pass derives everything
// from them. One writer, one reader, no accumulation - which makes the result
// order-independent by construction rather than by atomic discipline, and keeps the M6 CSV
// export reproducible for free.
//
// ## The determinism contract
//
// Only two fields are ever accumulated across concurrent writers, and both combine with an
// operation that is commutative, associative and idempotent:
//
//   arrival[i]  <- min(arrival[i], t)     atomicMin
//   peakI[i]    <- max(peakI[i], I)       atomicMax
//
// Both hold f32 **bit patterns**, not floats, because WGSL has no float atomics. For
// non-negative finite floats IEEE-754 bit patterns sort identically to the values they
// encode, so u32 atomicMin over the bits *is* float min — exactly, not approximately. Both
// writers below reject negatives, which is what keeps that guarantee true.
//
// Everything else (state, consumed) is a pure function of arrival time, so no scheduling
// order can affect it. That is what makes a run reproducible for the M6 CSV export.
//
// ## Storage-texture formats
//
// `r8uint`, `r8unorm` and `r16float` need the `texture-formats-tier1` feature for
// STORAGE_BINDING. It is present on the target device (checked at bring-up). `r32float`
// storage is core.

const CLASSES: u32 = 5u;

// ln(1/1e-3) — a class is fully consumed at t = tau * CUTOFF. Keep in step with
// BURNOUT_RESIDUAL / BURNOUT_CUTOFF in consumption.ts.
const BURNOUT_CUTOFF: f32 = 6.907755279;
const BURNOUT_RENORM: f32 = 1.0010010010010010;

// Largest finite f32. "Front has not arrived."
//
// The digits matter. This was written as `3.40282347e+38`, the value C's FLT_MAX prints as at
// 9 significant figures — which rounds UP past the largest representable f32, so Dawn rejects
// the literal outright: "value 340282346999999984391321947108527833088.0 cannot be represented
// as 'f32'". That invalidates the whole shader module, which invalidates every pipeline built
// from it, which DISCARDS EVERY COMMAND BUFFER those pipelines appear in — including all of
// the surface solver's compute passes, encoded before this pass and entirely innocent. The
// symptom is a fire that never starts and a probe that blames the Rothermel stage.
//
// Written as a hex float, which is exact. Dawn compares a decimal literal against the f32
// range BEFORE rounding it, so both of the usual spellings are rejected: 3.40282347e+38 and
// 3.4028235e+38 each denote a decimal strictly larger than 0x1.fffffep+127, even though both
// round to it. Do not "simplify" this back to decimal.
const ARRIVAL_NEVER: f32 = 0x1.fffffep+127;

const STATE_UNBURNT: u32 = 0u;
const STATE_BURNING: u32 = 1u;
const STATE_BURNT: u32 = 2u;

const AGG_BURNT_CELLS: u32 = 0u;
const AGG_PERIM_EDGES: u32 = 1u;
const AGG_MAX_INTENSITY_BITS: u32 = 2u;
// Centroid of the cells that are FLAMING RIGHT NOW, in cell indices, summed for a CPU divide.
//
// The convective plume has to be anchored somewhere, and it was anchored to the middle of the
// domain — a constant. A fire that spreads away from that point leaves its own plume behind,
// every crown at the front reads ambient gas, and the canopy cannot ignite no matter how hard
// the surface burns. Flaming, not burnt: a ring fire's burnt centroid sits in the black.
const AGG_FLAMING_X: u32 = 3u;
const AGG_FLAMING_Z: u32 = 4u;
const AGG_FLAMING_CELLS: u32 = 5u;

struct BurnoutModel {
  // 1/tau per size class [s^-1]. Zero for a class with no loading.
  invTau: array<f32, CLASSES>,
  // Share of the cell's total loading, sums to 1.
  loadFraction: array<f32, CLASSES>,
  // Flaming residence time of the bed [s] — from WP 2.1, sets the BURNING band.
  residenceTime: f32,
  // Total oven-dry loading [kg m^-2], for the soot source term.
  totalLoad: f32,
};

struct Params {
  now: f32,          // simulated clock [s]
  cellSize: f32,     // [m]
  cells: u32,        // grid is cells x cells
  modelCount: u32,
  // Rothermel reaction intensity [kW m^-2] for the current fuel and weather. Byram (1959) is
  // I = I_R * t_r * R, and I_R depends on the weather as much as on the fuel, so it arrives
  // per resolve rather than living in the model table.
  // ponytail: one value domain-wide, matching FireSim's single-fuel-model simplification.
  // Becomes a per-cell lookup alongside fuelIndex when the M5 fuel map lands.
  reactionIntensity: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> models: array<BurnoutModel>;
@group(0) @binding(2) var<storage, read> fuelIndex: array<u32>;   // 4 cells packed per word
@group(0) @binding(5) var<storage, read_write> aggregates: array<atomic<u32>>;

// Written by this pass.
@group(1) @binding(0) var stateTex: texture_storage_2d<r8uint, write>;
@group(1) @binding(1) var intensityTex: texture_storage_2d<r16float, write>;
@group(1) @binding(3) var consumedTex: texture_storage_2d<r8unorm, write>;
// Written by WP 2.3, read here. Bound as sampled textures rather than storage so the two
// passes cannot be merged by accident: a storage texture read and written in one pass is a
// data race WebGPU will not diagnose.
@group(1) @binding(4) var arrivalSrc: texture_2d<f32>;
@group(1) @binding(5) var rosSrc: texture_2d<f32>;


// ---------------------------------------------------------------------------
// Burnout curve — mirrors classConsumedFraction() in consumption.ts
// ---------------------------------------------------------------------------

fn class_consumed_fraction(dt: f32, inv_tau: f32) -> f32 {
  if (!(dt > 0.0) || inv_tau <= 0.0) { return 0.0; }
  let x = dt * inv_tau;
  if (x >= BURNOUT_CUTOFF) { return 1.0; }
  return (1.0 - exp(-x)) * BURNOUT_RENORM;
}

fn consumed_fraction(m: BurnoutModel, dt: f32) -> f32 {
  // Copied into a `var` so the fixed-size arrays are indexable by a loop variable: a value of
  // array type is not a reference, and dynamic indexing needs one.
  var mm = m;
  var f = 0.0;
  for (var c = 0u; c < CLASSES; c = c + 1u) {
    f = f + mm.loadFraction[c] * class_consumed_fraction(dt, mm.invTau[c]);
  }
  return clamp(f, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

// The aggregates are a snapshot of the current state, not a running total, so they are
// recounted from scratch on every resolve.
@compute @workgroup_size(64)
fn clear_accumulators(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x < 3u) { atomicStore(&aggregates[gid.x], 0u); }
}

// ---------------------------------------------------------------------------
// Resolve: accumulators -> output textures + aggregates
// ---------------------------------------------------------------------------

fn arrival_at(coord: vec2<i32>) -> f32 {
  return textureLoad(arrivalSrc, coord, 0).x;
}

fn has_arrived(coord: vec2<i32>) -> bool {
  let t = arrival_at(coord);
  return t < ARRIVAL_NEVER && t <= params.now;
}

fn fuel_index_at(index: u32) -> u32 {
  // One byte per cell, four cells per storage word. Saves 12 MB against a u32 per cell on
  // the 2048^2 grid, and the fuel-model table is nowhere near 256 entries.
  let word = fuelIndex[index >> 2u];
  return (word >> ((index & 3u) * 8u)) & 0xffu;
}

@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = params.cells;
  if (gid.x >= n || gid.y >= n) { return; }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let index = gid.y * n + gid.x;

  let arrival = arrival_at(coord);

  var mi = fuel_index_at(index);
  if (mi >= params.modelCount) { mi = 0u; }
  let model = models[mi];

  // Byram (1959): I = I_R * t_r * R, with I_R in kW m^-2, t_r in s and R in m s^-1, giving
  // kW m^-1. R is the rate the front was moving AT THIS CELL as it passed, which is why
  // WP 2.3 has to capture it: it is gone by the next substep.
  let ros = max(textureLoad(rosSrc, coord, 0).x, 0.0);

  // Byram's I is a property of the FLAMING FRONT, so it is gated on the cell still being
  // within its flaming residence window — the same test the state enum uses below. Gating it
  // only on "the fire ever arrived here" latched every burnt cell at its arrival intensity
  // for the rest of the run. That is not just a wrong picture: `emit_surface.wgsl` builds the
  // canopy's radiant panels from this texture, so cells that stopped burning minutes ago were
  // still heating the crowns above them, and Van Wagner crown initiation reads it too.
  let flaming = arrival <= params.now && (params.now - arrival) < model.residenceTime;
  let intensity = select(0.0, params.reactionIntensity * model.residenceTime * ros, flaming);

  textureStore(intensityTex, coord, vec4<f32>(intensity, 0.0, 0.0, 0.0));
  atomicMax(&aggregates[AGG_MAX_INTENSITY_BITS], bitcast<u32>(max(intensity, 0.0)));

  if (!(arrival <= params.now)) {
    textureStore(stateTex, coord, vec4<u32>(STATE_UNBURNT, 0u, 0u, 0u));
    textureStore(consumedTex, coord, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let dt = params.now - arrival;

  // BURNT does not mean "combustion finished" — the coarse classes are still smouldering and
  // `consumed` keeps climbing. The enum is a lifecycle label for the renderer.
  let state = select(STATE_BURNT, STATE_BURNING, dt < model.residenceTime);
  textureStore(stateTex, coord, vec4<u32>(state, 0u, 0u, 0u));
  textureStore(consumedTex, coord, vec4<f32>(consumed_fraction(model, dt), 0.0, 0.0, 0.0));

  // Aggregates. Burnt area is a straight count; perimeter is the count of exposed cell edges,
  // debiased on the CPU by pi/4 (see PERIMETER_DEBIAS in fields.ts). Off-grid counts as
  // unburnt so a fire leaving the domain still reports a closed perimeter.
  atomicAdd(&aggregates[AGG_BURNT_CELLS], 1u);
  if (state == STATE_BURNING) {
    atomicAdd(&aggregates[AGG_FLAMING_X], gid.x);
    atomicAdd(&aggregates[AGG_FLAMING_Z], gid.y);
    atomicAdd(&aggregates[AGG_FLAMING_CELLS], 1u);
  }
  var edges = 0u;
  if (gid.x == 0u      || !has_arrived(coord + vec2<i32>(-1,  0))) { edges = edges + 1u; }
  if (gid.x == n - 1u  || !has_arrived(coord + vec2<i32>( 1,  0))) { edges = edges + 1u; }
  if (gid.y == 0u      || !has_arrived(coord + vec2<i32>( 0, -1))) { edges = edges + 1u; }
  if (gid.y == n - 1u  || !has_arrived(coord + vec2<i32>( 0,  1))) { edges = edges + 1u; }
  if (edges > 0u) { atomicAdd(&aggregates[AGG_PERIM_EDGES], edges); }
}
