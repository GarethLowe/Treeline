// Near-field flames — WP 4.5. Spec §7.4.
//
// The surface solver knows exactly where the fire is flaming and how hard, and until now
// nothing drew it: the only thing on screen was WP 2.6's false-colour debug overlay, so a
// running fire read as a magenta stain on the ground.
//
// Two stages:
//
//   csGather — one thread per FLAME_STRIDE x FLAME_STRIDE block of surface cells. A block whose
//              centre cell is STATE_BURNING appends one billboard to `flameList`. Scanning at a
//              stride rather than per cell is the whole reason this is cheap: the surface grid
//              is 2048^2 = 4.2 M cells and a metre of ground does not need four flames on it.
//   vsFlame/fsFlame — instanced camera-facing quads, additively blended into the HDR target.
//
// **Nothing here is textured.** The shape is procedural and the colour comes from the
// blackbody LUT that `render/volumetrics/blackbody.ts` already builds and that is `validated`
// against CIE illuminant A — so a flame in this scene is the same physics as the glow the
// froxel march emits, not an art asset that happens to look similar.
//
// What it is NOT: a fluid simulation. The shape is noise, not vorticity, and each billboard is
// independent, so flames do not lean into each other or merge. §7.4's flame *sheet* is what
// the radiation package already models for heat transfer; this is the visible counterpart.

struct FlameU {
  viewProj    : mat4x4<f32>,
  // xyz = camera world position, w = time in seconds
  camera      : vec4<f32>,
  // x = domain size m, y = surface cells per axis, z = stride in cells, w = list capacity
  grid        : vec4<f32>,
  // x = wind dir x, y = wind dir z, z = wind speed m/s, w = flame temperature K
  wind        : vec4<f32>,
};

struct FlameInstance {
  // xy = world XZ of the billboard's base, z = flame length m, w = per-flame random phase
  packed  : vec4<f32>,
  // x = world Y of the billboard's base, yzw spare.
  //
  // Y is stored rather than looked up because the canopy gather emits flames at CROWN height,
  // where the terrain height texture is the wrong answer. Storing it for surface flames too
  // keeps one draw path for both and takes the height sample out of the vertex stage.
  packed2 : vec4<f32>,
};

// THREE GROUPS, and the split is forced rather than stylistic: WebGPU does not allow a
// read_write storage buffer to be visible to the vertex stage. The gather writes the list and
// the vertex stage reads it, so the same buffer is declared twice at different access modes
// and bound through different layouts. Each entry point only references its own, so a pipeline
// layout that omits the other group is still compatible.
//
//   group 0 — shared, every stage, nothing writable
//   group 1 — gather only, compute
//   group 2 — draw only, vertex

@group(0) @binding(0) var<uniform> flameU  : FlameU;
@group(0) @binding(1) var flameHeight    : texture_2d<f32>;
// The same blackbody chroma LUT the froxel march uses, rebuilt here rather than reached into
// the volumetrics pass for: it is 256 texels and sharing a private field across packages to
// save 4 KB is not a trade worth making.
@group(0) @binding(2) var flameLut       : texture_1d<f32>;
@group(0) @binding(3) var flameLutSamp   : sampler;

@group(1) @binding(0) var<storage, read_write> flameListRW : array<FlameInstance>;
@group(1) @binding(1) var<storage, read_write> flameCount  : atomic<u32>;
@group(1) @binding(2) var flameState     : texture_2d<u32>;
@group(1) @binding(3) var flameIntensity : texture_2d<f32>;
// Canopy billboards only, so `?debug` can tell "the canopy pass contributed nothing" from
// "the canopy pass never ran". Both look like surface-only flames on screen.
@group(1) @binding(4) var<storage, read_write> flameCanopyCount : atomic<u32>;
// Fraction of the cell's fuel consumed, r8unorm. The gather only ever sees BURNING cells, so
// over a billboard's life this runs 0 -> 1 across the flaming residence time.
@group(1) @binding(5) var flameConsumed  : texture_2d<f32>;

@group(2) @binding(0) var<storage, read> flameListRO : array<FlameInstance>;

const STATE_BURNING : u32 = 1u;

/// Byram (1959). The same relation as `sim/rothermel/kernel.ts` and `foliage/burnShade.wgsl`;
/// `test/render/flames/flames.test.ts` pins all three to one another.
fn flameLengthM(intensityKwM : f32) -> f32 {
  if (intensityKwM <= 0.0) { return 0.0; }
  return 0.0775 * pow(intensityKwM, 0.46);
}

@compute @workgroup_size(8, 8)
fn csGather(@builtin(global_invocation_id) gid : vec3<u32>) {
  let stride = u32(flameU.grid.z);
  let cells = u32(flameU.grid.y);
  let blocks = cells / stride;
  if (gid.x >= blocks || gid.y >= blocks) { return; }

  let coord = vec2<i32>(vec2<u32>(gid.x * stride + stride / 2u, gid.y * stride + stride / 2u));
  if (textureLoad(flameState, coord, 0).r != STATE_BURNING) { return; }

  let intensity = textureLoad(flameIntensity, coord, 0).r;
  // Byram's L is the flame length of a STEADY front. A cell is not steady: it ignites, burns
  // through its residence time and dies, and the burning rate rises and falls with it. Read
  // straight, every billboard sprang to full height the instant its cell ignited and vanished
  // the instant it stopped, which is most of why a spreading fire read as "exploding out of
  // the ground" rather than growing.
  //
  // ponytail: the ENVELOPE's shape is a visual choice, not a sourced relation — Byram gives
  // the peak and nothing here gives the rise and fall. Fast growth over the first tenth of the
  // cell's fuel, full height through the body of the burn, fading away over the last half as
  // the fuel runs out. Upgrade path is the burning-rate curve `burnout.wgsl` already
  // integrates, if it is ever exposed per cell.
  let consumed = textureLoad(flameConsumed, coord, 0).r;
  let envelope = smoothstep(0.0, 0.10, consumed) * (1.0 - smoothstep(0.50, 1.0, consumed));
  let flameLen = flameLengthM(intensity) * envelope;
  // Below a few centimetres there is nothing to see and the billboard would be sub-pixel at
  // any sane distance. Skipping them keeps the list for flames that actually read.
  if (flameLen < 0.05) { return; }

  let slot = atomicAdd(&flameCount, 1u);
  // Overflow is DROPPED, not wrapped — wrapping would overwrite live flames with new ones and
  // produce a flickering subset with no indication anything was lost. `FlameRenderer.stats`
  // reports the count so a capped frame is visible rather than silently thinned.
  if (slot >= u32(flameU.grid.w)) { return; }

  let cellM = flameU.grid.x / f32(cells);
  let world = (vec2<f32>(coord) + vec2<f32>(0.5)) * cellM;
  // Phase from the cell index so a flame's flicker is stable frame to frame rather than
  // resampled every time the list is rebuilt in a different order.
  let h = hash2(gid.x, gid.y);
  let phase = rnd01(h) * 6.2831853;
  // Per-flame length variation. Byram's L is the MEAN flame length of the front, not the
  // height of every individual flame — a real fireline is ragged, and identical billboards
  // read as a row of candles. +/-40% about the mean keeps the mean where the physics put it.
  let vary = 0.6 + 0.8 * rnd01(hash2(gid.y, gid.x));
  flameListRW[slot].packed = vec4<f32>(world, flameLen * vary, phase);
  flameListRW[slot].packed2 =
    vec4<f32>(terrainHeightAt(flameHeight, world.x, world.y), 0.0, 0.0, 0.0);
}

// ---------------------------------------------------------------------------
// Canopy gather — the crowning fire
// ---------------------------------------------------------------------------

// Until this existed the canopy could reach 90 % crown fraction burned and the scene still
// showed a ground fire: M3 solved crown combustion and nothing drew it.
//
// One billboard per FLAMING voxel, appended to the same list the surface gather writes, so
// there is one draw, one additive blend and no chance of double-brightening where a crown
// flame overlaps a surface one — which is WP 4.5's stated acceptance criterion.
//
// Dispatched over COLUMNS, not slots: a column knows its own zStart and run length, so the
// voxel's (i, j, k) falls out of the loop index and no slot-to-column map is needed here.
//
// ponytail: flame SIZE is the voxel edge, not a solved flame length. Byram's relation is a
// surface-fire correlation over fireline intensity and there is no published equivalent per
// canopy voxel; inventing one would be a physical claim this cannot support. The voxel is the
// honest scale — upgrade path is a crown flame-length correlation if one is ever sourced.
@compute @workgroup_size(8, 8)
fn csGatherCanopy(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= CANOPY_NXY || gid.y >= CANOPY_NXY) { return; }
  let column = gid.y * CANOPY_NXY + gid.x;
  let col = canopyColumns[column];
  let zStart = col.header & CANOPY_Z_MASK;
  let zCount = (col.header >> CANOPY_ZCOUNT_SHIFT) & CANOPY_Z_MASK;

  for (var d = 0u; d < zCount; d = d + 1u) {
    let v = col.offset + d;
    if (canopy_phase(v) != CANOPY_PHASE_FLAMING) { continue; }
    // One billboard per flaming voxel is denser than a crown fire reads — reported from the
    // owner's own Chrome. Thinned by a stable hash of the voxel rather than by a lattice
    // stride: a stride puts the survivors on a grid and the eye finds it immediately, and
    // hashing the voxel identity keeps the SAME voxels drawn frame to frame, so thinning does
    // not turn into flicker. Tuning knob, not a physical quantity.
    if (rnd01(hash2(zStart + d, column + 977u)) > CROWN_FLAME_KEEP) { continue; }

    let slot = atomicAdd(&flameCount, 1u);
    if (slot >= u32(flameU.grid.w)) { return; }
    atomicAdd(&flameCanopyCount, 1u);

    let centre = canopy_voxel_centre(i32(gid.x), i32(gid.y), i32(zStart + d));
    let h = hash2(column, zStart + d);
    let phase = rnd01(h) * 6.2831853;
    let vary = 0.6 + 0.8 * rnd01(hash2(zStart + d, column));
    flameListRW[slot].packed = vec4<f32>(centre.x, centre.z, CANOPY_CELL * vary, phase);
    // Base at the voxel's underside, so the flame occupies the voxel rather than floating a
    // metre above it.
    //
    // Colour comes from the FLAME temperature, not `canopy_temperature(v)`. That field is the
    // solid temperature of the foliage; the flame sheet burning off it is §7.4's 1200 K
    // whatever the needles read, and colouring by the solid made crown fire render deep red
    // because below ~1500 K a Planckian falls outside the sRGB gamut and clamps.
    flameListRW[slot].packed2 = vec4<f32>(centre.y - CANOPY_CELL * 0.5, 0.0, 0.0, 0.0);
  }
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

struct FlameOut {
  @builtin(position) clipPos : vec4<f32>,
  // xy = quad uv (x across, y up), z = flame length, w = phase
  @location(0) uv     : vec4<f32>,
};

// Two triangles. Corner order gives x in {0,1} across and y in {0,1} up.
const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
);

@vertex
fn vsFlame(
  @builtin(vertex_index) vi : u32,
  @builtin(instance_index) ii : u32,
) -> FlameOut {
  let inst = flameListRO[ii].packed;
  let inst2 = flameListRO[ii].packed2;
  let base = vec2<f32>(inst.x, inst.y);
  let flameLen = inst.z;   // `length` is a WGSL builtin; shadowing it breaks length() below
  let phase = inst.w;

  let corner = CORNERS[vi];
  // The gather resolved this: terrain height for a surface flame, voxel underside for a
  // crown one. The vertex stage cannot tell them apart and does not need to.
  let groundY = inst2.x;

  // Billboard about the vertical axis only. A flame is not a sphere: it stands up, so the
  // quad must too, or it shears into the ground when the camera looks down at it.
  let toCam = flameU.camera.xz - base;
  let lenToCam = max(length(toCam), 1e-4);
  let right = vec2<f32>(-toCam.y, toCam.x) / lenToCam;

  // Width from length, so a 3 m flame is not a 3 m wide sheet. Real flames are much taller
  // than they are wide. Wide enough that neighbours at the gather stride overlap: a fireline
  // is continuous, and billboards that do not touch read as separate candles.
  let halfWidth = max(flameLen * 0.42, 0.45);

  // Lean downwind, growing with height. The tilt angle of a wind-driven flame is a real and
  // very visible thing — a vertical flame in a 5 m/s wind reads as a candle.
  let t = corner.y;
  let leanFrac = flameU.wind.z / (flameU.wind.z + 3.0);
  let lean = vec2<f32>(flameU.wind.x, flameU.wind.y) * (flameLen * 0.9 * leanFrac * t * t);

  let offset = right * ((corner.x - 0.5) * 2.0 * halfWidth);
  let world = vec3<f32>(
    base.x + offset.x + lean.x,
    groundY + flameLen * t,
    base.y + offset.y + lean.y,
  );

  var out : FlameOut;
  out.clipPos = flameU.viewProj * vec4<f32>(world, 1.0);
  out.uv = vec4<f32>(corner, flameLen, phase);
  return out;
}

/// Value noise on a 2D lattice, from the shared 32-bit hash. Cheap and adequate: the flame's
/// silhouette is doing the work, the noise only breaks up its edge.
fn vnoise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let h = vec4<f32>(
    rnd01(hash2(u32(i32(i.x)), u32(i32(i.y)))),
    rnd01(hash2(u32(i32(i.x) + 1), u32(i32(i.y)))),
    rnd01(hash2(u32(i32(i.x)), u32(i32(i.y) + 1))),
    rnd01(hash2(u32(i32(i.x) + 1), u32(i32(i.y) + 1))),
  );
  return mix(mix(h.x, h.y, u.x), mix(h.z, h.w, u.x), u.y);
}

@fragment
fn fsFlame(in : FlameOut) -> @location(0) vec4<f32> {
  let x = in.uv.x * 2.0 - 1.0;   // -1..1 across
  let t = in.uv.y;               // 0 at the base, 1 at the tip
  let phase = in.uv.w;
  let time = flameU.camera.w;

  // The silhouette is NOISE, not a curve. A single analytic taper — however well chosen —
  // reads as a geometric fin, because a real flame's outline is turbulent at every scale and
  // its top is not a point but a set of separating tongues.
  //
  // Two octaves, scrolling upward in time: the low one moves the whole body, the high one
  // breaks the edge. Both are scaled by height so the base stays planted on the fuel — a
  // flame is anchored where it is burning and only the tip is free to move.
  let n1 = vnoise(vec2<f32>(x * 1.7 + phase * 13.0, t * 2.2 - time * 2.2));
  let n2 = vnoise(vec2<f32>(x * 4.3 + phase * 29.0, t * 5.5 - time * 4.1));
  let wobble = ((n1 - 0.5) * 0.60 + (n2 - 0.5) * 0.30) * t;

  // Fuller through the lower body than a parabola, pinching hard only near the top.
  let taper = pow(max(1.0 - t, 0.0), 0.55);
  let radius = abs(x - wobble);
  var shape = clamp((taper - radius) / max(taper, 1e-3), 0.0, 1.0);

  // Dissolve upward, biased by the fine octave, so the flame separates into tongues near the
  // tip instead of ending on a clean point.
  let dissolve = smoothstep(0.10, 1.0, t) * (1.25 - n2 * 1.9);
  shape = clamp(shape - max(dissolve, 0.0), 0.0, 1.0);
  // Squared: optically thicker through the middle, so the edge fades rather than cutting.
  shape = shape * shape;
  if (shape <= 0.004) { discard; }

  // Temperature falls from the flame-sheet value at the base to well below it at the tip,
  // which is what makes the base white-yellow and the tip deep orange. The base value is
  // `DEFAULT_FLAME_TEMPERATURE_K` from `sim/canopy/radiation/optics.ts` (§7.4, sigma T^4 =
  // 117.6 kW m^-2 at 1200 K) — the same number the radiation package heats the canopy with,
  // passed in rather than repeated here. Surface and crown flames share it: both are flame
  // sheets, and the fuel they stand on being at a different temperature does not change what
  // the flame above it radiates.
  let tempK = mix(flameU.wind.w, flameU.wind.w * 0.62, t);
  let u = clamp((tempK - LUT_MIN_K) / (LUT_MAX_K - LUT_MIN_K), 0.0, 1.0);
  let chroma = textureSampleLevel(flameLut, flameLutSamp, u, 0.0).rgb;

  // PHYSICAL RADIANCE, as everything upstream of the tone mapper is. sigma T^4 / pi is the
  // emissive power of a black surface at this temperature turned into radiance; the LUT
  // carries chroma at unit luminance so the T^4 appears exactly once, which is the trap
  // `froxel.wgsl` documents at its own emission term.
  let power = SIGMA_SB * tempK * tempK * tempK * tempK * INV_PI;
  return vec4<f32>(chroma * power * shape, shape);
}
