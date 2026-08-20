// Shared sky evaluation. Prepended (WGSL has no #include) to every sky entry point by
// src/render/sky/shaders.ts, so the full-screen pass and the environment-cube capture evaluate
// byte-identical code and cannot drift apart.
//
// Every coefficient in here is computed on the CPU in src/render/sky/preetham.ts and uploaded;
// the shader only evaluates the Perez function and the colour transform. That is deliberate —
// the fiddly, wrong-able part of the model lives where it can be unit tested, and the shader
// holds only what has to run per pixel.
//
// Units: radiance in W/(m^2 sr), linear sRGB primaries, no exposure applied unless the output
// mode asks for tone mapping.

const PI : f32 = 3.14159265359;

// One Perez lobe. MUST match packLobe() in src/render/sky/sky-model.ts.
struct Lobe {
  // Perez luminance coefficients a,b,c,d
  y0 : vec4<f32>,
  // Y.e, then x-chromaticity a,b,c
  y1 : vec4<f32>,
  // x.d, x.e, then y-chromaticity a,b
  y2 : vec4<f32>,
  // y.c, y.d, y.e, zenith luminance (cd/m^2)
  y3 : vec4<f32>,
  // zenith x, zenith y, radiance scale, 1 / luminous efficacy
  zen : vec4<f32>,
  // F(0, thetaS) for Y, x, y; .w carries global horizontal irradiance on the solar lobe only
  den : vec4<f32>,
  // unit vector to this lobe's light source, .w = enabled
  dir : vec4<f32>,
};

// MUST match SKY_UNIFORM_FLOATS / packSkyUniforms() in src/render/sky/sky-model.ts.
struct SkyUniforms {
  invViewProj : mat4x4<f32>,
  // xyz camera position (m), w linear exposure
  camera : vec4<f32>,
  // xyz unit vector to the sun, w angular radius (rad)
  sun : vec4<f32>,
  // rgb solar disc radiance, w sun-is-up flag
  sunDisc : vec4<f32>,
  // xyz unit vector to the moon, w angular radius (rad)
  moon : vec4<f32>,
  // rgb lunar disc radiance, w illuminated fraction
  moonDisc : vec4<f32>,
  // star radiance, output mode, plume optical depth, ground albedo
  misc : vec4<f32>,
  solarLobe : Lobe,
  lunarLobe : Lobe,
};

@group(0) @binding(0) var<uniform> sky : SkyUniforms;

const OUTPUT_LINEAR_HDR : f32 = 0.0;
const OUTPUT_TONEMAPPED : f32 = 1.0;
const OUTPUT_TONEMAPPED_SRGB : f32 = 2.0;

fn perez(a : f32, b : f32, c : f32, d : f32, e : f32, cosTheta : f32, gamma : f32) -> f32 {
  let ct = max(cosTheta, 0.01);
  let cg = cos(gamma);
  return (1.0 + a * exp(b / ct)) * (1.0 + c * exp(d * gamma) + e * cg * cg);
}

fn xyY_to_linear_srgb(x : f32, y : f32, Y : f32) -> vec3<f32> {
  if (y <= 1e-6) {
    return vec3<f32>(0.0);
  }
  let X = (x * Y) / y;
  let Z = ((1.0 - x - y) * Y) / y;
  let r =  3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b =  0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return max(vec3<f32>(r, g, b), vec3<f32>(0.0));
}

fn lobe_radiance(lobe : Lobe, dir : vec3<f32>) -> vec3<f32> {
  if (lobe.dir.w < 0.5 || dir.y <= 0.0) {
    return vec3<f32>(0.0);
  }
  let cosGamma = clamp(dot(dir, lobe.dir.xyz), -1.0, 1.0);
  let gamma = acos(cosGamma);
  let ct = dir.y;

  let fY = perez(lobe.y0.x, lobe.y0.y, lobe.y0.z, lobe.y0.w, lobe.y1.x, ct, gamma);
  let fx = perez(lobe.y1.y, lobe.y1.z, lobe.y1.w, lobe.y2.x, lobe.y2.y, ct, gamma);
  let fy = perez(lobe.y2.z, lobe.y2.w, lobe.y3.x, lobe.y3.y, lobe.y3.z, ct, gamma);

  let lum = lobe.y3.w * fY / max(lobe.den.x, 1e-6);
  let cx = lobe.zen.x * fx / max(lobe.den.y, 1e-6);
  let cy = lobe.zen.y * fy / max(lobe.den.z, 1e-6);

  // photometric -> radiometric, then the irradiance-matching normalisation
  let radiance = lum * lobe.zen.w * lobe.zen.z;
  return xyY_to_linear_srgb(cx, cy, radiance);
}

// Cheap 3D hash for the star field. Not a physical star catalogue: a Poisson-ish sprinkle whose
// per-star radiance is set from the moonless night-sky level, so it disappears correctly as
// twilight brightens rather than being faded by hand.
fn hash31(p : vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn stars(dir : vec3<f32>) -> vec3<f32> {
  let amp = sky.misc.x;
  if (amp <= 0.0 || dir.y <= 0.0) {
    return vec3<f32>(0.0);
  }
  // Quantise the direction onto a grid; one candidate star per cell.
  let grid = 420.0;
  let cell = floor(dir * grid);
  let h = hash31(cell);
  if (h < 0.995) {
    return vec3<f32>(0.0);
  }
  let centre = (cell + vec3<f32>(0.5)) / grid;
  let d = distance(normalize(centre), dir);
  let sigma = 1.6 / grid;
  let profile = exp(-(d * d) / (2.0 * sigma * sigma));
  // Slight colour spread around white, from the hash.
  let tint = vec3<f32>(0.9 + 0.2 * h, 1.0, 1.1 - 0.2 * h);
  let brightness = amp * (0.2 + 4.0 * (h - 0.995) * 200.0) * profile;
  return tint * brightness * smoothstep(0.0, 0.1, dir.y);
}

fn disc(dir : vec3<f32>, lightDir : vec3<f32>, angularRadius : f32, radiance : vec3<f32>) -> vec3<f32> {
  if (angularRadius <= 0.0) {
    return vec3<f32>(0.0);
  }
  let cosAngle = clamp(dot(dir, lightDir), -1.0, 1.0);
  let angle = acos(cosAngle);
  // Antialias the limb across roughly one tenth of the disc radius. Limb darkening is ignored:
  // it is a ~30% effect at the extreme edge of a disc a third of a degree across.
  let edge = angularRadius * 0.1;
  let coverage = 1.0 - smoothstep(angularRadius - edge, angularRadius + edge, angle);
  return radiance * coverage;
}

// Ground hemisphere: a Lambertian bounce off the terrain, radiance = albedo * E_horizontal / pi.
// The environment cube needs a plausible lower hemisphere for specular reflection; the actual
// terrain shading is the world renderer's job, not this one's.
fn ground_radiance() -> vec3<f32> {
  let ghi = sky.solarLobe.den.w;
  let albedo = sky.misc.w;
  return vec3<f32>(albedo * ghi / PI) * vec3<f32>(1.0, 0.96, 0.88);
}

/// Full environment radiance in a direction, W/(m^2 sr), linear sRGB.
///
/// `includeSunDisc` is false for the environment capture: the solar disc is ~1e7 W/(m^2 sr),
/// which overflows f16 storage and would let one texel dominate the prefiltered specular cube.
/// Direct sunlight reaches the shading model as an analytic directional light derived from the
/// same SolarState, so putting it in the cube as well would double-count it.
fn environment_radiance_ex(dir : vec3<f32>, includeSunDisc : bool) -> vec3<f32> {
  if (dir.y <= 0.0) {
    return ground_radiance();
  }
  var L = lobe_radiance(sky.solarLobe, dir) + lobe_radiance(sky.lunarLobe, dir);
  L += stars(dir);
  if (includeSunDisc && sky.sunDisc.w > 0.5) {
    L += disc(dir, sky.sun.xyz, sky.sun.w, sky.sunDisc.rgb);
  }
  L += disc(dir, sky.moon.xyz, sky.moon.w, sky.moonDisc.rgb);
  return L;
}

fn environment_radiance(dir : vec3<f32>) -> vec3<f32> {
  return environment_radiance_ex(dir, true);
}

// ACES filmic approximation, Narkowicz (2015). Only used when the target is an 8-bit surface;
// an HDR pipeline takes the linear radiance and tone maps once, at the end, with everything else.
fn aces(x : vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(1e-8)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn encode_output(L : vec3<f32>) -> vec3<f32> {
  let mode = sky.misc.y;
  if (mode == OUTPUT_LINEAR_HDR) {
    return L;
  }
  let mapped = aces(L * sky.camera.w);
  if (mode == OUTPUT_TONEMAPPED_SRGB) {
    return linear_to_srgb(mapped);
  }
  return mapped;
}
