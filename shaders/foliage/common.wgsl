// Shared structs, bindings and helpers for the foliage package.
//
// Concatenated after the generated constant prelude into every module in this directory, so
// a name means the same thing in the cull, scan, scatter, tree-draw and grass shaders.
//
// The functions here are transliterations of src/render/foliage/cullMath.ts and grassMath.ts.
// Those TypeScript versions are the normative reference and the acceptance oracle; if the two
// ever disagree, the TypeScript is right and this is a bug.

// ---------------------------------------------------------------------------
// Structs — byte layouts pinned by src/render/foliage/layout.ts
// ---------------------------------------------------------------------------

struct TreeInstance {              // 32 B
  posX: f32,
  posY: f32,
  posZ: f32,
  heightM: f32,
  rotationY: f32,
  cullRadiusM: f32,
  meshId: u32,
  burnStateIndex: u32,
};

struct MeshEntry {                 // 32 B
  indexCount: u32,
  firstIndex: u32,
  baseVertex: u32,
  triangleCount: u32,
  refHeightM: f32,
  lod: u32,
  meshId: u32,
  pad0: u32,
};

const INV_PI: f32 = 0.31830988618379067;

struct FrameUniform {              // 240 B
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  timeSec: f32,
  windDir: vec2<f32>,
  windSpeed: f32,
  gustiness: f32,
  // LEFT, RIGHT, BOTTOM, TOP, NEAR, FAR. dot(xyz, p) + w >= 0 is inside.
  frustum: array<vec4<f32>, 6>,
  sunDir: vec3<f32>,
  alphaCutoff: f32,
  // PHYSICAL UNITS, W/m2, per channel. This pass emits radiance, not an LDR colour, and the
  // light is not white — see layout.ts.
  sunIrradiance: vec3<f32>,
  _padFrame0: f32,
  skyIrradiance: vec3<f32>,
  _padFrame1: f32,
};

struct CullUniform {               // 64 B
  instanceCount: u32,
  bucketCount: u32,
  lodCount: u32,
  compactedCapacity: u32,
  lodThresholdPx: vec4<f32>,
  fadeFraction: f32,
  ppm: f32,
  cullRadiusScale: f32,
  pad0: f32,
  pad1: vec4<f32>,
};

struct GrassUniform {              // 96 B
  tileSizeM: f32,
  densityPerM2: f32,
  falloffStartM: f32,
  falloffEndM: f32,
  bandCount: u32,
  tileSpanTiles: u32,
  tileCapacityPerBand: u32,
  domainTiles: u32,
  bladeHeightMin: f32,
  bladeHeightMax: f32,
  bladeWidthM: f32,
  widthCompensation: f32,
  outerFadeFraction: f32,
  cameraTileX: i32,
  cameraTileZ: i32,
  verticalMarginM: f32,
  // Band edges 1..4. Edge 0 is always 0; band b spans [edgeAt(b), edgeAt(b+1)).
  bandEdges: vec4<f32>,
  materialLayer: u32,
  alphaCutoff: f32,
  pad0: f32,
  pad1: f32,
};

// Band edge lookup: edge 0 is the camera, edges 1..4 come from the uniform.
fn bandEdgeAt(g: GrassUniform, k: u32) -> f32 {
  if (k == 0u) {
    return 0.0;
  }
  return g.bandEdges[min(k - 1u, 3u)];
}

// Spec §7.4 density falloff, blades per m2. Mirrors grassMath.grassDensityAt.
fn grassDensityAt(g: GrassUniform, distanceM: f32) -> f32 {
  if (g.falloffEndM <= g.falloffStartM) {
    return select(0.0, g.densityPerM2, distanceM <= g.falloffEndM);
  }
  let t = (g.falloffEndM - distanceM) / (g.falloffEndM - g.falloffStartM);
  return g.densityPerM2 * clamp(t, 0.0, 1.0);
}

fn grassTileArea(g: GrassUniform) -> f32 {
  return g.tileSizeM * g.tileSizeM;
}

// Blade slots a band allocates per tile: the density at the band's NEAR edge, so no tile in
// the band is truncated by its own draw's vertex count.
fn bladeSlotsForBand(g: GrassUniform, band: u32) -> u32 {
  return u32(ceil(grassDensityAt(g, bandEdgeAt(g, band)) * grassTileArea(g)));
}

// Blades a tile at `distanceM` actually draws. Slots above this collapse to a degenerate
// triangle in the vertex shader — thinning that costs vertex work but no fill, which is the
// bound that actually matters here.
fn activeSlotsForTile(g: GrassUniform, distanceM: f32, band: u32) -> u32 {
  let slots = bladeSlotsForBand(g, band);
  let want = u32(max(round(grassDensityAt(g, distanceM) * grassTileArea(g)), 0.0));
  return min(want, slots);
}

fn bladeWidthScale(g: GrassUniform, activeSlots: u32, fullSlots: u32) -> f32 {
  if (activeSlots == 0u || fullSlots == 0u) {
    return 1.0;
  }
  let ratio = f32(fullSlots) / f32(activeSlots);
  let wc = clamp(g.widthCompensation, 0.0, 1.0);
  return min(pow(ratio, 0.5 * wc), MAX_WIDTH_COMPENSATION);
}

fn grassOuterFade(g: GrassUniform, distanceM: f32) -> f32 {
  let w = g.falloffEndM * clamp(g.outerFadeFraction, 0.0, 1.0);
  if (w <= 0.0) {
    return select(0.0, 1.0, distanceM <= g.falloffEndM);
  }
  return clamp((g.falloffEndM - distanceM) / w, 0.0, 1.0);
}

struct MaterialParams {            // 32 B
  baseColor: vec3<f32>,
  roughness: f32,
  layer: u32,
  flags: u32,
  metallic: f32,
  pad0: f32,
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

// Stafford's variant 13 mix. Cheap, and good enough that blade placement shows no visible
// lattice — which a weaker hash absolutely does at 400 blades/m2.
fn hashU32(x: u32) -> u32 {
  var v = x;
  v = v ^ (v >> 16u);
  v = v * 0x7feb352du;
  v = v ^ (v >> 15u);
  v = v * 0x846ca68bu;
  v = v ^ (v >> 16u);
  return v;
}

fn hash2(a: u32, b: u32) -> u32 {
  return hashU32(a ^ (b * 0x9e3779b9u));
}

fn hash3(a: u32, b: u32, c: u32) -> u32 {
  return hashU32(hash2(a, b) ^ (c * 0x85ebca6bu));
}

fn rnd01(x: u32) -> f32 {
  return f32(x & 0x00ffffffu) / 16777216.0;
}

// ---------------------------------------------------------------------------
// Culling — mirrors cullMath.ts
// ---------------------------------------------------------------------------

fn projectedHeightPx(heightM: f32, distanceM: f32, ppm: f32) -> f32 {
  return heightM * ppm / max(distanceM, 1e-3);
}

fn selectLod(hPx: f32, thresholds: vec4<f32>) -> u32 {
  var lod = 0u;
  for (var i = 0u; i < LOD_COUNT - 1u; i = i + 1u) {
    if (hPx < thresholds[i]) {
      lod = i + 1u;
    } else {
      break;
    }
  }
  return lod;
}

struct LodPick {
  lodA: u32,
  weightA: f32,
  lodB: u32,
  weightB: f32,
  count: u32,
};

// Cross-fade: inside a window around a threshold the instance is emitted into BOTH adjacent
// buckets with complementary dither weights, so the switch dissolves instead of popping.
fn pickLod(hPx: f32, thresholds: vec4<f32>, fadeFraction: f32) -> LodPick {
  let lod = selectLod(hPx, thresholds);
  var out = LodPick(lod, 1.0, 0u, 0.0, 1u);
  if (fadeFraction <= 0.0) {
    return out;
  }
  let maxBoundary = i32(LOD_COUNT) - 2;
  for (var k = 0; k < 2; k = k + 1) {
    let b = i32(lod) - 1 + k;
    if (b < 0 || b > maxBoundary) {
      continue;
    }
    let th = thresholds[u32(b)];
    let halfW = th * fadeFraction * 0.5;
    if (halfW <= 0.0) {
      continue;
    }
    if (hPx > th - halfW && hPx < th + halfW) {
      let w = clamp((hPx - (th - halfW)) / (2.0 * halfW), 0.0, 1.0);
      if (w >= 1.0) {
        return LodPick(u32(b), 1.0, 0u, 0.0, 1u);
      }
      if (w <= 0.0) {
        return LodPick(u32(b) + 1u, 1.0, 0u, 0.0, 1u);
      }
      return LodPick(u32(b), w, u32(b) + 1u, 1.0 - w, 2u);
    }
  }
  return out;
}

fn bucketIndex(meshId: u32, lod: u32) -> u32 {
  return meshId * LOD_COUNT + min(lod, LOD_COUNT - 1u);
}

fn packCompacted(instanceIndex: u32, fade01: f32) -> u32 {
  let q = u32(clamp(fade01, 0.0, 1.0) * COMPACTED_FADE_MAX + 0.5);
  return (q << COMPACTED_INDEX_BITS) | (instanceIndex & COMPACTED_INDEX_MASK);
}

fn unpackInstanceIndex(v: u32) -> u32 {
  return v & COMPACTED_INDEX_MASK;
}

fn unpackFade(v: u32) -> f32 {
  return f32(v >> COMPACTED_INDEX_BITS) / COMPACTED_FADE_MAX;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

// Bilinear fetch from the R32F height texture by textureLoad rather than a sampler.
// Filtering an r32float texture requires the optional `float32-filterable` feature; it is
// granted on the target part, but making the whole grass path conditional on an optional
// feature to save three lerps is a bad trade. Four loads work everywhere.
fn terrainHeightAt(tex: texture_2d<f32>, worldX: f32, worldZ: f32) -> f32 {
  let dims = vec2<i32>(textureDimensions(tex, 0));
  if (dims.x <= 1 || dims.y <= 1) {
    return textureLoad(tex, vec2<i32>(0, 0), 0).r;
  }
  let uv = vec2<f32>(worldX, worldZ) / DOMAIN_SIZE_M * vec2<f32>(dims) - vec2<f32>(0.5, 0.5);
  let base = floor(uv);
  let frac = uv - base;
  let i0 = clamp(vec2<i32>(base), vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
  let i1 = clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
  let h00 = textureLoad(tex, vec2<i32>(i0.x, i0.y), 0).r;
  let h10 = textureLoad(tex, vec2<i32>(i1.x, i0.y), 0).r;
  let h01 = textureLoad(tex, vec2<i32>(i0.x, i1.y), 0).r;
  let h11 = textureLoad(tex, vec2<i32>(i1.x, i1.y), 0).r;
  return mix(mix(h00, h10, frac.x), mix(h01, h11, frac.x), frac.y);
}

// ---------------------------------------------------------------------------
// Alpha
// ---------------------------------------------------------------------------

// Interleaved gradient noise (Jimenez 2014). Screen-space, stable under TAA, and one madd.
fn ditherNoise(pixel: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
}

// Returns false when the fragment should be discarded for a cross-fade or thinning weight.
fn ditherAccept(weight: f32, pixel: vec2<f32>) -> bool {
  if (weight >= 1.0) {
    return true;
  }
  return weight > ditherNoise(pixel);
}
