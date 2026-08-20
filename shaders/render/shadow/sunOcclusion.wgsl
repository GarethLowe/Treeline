// Sun occlusion — Phase 3 rung 1. A top-down occlusion map over the whole domain, covering
// the two things whose absence flattens the image most: trees casting shade on the ground,
// and ridges shading the slopes behind them.
//
// ponytail: this is a soft top-down approximation, NOT a shadow map. It has no notion of a
// side-lit trunk, it cannot shadow one tree with another in the vertical, and everything it
// produces is a function of ground position alone. The upgrade path is real cascades; the
// reason not to start there is that cascades cost a depth pass over 2.4M triangles and this
// costs one dispatch over 36,700 instances, recomputed only when the sun actually moves.
//
// Two dispatches, because WebGPU storage textures do not support atomics:
//
//   csDiscs   — one thread per tree instance, atomicMax of the crown's opacity into a plain
//               storage buffer. atomicMax rather than atomicAdd so overlapping crowns are
//               deterministic and order-free: a closed canopy saturates at one crown's
//               opacity instead of compounding to black, which is the behaviour we want
//               anyway since the constant below already describes a *closed* canopy.
//   csResolve — one thread per texel: canopy opacity plus a ray-march of the height field
//               toward the sun.
//
// The two are written to SEPARATE CHANNELS and that is not a convenience. Ground and grass
// want both terms. A tree does not want the canopy term: its own crown is in the map, so
// multiplying a crown's own fragments by it would make every tree self-shadow to the canopy
// floor value. Trees take .g alone, so a stand in a ridge's shadow darkens and a stand in
// open sun does not.
//
//   .r = canopy visibility, .g = terrain visibility.
//
// rgba8unorm rather than r8unorm because r8unorm as a STORAGE format needs the optional
// `texture-formats-tier1` feature; rgba8unorm is core, so this works on any adapter.

struct SunOccU {
  // xyz = unit vector TOWARDS the sun. w = terrain march step count.
  sunToward : vec4<f32>,
  // x = domain size m, y = texels per axis, z = canopy opacity, w = terrain march reach m
  params    : vec4<f32>,
  // x = instance count
  counts    : vec4<u32>,
};

@group(0) @binding(0) var<uniform> occU : SunOccU;
@group(0) @binding(1) var<storage, read> occInstances : array<TreeInstance>;
@group(0) @binding(2) var<storage, read_write> occAccum : array<atomic<u32>>;
@group(0) @binding(3) var occHeightTex : texture_2d<f32>;
@group(0) @binding(4) var occOut : texture_storage_2d<rgba8unorm, write>;

// Fixed-point scale for the atomic. 16 bits is far more than an r8 output can carry.
const OCC_SCALE : f32 = 65535.0;

// Height of the crown's centre as a fraction of total tree height. Authored, not sourced:
// this is a rendering approximation, and the value only sets how far a shadow slides from
// its trunk. A conifer crown occupies roughly the top half, so its centre sits near 0.7 H.
const CROWN_CENTRE_FRACTION : f32 = 0.7;

// Tangent of the sun's angular radius (0.53 deg across). Grows the penumbra with distance
// from the occluder, which is the whole reason a distant shadow reads soft and a contact
// shadow reads sharp. Free — it is one multiply-add.
const SUN_TAN_RADIUS : f32 = 0.00465;

// A shadow cannot slide further than this from its own trunk. Bounds the splat loop: at a
// low sun the projection distance goes to infinity, and an unbounded loop on the GPU hangs
// the device rather than looking wrong.
const MAX_SHADOW_TRAVEL_M : f32 = 150.0;
const MAX_SPLAT_TEXELS : i32 = 128;

// Below this the sun is at the horizon: everything is in shadow and nothing casts one.
const MIN_SUN_Y : f32 = 0.02;

@compute @workgroup_size(64)
fn csDiscs(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= occU.counts.x) { return; }

  let s = occU.sunToward.xyz;
  if (s.y < MIN_SUN_Y) { return; }

  let inst = occInstances[i];
  let groundY = inst.posY;
  let height = inst.heightM;

  // `cullRadiusM` is hypot(height/2, crownRadius) — see stemCullRadius in sceneBuild.ts. That
  // is exactly invertible, so the crown's real radius is recoverable without widening the
  // instance record. Using the cull radius directly would oversize every shadow by the half
  // height of the tree, which for a 30 m conifer is 15 m of shadow that is not there.
  let halfH = height * 0.5;
  let crownR = sqrt(max(0.0, inst.cullRadiusM * inst.cullRadiusM - halfH * halfH));
  if (crownR <= 0.0) { return; }

  let crownY = groundY + height * CROWN_CENTRE_FRACTION;
  // Follow the light (-s) from the crown centre down to the trunk's own ground height. Using
  // the trunk's ground rather than the ground under the shadow is the approximation: on a
  // slope the shadow lands slightly off. Iterating for the true intersection costs a height
  // fetch per instance and moves the shadow by well under a texel on anything but a cliff.
  let travel = min((crownY - groundY) / s.y, MAX_SHADOW_TRAVEL_M);
  let centre = vec2<f32>(inst.posX, inst.posZ) - s.xz * travel;

  let radius = crownR + travel * SUN_TAN_RADIUS;
  let texels = occU.params.y;
  let mPerTexel = occU.params.x / texels;

  let lo = vec2<i32>(floor((centre - radius) / mPerTexel));
  let hi = vec2<i32>(ceil((centre + radius) / mPerTexel));
  let maxT = i32(texels) - 1;
  let x0 = clamp(lo.x, 0, maxT);
  let y0 = clamp(lo.y, 0, maxT);
  let x1 = clamp(min(hi.x, x0 + MAX_SPLAT_TEXELS), 0, maxT);
  let y1 = clamp(min(hi.y, y0 + MAX_SPLAT_TEXELS), 0, maxT);

  let opacity = occU.params.z;
  let inner = radius * 0.55;

  for (var y = y0; y <= y1; y = y + 1) {
    for (var x = x0; x <= x1; x = x + 1) {
      let p = (vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5)) * mPerTexel;
      let d = length(p - centre);
      if (d > radius) { continue; }
      // Solid to `inner`, feathering to nothing at the rim. A hard-edged disc reads as a
      // stamped circle from any angle; the feather is what makes it read as a crown.
      let a = opacity * smoothstep(radius, inner, d);
      let q = u32(clamp(a, 0.0, 1.0) * OCC_SCALE);
      atomicMax(&occAccum[u32(y) * u32(texels) + u32(x)], q);
    }
  }
}

/// Fraction of the sun visible from `p` after the terrain between here and it. 1 = open.
fn terrainVisibility(p : vec2<f32>) -> f32 {
  let s = occU.sunToward.xyz;
  let horiz = length(s.xz);
  // Sun directly overhead: nothing can be between this point and it.
  if (horiz < 1e-3) { return 1.0; }

  let dir = s.xz / horiz;
  let rise = s.y / horiz;              // metres of ray climb per metre travelled
  let h0 = terrainHeightAt(occHeightTex, p.x, p.y);
  let steps = i32(occU.sunToward.w);
  let reach = occU.params.w;
  let domain = occU.params.x;

  // Geometric step growth: near-field detail is what reads as a shadow edge, far-field is
  // ridges, which are large. 32 geometric steps reach as far as ~120 linear ones.
  let growth = 1.12;
  var d = 2.0;
  var stepM = 2.0;
  var shadow = 0.0;

  for (var i = 0; i < steps; i = i + 1) {
    if (d > reach) { break; }
    let q = p + dir * d;
    if (q.x < 0.0 || q.y < 0.0 || q.x > domain || q.y > domain) { break; }
    let h = terrainHeightAt(occHeightTex, q.x, q.y);
    let rayY = h0 + rise * d;
    // Soft over 3 m so a ridge line does not alias into a staircase at this resolution.
    shadow = max(shadow, smoothstep(0.0, 3.0, h - rayY));
    if (shadow >= 1.0) { break; }
    stepM = stepM * growth;
    d = d + stepM;
  }
  return 1.0 - shadow;
}

@compute @workgroup_size(8, 8)
fn csResolve(@builtin(global_invocation_id) gid : vec3<u32>) {
  let texels = u32(occU.params.y);
  if (gid.x >= texels || gid.y >= texels) { return; }

  let s = occU.sunToward.xyz;
  if (s.y < MIN_SUN_Y) {
    // Sun on or below the horizon. Everything is in shadow; the ambient term carries the
    // whole image, which is correct — that IS what twilight looks like.
    textureStore(occOut, vec2<i32>(gid.xy), vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let mPerTexel = occU.params.x / occU.params.y;
  let p = (vec2<f32>(vec2<u32>(gid.x, gid.y)) + vec2<f32>(0.5)) * mPerTexel;

  let canopy = 1.0 - f32(atomicLoad(&occAccum[gid.y * texels + gid.x])) / OCC_SCALE;
  textureStore(occOut, vec2<i32>(gid.xy), vec4<f32>(canopy, terrainVisibility(p), 0.0, 1.0));
}
