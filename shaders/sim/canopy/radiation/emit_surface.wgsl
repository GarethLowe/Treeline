// Surface flame panels -> the emitter list WP 3.3's `scatter()` consumes.
//
// This pass did not exist. `CanopyRadiation.encode` takes an `emitters` buffer and an
// `emitterCount` and nothing in the tree produced either, which is why the canopy solver was
// never composed: WP 3.3 shipped complete from the cluster scatter onward and simply had no
// feeder. `src/sim/canopy/radiation/emitters.ts` is the oracle for the arithmetic below —
// `surfaceFlameEmitter()`, transliterated, and it stays the authority if the two disagree.
//
// One invocation per surface cell over the whole 2048^2 grid. That sounds expensive and is
// not: it runs at RAD_UPDATE_HZ (7.5 Hz), not per substep, because the irradiance field's
// physical timescale is minutes (spec §7.5). Two texture loads and an early-out for the ~99.9%
// of cells that are not burning.
//
// The emitter count is written by an atomic and consumed on the GPU — copied into the cluster
// params and turned into an indirect dispatch by `args()`. Reading it back to the CPU would
// cost a frame of latency and, worse, would make the scatter dispatch disagree with the buffer
// it is scanning: too low silently drops fire, too high re-reads the previous step's records
// and invents energy that is no longer burning.

const STATE_BURNING: u32 = 1u;

// Stefan-Boltzmann, W m^-2 K^-4.
const SIGMA: f32 = 5.670374419e-8;

// ## The vertical axis is HEIGHT ABOVE GROUND
//
// Emitters are placed at the flame's mid-height *above the ground under the cell*, not at an
// absolute elevation. The radiation grid spans RAD_NK * RAD_CELL_M = 128 m from its origin,
// and this project's terrain sits at 1942-2078 m above sea level, so an absolute-Y grid puts
// the entire radiative field a kilometre and a half underground: every emitter falls outside
// it, every gather returns zero, and nothing reports an error. WP 3.1 made the same call for
// the voxel store and called it forced. It is.
//
// The consequence is that ray paths are computed in terrain-following coordinates. Exact on
// flat ground; on a slope the path length errs by the slope cosine, ~10 % at 25 degrees.
// ponytail: bind the ground buffer to the gather and convert per sample if that matters.

struct EmitParams {
  // Surface grid.
  cells: u32,
  _pad0: u32,
  cellM: f32,
  _pad2: f32,

  // Flame optics (§7.3). `flameDepth` is D = R * t_r; `absorption` is k_f, §7.7's
  // calibration knob #1. Only the product k_f*D enters the emissivity.
  flameDepth: f32,
  absorption: f32,
  temperature: f32,
  maxRadiantFraction: f32,

  // Flame tilt from vertical and the direction it leans, radians. Wind-driven; constant
  // across the domain until M5's wind field makes it per-cell.
  tilt: f32,
  heading: f32,
  // Hard cap on emitters written. Overflow is counted, never wrapped.
  capacity: u32,
  _pad1: u32,
};

struct RadEmitter {
  pos: vec4f,   // xyz world m, w = radiant power W
  aux: vec4f,   // x = RMS radius about its own centroid, m
};

@group(0) @binding(0) var<uniform> params: EmitParams;
@group(0) @binding(1) var intensityTex: texture_2d<f32>;   // r16float, kW/m
@group(0) @binding(2) var stateTex: texture_2d<u32>;       // r8uint lifecycle
@group(0) @binding(4) var<storage, read_write> emitters: array<RadEmitter>;
// [0] = emitters written, [1..3] = indirect dispatch args for scatter, [4] = overflow count.
@group(0) @binding(5) var<storage, read_write> counter: array<atomic<u32>>;

const CT_COUNT: u32 = 0u;
const CT_ARG_X: u32 = 1u;
const CT_ARG_Y: u32 = 2u;
const CT_ARG_Z: u32 = 3u;
const CT_OVERFLOW: u32 = 4u;

// Byram (1959) flame length, L = 0.0775 * I^0.46 with I in kW/m. Mirrors `flameLength()`.
fn flameLength(intensityKwM: f32) -> f32 {
  if (!(intensityKwM > 0.0)) { return 0.0; }
  return 0.0775 * pow(intensityKwM, 0.46);
}

@compute @workgroup_size(64)
fn reset(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x == 0u) {
    atomicStore(&counter[CT_COUNT], 0u);
    atomicStore(&counter[CT_OVERFLOW], 0u);
    // y and z stay 1 for the indirect dispatch; x is written by args().
    atomicStore(&counter[CT_ARG_X], 0u);
    atomicStore(&counter[CT_ARG_Y], 1u);
    atomicStore(&counter[CT_ARG_Z], 1u);
  }
}

@compute @workgroup_size(8, 8)
fn emit(@builtin(global_invocation_id) gid: vec3u) {
  let n = params.cells;
  if (gid.x >= n || gid.y >= n) { return; }
  let coord = vec2i(i32(gid.x), i32(gid.y));

  // Only the flaming band radiates. A BURNT cell is still smouldering — `consumed` keeps
  // climbing — but it has no flame sheet, and treating it as one would leave a growing disc
  // of phantom emitters behind the front instead of a ring.
  if (textureLoad(stateTex, coord, 0).r != STATE_BURNING) { return; }

  let intensity = textureLoad(intensityTex, coord, 0).r;
  if (!(intensity > 0.0)) { return; }

  let lf = flameLength(intensity);
  if (!(lf > 0.0)) { return; }

  // eps_f = 1 - exp(-k_f * D): an optically thin flame radiates less than a black one.
  let eps = 1.0 - exp(-params.absorption * params.flameDepth);
  let t = params.temperature;
  let panel = eps * SIGMA * t * t * t * t * lf * params.cellM;
  // Never radiate more than the fire releases. I is kW per metre of front; this cell is
  // `cellM` metres of front.
  let cap = params.maxRadiantFraction * intensity * 1000.0 * params.cellM;
  let powerW = min(panel, max(0.0, cap));
  if (!(powerW > 0.0)) { return; }

  let slot = atomicAdd(&counter[CT_COUNT], 1u);
  if (slot >= params.capacity) {
    // Undo the increment so the count stays truthful, and record the loss. A count past the
    // capacity would make the indirect dispatch read past the buffer.
    atomicSub(&counter[CT_COUNT], 1u);
    atomicAdd(&counter[CT_OVERFLOW], 1u);
    return;
  }

  let world = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) * params.cellM;

  // Radiative centroid: half way up the TILTED flame axis. That displacement downwind and up
  // is the whole of the forward-preheating asymmetry, and it costs one sin/cos pair. Y is
  // height above the ground under this cell, which is zero by construction — see the header.
  let half = 0.5 * lf;
  let sinT = sin(params.tilt);
  emitters[slot] = RadEmitter(
    vec4f(
      world.x + half * sinT * cos(params.heading),
      half * cos(params.tilt),
      world.y + half * sinT * sin(params.heading),
      powerW,
    ),
    // RMS radius of a uniform L_f by dx rectangle about its centre.
    vec4f(sqrt((lf * lf + params.cellM * params.cellM) / 12.0), 0.0, 0.0, 0.0),
  );
}

@compute @workgroup_size(1)
fn args() {
  let n = atomicLoad(&counter[CT_COUNT]);
  // CLUSTER_WORKGROUP invocations per group, matching clusters.wgsl's scatter().
  atomicStore(&counter[CT_ARG_X], (n + CLUSTER_WG - 1u) / CLUSTER_WG);
}
