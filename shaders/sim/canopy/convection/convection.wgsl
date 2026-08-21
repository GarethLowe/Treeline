// Canopy convection — WP 3.4, spec §7.5.
//
// Function library, not a pipeline. WP 3.1 owns the sparse brick pool and therefore owns the
// voxel iteration; this file provides the per-voxel evaluation it calls. Include it and call
// `convectiveSourceW()` from your own entry point.
//
// The ORACLE for everything here is src/sim/canopy/convection/{plume,heatTransfer}.ts. Every
// constant below is asserted against its TypeScript counterpart by
// test/sim/canopy/convection/shaderMirror.test.ts, which runs on the CLI without a GPU. If you
// change a number here, that test fails — which is the point: M1 lost four bugs to device-only
// code that nothing on the CLI could see.
//
// COST. REASONED, not measured — this work package has no device. Per voxel: one 1-D LUT fetch
// pair (uniform, 544 B total, so it sits in constant cache), ~10 ALU + 2 exp for the Gaussian
// profile, ~15 ALU + 1 sqrt + 3 pow for Nusselt, ~5 ALU for the source term. Whoever wires this
// into WP 3.1's voxel pass must profile it with the timestamp query and correct this line.
//
// The CPU side IS measured: 41 us to re-solve the plume and rebuild the LUT (512 RK4 steps),
// done at 2 Hz (PLUME_LUT_UPDATE_HZ) because the plume turns a 128 m column over in ~23 s. Only
// the FIELD is amortised — the per-voxel evaluation runs at the canopy step rate, because
// convection ignites fuel in ~1 s (§7.5) and is the fast channel.

// ---------------------------------------------------------------------------
// Bind group. This module declares its own group so it composes with whatever
// WP 3.1's voxel pass already binds. TS mirror: CONVECTION_BIND_GROUP.
// ---------------------------------------------------------------------------

struct PlumeUniforms {
  // [dT_c (K), w_c (m/s), b (m), x_tilt (m)] per row, PLUME_LUT_ROWS rows,
  // uniformly spaced from 0 to PLUME_LUT_TOP_M above the source.
  lut : array<vec4<f32>, 32>,
  // x, y = plume source position in world XZ; z = ambient wind speed (m/s);
  // w = ambient air temperature (K).
  params : vec4<f32>,
  // x, y = unit vector along the wind in world XZ (the direction the plume leans);
  // z = source ground height (m); w = unused.
  axis : vec4<f32>,
}

@group(3) @binding(0) var<uniform> plume : PlumeUniforms;

const PLUME_LUT_ROWS : f32 = 32.0;
const PLUME_LUT_TOP_M : f32 = 128.0;

// Buoyancy/velocity profile width ratio. FIXED at 1.2 (Richardson & Hunt 2022 eq. 7.1).
// NOTE: alpha_e does not appear in this file at all — it lives entirely in the CPU-side ODE
// solve that builds the LUT. That is deliberate. There is no place in the shader for someone
// to write 0.16, which per spec §7.5 is simultaneously the correct top-hat value and the
// rejected Rouse Gaussian value.
const PLUME_LAMBDA : f32 = 1.2;

// Air, Sutherland two-constant form.
const MU_REF : f32 = 1.716e-5;
const T_REF : f32 = 273.15;
const S_MU : f32 = 110.4;
const K_REF : f32 = 0.0241;
const S_K : f32 = 194.0;
const R_AIR : f32 = 287.05;
const P_ATM : f32 = 101325.0;

// 0.62 * Pr^(1/3) / (1 + (0.4/Pr)^(2/3))^(1/4) at Pr = 0.70. Holding Pr fixed costs +/-1.2 % on h
// across 300-1200 K and removes the whole Pr dependence from the hot path.
const CB_COEFF_PR070 : f32 = 0.4829200425;

// ---------------------------------------------------------------------------
// Plume field
// ---------------------------------------------------------------------------

struct GasState {
  tempK : f32,
  speed : f32,
  // Signed distance from the TILTED centreline, along the wind axis [m]. Diagnostic only:
  // the plume core at crown base is narrower than a 2 m voxel, so "how close did any voxel
  // get" is the difference between a wiring bug and a resolution limit.
  offsetM : f32,
}

// Sample the plume at `heightM` above the source and `acrossM` downwind of it, measured along
// the wind axis. The centreline has drifted to x_tilt(z), so the Gaussian is evaluated on
// (acrossM - x_tilt). Velocity uses half-width b, temperature uses lambda*b: the two profiles
// have DIFFERENT widths and swapping them is the other half of the convention error that
// lambda exists to prevent.
fn plumeGasState(heightM : f32, acrossM : f32) -> GasState {
  let ambientT = plume.params.w;
  let wind = plume.params.z;
  if (heightM < 0.0 || heightM > PLUME_LUT_TOP_M) {
    // Outside the LUT there is no centreline to be near; the sentinel keeps this row out of
    // any min-offset diagnostic rather than reporting a spurious zero.
    return GasState(ambientT, abs(wind), 1e9);
  }
  let f = (heightM / PLUME_LUT_TOP_M) * (PLUME_LUT_ROWS - 1.0);
  let i0 = min(u32(floor(f)), u32(PLUME_LUT_ROWS) - 2u);
  let t = f - f32(i0);
  let row = mix(plume.lut[i0], plume.lut[i0 + 1u], t);

  let dTc = row.x;
  let w = row.y;
  let b = max(row.z, 1e-3);
  let xTilt = row.w;

  let s = acrossM - xTilt;
  let s2 = s * s;
  let gaussV = exp(-s2 / (b * b));
  let gaussT = exp(-s2 / (PLUME_LAMBDA * PLUME_LAMBDA * b * b));
  let wLocal = w * gaussV;
  return GasState(ambientT + dTc * gaussT, length(vec2<f32>(wLocal, wind)), s);
}

// Convenience: world-space voxel centre -> gas state, using the source position and wind axis
// carried in the uniform. `acrossM` is the projection onto the wind axis, so a voxel upwind of
// the fire gets a negative offset and sees ambient, which is correct.
fn plumeGasStateAtWorld(voxelCentre : vec3<f32>) -> GasState {
  let d = voxelCentre.xz - plume.params.xy;
  let acrossM = dot(d, plume.axis.xy);
  return plumeGasState(voxelCentre.y - plume.axis.z, acrossM);
}

// ---------------------------------------------------------------------------
// Convective heat transfer
// ---------------------------------------------------------------------------

fn airViscosity(tempK : f32) -> f32 {
  return MU_REF * pow(tempK / T_REF, 1.5) * (T_REF + S_MU) / (tempK + S_MU);
}

fn airConductivity(tempK : f32) -> f32 {
  return K_REF * pow(tempK / T_REF, 1.5) * (T_REF + S_K) / (tempK + S_K);
}

fn airKinematicViscosity(tempK : f32) -> f32 {
  let density = P_ATM / (R_AIR * tempK);
  return airViscosity(tempK) / density;
}

// Churchill & Bernstein (1977) with the Pr dependence folded into CB_COEFF_PR070.
// The high-Re bracket is KEPT: it is 1.052 at Re = 3600 (a 6 mm twig in a 20 m/s plume), so
// dropping it would be a 5 % systematic under-prediction of h to save two pow instructions.
fn nusseltWildland(re : f32) -> f32 {
  let reSafe = max(re, 1e-6);
  return 0.3 + CB_COEFF_PR070 * sqrt(reSafe) * pow(1.0 + pow(reSafe / 282000.0, 0.625), 0.8);
}

// Convective heat transfer coefficient [W m^-2 K^-1]. Air properties are evaluated at the film
// temperature (T_g + T_s)/2, which is the standard for this correlation family.
fn convectiveCoefficient(gasTempK : f32, solidTempK : f32, gasSpeed : f32, diameter : f32) -> f32 {
  let film = 0.5 * (gasTempK + solidTempK);
  let re = abs(gasSpeed) * diameter / airKinematicViscosity(film);
  return nusseltWildland(re) * airConductivity(film) / diameter;
}

// Volumetric convective source [W m^-3]: q''' = h * A_v * (T_g - T_s), A_v = 2*LAD because LAD
// is one-sided and both leaf faces exchange heat (spec §7.5).
//
// Signed. Negative when the gas is colder than the fuel; do NOT clamp that away, it is the
// correct post-front and night-time behaviour.
//
// The Biot correction 1/(1 + Bi/4) of spec §7.6 is WP 3.2's and multiplies the h returned by
// convectiveCoefficient(). It is not applied here.
fn convectiveSourceW(
  gasTempK : f32,
  solidTempK : f32,
  gasSpeed : f32,
  diameter : f32,
  leafAreaDensity : f32,
) -> f32 {
  let h = convectiveCoefficient(gasTempK, solidTempK, gasSpeed, diameter);
  return h * 2.0 * leafAreaDensity * (gasTempK - solidTempK);
}
