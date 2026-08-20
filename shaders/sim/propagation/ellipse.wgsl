// Fire-ellipse geometry and the level-set Hamiltonian.
//
// A transliteration of `src/sim/propagation/ellipse.ts`, which is the normative version and
// the oracle this is tested against. Keep the two in step; the TypeScript file carries the
// citations and the reasoning.
//
// Length-to-breadth is Anderson (1983) INT-305 Eq. 17 p.7 — `0.1147 / 0.0692` on **midflame
// wind in mi/h** — with Finney's (1998) `-0.397` zero-wind normalisation and cap at 8.
// Spec §4.6 prints `0.2566 / 0.1548`; those are the same relation reparameterised for wind
// in m/s and are wrong for a mi/h argument. See ellipse.ts for the three cross-checks.

const MPS_TO_MIH: f32 = 2.2369362920544025;
const LB_MAX: f32 = 8.0;

fn lengthToBreadth(effectiveWindMps: f32) -> f32 {
  let u = max(effectiveWindMps, 0.0) * MPS_TO_MIH;
  let lb = 0.936 * exp(0.1147 * u) + 0.461 * exp(-0.0692 * u) - 0.397;
  return clamp(lb, 1.0, LB_MAX);
}

struct Ellipse {
  // Rates, m/s: `a` semi-minor (flank), `b` semi-major, `c` focal offset, `h` unit heading.
  a: f32,
  b: f32,
  c: f32,
  h: vec2f,
}

fn ellipseFromRates(headRate: f32, lbIn: f32, headingIn: vec2f) -> Ellipse {
  let lb = clamp(lbIn, 1.0, LB_MAX);
  let rHead = max(headRate, 0.0);
  // Eccentricity form of R_b = R_head / HB: identical, but finite at LB = 1.
  let ecc = sqrt(max(lb * lb - 1.0, 0.0)) / lb;
  let backing = rHead * (1.0 - ecc) / (1.0 + ecc);
  let b = 0.5 * (rHead + backing);
  let len = length(headingIn);
  var e: Ellipse;
  e.b = b;
  e.c = b - backing;
  e.a = b / lb;
  e.h = select(vec2f(1.0, 0.0), headingIn / max(len, 1e-12), len > 1e-6);
  return e;
}

// H(p) = S(n)|p| with S the SUPPORT function of the ellipse about the rear focus
// (Richards 1990). Convex and homogeneous of degree one, which is what makes the level-set
// viscosity solution coincide with the Huygens envelope — i.e. what makes the emergent
// perimeter the analytic ellipse without any per-direction correction.
fn hamiltonian(p: vec2f, e: Ellipse) -> f32 {
  let q = dot(p, e.h);
  let perp = max(dot(p, p) - q * q, 0.0);
  return e.c * q + sqrt(e.b * e.b * q * q + e.a * e.a * perp);
}

// Ellipse-wide bound on |dH/dp| per axis. Used only as a fallback where the gradient is
// undefined; the advance kernel bounds the dissipation over the reconstruction box instead.
fn alphaGlobal(e: Ellipse) -> vec2f {
  return vec2f(
    abs(e.c * e.h.x) + length(vec2f(e.b * e.h.x, e.a * e.h.y)),
    abs(e.c * e.h.y) + length(vec2f(e.b * e.h.y, e.a * e.h.x)),
  );
}

fn hamiltonianGrad(p: vec2f, e: Ellipse) -> vec2f {
  let q = dot(p, e.h);
  let sq = e.b * e.b * q * q + e.a * e.a * max(dot(p, p) - q * q, 0.0);
  if (sq <= 1e-24) {
    return alphaGlobal(e);
  }
  let invS = inverseSqrt(sq);
  return e.c * e.h + (e.b * e.b * q * e.h + e.a * e.a * (p - q * e.h)) * invS;
}

fn minmod(a: f32, b: f32) -> f32 {
  if (a * b <= 0.0) {
    return 0.0;
  }
  return select(b, a, abs(a) < abs(b));
}
