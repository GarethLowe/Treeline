/**
 * Buoyant line-plume rise — WP 3.4, spec §7.5. Pure TypeScript, no GPU.
 *
 * This is the oracle for `shaders/sim/canopy/convection/convection.wgsl`.
 *
 * ## What this is for, and what it deliberately is not
 *
 * The plume decides **where hot gas goes**: how high it rises before it runs out of
 * buoyancy, how far downwind it leans on the way, how wide it has spread by the time it
 * reaches crown height, and how much excess temperature is left when it gets there. It is
 * *not* a CFD result and spec §0.5.1 explicitly says not to make it one. Everything here is
 * a 1-D integration along the plume axis; there is no 3-D flow field.
 *
 * ## The Morton–Taylor–Turner closure, in the convention the spec makes normative
 *
 * Gaussian convention, LINE (2-D) plume, per unit length of fire line:
 *
 *     w(x,z)  = w_c(z) · exp(−x² / b²)
 *     g'(x,z) = g'_c(z) · exp(−x² / (λb)²)
 *     u_e     = α_e · w_c            (entrainment velocity, from EACH side of the line)
 *
 * with `α_e = 0.11 ± 15 %` and `λ = 1.2` FIXED — Richardson & Hunt (2022) eq. (7.1).
 *
 * Integrating the Gaussian profiles across the plume gives the three fluxes, all per unit
 * length of the line source:
 *
 *     Q = ∫ w dx      = √π · w_c · b                        [m² s⁻¹]
 *     M = ∫ w² dx     = √(π/2) · w_c² · b                   [m³ s⁻²]
 *     F = ∫ w g' dx   = √π · λ/√(1+λ²) · w_c · g'_c · b     [m³ s⁻³]
 *
 * which invert to
 *
 *     w_c  = √2 · M / Q
 *     b    = Q² / (√(2π) · M)
 *     g'_c = F · √(1+λ²) / (λ · Q)
 *
 * and the conservation equations are
 *
 *     dQ/dz = 2 α_e w_c                 (the 2 is "both sides of the line")
 *     dM/dz = F √(1+λ²) / w_c           ( = √π λ b g'_c, the buoyancy force per unit length)
 *     dF/dz = −N² Q                     (N² = (g/T_a)·dθ/dz; 0 in a neutral atmosphere)
 *     dX/dz = u(z) / w_c                (centreline drift downwind — see "Tilt" below)
 *
 * ### Why this is integrated rather than evaluated in closed form
 *
 * In a neutral, quiescent atmosphere the system above has an exact power-law solution and
 * the whole thing collapses to four constants (`similarityCoefficients`). We still integrate,
 * for two reasons. Stratification and wind have no closed form — a stable layer is what stops
 * the plume, and stopping height is the quantity the canopy actually cares about. And, more
 * importantly, integrating from a NON-similar initial condition and checking that the solution
 * converges onto those four constants is the **mandatory CI regression of spec §7.5**: it tests
 * the closure and its convention, not the constant sitting in a config field. See
 * `test/sim/canopy/convection/plume.test.ts`.
 *
 * ### The numerical trap this file is built to fail loudly on
 *
 * `α_T = 0.16` is simultaneously the correct TOP-HAT value and the *rejected* Rouse et al.
 * (1952) Gaussian value. Writing 0.16 into a Gaussian-convention solver is a 41 % error that
 * produces a plume that is too narrow, too fast and too hot, and it does not look wrong.
 * `assertGaussianAlpha` therefore throws on anything outside the published Gaussian envelope,
 * and 0.16 is outside it. See spec §7.5 "NUMERICAL TRAP".
 *
 * ## Accepted errors (§0.5.1 requires these to be stated and bounded)
 *
 * 1. **Cross-wind entrainment is not modelled.** Entrainment is `α_e w_c` only; the wind
 *    advects the centreline but does not add shear entrainment. In a bent-over plume the real
 *    closure is larger, so rise height is OVER-predicted and dilution UNDER-predicted once
 *    `u/w_c ≳ 1`. Spec §7.5 states explicitly that this is a different closure and a new open
 *    question, not a re-tuning of `α_e`. `PLUME_PROVENANCE` records it.
 * 2. **Near-source excess temperature is clamped**, not resolved. The similarity solution is
 *    singular at the source (`b → 0`, `g'_c → ∞`); a real fire has a flame zone. Excess
 *    temperature is capped at `maxExcessTempK` (default 900 K over a 300 K ambient, i.e. the
 *    1200 K flame-sheet temperature of §7.4). Below roughly one flame depth the profile is a
 *    clamp, not a solution.
 * 3. **`convectiveFraction` is `estimated`.** See `PLUME_PROVENANCE`.
 */

import type { Kelvin, KilowattsPerMetre, Metres, MetresPerSecond } from '@contracts/units.ts'

// ---------------------------------------------------------------------------
// Normative constants — spec §7.5
// ---------------------------------------------------------------------------

/** Entrainment coefficient. GAUSSIAN convention, LINE plume. Richardson & Hunt (2022) eq. (7.1). */
export const ALPHA_E_GAUSSIAN_LINE = 0.11

/** Buoyancy/velocity profile width ratio. FIXED, not a free parameter. Published range 1.0–1.3. */
export const PLUME_LAMBDA = 1.2

/** Published envelope. The §7.7 optimiser warns outside this. */
export const ALPHA_E_SOFT_BOUNDS = { min: 0.095, max: 0.13 } as const

/** Hard optimiser bounds. Outside this is outside every published line-plume measurement. */
export const ALPHA_E_HARD_BOUNDS = { min: 0.09, max: 0.14 } as const

/**
 * Gaussian → top-hat conversion, `α_T = 2^(1/4)(1+λ²)^(1/4) α_G`. At λ = 1.2 the factor is
 * 1.486; the familiar √2 is the λ = 1 simplification and is wrong here by 5 %.
 *
 * Exported so that anyone who *does* write a top-hat solver derives the number instead of
 * transcribing 0.16 — which is the one digit sequence in this whole section that means two
 * different things.
 */
export const topHatAlpha = (alphaGaussian: number, lambda = PLUME_LAMBDA): number =>
  2 ** 0.25 * (1 + lambda * lambda) ** 0.25 * alphaGaussian

/**
 * Guard against the §7.5 numerical trap. Throws on a top-hat coefficient (0.16), on the
 * rejected Rouse Gaussian value (also 0.16), and on anything else outside the published
 * Gaussian envelope.
 */
export function assertGaussianAlpha(alphaE: number): void {
  if (!(alphaE >= ALPHA_E_HARD_BOUNDS.min && alphaE <= ALPHA_E_HARD_BOUNDS.max)) {
    throw new RangeError(
      `alphaE=${alphaE} is outside the Gaussian line-plume envelope ` +
        `[${ALPHA_E_HARD_BOUNDS.min}, ${ALPHA_E_HARD_BOUNDS.max}] (spec §7.5). ` +
        `If this came from a top-hat formulation, alpha_T=${topHatAlpha(ALPHA_E_GAUSSIAN_LINE).toFixed(4)} ` +
        `corresponds to alpha_G=${ALPHA_E_GAUSSIAN_LINE}; 0.16 is a TOP-HAT value and is also the ` +
        `rejected Rouse et al. (1952) Gaussian value. Do not conflate them.`,
    )
  }
}

const G = 9.81
/** Dry-air specific heat at constant pressure, ambient. */
export const CP_AIR = 1005
/** Ambient air density used to convert fireline intensity to buoyancy flux. */
export const RHO_AIR_AMBIENT = 1.2

// ---------------------------------------------------------------------------
// Similarity solution — the convention-independent observables of spec §7.5
// ---------------------------------------------------------------------------

export interface SimilarityCoefficients {
  /** `b = cb · z`. */
  readonly cb: number
  /** `w_c = cw · B₀^(1/3)`. */
  readonly cw: number
  /** `g'_c = cg · B₀^(2/3) / z`. */
  readonly cg: number
  /** `Q = cq · B₀^(1/3) · z`. */
  readonly cq: number
}

/**
 * Closed-form pure-plume similarity solution of the system above, in a neutral quiescent
 * atmosphere. At `α_e = 0.11, λ = 1.2` this reproduces the spec's five stated observables
 * (b = 0.1241z, λb = 0.1489z, w_c = 2.157 B₀^⅓, g'_c = 2.743 B₀^⅔ z⁻¹, Q = 0.4746 B₀^⅓ z).
 *
 * Derivation is three lines: substituting `b = cb·z`, `w_c = cw·B^⅓`, `g'_c = cg·B^⅔/z` into
 * dQ/dz gives `cb = 2α/√π`; into dM/dz gives `cg = cw²/(λ√2)`; and requiring F to be the
 * z-independent constant B gives `cw³ = √2·√(1+λ²)/(2α)`.
 */
export function similarityCoefficients(
  alphaE = ALPHA_E_GAUSSIAN_LINE,
  lambda = PLUME_LAMBDA,
): SimilarityCoefficients {
  const cb = (2 * alphaE) / Math.sqrt(Math.PI)
  const cw = Math.cbrt((Math.SQRT2 * Math.sqrt(1 + lambda * lambda)) / (2 * alphaE))
  const cg = (cw * cw) / (lambda * Math.SQRT2)
  const cq = Math.sqrt(Math.PI) * cw * cb
  return { cb, cw, cg, cq }
}

// ---------------------------------------------------------------------------
// Source strength
// ---------------------------------------------------------------------------

/**
 * Buoyancy flux **per unit length of fire line**, `B₀ = g χ_c I_B / (ρ_a c_p T_a)` [m³ s⁻³].
 *
 * NOTE the difference from spec §6.4's `F_b = g χ_c I_B Λ / (π ρ_a c_p T_a)` [m⁴ s⁻³], which is
 * the Briggs POINT-source flux for a fire line of finite length Λ. These are different
 * quantities with different dimensions and they are not interchangeable — §6.4 feeds Briggs's
 * final-rise formulae, this feeds an MTT line-plume integration.
 */
export function buoyancyFluxPerMetre(
  intensity: KilowattsPerMetre,
  env: PlumeEnvironment,
  convectiveFraction: number,
): number {
  return (G * convectiveFraction * intensity * 1000) / (env.density * CP_AIR * env.tempK)
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlumeEnvironment {
  /** Ambient air temperature at the surface. */
  readonly tempK: Kelvin
  /** Ambient air density. */
  readonly density: number
  /**
   * Potential temperature gradient dθ/dz [K m⁻¹]. 0 = neutral (plume never stops). Spec §6.4
   * defaults: 0.02 (Pasquill E), 0.035 (F). Unstable is negative and is clamped to 0 here —
   * an unstable line plume has no level-off height and this model has nothing to say about
   * the entrainment of mid-level air that actually terminates it.
   */
  readonly potentialTempGradient: number
  /** Ambient horizontal wind speed as a function of height above the source. */
  readonly wind: (heightM: number) => number
}

export interface PlumeSource {
  /** Byram fireline intensity of the surface cell driving this plume. */
  readonly intensity: KilowattsPerMetre
  /** Flame depth, i.e. the along-spread width of the flaming zone. Sets the initial half-width. */
  readonly flameDepth: Metres
}

export interface PlumeOptions {
  /** Gaussian line-plume entrainment coefficient. Calibration knob #2 of spec §7.7. */
  readonly alphaE?: number
  /** Profile width ratio. FIXED at 1.2; exposed only so the CI regression can vary it. */
  readonly lambda?: number
  /**
   * Convective fraction of `I_B`. `estimated` — see `PLUME_PROVENANCE`. Hold this FIXED during
   * the §7.7 calibration: it is degenerate with `α_e` (both scale plume strength) and fitting
   * both makes the two-parameter fit non-identifiable.
   */
  readonly convectiveFraction?: number
  /** Cap on centreline excess temperature. Default 900 K, the §7.4 flame-sheet value over 300 K. */
  readonly maxExcessTempK?: number
  /** Top of the integration, metres above the source. */
  readonly topM?: number
  /** RK4 steps. Log-spaced in z, so this is a relative resolution, not an absolute one. */
  readonly steps?: number
}

export const DEFAULT_CONVECTIVE_FRACTION = 0.6
const DEFAULT_TOP_M = 512
const DEFAULT_STEPS = 512
const DEFAULT_MAX_EXCESS_K = 900

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface PlumeProfile {
  /** Height above the source [m], log-spaced and strictly increasing. */
  readonly z: Float64Array
  /** 1/e velocity half-width `b` [m]. The buoyancy half-width is `λb`. */
  readonly halfWidth: Float64Array
  /** Centreline vertical velocity `w_c` [m s⁻¹]. */
  readonly centrelineVelocity: Float64Array
  /** Centreline buoyancy `g'_c` [m s⁻²]. */
  readonly centrelineBuoyancy: Float64Array
  /** Centreline excess temperature over ambient [K], clamped at `maxExcessTempK`. */
  readonly centrelineExcessTempK: Float64Array
  /** Volume flux per unit line length `Q` [m² s⁻¹]. */
  readonly volumeFlux: Float64Array
  /** Downwind displacement of the centreline [m]. Zero in still air. */
  readonly tiltX: Float64Array
  /** Source buoyancy flux per unit length [m³ s⁻³]. */
  readonly buoyancyFlux0: number
  /**
   * Height at which `w_c` fell below `W_STALL`, i.e. where the plume stops rising. `Infinity`
   * in a neutral atmosphere, where the MTT line plume rises without limit.
   */
  readonly levelOffHeight: number
}

/** Below this centreline velocity the plume has stopped and the integration terminates. */
const W_STALL = 0.05

/**
 * Half-width ceiling, as a multiple of height. The similarity solution gives b = 0.124 z, so
 * 10 z is two orders of magnitude of slack — it only ever binds where the solution has already
 * stalled and b would otherwise diverge.
 */
const B_MAX_PER_HEIGHT = 10

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

/**
 * Integrate the MTT line plume upward from the fire.
 *
 * The initial condition is deliberately **not** the similarity solution: the source delivers
 * buoyancy and essentially no momentum (`w₀ = 0.1 m s⁻¹` over a half-width of half the flame
 * depth), which is the MTT idealisation of a fire and is a lazy plume in the technical sense.
 * The closure has to generate the similarity solution itself, which is what makes the §7.5 CI
 * regression a real test rather than an echo of `similarityCoefficients`.
 *
 * Integration is RK4 in `ζ = ln z` so the step is a constant *fraction* of height: the
 * solution varies fastest near the source, where a uniform-z grid wastes most of its steps at
 * the top and starves the bottom.
 */
export function solvePlume(
  source: PlumeSource,
  env: PlumeEnvironment,
  opts: PlumeOptions = {},
): PlumeProfile {
  const alphaE = opts.alphaE ?? ALPHA_E_GAUSSIAN_LINE
  const lambda = opts.lambda ?? PLUME_LAMBDA
  const chiC = opts.convectiveFraction ?? DEFAULT_CONVECTIVE_FRACTION
  const maxExcess = opts.maxExcessTempK ?? DEFAULT_MAX_EXCESS_K
  const topM = opts.topM ?? DEFAULT_TOP_M
  const steps = opts.steps ?? DEFAULT_STEPS
  assertGaussianAlpha(alphaE)

  const b0 = Math.max(source.flameDepth / 2, 0.1)
  const z0 = b0
  const w0 = 0.1
  const B0 = buoyancyFluxPerMetre(source.intensity, env, chiC)

  // N² = (g/T_a)·dθ/dz. Unstable is clamped to neutral; see PlumeEnvironment.
  const nSq = (G / env.tempK) * Math.max(env.potentialTempGradient, 0)
  const kLambda = Math.sqrt(1 + lambda * lambda)
  const tempScale = env.tempK / G // g'_c → ΔT

  // State y = [Q, M, F, X].
  let Q = Math.sqrt(Math.PI) * w0 * b0
  let M = Math.sqrt(Math.PI / 2) * w0 * w0 * b0
  let F = B0
  let X = 0

  const n = steps + 1
  const z = new Float64Array(n)
  const halfWidth = new Float64Array(n)
  const wc = new Float64Array(n)
  const gc = new Float64Array(n)
  const dT = new Float64Array(n)
  const qFlux = new Float64Array(n)
  const tiltX = new Float64Array(n)
  let levelOffHeight = Infinity

  // dy/dzeta = z · dy/dz, written into `out` to keep the RK4 allocation-free.
  const out = [0, 0, 0, 0]
  const deriv = (zi: number, q: number, mm: number, f: number): void => {
    const w = (Math.SQRT2 * mm) / q
    if (!(w > W_STALL) || !(q > 0)) {
      out[0] = out[1] = out[2] = out[3] = 0
      return
    }
    out[0] = zi * 2 * alphaE * w
    out[1] = (zi * (f * kLambda)) / w
    out[2] = zi * -nSq * q
    out[3] = (zi * env.wind(zi)) / w
  }

  const dZeta = Math.log(topM / z0) / steps
  let zz = z0

  // A stalled plume drives M to zero, and b = Q^2/(sqrt(2pi) M) then runs away. Both fields go
  // into a GPU uniform, so they are clamped rather than left to reach Infinity: a plume that has
  // stopped is physically "a wide, motionless, ambient-temperature patch", and a NaN in a
  // uniform is a black screen nobody can trace back to here.
  const record = (i: number, zi: number, q: number, mm: number, f: number, x: number): void => {
    const w = Math.max((Math.SQRT2 * mm) / q, 0)
    const bb = Math.min((q * q) / (Math.sqrt(2 * Math.PI) * mm), B_MAX_PER_HEIGHT * zi)
    const g = (f * kLambda) / (lambda * q)
    z[i] = zi
    halfWidth[i] = bb
    wc[i] = w
    gc[i] = g
    dT[i] = Math.min(Math.max(g * tempScale, -maxExcess), maxExcess)
    qFlux[i] = q
    tiltX[i] = x
  }

  record(0, z0, Q, M, F, X)

  for (let i = 1; i < n; i++) {
    if (Q <= 0 || M <= 0 || (Math.SQRT2 * M) / Q <= W_STALL) {
      // Stalled: hold the last state so the LUT reads "no plume here" rather than NaN.
      if (levelOffHeight === Infinity) levelOffHeight = z[i - 1] ?? z0
      record(i, zz * Math.exp(dZeta), Q, Math.max(M, 0), 0, X)
      zz *= Math.exp(dZeta)
      continue
    }

    // RK4 in zeta.
    const h = dZeta
    const zMid = zz * Math.exp(h / 2)
    const zEnd = zz * Math.exp(h)

    deriv(zz, Q, M, F)
    const k1 = [out[0]!, out[1]!, out[2]!, out[3]!]
    deriv(zMid, Q + (h / 2) * k1[0]!, M + (h / 2) * k1[1]!, F + (h / 2) * k1[2]!)
    const k2 = [out[0]!, out[1]!, out[2]!, out[3]!]
    deriv(zMid, Q + (h / 2) * k2[0]!, M + (h / 2) * k2[1]!, F + (h / 2) * k2[2]!)
    const k3 = [out[0]!, out[1]!, out[2]!, out[3]!]
    deriv(zEnd, Q + h * k3[0]!, M + h * k3[1]!, F + h * k3[2]!)
    const k4 = [out[0]!, out[1]!, out[2]!, out[3]!]

    Q += (h / 6) * (k1[0]! + 2 * k2[0]! + 2 * k3[0]! + k4[0]!)
    M += (h / 6) * (k1[1]! + 2 * k2[1]! + 2 * k3[1]! + k4[1]!)
    F += (h / 6) * (k1[2]! + 2 * k2[2]! + 2 * k3[2]! + k4[2]!)
    X += (h / 6) * (k1[3]! + 2 * k2[3]! + 2 * k3[3]! + k4[3]!)
    zz = zEnd

    if (M <= 0 && levelOffHeight === Infinity) levelOffHeight = zz
    record(i, zz, Q, Math.max(M, 1e-12), F, X)
    if (wc[i]! <= W_STALL && levelOffHeight === Infinity) levelOffHeight = zz
  }

  return {
    z,
    halfWidth,
    centrelineVelocity: wc,
    centrelineBuoyancy: gc,
    centrelineExcessTempK: dT,
    volumeFlux: qFlux,
    tiltX,
    buoyancyFlux0: B0,
    levelOffHeight,
  }
}

// ---------------------------------------------------------------------------
// The GPU-side lookup table
// ---------------------------------------------------------------------------

/**
 * LUT rows. `vec4<f32>` so it drops straight into a WGSL uniform array with no padding.
 *
 * 32 rows × 16 B = 512 B, rebuilt on the CPU at 2 Hz (see `PLUME_LUT_UPDATE_HZ`). The whole
 * canopy convection field is therefore half a kilobyte of uniform data and one 1-D fetch per
 * voxel, which is the §0.5.1 answer to "do not resolve detail nobody can see".
 */
export const PLUME_LUT_ROWS = 32
export const PLUME_LUT_FLOATS_PER_ROW = 4
export const PLUME_LUT_BYTES = PLUME_LUT_ROWS * PLUME_LUT_FLOATS_PER_ROW * 4

/**
 * Top of the LUT. The canopy grid is 64 × 2 m = 128 m tall (contracts `CANOPY_N_Z`,
 * `CANOPY_CELL_M_3D`), so nothing above 128 m can receive convective heat and resolving it
 * would be waste. 4 m rows, matching the §7.4 radiation volume's z spacing.
 */
export const PLUME_LUT_TOP_M = 128

/**
 * Rebuild rate for the LUT.
 *
 * The plume adjusts on its own turnover time, `z_top / w_c`. At a strong 1000 kW m⁻¹ fire
 * line, `w_c ≈ 5.5 m s⁻¹`, so a 128 m column turns over in ~23 s. Rebuilding at 2 Hz
 * oversamples that by ~45× and still resolves the 1–5 s gust modulation §7.5 asks for. The
 * cost is **41 µs of CPU per rebuild, measured** (512 RK4 steps + resample; see the bench in
 * `test/sim/canopy/convection/plume.test.ts`, run on the CI box, which is slower than the
 * target i9). That is 82 µs per wall-clock second per plume source — not a line item in any
 * budget, and the step count can drop to 256 if it ever becomes one.
 *
 * The per-voxel *evaluation* is separate and runs at the canopy step rate, because convection
 * ignites fuel in ~1 s (§7.5) and is the fast channel. Only the field is amortised.
 */
export const PLUME_LUT_UPDATE_HZ = 2

/**
 * Resample a solved profile onto the uniform-height LUT the shader samples.
 *
 * Row `i` is at height `i · PLUME_LUT_TOP_M / (PLUME_LUT_ROWS − 1)` above the source and holds
 * `[ΔT_c (K), w_c (m s⁻¹), b (m), x_tilt (m)]`.
 */
export function buildPlumeLut(
  profile: PlumeProfile,
  rows = PLUME_LUT_ROWS,
  topM = PLUME_LUT_TOP_M,
): Float32Array {
  const out = new Float32Array(rows * PLUME_LUT_FLOATS_PER_ROW)
  const dz = topM / (rows - 1)
  const n = profile.z.length
  let j = 0
  for (let i = 0; i < rows; i++) {
    const zTarget = i * dz
    while (j < n - 2 && profile.z[j + 1]! < zTarget) j++
    const z0 = profile.z[j]!
    const z1 = profile.z[j + 1]!
    const t = z1 > z0 ? Math.min(Math.max((zTarget - z0) / (z1 - z0), 0), 1) : 0
    const lerp = (a: Float64Array): number => a[j]! + (a[j + 1]! - a[j]!) * t
    const o = i * PLUME_LUT_FLOATS_PER_ROW
    out[o] = lerp(profile.centrelineExcessTempK)
    out[o + 1] = lerp(profile.centrelineVelocity)
    out[o + 2] = lerp(profile.halfWidth)
    out[o + 3] = lerp(profile.tiltX)
  }
  return out
}

export interface PlumeGasState {
  /** Gas temperature at the sample point [K]. */
  readonly gasTempK: number
  /** Speed of the gas past a (stationary) fuel element [m s⁻¹] — plume vertical plus ambient wind. */
  readonly gasSpeed: MetresPerSecond
}

/**
 * Sample the plume field at a point, given as height above the source and cross-plume offset
 * from the *untilted* source position. This is the TypeScript oracle for `plumeGasState()` in
 * `convection.wgsl`; the two must stay identical.
 *
 * `acrossM` is the horizontal distance downwind of the source. The centreline has drifted to
 * `x_tilt(z)`, so the Gaussian is evaluated on `acrossM − x_tilt`. Velocity uses half-width
 * `b`, temperature uses `λb` — the two profiles have different widths and swapping them is
 * the other half of the convention error `λ` exists to prevent.
 */
export function samplePlumeLut(
  lut: Float32Array,
  heightM: number,
  acrossM: number,
  cfg: { ambientTempK: number; windSpeed: number; lambda?: number; rows?: number; topM?: number },
): PlumeGasState {
  const rows = cfg.rows ?? PLUME_LUT_ROWS
  const topM = cfg.topM ?? PLUME_LUT_TOP_M
  const lambda = cfg.lambda ?? PLUME_LAMBDA
  const u = cfg.windSpeed

  if (heightM < 0 || heightM > topM) {
    return { gasTempK: cfg.ambientTempK, gasSpeed: Math.abs(u) as MetresPerSecond }
  }
  const f = (heightM / topM) * (rows - 1)
  const i0 = Math.min(Math.floor(f), rows - 2)
  const t = f - i0
  const o0 = i0 * PLUME_LUT_FLOATS_PER_ROW
  const o1 = o0 + PLUME_LUT_FLOATS_PER_ROW
  const mix = (k: number): number => lut[o0 + k]! + (lut[o1 + k]! - lut[o0 + k]!) * t

  const dTc = mix(0)
  const w = mix(1)
  const b = Math.max(mix(2), 1e-3)
  const xTilt = mix(3)

  const s = acrossM - xTilt
  const gaussV = Math.exp(-(s * s) / (b * b))
  const gaussT = Math.exp(-(s * s) / (lambda * lambda * b * b))
  const wLocal = w * gaussV
  return {
    gasTempK: cfg.ambientTempK + dTc * gaussT,
    gasSpeed: Math.hypot(wLocal, u) as MetresPerSecond,
  }
}

/**
 * Bind group index the WGSL library declares for itself. Group 3 so it composes with whatever
 * WP 3.1's voxel pass already binds at 0–2.
 */
export const CONVECTION_BIND_GROUP = 3

/** `PlumeUniforms` in convection.wgsl: 32 × vec4 LUT + params vec4 + axis vec4. */
export const PLUME_UNIFORM_BYTES = (PLUME_LUT_ROWS + 2) * PLUME_LUT_FLOATS_PER_ROW * 4

export interface PlumeUniformInputs {
  /** LUT from `buildPlumeLut`. */
  readonly lut: Float32Array
  /** Plume source position in world XZ [m] — the surface cell driving this plume. */
  readonly sourceX: number
  readonly sourceZ: number
  /** Ground height of the source [m], subtracted from voxel Y to get height above the fire. */
  readonly sourceGroundY: number
  /** Ambient wind speed at canopy level [m s⁻¹]. */
  readonly windSpeed: number
  /** Ambient air temperature [K]. */
  readonly ambientTempK: number
  /** Unit wind direction in world XZ — the direction the plume leans. */
  readonly windDirX: number
  readonly windDirZ: number
}

/**
 * Pack `PlumeUniforms`. One definition of the struct layout on this side of the boundary, so a
 * field reorder in the WGSL is a one-file fix rather than a silent misread.
 */
export function packPlumeUniforms(inp: PlumeUniformInputs): Float32Array {
  const out = new Float32Array(PLUME_UNIFORM_BYTES / 4)
  out.set(inp.lut.subarray(0, PLUME_LUT_ROWS * PLUME_LUT_FLOATS_PER_ROW), 0)
  const o = PLUME_LUT_ROWS * PLUME_LUT_FLOATS_PER_ROW
  out[o] = inp.sourceX
  out[o + 1] = inp.sourceZ
  out[o + 2] = inp.windSpeed
  out[o + 3] = inp.ambientTempK
  out[o + 4] = inp.windDirX
  out[o + 5] = inp.windDirZ
  out[o + 6] = inp.sourceGroundY
  out[o + 7] = 0
  return out
}
