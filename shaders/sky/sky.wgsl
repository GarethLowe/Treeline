// Full-screen sky pass. Prepend shaders/sky/sky_common.wgsl before compiling.
//
// One full-screen triangle, no vertex buffer, no depth write. The world-space ray is
// reconstructed from the inverse view-projection so the pass is independent of how the camera
// rig builds its matrices — it only needs the `invViewProjMatrix` the CameraState contract
// already publishes for the M4 froxel pass.

struct VsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) ndc : vec2<f32>,
};

@vertex
fn vs_sky(@builtin(vertex_index) vertexIndex : u32) -> VsOut {
  // Oversized triangle covering the viewport: (-1,-1), (3,-1), (-1,3).
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let p = corners[vertexIndex];
  var out : VsOut;
  out.position = vec4<f32>(p, 1.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs_sky(in : VsOut) -> @location(0) vec4<f32> {
  // z = 1 is the far plane in WebGPU's [0,1] clip range.
  let farPoint = sky.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let world = farPoint.xyz / farPoint.w;
  let dir = normalize(world - sky.camera.xyz);
  let L = environment_radiance(dir);
  return vec4<f32>(encode_output(L), 1.0);
}
