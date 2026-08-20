// The terrain surface pass — src/app.
//
// Prepended, in order, by src/app/terrainPass.ts:
//   1. materialWgsl({ materialGroup: 1, burnGroup: 3, includeSplat: true })   [WP 1.6]
//        -> noise.wgsl, material_sample.wgsl, splat.wgsl. Declares @group(1) bindings 0..5
//           and provides materialSampleGrad(), terrainSplat(), burnStateUnburnt().
//   2. shaders/terrain/terrain_sample.wgsl                                    [WP 1.2]
//        -> terrain_sample(), the exact transcription of the CPU height/slope/aspect query.
//           Using it rather than re-deriving normals from the mesh is what keeps the picture
//           and the physics reading the same surface.
//
// BIND GROUPS
//   0  this pass: uniforms + the three terrain textures
//   1  materials (WP 1.6's own bind group layout, unmodified)
//   2  environment lighting (WP 1.7's own bind group layout, unmodified)
//   3  burn state (M4, WP 4.6). WP 1.6 reserved this group and pointed materialWgsl's
//      burnGroup at it; this is the pass that finally declares it. Spec §7.6(d): "grass and
//      ground sample the 2048^2 surface-state texture directly by world XZ, at zero extra
//      storage" — so there is no per-instance record here, just the sim's own fields.
//
// DEPTH IS REVERSED-Z. The projection arrives from WP 1.8 already reversed, so this shader
// does nothing special; the pipeline uses DEPTH_COMPARE ('greater') and clears to 0.

struct TerrainUniforms {
  viewProj   : mat4x4<f32>,
  // xyz = camera world position, w = site latitude in DEGREES (the splat's hemisphere test)
  cameraPos  : vec4<f32>,
  // xyz = unit vector TOWARDS the sun, w = direct normal irradiance, W/m^2
  sunDir     : vec4<f32>,
  // rgb = normalised beam colour (peak channel 1), a = diffuse horizontal irradiance, W/m^2
  sunColor   : vec4<f32>,
  // x = vertices per grid axis, y = domain size m, z = terrain grid nodes, w = terrain cell m
  grid       : vec4<f32>,
  // material-table indices in GROUND_SLOT order: mesic, litter, xeric, rock
  ground     : vec4<u32>,
  // x = inner fraction, y = skirt reach, z = specular mip count, w = unused
  misc       : vec4<f32>,
}

// --- group 3, the burn state (WP 4.6) --------------------------------------
// WP 2.4's consumed fraction over the 2048^2 surface grid, and WP 4.1's smoke field for the
// residual surface temperature that drives ember glow in the crack floors.
@group(3) @binding(0) var consumedTex : texture_2d<f32>;
@group(3) @binding(1) var smokeTex3   : texture_3d<f32>;
@group(3) @binding(2) var burnSamp    : sampler;
// x = surface cells, y = domain size m, z = ambient K, w = smoke top m AGL
@group(3) @binding(3) var<uniform> burnU : vec4<f32>;

/// Burn state of the ground at a world XZ.
///
/// Spec §7.6: `b = clamp(s + c + a, 0, 3)` with `a = smoothstep(0.75, 1, u)` and u the mass
/// consumption fraction. Scorch and char are the two earlier bands of the same u, so the
/// coordinate is monotone in consumption by construction — a ground cell can never un-burn,
/// which is what stops the splat flickering between layers as the readback lands.
fn groundBurnState(worldXZ : vec2<f32>) -> BurnState {
  let n = burnU.x;
  let uv = clamp(worldXZ / burnU.y, vec2<f32>(0.0), vec2<f32>(1.0));
  let u = clamp(textureSampleLevel(consumedTex, burnSamp, uv, 0.0).r, 0.0, 1.0);

  let scorch = smoothstep(0.02, 0.30, u);
  let charFrac = smoothstep(0.25, 0.75, u);
  let ash = smoothstep(0.75, 1.0, u);

  // Residual surface temperature from the smoke field's ground level. Real, simulated, and
  // already decaying on its own clock — which is what makes embers fade instead of being
  // switched off by a timer. Below §7.6's 700 K threshold the emission term is zero anyway.
  let smokeUvw = vec3<f32>(uv.x, uv.y, 0.5 / burnU.w);
  let excess = max(textureSampleLevel(smokeTex3, burnSamp, smokeUvw, 0.0).r, 0.0);
  let tempK = select(0.0, burnU.z + excess, u > 0.0);

  return BurnState(scorch, charFrac, ash, tempK);
}

@group(0) @binding(0) var<uniform> terrainU : TerrainUniforms;
@group(0) @binding(1) var heightTex      : texture_2d<f32>;
@group(0) @binding(2) var slopeAspectTex : texture_2d<f32>;
@group(0) @binding(3) var drainageTex    : texture_2d<f32>;
@group(0) @binding(4) var occlusionTex   : texture_2d<f32>;

// Diffuse irradiance SH (9 x vec4, cosine-convolved) + prefiltered specular cube. WP 1.7's
// EnvironmentLighting.bindGroupLayout, binding for binding.
struct IrradianceSh { coefficients : array<vec4<f32>, 9>, }
@group(2) @binding(0) var<uniform> envSh       : IrradianceSh;
@group(2) @binding(1) var envSpecular : texture_cube<f32>;
@group(2) @binding(2) var envSampler  : sampler;

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

// EXACT mirror of gridAxisToWorld() in src/app/terrainGrid.ts, which is the unit-tested
// oracle. The inner INNER_FRACTION of the axis covers the domain linearly; the rest is a
// quadratic skirt out to (1 + SKIRT_REACH) half-domains, so the horizon is terrain rather
// than a cliff edge at 1 km.
fn terrainAxisToWorld(t: f32, domainM: f32) -> f32 {
  let s = t * 2.0 - 1.0;
  let a = abs(s);
  let half = domainM * 0.5;
  let inner = terrainU.misc.x;
  var r: f32;
  if (a <= inner) {
    r = a / inner;
  } else {
    let u = (a - inner) / max(1e-5, 1.0 - inner);
    r = 1.0 + terrainU.misc.y * u * u;
  }
  return half + half * sign(s) * r;
}

fn terrainConfig() -> TerrainConfig {
  return TerrainConfig(u32(terrainU.grid.z), terrainU.grid.w, 0u, 0u);
}

// Bilinear drainage on the same texel convention as terrain_sample: texel (i, j) is the node
// at ((i + 0.5) * cell, (j + 0.5) * cell).
fn drainageAt(x: f32, z: f32) -> f32 {
  let n = i32(terrainU.grid.z);
  let cell = terrainU.grid.w;
  let fx = clamp(x / cell - 0.5, 0.0, f32(n - 1));
  let fz = clamp(z / cell - 0.5, 0.0, f32(n - 1));
  let i0 = min(i32(floor(fx)), n - 2);
  let j0 = min(i32(floor(fz)), n - 2);
  let tx = fx - f32(i0);
  let tz = fz - f32(j0);
  let d00 = textureLoad(drainageTex, vec2<i32>(i0, j0), 0).r;
  let d10 = textureLoad(drainageTex, vec2<i32>(i0 + 1, j0), 0).r;
  let d01 = textureLoad(drainageTex, vec2<i32>(i0, j0 + 1), 0).r;
  let d11 = textureLoad(drainageTex, vec2<i32>(i0 + 1, j0 + 1), 0).r;
  return mix(mix(d00, d10, tx), mix(d01, d11, tx), tz);
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

// Irradiance for a normal, W/m^2. The buffer already carries the cosine convolution, so this
// is a plain SH evaluation. Clamped at zero: band-limited SH rings negative in dark
// directions, and a negative irradiance renders as a black hole in the shadowed side.
fn skyIrradiance(n: vec3<f32>) -> vec3<f32> {
  let b0 = 0.282095;
  let b1 = 0.488603 * n.y;
  let b2 = 0.488603 * n.z;
  let b3 = 0.488603 * n.x;
  let b4 = 1.092548 * n.x * n.y;
  let b5 = 1.092548 * n.y * n.z;
  let b6 = 0.315392 * (3.0 * n.z * n.z - 1.0);
  let b7 = 1.092548 * n.x * n.z;
  let b8 = 0.546274 * (n.x * n.x - n.y * n.y);
  let e =
      envSh.coefficients[0].rgb * b0
    + envSh.coefficients[1].rgb * b1
    + envSh.coefficients[2].rgb * b2
    + envSh.coefficients[3].rgb * b3
    + envSh.coefficients[4].rgb * b4
    + envSh.coefficients[5].rgb * b5
    + envSh.coefficients[6].rgb * b6
    + envSh.coefficients[7].rgb * b7
    + envSh.coefficients[8].rgb * b8;
  return max(e, vec3<f32>(0.0));
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
}

// No vertex buffer: the position comes from the vertex index. 591 k vertices of XZ never
// exist in memory, and the grid resolution is a constant rather than a rebuild.
@vertex
fn vs_terrain(@builtin(vertex_index) vid : u32) -> VsOut {
  let v = max(2u, u32(terrainU.grid.x));
  let ix = vid % v;
  let iz = vid / v;
  let inv = 1.0 / f32(v - 1u);
  let wx = terrainAxisToWorld(f32(ix) * inv, terrainU.grid.y);
  let wz = terrainAxisToWorld(f32(iz) * inv, terrainU.grid.y);
  let s = terrain_sample(heightTex, slopeAspectTex, terrainConfig(), wx, wz);

  var out : VsOut;
  out.world = vec3<f32>(wx, s.height, wz);
  out.clip = terrainU.viewProj * vec4<f32>(out.world, 1.0);
  return out;
}

@fragment
fn fs_terrain(in : VsOut) -> @location(0) vec4<f32> {
  let worldXZ = in.world.xz;

  // Re-sample rather than interpolating a vertex normal: at the 1.8 m grid spacing an
  // interpolated normal is visibly faceted, and this is the same function the CPU query and
  // the fire model use, so the shading agrees with the physics by construction.
  let s = terrain_sample(heightTex, slopeAspectTex, terrainConfig(), worldXZ.x, worldXZ.y);
  let geoN = normalize(s.normal);

  let splat = terrainSplat(
    terrainU.ground,
    worldXZ,
    s.slopeTan,
    s.aspect,
    drainageAt(worldXZ.x, worldXZ.y),
    terrainU.cameraPos.w,
    groundBurnState(worldXZ),
    vec3<f32>(1.0, 0.35, 0.08));

  // Material UVs are world-space XZ (materialWorldUV), so the tangent frame is the world
  // axes projected onto the surface. Getting this wrong tilts every detail normal by the
  // slope and reads as a lighting bug on steep ground.
  let t0 = vec3<f32>(1.0, 0.0, 0.0);
  let tangent = normalize(t0 - geoN * dot(geoN, t0));
  let bitangent = normalize(cross(geoN, tangent));
  let n = splat.normalTS;
  let N = normalize(tangent * n.x + bitangent * n.y + geoN * n.z);

  let V = normalize(terrainU.cameraPos.xyz - in.world);
  let L = normalize(terrainU.sunDir.xyz);
  let NdotL = max(0.0, dot(N, L));
  let NdotV = max(1e-4, dot(N, V));

  // Physical irradiance, W/m^2, times the fraction of the sun this point can actually see:
  // crown shadows and ridge shadows from the top-down occlusion map. Not a cascade — see
  // `shaders/render/shadow/sunOcclusion.wgsl` for what it does and does not cover. Only the
  // direct term is occluded; sky ambient still reaches shaded ground, which is why a forest
  // floor reads blue-shifted rather than black.
  let sunVis = sunVisibilityAt(occlusionTex, in.world.x, in.world.z);
  let direct = terrainU.sunColor.rgb * (terrainU.sunDir.w * NdotL * sunVis);
  let ambient = skyIrradiance(N) * splat.occlusion;

  // Lambertian exitance -> radiance: E * albedo / pi. Everything upstream of the tone mapper
  // is in W/(m^2 sr), which is what lets M4's blackbody flame composite without a fudge.
  let diffuse = splat.albedo * (direct + ambient) * (1.0 / 3.14159265358979);

  // Crude split-sum specular: prefiltered environment times a Schlick Fresnel. No BRDF LUT,
  // so it is not energy-exact; without it wet-looking ground and rock read as flat paint.
  let R = reflect(-V, N);
  let mipCount = max(1.0, terrainU.misc.z);
  let mip = sqrt(clamp(splat.roughness, 0.0, 1.0)) * (mipCount - 1.0);
  let prefiltered = textureSampleLevel(envSpecular, envSampler, R, mip).rgb;
  let f0 = mix(vec3<f32>(0.04), splat.albedo, splat.metallic);
  let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - NdotV, 5.0);
  let specular = prefiltered * fresnel * splat.occlusion;

  return vec4<f32>(diffuse + specular + splat.emission, 1.0);
}
