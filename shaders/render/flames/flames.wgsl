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
  packed : vec4<f32>,
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
  let flameLen = flameLengthM(intensity);
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
  let base = vec2<f32>(inst.x, inst.y);
  let flameLen = inst.z;   // `length` is a WGSL builtin; shadowing it breaks length() below
  let phase = inst.w;

  let corner = CORNERS[vi];
  let groundY = terrainHeightAt(flameHeight, base.x, base.y);

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
  // passed in rather than repeated here.
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
