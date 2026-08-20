// Group 0 is the frame block, identical for every pipeline in the foliage package — plus
// the helpers that read it.
//
// Split out of common.wgsl so that common.wgsl depends on nothing but the generated prelude.
// The sun-occlusion pass wants `TreeInstance` and `terrainHeightAt` from there and binds
// none of what the foliage pipelines bind; before the split it inherited a `frame` reference
// it had no uniform for, which is a compile error rather than a wrong picture, but only
// because WGSL happens to catch it.

@group(0) @binding(0) var<uniform> frame: FrameUniform;

// ---------------------------------------------------------------------------
// Culling — mirrors cullMath.ts
// ---------------------------------------------------------------------------

fn sphereInFrustum(centre: vec3<f32>, radius: f32) -> bool {
  for (var i = 0u; i < 6u; i = i + 1u) {
    let p = frame.frustum[i];
    if (dot(p.xyz, centre) + p.w < -radius) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Wind — M1 synthetic field
// ---------------------------------------------------------------------------

// A travelling gust wave plus a slower envelope. This is NOT the fire meteorology model:
// WP 5.4 replaces it with the terrain-modified mass-consistent field. It is driven entirely
// from the wind uniform so that handover is a buffer write, not a shader change.
fn windDisplacement(worldXZ: vec2<f32>, phase: f32) -> vec2<f32> {
  let lenDir = length(frame.windDir);
  let dir = select(vec2<f32>(0.0, 1.0), frame.windDir / max(lenDir, 1e-6), lenDir > 1e-6);
  let k = 0.35; // rad/m — about an 18 m gust wavelength
  let travel = dot(worldXZ, dir) * k - frame.timeSec * frame.windSpeed * k + phase;
  let gust = 1.0 + frame.gustiness * sin(travel * 0.35 + frame.timeSec * 0.7);
  // Saturating in speed: displacement cannot grow without bound as wind rises.
  let amp = frame.windSpeed / (frame.windSpeed + 4.0);
  return dir * amp * gust * (0.6 + 0.4 * sin(travel));
}

