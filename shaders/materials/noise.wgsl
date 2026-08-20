// Deterministic tileable noise. WP 1.6.
//
// EXACT mirror of src/render/materials/noise.ts. The TypeScript version is the oracle: it is
// unit-tested on the CLI, and this file must produce the same structure so that a readback of
// a GPU-generated layer can be compared against a CPU bake.
//
// Two properties are load-bearing and are why this is not "just some noise":
//
//  1. All hashing is integer u32. `Math.imul` in JS is exactly WGSL's wrapping u32 multiply,
//     and `>>> 0` is exactly u32 truncation, so the two implementations agree bit for bit on
//     the lattice values. Only the interpolation is float, and there a 1e-7 f32/f64
//     difference is far below one 8-bit texel step.
//  2. All noise is periodic on an integer lattice, given separately in u and v. A material
//     texture that does not tile seamlessly is useless, and periodicity is a property of the
//     lattice indices — it has to be built in, not bolted on with a mirror trick. Unequal
//     periods are what give bark its anisotropy (fissures run along the trunk) while keeping
//     the tile seamless; scaling the input coordinates instead would break the tiling.

// Wellons' `lowbias32` avalanche. Chosen over `fract(sin(dot(...)) * 43758.5453)`, which has
// visible structure, is not stable across GPUs (it depends on `sin` precision) and cannot be
// reproduced on the CPU at all.
fn hashU32(x: u32) -> u32 {
  var h: u32 = x;
  h = h ^ (h >> 16u);
  h = h * 0x7feb352du;
  h = h ^ (h >> 15u);
  h = h * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return h;
}

fn hash2i(ix: i32, iy: i32, seed: u32) -> u32 {
  let a: u32 = u32(ix) * 0x27d4eb2du;
  let b: u32 = u32(iy) * 0x165667b1u;
  let c: u32 = seed * 0x9e3779b1u;
  return hashU32(a ^ b ^ c);
}

fn hash2iAlt(ix: i32, iy: i32, seed: u32) -> u32 {
  return hashU32(hash2i(ix, iy, seed) ^ 0x85ebca6bu);
}

// u32 -> [0,1). Uses the top 24 bits, which are the well-mixed ones.
fn u32ToUnit(h: u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// Positive modulo. `-1 % 8` is `-1` in both JS and WGSL; the lattice needs `7`.
fn wrapI(i: i32, period: i32) -> i32 {
  let m = i % period;
  return select(m, m + period, m < 0);
}

// Perlin's improved fade. C2 continuous, so derived normals stay smooth.
fn fadeQuintic(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn clamp01f(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

// Matches the TypeScript `smoothstep`, including its degenerate-edge behaviour: WGSL's
// built-in smoothstep is undefined when low == high, and several call sites here can reach
// that (a crack mask at zero char, for one).
fn smoothstepSafe(edge0: f32, edge1: f32, x: f32) -> f32 {
  let d = edge1 - edge0;
  if (abs(d) < 1e-9) {
    return select(1.0, 0.0, x < edge0);
  }
  let t = clamp01f((x - edge0) / d);
  return t * t * (3.0 - 2.0 * t);
}

// Value noise on a px x py lattice over the unit square, seamlessly periodic. Result [0,1].
fn valueNoise2P(u: f32, v: f32, px: i32, py: i32, seed: u32) -> f32 {
  let x = u * f32(px);
  let y = v * f32(py);
  let x0 = floor(x);
  let y0 = floor(y);
  let fx = fadeQuintic(x - x0);
  let fy = fadeQuintic(y - y0);
  let ix0 = wrapI(i32(x0), px);
  let iy0 = wrapI(i32(y0), py);
  let ix1 = wrapI(i32(x0) + 1, px);
  let iy1 = wrapI(i32(y0) + 1, py);
  let n00 = u32ToUnit(hash2i(ix0, iy0, seed));
  let n10 = u32ToUnit(hash2i(ix1, iy0, seed));
  let n01 = u32ToUnit(hash2i(ix0, iy1, seed));
  let n11 = u32ToUnit(hash2i(ix1, iy1, seed));
  return mix(mix(n00, n10, fx), mix(n01, n11, fx), fy);
}

// fBm over periodic value noise. Lacunarity is fixed at 2 so each octave's lattice period
// stays an integer multiple of the base, which is what keeps the SUM periodic. A non-integer
// lacunarity gives a beautiful field that does not tile.
fn fbm2P(u: f32, v: f32, px: i32, py: i32, seed: u32, octaves: i32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var sx = px;
  var sy = py;
  for (var i = 0; i < octaves; i = i + 1) {
    sum = sum + amp * valueNoise2P(u, v, sx, sy, seed + u32(i) * 131u);
    norm = norm + amp;
    amp = amp * gain;
    sx = sx * 2;
    sy = sy * 2;
  }
  return select(0.0, sum / norm, norm > 0.0);
}

// Ridged fBm: `1 - |2n - 1|` raised to a sharpening power. Creases rather than blobs, which
// is what bark fissures and rock fractures actually look like.
fn ridged2P(u: f32, v: f32, px: i32, py: i32, seed: u32, octaves: i32, sharpness: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var sx = px;
  var sy = py;
  for (var i = 0; i < octaves; i = i + 1) {
    let n = valueNoise2P(u, v, sx, sy, seed + u32(i) * 131u);
    let r = 1.0 - abs(2.0 * n - 1.0);
    sum = sum + amp * pow(r, sharpness);
    norm = norm + amp;
    amp = amp * 0.5;
    sx = sx * 2;
    sy = sy * 2;
  }
  return select(0.0, sum / norm, norm > 0.0);
}

struct WorleyResult {
  f1: f32,     // distance to nearest feature point, cell units
  f2: f32,     // distance to second nearest; f2-f1 is the cell-boundary distance field
  cell: u32,   // hash of the nearest cell — a stable per-cell id
}

// Periodic Worley. `f2 - f1` is the quantity this project wants: ~0 exactly on a cell
// boundary, growing toward cell interiors. That is a bark furrow, a rock fracture and an
// alligator char crack all at once, and spec 7.6 specifies the crack field as precisely this.
fn worley2P(u: f32, v: f32, px: i32, py: i32, seed: u32) -> WorleyResult {
  let x = u * f32(px);
  let y = v * f32(py);
  let cx = i32(floor(x));
  let cy = i32(floor(y));
  var f1 = 1e9;
  var f2 = 1e9;
  var cell: u32 = 0u;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let gx = cx + dx;
      let gy = cy + dy;
      let wx = wrapI(gx, px);
      let wy = wrapI(gy, py);
      let h = hash2i(wx, wy, seed);
      let h2 = hash2iAlt(wx, wy, seed);
      // The 0.1 inset keeps feature points off the exact cell boundary, where f2-f1 would
      // otherwise be identically zero along a whole edge.
      let fxp = f32(gx) + 0.1 + 0.8 * u32ToUnit(h);
      let fyp = f32(gy) + 0.1 + 0.8 * u32ToUnit(h2);
      let ddx = fxp - x;
      let ddy = fyp - y;
      let d = sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        cell = h;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return WorleyResult(f1, f2, cell);
}

// Domain warp, kept periodic by warping with periodic noise and expressing the offset in
// unit-square coordinates.
fn warp2P(u: f32, v: f32, px: i32, py: i32, seed: u32, amount: f32) -> vec2<f32> {
  let wu = valueNoise2P(u, v, px, py, seed) - 0.5;
  let wv = valueNoise2P(u, v, px, py, seed ^ 0x51ed270bu) - 0.5;
  return vec2<f32>(u + amount * wu / f32(px), v + amount * wv / f32(py));
}

fn rotate2(x: f32, y: f32, angle: f32) -> vec2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(c * x - s * y, s * x + c * y);
}

// Per-cell attribute in [0,1) from a cell hash and a stream index.
fn cellUnit(cellHash: u32, stream: u32) -> f32 {
  return u32ToUnit(hashU32(cellHash ^ ((stream + 1u) * 0x9e3779b1u)));
}
