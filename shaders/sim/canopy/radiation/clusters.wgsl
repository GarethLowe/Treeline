// WP 3.3 passes 1-3 — build the emitter cluster list the gather reads.
//
// Three entry points over one bind group:
//
//   scatter()   over the emitter sample list: bin into 16 m cells with u32 atomics.
//   compact()   over the 64x64x8 bin grid: emit every bin above the threshold as a cluster.
//   finalise()  one invocation: write the overflow catch-all and retune the threshold.
//
// Core WGSL has no float atomics (§6.8 pitfall 3) and `atomicAdd` WRAPS rather than
// saturating, so every scale here is chosen against a reasoned worst-case bin and the bound
// is asserted on the CLI by test/sim/canopy/radiation/emitters.test.ts. An overflow would
// not error — it would relocate a cluster and invent energy.
//
// Moments are taken about the BIN CENTRE, not the world origin. That is what keeps the
// operands inside u32; the centroid comes back by the parallel-axis theorem in decodeBin().
//
// src/sim/canopy/radiation/emitters.ts runs this same fixed-point arithmetic in TypeScript
// and is the oracle.

// pos.xyz world m, pos.w radiant power W; aux.x = RMS radius of this emitter about itself.
struct RadEmitter {
  pos: vec4f,
  aux: vec4f,
};

struct RadCluster {
  pos: vec4f,
  aux: vec4f,
};

struct ClusterParams {
  sampleCount: u32,
  // Bins weaker than this (in u32 power units) go to the overflow catch-all instead of
  // taking a slot. Retuned each step by finalise(); see there for why.
  minBinUnits: u32,
  _pad0: u32,
  _pad1: u32,
};

// Slots of `state`, which carries what has to survive between the three dispatches.
const ST_COUNT: u32 = 0u;      // clusters written by compact()
const ST_OVERFLOW: u32 = 1u;   // bins rejected by compact()
const ST_OV_POWER: u32 = 2u;   // their total power, >> OVERFLOW_POWER_SHIFT
const ST_THRESHOLD: u32 = 3u;  // minBinUnits for the NEXT step
const ST_SLOTS: u32 = 4u;

@group(0) @binding(0) var<uniform> params: ClusterParams;
@group(0) @binding(1) var<storage, read> samples: array<RadEmitter>;
@group(0) @binding(2) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> clusters: array<RadCluster>;
@group(0) @binding(4) var<storage, read_write> state: array<atomic<u32>>;

fn binCentre(key: u32) -> vec3f {
  let i = key % EMIT_NI;
  let j = (key / EMIT_NI) % EMIT_NJ;
  let k = key / (EMIT_NI * EMIT_NJ);
  return vec3f(
    EMIT_ORIGIN_X + (f32(i) + 0.5) * EMIT_CELL_M,
    EMIT_ORIGIN_Y + (f32(k) + 0.5) * EMIT_CELL_M,
    EMIT_ORIGIN_Z + (f32(j) + 0.5) * EMIT_CELL_M,
  );
}

fn posUnits(offsetM: f32) -> u32 {
  return u32((offsetM + POSITION_BIAS_M) * POSITION_FIXED_SCALE + 0.5);
}

// Five u32 slots -> one cluster. Mirrors decodeBin() in emitters.ts.
fn decodeBin(power: u32, mx: u32, my: u32, mz: u32, m2: u32, centre: vec3f) -> RadCluster {
  let inv = 1.0 / f32(power);
  let d = vec3f(
    f32(mx) * inv / POSITION_FIXED_SCALE - POSITION_BIAS_M,
    f32(my) * inv / POSITION_FIXED_SCALE - POSITION_BIAS_M,
    f32(mz) * inv / POSITION_FIXED_SCALE - POSITION_BIAS_M,
  );
  let a2 = f32(m2) * inv - dot(d, d);
  var c: RadCluster;
  c.pos = vec4f(centre + d, f32(power) / POWER_FIXED_SCALE);
  c.aux = vec4f(max(A2_MIN, a2), 0.0, 0.0, 0.0);
  return c;
}

@compute @workgroup_size(CLUSTER_WG, 1, 1)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.sampleCount) { return; }
  let e = samples[gid.x];
  let q = u32(min(e.pos.w * POWER_FIXED_SCALE, 4294967040.0) + 0.5);
  if (q == 0u) { return; }

  let g = vec3f(
    (e.pos.x - EMIT_ORIGIN_X) / EMIT_CELL_M,
    (e.pos.z - EMIT_ORIGIN_Z) / EMIT_CELL_M,
    (e.pos.y - EMIT_ORIGIN_Y) / EMIT_CELL_M,
  );
  if (any(g < vec3f(0.0)) || g.x >= EMIT_NI_F || g.y >= EMIT_NJ_F || g.z >= EMIT_NK_F) { return; }
  let key = u32(g.x) + u32(g.y) * EMIT_NI + u32(g.z) * EMIT_NI * EMIT_NJ;

  let d = e.pos.xyz - binCentre(key);
  let base = key * EMIT_SLOTS;
  atomicAdd(&bins[base + 0u], q);
  atomicAdd(&bins[base + 1u], q * posUnits(d.x));
  atomicAdd(&bins[base + 2u], q * posUnits(d.y));
  atomicAdd(&bins[base + 3u], q * posUnits(d.z));
  atomicAdd(&bins[base + 4u], q * u32(dot(d, d) + e.aux.x * e.aux.x + 0.5));
}

@compute @workgroup_size(CLUSTER_WG, 1, 1)
fn compact(@builtin(global_invocation_id) gid: vec3u) {
  let key = gid.x;
  if (key >= EMIT_GRID_CELLS) { return; }
  let base = key * EMIT_SLOTS;
  let power = atomicLoad(&bins[base + 0u]);
  if (power == 0u) { return; }

  // Reserve a slot only if this bin clears the threshold. Slots past the cap are simply not
  // written; finalise() clamps the count, so no invocation ever has to give a slot back.
  var slot = 0xffffffffu;
  if (power >= params.minBinUnits) {
    slot = atomicAdd(&state[ST_COUNT], 1u);
  }
  if (slot < EMIT_CLUSTER_CAP - 1u) {
    clusters[slot] = decodeBin(
      power,
      atomicLoad(&bins[base + 1u]),
      atomicLoad(&bins[base + 2u]),
      atomicLoad(&bins[base + 3u]),
      atomicLoad(&bins[base + 4u]),
      binCentre(key),
    );
    return;
  }

  // Overflow. We keep the POWER and nothing else: the catch-all is placed at the domain
  // centre with the domain's own second moment, i.e. "the rest of the fire, smeared over the
  // whole world". That is deliberately crude and it is the right crudeness — the threshold
  // controller guarantees these are the WEAKEST bins, and smearing them over 1 km makes them
  // a near-uniform ambient term that cannot masquerade as a nearby hot source. Accumulating
  // their centroid instead would need four more atomics with domain-sized moment arms, which
  // is exactly the arithmetic that wraps.
  atomicAdd(&state[ST_OVERFLOW], 1u);
  atomicAdd(&state[ST_OV_POWER], power >> OVERFLOW_POWER_SHIFT);
}

@compute @workgroup_size(1, 1, 1)
fn finalise() {
  let ov = atomicLoad(&state[ST_OVERFLOW]);
  var count = min(atomicLoad(&state[ST_COUNT]), EMIT_CLUSTER_CAP - 1u);
  let ovPower = atomicLoad(&state[ST_OV_POWER]);
  if (ov > 0u && ovPower > 0u) {
    var c: RadCluster;
    c.pos = vec4f(
      OVERFLOW_CENTRE,
      f32(ovPower) * f32(1u << OVERFLOW_POWER_SHIFT) / POWER_FIXED_SCALE,
    );
    c.aux = vec4f(OVERFLOW_A2, 0.0, 0.0, 0.0);
    clusters[count] = c;
    count = count + 1u;
  }
  atomicStore(&state[ST_COUNT], count);

  // Retune the threshold for the next step. One step of feedback at RAD_UPDATE_HZ converges
  // in well under a second. Without it the catch-all would swallow whichever bins happened
  // to be scanned last — arbitrary — instead of the weakest ones, which is what a lossy
  // aggregate should contain. Halving and doubling is deliberately coarse: this only has to
  // track the order of magnitude of a growing fire.
  var t = max(1u, atomicLoad(&state[ST_THRESHOLD]));
  if (ov > 0u) {
    t = t * 2u;
  } else if (count * 2u < EMIT_CLUSTER_CAP) {
    t = max(1u, t / 2u);
  }
  atomicStore(&state[ST_THRESHOLD], t);
}
