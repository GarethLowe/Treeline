// The shared alligator-crack field. WP 1.6, spec 7.6.
//
// Requires noise.wgsl and patterns.wgsl to be prepended.
//
// ONE tiling texture serves every burnable material in the world. That is spec 7.6's answer
// to the texture-explosion problem: cracking is not per-object art, it is a distance field
// evaluated at shade time against the LIVE char fraction, so a trunk charred to 4 m has open
// cracks below that line and none above it without any per-instance texture existing.
//
// Channels:
//   R = D, the normalised Worley boundary distance. `m_crack = smoothstep(0.5-0.35c, 0.5, D)`
//   G = cell id, a stable per-plate hash for tinting and for per-plate ember variation
//   B = dD/du, remapped to [0,1]
//   A = dD/dv, remapped to [0,1]
//
// B and A exist because the sampling shader needs the crack field's GRADIENT to perturb the
// surface normal, and `dpdx`/`dpdy` are fragment-only and would also differentiate the wrong
// thing (screen space, not texture space). Storing the analytic gradient costs two otherwise
// wasted channels and makes the crack normal available in compute and vertex stages too.

struct CrackParams {
  // period (Worley cells across the tile), seed, size, unused
  dims : vec4<u32>,
}

@group(0) @binding(0) var<uniform> crackParams : CrackParams;
@group(0) @binding(1) var crackOut : texture_storage_2d_array<rgba8unorm, write>;

// Gradient scale. dD/du is in units of "D per unit UV"; a 24-cell field has |dD/du| up to
// roughly 2*period/0.45, so this normalises into [-1,1] for the 8-bit encode. Overflow is
// clamped, which flattens the very sharpest crack walls slightly rather than wrapping them —
// wrapping would put an inverted normal at the bottom of every crack.
const CRACK_GRAD_SCALE: f32 = 0.0075;

@compute @workgroup_size(8, 8, 1)
fn generateCrack(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = crackParams.dims.z;
  if (gid.x >= size || gid.y >= size) { return; }

  let period = i32(crackParams.dims.x);
  let seed = crackParams.dims.y;
  let texel = 1.0 / f32(size);
  let u = (f32(gid.x) + 0.5) * texel;
  let v = (f32(gid.y) + 0.5) * texel;

  let d = crackDistance(u, v, period, seed);
  let cell = crackCellId(u, v, period, seed);

  let dL = crackDistance(u - texel, v, period, seed);
  let dR = crackDistance(u + texel, v, period, seed);
  let dD = crackDistance(u, v - texel, period, seed);
  let dU = crackDistance(u, v + texel, period, seed);
  let gu = (dR - dL) / (2.0 * texel);
  let gv = (dU - dD) / (2.0 * texel);

  textureStore(crackOut, vec2<i32>(i32(gid.x), i32(gid.y)), 0, vec4<f32>(
    d,
    cell,
    clamp01f(gu * CRACK_GRAD_SCALE * 0.5 + 0.5),
    clamp01f(gv * CRACK_GRAD_SCALE * 0.5 + 0.5)));
}
