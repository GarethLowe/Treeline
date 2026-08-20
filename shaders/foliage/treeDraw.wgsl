// Instanced tree draw, one indirect draw per (mesh, LOD) bucket.
//
// The vertex shader reads its instance out of the GPU-authored compacted list rather than
// from a vertex buffer with a per-instance step mode. That is what keeps `firstInstance` at
// zero and the whole path free of the `indirect-first-instance` feature: the bucket's base
// offset comes from `bucketBases[]`, and `@builtin(instance_index)` is the offset within it.

struct BucketUniform {
  bucketId: u32,
  // Carried alongside because the bucket base table lives inside the shared control buffer,
  // whose per-bucket sections are offset by the bucket count.
  bucketCount: u32,
  pad0: u32,
  pad1: u32,
};

@group(1) @binding(0) var<storage, read> instances: array<TreeInstance>;
@group(1) @binding(1) var<storage, read> meshTable: array<MeshEntry>;
@group(1) @binding(2) var<storage, read> compacted: array<u32>;
@group(1) @binding(3) var<storage, read> control: array<u32>;
@group(1) @binding(4) var<uniform> bucketU: BucketUniform;
@group(1) @binding(5) var<storage, read> materialParams: array<MaterialParams>;
@group(1) @binding(6) var occlusionTex: texture_2d<f32>;
@group(1) @binding(7) var<storage, read> burnPeak: array<u32>;
@group(1) @binding(8) var consumedTex: texture_2d<f32>;

fn bucketBase(bucket: u32) -> u32 {
  return control[CONTROL_HEADER_U32S + 2u * bucketU.bucketCount + bucket];
}

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) materialSlot: u32,
};

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) materialSlot: u32,
  @location(3) @interpolate(flat) fade: f32,
  // RIDGE visibility only, sampled at the trunk. The canopy channel contains this tree's own
  // crown, so using it here would make every tree self-shadow to the canopy floor.
  @location(4) @interpolate(flat) sunVis: f32,
  // Burn coordinate at this vertex. Interpolated, NOT flat: the whole point is that a stem is
  // charred at the ankle and green at the crown, so it has to vary up the geometry.
  @location(5) burn: f32,
};

// How far foliage moves at the crown top, as a fraction of tree height, at saturated wind.
const FOLIAGE_SWAY_FRACTION: f32 = 0.06;

@vertex
fn vsTree(in: VsIn, @builtin(instance_index) instanceOffset: u32) -> VsOut {
  let bucket = bucketU.bucketId;
  let rec = compacted[bucketBase(bucket) + instanceOffset];
  let inst = instances[unpackInstanceIndex(rec)];
  let entry = meshTable[bucket];

  // Scale is derived from the stem's physical height over the mesh's MEASURED reference
  // height, so a 30 m stem draws 30 m tall even though the mesh cache is keyed on quantised
  // parameters. Geometry stays an expression of the fuel data (spec §0, world.ts).
  let scale = inst.heightM / max(entry.refHeightM, 1e-3);

  let c = cos(inst.rotationY);
  let s = sin(inst.rotationY);
  let local = in.position * scale;
  let rotated = vec3<f32>(c * local.x + s * local.z, local.y, -s * local.x + c * local.z);
  let rotatedN = vec3<f32>(
    c * in.normal.x + s * in.normal.z,
    in.normal.y,
    -s * in.normal.x + c * in.normal.z,
  );

  let mat = materialParams[in.materialSlot];
  let isFoliage = (mat.flags & MATERIAL_FLAG_ALPHA_TEST) != 0u;
  let heightFrac = clamp(rotated.y / max(inst.heightM, 1e-3), 0.0, 1.0);
  // Quadratic in height: the trunk base does not move, the crown does. Per-instance phase
  // from the instance index so a stand does not sway in unison.
  let swayAmount = select(0.0, FOLIAGE_SWAY_FRACTION, isFoliage) *
    heightFrac * heightFrac * inst.heightM;
  let sway = windDisplacement(vec2<f32>(inst.posX, inst.posZ), f32(unpackInstanceIndex(rec)) * 0.6180339) * swayAmount;

  let world = vec3<f32>(
    inst.posX + rotated.x + sway.x,
    inst.posY + rotated.y,
    inst.posZ + rotated.z + sway.y,
  );

  var out: VsOut;
  out.clipPos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldNormal = normalize(rotatedN);
  out.uv = in.uv;
  out.materialSlot = in.materialSlot;
  out.fade = unpackFade(rec);
  out.sunVis = ridgeVisibilityAt(occlusionTex, inst.posX, inst.posZ);
  // `rotated.y` is metres above this stem's own base, which is what the char height is
  // measured against — not the world Y, and not the normalised height fraction.
  out.burn = stemBurnCoordinate(
    consumedAt(consumedTex, inst.posX, inst.posZ),
    f32(burnPeak[unpackInstanceIndex(rec)]) / BURN_PEAK_SCALE,
    rotated.y,
  );
  return out;
}

@fragment
fn fsTree(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let mat = materialParams[in.materialSlot];
  let tex = burnAlbedo(in.uv, burnLayers(mat.layer, mat.flags, in.burn));
  var alpha = tex.a;

  let alphaTested = (mat.flags & MATERIAL_FLAG_ALPHA_TEST) != 0u;
  if (alphaTested && alpha < frame.alphaCutoff) {
    discard;
  }

  // LOD cross-fade. Dither is the default because it is single-sampled and TAA resolves the
  // noise from M4 onward; alpha-to-coverage needs MSAA and multiplies the fill cost that
  // already bounds this pass.
  if (DITHER_ALPHA) {
    if (!ditherAccept(in.fade, in.clipPos.xy)) {
      discard;
    }
    alpha = 1.0;
  } else {
    alpha = alpha * in.fade;
  }

  // Two-sided lighting for foliage cards: a leaf card's normal is meaningless on the back
  // face, and flipping it is what stops the far side of every crown reading as black.
  var n = normalize(in.worldNormal);
  if ((mat.flags & MATERIAL_FLAG_DOUBLE_SIDED) != 0u && !frontFacing) {
    n = -n;
  }

  let l = normalize(-frame.sunDir);
  // Wrapped diffuse. Real foliage transmits, and a hard N.L on a leaf card reads as plastic.
  let ndl = clamp((dot(n, l) + 0.35) / 1.35, 0.0, 1.0);
  let ambient = 0.25 + 0.15 * clamp(n.y, 0.0, 1.0);
  // PHYSICAL RADIANCE, not an LDR colour. `ndl` and `ambient` are dimensionless shaping
  // terms; multiplying by the actual irradiance (W/m2) and dividing by pi gives Lambertian
  // radiance in W/(m2 sr) — the same units the terrain, the sky and the tone mapper use.
  // Emitting 0..1 here instead made every tree and blade a black silhouette at any exposure,
  // because the terrain beside it was emitting ~58.
  let albedo = tex.rgb * mat.baseColor;
  // Only the direct term is occluded; sky ambient is unshadowed.
  let irradiance = frame.sunIrradiance * (ndl * in.sunVis) + frame.skyIrradiance * ambient;
  let lit = albedo * irradiance * INV_PI;
  return vec4<f32>(lit, alpha);
}
