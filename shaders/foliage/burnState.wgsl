// Per-instance burn memory. Spec §7.6(c).
//
// A tree that has burned stays burned, and that is not automatic. WP 2.4's consumed fraction
// IS monotonic by construction — §7.6(d) requires that ground can never un-burn — but char
// HEIGHT up a trunk is a function of flame length, and flame length is a function of the
// fireline intensity, which is instantaneous. Reading it directly would char a trunk as the
// front arrived and then un-char it as the front moved on.
//
// So each tree remembers the strongest fire it has ever stood in. `atomicMax` makes that
// order-free across the dispatch and monotonic by the operator rather than by convention.

struct BurnStateU {
  // x = domain size m, y = instance count, z/w unused
  params : vec4<f32>,
};

@group(0) @binding(0) var<uniform> bsU : BurnStateU;
@group(0) @binding(1) var<storage, read> bsInstances : array<TreeInstance>;
@group(0) @binding(2) var<storage, read_write> bsPeak : array<atomic<u32>>;
@group(0) @binding(3) var bsIntensity : texture_2d<f32>;
// How much of this stem's CROWN the 3D canopy has consumed, unorm x BURN_CROWN_SCALE.
//
// Without this a tree could not take part in a crown fire it was standing in. The stem burn
// coordinate is gated by `1 - height/charReach`, and char reach is Byram flame length -- two
// to seven metres. Conifer foliage starts at eight, so the gate was identically zero over
// every needle on the tree and the crown stayed green through 100 % crown fraction burned.
// M3 has known which foliage burned all along; nothing read it.
@group(0) @binding(4) var<storage, read_write> bsCrown : array<atomic<u32>>;

@compute @workgroup_size(64)
fn csBurnState(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u32(bsU.params.y)) { return; }

  let dims = vec2<i32>(textureDimensions(bsIntensity, 0));
  // 1x1 stand-in: no fire solver attached, so there is nothing to remember.
  if (dims.x <= 1) { return; }

  let inst = bsInstances[i];
  let uv = vec2<f32>(inst.posX, inst.posZ) / bsU.params.x * vec2<f32>(dims);
  let t = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(dims) - vec2<f32>(1.0)));
  // --- Crown consumption, from the canopy voxel field -------------------------
  //
  // The column through the stem, which passes through the middle of its own crown. A crown is
  // wider than one 2 m column, so this is the centre sample rather than a volume average --
  // honest for what it drives (which stage of green/scorch/char/ash the whole tree renders at)
  // and not enough for 7.6(c)'s vertical profile, which wants the column resolved.
  //
  // atomicMax for the same reason `bsPeak` uses it: monotonic by the operator. Foliage mass is
  // consumed monotonically, but a voxel's char FRACTION is read one frame at a time and the
  // front moves, so taking the running maximum is what stops a crown un-burning behind it.
  let ci = i32(inst.posX * CANOPY_INV_CELL);
  let cj = i32(inst.posZ * CANOPY_INV_CELL);
  if (ci >= 0 && cj >= 0 && ci < i32(CANOPY_NXY) && cj < i32(CANOPY_NXY)) {
    let col = canopyColumns[u32(cj) * CANOPY_NXY + u32(ci)];
    let zCount = (col.header >> CANOPY_ZCOUNT_SHIFT) & CANOPY_Z_MASK;
    var initial = 0.0;
    var gone = 0.0;
    for (var d = 0u; d < zCount; d = d + 1u) {
      let v = col.offset + d;
      let dry = canopy_dry_density(v);
      if (!(dry > 0.0)) { continue; }
      initial = initial + dry;
      // Consumed = what is no longer live foliage. Char counts: a charred needle is not green.
      gone = gone + dry * clamp(1.0 - canopy_foliage_fraction(v), 0.0, 1.0);
    }
    if (initial > 0.0) {
      let frac = clamp(gone / initial, 0.0, 1.0);
      atomicMax(&bsCrown[i], u32(frac * BURN_CROWN_SCALE));
    }
  }

  let intensity = textureLoad(bsIntensity, t, 0).r;   // kW/m
  if (intensity <= 0.0) { return; }

  atomicMax(&bsPeak[i], u32(clamp(intensity * BURN_PEAK_SCALE, 0.0, 4.0e9)));
}
