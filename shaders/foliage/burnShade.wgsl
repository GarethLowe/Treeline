// Shared burn shading. Included by both draw pipelines.
//
// A burnable material occupies BURN_LAYER_COUNT consecutive texture-array layers — green,
// scorch, char, ash — packed by `library.ts`. Burning something is therefore a layer offset
// and a blend, not a colour tint: the char layer has its own albedo, its own roughness and
// its own normal map, and a tint would flatten all three into a multiply.

/// Metres of char up a trunk, from the strongest fire this tree has stood in.
///
/// Byram (1959) flame length, `L = 0.0775 * I^0.46`, which is already the project's flame
/// length everywhere else — see `sim/rothermel/kernel.ts` and its `calibrated` provenance.
/// Char reaches about as high as the flame does; SCORCH — where the convective plume kills
/// foliage without burning it — goes far higher and is a different relation (Van Wagner 1973),
/// which is NOT modelled here. So a tree in this scene chars to flame height and its crown
/// above that stays green even where a real one would be brown. Stated, not hidden.
fn charHeightM(peakIntensityKwM: f32) -> f32 {
  if (peakIntensityKwM <= 0.0) { return 0.0; }
  return 0.0775 * pow(peakIntensityKwM, 0.46);
}

/// Burn coordinate in [0,1] at `heightM` above a stem's base.
///
/// `consumed` is how complete the burn is where the tree stands, and the vertical term is how
/// far up the flame reached. Multiplying them means a low-intensity backing fire leaves a
/// scorched ankle and a crown fire takes the whole stem.
fn stemBurnCoordinate(consumed: f32, peakIntensityKwM: f32, heightM: f32) -> f32 {
  let reach = charHeightM(peakIntensityKwM);
  if (reach <= 0.01) { return 0.0; }
  let vertical = clamp(1.0 - heightM / reach, 0.0, 1.0);
  return clamp(consumed, 0.0, 1.0) * vertical;
}

/// WP 2.4's consumed fraction at a world position. Nearest — the surface grid is 0.5 m, finer
/// than anything downstream of it resolves.
fn consumedAt(tex: texture_2d<f32>, worldX: f32, worldZ: f32) -> f32 {
  let dims = vec2<i32>(textureDimensions(tex, 0));
  if (dims.x <= 1) { return 0.0; }
  let uv = vec2<f32>(worldX, worldZ) / DOMAIN_SIZE_M * vec2<f32>(dims);
  let t = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(dims) - vec2<f32>(1.0)));
  return textureLoad(tex, t, 0).r;
}

/// The two burn-stage layers to blend, and the fraction between them.
/// Returns (layer0, layer1, fraction). A non-burnable material has one layer and stays on it.
fn burnLayers(baseLayer: u32, flags: u32, burn: f32) -> vec3<f32> {
  if ((flags & MATERIAL_FLAG_BURNABLE) == 0u) {
    return vec3<f32>(f32(baseLayer), f32(baseLayer), 0.0);
  }
  let c = clamp(burn, 0.0, 1.0) * f32(BURN_LAYER_COUNT - 1u);
  let s0 = floor(c);
  let s1 = min(s0 + 1.0, f32(BURN_LAYER_COUNT - 1u));
  return vec3<f32>(f32(baseLayer) + s0, f32(baseLayer) + s1, c - s0);
}

/// Sample the albedo array across a burn transition.
///
/// BOTH layers are always sampled, never conditionally: `textureSample` needs uniform control
/// flow for its implicit derivatives, and branching on a per-fragment burn coordinate is not
/// uniform. `materialSample` in the materials package takes the same two fetches for the same
/// reason. When the two layers are equal the mix is a no-op and the cache serves the second
/// fetch from the first.
fn burnAlbedo(uv: vec2<f32>, layers: vec3<f32>) -> vec4<f32> {
  let a = textureSample(albedoArray, materialSampler, uv, u32(layers.x));
  let b = textureSample(albedoArray, materialSampler, uv, u32(layers.y));
  return mix(a, b, layers.z);
}
