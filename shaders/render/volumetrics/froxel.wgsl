// Froxel volumetrics — WP 4.2/4.4. Spec §7.1.1 (volume), §7.1.3 (emission), §7.1.4 (integration).
//
// A frustum-aligned march at 1/16 screen resolution, integrating emission and in-scatter
// front-to-back against the WP 4.1 smoke field, then composited at full resolution.
//
// ## Two outputs, not one alpha
//
// Transmittance is written as an RGB triple, not as a scalar alpha, and the composite is a
// compute pass rather than a blend. That is not gold-plating: extinction goes as lambda^-1.76,
// so the transmitted background is reddened by the plume, and the whole reason §7.1.2 works
// per channel is to get that for free. A single-alpha blend throws it away and the plume greys
// the background instead of reddening it — the most recognisable thing about smoke.
//
// ## What is deliberately not here yet
//
// ponytail: the sun is unshadowed. §7.1.4 wants a 128^3 sun-transmittance volume (2 MB,
// 0.15 ms) so the plume self-shadows and casts into its own smoke. Without it a thick column
// is lit uniformly instead of bright-on-top, dark-underneath. Add the volume, sample it in
// `inScatter`, and nothing else here changes.
// ponytail: no curl-noise detail warp (§7.1.2's `A = 1.2 m, L = 6 m`), so structure is limited
// by the 4 m field. It displaces samples, it does not create mass, so it slots into
// `sampleSmoke` alone.

struct FroxelParams {
  invViewProj: mat4x4f,
  cameraPos: vec4f,          // xyz world, w unused
  sunDirection: vec4f,       // xyz TOWARDS the sun, normalised
  sunIrradiance: vec4f,      // rgb W m^-2 on a surface normal to the beam
  skyIrradiance: vec4f,      // rgb diffuse horizontal, the ambient in-scatter floor
  // x, y = froxel grid, z = slice count, w = terrain texture dimension
  gridInfo: vec4f,
  // x = ambient K, y = near split z1, z = far z_f, w = near z0
  depthInfo: vec4f,
  // x = slices in the linear near-field, y = smoke top (m AGL), z = domain size m, w unused
  misc: vec4f,
};

@group(0) @binding(0) var<uniform> fp: FroxelParams;
@group(0) @binding(1) var smokeTex: texture_3d<f32>;
@group(0) @binding(2) var smokeSamp: sampler;
@group(0) @binding(3) var heightTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var scatterOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var transOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var bbLut: texture_1d<f32>;
@group(0) @binding(8) var bbSamp: sampler;

// --- §7.1.2 optical constants ----------------------------------------------
// Mass extinction efficiency at 550 nm per unit TOTAL dry smoke PM, m^2 kg^-1.
// Reid et al. (2005) Table 5 p. 843. NOT the 8700 EC-only figure, which applied to total PM
// makes the plume about twice as opaque as it should be.
const K550: f32 = 4400.0;
// Extinction Angstrom exponent. Sayer et al. (2014) Table 4 p. 11501, ten-site mean.
const ALPHA: f32 = 1.76;
const LAMBDA_R: f32 = 600.0;
const LAMBDA_G: f32 = 550.0;
const LAMBDA_B: f32 = 450.0;
// Henyey-Greenstein asymmetry. Reid et al. (2005) Table 5, fresh smoke. `estimated`.
const G_HG: f32 = 0.63;
const SIGMA_SB: f32 = 5.670374419e-8;
const INV_PI: f32 = 0.31830988618;
const LUT_MIN_K: f32 = 500.0;
const LUT_MAX_K: f32 = 2500.0;

/// Per-channel extinction, m^-1. The lambda^-alpha dependence is what reddens everything seen
/// through the plume; it is not a special case, it falls out of doing this per channel.
fn extinction(rhoS: f32) -> vec3f {
  let base = K550 * max(rhoS, 0.0);
  return base * vec3f(
    pow(LAMBDA_G / LAMBDA_R, ALPHA),
    1.0,
    pow(LAMBDA_G / LAMBDA_B, ALPHA),
  );
}

/// Single-scattering albedo, keyed on aerosol composition and nothing else.
///
/// Pokhrel et al. (2016) Fig. 4a-c p. 9555, interpolated to the channel wavelengths. There is
/// no distance switch and no biome switch: §7.1.2 deleted both, the first as refuted in
/// mechanism (measured aging is far too slow to vary inside a 1 km domain) and the second
/// because SSA depends on burn conditions rather than fuel type.
fn albedo(f: f32) -> vec3f {
  return clamp(
    vec3f(0.985 - 1.042 * f, 0.981 - 1.018 * f, 0.935 - 0.920 * f),
    vec3f(0.0),
    vec3f(1.0),
  );
}

fn henyeyGreenstein(cosTheta: f32) -> f32 {
  let g2 = G_HG * G_HG;
  let d = 1.0 + g2 - 2.0 * G_HG * cosTheta;
  return INV_PI * 0.25 * (1.0 - g2) / max(d * sqrt(max(d, 1e-6)), 1e-6);
}

/// Ground elevation under a world xz, from WP 1.2's own height texture.
fn groundAt(xz: vec2f) -> f32 {
  let n = fp.gridInfo.w;
  let t = clamp(xz / fp.misc.z * n, vec2f(0.0), vec2f(n - 1.0));
  return textureLoad(heightTex, vec2i(t), 0).r;
}

struct Medium {
  sigmaT: vec3f,
  sigmaS: vec3f,
  sigmaA: vec3f,
  temperatureK: f32,
};

/// Sample the smoke field at a world position.
///
/// The field's vertical axis is height above ground (see `smoke.wgsl`), so the ground has to be
/// subtracted here. Sampling it with an absolute Y would read a kilometre and a half outside
/// the field, clamp, and return the ground layer everywhere — a uniform grey fog that looks
/// deliberate.
fn sampleSmoke(p: vec3f) -> Medium {
  let agl = p.y - groundAt(p.xz);
  var m: Medium;
  m.sigmaT = vec3f(0.0);
  m.sigmaS = vec3f(0.0);
  m.sigmaA = vec3f(0.0);
  m.temperatureK = fp.depthInfo.x;
  if (agl < 0.0 || agl > fp.misc.y) { return m; }

  let uvw = vec3f(p.x / fp.misc.z, p.z / fp.misc.z, agl / fp.misc.y);
  if (any(uvw.xy < vec2f(0.0)) || any(uvw.xy > vec2f(1.0))) { return m; }
  let s = textureSampleLevel(smokeTex, smokeSamp, uvw, 0.0);

  let rhoS = max(s.g, 0.0);
  if (rhoS <= 0.0) { return m; }
  // f is formed HERE, from two advected masses. §7.1.2's implementation trap: a ratio must
  // never be blended as a scalar, and the field stores mass precisely so it never is.
  let f = clamp(s.b / rhoS, 0.0, 1.0);
  let w0 = albedo(f);
  m.sigmaT = extinction(rhoS);
  m.sigmaS = w0 * m.sigmaT;
  m.sigmaA = (vec3f(1.0) - w0) * m.sigmaT;
  m.temperatureK = fp.depthInfo.x + max(s.r, 0.0);
  return m;
}

/// Volumetric emission source, W m^-3 sr^-1. §7.1.3's `S_e = sigma_a * sigma_SB T^4 / pi * C(T)`.
///
/// The LUT carries CHROMA at unit luminance and the magnitude comes from Stefan-Boltzmann, so
/// the T^4 appears exactly once. Applying it in both places is the classic way to get a flame
/// that is the right colour and wildly the wrong brightness.
fn emission(m: Medium) -> vec3f {
  let t = m.temperatureK;
  // Below the LUT floor there is nothing visibly glowing; skipping it also avoids extrapolating
  // the fit off the end of its range.
  if (t <= LUT_MIN_K) { return vec3f(0.0); }
  let u = clamp((t - LUT_MIN_K) / (LUT_MAX_K - LUT_MIN_K), 0.0, 1.0);
  let chroma = textureSampleLevel(bbLut, bbSamp, u, 0.0).rgb;
  let power = SIGMA_SB * t * t * t * t * INV_PI;
  return m.sigmaA * power * chroma;
}

/// In-scattered radiance, W m^-3 sr^-1: sun through the HG lobe plus a sky ambient floor.
fn inScatter(m: Medium, rayDir: vec3f) -> vec3f {
  let cosTheta = dot(rayDir, fp.sunDirection.xyz);
  let phase = henyeyGreenstein(cosTheta);
  // ponytail: unshadowed. The 128^3 sun-transmittance volume of §7.1.4 goes here.
  let sun = fp.sunIrradiance.rgb * phase;
  // The sky term is isotropic, so it carries 1/(4 pi) rather than a phase function.
  let sky = fp.skyIrradiance.rgb * INV_PI * 0.25;
  return m.sigmaS * (sun + sky);
}

/// §7.1.1's piecewise depth distribution: linear near so the fire front is not smeared,
/// exponential far so the plume top stays in range.
fn sliceDepth(s: f32) -> f32 {
  let z0 = fp.depthInfo.w;
  let z1 = fp.depthInfo.y;
  let zf = fp.depthInfo.z;
  let n1 = fp.misc.x;
  let n = fp.gridInfo.z;
  if (s < n1) { return z0 + (s / n1) * (z1 - z0); }
  return z1 * pow(zf / z1, (s - n1) / (n - n1));
}

/// Linear view-space distance of the depth buffer at this froxel, or a huge number for sky.
///
/// REVERSED-Z: the far plane is 0 and the near plane is 1, so a depth of exactly 0 means
/// "nothing was drawn here" — sky — and the march must run to the end rather than stopping
/// immediately. Reading this the conventional way round makes the volumetrics vanish wherever
/// they matter most and appear as a solid wall where they do not.
fn sceneDistance(uv: vec2f, rayDir: vec3f) -> f32 {
  let dims = vec2f(textureDimensions(depthTex));
  let px = vec2i(clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0)));
  let d = textureLoad(depthTex, px, 0);
  if (d <= 0.0) { return 1.0e9; }
  // Reconstruct the world position from the reversed-Z depth and take the true ray distance,
  // not the view-space z: the march is along the ray, and using z would shorten every ray off
  // the screen centre by the cosine.
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let world = fp.invViewProj * ndc;
  if (abs(world.w) < 1e-9) { return 1.0e9; }
  return length(world.xyz / world.w - fp.cameraPos.xyz);
}

@compute @workgroup_size(8, 8)
fn march(@builtin(global_invocation_id) gid: vec3u) {
  let nx = u32(fp.gridInfo.x);
  let ny = u32(fp.gridInfo.y);
  if (gid.x >= nx || gid.y >= ny) { return; }

  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / vec2f(f32(nx), f32(ny));
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let far = fp.invViewProj * ndc;
  let rayDir = normalize(far.xyz / far.w - fp.cameraPos.xyz);

  let stop = sceneDistance(uv, rayDir);
  let slices = u32(fp.gridInfo.z);

  var L = vec3f(0.0);
  var T = vec3f(1.0);
  var prev = 0.0;

  for (var s = 0u; s < slices; s = s + 1u) {
    let znext = sliceDepth(f32(s) + 1.0);
    if (prev >= stop) { break; }
    let segEnd = min(znext, stop);
    let d = segEnd - prev;
    prev = znext;
    if (d <= 0.0) { continue; }

    let mid = fp.cameraPos.xyz + rayDir * (segEnd - d * 0.5);
    let m = sampleSmoke(mid);
    // Empty air still costs the loop but nothing else; most slices take this branch.
    if (all(m.sigmaT <= vec3f(0.0))) { continue; }

    let S = emission(m) + inScatter(m, rayDir);
    // Hillaire's analytic per-slice integral: exact for a constant source over the segment,
    // and stable as sigma_t -> 0 where the naive form divides by zero.
    let e = exp(-m.sigmaT * d);
    let safe = max(m.sigmaT, vec3f(1e-6));
    L = L + T * (S - S * e) / safe;
    T = T * e;
    // Nothing behind a fully opaque column can contribute, and a long march through dense
    // smoke is exactly where the early-out pays.
    if (all(T < vec3f(1e-3))) {
      T = vec3f(0.0);
      break;
    }
  }

  let coord = vec2i(i32(gid.x), i32(gid.y));
  // Alpha carries the distance this column stopped at. The composite needs it to tell a
  // froxel that marched to the far background from one that stopped a metre away on a trunk;
  // without it there is nothing to weight an upsample by. f16 resolves ~0.5 m at 1 km, which
  // is far finer than the tolerance below cares about.
  textureStore(scatterOut, coord, vec4f(L, stop));
  textureStore(transOut, coord, vec4f(T, 1.0));
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

@group(1) @binding(0) var scatterIn: texture_2d<f32>;
@group(1) @binding(1) var transIn: texture_2d<f32>;
// binding 2 was the upsample sampler. The depth-aware upsample weights its own taps, so it
// reads with textureLoad and no sampler exists to bind — and a binding an entry point never
// references is DROPPED from a `layout: 'auto'` pipeline, which makes supplying it a validation
// error rather than a harmless extra. The index is left as a hole rather than renumbering.
@group(1) @binding(3) var hdrTarget: texture_storage_2d<rgba16float, read_write>;

/// `dst = dst * T + L`, per channel, at full resolution, upsampled DEPTH-AWARE.
///
/// A compute pass rather than an alpha blend, because the blend equation has one alpha and the
/// transmittance is three numbers.
///
/// ## Why plain bilinear is not enough here, and what it looked like
///
/// The march terminates each column at ONE scene depth, sampled at the froxel centre. In open
/// ground that is harmless. In a forest it is not: neighbouring froxels straddle a trunk, so
/// one stops a couple of metres out and integrates almost nothing while the next runs to the
/// far background and integrates the whole plume. The low-resolution signal is then close to
/// BINARY between adjacent texels, and no amount of bilinear filtering rescues a signal that
/// is already wrong at source — it just ramps between the two wrong answers. On screen the
/// smoke appeared as hard axis-aligned squares roughly 8 x 6 px, one per froxel column, as
/// though it were being viewed through a stencil. Reported 2026-08-22; unoccluded smoke looked
/// correct the whole time, which is what made it read as a resolution problem rather than a
/// depth one.
///
/// So each full-resolution pixel takes its own scene depth and weights the four surrounding
/// froxels by how well their stop distance agrees with it. A pixel on a distant background
/// draws from the froxels that also saw background; a pixel on a trunk draws from the ones
/// that stopped on a trunk. This is the "depth-aware upsample" §7.1.6 named and deferred.
///
/// Falls back to the plain bilinear weights when no neighbour agrees, which is what keeps a
/// silhouette edge from picking one arbitrary froxel and shimmering along it.
const UPSAMPLE_DEPTH_TOL_M: f32 = 2.0;

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(hdrTarget);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let coord = vec2i(i32(gid.x), i32(gid.y));
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  // This pixel's own scene distance, along its own ray — the same quantity the march stored,
  // measured the same way, or the comparison below would be between two different numbers.
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let farP = fp.invViewProj * ndc;
  let rayDir = normalize(farP.xyz / farP.w - fp.cameraPos.xyz);
  let dFull = sceneDistance(uv, rayDir);

  let lowDims = vec2f(textureDimensions(scatterIn));
  // Bilinear tap positions in low-resolution texel space.
  let t = uv * lowDims - vec2f(0.5);
  let base = floor(t);
  let frac = t - base;

  var sumL = vec3f(0.0);
  var sumT = vec3f(0.0);
  var sumW = 0.0;
  var sumBilinearL = vec3f(0.0);
  var sumBilinearT = vec3f(0.0);
  for (var j = 0; j < 2; j = j + 1) {
    for (var i = 0; i < 2; i = i + 1) {
      let px = clamp(
        vec2i(base) + vec2i(i, j),
        vec2i(0),
        vec2i(lowDims) - vec2i(1),
      );
      let wx = select(1.0 - frac.x, frac.x, i == 1);
      let wy = select(1.0 - frac.y, frac.y, j == 1);
      let bilinear = wx * wy;

      let sc = textureLoad(scatterIn, px, 0);
      let tr = textureLoad(transIn, px, 0).rgb;
      sumBilinearL = sumBilinearL + sc.rgb * bilinear;
      sumBilinearT = sumBilinearT + tr * bilinear;

      // Agreement falls off over a couple of metres. Sky is 1e9 on both sides, so two
      // background froxels agree exactly rather than both being rejected as far apart.
      let dLow = sc.a;
      let closeness = 1.0 / (1.0 + abs(dLow - dFull) / UPSAMPLE_DEPTH_TOL_M);
      let w = bilinear * closeness;
      sumL = sumL + sc.rgb * w;
      sumT = sumT + tr * w;
      sumW = sumW + w;
    }
  }

  var L = sumBilinearL;
  var T = sumBilinearT;
  if (sumW > 1e-4) {
    L = sumL / sumW;
    T = sumT / sumW;
  }

  let dst = textureLoad(hdrTarget, coord).rgb;
  textureStore(hdrTarget, coord, vec4f(dst * T + L, 1.0));
}
