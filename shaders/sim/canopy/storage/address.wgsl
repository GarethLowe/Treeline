// WP 3.1 — canopy sparse addressing. Appended to the prelude emitted by
// src/sim/canopy/storage/shaders.ts, which declares every constant and binding used here so
// there is exactly one definition of the layout and it lives in TypeScript.
//
// The vertical axis is HEIGHT ABOVE GROUND. `canopyGround[column]` is the terrain elevation
// at the column centre, so voxel (i, j, k) is the axis-aligned world box
//
//     x ∈ [i·CELL, (i+1)·CELL],  z ∈ [j·CELL, (j+1)·CELL],
//     y ∈ [ground(i,j) + k·CELL, ground(i,j) + (k+1)·CELL]
//
// A ray marcher works in world space and calls `canopy_sample_at` per step; that is one extra
// f32 load against the alternative of not fitting the domain in 64 levels at all.

fn canopy_ground_at(i: i32, j: i32) -> f32 {
  let ci = clamp(i, 0, i32(CANOPY_NXY) - 1);
  let cj = clamp(j, 0, i32(CANOPY_NXY) - 1);
  return canopyGround[u32(cj) * CANOPY_NXY + u32(ci)];
}

/// Packed voxel index, or CANOPY_INVALID. The exact twin of `lookup()` in layout.ts.
fn canopy_lookup(i: i32, j: i32, k: i32) -> u32 {
  if (i < 0 || j < 0 || k < 0 ||
      u32(i) >= CANOPY_NXY || u32(j) >= CANOPY_NXY || u32(k) >= CANOPY_NZ) {
    return CANOPY_INVALID;
  }
  let col = canopyColumns[u32(j) * CANOPY_NXY + u32(i)];
  let zStart = i32(col.header & CANOPY_Z_MASK);
  let zCount = i32((col.header >> CANOPY_ZCOUNT_SHIFT) & CANOPY_Z_MASK);
  let d = k - zStart;
  if (d < 0 || d >= zCount) { return CANOPY_INVALID; }
  return col.offset + u32(d);
}

/// World position to voxel coordinate. k may fall outside [0, CANOPY_NZ); canopy_lookup
/// rejects it. Columns are clamped only for the ground fetch, never for the returned i/j.
fn canopy_voxel_coord(p: vec3f) -> vec3i {
  let i = i32(floor(p.x * CANOPY_INV_CELL));
  let j = i32(floor(p.z * CANOPY_INV_CELL));
  let agl = p.y - canopy_ground_at(i, j);
  return vec3i(i, j, i32(floor(agl * CANOPY_INV_CELL)));
}

/// Centre of voxel (i, j, k) in world space.
fn canopy_voxel_centre(i: i32, j: i32, k: i32) -> vec3f {
  return vec3f(
    (f32(i) + 0.5) * CANOPY_CELL,
    canopy_ground_at(i, j) + (f32(k) + 0.5) * CANOPY_CELL,
    (f32(j) + 0.5) * CANOPY_CELL
  );
}

/// One-shot world-space sample: packed index or CANOPY_INVALID.
fn canopy_sample_at(p: vec3f) -> u32 {
  let c = canopy_voxel_coord(p);
  return canopy_lookup(c.x, c.y, c.z);
}

// --- pool A (hot state) -----------------------------------------------------
// word0: temperature f16 | foliage dry-mass fraction unorm16
// word1: 0-3 mm fraction unorm16 | 3-6 mm fraction unorm16
// word2: free water f16 | bound water f16   [kg m⁻³]
// word3: char unorm8 | phase u8 | pyrolysate flux f16

fn canopy_pack_word0(temperatureK: f32, foliageFraction: f32) -> u32 {
  return (pack2x16float(vec2f(temperatureK, 0.0)) & 0xffffu) |
         (u32(saturate(foliageFraction) * 65535.0 + 0.5) << 16u);
}
fn canopy_temperature(v: u32) -> f32 {
  return unpack2x16float(canopyPoolA[v].x & 0xffffu).x;
}
fn canopy_foliage_fraction(v: u32) -> f32 {
  return f32(canopyPoolA[v].x >> 16u) * (1.0 / 65535.0);
}
fn canopy_pack_water(freeKgM3: f32, boundKgM3: f32) -> u32 {
  return pack2x16float(vec2f(freeKgM3, boundKgM3));
}
fn canopy_free_water(v: u32) -> f32 { return unpack2x16float(canopyPoolA[v].z).x; }
fn canopy_bound_water(v: u32) -> f32 { return unpack2x16float(canopyPoolA[v].z).y; }
fn canopy_char_fraction(v: u32) -> f32 { return f32(canopyPoolA[v].w & 0xffu) * (1.0 / 255.0); }
fn canopy_phase(v: u32) -> u32 { return (canopyPoolA[v].w >> 8u) & 0xffu; }

// --- pool B (static after build) --------------------------------------------
// word0: LAD f16 | initial dry bulk density f16
// word1: SAV code u8 | species id u8 | clumping unorm8 | bark class u8

fn canopy_lad(v: u32) -> f32 { return unpack2x16float(canopyPoolB[v].x).x; }
fn canopy_dry_density(v: u32) -> f32 { return unpack2x16float(canopyPoolB[v].x).y; }
fn canopy_sav(v: u32) -> f32 {
  return CANOPY_SAV_MIN * exp(f32(canopyPoolB[v].y & 0xffu) * CANOPY_SAV_DECODE);
}
fn canopy_species(v: u32) -> u32 { return (canopyPoolB[v].y >> 8u) & 0xffu; }
fn canopy_clumping(v: u32) -> f32 {
  return f32((canopyPoolB[v].y >> 16u) & 0xffu) * (1.0 / 255.0);
}
fn canopy_bark_class(v: u32) -> u32 { return (canopyPoolB[v].y >> 24u) & 0xffu; }

/// Beer–Lambert extinction coefficient, m⁻¹ (spec §30 §7.3: κ = G·Ω_c·LAD, G = 0.5 for a
/// spherical leaf-angle distribution). Here so radiation and convection cannot disagree.
fn canopy_extinction(v: u32) -> f32 {
  return CANOPY_G_SPHERICAL * canopy_clumping(v) * canopy_lad(v);
}
