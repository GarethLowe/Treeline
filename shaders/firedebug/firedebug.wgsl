// Fire debug overlay — work package 2.6.
//
// PROVISIONAL. M4 owns fire rendering; this draws the solver's output textures flat onto the
// terrain so M2 can be looked at while it is being written. No particles, no volumetrics, no
// attempt at realism — that work belongs to the froxel pass and duplicating it here would
// create a second thing to keep in sync with the physics.
//
// Geometry: a procedural grid over the 1 km domain, no vertex or index buffer. Vertices are
// lifted to the heightfield in the vertex shader and pushed `liftM` up the Y axis so the
// overlay wins the depth test against the terrain mesh without needing a depth bias whose
// sign depends on the caller's depth convention.
//
// The colour ramps are NOT authored here. `src/render/firedebug/shaders.ts` generates them
// from the tables in `views.ts`, which is also what the legend and the CPU oracle read, so
// the picture, the legend and the test cannot drift apart.

struct FireDebugUniforms {
  viewProj : mat4x4<f32>,
  gridQuads : f32,
  domainM : f32,
  terrainGridN : f32,
  terrainCellM : f32,
  surfaceCells : f32,
  surfaceCellM : f32,
  liftM : f32,
  opacity : f32,
  viewId : u32,
  timeS : f32,
  isochroneS : f32,
  arrivalMaxS : f32,
  logIntensityMin : f32,
  logIntensityMax : f32,
  radianceScale : f32,
  _pad : f32,
}

@group(0) @binding(0) var<uniform> fdU : FireDebugUniforms;
@group(0) @binding(1) var fdHeight : texture_2d<f32>;
@group(0) @binding(2) var fdState : texture_2d<u32>;
@group(0) @binding(3) var fdIntensity : texture_2d<f32>;
@group(0) @binding(4) var fdArrival : texture_2d<f32>;
@group(0) @binding(5) var fdConsumed : texture_2d<f32>;

// Must match FIRE_DEBUG_VIEWS in views.ts.
const FD_VIEW_STATE : u32 = 0u;
const FD_VIEW_INTENSITY : u32 = 1u;
const FD_VIEW_ARRIVAL : u32 = 2u;
const FD_VIEW_CONSUMED : u32 = 3u;

// Matches ARRIVAL_NEVER / hasArrived() in views.ts. Rejects both the large sentinel and the
// zero a never-written texture holds, so it does not depend on which WP 2.2 chooses.
const FD_ARRIVAL_NEVER : f32 = 3.4e38;

fn fd_has_arrived(a : f32) -> bool {
  return a > 0.0 && a < FD_ARRIVAL_NEVER;
}

// Bilinear height fetch. Same texel rule as shaders/terrain/terrain_sample.wgsl (WP 1.2):
// texel (i, j) is the node at world ((i + 0.5) * cell, (j + 0.5) * cell), so
// f = world / cell - 0.5, and the clamp reproduces clamp-to-edge. textureLoad rather than a
// sampler, so no dependency on float32-filterable for the r32float height texture.
fn fd_height(x : f32, z : f32) -> f32 {
  let n = i32(fdU.terrainGridN);
  let fx = clamp(x / fdU.terrainCellM - 0.5, 0.0, f32(n - 1));
  let fz = clamp(z / fdU.terrainCellM - 0.5, 0.0, f32(n - 1));
  let i0 = min(i32(floor(fx)), n - 2);
  let j0 = min(i32(floor(fz)), n - 2);
  let tx = fx - f32(i0);
  let tz = fz - f32(j0);
  let h00 = textureLoad(fdHeight, vec2<i32>(i0, j0), 0).x;
  let h10 = textureLoad(fdHeight, vec2<i32>(i0 + 1, j0), 0).x;
  let h01 = textureLoad(fdHeight, vec2<i32>(i0, j0 + 1), 0).x;
  let h11 = textureLoad(fdHeight, vec2<i32>(i0 + 1, j0 + 1), 0).x;
  let top = h00 + tx * (h10 - h00);
  let bot = h01 + tx * (h11 - h01);
  return top + tz * (bot - top);
}

struct FdVsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec2<f32>,
}

// Two triangles per quad, corners bit-encoded x = i & 1, z = (i >> 1) & 1.
var<private> FD_QUAD : array<u32, 6> = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);

@vertex
fn vs_firedebug(@builtin(vertex_index) vi : u32) -> FdVsOut {
  let q = max(u32(fdU.gridQuads), 1u);
  let quad = vi / 6u;
  let corner = FD_QUAD[vi % 6u];
  let gx = f32(quad % q + (corner & 1u));
  let gz = f32(quad / q + ((corner >> 1u) & 1u));
  let step = fdU.domainM / f32(q);
  let world = vec2<f32>(gx * step, gz * step);

  var out : FdVsOut;
  out.world = world;
  out.clip = fdU.viewProj * vec4<f32>(world.x, fd_height(world.x, world.y) + fdU.liftM, world.y, 1.0);
  return out;
}

fn fd_ramp(which : u32, t : f32) -> vec3<f32> {
  let u = clamp(t, 0.0, 1.0) * f32(FD_RAMP_N - 1u);
  let i = min(u32(floor(u)), FD_RAMP_N - 1u);
  let j = min(i + 1u, FD_RAMP_N - 1u);
  let f = u - floor(u);
  if (which == FD_VIEW_INTENSITY) {
    return mix(FD_RAMP_INTENSITY[i], FD_RAMP_INTENSITY[j], f);
  }
  if (which == FD_VIEW_ARRIVAL) {
    return mix(FD_RAMP_ARRIVAL[i], FD_RAMP_ARRIVAL[j], f);
  }
  return mix(FD_RAMP_CONSUMED[i], FD_RAMP_CONSUMED[j], f);
}

@fragment
fn fs_firedebug(in : FdVsOut) -> @location(0) vec4<f32> {
  let cells = i32(fdU.surfaceCells);
  let cx = clamp(i32(floor(in.world.x / fdU.surfaceCellM)), 0, cells - 1);
  let cz = clamp(i32(floor(in.world.y / fdU.surfaceCellM)), 0, cells - 1);
  let cell = vec2<i32>(cx, cz);

  // Hoisted ABOVE every branch on purpose. `fwidth` may only be called from uniform control
  // flow, and "did the front reach this cell" is as non-uniform as it gets — Tint rejects the
  // module outright if this sits inside the arrival branch. One extra texture load in the
  // three views that do not use it is the price.
  let arrival = textureLoad(fdArrival, cell, 0).x;
  let phase = arrival / max(fdU.isochroneS, 1e-6);
  // Clamped because unarrived neighbours in the derivative quad hold a huge sentinel, and an
  // unbounded width would paint a spurious contour along the whole live front.
  let phaseWidth = clamp(fwidth(phase), 1e-6, 0.25) * 1.5;

  var rgb = vec3<f32>(0.0);
  var alpha = 0.0;

  if (fdU.viewId == FD_VIEW_STATE) {
    let s = min(textureLoad(fdState, cell, 0).x, 2u);
    let c = FD_STATE_COLORS[s];
    rgb = c.rgb;
    alpha = c.a;
  } else if (fdU.viewId == FD_VIEW_INTENSITY) {
    let kWm = textureLoad(fdIntensity, cell, 0).x;
    if (kWm > 0.0) {
      // Log scale: fireline intensity spans four decades between a creeping timber fire and
      // an extreme grass head fire, and a linear ramp shows one dot.
      let t = (log(kWm) - fdU.logIntensityMin) / max(fdU.logIntensityMax - fdU.logIntensityMin, 1e-6);
      rgb = fd_ramp(FD_VIEW_INTENSITY, t);
      alpha = 0.85;
    }
  } else if (fdU.viewId == FD_VIEW_ARRIVAL) {
    if (fd_has_arrived(arrival)) {
      let band = fd_ramp(FD_VIEW_ARRIVAL, arrival / max(fdU.arrivalMaxS, 1e-6));
      // Screen-space contour: a line wherever arrival crosses a multiple of the interval.
      // The `fwidth` term is what keeps it one pixel wide at every distance, and it is why
      // this term cannot live in the CPU oracle.
      let d = abs(fract(phase) - 0.5);
      let line = 1.0 - smoothstep(0.0, phaseWidth, 0.5 - d);
      rgb = mix(band * 0.7, vec3<f32>(1.0), line);
      alpha = 0.6 + 0.4 * line;
    }
  } else {
    let consumed = textureLoad(fdConsumed, cell, 0).x;
    if (consumed > 0.0) {
      rgb = fd_ramp(FD_VIEW_CONSUMED, consumed);
      alpha = 0.85;
    }
  }

  if (alpha <= 0.0) {
    discard;
  }
  // radianceScale exists because this is drawn into the linear-HDR world target, before
  // exposure and the ACES curve. At 1.0 the overlay is crushed to black in daylight.
  return vec4<f32>(rgb * fdU.radianceScale, alpha * fdU.opacity);
}
