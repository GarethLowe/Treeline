// WP 3.3 pass 3 — next-event-estimation irradiance gather. Spec §7.4.
//
// One workgroup per active brick (WP 3.1's brick list), 64 invocations = the brick's 4^3
// radiation cells at 4 m. Pure gather: no atomics, no sweep ordering, no ping-pong.
//
// Per invocation:
//   1. Scan the whole cluster list (<= EMIT_CLUSTER_CAP). Accumulate the unoccluded fluence
//      and its range moment, and keep the RAY_COUNT brightest in registers.
//   2. March Beer-Lambert transmittance to each of those, RAY_TAPS trilinear taps each.
//   3. Add the unmarched tail back at the marched set's mean transmittance, extrapolated
//      along the tail's longer mean path so it can only under-estimate.
//
// This mirrors `src/sim/canopy/radiation/gather.ts` line for line; that file is the oracle
// and carries the derivation and the error bounds.
//
// Cost shape (see test/sim/canopy/radiation/budget.test.ts): RAY_COUNT*RAY_TAPS trilinear 3D
// texture samples plus ~12 ALU per cluster. The extinction field is 4.19 MB and L2-resident,
// so this pass is TEXTURE-SAMPLER bound, not bandwidth bound — which is the §6.3 open
// question's ask, answered.

// pos.xyz = power-weighted centroid (world m), pos.w = radiant power (W).
// aux.x   = a^2, the power-weighted mean square spread (m^2) that softens the 1/r^2 pole.
// aux.yzw = unused; vec4 alignment makes the record 32 B either way.
struct RadCluster {
  pos: vec4f,
  aux: vec4f,
};

struct GatherParams {
  // Rays per receiver. Floored at MIN_RAY_COUNT by the quality controller (§6.7): below 8
  // the estimator's variance biases crown initiation early.
  rayCount: u32,
  brickCount: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: GatherParams;
@group(0) @binding(1) var<storage, read> clusters: array<RadCluster>;
// Indirection-grid index of each active brick, from WP 3.1.
@group(0) @binding(2) var<storage, read> brickList: array<u32>;
@group(0) @binding(3) var extinctionTex: texture_3d<f32>;
@group(0) @binding(4) var extinctionSamp: sampler;
// kW m^-2, not W m^-2: f16 tops out at 65504 and a flame sheet is 117600 W m^-2.
// Write-only: §7.4's alpha = 0.35 temporal blend is deliberately not implemented (see
// layout.ts), and a read_write storage texture is a non-core WGSL language feature anyway.
@group(0) @binding(5) var irradianceOut: texture_storage_3d<r16float, write>;
// clusters.wgsl's state buffer, read as plain u32 here. Slot ST_COUNT is how many clusters
// compact()/finalise() actually produced — read on the GPU so the scan loop is exactly as
// long as the fire is big, rather than always running to the cap.
@group(0) @binding(6) var<storage, read> clusterState: array<u32>;

// Trilinear sample of kappa at a world position. Clamp addressing; the field's top layer is
// air, so clamping above the canopy is the same as returning zero.
fn sampleKappa(p: vec3f) -> f32 {
  let uvw = (vec3f(p.x - RAD_ORIGIN_X, p.z - RAD_ORIGIN_Z, p.y - RAD_ORIGIN_Y) / RAD_CELL_M)
    / vec3f(RAD_NI_F, RAD_NJ_F, RAD_NK_F);
  return textureSampleLevel(extinctionTex, extinctionSamp, uvw, 0.0).r;
}

// Evenly spaced midpoint quadrature. Fixed trip count so the wavefront never diverges.
fn transmittance(a: vec3f, b: vec3f) -> f32 {
  let d = b - a;
  let len = length(d);
  if (len <= 0.0) { return 1.0; }
  var sum = 0.0;
  for (var n = 0u; n < RAY_TAPS; n = n + 1u) {
    let t = (f32(n) + 0.5) / RAY_TAPS_F;
    sum = sum + sampleKappa(a + d * t);
  }
  return exp(-sum * len / RAY_TAPS_F);
}

var<private> bestPhi: array<f32, MAX_RAY_COUNT>;
var<private> bestIdx: array<u32, MAX_RAY_COUNT>;

@compute @workgroup_size(GATHER_WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_index) lane: u32,
) {
  if (wg.x >= params.brickCount) { return; }

  // Brick -> its 4^3 radiation cells. The indirection index is (bi, bj, bk) over a
  // 64x64x8 grid of 16 m bricks; each brick is RAD_CELLS_PER_BRICK^3 cells of RAD_CELL_M.
  let brick = brickList[wg.x];
  let bi = brick % BRICK_NI;
  let bj = (brick / BRICK_NI) % BRICK_NJ;
  let bk = brick / (BRICK_NI * BRICK_NJ);
  let ci = bi * RAD_CELLS_PER_BRICK + (lane % RAD_CELLS_PER_BRICK);
  let cj = bj * RAD_CELLS_PER_BRICK + ((lane / RAD_CELLS_PER_BRICK) % RAD_CELLS_PER_BRICK);
  let ck = bk * RAD_CELLS_PER_BRICK + (lane / (RAD_CELLS_PER_BRICK * RAD_CELLS_PER_BRICK));
  if (ci >= RAD_NI || cj >= RAD_NJ || ck >= RAD_NK) { return; }

  // World centre of this receiving cell. i,j horizontal (x,z); k vertical (y).
  let p = vec3f(
    RAD_ORIGIN_X + (f32(ci) + 0.5) * RAD_CELL_M,
    RAD_ORIGIN_Y + (f32(ck) + 0.5) * RAD_CELL_M,
    RAD_ORIGIN_Z + (f32(cj) + 0.5) * RAD_CELL_M,
  );

  let rays = min(max(params.rayCount, MIN_RAY_COUNT), MAX_RAY_COUNT);
  for (var s = 0u; s < MAX_RAY_COUNT; s = s + 1u) {
    bestPhi[s] = 0.0;
    bestIdx[s] = 0xffffffffu;
  }

  var sumAll = 0.0;
  var sumAllR = 0.0;
  var minSlot = 0u;

  let count = min(clusterState[0], EMIT_CLUSTER_CAP);
  for (var c = 0u; c < count; c = c + 1u) {
    let cl = clusters[c];
    if (cl.pos.w <= 0.0) { continue; }
    let d = cl.pos.xyz - p;
    let r2 = dot(d, d);
    // Finite-emitter softening: r^2 -> r^2 + a^2. Loses flux at short range, never creates.
    let phi = cl.pos.w / (FOUR_PI * (r2 + cl.aux.x));
    sumAll = sumAll + phi;
    sumAllR = sumAllR + phi * sqrt(r2);
    if (phi > bestPhi[minSlot]) {
      bestPhi[minSlot] = phi;
      bestIdx[minSlot] = c;
      var mv = bestPhi[0];
      var ms = 0u;
      for (var s = 1u; s < rays; s = s + 1u) {
        if (bestPhi[s] < mv) { mv = bestPhi[s]; ms = s; }
      }
      minSlot = ms;
    }
  }

  var gTop = 0.0;
  var sumTop = 0.0;
  var sumTopR = 0.0;
  for (var s = 0u; s < rays; s = s + 1u) {
    let idx = bestIdx[s];
    if (idx == 0xffffffffu) { continue; }
    let cl = clusters[idx];
    let tau = transmittance(p, cl.pos.xyz);
    gTop = gTop + bestPhi[s] * tau;
    sumTop = sumTop + bestPhi[s];
    sumTopR = sumTopR + bestPhi[s] * length(cl.pos.xyz - p);
  }

  var g = gTop;
  let tailPhi = sumAll - sumTop;
  if (tailPhi > 0.0 && sumTop > 0.0) {
    let tauBar = min(1.0, gTop / sumTop);
    let rTop = sumTopR / sumTop;
    let rTail = (sumAllR - sumTopR) / tailPhi;
    let expo = select(1.0, max(1.0, rTail / rTop), rTop > 0.0);
    let tauTail = select(0.0, pow(tauBar, expo), tauBar > 0.0);
    g = g + tailPhi * tauTail;
  }

  textureStore(irradianceOut, vec3i(i32(ci), i32(cj), i32(ck)), vec4f(g * W_TO_KW, 0.0, 0.0, 0.0));
}
