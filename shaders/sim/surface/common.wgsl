// Surface solver — shared state decode and the Rothermel coefficient LUT.
//
// The constant prelude is PREPENDED by src/sim/surface/shaders.ts. Every plane/byte offset,
// moisture scale and unit factor used below is generated from the TypeScript layout, so
// nothing here is a second copy of a number that lives elsewhere.
//
// Units: this file speaks the BTU-lb-ft-min system, because Rothermel's coefficients are
// dimensional fits in it and converting them breaks every published cross-check. Conversion
// happens at the two entry points, exactly as it does on the CPU path.
//
// Moisture is a FRACTION here and everywhere. There is no x100 anywhere in this directory.

// ---------------------------------------------------------------------------
// Per-cell packed state: three u32 planes, structure-of-arrays.
// Plane p, cell i lives at stateWords[p * PLANE_STRIDE + i] — a 4-byte stride within each
// plane, so a workgroup's 64 lanes read 64 contiguous words.
// ---------------------------------------------------------------------------

@group(0) @binding(0) var<storage, read> stateWords: array<u32>;

fn cellIndex(xy: vec2u) -> u32 { return xy.y * SURFACE_CELLS + xy.x; }

fn planeWord(plane: u32, cell: u32) -> u32 { return stateWords[plane * PLANE_STRIDE + cell]; }

fn stateByte(word: u32, slot: u32) -> u32 { return (word >> (slot * 8u)) & 0xffu; }

fn unorm8(raw: u32, fullScale: f32) -> f32 { return f32(raw) * (fullScale / 255.0); }

struct CellState {
  fuelModelId : u32,
  flags       : u32,
  // Fraction, oven-dry mass. Order matches the CPU MoistureVector exactly.
  moisture    : array<f32, 5>,
}

fn loadCellState(cell: u32) -> CellState {
  let w0 = planeWord(0u, cell);
  let w1 = planeWord(1u, cell);
  var s: CellState;
  s.fuelModelId = stateByte(w0, F_FUEL_MODEL_ID_BYTE);
  s.flags = stateByte(w0, F_FLAGS_BYTE);
  s.moisture[0] = unorm8(stateByte(w0, F_MOISTURE_DEAD_1H_BYTE), DEAD_MOISTURE_FULL_SCALE);
  s.moisture[1] = unorm8(stateByte(w0, F_MOISTURE_DEAD_10H_BYTE), DEAD_MOISTURE_FULL_SCALE);
  s.moisture[2] = unorm8(stateByte(w1, F_MOISTURE_DEAD_100H_BYTE), DEAD_MOISTURE_FULL_SCALE);
  s.moisture[3] = unorm8(stateByte(w1, F_MOISTURE_LIVE_HERB_BYTE), LIVE_MOISTURE_FULL_SCALE);
  s.moisture[4] = unorm8(stateByte(w1, F_MOISTURE_LIVE_WOODY_BYTE), LIVE_MOISTURE_FULL_SCALE);
  return s;
}

// §4.3 dynamic load transfer, in FRACTION form. Published as T = 1.333 - 0.0111*M_herb%.
// Evaluated unconditionally: static models have a flat LUT over cure, so the result is
// ignored by construction rather than by a branch.
fn curingFraction(herbMoisture: f32) -> f32 {
  return clamp(1.333 - 1.11 * herbMoisture, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Fuel coefficient LUT. Built on the CPU by src/sim/surface/coefficients.ts; the packing
// there and the unpacking here must stay in step, which the layout test asserts.
//
// Read-only storage rather than uniform: 53 models x 16 cure bins x 128 B is ~108 KB and the
// default maxUniformBufferBindingSize is 64 KiB. Access is broadcast-coherent, so it behaves
// like a uniform in cache.
// ---------------------------------------------------------------------------

struct FuelCoeff {
  v0 : vec4f,  // gammaEtaS, wnDeadH, wnLiveH, xiOverRhoB
  v1 : vec4f,  // kHeat[0..3]
  v2 : vec4f,  // kHeat[4], kHeatQ0, mxDead, mxLiveW
  v3 : vec4f,  // fDead[0..2], fLive[0]
  v4 : vec4f,  // fLive[1], wpDead[0..2]
  v5 : vec4f,  // windC, windB, windInvB, slopeK
  v6 : vec4f,  // residenceSeconds, savFt, -, -
  v7 : vec4f,  // reserved for WP 2.4
}

@group(0) @binding(1) var<storage, read> fuelLut: array<FuelCoeff>;

fn mixCoeff(a: FuelCoeff, b: FuelCoeff, t: f32) -> FuelCoeff {
  var r: FuelCoeff;
  r.v0 = mix(a.v0, b.v0, t);
  r.v1 = mix(a.v1, b.v1, t);
  r.v2 = mix(a.v2, b.v2, t);
  r.v3 = mix(a.v3, b.v3, t);
  r.v4 = mix(a.v4, b.v4, t);
  r.v5 = mix(a.v5, b.v5, t);
  r.v6 = mix(a.v6, b.v6, t);
  r.v7 = mix(a.v7, b.v7, t);
  return r;
}

// The LUT fetch. Cure shifts sigma for dynamic models, so the coefficients are tabulated over
// cure and lerped rather than recomputed — that is the whole point of §4.3's optimisation.
fn sampleFuelLut(fuelModelId: u32, cure: f32) -> FuelCoeff {
  let t = clamp(cure, 0.0, 1.0) * (CURE_BINS_F - 1.0);
  let i0 = min(CURE_BINS - 2u, u32(floor(t)));
  let base = fuelModelId * CURE_BINS + i0;
  return mixCoeff(fuelLut[base], fuelLut[base + 1u], clamp(t - f32(i0), 0.0, 1.0));
}

// ---------------------------------------------------------------------------
// The moisture-dependent half of Rothermel — the transliteration of kernel() in
// src/sim/surface/rothermel.ts. Deliberately line-for-line with the TypeScript.
// ---------------------------------------------------------------------------

// Eq. 29, clamped. r_M >= 1 gives eta_M = 0 and the cell cannot burn.
fn moistureDamping(ratio: f32) -> f32 {
  if (ratio >= 1.0) { return 0.0; }
  let r = max(0.0, ratio);
  return clamp(1.0 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r, 0.0, 1.0);
}

struct BaseRates {
  // ft min^-1, before wind and slope.
  r0 : f32,
  // BTU ft^-2 min^-1.
  reactionIntensity : f32,
}

fn rothermelBase(c: FuelCoeff, moisture: array<f32, 5>) -> BaseRates {
  var m = moisture;
  let mDead = c.v3.x * m[0] + c.v3.y * m[1] + c.v3.z * m[2];
  let mLive = c.v3.w * m[3] + c.v4.x * m[4];
  let mPrime = c.v4.y * m[0] + c.v4.z * m[1] + c.v4.w * m[2];

  let mxDead = c.v2.z;
  let mxLiveW = c.v2.w;
  // Eq. 88. Asymmetric exponents (-138 dead, -500 live) are already folded into mxLiveW.
  let mxLive = select(mxDead, max(mxLiveW * (1.0 - mPrime / mxDead) - 0.226, mxDead), mxLiveW > 0.0);

  let etaMDead = moistureDamping(mDead / mxDead);
  let etaMLive = select(0.0, moistureDamping(mLive / mxLive), mxLiveW > 0.0);

  // Eq. 27, with Gamma' * eta_s and w_n * h precomputed on the CPU.
  let iR = c.v0.x * (c.v0.y * etaMDead + c.v0.z * etaMLive);

  // Heat sink: rho_b * sum f_i f_ij eps_ij (250 + 1116 M_ij), Eqs. 12 and 14. The 1/rho_b is
  // folded into xiOverRhoB, so this is the bracket only.
  let sink = c.v2.y
    + 1116.0 * (c.v1.x * m[0] + c.v1.y * m[1] + c.v1.z * m[2] + c.v1.w * m[3] + c.v2.x * m[4]);

  var out: BaseRates;
  out.reactionIntensity = iR;
  out.r0 = select(0.0, iR * c.v0.w / sink, sink > 0.0);
  return out;
}

// §4.6 elliptical length-to-breadth, Anderson (1983) form, U_eff in mi h^-1.
//
// STATUS `estimated` — spec §4.6 carries a live OPEN QUESTION on these exponents (neither
// reference implementation agrees with them or with each other, and one of the two is wrong
// by the 2.237 mi h^-1-per-m s^-1 factor). WP 2.3 owns closing it. Mirrors
// lengthToBreadth() in src/sim/surface/rothermel.ts; change both together.
fn lengthToBreadth(effectiveWindFtMin: f32) -> f32 {
  let mph = effectiveWindFtMin / FTMIN_PER_MPH;
  return min(0.936 * exp(0.2566 * mph) + 0.461 * exp(-0.1548 * mph) - 0.397, 8.0);
}
