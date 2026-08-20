// Sampling side of the sun-occlusion map. Included by every shader that lights something
// with the sun: terrain, tree cards, grass blades.
//
// `textureLoad` with a hand-rolled bilinear rather than a sampler, so adding this to a
// pipeline costs one binding instead of two and needs no filterable-format guarantee. The map
// is one texel per metre, so the interpolation is doing real work — nearest reads as visible
// 1 m stair-stepping along every shadow edge.

fn sunOcclusionTexel(tex: texture_2d<f32>, worldX: f32, worldZ: f32) -> vec2<f32> {
  let dims = vec2<i32>(textureDimensions(tex, 0));
  if (dims.x <= 1 || dims.y <= 1) { return vec2<f32>(1.0, 1.0); }
  let uv = vec2<f32>(worldX, worldZ) / DOMAIN_SIZE_M * vec2<f32>(dims) - vec2<f32>(0.5);
  let base = floor(uv);
  let frac = uv - base;
  let i0 = clamp(vec2<i32>(base), vec2<i32>(0), dims - vec2<i32>(1));
  let i1 = clamp(i0 + vec2<i32>(1), vec2<i32>(0), dims - vec2<i32>(1));
  let v00 = textureLoad(tex, vec2<i32>(i0.x, i0.y), 0).rg;
  let v10 = textureLoad(tex, vec2<i32>(i1.x, i0.y), 0).rg;
  let v01 = textureLoad(tex, vec2<i32>(i0.x, i1.y), 0).rg;
  let v11 = textureLoad(tex, vec2<i32>(i1.x, i1.y), 0).rg;
  return mix(mix(v00, v10, frac.x), mix(v01, v11, frac.x), frac.y);
}

/// Everything at ground level: crown shadows AND ridge shadows.
fn sunVisibilityAt(tex: texture_2d<f32>, worldX: f32, worldZ: f32) -> f32 {
  let v = sunOcclusionTexel(tex, worldX, worldZ);
  return v.x * v.y;
}

/// Ridge shadows only. For anything that is itself an occluder in the canopy layer — see the
/// channel note in sunOcclusion.wgsl.
fn ridgeVisibilityAt(tex: texture_2d<f32>, worldX: f32, worldZ: f32) -> f32 {
  return sunOcclusionTexel(tex, worldX, worldZ).y;
}
