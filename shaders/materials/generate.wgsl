// Procedural material generation into the shared texture arrays. WP 1.6.
//
// Requires noise.wgsl and patterns.wgsl to be prepended (WGSL has no include mechanism; the
// composition happens in src/render/materials/shaders.ts).
//
// One dispatch per array layer, addressed by a dynamic uniform offset. 45 layers at 512^2 is
// 45 dispatches of 64x64 workgroups — a few milliseconds of GPU time, once, at world load.
//
// ## sRGB, which is the thing this file most easily gets wrong
//
// The albedo array is bound here as `rgba8unorm` STORAGE, because WebGPU has no sRGB storage
// format at all. So this shader performs the sRGB ENCODE itself, and the bytes it stores are
// encoded values. Consumers sample the same memory through an `rgba8unorm-srgb` view, and the
// hardware decodes for free. Skipping the encode here would leave linear values in a texture
// everyone decodes as sRGB — the classic double-darkening that looks like a lighting bug.
//
// The ALPHA channel is written LINEAR, deliberately, because the sRGB transfer function is
// defined on the three colour channels only and hardware sRGB formats leave alpha alone.

@group(0) @binding(0) var<uniform> gen : Pattern;
@group(0) @binding(1) var albedoOut : texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(2) var normalOut : texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(3) var ormOut    : texture_storage_2d_array<rgba8unorm, write>;

// IEC 61966-2-1, the piecewise curve with the 12.92 linear segment — NOT the gamma-2.2
// approximation. The two differ by ~1% in the midtones and by much more near black, and
// near-black is exactly where char and ash live in this project.
fn linearToSrgb1(c: f32) -> f32 {
  let x = clamp(c, 0.0, 1.0);
  if (x <= 0.0031308) {
    return x * 12.92;
  }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

fn linearToSrgb3(c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(linearToSrgb1(c.x), linearToSrgb1(c.y), linearToSrgb1(c.z));
}

@compute @workgroup_size(8, 8, 1)
fn generateLayer(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = gen.kindStageSizeSS.z;
  if (gid.x >= size || gid.y >= size) { return; }

  let stage = gen.kindStageSizeSS.y;
  let layer = gen.cellsLayerFlags.z;
  let ss = max(1u, gen.kindStageSizeSS.w);
  let texel = 1.0 / f32(size);
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // --- shade, supersampled, accumulated in LINEAR space ---
  //
  // Procedural patterns are analytically infinite-frequency (a Worley boundary is a step), so
  // point-sampling mip 0 aliases visibly. Averaging in linear space is what makes the result
  // correct rather than merely softer.
  var albedoAcc = vec3<f32>(0.0);
  var alphaAcc = 0.0;
  var occAcc = 0.0;
  var roughAcc = 0.0;
  var metalAcc = 0.0;
  var detailAcc = 0.0;
  for (var sy = 0u; sy < ss; sy = sy + 1u) {
    for (var sx = 0u; sx < ss; sx = sx + 1u) {
      let u = (f32(gid.x) + (f32(sx) + 0.5) / f32(ss)) * texel;
      let v = (f32(gid.y) + (f32(sy) + 0.5) / f32(ss)) * texel;
      let s = samplePattern(gen, u, v, stage);
      albedoAcc = albedoAcc + s.albedo;
      alphaAcc = alphaAcc + s.alpha;
      occAcc = occAcc + s.occlusion;
      roughAcc = roughAcc + s.roughness;
      metalAcc = metalAcc + s.metallic;
      detailAcc = detailAcc + s.detail;
    }
  }
  let inv = 1.0 / f32(ss * ss);
  let albedoLin = albedoAcc * inv;

  textureStore(albedoOut, coord, layer,
               vec4<f32>(linearToSrgb3(albedoLin), clamp01f(alphaAcc * inv)));

  // --- normal, from central differences on the height field ---
  //
  // NOT supersampled: central differencing at texel spacing already band-limits the height
  // field to the texel Nyquist, and supersampling on top of that would smooth twice and
  // flatten the relief.
  let dUV = texel;
  let dM = gen.reliefTileMetal.y * dUV;
  let u0 = (f32(gid.x) + 0.5) * texel;
  let v0 = (f32(gid.y) + 0.5) * texel;
  let hL = patternHeight(gen, u0 - dUV, v0, stage);
  let hR = patternHeight(gen, u0 + dUV, v0, stage);
  let hD = patternHeight(gen, u0, v0 - dUV, stage);
  let hU = patternHeight(gen, u0, v0 + dUV, stage);
  let hC = patternHeight(gen, u0, v0, stage);
  // Tangent-space normal of the surface z = h(x, y): n = normalize(-dh/dx, -dh/dy, 1).
  let nx = -(hR - hL) / (2.0 * dM);
  let ny = -(hU - hD) / (2.0 * dM);
  let invLen = inverseSqrt(nx * nx + ny * ny + 1.0);
  let relief = max(1e-9, gen.reliefTileMetal.x);
  textureStore(normalOut, coord, layer, vec4<f32>(
    clamp01f(nx * invLen * 0.5 + 0.5),
    clamp01f(ny * invLen * 0.5 + 0.5),
    // B carries height in units of this material's declared relief, so the shader recovers
    // metres by multiplying by reliefM from the material table.
    clamp01f(hC / relief),
    1.0));

  // R = occlusion, G = roughness, B = metallic, A = burn susceptibility.
  //
  // Susceptibility reuses the pattern's own mean-0.5 `detail` field, so the burn front breaks
  // up along the material's real features — bark furrows, leaf veins — rather than along an
  // unrelated noise field. That is what stops a charring trunk looking like it has a decal.
  textureStore(ormOut, coord, layer, vec4<f32>(
    clamp01f(occAcc * inv),
    clamp01f(roughAcc * inv),
    clamp01f(metalAcc * inv),
    clamp01f(detailAcc * inv)));
}
