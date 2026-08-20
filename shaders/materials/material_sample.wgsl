// The material bind group and its sampling interface. WP 1.6.
//
// This is the chunk that OTHER packages include. WGSL has no include mechanism, so it is
// exposed from TypeScript as `materialWgsl(matGroup, burnGroup)` in
// src/render/materials/shaders.ts, which substitutes the two group indices and returns source
// to string-prepend to a consumer shader. The group indices are parameters rather than
// constants precisely so that this package does not have to win an argument with WP 1.5 about
// who owns @group(1).
//
// ## What is bound
//
// One bind group serves the entire world — every tree, every blade of grass, every square
// metre of terrain. A foliage pass drawing 80 k instances across a dozen materials never
// rebinds, which is the whole reason materials are arrays rather than individual textures.
//
//   0  albedo array   sampled through an rgba8unorm-srgb view -> the shader receives LINEAR
//   1  normal array   rgba8unorm, LINEAR. RG = tangent normal XY, B = height, A = 1
//   2  ORM array      rgba8unorm, LINEAR. R = occlusion, G = roughness, B = metallic,
//                     A = burn susceptibility
//   3  crack field    rgba8unorm, LINEAR. R = D, G = cell id, B = dD/du, A = dD/dv
//   4  sampler        filtering, repeat, anisotropic
//   5  material table uniform: per-material factors and layer assignment
//
// The albedo view carries the sRGB transfer function, so `textureSample` on it returns linear
// values with no shader-side decode. Do NOT add one. Conversely the normal and ORM views are
// NOT sRGB and must never be given an -srgb view: pushing a roughness through a colour
// transfer function is wrong by up to 2.3x in the midtones and looks like a shading bug.
//
// ## Burn state
//
// Every sampling entry point takes a `BurnState`. M1 passes `burnStateUnburnt()` and gets the
// green layer; M4 passes simulation-driven values and gets a continuous green -> scorch ->
// char -> ash blend plus ember emission, with no change to this file, to the material format,
// or to the baked textures. That is the entire point of plumbing it now.

struct MaterialEntry {
  baseColorRough : vec4<f32>,   // baseColorFactor.rgb, roughnessFactor
  factors        : vec4<f32>,   // metallicFactor, tileSizeM, reliefM, alphaCutoff
  layers         : vec4<u32>,   // baseLayer, layerCount, flags, unused
}

struct MaterialTable {
  // crackTileSizeM, burnSusceptibilityStrength, unused, unused
  globals : vec4<f32>,
  entries : array<MaterialEntry, 64>,
}

const MAT_FLAG_BURNABLE: u32 = 1u;
const MAT_FLAG_ALPHA_TEST: u32 = 2u;
const MAT_FLAG_DOUBLE_SIDED: u32 = 4u;

@group(__MAT_GROUP__) @binding(0) var matAlbedo  : texture_2d_array<f32>;
@group(__MAT_GROUP__) @binding(1) var matNormal  : texture_2d_array<f32>;
@group(__MAT_GROUP__) @binding(2) var matOrm     : texture_2d_array<f32>;
@group(__MAT_GROUP__) @binding(3) var matCrack   : texture_2d<f32>;
@group(__MAT_GROUP__) @binding(4) var matSampler : sampler;
@group(__MAT_GROUP__) @binding(5) var<uniform> matTable : MaterialTable;

// ---------------------------------------------------------------------------
// Burn state
// ---------------------------------------------------------------------------

// Spec 7.6's four scalars. `charFrac` rather than `char` only because `char` is a reserved
// word in WGSL.
struct BurnState {
  scorch : f32,
  charFrac : f32,
  ash : f32,
  tempK : f32,
}

fn burnStateUnburnt() -> BurnState {
  return BurnState(0.0, 0.0, 0.0, 0.0);
}

// Spec 7.6: b = clamp(s + c + a, 0, 3).
fn burnCoordinate(b: BurnState) -> f32 {
  return clamp(clamp(b.scorch, 0.0, 1.0) + clamp(b.charFrac, 0.0, 1.0) + clamp(b.ash, 0.0, 1.0),
               0.0, 3.0);
}

// Unpack the 8-byte per-instance record written by packBurnState() in burn.ts.
// word.x = scorch | char<<8 | ash<<16 | flags<<24 ; word.y = tempK (u16) | reserved<<16.
fn unpackBurnState(word: vec2<u32>) -> BurnState {
  return BurnState(
    f32(word.x & 0xffu) / 255.0,
    f32((word.x >> 8u) & 0xffu) / 255.0,
    f32((word.x >> 16u) & 0xffu) / 255.0,
    f32(word.y & 0xffffu));
}

fn unpackBurnFlags(word: vec2<u32>) -> u32 {
  return (word.x >> 24u) & 0xffu;
}

// Bias the burn coordinate by the per-texel susceptibility in ORM.a.
//
// Without this an instance's whole surface flips from green to scorch at one instant, which
// reads as a material swap rather than as burning. With it, the material's raised, exposed
// structure goes first and the recesses lag, so the transition front follows the bark furrows
// and the leaf veins.
fn modulateBurnCoordinate(b: f32, susceptibility: f32, strength: f32) -> f32 {
  return clamp(b + strength * (clamp(susceptibility, 0.0, 1.0) - 0.5) * 2.0, 0.0, 3.0);
}

// ---------------------------------------------------------------------------
// Cracks and embers (spec 7.6)
// ---------------------------------------------------------------------------

// spec 7.6: m_crack = smoothstep(0.5 - 0.35c, 0.5, D).
//
// NOTE the sense: m_crack is 1 on the INTACT plate and 0 in the crack floor, which is why
// ember emission below is multiplied by (1 - m_crack) — the glow comes from the exposed hot
// interior at the bottom of the crack, not from the surface. At c = 0 the two edges coincide
// and the built-in smoothstep would be undefined, so this steps instead: an uncharred surface
// has no cracks and the mask is identically 1 above D = 0.5.
fn crackMask(distanceD: f32, charFraction: f32) -> f32 {
  let c = clamp(charFraction, 0.0, 1.0);
  let lo = 0.5 - 0.35 * c;
  if (0.5 - lo < 1e-5) {
    return select(0.0, 1.0, distanceD >= 0.5);
  }
  let t = clamp((distanceD - lo) / (0.5 - lo), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// spec 7.6: crack depth, 3 mm at full char.
fn crackDepthM(charFraction: f32) -> f32 {
  return 0.003 * clamp(charFraction, 0.0, 1.0);
}

const STEFAN_BOLTZMANN: f32 = 5.670374419e-8;
const CHAR_EMISSIVITY: f32 = 0.90;
const EMBER_MIN_TEMP_K: f32 = 700.0;

// spec 7.6: L_emit = eps * sigma * T^4 / pi.
//
// The /pi converts the Stefan-Boltzmann hemispherical exitance into the RADIANCE of a
// Lambertian emitter, which is what a shader adds to a radiance buffer. Dropping it is a
// 3.14x brightness error that is easily mistaken for a tone-mapping problem. Units are
// W m^-2 sr^-1 — physical, like everything else in this project; the tone mapper deals with
// the magnitude.
fn emberRadiance(tempK: f32) -> f32 {
  if (tempK <= EMBER_MIN_TEMP_K) { return 0.0; }
  let t2 = tempK * tempK;
  return CHAR_EMISSIVITY * STEFAN_BOLTZMANN * t2 * t2 / 3.14159265358979;
}

// Must match CRACK_GRADIENT_SCALE in patterns.ts and crack.wgsl.
const CRACK_GRAD_SCALE_INV: f32 = 1.0 / 0.0075;

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

struct MaterialSurface {
  albedo : vec3<f32>,     // LINEAR, base-colour-factor applied
  alpha : f32,            // linear coverage
  normalTS : vec3<f32>,   // tangent space, unit length
  heightM : f32,          // displacement above the material's mean plane, metres
  occlusion : f32,
  roughness : f32,
  metallic : f32,
  emission : vec3<f32>,   // ember radiance, W m^-2 sr^-1
}

// Which two layers to blend, and by how much. Split out so the fragment-stage and
// explicit-LOD entry points share exactly one copy of the layer arithmetic.
fn materialLayerBlend(matIndex: u32, susceptibility: f32, burn: BurnState) -> vec3<f32> {
  let e = matTable.entries[matIndex];
  let baseLayer = f32(e.layers.x);
  let layerCount = e.layers.y;
  if (layerCount <= 1u) {
    // Non-burnable: one layer, no blend. Rock is the reason the packer handles variable run
    // lengths instead of assuming a stride of four.
    return vec3<f32>(baseLayer, baseLayer, 0.0);
  }
  let b = modulateBurnCoordinate(burnCoordinate(burn), susceptibility, matTable.globals.y);
  let lo = min(u32(floor(b)), layerCount - 1u);
  let hi = min(lo + 1u, layerCount - 1u);
  return vec3<f32>(baseLayer + f32(lo), baseLayer + f32(hi), b - floor(b));
}

fn assembleSurface(
  matIndex: u32,
  a0: vec4<f32>, a1: vec4<f32>,
  n0: vec4<f32>, n1: vec4<f32>,
  o0: vec4<f32>, o1: vec4<f32>,
  crack: vec4<f32>,
  f: f32,
  burn: BurnState,
  emberColor: vec3<f32>,
) -> MaterialSurface {
  let e = matTable.entries[matIndex];
  let c = clamp(burn.charFrac, 0.0, 1.0);

  var albedo = mix(a0.rgb, a1.rgb, f) * e.baseColorRough.rgb;
  let alpha = mix(a0.a, a1.a, f);

  // Decode two-channel tangent normals and blend as vectors. Reconstructing Z rather than
  // storing it costs one sqrt and buys the B channel for height.
  let e0 = n0.rg * 2.0 - 1.0;
  let e1 = n1.rg * 2.0 - 1.0;
  let xy = mix(e0, e1, f);
  var n = normalize(vec3<f32>(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))));

  let orm = mix(o0, o1, f);
  var occlusion = clamp(orm.r, 0.0, 1.0);
  let roughness = clamp(orm.g * e.baseColorRough.w, 0.0, 1.0);
  let metallic = clamp(orm.b * e.factors.x, 0.0, 1.0);

  var heightM = mix(n0.b, n1.b, f) * e.factors.z;
  var emission = vec3<f32>(0.0);

  if ((e.layers.z & MAT_FLAG_BURNABLE) != 0u && c > 0.0) {
    let m = crackMask(crack.r, c);
    let open = 1.0 - m;
    let depth = crackDepthM(c);

    // Normal perturbation from the STORED analytic gradient of D. dpdx/dpdy would be
    // fragment-only and would differentiate screen space rather than texture space.
    let grad = (vec2<f32>(crack.b, crack.a) * 2.0 - 1.0) * CRACK_GRAD_SCALE_INV;
    // A crack wall tilts away from the plate. Depth over the crack's world width gives the
    // slope; the (1-m) gate keeps the intact plate perfectly flat.
    let slope = grad * (depth / max(1e-4, matTable.globals.x)) * open;
    n = normalize(vec3<f32>(n.xy + slope, n.z));

    // Crack floors are recessed, darker and self-shadowed.
    heightM = heightM - depth * open;
    occlusion = occlusion * mix(1.0, 0.45, open * c);
    albedo = albedo * mix(1.0, 0.35, open * c);

    // spec 7.6: emission is INVERTED against the crack mask — cracks expose the hot interior,
    // so the glow lives in the crack floors and fades as T_s decays. No separate ember
    // system, no authored emissive mask.
    emission = emberColor * emberRadiance(burn.tempK) * open;
  }

  return MaterialSurface(albedo, alpha, n, heightM, occlusion, roughness, metallic, emission);
}

// Fragment-stage sampling with implicit derivatives.
//
// MUST be called from uniform control flow (it uses textureSample). If you need it inside a
// branch, use materialSampleGrad with derivatives taken outside the branch.
fn materialSample(
  matIndex: u32,
  uv: vec2<f32>,
  crackUV: vec2<f32>,
  burn: BurnState,
  emberColor: vec3<f32>,
) -> MaterialSurface {
  let e = matTable.entries[matIndex];
  // One extra fetch to read per-texel susceptibility from the material's FIRST layer, whose
  // structure is stable across burn stages. Cheaper than making susceptibility a per-instance
  // constant and far better looking than not having it.
  let susceptibility = textureSample(matOrm, matSampler, uv, e.layers.x).a;
  let lb = materialLayerBlend(matIndex, susceptibility, burn);
  let l0 = u32(lb.x);
  let l1 = u32(lb.y);
  return assembleSurface(
    matIndex,
    textureSample(matAlbedo, matSampler, uv, l0), textureSample(matAlbedo, matSampler, uv, l1),
    textureSample(matNormal, matSampler, uv, l0), textureSample(matNormal, matSampler, uv, l1),
    textureSample(matOrm, matSampler, uv, l0), textureSample(matOrm, matSampler, uv, l1),
    textureSample(matCrack, matSampler, crackUV),
    lb.z, burn, emberColor);
}

// Explicit-gradient sampling. Safe inside non-uniform control flow, which is what the terrain
// splat needs when it skips a ground material whose weight is below 8-bit visibility.
fn materialSampleGrad(
  matIndex: u32,
  uv: vec2<f32>,
  ddxUV: vec2<f32>,
  ddyUV: vec2<f32>,
  crackUV: vec2<f32>,
  crackDdx: vec2<f32>,
  crackDdy: vec2<f32>,
  burn: BurnState,
  emberColor: vec3<f32>,
) -> MaterialSurface {
  let e = matTable.entries[matIndex];
  let susceptibility = textureSampleGrad(matOrm, matSampler, uv, e.layers.x, ddxUV, ddyUV).a;
  let lb = materialLayerBlend(matIndex, susceptibility, burn);
  let l0 = u32(lb.x);
  let l1 = u32(lb.y);
  return assembleSurface(
    matIndex,
    textureSampleGrad(matAlbedo, matSampler, uv, l0, ddxUV, ddyUV),
    textureSampleGrad(matAlbedo, matSampler, uv, l1, ddxUV, ddyUV),
    textureSampleGrad(matNormal, matSampler, uv, l0, ddxUV, ddyUV),
    textureSampleGrad(matNormal, matSampler, uv, l1, ddxUV, ddyUV),
    textureSampleGrad(matOrm, matSampler, uv, l0, ddxUV, ddyUV),
    textureSampleGrad(matOrm, matSampler, uv, l1, ddxUV, ddyUV),
    textureSampleGrad(matCrack, matSampler, crackUV, crackDdx, crackDdy),
    lb.z, burn, emberColor);
}

// Explicit-LOD sampling, for compute and vertex stages, which have no derivatives at all.
fn materialSampleLod(
  matIndex: u32,
  uv: vec2<f32>,
  lod: f32,
  crackUV: vec2<f32>,
  burn: BurnState,
  emberColor: vec3<f32>,
) -> MaterialSurface {
  let e = matTable.entries[matIndex];
  let susceptibility = textureSampleLevel(matOrm, matSampler, uv, e.layers.x, lod).a;
  let lb = materialLayerBlend(matIndex, susceptibility, burn);
  let l0 = u32(lb.x);
  let l1 = u32(lb.y);
  return assembleSurface(
    matIndex,
    textureSampleLevel(matAlbedo, matSampler, uv, l0, lod),
    textureSampleLevel(matAlbedo, matSampler, uv, l1, lod),
    textureSampleLevel(matNormal, matSampler, uv, l0, lod),
    textureSampleLevel(matNormal, matSampler, uv, l1, lod),
    textureSampleLevel(matOrm, matSampler, uv, l0, lod),
    textureSampleLevel(matOrm, matSampler, uv, l1, lod),
    textureSampleLevel(matCrack, matSampler, crackUV, lod),
    lb.z, burn, emberColor);
}

// Alpha test. Returns true when the fragment should be discarded.
fn materialAlphaTestFails(matIndex: u32, alpha: f32) -> bool {
  let e = matTable.entries[matIndex];
  return (e.layers.z & MAT_FLAG_ALPHA_TEST) != 0u && alpha < e.factors.w;
}

// World-space UV for a material, from a world XZ position. Ground materials tile by world
// position so that adjacent terrain patches cannot show a seam.
fn materialWorldUV(matIndex: u32, worldXZ: vec2<f32>) -> vec2<f32> {
  return worldXZ / max(1e-4, matTable.entries[matIndex].factors.y);
}

fn crackWorldUV(worldXZ: vec2<f32>) -> vec2<f32> {
  return worldXZ / max(1e-4, matTable.globals.x);
}
