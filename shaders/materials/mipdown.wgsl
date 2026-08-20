// Mip reduction for the material arrays. WP 1.6.
//
// Three reduction modes, because the three arrays hold three different KINDS of data and
// averaging them the same way is wrong in three different ways:
//
//  0 LINEAR   — ORM and the crack field. Plain 2x2 box average. Correct because a roughness
//               or an occlusion is a scalar with no transfer function attached.
//  1 SRGB     — albedo. DECODE each of the four samples to linear, average, RE-ENCODE. Alpha
//               bypasses the curve entirely. Averaging the stored sRGB bytes instead is the
//               single most common silent error in a PBR pipeline, and it is wrong in a
//               direction that reads as a feature: distant foliage comes out too dark, which
//               looks like aerial perspective. The error peaks where a downsample crosses a
//               high-contrast edge — a needle silhouette, i.e. every mid-distance foliage
//               texel in this project.
//  2 NORMAL   — decode to [-1,1], reconstruct Z, average as VECTORS, renormalise, re-encode.
//               Averaging the bytes without renormalising shortens the vector, which reads as
//               a roughness change with distance rather than as a normal-map bug.
//
// Source and destination are different mip levels of the SAME texture. Different mip levels
// are different subresources, so binding one as sampled and the other as writable storage in
// one pass is legal WebGPU; the views are created with mipLevelCount: 1 to make that explicit.

struct MipParams {
  // dstSize, layer, mode, srcMipRelative (always 0 — the src view is already based at the
  // level we read, so textureLoad's level argument is 0).
  dims : vec4<u32>,
}

@group(0) @binding(0) var srcTex : texture_2d_array<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> mipParams : MipParams;

const MIP_MODE_LINEAR: u32 = 0u;
const MIP_MODE_SRGB: u32 = 1u;
const MIP_MODE_NORMAL: u32 = 2u;

fn srgbToLinear1(c: f32) -> f32 {
  let x = clamp(c, 0.0, 1.0);
  if (x <= 0.04045) {
    return x / 12.92;
  }
  return pow((x + 0.055) / 1.055, 2.4);
}

fn linearToSrgbMip(c: f32) -> f32 {
  let x = clamp(c, 0.0, 1.0);
  if (x <= 0.0031308) {
    return x * 12.92;
  }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

@compute @workgroup_size(8, 8, 1)
fn mipDown(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dstSize = mipParams.dims.x;
  if (gid.x >= dstSize || gid.y >= dstSize) { return; }
  let layer = i32(mipParams.dims.y);
  let mode = mipParams.dims.z;

  let b = vec2<i32>(i32(gid.x) * 2, i32(gid.y) * 2);
  let s00 = textureLoad(srcTex, b + vec2<i32>(0, 0), layer, 0);
  let s10 = textureLoad(srcTex, b + vec2<i32>(1, 0), layer, 0);
  let s01 = textureLoad(srcTex, b + vec2<i32>(0, 1), layer, 0);
  let s11 = textureLoad(srcTex, b + vec2<i32>(1, 1), layer, 0);
  let dst = vec2<i32>(i32(gid.x), i32(gid.y));

  if (mode == MIP_MODE_SRGB) {
    // textureLoad on a plain rgba8unorm view returns the RAW STORED bytes, not sRGB-decoded
    // values — the decode is a property of the -srgb VIEW format, and this view is not one.
    // So the decode has to be explicit here. That is exactly the point: the mip chain is
    // built in linear space regardless of how the bytes are stored.
    var lin = vec3<f32>(0.0);
    lin = lin + vec3<f32>(srgbToLinear1(s00.r), srgbToLinear1(s00.g), srgbToLinear1(s00.b));
    lin = lin + vec3<f32>(srgbToLinear1(s10.r), srgbToLinear1(s10.g), srgbToLinear1(s10.b));
    lin = lin + vec3<f32>(srgbToLinear1(s01.r), srgbToLinear1(s01.g), srgbToLinear1(s01.b));
    lin = lin + vec3<f32>(srgbToLinear1(s11.r), srgbToLinear1(s11.g), srgbToLinear1(s11.b));
    lin = lin * 0.25;
    let a = (s00.a + s10.a + s01.a + s11.a) * 0.25;
    textureStore(dstTex, dst, layer, vec4<f32>(
      linearToSrgbMip(lin.x), linearToSrgbMip(lin.y), linearToSrgbMip(lin.z), a));
    return;
  }

  if (mode == MIP_MODE_NORMAL) {
    var n = vec3<f32>(0.0);
    var h = 0.0;
    var w = 0.0;
    // `var`, not `let`: WGSL only permits a dynamic index into an array that lives in
    // memory. A `let` array would need a const index and this loop does not have one.
    var samples = array<vec4<f32>, 4>(s00, s10, s01, s11);
    for (var i = 0; i < 4; i = i + 1) {
      let s = samples[i];
      let ex = s.r * 2.0 - 1.0;
      let ey = s.g * 2.0 - 1.0;
      let ez = sqrt(max(0.0, 1.0 - ex * ex - ey * ey));
      n = n + vec3<f32>(ex, ey, ez);
      h = h + s.b;
      w = w + s.a;
    }
    let len = length(n);
    // A perfectly opposed 2x2 (a knife-edge crease) sums to zero. Emitting a flat normal
    // there is correct: at this mip the crease is below the sampling rate.
    var unit = vec3<f32>(0.0, 0.0, 1.0);
    if (len > 1e-6) { unit = n / len; }
    textureStore(dstTex, dst, layer, vec4<f32>(
      clamp01f(unit.x * 0.5 + 0.5), clamp01f(unit.y * 0.5 + 0.5), clamp01f(h * 0.25),
      clamp01f(w * 0.25)));
    return;
  }

  textureStore(dstTex, dst, layer, (s00 + s10 + s01 + s11) * 0.25);
}
