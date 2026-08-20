// Surface solver pass 1 — the moisture tick (~1 Hz sim time).
//
// §4.3 factorises Rothermel as R = R0(fuel, moisture) * (1 + phi_w + phi_s). This pass owns
// R0: everything that changes only when the fuel moisture field changes. The substep pass
// owns the wind and slope factors, which change every substep from the gusty wind field.
//
// Reads:  planes 0 and 1 of the packed state (8 B/cell), the fuel LUT (broadcast).
// Writes: rosBase, one u32 per cell = pack2x16float(R0 [m s^-1], I_R [kW m^-2]).
//
// f16 note: the PACKING is 16-bit, the ARITHMETIC is f32. R0 runs 1e-4 to 1e-1 m s^-1 and
// I_R runs to a few thousand kW m^-2, both comfortably inside f16 with ~0.05% relative
// precision. The wind exponent B is deliberately NOT cached here — see src/sim/surface/shaders.ts.

@group(0) @binding(2) var<storage, read_write> rosBase: array<u32>;

@compute @workgroup_size(WG, WG, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= SURFACE_CELLS || gid.y >= SURFACE_CELLS) { return; }
  let cell = cellIndex(gid.xy);

  let s = loadCellState(cell);
  // Cure is derived from live herbaceous moisture, never stored independently (§4.3).
  let c = sampleFuelLut(s.fuelModelId, curingFraction(s.moisture[3]));
  let b = rothermelBase(c, s.moisture);

  rosBase[cell] = pack2x16float(vec2f(
    b.r0 * FTMIN_TO_MPS,
    b.reactionIntensity * BTUFT2MIN_TO_KWM2,
  ));
}
