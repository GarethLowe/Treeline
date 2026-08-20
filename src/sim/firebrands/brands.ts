/**
 * WP 3.6 — Lagrangian firebrand physics. Pure, CLI-testable, no GPU.
 *
 * This is the CPU oracle for `shaders/sim/firebrands/firebrands.wgsl`: every function here has
 * a line-for-line counterpart in the shader, and the tests in `test/sim/firebrands/` prove the
 * physics on the CPU so that a device-only bug has nowhere left to hide. Spec §40.
 *
 * ## The one physical statement that matters
 *
 * Terminal velocity depends only on **areal density** σ = m/A⊥, not on lateral extent
 * (§2.2). A brand can be arbitrarily large in plan area — carrying arbitrarily large thermal
 * mass and burnout time — at unchanged v_t. Eucalypt ribbon bark exploits exactly this, which
 * is why it spots to kilometres and a conifer twig does not. Every part of this module is
 * organised around σ rather than around mass.
 *
 * ## The two traps this module is written to avoid
 *
 * 1. **σ branches on shape.** δ is a HALF-thickness everywhere (§2.2, §4.1), and
 *    σ = k_shape·ρ_p·δ with k = 2 for a plate but π/2 for a cylinder, because A⊥ is the plan
 *    area for one and the broadside area for the other. Applying the plate form uniformly
 *    overstates cylinder σ by 4/π and v_t by √(4/π) = 1.128 — exactly wrong for the two
 *    classes (W. US conifer, simple-cylinder eucalypt) that NIST and Hall actually measured.
 * 2. **C_D is referenced to the FULL projected area**, not to the random-orientation average.
 *    That is why the values are 0.47 (cylinder, broadside d×L) and 0.95 (plate, plan L×I) and
 *    not the ~1.0/1.3 a half-area convention would give. See `provenance.ts`.
 */

import type {
  Kelvin,
  KgPerCubicMetre,
  Metres,
  MetresPerSecond,
  MoistureFraction,
  Seconds,
} from '@contracts/units'
import { m as metres, mps } from '@contracts/units'

// ---------------------------------------------------------------------------
// Environment constants
// ---------------------------------------------------------------------------

/** m s⁻². */
export const GRAVITY = 9.81
/** kg m⁻³ at 293 K, 1 atm. The reference density every tabulated v_t in §2.1 was solved at. */
export const AIR_DENSITY = 1.2
/** Pa s, dry air at 293 K. Only enters through Re in the regression-rate enhancement. */
export const AIR_VISCOSITY = 1.81e-5
/** Reference temperature for AIR_DENSITY, K. */
export const AIR_REF_TEMPERATURE = 293

/**
 * Brand bulk density, kg m⁻³. Petersen & Banerjee (2024) §II C: 360 ± 9 by gas pycnometry on
 * embers from a ponderosa/Douglas-fir pile burn. Lower than unburnt wood because of thermal
 * degradation — using an unburnt-wood density here would inflate σ, and therefore v_t, by
 * ~20-25%.
 */
export const BRAND_BULK_DENSITY = 360 as KgPerCubicMetre

/** Ideal-gas correction for air density in a hot plume. Cheap and it matters: at 1000 K the
 * drag force is a third of what the cold-air value gives. */
export const airDensityAt = (t: Kelvin): number => (AIR_DENSITY * AIR_REF_TEMPERATURE) / Math.max(t, 200)

// ---------------------------------------------------------------------------
// Shape classes
// ---------------------------------------------------------------------------

export type BrandShape = 'plate' | 'cylinder' | 'ribbon'

export interface ShapeDef {
  /** Nibble written into `Brand.packed`; the shader indexes its table with this. */
  readonly code: number
  /** σ = k·ρ_p·δ. 2 for a plate (full thickness 2δ), π/2 for a cylinder of diameter 2δ. */
  readonly kShape: number
  /** Orientation-averaged C_D referenced to the FULL projected area named below. */
  readonly cd: number
  readonly referenceArea: string
}

export const SHAPES: Readonly<Record<BrandShape, ShapeDef>> = {
  plate: { code: 0, kShape: 2, cd: 0.95, referenceArea: 'plan L×I' },
  cylinder: { code: 1, kShape: Math.PI / 2, cd: 0.47, referenceArea: 'broadside d×L' },
  /** Convoluted ribbon cylinder: treated as a plate for drag; σ is the calibrated quantity. */
  ribbon: { code: 2, kShape: 2, cd: 0.95, referenceArea: 'plan area' },
}

export const SHAPE_BY_CODE: readonly BrandShape[] = ['plate', 'cylinder', 'ribbon']

/** σ = m/A⊥ in kg m⁻², from the half-thickness. Branches on shape — see the module header. */
export function arealDensity(
  shape: BrandShape,
  halfThk: number,
  bulkDensity: number = BRAND_BULK_DENSITY,
): number {
  return SHAPES[shape].kShape * bulkDensity * Math.max(halfThk, 0)
}

/** v_t = √(2σg/(ρ_a C_D)). Depends on σ alone — never on how big the brand is in plan. */
export function terminalVelocity(
  shape: BrandShape,
  halfThk: number,
  bulkDensity: number = BRAND_BULK_DENSITY,
  rhoAir: number = AIR_DENSITY,
): MetresPerSecond {
  const sigma = arealDensity(shape, halfThk, bulkDensity)
  return mps(Math.sqrt((2 * sigma * GRAVITY) / (rhoAir * SHAPES[shape].cd)))
}

/** Inverse of {@link terminalVelocity}: the δ a measured v_t implies. How the eucalypt rows of
 * the §2.1 table were solved, and how a new biome row should be entered. */
export function halfThicknessForTerminalVelocity(
  shape: BrandShape,
  vt: number,
  bulkDensity: number = BRAND_BULK_DENSITY,
  rhoAir: number = AIR_DENSITY,
): Metres {
  const sigma = (vt * vt * rhoAir * SHAPES[shape].cd) / (2 * GRAVITY)
  return metres(sigma / (SHAPES[shape].kShape * bulkDensity))
}

// ---------------------------------------------------------------------------
// Brand classes — the §2.1 table
// ---------------------------------------------------------------------------

export type BrandClassId =
  | 'conifer-cylinder'
  | 'eucalypt-ribbon'
  | 'eucalypt-plate'
  | 'eucalypt-cylinder'
  | 'grass-plate'
  | 'chaparral-plate'
  | 'uk-plate'

export interface BrandClass {
  readonly id: BrandClassId
  readonly shape: BrandShape
  /** Half-thickness at spawn, m. */
  readonly halfThk: Metres
  /** Burnout time at terminal-velocity conditions, s. Sets β₀ = δ₀/t_burnout. */
  readonly burnout: Seconds
  /** Brands per kg of the source component consumed. = Y_j/m̄_j (§2.1). */
  readonly brandsPerKg: number
  /** Truncation of the −2 power law in projected area, expressed as mass, kg. */
  readonly massMin: number
  readonly massMax: number
  /** `estimated` rows are calibration parameters, not measurements. */
  readonly sourced: boolean
}

const cls = (
  id: BrandClassId,
  shape: BrandShape,
  halfThkMm: number,
  burnoutS: number,
  brandsPerKg: number,
  massMinG: number,
  massMaxG: number,
  sourced: boolean,
): BrandClass => ({
  id,
  shape,
  halfThk: metres(halfThkMm * 1e-3),
  burnout: burnoutS as Seconds,
  brandsPerKg,
  massMin: massMinG * 1e-3,
  massMax: massMaxG * 1e-3,
  sourced,
})

/**
 * §2.1, reconciled: every row satisfies v_t = √(2σg/(ρ_a C_D)) at the sourced C_D of §2.2,
 * with δ the half-thickness. `test/sim/firebrands/brands.test.ts` asserts each tabulated v_t.
 *
 * δ per row: conifer d = 4 mm (Manzello's 5.2 m Douglas-fir, 18% MC) → δ = 2.0 mm, σ = 1.13,
 * v_t = 6.1. Eucalypt δ solved from Hall's measured v_t (5.4 / 5.2 / 5.8). The three
 * `estimated` rows take the UPPER σ end of their range, because §2.1 records those σ as a
 * lower bound biased toward over-long spot distances; the upper end is the less biased choice.
 */
export const BRAND_CLASSES: Readonly<Record<BrandClassId, BrandClass>> = {
  // Manzello et al. 2009 (NIST): all collected Douglas-fir/Korean pine brands were cylinders,
  // 3-5 mm × 34-53 mm, most masses < 0.3 g, largest 3.5-3.9 g.
  'conifer-cylinder': cls('conifer-cylinder', 'cylinder', 2.0, 115, 200, 0.05, 3.9, true),
  // Hall et al. 2015, E. viminalis ribbon gum, tethered at terminal velocity in a vertical
  // wind tunnel. The convoluted cylinder is the extreme brand known: 429 s mean burnout,
  // 1304 s max, at v_t 5.8 m/s.
  'eucalypt-ribbon': cls('eucalypt-ribbon', 'ribbon', 2.715, 429, 100, 0.5, 20, true),
  'eucalypt-plate': cls('eucalypt-plate', 'plate', 2.353, 251, 100, 0.5, 20, true),
  'eucalypt-cylinder': cls('eucalypt-cylinder', 'cylinder', 1.374, 122, 100, 0.5, 20, true),
  // Unsourced rows. σ upper end of the §2.1 range; masses and burnout times are (assumed).
  'grass-plate': cls('grass-plate', 'plate', 0.264, 25, 500, 0.005, 0.05, false),
  'chaparral-plate': cls('chaparral-plate', 'plate', 1.986, 120, 800, 0.02, 1.0, false),
  'uk-plate': cls('uk-plate', 'plate', 0.66, 60, 400, 0.01, 0.3, false),
}

/**
 * Species → brand class. `bark` and `firebrandSource` are already on `SpeciesDef` (M1) and the
 * whole reason `bark` is there is this function: decorticating ribbon bark is the single
 * largest firebrand source known.
 */
export function brandClassForSpecies(
  bark: string,
  form: string,
  firebrandSource: boolean,
): BrandClass {
  if (bark === 'decorticating-ribbon') return BRAND_CLASSES['eucalypt-ribbon']
  if (bark === 'fibrous') return BRAND_CLASSES[firebrandSource ? 'eucalypt-plate' : 'uk-plate']
  if (form === 'grass') return BRAND_CLASSES['grass-plate']
  if (form === 'shrub') return BRAND_CLASSES['chaparral-plate']
  if (form === 'conifer') return BRAND_CLASSES['conifer-cylinder']
  return BRAND_CLASSES['uk-plate']
}

/**
 * Yield multiplier for a species that is not a significant brand shedder. Not zero: litter and
 * foliage under a non-shedding species still produce brands, they just do not produce the bark
 * flux that makes eucalypt eucalypt. `estimated`.
 */
export const NON_SHEDDER_YIELD = 0.15

// ---------------------------------------------------------------------------
// Brand state
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number]

/** Mirrors `struct Brand` (48 B) in the shader; see `layout.ts`. */
export interface BrandState {
  readonly pos: Vec3
  /** δ, m. Half-thickness — see the module header. */
  readonly halfThk: number
  readonly vel: Vec3
  /** m/m₀. */
  readonly massFrac: number
  /** Equivalent diameter of the projected area, m: d_eq = √(4A⊥/π). */
  readonly areaEq: number
  /** Super-particle multiplicity. */
  readonly weight: number
  readonly age: number
  readonly shape: BrandShape
}

export const projectedArea = (areaEq: number): number => (Math.PI / 4) * areaEq * areaEq
export const equivalentDiameter = (area: number): number => Math.sqrt((4 * area) / Math.PI)

/** Current mass, kg. σ·A⊥ with the CURRENT δ and d_eq — so it falls as the brand burns. */
export function brandMass(b: BrandState, bulkDensity: number = BRAND_BULK_DENSITY): number {
  return arealDensity(b.shape, b.halfThk, bulkDensity) * projectedArea(b.areaEq)
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

export interface FlightParams {
  /** Reference regression rate β₀ = δ₀/t_burnout, m s⁻¹. */
  readonly beta0: number
  /** Brand moisture, fraction. Lofted brands are already pyrolysed; the default path is 0. */
  readonly moisture: MoistureFraction
  readonly bulkDensity: number
}

/** τ is capped because as |v−u| → 0 the analytic limit is free fall but the float form is a
 * cancellation. 10³ s is ~10⁵ × any dt we ever take, so the cap is unobservable. */
const TAU_MAX = 1e3

/** Drag relaxation time, s. τ = σ/(½ρ_a C_D |v−u|) (§4.3). */
export function dragRelaxationTime(
  shape: BrandShape,
  halfThk: number,
  relSpeed: number,
  rhoAir: number = AIR_DENSITY,
  bulkDensity: number = BRAND_BULK_DENSITY,
): number {
  const sigma = arealDensity(shape, halfThk, bulkDensity)
  const denom = 0.5 * rhoAir * SHAPES[shape].cd * Math.max(relSpeed, 1e-6)
  return Math.min(sigma / denom, TAU_MAX)
}

/** 1 − e^(−h), series-guarded for small h. The shader uses the identical branch. */
export function oneMinusExp(h: number): number {
  return h < 1e-4 ? h * (1 - 0.5 * h) : 1 - Math.exp(-h)
}

/**
 * Moisture retardation of the surface regression rate, §2.4's χ(MC).
 *
 * **`estimated`.** No source gives χ for an airborne brand. The form is monotone decreasing
 * and χ(0) = 1, so the default path — brands spawn dry, having already pyrolysed — is
 * unaffected, and the coefficient only matters if a caller injects wet brands.
 */
export const CHI_MOISTURE_COEFF = 3.0
export const moistureRetardation = (mc: number): number => 1 / (1 + CHI_MOISTURE_COEFF * mc)

/** Reynolds number on the equivalent diameter. */
export const reynolds = (relSpeed: number, dEq: number, rhoAir: number = AIR_DENSITY): number =>
  (rhoAir * relSpeed * dEq) / AIR_VISCOSITY

/**
 * Surface regression rate, m s⁻¹ (§2.4). The Ranz–Marshall-form √Re enhancement makes a brand
 * accelerating through the plume at 20 m s⁻¹ burn faster than one drifting at v_t.
 *
 * **Re_t is evaluated at the brand's CURRENT geometry, not at its spawn geometry.** That is the
 * difference between β₀ meaning what §2.4 says it means and not: normalising against a frozen
 * spawn Re_t makes the enhancement drift below 1 as the brand shrinks, which stretches burnout
 * ~40% past the published time and silently decalibrates β₀ = δ₀/t_burnout. Evaluated at the
 * current geometry the ratio collapses to |v−u|/v_t, so a brand descending at terminal velocity
 * burns out at exactly the wind-tunnel time it was measured at.
 */
export function regressionRate(p: FlightParams, re: number, reT: number): number {
  const enh = (1 + 0.3 * Math.sqrt(Math.max(re, 0))) / (1 + 0.3 * Math.sqrt(Math.max(reT, 0)))
  return p.beta0 * enh * moistureRetardation(p.moisture)
}

/** β₀ for a class: δ₀ regresses to zero in exactly t_burnout at terminal-velocity conditions. */
export const beta0For = (c: BrandClass): number => c.halfThk / c.burnout

/**
 * One substep of transport + combustion.
 *
 * The integrator is the semi-analytic exponential of §4.3, extended to position with the exact
 * integral of its own velocity so the trajectory is right at large dt as well:
 *
 *   v₁ = u + gτ + (v₀ − u − gτ)e^(−dt/τ)
 *   x₁ = x₀ + (u + gτ)dt + (v₀ − u − gτ)τ(1 − e^(−dt/τ))
 *
 * With τ ≈ 0.004–0.017 s for the thin-plate classes in a 20 m s⁻¹ plume, explicit Euler would
 * need 4+ substeps per frame. This is unconditionally stable and costs one `exp`. That is the
 * whole reason brands can run at the solver's 2-10 Hz rather than at 60 Hz.
 *
 * Mass loss is thickness AND lateral regression: the same β eats 2β s⁻¹ off the full thickness
 * and off d_eq, so m/m₀ = (δ/δ₀)(d_eq/d_eq₀)², accumulated incrementally. For a 10 m ribbon the
 * lateral term is ~1 and
 * burnout is a thickness process; for a 3 mm twig it is not. Keeping both is what makes the
 * `m/m₀ > f_glow` test say something different from `δ > 0`.
 */
export function stepBrand(
  b: BrandState,
  u: Vec3,
  dt: number,
  p: FlightParams,
  rhoAir: number = AIR_DENSITY,
): BrandState {
  const rel: Vec3 = [b.vel[0] - u[0], b.vel[1] - u[1], b.vel[2] - u[2]]
  const relSpeed = Math.hypot(rel[0], rel[1], rel[2])
  const tau = dragRelaxationTime(b.shape, b.halfThk, relSpeed, rhoAir, p.bulkDensity)
  const gEff = -GRAVITY * (1 - rhoAir / p.bulkDensity)
  const k = oneMinusExp(dt / tau)
  const e = 1 - k

  // uz + g*tau is the drift-free steady state; the exponential relaxes onto it.
  const sx = u[0]
  const sy = u[1]
  const sz = u[2] + gEff * tau
  const dx0 = b.vel[0] - sx
  const dy0 = b.vel[1] - sy
  const dz0 = b.vel[2] - sz

  const pos: Vec3 = [
    b.pos[0] + sx * dt + dx0 * tau * k,
    b.pos[1] + sy * dt + dy0 * tau * k,
    b.pos[2] + sz * dt + dz0 * tau * k,
  ]
  const vel: Vec3 = [sx + dx0 * e, sy + dy0 * e, sz + dz0 * e]

  const vtNow = terminalVelocity(b.shape, b.halfThk, p.bulkDensity, rhoAir)
  const beta = regressionRate(
    p,
    reynolds(relSpeed, b.areaEq, rhoAir),
    reynolds(vtNow, b.areaEq, rhoAir),
  )
  const halfThk = Math.max(b.halfThk - beta * dt, 0)
  const areaEq = Math.max(b.areaEq - 2 * beta * dt, 0)
  // Incremental rather than referenced to (delta0, d_eq0): the ratios telescope to exactly the
  // same product, and the GPU struct then needs no spawn-state fields to carry around.
  const rThk = b.halfThk > 0 ? halfThk / b.halfThk : 0
  const rArea = b.areaEq > 0 ? areaEq / b.areaEq : 0
  const massFrac = b.massFrac * rThk * rArea * rArea

  return { ...b, pos, vel, halfThk, areaEq, massFrac, age: b.age + dt }
}

export interface Flight {
  readonly landed: BrandState
  /** Horizontal distance travelled from release, m. */
  readonly distance: number
  /** Total time of flight, s. */
  readonly time: number
  /** True if the brand was still an ignition source at ground contact (§2.5). */
  readonly glowing: boolean
  /** True if the loop hit its step cap rather than the ground — the result is a lower bound. */
  readonly truncated: boolean
}

/**
 * Integrate a single brand to ground contact. This is the CPU oracle for the shader's substep
 * loop; the tests measure spot distance with it.
 *
 * The substep is fixed rather than adaptive on purpose. τ is unconditionally handled by the
 * exponential integrator, so the step is set by how fast the *fluid* field changes along the
 * trajectory, not by stability — 0.1 s at 20 m s⁻¹ is 2 m, one canopy voxel.
 */
export function flyToGround(
  start: BrandState,
  wind: (pos: Vec3, t: number) => Vec3,
  p: FlightParams,
  dtSub = 0.1,
  maxTime = 3600,
  groundZ = 0,
): Flight {
  let b = start
  let t = 0
  while (b.pos[2] > groundZ && t < maxTime) {
    b = stepBrand(b, wind(b.pos, t), dtSub, p)
    t += dtSub
    if (!stillGlowing(b) && b.halfThk <= 0) break
  }
  return {
    landed: b,
    distance: Math.hypot(b.pos[0] - start.pos[0], b.pos[1] - start.pos[1]),
    time: t,
    glowing: stillGlowing(b) && b.pos[2] <= groundZ,
    truncated: t >= maxTime,
  }
}

// ---------------------------------------------------------------------------
// Burnout criterion (§2.5)
// ---------------------------------------------------------------------------

/**
 * m/m₀ below which a brand is no longer a viable ignition source. Ellis (2011) combusted
 * *E. obliqua* stringybark to ~20% of initial mass and still obtained ignitions on litter beds,
 * so 0.20 is the floor at which we stop believing in it, not a safety margin.
 */
export const GLOW_MASS_FRACTION = 0.2

/** Both conditions required (§2.5). A brand failing either is killed and contributes only to
 * the ash/soot field. */
export const stillGlowing = (b: BrandState): boolean =>
  b.halfThk > 0 && b.massFrac > GLOW_MASS_FRACTION

// ---------------------------------------------------------------------------
// Generation (§2.1)
// ---------------------------------------------------------------------------

/**
 * Counter-based hash RNG. Stateless, keyed on (cell, frame), so spawning is reproducible run
 * to run and there is no RNG state buffer — which is the whole point: a spot-fire bug you
 * cannot reproduce is a spot-fire bug you cannot fix.
 *
 * PCG-XSH-RR-flavoured; the shader has the identical integer sequence.
 */
export function hashU32(x: number): number {
  const v = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul((v >>> ((v >>> 28) + 4)) ^ v, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}

export const hash2 = (a: number, b: number): number => hashU32((a ^ hashU32(b)) >>> 0)
export const hash01 = (a: number, b: number): number => hash2(a, b) / 4294967296

/**
 * Brands spawned by one cell this step. Ṅ = ṁ·(brands per kg)·yield, and the fractional
 * remainder is resolved stochastically so a cell producing 0.3 brands per step is not silently
 * rounded to zero — over a 2048² grid that truncation would delete most of the spotting.
 */
export function spawnCount(
  massLossRateKgS: number,
  brandsPerKg: number,
  yieldMul: number,
  dt: number,
  weight: number,
  u01: number,
): number {
  const expected = (massLossRateKgS * brandsPerKg * yieldMul * dt) / Math.max(weight, 1)
  if (!(expected > 0)) return 0
  const whole = Math.floor(expected)
  return whole + (u01 < expected - whole ? 1 : 0)
}

/**
 * Sample projected area from a truncated power law of exponent −2, by inverse CDF.
 *
 * Petersen & Banerjee (2024) imaged 86,000 embers without the usual hand-picking bias and found
 * the PDFs of projected area, longest dimension and equivalent diameter all follow power laws
 * of slope ≈ −2 across three decades — the signature of brittle fragmentation — and state
 * explicitly that there is **no size distribution with a defined mean or mode**. So sampling a
 * delta at m̄, or a lognormal, would be inventing a scale the measurement says does not exist.
 * The truncation below is the spec's own "large enough to ignite" cut, and it is what gives the
 * distribution a finite mean at all.
 */
export function sampleProjectedArea(u01: number, aMin: number, aMax: number): number {
  const lo = 1 / Math.max(aMin, 1e-12)
  const hi = 1 / Math.max(aMax, 1e-12)
  return 1 / (lo - u01 * (lo - hi))
}

/** Analytic mean of that distribution — the m̄ the §2.1 table quotes, and a free cross-check. */
export function meanProjectedArea(aMin: number, aMax: number): number {
  return (Math.log(aMax / aMin) * (aMin * aMax)) / (aMax - aMin)
}

/** Spawn a brand of class `c` from the uniforms `u`, at `pos` with the local fluid velocity. */
export function spawnBrand(c: BrandClass, u01: number, pos: Vec3, vel: Vec3, weight = 1): BrandState {
  const sigma = arealDensity(c.shape, c.halfThk)
  const area = sampleProjectedArea(u01, c.massMin / sigma, c.massMax / sigma)
  return {
    pos,
    vel,
    halfThk: c.halfThk,
    massFrac: 1,
    areaEq: equivalentDiameter(area),
    weight,
    age: 0,
    shape: c.shape,
  }
}

export function flightParamsFor(c: BrandClass, moisture: MoistureFraction): FlightParams {
  return { beta0: beta0For(c), moisture, bulkDensity: BRAND_BULK_DENSITY }
}

// ---------------------------------------------------------------------------
// Landing ignition (§3)
// ---------------------------------------------------------------------------

/**
 * Logistic ignition-probability coefficients.
 *
 * **`estimated`, and that is the honest status.** §3 of the spec calls this a calibrated
 * construct, but under §0.7.3 `calibrated` means constants traced to a source with a page
 * citation, and these are not: there is no well-validated multivariate firebrand ignition
 * function in the literature — published studies are single- or two-factor on different fuel
 * beds, brand preparations and ignition definitions. The coefficients are fitted by hand to
 * reproduce the four published anchors listed in `provenance.ts`. The signs are firm
 * (b1 > 0, b2 < 0, b4 < 0); the magnitudes are biome-tunable and the uncertainty on a single
 * draw is easily ±0.2 absolute. That is tolerable only because we integrate over 10⁴-10⁵
 * brands and the aggregate spot rate is far better conditioned than any individual draw.
 */
export interface IgnitionCoeffs {
  readonly b0: number
  /** ln m, m in grams. */
  readonly b1: number
  /** Receptor moisture, % oven-dry. */
  readonly b2: number
  /** Surface windspeed at 0.1 m, m s⁻¹. */
  readonly b3: number
  /** Receptor bulk density, kg m⁻³. */
  readonly b4: number
  /** Flaming (1) vs glowing (0). */
  readonly b5: number
}

export const DEFAULT_IGNITION_COEFFS: IgnitionCoeffs = {
  b0: 1.0,
  b1: 0.8,
  b2: -0.15,
  b3: 0.25,
  b4: -0.012,
  b5: 3.2,
}

export interface LandingState {
  /** Brand mass at landing, kg. */
  readonly massKg: number
  /** Receptor moisture — a FRACTION, per §0.6. Converted to % inside, where the fit lives. */
  readonly receptorMoisture: MoistureFraction
  /** Windspeed at 0.1 m, m s⁻¹. */
  readonly surfaceWind: number
  /** Receptor bulk density, kg m⁻³. */
  readonly receptorBulkDensity: number
  readonly flaming: boolean
}

/** P_ig ∈ (0,1), always — the logistic cannot leave the interval and the test asserts it over
 * the full parameter sweep including degenerate masses. */
export function ignitionProbability(
  s: LandingState,
  c: IgnitionCoeffs = DEFAULT_IGNITION_COEFFS,
): number {
  const lnM = Math.log(Math.max(s.massKg, 1e-9) * 1000)
  const z =
    c.b0 +
    c.b1 * lnM +
    c.b2 * (s.receptorMoisture * 100) +
    c.b3 * s.surfaceWind +
    c.b4 * s.receptorBulkDensity +
    c.b5 * (s.flaming ? 1 : 0)
  // Branch-free-safe logistic: exp of a large positive argument overflows, so fold it.
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

/**
 * Area of receptor fuel a landed brand can actually take to ignition, m².
 *
 * §3 requires a **coalescence** check: a single 0.5 m cell ignition is well below the ~1 m²
 * minimum for a self-sustaining spot fire, so an ignition must survive a residence check before
 * it promotes to a live surface-fire cell, or spot-fire counts are massively over-predicted.
 * That check needs the receptor's own rate of spread and residence time, which belong to the
 * surface solver, so it is **not implemented here** — this function supplies the one piece that
 * is local to the brand: how big the seed patch is.
 *
 * The arithmetic is worth stating because it is the reason the gate matters at all. A 5 g brand
 * with 20% of its mass left as glowing char carries ~32 kJ; drying and preheating litter at
 * 0.5 kg m⁻² and 6% moisture costs ~1.76 MJ per kg, so the seed patch is ~0.04 m² — a 20 cm
 * spot, sub-cell on the 0.5 m grid. Firebrand ignition is a sub-grid process by construction.
 *
 * **`estimated`**: the char heat of combustion is standard, the preheat enthalpy is an
 * engineering number, and the fraction of the brand's energy that reaches the fuel rather than
 * the air is taken as 1 (optimistic — biases the patch area LONG).
 */
/** J kg⁻¹, char oxidation. */
export const CHAR_HEAT_OF_COMBUSTION = 32e6
/** J kg⁻¹ to take receptor fuel from ambient to ignition, dry. */
export const PREHEAT_ENTHALPY = 1.6e6
/** J kg⁻¹ of water: latent heat plus sensible heat to 100 °C. */
export const MOISTURE_SINK = 2.6e6

export function ignitedPatchArea(
  landedMassKg: number,
  receptorLoadKgM2: number,
  receptorMoisture: MoistureFraction,
): number {
  const perKg = PREHEAT_ENTHALPY + receptorMoisture * MOISTURE_SINK
  const load = Math.max(receptorLoadKgM2, 1e-6)
  return (Math.max(landedMassKg, 0) * GLOW_MASS_FRACTION * CHAR_HEAT_OF_COMBUSTION) / (perKg * load)
}
