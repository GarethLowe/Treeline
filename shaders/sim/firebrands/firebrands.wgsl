// WP 3.6 — Lagrangian firebrand transport. Spec §40.
//
// TWO dispatches per solver step, not the eight of §4.2:
//
//   spawn_step  — 1 workgroup: count, exclusive scan, population control, ring allocation,
//                 brand emission, and the indirect args for the next pass. All of it.
//   integrate   — used-prefix/256 workgroups: substep loop, drag, burn, land, ignite.
//
// That collapse is the whole optimisation. §4.4's open question observes that this pass is not
// ALU- or bandwidth-bound — 100k fetches x 8 B is 0.8 MB against ~250 GB/s — and is instead
// dominated by per-dispatch and barrier overhead on browser WebGPU. So reducing the brand count
// or the fetch cost buys nothing, while fusing dispatches buys everything. There is no free
// list and no alive-compaction here for exactly that reason: they are six dispatches and two
// 0.5 MB buffers spent optimising a per-brand cost that does not dominate.
//
// Every physics function below has a line-for-line CPU twin in `src/sim/firebrands/brands.ts`,
// which is where correctness is actually proven. Keep them in step.

const PI = 3.14159265359;
const GRAVITY = 9.81;
const AIR_DENSITY = 1.2;
const AIR_VISCOSITY = 1.81e-5;
const BULK_DENSITY = 360.0;      // Petersen & Banerjee 2024 §II C: 360 +/- 9 kg/m3, pycnometry
const GLOW_MASS_FRACTION = 0.2;  // Ellis 2011: stringybark still ignites litter at ~20% of m0
const CHI_MOISTURE_COEFF = 3.0;  // estimated; chi(0) = 1 so the default dry path is unaffected
const TAU_MAX = 1e3;
const MAX_SUBSTEPS = 32u;
const MAX_SPAWN_PER_EMITTER = 65536u;

const FLAG_ALIVE = 1u;
const FLAG_FLAMING = 2u;

const SPAWN_WG = 256u;
const EMITTERS_PER_THREAD = 16u;   // SPAWN_WG * this = MAX_EMITTERS = 4096
const INTEGRATE_WG = 256u;

struct Brand {                   // 64 B, std430. layout.ts says why it is 64 and not §4.1's 48.
  pos      : vec3<f32>,          //  0  world m
  halfThk  : f32,                // 12  delta, m. HALF-thickness: sigma = k_shape * rho_p * delta
  vel      : vec3<f32>,          // 16  m/s
  massFrac : f32,                // 28  m/m0
  origin   : vec2<f32>,          // 32  spawn XY — the only way to report maxSpotDistanceM
  areaEq   : f32,                // 40  d_eq of the projected area, m
  weight   : f32,                // 44  super-particle multiplicity
  age      : f32,                // 48  s
  packed   : u32,                // 52  shape:4 | class:4 | biome:4 | flags:4 | rngSeed:16
  pad      : vec2<u32>,          // 56
}

struct BrandClass {              // 32 B
  halfThk    : f32,              // delta at spawn, m
  sigma      : f32,              // kg/m2 at spawn, precomputed CPU-side WITH the k_shape branch
  cd         : f32,              // referenced to the FULL projected area — see below
  beta0      : f32,              // delta0 / t_burnout
  areaMin    : f32,              // m2, power-law truncation
  areaMax    : f32,
  brandsPerKg: f32,
  shape      : f32,
}

struct Emitter {                 // 32 B
  pos         : vec3<f32>,
  massLossRate: f32,             // kg/s of the BRAND-PRODUCING component only, not the fuel bed
  classIndex  : f32,
  yieldMul    : f32,
  pad         : vec2<f32>,
}

struct SimState {
  cursor     : atomic<u32>,      // ring write cursor
  highWater  : atomic<u32>,      // slots ever touched; bounds the integrate dispatch
  weight     : atomic<u32>,      // current super-particle weight
  spawned    : atomic<u32>,
  airborne   : atomic<u32>,      // live SLOTS — what ring capacity is measured in
  airborneWt : atomic<u32>,      // live brands represented, i.e. sum of super-particle weights
  landed     : atomic<u32>,
  ignitions  : atomic<u32>,
  maxSpotMm  : atomic<u32>,      // atomicMax on a monotone u32 encoding — order-independent
  exited     : atomic<u32>,
}

struct Params {
  domainMin    : vec3<f32>,
  groundZ      : f32,
  domainSize   : vec3<f32>,
  windTop      : f32,            // height the velocity texture covers, m
  dt           : f32,
  subSteps     : u32,
  frameIndex   : u32,
  emitterCount : u32,
  // Ambient log profile: u(z) = (uStar/kappa) ln((z-d)/z0)
  uStar        : f32,
  z0           : f32,
  displ        : f32,
  windDirX     : f32,
  windDirY     : f32,
  // Receptor bed. Uniform for now; per-cell fields arrive with the surface solver's outputs.
  receptorMoisturePct : f32,
  receptorBulkDensity : f32,
  surfaceWind         : f32,
  // Logistic ignition coefficients (b0, b1 ln m, b2 M, b3 U, b4 rho_b, b5 flaming)
  b0 : f32, b1 : f32, b2 : f32, b3 : f32, b4 : f32, b5 : f32,
  brandMoisture : f32,
  maxWorkgroups : u32,           // maxComputeWorkgroupsPerDimension — the clamp below
  poolSize      : u32,
  surfaceCells  : u32,           // cells per side of the ignition bitmask
  surfaceCellM  : f32,
  pad0          : f32,
}

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var<storage, read_write> brands : array<Brand>;
@group(0) @binding(2) var<storage, read> classes : array<BrandClass>;
@group(0) @binding(3) var<storage, read> emitters : array<Emitter>;
@group(0) @binding(4) var<storage, read_write> state : SimState;
@group(0) @binding(6) var<storage, read_write> ignitionMask : array<atomic<u32>>;
@group(0) @binding(7) var windTex : texture_3d<f32>;
@group(0) @binding(8) var windSampler : sampler;

// Group 1 is spawn-only. Keeping the indirect args out of `integrate`'s pipeline layout means
// the buffer is never bound as writable storage during the very dispatch that reads it as
// indirect arguments — a usage conflict some implementations reject and none of them enjoy.
@group(1) @binding(0) var<storage, read_write> indirectArgs : array<u32, 3>;

// ---------------------------------------------------------------------------
// Counter-based RNG. Stateless and keyed on (slot, frame): reproducible across runs, which is
// the only way a spot-fire bug is ever debuggable. No RNG state buffer exists.
// ---------------------------------------------------------------------------

fn hash_u32(x: u32) -> u32 {
  let v = x * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash2(a: u32, b: u32) -> u32 { return hash_u32(a ^ hash_u32(b)); }
fn hash01(a: u32, b: u32) -> f32 { return f32(hash2(a, b)) * 2.3283064365386963e-10; }

// ---------------------------------------------------------------------------
// Fluid velocity: one 3D texture fetch inside the plume region, analytic everywhere else.
// ---------------------------------------------------------------------------

fn ambient_wind(z: f32) -> vec3<f32> {
  let zz = max(z - params.displ, params.z0 * 1.0001);
  let sp = (params.uStar / 0.41) * log(zz / params.z0);
  return vec3<f32>(sp * params.windDirX, sp * params.windDirY, 0.0);
}

fn fluid_velocity(pos: vec3<f32>) -> vec3<f32> {
  let amb = ambient_wind(pos.z - params.groundZ);
  let rel = (pos - params.domainMin) / params.domainSize;
  if (pos.z - params.groundZ > params.windTop
      || any(rel.xy < vec2<f32>(0.0)) || any(rel.xy > vec2<f32>(1.0))) {
    return amb;
  }
  let uvw = vec3<f32>(rel.xy, clamp((pos.z - params.groundZ) / params.windTop, 0.0, 1.0));
  // rgba16float, 128x128x64. Chosen over rgba8unorm deliberately: 8.4 MB is 0.1% of the VRAM
  // budget, it is one fetch either way, and unorm costs precision exactly in the low-speed
  // ambient field where brand drift is most sensitive to it. Per §0.5.1 this is not an
  // accuracy-for-speed trade at all, so there is nothing to trade away.
  let plume = textureSampleLevel(windTex, windSampler, uvw, 0.0).xyz;
  return amb + plume;
}

// ---------------------------------------------------------------------------
// One substep: exponential drag integrator + surface regression. §2.2, §2.4, §4.3.
// ---------------------------------------------------------------------------

fn one_minus_exp(h: f32) -> f32 {
  if (h < 1e-4) { return h * (1.0 - 0.5 * h); }
  return 1.0 - exp(-h);
}

fn terminal_velocity(sigma: f32, cd: f32) -> f32 {
  return sqrt(2.0 * sigma * GRAVITY / max(AIR_DENSITY * cd, 1e-9));
}

fn step_brand(b: ptr<function, Brand>, c: BrandClass, dt: f32) {
  let u = fluid_velocity((*b).pos);
  let rel = (*b).vel - u;
  let relSpeed = length(rel);
  let rhoAir = AIR_DENSITY;   // plume-temperature coupling arrives with WP 3.4's texture

  // sigma shrinks with delta, so v_t FALLS as the brand burns and a burning brand stays aloft
  // longer than a cold one of the same initial size. That coupling produces Sardoy's bimodal
  // ground distribution; expect it, do not treat it as a bug.
  let sigmaNow = c.sigma * max((*b).halfThk, 0.0) / max(c.halfThk, 1e-9);
  let tau = min(sigmaNow / max(0.5 * rhoAir * c.cd * max(relSpeed, 1e-6), 1e-12), TAU_MAX);
  let gEff = -GRAVITY * (1.0 - rhoAir / BULK_DENSITY);

  // v1 = u + g*tau + (v0 - u - g*tau) e^(-dt/tau);  x1 = x0 + (u + g*tau) dt + (...) tau (1-e).
  // Unconditionally stable, one exp, and the position uses the exact integral of that velocity
  // so the trajectory stays right at the solver's 0.1-0.5 s step rather than only at 1/60 s.
  let k = one_minus_exp(dt / tau);
  let e = 1.0 - k;
  let steady = vec3<f32>(u.x, u.y, u.z + gEff * tau);
  let d0 = (*b).vel - steady;
  (*b).pos = (*b).pos + steady * dt + d0 * (tau * k);
  (*b).vel = steady + d0 * e;

  // Ranz-Marshall-form enhancement, normalised at terminal velocity so beta0 comes straight
  // from a wind-tunnel burnout time measured at terminal velocity — no unmeasured constant.
  // Re_t uses the brand's CURRENT geometry, not its spawn geometry: normalising against a
  // frozen spawn Re_t drifts the enhancement below 1 as the brand shrinks and stretches burnout
  // ~40% past the published time, silently decalibrating beta0 = delta0/t_burnout.
  let re = rhoAir * relSpeed * (*b).areaEq / AIR_VISCOSITY;
  let reT = rhoAir * terminal_velocity(sigmaNow, c.cd) * (*b).areaEq / AIR_VISCOSITY;
  let chi = 1.0 / (1.0 + CHI_MOISTURE_COEFF * params.brandMoisture);
  let beta = c.beta0 * (1.0 + 0.3 * sqrt(max(re, 0.0))) / (1.0 + 0.3 * sqrt(max(reT, 0.0))) * chi;

  let thkNew = max((*b).halfThk - beta * dt, 0.0);
  let areaNew = max((*b).areaEq - 2.0 * beta * dt, 0.0);
  let rThk = select(0.0, thkNew / (*b).halfThk, (*b).halfThk > 0.0);
  let rArea = select(0.0, areaNew / (*b).areaEq, (*b).areaEq > 0.0);
  (*b).massFrac = (*b).massFrac * rThk * rArea * rArea;
  (*b).halfThk = thkNew;
  (*b).areaEq = areaNew;
  (*b).age = (*b).age + dt;
}

// ---------------------------------------------------------------------------
// Landing (§3)
// ---------------------------------------------------------------------------

fn ignition_probability(massKg: f32, flaming: bool) -> f32 {
  let lnM = log(max(massKg, 1e-9) * 1000.0);
  let z = params.b0
        + params.b1 * lnM
        + params.b2 * params.receptorMoisturePct
        + params.b3 * params.surfaceWind
        + params.b4 * params.receptorBulkDensity
        + params.b5 * select(0.0, 1.0, flaming);
  // Folded logistic: exp() of a large positive argument is inf in f32, and inf/inf is NaN.
  if (z >= 0.0) { return 1.0 / (1.0 + exp(-z)); }
  let ez = exp(z);
  return ez / (1.0 + ez);
}

fn record_ignition(pos: vec3<f32>) {
  let c = vec2<i32>(floor((pos.xy - params.domainMin.xy) / params.surfaceCellM));
  let n = i32(params.surfaceCells);
  if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) { return; }
  let bit = u32(c.y) * params.surfaceCells + u32(c.x);
  atomicOr(&ignitionMask[bit >> 5u], 1u << (bit & 31u));
  atomicAdd(&state.ignitions, 1u);
}

// ---------------------------------------------------------------------------
// Pass 1 — spawn. ONE workgroup, so count + scan + emission need no device-scoped sync.
// ---------------------------------------------------------------------------

var<workgroup> wgCounts : array<u32, SPAWN_WG>;
var<workgroup> wgScratch : array<u32, SPAWN_WG>;
var<workgroup> wgTotal : u32;
var<workgroup> wgBase : u32;

fn class_index(raw: f32) -> u32 {
  return min(u32(max(raw, 0.0)), arrayLength(&classes) - 1u);
}

fn emitter_count(ei: u32, weight: f32) -> u32 {
  let e = emitters[ei];
  let c = classes[class_index(e.classIndex)];
  // N_dot = mdot * (brands per kg) * yield; the fractional remainder is resolved stochastically
  // so a cell producing 0.3 brands per step is not silently truncated to zero — over a 2048^2
  // grid that rounding would delete most of the spotting.
  let expected = e.massLossRate * c.brandsPerKg * e.yieldMul * params.dt / max(weight, 1.0);
  if (!(expected > 0.0)) { return 0u; }
  let whole = floor(expected);
  let extra = select(0.0, 1.0, hash01(ei, params.frameIndex) < expected - whole);
  // Capped before the u32 conversion: an out-of-range float to u32 is implementation-defined,
  // and one bad mass-loss value would otherwise hand the scan a garbage total.
  return u32(min(whole + extra, f32(MAX_SPAWN_PER_EMITTER)));
}

fn emit(ei: u32, slot: u32, q: u32, weight: f32) {
  let e = emitters[ei];
  let ci = class_index(e.classIndex);
  let c = classes[ci];

  // Truncated power law of exponent -2 in PROJECTED AREA (Petersen & Banerjee 2024: the PDFs of
  // projected area, longest dimension and equivalent diameter all follow slope -2 over three
  // decades and have no defined mean or mode, so a delta at m-bar or a lognormal would invent a
  // scale the measurement says does not exist). Inverse CDF, one divide.
  let u01 = hash01(hash2(ei, q), params.frameIndex);
  let lo = 1.0 / max(c.areaMin, 1e-12);
  let hi = 1.0 / max(c.areaMax, 1e-12);
  let area = 1.0 / (lo - u01 * (lo - hi));

  var b : Brand;
  b.pos = e.pos;
  b.halfThk = c.halfThk;
  b.vel = fluid_velocity(e.pos);
  b.massFrac = 1.0;
  b.origin = e.pos.xy;
  b.areaEq = sqrt(4.0 * area / PI);
  b.weight = weight;
  b.age = 0.0;
  b.packed = (u32(c.shape) & 0xfu)
           | ((ci & 0xfu) << 4u)
           | (((FLAG_ALIVE | FLAG_FLAMING) & 0xfu) << 12u)
           | ((hash2(slot, params.frameIndex) & 0xffffu) << 16u);
  b.pad = vec2<u32>(0u, 0u);
  brands[slot] = b;
}

@compute @workgroup_size(SPAWN_WG)
fn spawn_step(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  // The weight used for counting MUST be the weight used for emission, or the scanned offsets
  // stop matching the emitted counts. Population control therefore updates the weight for the
  // NEXT step and truncates this one at capacity. One step of lag, fully deterministic.
  let weight = max(f32(atomicLoad(&state.weight)), 1.0);

  var mine = 0u;
  for (var j = 0u; j < EMITTERS_PER_THREAD; j = j + 1u) {
    let ei = t * EMITTERS_PER_THREAD + j;
    if (ei >= params.emitterCount) { break; }
    mine = mine + emitter_count(ei, weight);
  }
  wgCounts[t] = mine;
  workgroupBarrier();

  // Hillis-Steele inclusive scan in shared memory; double-buffered so no barrier is racing a
  // read against a write of the same slot.
  for (var off = 1u; off < SPAWN_WG; off = off << 1u) {
    var v = wgCounts[t];
    if (t >= off) { v = v + wgCounts[t - off]; }
    wgScratch[t] = v;
    workgroupBarrier();
    wgCounts[t] = wgScratch[t];
    workgroupBarrier();
  }
  let exclusive = wgCounts[t] - mine;

  if (t == SPAWN_WG - 1u) {
    let demand = wgCounts[t];
    let live = atomicLoad(&state.airborne);
    let capacity = select(params.poolSize - live, 0u, live >= params.poolSize);

    // §4.2 population control: we do not grow the pool and we do not drop the fire's brand flux
    // on the floor. Double the super-particle weight, halve the count, until it fits. Cost stays
    // flat and statistical resolution degrades gracefully — this is what keeps a Black Saturday
    // dense-spotting scenario from falling off a cliff.
    var w = u32(weight);
    var n = demand;
    for (var i = 0u; i < 24u && n > capacity; i = i + 1u) { w = w * 2u; n = n / 2u; }
    atomicStore(&state.weight, max(w, 1u));

    wgTotal = min(demand, capacity);
    wgBase = atomicLoad(&state.cursor);
    atomicStore(&state.cursor, (wgBase + wgTotal) % params.poolSize);
    atomicStore(&state.spawned, wgTotal);
    atomicMax(&state.highWater, min(wgBase + wgTotal, params.poolSize));

    // Indirect args for `integrate`. CLAMPED, and this is not defensive programming: WebGPU
    // §16.1.2 makes an over-large indirect workgroup count skip the ENTIRE dispatch, silently,
    // on the queue timeline — no error, no encode-time validation. Brands just stop moving.
    let slots = min(atomicLoad(&state.highWater), params.poolSize);
    let wg = (slots + INTEGRATE_WG - 1u) / INTEGRATE_WG;
    indirectArgs[0] = min(wg, max(params.maxWorkgroups, 1u));
    indirectArgs[1] = 1u;
    indirectArgs[2] = 1u;

    atomicStore(&state.airborne, 0u);   // integrate recounts both from scratch every step
    atomicStore(&state.airborneWt, 0u);
  }
  workgroupBarrier();

  // Emission. Each thread writes its own emitters' brands at its own scanned offset: no
  // contention, no allocation atomics, byte-identical across runs.
  var k = exclusive;
  for (var j = 0u; j < EMITTERS_PER_THREAD; j = j + 1u) {
    let ei = t * EMITTERS_PER_THREAD + j;
    if (ei >= params.emitterCount) { break; }
    let n = emitter_count(ei, weight);
    for (var q = 0u; q < n; q = q + 1u) {
      if (k >= wgTotal) { return; }
      emit(ei, (wgBase + k) % params.poolSize, q, weight);
      k = k + 1u;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — integrate, burn, land, ignite. One dispatch over the used prefix of the ring.
// ---------------------------------------------------------------------------

@compute @workgroup_size(INTEGRATE_WG)
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.poolSize || i >= arrayLength(&brands)) { return; }
  var b = brands[i];
  var flags = (b.packed >> 12u) & 0xfu;
  if ((flags & FLAG_ALIVE) == 0u) { return; }

  let ci = (b.packed >> 4u) & 0xfu;
  let c = classes[ci];

  let nSub = clamp(params.subSteps, 1u, MAX_SUBSTEPS);
  let dtSub = params.dt / f32(nSub);
  var landed = false;
  var killed = false;

  for (var s = 0u; s < nSub; s = s + 1u) {
    step_brand(&b, c, dtSub);
    if (b.pos.z <= params.groundZ) { landed = true; break; }
    let rel = (b.pos - params.domainMin) / params.domainSize;
    if (any(rel.xy < vec2<f32>(0.0)) || any(rel.xy > vec2<f32>(1.0))) { killed = true; break; }
    // §2.5: both conditions required. A brand failing either only feeds the ash/soot field.
    if (!(b.halfThk > 0.0 && b.massFrac > GLOW_MASS_FRACTION)) { killed = true; break; }
  }

  if (landed) {
    flags = flags & ~FLAG_ALIVE;
    atomicAdd(&state.landed, u32(max(b.weight, 1.0)));
    atomicMax(&state.maxSpotMm, u32(clamp(length(b.pos.xy - b.origin) * 1000.0, 0.0, 4.2e9)));
    if (b.halfThk > 0.0 && b.massFrac > GLOW_MASS_FRACTION) {
      let sigmaNow = c.sigma * b.halfThk / max(c.halfThk, 1e-9);
      let massKg = sigmaNow * (PI / 4.0) * b.areaEq * b.areaEq;
      let p = ignition_probability(massKg, (flags & FLAG_FLAMING) != 0u);
      if (hash01(i ^ 0x9e3779b9u, params.frameIndex) < p) { record_ignition(b.pos); }
    }
  } else if (killed) {
    // Exiting brands are counted, not wrapped: a toroidal domain would re-enter them behind the
    // fire and produce entirely spurious behaviour (§5). The CSV export logs their state so the
    // long-range flux stays measurable even though a 1 km domain cannot simulate it.
    flags = flags & ~FLAG_ALIVE;
    atomicAdd(&state.exited, 1u);
  } else {
    atomicAdd(&state.airborne, 1u);
    atomicAdd(&state.airborneWt, u32(max(b.weight, 1.0)));
  }

  b.packed = (b.packed & ~(0xfu << 12u)) | (flags << 12u);
  brands[i] = b;
}
