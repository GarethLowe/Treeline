// Surface solver pass 2 — the substep (every level-set substep, 40-250 ms of sim time).
//
// Wind and slope only. R0 and I_R come from the moisture tick's cache. Output is the
// elliptical fire-shape parameters WP 2.3's level set consumes:
//   x = pack2x16float(R_head [m s^-1], LB)
//   y = pack2x16float(heading.x, heading.y)      unit vector, world XZ
//
// **Pipeline order is normative (§4.5)**: phi_w, phi_s -> vector-combine -> phi_E -> U_eff ->
// cap -> LB -> ellipse. Any cap acts on the pair (U_eff, R_head) BEFORE the elliptical
// decomposition. Flank and backing rates are functions of the capped head quantities and are
// never capped separately, which is why this shader emits R_head and LB and not the four
// directional rates.
//
// Traffic: 4 (rosBase) + 8 (planes 0,1) + 4 (slope/aspect) read, 8 written = 24 B/cell.

struct SubstepParams {
  // MIDFLAME wind, already through the §4.5 WAF chain. m s^-1.
  midflameWind : f32,
  // Azimuth the wind blows TOWARD, radians clockwise from north — the same convention as
  // ITerrainField.aspectAt. (The contract does not state this for SurfaceWeather.windDirection;
  // reported as a contract issue. Flip the sign here if the integrator settles the other way.)
  windAzimuth : f32,
  _pad0 : f32,
  _pad1 : f32,
}

@group(0) @binding(2) var<storage, read> rosBase: array<u32>;
@group(0) @binding(3) var<storage, read_write> ellipseCache: array<vec2u>;
// WP 1.2's ITerrainField.slopeAspectTexture: RG16F, .r = slope TANGENT, .g = downslope azimuth.
@group(0) @binding(4) var slopeAspect: texture_2d<f32>;
@group(0) @binding(5) var<uniform> params: SubstepParams;

fn azimuthToVec(a: f32) -> vec2f { return vec2f(sin(a), cos(a)); }

@compute @workgroup_size(WG, WG, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= SURFACE_CELLS || gid.y >= SURFACE_CELLS) { return; }
  let cell = cellIndex(gid.xy);

  let s = loadCellState(cell);
  let c = sampleFuelLut(s.fuelModelId, curingFraction(s.moisture[3]));

  let base = unpack2x16float(rosBase[cell]);
  let r0Ft = base.x * MPS_TO_FTMIN;              // back into the kernel's units
  let iR = base.y / BTUFT2MIN_TO_KWM2;           // BTU ft^-2 min^-1, for the legacy cap only

  // --- phi_w, Eqs. 47-50. windC already carries C * (beta/beta_op)^-E, so this is one pow.
  let uFt = max(0.0, params.midflameWind) * MPS_TO_FTMIN;
  let phiW = select(0.0, c.v5.x * pow(max(uFt, 1e-6), c.v5.y), uFt > 0.0);

  // --- phi_s, Eq. 51. Slope is a TANGENT and enters squared; clamped at tan 0.7 per §4.9,
  //     above which the tan^2 growth is unrestrained and over-predicts severely.
  let dims = textureDimensions(slopeAspect, 0);
  let tc = vec2u(gid.xy * dims / vec2u(SURFACE_CELLS, SURFACE_CELLS));
  let sa = textureLoad(slopeAspect, tc, 0);
  let tanPhi = clamp(sa.x, 0.0, MAX_SLOPE_TANGENT);
  let phiS = c.v5.w * tanPhi * tanPhi;

  // --- Vector combination (§4.5). Upslope is the reverse of the downslope aspect azimuth.
  let windDir = azimuthToVec(params.windAzimuth);
  let upslope = -azimuthToVec(sa.y);
  let combined = phiW * windDir + phiS * upslope;
  var phiE = length(combined);
  let heading = select(windDir, combined / max(phiE, 1e-20), phiE > 1e-12);

  // --- Effective midflame wind: Eq. 47 inverted on the resultant (GTR-371 §4.1 p.27).
  //     Using raw wind for LB instead of this is wrong on slopes.
  var uEff = select(0.0, pow(max(phiE, 1e-20) / c.v5.x, c.v5.z), phiE > 0.0 && c.v5.x > 0.0);
  var rHead = r0Ft * (1.0 + phiE);

  // --- §4.5 wind limit. Default is mode 1: no hard cap (the model authors' published
  //     recommendation), just an inert rail against pathological wind fields.
  if (WIND_LIMIT_MODE == 2u) {
    // Legacy BEHAVE debug toggle: cap the WIND and re-evaluate. Clamping R directly gives
    // different numbers and will not reproduce BehavePlus.
    let limit = 0.9 * iR;
    if (uEff > limit) {
      uEff = limit;
      phiE = c.v5.x * pow(max(uEff, 1e-6), c.v5.y);
      rHead = r0Ft * (1.0 + phiE);
    }
  } else if (WIND_LIMIT_MODE == 1u) {
    rHead = min(rHead, max(uEff, r0Ft));
  }

  ellipseCache[cell] = vec2u(
    pack2x16float(vec2f(rHead * FTMIN_TO_MPS, lengthToBreadth(uEff))),
    pack2x16float(heading),
  );
}
