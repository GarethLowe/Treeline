// Advected smoke field — WP 4.1. Spec §6.1 (grid choice) and §7.1.2 (what the renderer reads).
//
// 256 x 256 x 64 at 4 m horizontal / 2 m vertical, rgba16float, ping-ponged. §6.1 chose this
// over the 2 m canopy lattice deliberately: 512^2 x 64 is 128 MiB per copy and 4x the
// bandwidth, and the froxel raymarcher reconstructs sub-4 m structure with curl noise, which is
// "visually superior per byte to a 2 m advected field that is itself numerically diffused".
//
// ## Channels
//
//   R  excess gas temperature over ambient, K
//   G  total dry smoke PM mass concentration, kg m^-3   <- rho_s in §7.1.2
//   B  elemental-carbon mass concentration, kg m^-3
//   A  unused
//
// **B is a mass, not the ratio f.** §7.1.2's implementation trap is that omega_0 must never be
// mass-averaged because it is a ratio; the same holds one level up for f the moment two parcels
// of different composition mix. Two extensive quantities advect correctly under any transport
// scheme, their quotient does not, so f = B/G is formed at sample time and never stored.
//
// ## The vertical axis is height above ground
//
// Same convention as WP 3.1's voxel store and the radiation grid — see the header of
// `emit_surface.wgsl` for what happens when a field disagrees. 64 levels x 2 m = 128 m AGL.
//
// ## No pressure projection
//
// Spec §6.4: the field is advected by the terrain-modified wind plus the parameterised buoyant
// vertical velocity from WP 3.4's plume solve. A 256x256x64 Jacobi/multigrid pressure solve
// would cost more than the entire rest of the simulation. The stated consequence is that
// fire-induced indraft and the counter-rotating vortex pairs that drive fingering are NOT
// reproduced — absent by construction, not by accident.

struct SmokeParams {
  dt: f32,
  // Simulated clock, s. Used to age each surface cell's burnout curve.
  now: f32,
  // Ambient air temperature, K. The field stores EXCESS over this.
  ambientK: f32,
  // Surface grid, for the injection pass.
  surfaceCells: u32,

  surfaceCellM: f32,
  // Horizontal wind, m/s, world x and z. Constant until M5's field lands.
  windX: f32,
  windZ: f32,
  // Per-second fraction of mass removed: entrainment dilution plus deposition. Keeps a
  // long-running fire from filling the whole domain with an ever-thickening haze.
  decayPerS: f32,

  // Burnout model of the single domain-wide fuel, packed the same way `burnout.wgsl` reads it.
  invTau: vec4f,      // classes 0-3
  loadFrac: vec4f,    // classes 0-3
  invTau4: f32,       // class 4 (live woody)
  loadFrac4: f32,
  totalLoad: f32,     // kg m^-2
  residenceTime: f32, // s — the flaming/smouldering boundary

  // Emission constants from `emission.ts`, which is the oracle.
  yieldFlaming: f32,
  yieldSmouldering: f32,
  fFlaming: f32,
  fSmouldering: f32,

  heatOfCombustion: f32,
  convectiveFraction: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> sp: SmokeParams;
@group(0) @binding(1) var srcField: texture_3d<f32>;
@group(0) @binding(2) var dstField: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var fieldSamp: sampler;
// WP 2.4's fields. Arrival time ages the burnout curve; state gates on "has arrived".
@group(1) @binding(0) var arrivalTex: texture_2d<f32>;
@group(1) @binding(1) var stateTex: texture_2d<u32>;

const ARRIVAL_NEVER: f32 = 0x1.fffffep+127;
const STATE_UNBURNT: u32 = 0u;

/// Dispatch coordinate -> world position. `c.x` and `c.y` are the two HORIZONTAL axes and
/// `c.z` is the vertical one, matching the dispatch (NXZ, NXZ, NY), the bounds check, and the
/// `c.z == 0` injection test.
///
/// This originally read the axes in declaration order — x, y, z onto world x, height, z — which
/// swaps the vertical with the second horizontal axis. Every backtrace then sampled a cell
/// hundreds of metres sideways from where it should have, the plume velocity was evaluated at
/// the wrong height, and the field stayed pinned in the injection layer. Nothing errors: the
/// indices are all in range, just wrong.
fn cellCentre(c: vec3u) -> vec3f {
  return vec3f(
    (f32(c.x) + 0.5) * SMOKE_CELL_XZ,   // world x
    (f32(c.z) + 0.5) * SMOKE_CELL_Y,    // height above ground
    (f32(c.y) + 0.5) * SMOKE_CELL_XZ,   // world z
  );
}

/// World/AGL position -> normalised texture coordinate. x fastest, then z, then y: the texture
/// is addressed (i, k, j) with j vertical, matching the dispatch below.
fn fieldUvw(p: vec3f) -> vec3f {
  return vec3f(
    p.x / (SMOKE_NXZ_F * SMOKE_CELL_XZ),
    p.z / (SMOKE_NXZ_F * SMOKE_CELL_XZ),
    p.y / (SMOKE_NY_F * SMOKE_CELL_Y),
  );
}

fn sampleField(p: vec3f) -> vec4f {
  return textureSampleLevel(srcField, fieldSamp, fieldUvw(p), 0.0);
}

/// Mass loss rate of a surface cell `sinceArrival` seconds after the front passed, kg m^-2 s^-1.
/// The analytic derivative of the burnout curve WP 2.4 integrates — mirrors `massLossRate()`.
fn massLossRate(sinceArrival: f32) -> f32 {
  if (!(sinceArrival > 0.0)) { return 0.0; }
  var rate = 0.0;
  let load = sp.totalLoad;
  for (var c = 0u; c < 4u; c = c + 1u) {
    let it = sp.invTau[c];
    let lf = sp.loadFrac[c];
    if (it > 0.0 && lf > 0.0) {
      rate = rate + load * lf * it * exp(-it * sinceArrival);
    }
  }
  if (sp.invTau4 > 0.0 && sp.loadFrac4 > 0.0) {
    rate = rate + load * sp.loadFrac4 * sp.invTau4 * exp(-sp.invTau4 * sinceArrival);
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Advection, with injection folded in
// ---------------------------------------------------------------------------
//
// ONE pass, not two. Injecting in a separate pass would need to read and write the same
// texture: the source has to be added to the advected result, and a storage texture is
// write-only. Binding one texture as both sampled and write-storage inside a single usage
// scope is a validation error, and WebGPU answers a validation error by discarding the whole
// command buffer — the failure mode that has cost this project more time than any other.
//
// Folding the source into the advect invocation removes the aliasing entirely: every texel is
// written exactly once, by the invocation that owns it, from a sample of the OTHER buffer.
//
// Injection goes into the ground level only, and buoyancy carries it up. A 4 m column covers
// 8x8 surface cells at 0.5 m and all 64 are summed rather than sampled: the total emitted mass
// has to be right, and a thin advancing front is exactly where a sparse estimator is worst.
// Only the 65 536 ground-level invocations pay for that loop.

fn injectAt(column: vec2u) -> vec3f {
  let per = u32(SMOKE_CELL_XZ / sp.surfaceCellM);
  let base = vec2u(column.x * per, column.y * per);
  var massRate = 0.0;   // kg m^-2 s^-1, summed over sub-cells
  var ecRate = 0.0;
  var heatRate = 0.0;   // W m^-2

  for (var dy = 0u; dy < per; dy = dy + 1u) {
    for (var dx = 0u; dx < per; dx = dx + 1u) {
      let c = vec2i(i32(base.x + dx), i32(base.y + dy));
      if (u32(c.x) >= sp.surfaceCells || u32(c.y) >= sp.surfaceCells) { continue; }
      if (textureLoad(stateTex, c, 0).r == STATE_UNBURNT) { continue; }
      let arrival = textureLoad(arrivalTex, c, 0).r;
      if (!(arrival < ARRIVAL_NEVER) || arrival > sp.now) { continue; }

      let since = sp.now - arrival;
      let loss = massLossRate(since);
      if (!(loss > 0.0)) { continue; }
      // Flaming for the bed's residence time, smouldering after — the same boundary WP 2.4
      // uses to label the cell BURNING or BURNT, so the two cannot drift apart.
      let flaming = select(0.0, 1.0, since < sp.residenceTime);
      let y = mix(sp.yieldSmouldering, sp.yieldFlaming, flaming);
      let f = mix(sp.fSmouldering, sp.fFlaming, flaming);
      let total = loss * y;
      massRate = massRate + total;
      ecRate = ecRate + total * f;
      heatRate = heatRate + loss * sp.heatOfCombustion * sp.convectiveFraction;
    }
  }

  // The sums are over sub-cells of area (surfaceCellM^2) inside a column of area
  // (SMOKE_CELL_XZ^2), so dividing by the sub-cell count converts them back to a mean flux per
  // unit column area. Then per-area -> per-volume over the one receiving level.
  let areaFrac = 1.0 / f32(per * per);
  let inv = areaFrac / SMOKE_CELL_Y * sp.dt;
  const RHO_AIR: f32 = 1.2;
  const CP_AIR: f32 = 1005.0;
  return vec3f(
    heatRate * inv / (RHO_AIR * CP_AIR),   // K
    massRate * inv,                        // kg m^-3
    ecRate * inv,                          // kg m^-3
  );
}

@compute @workgroup_size(4, 4, 4)
fn advect(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= SMOKE_NXZ || gid.y >= SMOKE_NXZ || gid.z >= SMOKE_NY) { return; }
  let coord = vec3i(i32(gid.x), i32(gid.y), i32(gid.z));
  let p = cellCentre(gid);

  // Vertical velocity from WP 3.4's plume solve. Spec §6.4's "parameterised buoyant vertical
  // velocity" IS that LUT, so using anything else would put two different plumes in one
  // simulation.
  //
  // The CENTRELINE profile, scaled by how buoyant this parcel actually is, rather than
  // `plumeGasStateAtWorld`'s cross-plume Gaussian. That Gaussian is right for a canopy voxel
  // ("what gas is passing through me") and wrong here. It localises lift to a strip of
  // half-width b about ONE line through the flaming centroid, and b is about 2 m near the
  // ground while a smoke cell is 4 m wide -- so on a 4.7 ha fire, 549 of the 551 cells holding
  // smoke sat outside the strip, read w = 0, and the whole field stayed pinned in its
  // injection layer. The `?debug` probe has reported that as "injected but NOT LIFTED" for as
  // long as it has existed.
  //
  // A parcel as hot as the plume centreline rises like the centreline; one at ambient does not
  // rise at all. That ties lift to the buoyancy the field is already carrying, and it lofts the
  // whole burning area rather than one line across it.
  //
  // ponytail: this is a closure, not a second plume solve -- the rise velocity of a parcel is
  // taken from the solved profile at its height rather than integrated per column. The upgrade
  // path is a plume per active front once M5's wind field makes several fronts distinguishable.
  // Read the buoyancy UPSTREAM, which for a rising parcel is the cell below. Taking it from
  // this cell instead is circular and silently does nothing: an empty cell has no excess
  // temperature, so it computes zero rise velocity, so it never backtraces down into the smoke
  // underneath it, so it stays empty. The field then sits exactly where injection put it and
  // every diagnostic reads identically to having made no change at all.
  let prof = plumeCentrelineAt(p.y);
  let below = textureLoad(srcField, vec3i(coord.x, coord.y, max(coord.z - 1, 0)), 0);
  let here = textureLoad(srcField, coord, 0);
  let excess = max(here.r, below.r);
  let buoyantFraction = clamp(excess / max(prof.x, 1.0), 0.0, 1.0);
  let w = prof.y * buoyantFraction;

  let vel = vec3f(sp.windX, w, sp.windZ);
  var back = p - vel * sp.dt;
  // The floor is the ground: a trace below it samples the clamped edge and smears the
  // injection level upward into a permanent haze.
  back = clamp(
    back,
    vec3f(0.0),
    vec3f(SMOKE_NXZ_F * SMOKE_CELL_XZ, SMOKE_NY_F * SMOKE_CELL_Y, SMOKE_NXZ_F * SMOKE_CELL_XZ),
  );

  var v = sampleField(back);
  // Dilution by entrainment plus deposition; the temperature excess relaxes to ambient on the
  // same clock, which is what stops a stalled parcel staying hot forever.
  let keep = exp(-sp.decayPerS * sp.dt);
  var t = v.r * keep;
  var mass = v.g * keep;
  var ec = v.b * keep;

  if (gid.z == 0u) {
    let src = injectAt(gid.xy);
    t = t + src.x;
    mass = mass + src.y;
    ec = ec + src.z;
  }

  // f16 denormals are noise; below this there is no smoke worth carrying, and clearing the
  // EC mass with it keeps f = B/G from being formed out of two rounding errors.
  if (mass < 1e-9) {
    mass = 0.0;
    ec = 0.0;
  }
  textureStore(dstField, coord, vec4f(t, mass, ec, 0.0));
}

@compute @workgroup_size(4, 4, 4)
fn clearField(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= SMOKE_NXZ || gid.y >= SMOKE_NXZ || gid.z >= SMOKE_NY) { return; }
  textureStore(dstField, vec3i(i32(gid.x), i32(gid.y), i32(gid.z)), vec4f(0.0));
}
