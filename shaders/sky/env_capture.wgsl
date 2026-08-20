// Environment cube capture. Prepend shaders/sky/sky_common.wgsl before compiling.
//
// Writes one mip level of the environment cube (all six faces, z = 6 in the dispatch) by
// evaluating the same analytic sky the full-screen pass uses. A compute pass rather than six
// render passes: the cube is small (128^2 by default), one mip per dispatch keeps the per-frame
// cost amortised, and a storage texture write avoids six render pipelines and six attachment
// views.
//
// Coarser mips are evaluated analytically at their own resolution rather than box-downsampled
// from mip 0. For the smooth Perez lobes that is equivalent; for the moon disc and the star
// field it point-samples rather than area-averages, so those lose energy in the coarse mips.
// That only affects the roughest specular reflections of a night sky and it buys a whole
// downsample pipeline and pass, so it is a deliberate trade rather than an oversight.
//
// The destination is bound as a 2d-array view over the cube texture, which is how WebGPU
// exposes cube faces for storage access.

@group(1) @binding(0) var dst : texture_storage_2d_array<rgba16float, write>;

struct CaptureParams {
  // x: face size in texels for the mip being written, y,z,w: unused
  faceAndSize : vec4<u32>,
};
@group(1) @binding(1) var<uniform> capture : CaptureParams;

// Standard cube-face basis. u,v run -1..1 across the face; matches the WebGPU/D3D convention
// (+Y face's v runs toward +Z, and the -Y face mirrors it), so a cube sampled with a direction
// returns the texel this function wrote for that direction.
fn cube_direction(face : u32, u : f32, v : f32) -> vec3<f32> {
  switch face {
    case 0u: { return normalize(vec3<f32>( 1.0,  -v,  -u)); }
    case 1u: { return normalize(vec3<f32>(-1.0,  -v,   u)); }
    case 2u: { return normalize(vec3<f32>(   u, 1.0,   v)); }
    case 3u: { return normalize(vec3<f32>(   u,-1.0,  -v)); }
    case 4u: { return normalize(vec3<f32>(   u,  -v, 1.0)); }
    default: { return normalize(vec3<f32>(  -u,  -v,-1.0)); }
  }
}

// All six faces are written by one dispatch (z = 6), one mip level per dispatch.
@compute @workgroup_size(8, 8, 1)
fn capture_face(@builtin(global_invocation_id) gid : vec3<u32>) {
  let size = capture.faceAndSize.x;
  if (gid.x >= size || gid.y >= size) {
    return;
  }
  let face = gid.z;
  let u = 2.0 * (f32(gid.x) + 0.5) / f32(size) - 1.0;
  let v = 2.0 * (f32(gid.y) + 0.5) / f32(size) - 1.0;
  let dir = cube_direction(face, u, v);

  // The environment cube stores LINEAR RADIANCE, never a tone-mapped value: it is consumed by
  // the PBR pass as a physical quantity. Tone mapping happens once, at the end of the frame.
  // The solar disc is excluded — see environment_radiance_ex — and the result is clamped well
  // inside the f16 range so a bright moon or a horizon glare spike cannot produce an Inf that
  // then propagates through the whole prefilter chain.
  let L = min(environment_radiance_ex(dir, false), vec3<f32>(60000.0));

  textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face), vec4<f32>(L, 1.0));
}
