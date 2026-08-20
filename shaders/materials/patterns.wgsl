// Procedural material synthesis. WP 1.6.
//
// EXACT mirror of src/render/materials/patterns.ts. Requires noise.wgsl to be prepended.
//
// Six pattern kinds share one parameter struct, so this is a parameterised function rather
// than a pile of one-off shaders — and because the TypeScript evaluates the same function,
// the CPU version is a testable oracle for this one rather than a separate piece of artwork.
//
// Burn state is NOT a seventh kind. Every material is generated at four stages (green,
// scorch, char, ash) from the SAME underlying noise field, so the spatial structure is
// coherent across the blend and a tree charring from the bottom up does not shimmer at the
// boundary. The four stages become four consecutive array layers (spec 7.6) and the sampler
// lerps floor(b) and floor(b)+1.

// Pattern kinds. Must match PATTERN in patterns.ts.
const KIND_BARK: u32 = 0u;
const KIND_FOLIAGE_ATLAS: u32 = 1u;
const KIND_GRANULAR: u32 = 2u;
const KIND_LITTER: u32 = 3u;
const KIND_GRASS: u32 = 4u;
const KIND_ROCK: u32 = 5u;

const STAGE_GREEN: u32 = 0u;
const STAGE_SCORCH: u32 = 1u;
const STAGE_CHAR: u32 = 2u;
const STAGE_ASH: u32 = 3u;

// One material's procedural recipe. 128 bytes; laid out entirely in vec4s so that WGSL's
// uniform-address-space alignment rules cannot surprise us, and mirrored byte for byte by
// writeGenParams() in gpuGenerator.ts.
struct Pattern {
  kindStageSizeSS : vec4<u32>,   // kind, stage, size, superSamples
  seedPeriods     : vec4<u32>,   // seed, periodU, periodV, grainPeriod
  cellsLayerFlags : vec4<u32>,   // cellsU, cellsV, targetLayer, flags
  elemTipPlate    : vec4<f32>,   // elementWidth, elementLength, tipSharpness, plateiness
  reliefTileMetal : vec4<f32>,   // reliefM, tileSizeM, metallic, baseRoughness
  baseAlbedoVar   : vec4<f32>,   // baseAlbedo.rgb, roughnessVariation
  deepAlbedo      : vec4<f32>,   // deepAlbedo.rgb, detailMean
  burnResponse    : vec4<f32>,   // scorch, char, ash response weights, unused
}

struct PatternSample {
  albedo : vec3<f32>,   // LINEAR. The generator sRGB-encodes on the way into the texture.
  roughness : f32,
  occlusion : f32,
  metallic : f32,
  alpha : f32,          // linear coverage, stored un-encoded in albedo.a
  detail : f32,         // structure field on [0,1]; carries the material's own features into
                        // the burn stages. Its mean is Pattern.deepAlbedo.w, measured not assumed.
}

struct Element {
  mask : f32,       // coverage [0,1]
  lx : f32,         // signed lateral offset from the element spine, cell units
  ly : f32,         // signed offset along the spine, cell units
  core : f32,       // 1 at the spine, 0 at the silhouette
  cellHash : u32,
  lift : f32,       // which of the two litter layers we landed on
}

// Spec 7.6, "Progressive burn materials". LINEAR RGB in xyz, roughness in w. These are the
// values the whole burn visual is anchored to; the tests assert the generated layers
// reproduce them in the mean.
fn burnTarget(stage: u32) -> vec4<f32> {
  switch stage {
    case 1u: { return vec4<f32>(0.14, 0.08, 0.03, 0.68); }    // heat-scorched brown
    case 2u: { return vec4<f32>(0.035, 0.033, 0.032, 0.85); } // black char
    case 3u: { return vec4<f32>(0.62, 0.61, 0.59, 0.96); }    // grey ash
    default: { return vec4<f32>(0.09, 0.16, 0.05, 0.55); }    // green foliage
  }
}

// Scorch curls and shrinks the surface; ash is powder and has almost none. Char keeps the
// parent relief, because its cracks come from the SHARED crack field at shade time, not from
// baked geometry — baking them here as well would double-count, which spec 7.6 warns against.
fn burnReliefScale(stage: u32) -> f32 {
  switch stage {
    case 1u: { return 1.15; }
    case 2u: { return 1.0; }
    case 3u: { return 0.35; }
    default: { return 1.0; }
  }
}

// ---------------------------------------------------------------------------
// Element geometry shared by the atlas-style patterns
// ---------------------------------------------------------------------------

fn foliageElementSeeded(p: Pattern, u: f32, v: f32, seed: u32) -> Element {
  let cu = max(1, i32(p.cellsLayerFlags.x));
  let cv = max(1, i32(p.cellsLayerFlags.y));
  let gx = u * f32(cu);
  let gy = v * f32(cv);
  let ix = i32(floor(gx));
  let iy = i32(floor(gy));
  let h = hash2i(wrapI(ix, cu), wrapI(iy, cv), seed);
  let angle = cellUnit(h, 0u) * 6.283185307179586;
  let sizeJitter = 0.75 + 0.5 * cellUnit(h, 1u);
  let l = rotate2(gx - f32(ix) - 0.5, gy - f32(iy) - 0.5, angle);
  let halfLen = min(0.5, p.elemTipPlate.y) * sizeJitter;
  let along = clamp01f(1.0 - abs(l.y) / max(1e-4, halfLen));
  let halfWidth = p.elemTipPlate.x * sizeJitter * pow(along, 1.0 / max(0.25, p.elemTipPlate.z));
  let d = 1.0 - abs(l.x) / max(1e-4, halfWidth);
  var mask = 0.0;
  if (along > 0.0) {
    mask = smoothstepSafe(0.0, 0.35, d);
  }
  return Element(mask, l.x, l.y, clamp01f(d), h, 0.0);
}

fn foliageElement(p: Pattern, u: f32, v: f32) -> Element {
  return foliageElementSeeded(p, u, v, p.seedPeriods.x);
}

// Forest-floor litter: two half-cell-offset layers of the same scheme, so pieces visibly
// overlap. A single layer reads as a regular lattice of needles no matter how much the cells
// are jittered, because every cell contains exactly one piece.
fn litterElement(p: Pattern, u: f32, v: f32) -> Element {
  let lower = foliageElementSeeded(p, u, v, p.seedPeriods.x);
  let cu = f32(max(1u, p.cellsLayerFlags.x));
  let cv = f32(max(1u, p.cellsLayerFlags.y));
  var upper = foliageElementSeeded(p, u + 0.5 / cu, v + 0.5 / cv, p.seedPeriods.x ^ 0x68e31da4u);
  if (upper.mask >= lower.mask) {
    upper.lift = 1.0;
    return upper;
  }
  return lower;
}

// Grass blades rooted at v = 0, bending with height. Periodic in u only.
fn grassBlade(p: Pattern, u: f32, v: f32) -> Element {
  let cu = max(1, i32(p.cellsLayerFlags.x));
  let gx = u * f32(cu);
  let ix = i32(floor(gx));
  let fx = gx - f32(ix);
  let h = hash2i(wrapI(ix, cu), 0, p.seedPeriods.x);
  let bend = (cellUnit(h, 2u) - 0.5) * 1.2;
  let height = 0.55 + 0.45 * cellUnit(h, 3u);
  let centre = 0.5 + (cellUnit(h, 0u) - 0.5) * 0.5 + bend * v * v;
  let alive = select(0.0, 1.0, v <= height);
  let taper = clamp01f(1.0 - v / max(1e-4, height));
  let halfWidth = p.elemTipPlate.x * (0.25 + 0.75 * pow(taper, 0.6));
  let d = 1.0 - abs(fx - centre) / max(1e-4, halfWidth);
  return Element(alive * smoothstepSafe(0.0, 0.3, d), fx - centre, v, clamp01f(d), h, 0.0);
}

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

// Split out from patternShade because the generator evaluates it four extra times per texel
// for the central-difference normal, and it is much cheaper than the full shade.
fn patternHeight(p: Pattern, u: f32, v: f32, stage: u32) -> f32 {
  let periodU = i32(p.seedPeriods.y);
  let periodV = i32(p.seedPeriods.z);
  let grain = i32(p.seedPeriods.w);
  let seed = p.seedPeriods.x;
  let relief = p.reliefTileMetal.x;
  var h = 0.0;

  switch p.kindStageSizeSS.x {
    case KIND_BARK: {
      let w2 = warp2P(u, v, periodU, periodV, seed ^ 0x1b873593u, 0.35);
      let w = worley2P(w2.x, w2.y, periodU, periodV, seed);
      let plate = smoothstepSafe(0.02, 0.22, w.f2 - w.f1);
      let fissure = ridged2P(u, v, periodU * 2, max(1, periodV), seed + 7u, 4, 3.0);
      let dominant = mix(fissure, plate, p.elemTipPlate.w);
      let g = fbm2P(u, v, grain, grain * 2, seed + 11u, 3, 0.5);
      h = relief * (dominant + 0.22 * g);
    }
    case KIND_FOLIAGE_ATLAS: {
      let e = foliageElement(p, u, v);
      // Squared explicitly rather than via pow(): WGSL's pow() is undefined for a negative
      // base, and `lx` is a SIGNED lateral offset, so half the leaf would be undefined.
      let q = e.lx / max(1e-4, 0.22 * p.elemTipPlate.x);
      let midrib = exp(-(q * q));
      let veins = 0.5 + 0.5 * cos(e.ly * 46.0);
      h = relief * e.mask * (0.55 * midrib + 0.2 * veins + 0.25 * e.core);
    }
    case KIND_GRANULAR: {
      let g = fbm2P(u, v, grain, grain, seed, 5, 0.5);
      let peb = worley2P(u, v, periodU, periodV, seed + 3u);
      let pebble = smoothstepSafe(0.42, 0.14, peb.f1);
      h = relief * (0.55 * g + 0.9 * pebble * (0.42 - min(peb.f1, 0.42)));
    }
    case KIND_LITTER: {
      let e = litterElement(p, u, v);
      let g = fbm2P(u, v, grain, grain, seed + 17u, 4, 0.5);
      h = relief * (0.3 * g + e.mask * (0.4 + 0.6 * e.lift));
    }
    case KIND_GRASS: {
      let e = grassBlade(p, u, v);
      h = relief * e.mask * (0.4 + 0.6 * e.core);
    }
    case KIND_ROCK: {
      let w = worley2P(u, v, periodU, periodV, seed);
      let facet = smoothstepSafe(0.0, 0.16, w.f2 - w.f1);
      let g = fbm2P(u, v, grain, grain, seed + 5u, 4, 0.5);
      h = relief * (0.8 * facet + 0.3 * g);
    }
    default: { h = 0.0; }
  }
  return h * burnReliefScale(stage);
}

// ---------------------------------------------------------------------------
// Shade
// ---------------------------------------------------------------------------

fn shadeUnburnt(p: Pattern, u: f32, v: f32) -> PatternSample {
  let periodU = i32(p.seedPeriods.y);
  let periodV = i32(p.seedPeriods.z);
  let grainP = i32(p.seedPeriods.w);
  let seed = p.seedPeriods.x;
  let baseA = p.baseAlbedoVar.xyz;
  let deepA = p.deepAlbedo.xyz;
  let baseR = p.reliefTileMetal.w;
  let varR = p.baseAlbedoVar.w;
  let metal = p.reliefTileMetal.z;

  switch p.kindStageSizeSS.x {
    case KIND_BARK: {
      let w2 = warp2P(u, v, periodU, periodV, seed ^ 0x1b873593u, 0.35);
      let w = worley2P(w2.x, w2.y, periodU, periodV, seed);
      let plate = smoothstepSafe(0.02, 0.22, w.f2 - w.f1);
      let fissure = ridged2P(u, v, periodU * 2, max(1, periodV), seed + 7u, 4, 3.0);
      let dominant = mix(fissure, plate, p.elemTipPlate.w);
      let g = fbm2P(u, v, grainP, grainP * 2, seed + 11u, 3, 0.5);
      // Real bark plates weather independently, so each gets its own tint.
      let tint = 0.82 + 0.36 * cellUnit(w.cell, 4u);
      let detail = clamp01f(0.55 * dominant + 0.45 * g);
      let albedo = mix(deepA, baseA, dominant) * (tint * (0.8 + 0.4 * g));
      // Furrows self-shadow. Without this AO, bark reads as a flat noise print under any
      // sky-dominated lighting.
      return PatternSample(albedo, clamp01f(baseR + varR * (g - 0.5) * 2.0),
                           clamp01f(0.35 + 0.65 * dominant), metal, 1.0, detail);
    }
    case KIND_FOLIAGE_ATLAS: {
      let e = foliageElement(p, u, v);
      let veins = 0.5 + 0.5 * cos(e.ly * 46.0);
      let leafTint = 0.78 + 0.44 * cellUnit(e.cellHash, 5u);
      let centreness = clamp01f(e.core);
      let albedo = mix(baseA, deepA, centreness * 0.7) * leafTint;
      let detail = clamp01f(0.6 * centreness + 0.4 * veins);
      // Leaf edges are thinner, lighter and rougher than the centre.
      return PatternSample(albedo, clamp01f(baseR + varR * (0.5 - centreness) * 2.0),
                           clamp01f(0.6 + 0.4 * centreness), metal, e.mask, detail);
    }
    case KIND_GRANULAR: {
      let g = fbm2P(u, v, grainP, grainP, seed, 5, 0.5);
      let peb = worley2P(u, v, periodU, periodV, seed + 3u);
      let pebble = smoothstepSafe(0.42, 0.14, peb.f1);
      let pebTint = 0.8 + 0.4 * cellUnit(peb.cell, 6u);
      let base = mix(deepA, baseA, g);
      let albedo = mix(base, baseA * pebTint, pebble);
      let detail = clamp01f(0.7 * g + 0.3 * pebble);
      return PatternSample(albedo, clamp01f(baseR + varR * (g - 0.5) * 2.0),
                           clamp01f(0.55 + 0.45 * g), metal, 1.0, detail);
    }
    case KIND_LITTER: {
      let e = litterElement(p, u, v);
      let g = fbm2P(u, v, grainP, grainP, seed + 17u, 4, 0.5);
      let pieceTint = 0.7 + 0.6 * cellUnit(e.cellHash, 7u);
      // Where no piece covers, we see the duff underneath.
      let duff = deepA * (0.75 + 0.5 * g);
      let piece = baseA * pieceTint;
      let albedo = mix(duff, piece, e.mask);
      let detail = clamp01f(0.5 * e.mask + 0.5 * g);
      return PatternSample(albedo, clamp01f(baseR + varR * (g - 0.5) * 2.0),
                           clamp01f(0.45 + 0.35 * g + 0.2 * e.mask * (0.5 + 0.5 * e.lift)),
                           metal, 1.0, detail);
    }
    case KIND_GRASS: {
      let e = grassBlade(p, u, v);
      let bladeTint = 0.7 + 0.6 * cellUnit(e.cellHash, 8u);
      // Blades are darker and greener at the base, drier toward the tip. At M5 that gradient
      // becomes the curing state rather than an appearance choice.
      let albedo = mix(deepA, baseA, clamp01f(v * 1.3)) * bladeTint;
      let detail = clamp01f(0.5 * e.core + 0.5 * v);
      return PatternSample(albedo, clamp01f(baseR + varR * (v - 0.5) * 2.0),
                           clamp01f(0.35 + 0.65 * clamp01f(v * 1.2)), metal, e.mask, detail);
    }
    case KIND_ROCK: {
      let w = worley2P(u, v, periodU, periodV, seed);
      let facet = smoothstepSafe(0.0, 0.16, w.f2 - w.f1);
      let g = fbm2P(u, v, grainP, grainP, seed + 5u, 4, 0.5);
      let facetTint = 0.78 + 0.44 * cellUnit(w.cell, 9u);
      let albedo = mix(deepA, baseA, facet) * (facetTint * (0.85 + 0.3 * g));
      let detail = clamp01f(0.6 * facet + 0.4 * g);
      return PatternSample(albedo, clamp01f(baseR + varR * (g - 0.5) * 2.0),
                           clamp01f(0.4 + 0.6 * facet), metal, 1.0, detail);
    }
    default: {
      return PatternSample(vec3<f32>(0.0), 1.0, 1.0, 0.0, 1.0, 0.5);
    }
  }
}

// Move an unburnt sample toward the spec 7.6 stage target.
//
// The modulation is MEAN-PRESERVING BY CONSTRUCTION: `1 + k*(detail - detailMean)` has mean
// exactly 1, because detailMean (deepAlbedo.w) is measured from this pattern rather than
// assumed. The layer keeps its spatial variation without biasing its mean away from the
// published value, which is what makes the reference-value test meaningful. Assuming 0.5
// instead is the subtle version of the same bug: right for bark and ground, wrong by ~30% for
// the alpha-tested atlases, whose detail is near zero across the empty part of every cell.
fn applyBurn(p: Pattern, s: PatternSample, stage: u32) -> PatternSample {
  if (stage == STAGE_GREEN) { return s; }
  let tgt = burnTarget(stage);
  var w = 1.0;
  switch stage {
    case 1u: { w = p.burnResponse.x; }
    case 2u: { w = p.burnResponse.y; }
    default: { w = p.burnResponse.z; }
  }
  w = clamp01f(w);
  let modulation = 1.0 + 0.5 * (s.detail - p.deepAlbedo.w);
  let albedo = mix(s.albedo, tgt.xyz * modulation, w);
  let roughness = mix(s.roughness, tgt.w, w);
  // Ash is powder: it fills the crevices, so ambient occlusion flattens out.
  var occlusion = mix(s.occlusion, s.occlusion * 0.85, w);
  if (stage == STAGE_ASH) {
    occlusion = mix(s.occlusion, 1.0, 0.6 * w);
  }
  // Alpha survives burning — a charred needle is still needle-shaped until it falls off.
  // Ash erodes the silhouette slightly, which is what makes a burnt canopy read as thinner.
  var alpha = s.alpha;
  if (stage == STAGE_ASH) {
    alpha = s.alpha * mix(1.0, 0.82, w);
  }
  return PatternSample(albedo, roughness, occlusion, s.metallic, alpha, s.detail);
}

fn samplePattern(p: Pattern, u: f32, v: f32, stage: u32) -> PatternSample {
  return applyBurn(p, shadeUnburnt(p, u, v), stage);
}

// ---------------------------------------------------------------------------
// Alligator crack field (spec 7.6)
// ---------------------------------------------------------------------------

// One shared tiling field for the whole world. Cracks are NOT baked into the char layer:
// spec 7.6 makes crack width a function of the LIVE char fraction, so it must be evaluated at
// shade time from this field.
fn crackDistance(u: f32, v: f32, period: i32, seed: u32) -> f32 {
  let w = worley2P(u, v, period, period, seed);
  // ~0.45 is a typical interior value for jittered Worley, so this normalises f2-f1 to [0,1].
  return clamp01f((w.f2 - w.f1) / 0.45);
}

fn crackCellId(u: f32, v: f32, period: i32, seed: u32) -> f32 {
  return u32ToUnit(worley2P(u, v, period, period, seed).cell);
}
