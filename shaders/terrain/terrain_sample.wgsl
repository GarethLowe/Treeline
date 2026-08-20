// Terrain sampling — work package 1.2.
//
// A line-by-line transcription of src/world/terrain/sampling.ts. The CPU query, the CPU
// texel emulation and this shader are three implementations of ONE stated rule; the
// acceptance test for the package is that they agree numerically, which is only a
// meaningful test because the rule is written down once and copied deliberately.
//
// Coordinate frame (src/world/terrain/conventions.ts): right-handed, Y-up, +x = East,
// +z = South, north = -z. Aspect is the DOWNSLOPE azimuth, clockwise from north.
//
// Texel (i, j) is the terrain node at world ((i + 0.5) * cell, (j + 0.5) * cell), so
// f = world / cell - 0.5 and the clamp to [0, n-1] reproduces clamp-to-edge exactly.
//
// WHY textureLoad AND NOT A LINEAR SAMPLER:
//   * Aspect is an angle on a circle. Hardware-filtering the rg16float texel blends 0.02 rad
//     with 6.27 rad into ~3.1 rad — pointing due south where the answer is due north — along
//     the whole seam where aspect wraps through north. Every consumer of aspect (solar load
//     on a slope, slope-driven spread direction) would be silently reversed there. So the
//     four texels are converted to gradient VECTORS first and the vectors are blended.
//   * Hardware bilinear also quantises its interpolation weights to a few subtexel bits.
//     Irrelevant for shading, but it puts a floor under CPU/GPU agreement that is higher
//     than the agreement this package is required to demonstrate.
// Rendering may still bind heightTex to a filtering sampler; physics uses these functions.

const TERRAIN_TWO_PI: f32 = 6.283185307179586;

struct TerrainConfig {
  gridN: u32,
  cellM: f32,
  probeCount: u32,
  _pad: u32,
};

struct TerrainSample {
  height: f32,
  slopeTan: f32,
  aspect: f32,
  normal: vec3<f32>,
};

// Base texel index and blend weight for one axis.
fn terrain_locate(world: f32, cellM: f32, n: i32) -> vec2<f32> {
  let f = clamp(world / cellM - 0.5, 0.0, f32(n - 1));
  let i0 = min(i32(floor(f)), n - 2);
  return vec2<f32>(f32(i0), f - f32(i0));
}

// Compass azimuth (clockwise from north) of a horizontal direction in world (x, z),
// wrapped into [0, 2*pi). Mirrors azimuthOf() in conventions.ts.
fn terrain_azimuth(vx: f32, vz: f32) -> f32 {
  let a = atan2(vx, -vz);
  return select(a, a + TERRAIN_TWO_PI, a < 0.0);
}

// (slope tangent, downslope azimuth) -> gradient (dh/dx, dh/dz).
// Downslope direction is (sin a, -cos a); the gradient points uphill, so it is -slope times
// that.
fn terrain_decode_gradient(sa: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(-sa.x * sin(sa.y), sa.x * cos(sa.y));
}

fn terrain_sample(
  heightTex: texture_2d<f32>,
  slopeAspectTex: texture_2d<f32>,
  cfg: TerrainConfig,
  x: f32,
  z: f32,
) -> TerrainSample {
  let n = i32(cfg.gridN);
  let cx = terrain_locate(x, cfg.cellM, n);
  let cz = terrain_locate(z, cfg.cellM, n);
  let i0 = i32(cx.x);
  let j0 = i32(cz.x);
  let tx = cx.y;
  let tz = cz.y;

  let p00 = vec2<i32>(i0, j0);
  let p10 = vec2<i32>(i0 + 1, j0);
  let p01 = vec2<i32>(i0, j0 + 1);
  let p11 = vec2<i32>(i0 + 1, j0 + 1);

  let h00 = textureLoad(heightTex, p00, 0).x;
  let h10 = textureLoad(heightTex, p10, 0).x;
  let h01 = textureLoad(heightTex, p01, 0).x;
  let h11 = textureLoad(heightTex, p11, 0).x;
  let top = h00 + tx * (h10 - h00);
  let bot = h01 + tx * (h11 - h01);
  let height = top + tz * (bot - top);

  let g00 = terrain_decode_gradient(textureLoad(slopeAspectTex, p00, 0).xy);
  let g10 = terrain_decode_gradient(textureLoad(slopeAspectTex, p10, 0).xy);
  let g01 = terrain_decode_gradient(textureLoad(slopeAspectTex, p01, 0).xy);
  let g11 = terrain_decode_gradient(textureLoad(slopeAspectTex, p11, 0).xy);
  let gTop = g00 + tx * (g10 - g00);
  let gBot = g01 + tx * (g11 - g01);
  let g = gTop + tz * (gBot - gTop);

  var out: TerrainSample;
  out.height = height;
  out.slopeTan = length(g);
  out.aspect = select(terrain_azimuth(-g.x, -g.y), 0.0, g.x == 0.0 && g.y == 0.0);
  out.normal = normalize(vec3<f32>(-g.x, 1.0, -g.y));
  return out;
}
