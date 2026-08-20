// GPU-generated grass. No vertex buffer, no index buffer, no per-blade CPU work.
//
// One instance is one tile; `vertex_index` decomposes into (bladeId, vertexInBlade). Blade
// placement, height, yaw and phase all come from a hash of (tileX, tileZ, bladeId), so the
// field is stable frame to frame and identical on every machine.
//
// VERTS_PER_BLADE vertices per blade in one triangle strip per instance: vertex 0 duplicates
// the first real vertex and the last duplicates the final one, which stitches consecutive
// blades together with degenerate triangles that rasterise nothing. Blade slots above the
// tile's active count collapse to a single point, so thinning costs vertex work but zero
// fill — which is the bound this pass actually lives under (spec §7.4 OPEN QUESTION).

struct BandUniform {
  bandId: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(1) @binding(0) var<uniform> grassU: GrassUniform;
@group(1) @binding(1) var<storage, read> tileLists: array<u32>;
@group(1) @binding(2) var<uniform> bandU: BandUniform;
@group(1) @binding(3) var heightTex: texture_2d<f32>;
@group(1) @binding(4) var occlusionTex: texture_2d<f32>;
@group(1) @binding(5) var consumedTex: texture_2d<f32>;

struct GrassOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) tint: vec3<f32>,
  @location(3) @interpolate(flat) fade: f32,
  // Sun visibility at the blade's ROOT, flat across the blade. A blade is ~0.5 m and the map
  // is 1 m per texel, so interpolating along it would be inventing detail the map lacks.
  @location(4) @interpolate(flat) sunVis: f32,
  // Flat, unlike a tree's: a blade is half a metre in a half-metre fuel cell, so it burns all
  // at once. There is no vertical structure to resolve.
  @location(5) @interpolate(flat) burn: f32,
};

// Blade bend at the tip, as a fraction of blade height, at saturated wind.
const GRASS_BEND_FRACTION: f32 = 0.55;
// Width at the tip, as a fraction of the base width.
const GRASS_TIP_WIDTH_FRACTION: f32 = 0.15;

fn degenerate() -> GrassOut {
  var out: GrassOut;
  // Behind the near plane AND identical for every vertex of the blade: clipped early, and
  // zero area even if it were not.
  out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 1.0);
  out.worldNormal = vec3<f32>(0.0, 1.0, 0.0);
  out.uv = vec2<f32>(0.0, 0.0);
  out.tint = vec3<f32>(0.0, 0.0, 0.0);
  out.fade = 0.0;
  return out;
}

@vertex
fn vsGrass(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> GrassOut {
  let band = bandU.bandId;
  let tilePacked = tileLists[band * grassU.tileCapacityPerBand + instanceIndex];
  let tileX = tilePacked & 0xffffu;
  let tileZ = (tilePacked >> 16u) & 0xffffu;

  let bladeId = vertexIndex / VERTS_PER_BLADE;
  let v = vertexIndex % VERTS_PER_BLADE;

  let tileOrigin = vec2<f32>(f32(tileX), f32(tileZ)) * grassU.tileSizeM;
  let tileCentre = tileOrigin + vec2<f32>(grassU.tileSizeM * 0.5, grassU.tileSizeM * 0.5);
  let tileDistance = length(tileCentre - frame.cameraPos.xz);

  let fullSlots = bladeSlotsForBand(grassU, band);
  let activeSlots = activeSlotsForTile(grassU, tileDistance, band);
  if (bladeId >= activeSlots) {
    return degenerate();
  }

  // Per-blade randomness. Four independent draws from one hash chain.
  let h0 = hash3(tileX, tileZ, bladeId);
  let h1 = hashU32(h0 ^ 0x1u);
  let h2 = hashU32(h0 ^ 0x2u);
  let h3 = hashU32(h0 ^ 0x3u);

  let localXZ = vec2<f32>(rnd01(h0), rnd01(h1)) * grassU.tileSizeM;
  let worldXZ = tileOrigin + localXZ;
  let bladeHeight = mix(grassU.bladeHeightMin, grassU.bladeHeightMax, rnd01(h2));
  let yaw = rnd01(h3) * 6.2831853;
  let phase = rnd01(hashU32(h3)) * 6.2831853;

  // Decompose the strip index. v = 0 duplicates the first vertex, v = VERTS_PER_BLADE - 1
  // duplicates the last; the eight in between are four levels x two sides.
  let j = clamp(v, 1u, VERTS_PER_BLADE - 2u) - 1u;
  let level = min(j >> 1u, 3u);
  let side = f32(j & 1u) * 2.0 - 1.0;
  let t = f32(level) / 3.0;

  let sideDir = vec2<f32>(cos(yaw), sin(yaw));
  let widthScale = bladeWidthScale(grassU, activeSlots, fullSlots);
  let width = grassU.bladeWidthM * widthScale * mix(1.0, GRASS_TIP_WIDTH_FRACTION, t);

  // Bend is quadratic in height: the base stays planted, the tip travels.
  let bend = windDisplacement(worldXZ, phase) * (GRASS_BEND_FRACTION * bladeHeight * t * t);
  let groundY = terrainHeightAt(heightTex, worldXZ.x, worldXZ.y);
  let pos = vec3<f32>(
    worldXZ.x + bend.x + sideDir.x * width * 0.5 * side,
    groundY + bladeHeight * t,
    worldXZ.y + bend.y + sideDir.y * width * 0.5 * side,
  );

  // Tangent of the bent centreline, so the lighting normal follows the bend instead of
  // pointing at the sky on a blade lying nearly flat in a gust.
  let dBend = windDisplacement(worldXZ, phase) * (GRASS_BEND_FRACTION * bladeHeight * 2.0 * t);
  let tangent = normalize(vec3<f32>(dBend.x, bladeHeight, dBend.y));
  let sideVec = vec3<f32>(sideDir.x, 0.0, sideDir.y);
  let normal = normalize(cross(tangent, sideVec));

  let bladeDistance = length(worldXZ - frame.cameraPos.xz);

  var out: GrassOut;
  out.clipPos = frame.viewProj * vec4<f32>(pos, 1.0);
  out.worldNormal = normal;
  // v runs base -> tip, matching the atlas: `grassBlade` in patterns.ts has the blade alive
  // for v <= height, and shades `mix(deepAlbedo, baseAlbedo, v * 1.3)` — green at the base,
  // cured straw at the tip. `1.0 - t` here ran it the other way and put the straw at the
  // ground and the green at the tip, which is upside down for the curing state M5 drives.
  out.uv = vec2<f32>(f32(j & 1u), t);
  // Slight per-blade hue variation, and darker toward the base where light does not reach.
  let hueJitter = 0.85 + 0.3 * rnd01(hashU32(h2));
  out.tint = vec3<f32>(hueJitter) * mix(0.55, 1.0, t);
  out.fade = grassOuterFade(grassU, bladeDistance);
  // Grass sits on the ground, so it takes both terms: crown shade and ridge shade.
  out.sunVis = sunVisibilityAt(occlusionTex, worldXZ.x, worldXZ.y);
  out.burn = consumedAt(consumedTex, worldXZ.x, worldXZ.y);
  return out;
}

@fragment
fn fsGrass(in: GrassOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let tex = burnAlbedo(in.uv, burnLayers(grassU.materialLayer, MATERIAL_FLAG_BURNABLE, in.burn));
  // NO cutout alpha test. `grass-blade`'s alpha channel is a *card* atlas: 12 blade
  // silhouettes across U, each about 3.5% of its cell wide and randomly offset within it.
  // This geometry is already an extruded, bent, tapered blade ribbon, and it samples the
  // atlas at u in {0,1} — cell boundaries, which are always gap. So the mask reads 0 and
  // every fragment discards. The atlas and the ribbon are two representations of the same
  // thing and only one of them can be in charge of the silhouette; here it is the geometry.
  //
  // The colour channel is unmasked and correct at any u — `deepAlbedo` at the base through
  // `baseAlbedo` at the tip (that gradient is the curing state M5 will drive) times a
  // per-cell tint — so the texture still supplies the colour it was authored for.
  var alpha = 1.0;

  if (DITHER_ALPHA) {
    if (!ditherAccept(in.fade, in.clipPos.xy)) {
      discard;
    }
    alpha = 1.0;
  } else {
    alpha = alpha * in.fade;
  }

  var n = normalize(in.worldNormal);
  if (!frontFacing) {
    n = -n;
  }
  let l = normalize(-frame.sunDir);
  let ndl = clamp((dot(n, l) + 0.4) / 1.4, 0.0, 1.0);
  // Hemisphere ambient, matching treeDraw.wgsl: an upward-facing blade sees more sky than a
  // side-on one. A flat constant made every blade in a clump read as the same tone.
  let ambient = 0.25 + 0.15 * clamp(n.y, 0.0, 1.0);
  // PHYSICAL RADIANCE, not an LDR colour. `ndl` and `ambient` are dimensionless shaping
  // terms; multiplying by the actual irradiance (W/m2) and dividing by pi gives Lambertian
  // radiance in W/(m2 sr) — the same units the terrain, the sky and the tone mapper use.
  // Emitting 0..1 here instead made every tree and blade a black silhouette at any exposure,
  // because the terrain beside it was emitting ~58.
  let albedo = tex.rgb * in.tint;
  // Only the direct term is occluded — sky ambient still reaches shaded grass, which is
  // what keeps a forest floor blue-shifted rather than black.
  let irradiance = frame.sunIrradiance * (ndl * in.sunVis) + frame.skyIrradiance * ambient;
  return vec4<f32>(albedo * irradiance * INV_PI, alpha);
}
