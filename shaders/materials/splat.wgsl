// Terrain splatting by slope, aspect and biome. WP 1.6.
//
// EXACT mirror of src/render/materials/splat.ts, which is the unit-tested oracle. Requires
// material_sample.wgsl (and therefore noise.wgsl) to be prepended.
//
// Four ground materials blended per fragment. Which four comes from the biome
// (BiomeParams.groundMaterials, in the fixed slot order declared in library.ts); how much of
// each comes from the terrain and only from the terrain. There is no authored splat map
// anywhere in this project, because a hand-painted one drifts out of agreement with the
// heightfield the moment the seed changes.
//
// Slope is a TANGENT throughout, never an angle, because that is what ITerrainField.slopeAt
// returns and what the spread model consumes (spec 0.6 rule 4). Converting to degrees to
// compare and back is how a radians/degrees error gets in.

// tan(25), tan(45), tan(15), tan(35), tan(10), tan(30). Asserted against the TypeScript
// values in test/render/materials/bindings.test.ts — including tan(45), which is 0.9999...
// rather than 1 in IEEE double and must be written that way for the two to agree.
const SPLAT_ROCK_ONSET: f32 = 0.4663076581549986;
const SPLAT_ROCK_FULL: f32 = 0.9999999999999999;
const SPLAT_LITTER_SHED_START: f32 = 0.2679491924311227;
const SPLAT_LITTER_SHED_END: f32 = 0.7002075382097097;
const SPLAT_DRY_START: f32 = 0.17632698070846498;
const SPLAT_DRY_END: f32 = 0.5773502691896257;

const GROUND_SLOT_MESIC: u32 = 0u;
const GROUND_SLOT_LITTER: u32 = 1u;
const GROUND_SLOT_XERIC: u32 = 2u;
const GROUND_SLOT_ROCK: u32 = 3u;

// Solar exposure of a slope from its aspect: 0 pole-facing, 1 equator-facing.
//
// Aspect is the DOWNSLOPE azimuth clockwise from north (contract ITerrainField), so in the
// northern hemisphere an aspect of pi points the face south. (1 - cos a)/2 maps that to 1
// with a cosine falloff either side, which is the right first-order shape: beam load on a
// tilted plane goes as the cosine of incidence and the azimuth enters through that cosine.
//
// At M5 this SAME term drives fuel moisture, which is why the picture and the physics will
// agree without being made to.
fn slopeExposure(aspectRad: f32, latitudeDeg: f32) -> f32 {
  let e = (1.0 - cos(aspectRad)) * 0.5;
  return select(1.0 - e, e, latitudeDeg >= 0.0);
}

// Ground cover weights, in GROUND_SLOT order. Sums to exactly 1 by construction, not by a
// final divide-by-sum that could divide by zero: rock takes its share off the top and the
// remaining (1 - rock) is split by affinities whose sum has a hard positive floor. A splat
// that does not sum to 1 darkens or brightens the terrain in bands, which reads as a lighting
// bug and gets chased for a day.
fn splatWeights(slopeTangent: f32, aspectRad: f32, drainage: f32, latitudeDeg: f32) -> vec4<f32> {
  let slope = max(0.0, slopeTangent);
  let d = clamp01f(drainage);
  let exposure = clamp01f(slopeExposure(aspectRad, latitudeDeg));

  // Soil and litter cannot rest above the angle of repose. Slope, and nothing else.
  let rock = smoothstepSafe(SPLAT_ROCK_ONSET, SPLAT_ROCK_FULL, slope);
  let rest = 1.0 - rock;

  // Litter follows flow accumulation, sheds where the ground tips, and decays a little on the
  // hot aspect where it decomposes and burns off faster.
  let litterAffinity =
    smoothstepSafe(0.15, 0.8, d) *
    (1.0 - smoothstepSafe(SPLAT_LITTER_SHED_START, SPLAT_LITTER_SHED_END, slope)) *
    (1.0 - 0.35 * exposure);

  // Xeric ground: sun-exposed, and better drained the steeper it gets.
  let xericAffinity = exposure * (0.3 + 0.7 * smoothstepSafe(SPLAT_DRY_START, SPLAT_DRY_END, slope));

  // The 0.35 floor guarantees a positive denominator, and it is physical: some cover of the
  // mesic type exists everywhere that is not bare rock.
  let mesicAffinity =
    0.35 + 0.65 * (1.0 - exposure) * (1.0 - smoothstepSafe(SPLAT_DRY_START, SPLAT_DRY_END, slope));

  let k = rest / (litterAffinity + xericAffinity + mesicAffinity);
  return vec4<f32>(mesicAffinity * k, litterAffinity * k, xericAffinity * k, rock);
}

// Height-aware blend.
//
// Straight linear blending of four albedos reads as mud: the boundary between gravel and
// litter becomes a soft 3 m gradient that exists nowhere in nature. Biasing by each
// material's stored height lets the taller feature win locally, so pebbles poke through a
// thin litter layer instead of averaging with it.
fn heightBlend(weights: vec4<f32>, heights: vec4<f32>, sharpness: f32) -> vec4<f32> {
  // A zero-weight material must not be able to win on height alone.
  var bias = heights + weights;
  let veryLow = -1e30;
  bias = select(vec4<f32>(veryLow), bias, weights > vec4<f32>(0.0));
  let maxBias = max(max(bias.x, bias.y), max(bias.z, bias.w));
  let eps = max(1e-4, sharpness);
  let raised = max(vec4<f32>(0.0), bias - vec4<f32>(maxBias - eps)) * weights;
  let sum = raised.x + raised.y + raised.z + raised.w;
  // Degenerate case: everything fell outside the epsilon window. Falling back to the unbiased
  // weights beats emitting zeros, which would render black terrain.
  if (sum <= 0.0) { return weights; }
  return raised / sum;
}

struct TerrainSplatResult {
  albedo : vec3<f32>,
  normalTS : vec3<f32>,
  occlusion : f32,
  roughness : f32,
  metallic : f32,
  emission : vec3<f32>,
}

// Blend the four ground materials at one point.
//
// `groundMaterials` are material-table indices in GROUND_SLOT order — resolve them once on
// the CPU with resolveGroundMaterials() and pass them in a uniform; do NOT look them up per
// fragment.
//
// All four are sampled unconditionally. Skipping the ones below visibility would save fetches
// but needs non-uniform control flow, hence materialSampleGrad and the derivatives taken here
// once, outside any branch; that optimisation is available but is not taken until the terrain
// pass is actually measured against its budget.
fn terrainSplat(
  groundMaterials: vec4<u32>,
  worldXZ: vec2<f32>,
  slopeTangent: f32,
  aspectRad: f32,
  drainage: f32,
  latitudeDeg: f32,
  burn: BurnState,
  emberColor: vec3<f32>,
) -> TerrainSplatResult {
  let w0 = splatWeights(slopeTangent, aspectRad, drainage, latitudeDeg);

  let ddxWorld = dpdx(worldXZ);
  let ddyWorld = dpdy(worldXZ);
  let crackUV = crackWorldUV(worldXZ);
  let crackDx = ddxWorld / max(1e-4, matTable.globals.x);
  let crackDy = ddyWorld / max(1e-4, matTable.globals.x);

  // `var` arrays, not `let`: WGSL only permits a dynamic index into an array that lives in
  // memory, and these loops are indexed by a loop variable.
  var surf: array<MaterialSurface, 4>;
  var heights: array<f32, 4>;
  for (var i = 0u; i < 4u; i = i + 1u) {
    let mi = groundMaterials[i];
    let tile = max(1e-4, matTable.entries[mi].factors.y);
    surf[i] = materialSampleGrad(
      mi, worldXZ / tile, ddxWorld / tile, ddyWorld / tile,
      crackUV, crackDx, crackDy, burn, emberColor);
    heights[i] = surf[i].heightM / max(1e-6, matTable.entries[mi].factors.z);
  }

  let w = heightBlend(w0, vec4<f32>(heights[0], heights[1], heights[2], heights[3]), 0.08);

  var albedo = vec3<f32>(0.0);
  var normalTS = vec3<f32>(0.0);
  var occlusion = 0.0;
  var roughness = 0.0;
  var metallic = 0.0;
  var emission = vec3<f32>(0.0);
  for (var i = 0u; i < 4u; i = i + 1u) {
    let k = w[i];
    albedo = albedo + surf[i].albedo * k;
    normalTS = normalTS + surf[i].normalTS * k;
    occlusion = occlusion + surf[i].occlusion * k;
    roughness = roughness + surf[i].roughness * k;
    metallic = metallic + surf[i].metallic * k;
    emission = emission + surf[i].emission * k;
  }

  return TerrainSplatResult(albedo, normalize(normalTS), occlusion, roughness, metallic, emission);
}
