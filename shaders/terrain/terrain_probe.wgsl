// CPU/GPU agreement probe — work package 1.2 acceptance.
//
// Samples the terrain textures at a list of world positions using the shared helpers in
// terrain_sample.wgsl (which is prepended to this source at pipeline creation), and writes
// the results to a storage buffer. The host compares them against the CPU queries.
//
// This is the only honest way to test "CPU query matches GPU texture": the comparison has
// to go through the same texture fetch and the same f16 dequantisation that the real
// consumers use, on the real device. Comparing the CPU query against the bytes we uploaded
// would only prove we can read our own arrays back.

struct ProbeResult {
  height: f32,
  slopeTan: f32,
  aspect: f32,
  nx: f32,
  ny: f32,
  nz: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var heightTex: texture_2d<f32>;
@group(0) @binding(1) var slopeAspectTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> cfg: TerrainConfig;
@group(0) @binding(3) var<storage, read> positions: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> results: array<ProbeResult>;

@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= cfg.probeCount) {
    return;
  }
  let p = positions[i];
  let s = terrain_sample(heightTex, slopeAspectTex, cfg, p.x, p.y);
  var r: ProbeResult;
  r.height = s.height;
  r.slopeTan = s.slopeTan;
  r.aspect = s.aspect;
  r.nx = s.normal.x;
  r.ny = s.normal.y;
  r.nz = s.normal.z;
  r._pad0 = 0.0;
  r._pad1 = 0.0;
  results[i] = r;
}
