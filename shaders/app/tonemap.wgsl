// HDR resolve — src/app.
//
// Everything before this point is physical: WP 1.7's sky emits spectral radiance in
// W/(m^2 sr) and the terrain and foliage passes emit albedo/pi * irradiance in the same
// units. That is deliberate (it is what lets M4's blackbody flame colour composite against
// the sky without a fudge factor) and it means the HDR target spans roughly thirteen orders
// of magnitude between a moonless night and the solar disc. This pass is the only place that
// maps that onto a display.
//
// Three jobs, in order:
//   1. exposure       — a single scalar from src/app/exposure.ts, computed analytically from
//                       the solar state rather than from a histogram readback.
//   2. tone curve     — the ACES fitting curve (Narkowicz 2015). A filmic shoulder matters
//                       here specifically because the sun disc is ~1e7 and a linear clip
//                       would give the sky a hard white edge with a visible contour.
//   3. sRGB encode    — the swapchain is the preferred canvas format, which is bgra8unorm
//                       (NOT -srgb), so the transfer function is applied here. Doing it in
//                       the shader rather than via an -srgb view keeps WP 1.1's canvas
//                       configuration untouched.
//
// Also the guard rail for non-finite values. rgba16float saturates at 65504 and the solar
// disc radiance exceeds that, so Inf reaches this pass legitimately; NaN reaching it does
// not, but if it ever does the screen should go magenta rather than black, because "black"
// is indistinguishable from twenty other failures and magenta is not.

struct ResolveUniforms {
  // x = exposure multiplier, y = 1 when the NaN guard should paint magenta, zw unused
  params : vec4<f32>,
}

@group(0) @binding(0) var<uniform> resolveU : ResolveUniforms;
@group(0) @binding(1) var hdrTex : texture_2d<f32>;
@group(0) @binding(2) var hdrSampler : sampler;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

// Fullscreen triangle. One primitive, no vertex buffer, no overdraw along the diagonal that
// a two-triangle quad has.
@vertex
fn vs_resolve(@builtin(vertex_index) vid : u32) -> VsOut {
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  var out : VsOut;
  out.clip = vec4<f32>(x, y, 0.0, 1.0);
  // Clip space y is up, texture v is down.
  out.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

// Narkowicz 2015, "ACES Filmic Tone Mapping Curve" — the widely used rational fit to the
// ACES RRT+ODT, not the full transform. Cheap, and its shoulder is the point.
fn acesFilmic(x : vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// IEC 61966-2-1.
fn linearToSrgb(c : vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_resolve(in : VsOut) -> @location(0) vec4<f32> {
  var hdr = textureSampleLevel(hdrTex, hdrSampler, in.uv, 0.0).rgb;

  // NaN is the only value that fails a self-comparison. Inf is legitimate here (the solar
  // disc overflows f16) and is handled by the clamp below.
  let isNan = hdr != hdr;
  if (any(isNan)) {
    if (resolveU.params.y > 0.5) {
      return vec4<f32>(1.0, 0.0, 1.0, 1.0);
    }
    hdr = select(hdr, vec3<f32>(0.0), isNan);
  }

  let exposed = clamp(hdr * resolveU.params.x, vec3<f32>(0.0), vec3<f32>(65504.0));
  return vec4<f32>(linearToSrgb(acesFilmic(exposed)), 1.0);
}
