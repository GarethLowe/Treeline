// Front propagation on the 0.5 m surface grid — work package 2.3.
//
// Prepended by `src/sim/propagation/shaders.ts` with `ellipse.wgsl`.
//
// One bind group layout serves every kernel. Two bind groups are created from it, differing
// only in which φ buffer is `srcPhi` and which is `dstPhi`:
//
//   PREDICTOR   src = φⁿ     dst = work      φ⁽¹⁾ = φⁿ + Δt·L(φⁿ)
//   CORRECTOR   src = work   dst = φⁿ        φⁿ⁺¹ = ½φⁿ + ½(φ⁽¹⁾ + Δt·L(φ⁽¹⁾))
//
// Every other kernel uses the CORRECTOR group, where `dstPhi` is the real φ. That is the
// whole ping-pong: two pre-created bind groups, no per-frame bind group creation, and
// SSP-RK2 in two buffers instead of three (16.8 MB saved at 2048²).

struct Params {
  n: u32,
  tilesX: u32,
  tileCount: u32,
  maxWorkgroupsPerDim: u32,
  cellM: f32,
  invCell: f32,
  dt: f32,
  band: f32,
  igniteA: vec2f,
  igniteB: vec2f,
  igniteRadius: f32,
  igniteWidth: f32,
  igniteKind: u32,
  pad0: u32,
}

struct Control {
  tileCount: atomic<u32>,
  // Running total of cells the front has ever crossed. Accumulated incrementally because
  // the active set never sees the interior of an old burn, so it cannot be re-counted.
  burntCells: atomic<u32>,
  frontCells: atomic<u32>,
  overflow: u32,
  timeS: f32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  args: vec3u,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> srcPhi: array<f32>;
@group(0) @binding(2) var<storage, read_write> dstPhi: array<f32>;
@group(0) @binding(3) var<storage, read_write> tileMinAbs: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> tileList: array<u32>;
@group(0) @binding(5) var<storage, read_write> control: Control;
// Jump-flood nearest-crossing sites. Two halves, ping-ponged: [0, n²) and [n², 2n²).
// `x < 0` means "no site". Kept out of NaN so a stray read cannot poison a min.
@group(0) @binding(6) var<storage, read_write> sites: array<vec2f>;
// WP 2.2's per-cell cache: (R_head m/s, LB, headingX, headingY), rgba16float.
@group(0) @binding(7) var rosCache: texture_2d<f32>;
@group(0) @binding(8) var arrivalTex: texture_storage_2d<r32float, write>;
@group(0) @binding(9) var stateTex: texture_storage_2d<r8uint, write>;
// Normal rate of spread AT THE MOMENT OF ARRIVAL [m/s]. Byram's intensity is a property of
// the front as it passes, not of the cell afterwards, so the value has to be captured here —
// nothing downstream can reconstruct it once the front has moved on. WP 2.4 turns this into
// fireline intensity (I = I_R * t_r * R) and it is the only input it was still missing.
@group(0) @binding(10) var rosArrivalTex: texture_storage_2d<r16float, write>;

const TILE: u32 = 16u;
const CLASSIFY_WG: u32 = 64u;
const NO_SITE: vec2f = vec2f(-1.0, -1.0);
const INF_BITS: u32 = 0x7f800000u;

// Predictor = 0, corrector = 0.5. Set per pipeline; one entry point, two pipelines.
override BLEND: f32 = 0.0;
// Only the corrector records arrivals, state and the tile summary.
override RECORD: bool = false;
override JFA_JUMP: u32 = 1u;
override JFA_SRC_HALF: u32 = 0u;

fn cellIndex(i: u32, j: u32) -> u32 {
  return j * params.n + i;
}

fn clampIdx(v: i32) -> u32 {
  return u32(clamp(v, 0, i32(params.n) - 1));
}

// ---------------------------------------------------------------------------
// Per-substep bookkeeping
// ---------------------------------------------------------------------------

@compute @workgroup_size(1)
fn tick() {
  atomicStore(&control.tileCount, 0u);
  atomicStore(&control.frontCells, 0u);
  control.timeS = control.timeS + params.dt;
}

// ---------------------------------------------------------------------------
// Tile classification — spec §6.4
// ---------------------------------------------------------------------------

fn tileActive(tid: u32) -> bool {
  let tx = i32(tid % params.tilesX);
  let ty = i32(tid / params.tilesX);
  let tilesY = i32(params.tileCount / params.tilesX);
  let bandBits = bitcast<u32>(params.band);
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    let y = ty + dy;
    if (y < 0 || y >= tilesY) { continue; }
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let x = tx + dx;
      if (x < 0 || x >= i32(params.tilesX)) { continue; }
      // min|φ| is stored as the float's bit pattern, which orders identically to the value
      // for non-negative floats — so `atomicMin` on u32 is `min` on the float.
      if (atomicLoad(&tileMinAbs[u32(y) * params.tilesX + u32(x)]) <= bandBits) {
        return true;
      }
    }
  }
  return false;
}

// Per WebGPU §16.1.2 an indirect dispatch whose workgroup count exceeds
// `maxComputeWorkgroupsPerDimension` is SILENTLY SKIPPED IN ITS ENTIRETY — not clamped, not
// an error. So excess is folded into Y and, failing that, clamped with `overflow` raised so
// the HUD can say a substep was dropped rather than the fire simply stopping.
@compute @workgroup_size(1)
fn dispatchArgs() {
  let n = atomicLoad(&control.tileCount);
  let limit = max(params.maxWorkgroupsPerDim, 1u);
  var x = n;
  var y = 1u;
  var overflow = 0u;
  if (n == 0u) {
    x = 0u;
    y = 0u;
  } else if (n > limit) {
    x = limit;
    y = (n + limit - 1u) / limit;
    if (y > limit) {
      y = limit;
      overflow = 1u;
    }
  }
  control.args = vec3u(x, y, 1u);
  control.overflow = overflow;
}

// ---------------------------------------------------------------------------
// The advance
// ---------------------------------------------------------------------------

var<workgroup> tileMin: atomic<u32>;

// `slot` is workgroup-uniform, so this early-out keeps every barrier below in uniform
// control flow.
fn tileSlot(wg: vec3u) -> u32 {
  // The fold width comes from `control.args.x` — the value `dispatchArgs` wrote — rather
  // than from `@builtin(num_workgroups)`, which has to be emulated for indirect dispatch.
  // One load from a buffer that is bound anyway.
  return wg.x + wg.y * max(control.args.x, 1u);
}

@compute @workgroup_size(TILE, TILE)
fn advance(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(local_invocation_index) li: u32,
) {
  // NO EARLY RETURN. `slot` is derived from the workgroup id alone, so every invocation in
  // a workgroup shares it and `slot >= tileCount` is genuinely uniform at runtime — but
  // WGSL's uniformity analysis cannot prove that through an `atomicLoad`, and a `return`
  // here made both `workgroupBarrier()` calls below reject with "must only be called from
  // uniform control flow". That failed shader module invalidated every pipeline built from
  // it, so no fire could ever spread.
  //
  // Instead: every invocation runs to the end and reaches both barriers, the tile index is
  // clamped so out-of-range workgroups read valid memory, and every WRITE is guarded by
  // `inRange`. Out-of-range workgroups therefore do redundant arithmetic and store nothing.
  let slot = tileSlot(wg);
  let inRange = slot < atomicLoad(&control.tileCount);
  let tid = tileList[select(0u, slot, inRange)];
  let i = (tid % params.tilesX) * TILE + lid.x;
  let j = (tid / params.tilesX) * TILE + lid.y;

  // Barriers stay unconditional. `RECORD` is a pipeline-override constant and therefore
  // uniform, but an unconditional barrier costs nothing and keeps the uniformity analysis
  // out of the argument entirely.
  if (li == 0u) { atomicStore(&tileMin, INF_BITS); }
  workgroupBarrier();

  let k = cellIndex(i, j);
  let ii = i32(i);
  let jj = i32(j);
  let h = params.cellM;
  let inv = params.invCell;
  let inv2 = inv * inv;

  let c = srcPhi[k];
  let xm1 = srcPhi[cellIndex(clampIdx(ii - 1), j)];
  let xm2 = srcPhi[cellIndex(clampIdx(ii - 2), j)];
  let xp1 = srcPhi[cellIndex(clampIdx(ii + 1), j)];
  let xp2 = srcPhi[cellIndex(clampIdx(ii + 2), j)];
  let ym1 = srcPhi[cellIndex(i, clampIdx(jj - 1))];
  let ym2 = srcPhi[cellIndex(i, clampIdx(jj - 2))];
  let yp1 = srcPhi[cellIndex(i, clampIdx(jj + 1))];
  let yp2 = srcPhi[cellIndex(i, clampIdx(jj + 2))];

  // ENO2 one-sided gradients. First-order upwind alone leaves 5-8% axis/diagonal bias.
  let d2xm = (c - 2.0 * xm1 + xm2) * inv2;
  let d2xc = (xp1 - 2.0 * c + xm1) * inv2;
  let d2xp = (xp2 - 2.0 * xp1 + c) * inv2;
  let pxm = (c - xm1) * inv + 0.5 * h * minmod(d2xm, d2xc);
  let pxp = (xp1 - c) * inv - 0.5 * h * minmod(d2xc, d2xp);

  let d2ym = (c - 2.0 * ym1 + ym2) * inv2;
  let d2yc = (yp1 - 2.0 * c + ym1) * inv2;
  let d2yp = (yp2 - 2.0 * yp1 + c) * inv2;
  let pym = (c - ym1) * inv + 0.5 * h * minmod(d2ym, d2yc);
  let pyp = (yp1 - c) * inv - 0.5 * h * minmod(d2yc, d2yp);

  let cache = textureLoad(rosCache, vec2i(ii, jj), 0);
  let e = ellipseFromRates(cache.x, cache.y, cache.zw);

  // LOCAL Lax-Friedrichs: bound |dH/dp| over the reconstruction box, not over the whole
  // ellipse. With the ellipse-wide bound the viscosity at the backing edge is the HEAD rate,
  // which over-dissipates the backing fire by ~16% at LB = 2.
  var alpha = vec2f(0.0);
  for (var corner = 0u; corner < 4u; corner = corner + 1u) {
    let q = vec2f(select(pxm, pxp, (corner & 1u) != 0u), select(pym, pyp, (corner & 2u) != 0u));
    alpha = max(alpha, abs(hamiltonianGrad(q, e)));
  }

  let p = vec2f(0.5 * (pxm + pxp), 0.5 * (pym + pyp));
  let flux = hamiltonian(p, e) - 0.5 * dot(alpha, vec2f(pxp - pxm, pyp - pym));

  let advanced = c - params.dt * flux;
  let before = dstPhi[k];
  let next = BLEND * before + (1.0 - BLEND) * advanced;
  if (inRange) { dstPhi[k] = next; }

  if (RECORD && inRange) {
    if (before > 0.0 && next <= 0.0) {
      // One invocation per cell, so this write needs no atomic; the §6.4 `atomicMin`
      // discipline is for scatter-accumulation, and this is a gather.
      textureStore(arrivalTex, vec2i(ii, jj), vec4f(control.timeS, 0.0, 0.0, 0.0));
      textureStore(stateTex, vec2i(ii, jj), vec4u(1u, 0u, 0u, 0u));
      // H(p, e) is R_n * |grad phi|; phi is kept near a signed distance by the JFA reinit, so
      // dividing by |grad phi| recovers the normal rate even between reinitialisations. The
      // floor keeps a degenerate flat patch from producing an infinity.
      let rosN = hamiltonian(p, e) / max(length(p), 1e-3);
      textureStore(rosArrivalTex, vec2i(ii, jj), vec4f(max(rosN, 0.0), 0.0, 0.0, 0.0));
      atomicAdd(&control.burntCells, 1u);
    }
    if (abs(next) < 0.5 * h) { atomicAdd(&control.frontCells, 1u); }
    atomicMin(&tileMin, bitcast<u32>(abs(next)));
  }
  workgroupBarrier();
  if (RECORD && inRange && li == 0u) { atomicStore(&tileMinAbs[tid], atomicLoad(&tileMin)); }
}

// ---------------------------------------------------------------------------
// Ignition
// ---------------------------------------------------------------------------

fn distanceToSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let len2 = dot(ab, ab);
  let t = select(0.0, clamp(dot(p - a, ab) / len2, 0.0, 1.0), len2 > 0.0);
  return distance(p, a + t * ab);
}

fn ignitionDistance(p: vec2f) -> f32 {
  switch (params.igniteKind) {
    case 1u: { return distanceToSegment(p, params.igniteA, params.igniteB) - 0.5 * params.igniteWidth; }
    case 2u: { return abs(distance(p, params.igniteA) - params.igniteRadius) - 0.5 * params.igniteWidth; }
    default: { return distance(p, params.igniteA) - params.igniteRadius; }
  }
}

@compute @workgroup_size(CLASSIFY_WG)
fn igniteClear(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < params.tileCount) { atomicStore(&tileMinAbs[gid.x], INF_BITS); }
}

// Full-grid, because an ignition can land anywhere — including outside the current band,
// which is exactly the case (a firebrand spot fire) the active set must not be able to miss.
@compute @workgroup_size(TILE, TILE)
fn ignite(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.n || gid.y >= params.n) { return; }
  let k = cellIndex(gid.x, gid.y);
  let p = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) * params.cellM;
  let d = ignitionDistance(p);
  let before = dstPhi[k];
  let next = min(before, d);
  dstPhi[k] = next;
  srcPhi[k] = next;
  if (before > 0.0 && next <= 0.0) {
    textureStore(arrivalTex, vec2i(gid.xy), vec4f(control.timeS, 0.0, 0.0, 0.0));
    textureStore(stateTex, vec2i(gid.xy), vec4u(1u, 0u, 0u, 0u));
    // A stamped ignition has no front and therefore no normal rate. Seed with the local head
    // rate: it is the rate this cell would spread at, and it stops the ignition disc reading
    // as zero-intensity while everything around it burns.
    textureStore(rosArrivalTex, vec2i(gid.xy), vec4f(max(textureLoad(rosCache, vec2i(gid.xy), 0).x, 0.0), 0.0, 0.0, 0.0));
    atomicAdd(&control.burntCells, 1u);
  }
  let tid = (gid.y / TILE) * params.tilesX + (gid.x / TILE);
  atomicMin(&tileMinAbs[tid], bitcast<u32>(abs(next)));
}

// ---------------------------------------------------------------------------
// Jump-flood reinitialisation
// ---------------------------------------------------------------------------

@compute @workgroup_size(TILE, TILE)
fn jfaSeed(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let slot = tileSlot(wg);
  if (slot >= atomicLoad(&control.tileCount)) { return; }
  let tid = tileList[slot];
  let i = (tid % params.tilesX) * TILE + lid.x;
  let j = (tid / params.tilesX) * TILE + lid.y;
  let k = cellIndex(i, j);
  let p = (vec2f(f32(i), f32(j)) + 0.5) * params.cellM;
  let c = dstPhi[k];

  var best = 1e30;
  var site = NO_SITE;
  if (c == 0.0) {
    best = 0.0;
    site = p;
  } else {
    var offs = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
    for (var d = 0u; d < 4u; d = d + 1u) {
      let o = offs[d];
      let ni = i32(i) + o.x;
      let nj = i32(j) + o.y;
      if (ni < 0 || nj < 0 || ni >= i32(params.n) || nj >= i32(params.n)) { continue; }
      let other = dstPhi[cellIndex(u32(ni), u32(nj))];
      if ((c > 0.0) == (other > 0.0)) { continue; }
      // Sub-cell crossing. Seeding at cell centres instead would re-quantise the front to
      // the grid every reinitialisation and put back the bias the scheme exists to avoid.
      let t = c / (c - other);
      let dist = abs(t) * params.cellM;
      if (dist < best) {
        best = dist;
        site = p + t * vec2f(f32(o.x), f32(o.y)) * params.cellM;
      }
    }
  }
  sites[k] = site;
  sites[k + params.n * params.n] = site;
}

@compute @workgroup_size(TILE, TILE)
fn jfaFlood(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let slot = tileSlot(wg);
  if (slot >= atomicLoad(&control.tileCount)) { return; }
  let tid = tileList[slot];
  let i = (tid % params.tilesX) * TILE + lid.x;
  let j = (tid / params.tilesX) * TILE + lid.y;
  let k = cellIndex(i, j);
  let total = params.n * params.n;
  let srcBase = JFA_SRC_HALF * total;
  let dstBase = (1u - JFA_SRC_HALF) * total;
  let p = (vec2f(f32(i), f32(j)) + 0.5) * params.cellM;

  var site = sites[srcBase + k];
  var best = select(1e30, dot(p - site, p - site), site.x >= 0.0);
  let jump = i32(JFA_JUMP);
  for (var d = 0u; d < 9u; d = d + 1u) {
    if (d == 4u) { continue; }
    let ox = (i32(d % 3u) - 1) * jump;
    let oy = (i32(d / 3u) - 1) * jump;
    let ni = i32(i) + ox;
    let nj = i32(j) + oy;
    if (ni < 0 || nj < 0 || ni >= i32(params.n) || nj >= i32(params.n)) { continue; }
    let cand = sites[srcBase + cellIndex(u32(ni), u32(nj))];
    if (cand.x < 0.0) { continue; }
    let dd = dot(p - cand, p - cand);
    if (dd < best) {
      best = dd;
      site = cand;
    }
  }
  sites[dstBase + k] = site;
}

@compute @workgroup_size(TILE, TILE)
fn jfaResolve(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let slot = tileSlot(wg);
  if (slot >= atomicLoad(&control.tileCount)) { return; }
  let tid = tileList[slot];
  let i = (tid % params.tilesX) * TILE + lid.x;
  let j = (tid / params.tilesX) * TILE + lid.y;
  let k = cellIndex(i, j);
  let site = sites[k];
  if (site.x < 0.0) { return; }
  let p = (vec2f(f32(i), f32(j)) + 0.5) * params.cellM;
  let d = distance(p, site);
  let signed = select(d, -d, dstPhi[k] <= 0.0);
  dstPhi[k] = signed;
  atomicMin(&tileMinAbs[tid], bitcast<u32>(abs(signed)));
}
