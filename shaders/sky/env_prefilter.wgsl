// Prefiltered specular environment. Standalone — does NOT include sky_common.wgsl.
//
// Split-sum prefilter (Karis, "Real Shading in Unreal Engine 4", SIGGRAPH 2013 course notes):
// mip level m holds the GGX-convolved environment for roughness m / (mipCount - 1), so a
// shading pass samples the cube at a mip chosen from the material roughness and gets the
// specular term with one texture fetch.
//
// Approximations, stated rather than hidden:
//  - N = V = R. Standard for this technique; it drops the grazing-angle stretch of the GGX
//    lobe, which is the well-known limitation of split-sum prefiltering.
//  - Mip-biased source sampling by solid-angle ratio (Colbert & Krivanek) to keep the sample
//    count low without fireflies. The source is the full mip chain of the same cube.

@group(0) @binding(0) var srcCube : texture_cube<f32>;
@group(0) @binding(1) var srcSampler : sampler;
@group(0) @binding(2) var dst : texture_storage_2d_array<rgba16float, write>;

struct FilterParams {
  // x roughness, y destination face size (texels), z source face size (texels), w sample count
  params : vec4<f32>,
};
@group(0) @binding(3) var<uniform> filterParams : FilterParams;

const PI : f32 = 3.14159265359;

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

// Hammersley low-discrepancy sequence — deterministic, so the same solar state always produces
// the same environment. A stochastic sequence would make the specular probe shimmer between
// amortised updates.
fn radical_inverse_vdc(inBits : u32) -> f32 {
  var bits = inBits;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

fn hammersley(i : u32, n : u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(n), radical_inverse_vdc(i));
}

fn importance_sample_ggx(xi : vec2<f32>, n : vec3<f32>, roughness : f32) -> vec3<f32> {
  let a = roughness * roughness;
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));

  let h = vec3<f32>(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);

  var up = vec3<f32>(0.0, 0.0, 1.0);
  if (abs(n.z) >= 0.999) {
    up = vec3<f32>(1.0, 0.0, 0.0);
  }
  let tangentX = normalize(cross(up, n));
  let tangentY = cross(n, tangentX);
  return normalize(tangentX * h.x + tangentY * h.y + n * h.z);
}

fn distribution_ggx(nDotH : f32, roughness : f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

@compute @workgroup_size(8, 8, 1)
fn prefilter(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dstSize = u32(filterParams.params.y);
  if (gid.x >= dstSize || gid.y >= dstSize) {
    return;
  }
  let face = gid.z;
  let u = 2.0 * (f32(gid.x) + 0.5) / f32(dstSize) - 1.0;
  let v = 2.0 * (f32(gid.y) + 0.5) / f32(dstSize) - 1.0;
  let n = cube_direction(face, u, v);
  let roughness = filterParams.params.x;
  let sampleCount = u32(filterParams.params.w);

  if (roughness <= 0.0) {
    let L = textureSampleLevel(srcCube, srcSampler, n, 0.0).rgb;
    textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face), vec4<f32>(L, 1.0));
    return;
  }

  let srcSize = filterParams.params.z;
  let saTexel = 4.0 * PI / (6.0 * srcSize * srcSize);

  var colour = vec3<f32>(0.0);
  var weight = 0.0;
  for (var i : u32 = 0u; i < sampleCount; i = i + 1u) {
    let xi = hammersley(i, sampleCount);
    let h = importance_sample_ggx(xi, n, roughness);
    let l = normalize(2.0 * dot(n, h) * h - n);
    let nDotL = dot(n, l);
    if (nDotL <= 0.0) {
      continue;
    }
    let nDotH = max(dot(n, h), 0.0);
    let pdf = max(distribution_ggx(nDotH, roughness) * 0.25, 1e-8);
    let saSample = 1.0 / (f32(sampleCount) * pdf);
    let mip = max(0.5 * log2(saSample / saTexel), 0.0);
    colour += textureSampleLevel(srcCube, srcSampler, l, mip).rgb * nDotL;
    weight += nDotL;
  }

  let outColour = select(vec3<f32>(0.0), colour / weight, weight > 0.0);
  textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face), vec4<f32>(outColour, 1.0));
}
