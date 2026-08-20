// WP 3.3 pass 0 — build the 4 m extinction field from the 2 m canopy LAD. Spec §7.3.
//
//   kappa = G(Omega) * Omega_c * LAD          G = 0.5 for a spherical leaf-angle distribution
//
// The relation is LINEAR in LAD, so averaging LAD over the 2x2x2 group and then taking kappa
// is identical to averaging kappa — there is no Jensen error here, unlike averaging
// transmittance, which is where voxel radiative transfer usually goes wrong.
//
// This pass is NOT in the per-step schedule. LAD is §7.2 pool B, static after the world
// build, so it runs once at build time and again only when consumption has changed the
// canopy enough to matter. Not rebuilding it every step is what removes the mip-pyramid
// build the §7.4 pipeline needs, and it is why the field can be a plain 4.19 MB texture that
// lives in L2.
//
// Smoke is deliberately absent: plume soot does absorb IR, but the plume field is WP 3.4's
// and coupling it here would make "static after build" untrue. Recorded in provenance.ts.

@group(0) @binding(0) var ladTex: texture_3d<f32>;   // r16float, LAD (m^2 m^-3) at 2 m
@group(0) @binding(1) var clumpTex: texture_3d<f32>; // r8unorm, Omega_c at 2 m
@group(0) @binding(2) var kappaOut: texture_storage_3d<r16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= RAD_NI || gid.y >= RAD_NJ || gid.z >= RAD_NK) { return; }
  let base = vec3i(gid) * 2;
  var sum = 0.0;
  for (var k = 0; k < 2; k = k + 1) {
    for (var j = 0; j < 2; j = j + 1) {
      for (var i = 0; i < 2; i = i + 1) {
        let c = base + vec3i(i, j, k);
        let lad = max(0.0, textureLoad(ladTex, c, 0).r);
        // Omega_c is stored normalised over [0, 1]; §7.3 uses 0.4-0.8 for conifer shoots and
        // ~0.9 for broadleaf, so the full range is used and no rescale is needed.
        sum = sum + LEAF_PROJECTION * textureLoad(clumpTex, c, 0).r * lad;
      }
    }
  }
  textureStore(kappaOut, vec3i(gid), vec4f(sum * 0.125, 0.0, 0.0, 0.0));
}
