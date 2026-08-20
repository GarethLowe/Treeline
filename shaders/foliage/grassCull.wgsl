// Grass tile cull and indirect-argument authoring.
//
// The field is diced into tiles; one draw instance is one tile. This pass tests every
// candidate tile in a square around the camera, assigns the survivors to a distance band, and
// appends them to that band's tile list. A second tiny kernel turns the per-band tile counts
// into the per-band indirect draw arguments.
//
// It also accumulates the EXACT number of blades the draw will rasterise, because the
// per-tile active-slot count is deterministic. `FoliageStats.grassBladesDrawn` is therefore a
// count, not an estimate — which matters, because the whole open question in spec §7.4 is
// whether the grass cost model is right, and you cannot check a cost model against a guess.

@group(1) @binding(0) var<uniform> grassU: GrassUniform;
@group(1) @binding(1) var<storage, read_write> tileLists: array<u32>;
@group(1) @binding(2) var<storage, read_write> tileCounts: array<atomic<u32>>;
@group(1) @binding(3) var<storage, read_write> grassDrawArgs: array<u32>;
// The same control buffer the tree cull uses; the stats block sits at its base.
@group(1) @binding(4) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(5) var heightTex: texture_2d<f32>;

// A vertex count this large means a mis-set density, not a legitimate draw. Clamping keeps a
// bad uniform from turning into a multi-second stall.
const MAX_BAND_VERTS: u32 = 1u << 24u;

fn bandOfDistance(distanceM: f32) -> i32 {
  for (var b = 0u; b < grassU.bandCount; b = b + 1u) {
    let near = bandEdgeAt(grassU, b);
    let far = bandEdgeAt(grassU, b + 1u);
    if (distanceM >= near && distanceM < far) {
      return i32(b);
    }
  }
  // A tile sitting exactly on the outer edge belongs to the last band (with zero active
  // slots) rather than falling through the gap between "in a band" and "beyond the field".
  if (grassU.bandCount > 0u && distanceM == bandEdgeAt(grassU, grassU.bandCount)) {
    return i32(grassU.bandCount) - 1;
  }
  return -1;
}

@compute @workgroup_size(GRASS_WG)
fn cullTiles(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let span = grassU.tileSpanTiles;
  let i = gid.x + gid.y * (nwg.x * GRASS_WG);
  if (span == 0u || i >= span * span) {
    return;
  }

  let radius = i32(span / 2u);
  let tx = grassU.cameraTileX - radius + i32(i % span);
  let tz = grassU.cameraTileZ - radius + i32(i / span);
  if (tx < 0 || tz < 0 || tx >= i32(grassU.domainTiles) || tz >= i32(grassU.domainTiles)) {
    return;
  }

  let cx = (f32(tx) + 0.5) * grassU.tileSizeM;
  let cz = (f32(tz) + 0.5) * grassU.tileSizeM;
  let distanceM = length(vec2<f32>(cx, cz) - frame.cameraPos.xz);
  let band = bandOfDistance(distanceM);
  if (band < 0) {
    return;
  }

  // The tile's bounding sphere must cover its footprint, its blades, and whatever relief the
  // terrain has inside it. Erring large costs a few wasted vertex invocations; erring small
  // deletes a patch of ground that is visible over a ridge.
  let groundY = terrainHeightAt(heightTex, cx, cz);
  let sphereRadius = length(vec2<f32>(grassU.tileSizeM, grassU.tileSizeM)) * 0.5 +
    grassU.bladeHeightMax + grassU.verticalMarginM;
  if (!sphereInFrustum(vec3<f32>(cx, groundY + grassU.verticalMarginM, cz), sphereRadius)) {
    return;
  }

  let b = u32(band);
  let slot = atomicAdd(&tileCounts[b], 1u);
  if (slot >= grassU.tileCapacityPerBand) {
    atomicAdd(&control[STATS_CLAMP_EVENTS], 1u);
    return;
  }
  tileLists[b * grassU.tileCapacityPerBand + slot] = (u32(tx) & 0xffffu) | ((u32(tz) & 0xffffu) << 16u);

  atomicAdd(&control[STATS_GRASS_TILES], 1u);
  atomicAdd(&control[STATS_GRASS_BLADES], activeSlotsForTile(grassU, distanceM, b));
}

@compute @workgroup_size(GRASS_WG)
fn writeArgs(@builtin(local_invocation_index) tid: u32) {
  if (tid >= grassU.bandCount) {
    return;
  }
  let count = min(atomicLoad(&tileCounts[tid]), grassU.tileCapacityPerBand);
  let verts = min(bladeSlotsForBand(grassU, tid) * VERTS_PER_BLADE, MAX_BAND_VERTS);
  let o = tid * 4u;
  grassDrawArgs[o + 0u] = verts;
  grassDrawArgs[o + 1u] = count;
  grassDrawArgs[o + 2u] = 0u;
  grassDrawArgs[o + 3u] = 0u;
}
