// Per-instance burn memory. Spec §7.6(c).
//
// A tree that has burned stays burned, and that is not automatic. WP 2.4's consumed fraction
// IS monotonic by construction — §7.6(d) requires that ground can never un-burn — but char
// HEIGHT up a trunk is a function of flame length, and flame length is a function of the
// fireline intensity, which is instantaneous. Reading it directly would char a trunk as the
// front arrived and then un-char it as the front moved on.
//
// So each tree remembers the strongest fire it has ever stood in. `atomicMax` makes that
// order-free across the dispatch and monotonic by the operator rather than by convention.

struct BurnStateU {
  // x = domain size m, y = instance count, z/w unused
  params : vec4<f32>,
};

@group(0) @binding(0) var<uniform> bsU : BurnStateU;
@group(0) @binding(1) var<storage, read> bsInstances : array<TreeInstance>;
@group(0) @binding(2) var<storage, read_write> bsPeak : array<atomic<u32>>;
@group(0) @binding(3) var bsIntensity : texture_2d<f32>;

@compute @workgroup_size(64)
fn csBurnState(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u32(bsU.params.y)) { return; }

  let dims = vec2<i32>(textureDimensions(bsIntensity, 0));
  // 1x1 stand-in: no fire solver attached, so there is nothing to remember.
  if (dims.x <= 1) { return; }

  let inst = bsInstances[i];
  let uv = vec2<f32>(inst.posX, inst.posZ) / bsU.params.x * vec2<f32>(dims);
  let t = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(dims) - vec2<f32>(1.0)));
  let intensity = textureLoad(bsIntensity, t, 0).r;   // kW/m
  if (intensity <= 0.0) { return; }

  atomicMax(&bsPeak[i], u32(clamp(intensity * BURN_PEAK_SCALE, 0.0, 4.0e9)));
}
