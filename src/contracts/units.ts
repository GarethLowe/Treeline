/**
 * Normative unit conventions. See docs/spec/00-overview.md §0.6.
 *
 * Fire science mixes unit systems badly: Rothermel's coefficients are dimensional fits in
 * BTU-lb-ft-min, McArthur's are km/h and mm, and moisture is quoted as a percentage in
 * nearly every source paper but must be a fraction in nearly every equation. A unit error
 * here does not throw and does not look wrong — it produces a fire that spreads plausibly
 * at the wrong rate, and no acceptance test that exercises one fuel model at one moisture
 * will catch it.
 *
 * So the conventions are enforced by the type system rather than by discipline. These are
 * branded types: zero runtime cost (they erase to `number`), but a `MoisturePercent` cannot
 * be passed where a `MoistureFraction` is expected. Conversion must go through a named
 * function, which makes every unit boundary in the codebase greppable.
 */

declare const BRAND: unique symbol

/** A `number` tagged with a unit, erased at compile time. */
type Unit<Tag extends string> = number & { readonly [BRAND]: Tag }

// ---------------------------------------------------------------------------
// Moisture
// ---------------------------------------------------------------------------

/** Fuel moisture as an oven-dry-mass fraction, range [0, ~4]. The internal convention. */
export type MoistureFraction = Unit<'MoistureFraction'>
/** Fuel moisture as a percentage. Exists only in source fuel tables and in the HUD. */
export type MoisturePercent = Unit<'MoisturePercent'>

export const moistureFraction = (v: number): MoistureFraction => v as MoistureFraction
export const moisturePercent = (v: number): MoisturePercent => v as MoisturePercent
export const pctToFrac = (v: MoisturePercent): MoistureFraction => (v / 100) as MoistureFraction
export const fracToPct = (v: MoistureFraction): MoisturePercent => (v * 100) as MoisturePercent

// ---------------------------------------------------------------------------
// SI storage units — what lives in memory and on the GPU
// ---------------------------------------------------------------------------

/** Metres. */
export type Metres = Unit<'m'>
/** Metres per second. Wind speed, rate of spread. */
export type MetresPerSecond = Unit<'m/s'>
/** Kilograms per square metre. Fuel load. */
export type KgPerSquareMetre = Unit<'kg/m2'>
/** Kilograms per cubic metre. Bulk density, crown bulk density. */
export type KgPerCubicMetre = Unit<'kg/m3'>
/** Reciprocal metres. Surface-area-to-volume ratio. */
export type PerMetre = Unit<'1/m'>
/** Kelvin. All temperatures internally; °C only at UI boundaries. */
export type Kelvin = Unit<'K'>
/** Kilowatts per metre. Byram fireline intensity. */
export type KilowattsPerMetre = Unit<'kW/m'>
/** Kilowatts per square metre. Reaction intensity, radiant heat flux. */
export type KilowattsPerSquareMetre = Unit<'kW/m2'>
/** Kilojoules per kilogram. Heat content. */
export type KilojoulesPerKg = Unit<'kJ/kg'>
/** Seconds. Simulated clock time, residence time, timelag. */
export type Seconds = Unit<'s'>
/** Radians. All angles internally; degrees only at UI boundaries. */
export type Radians = Unit<'rad'>
/** Dimensionless slope as a tangent — what the physics actually consumes. */
export type SlopeTangent = Unit<'tan'>

export const m = (v: number): Metres => v as Metres
export const mps = (v: number): MetresPerSecond => v as MetresPerSecond
export const kgm2 = (v: number): KgPerSquareMetre => v as KgPerSquareMetre
export const kgm3 = (v: number): KgPerCubicMetre => v as KgPerCubicMetre
export const perM = (v: number): PerMetre => v as PerMetre
export const K = (v: number): Kelvin => v as Kelvin
export const kWm = (v: number): KilowattsPerMetre => v as KilowattsPerMetre
export const kWm2 = (v: number): KilowattsPerSquareMetre => v as KilowattsPerSquareMetre
export const kJkg = (v: number): KilojoulesPerKg => v as KilojoulesPerKg
export const s = (v: number): Seconds => v as Seconds
export const rad = (v: number): Radians => v as Radians
export const slopeTan = (v: number): SlopeTangent => v as SlopeTangent

// ---------------------------------------------------------------------------
// English units — exist ONLY inside the Rothermel kernel boundary
// ---------------------------------------------------------------------------

/**
 * Rothermel (1972) coefficients are dimensional fits in BTU-lb-ft-min. Converting them to
 * SI would change ~20 published constants and break every cross-check against BEHAVE and
 * the source paper. So the kernel converts at its boundary instead — the same choice
 * WRF-Fire makes (Mandel et al. 2011). These types make it a type error to let an English
 * quantity escape into general code.
 */
export type Feet = Unit<'ft'>
export type FeetPerMinute = Unit<'ft/min'>
export type PoundsPerSquareFoot = Unit<'lb/ft2'>
export type PoundsPerCubicFoot = Unit<'lb/ft3'>
export type PerFoot = Unit<'1/ft'>
export type BtuPerPound = Unit<'BTU/lb'>
export type BtuPerSquareFootMinute = Unit<'BTU/ft2/min'>

/**
 * Conversion factors are DERIVED from the exact SI definitions below, never transcribed as
 * rounded decimals.
 *
 * The spec quotes the published pair 0.204816 (SI→English) and 4.88243 (English→SI) for
 * fuel load. Those are each correctly rounded, but they are not exact reciprocals — their
 * product is 0.99999978, so a round trip drifts by ~2×10⁻⁷ and, worse, the forward and
 * reverse paths disagree. Deriving one from the other makes the round trip exact to
 * floating-point and removes a whole class of "why doesn't this match BehavePlus in the
 * seventh digit" investigation.
 */
const FT_TO_M = 0.3048 // exact by definition
const LB_TO_KG = 0.45359237 // exact by definition
const BTU_TO_J = 1055.05585262 // IT calorie definition
const M2_PER_FT2 = FT_TO_M ** 2
const M3_PER_FT3 = FT_TO_M ** 3
const SHORT_TON_TO_KG = 2000 * LB_TO_KG
const ACRE_TO_M2 = 43560 * M2_PER_FT2

const LBFT2_TO_KGM2 = LB_TO_KG / M2_PER_FT2 // 4.8824276…
const LBFT3_TO_KGM3 = LB_TO_KG / M3_PER_FT3 // 16.018463…
const FTMIN_TO_MPS = FT_TO_M / 60 // 0.00508 exact
const BTULB_TO_KJKG = BTU_TO_J / LB_TO_KG / 1000 // 2.326 exact
const BTUFT2MIN_TO_KWM2 = BTU_TO_J / M2_PER_FT2 / 60 / 1000 // 0.1892751…
const TONSACRE_TO_KGM2 = SHORT_TON_TO_KG / ACRE_TO_M2 // 0.2241702…

/** SI → English, at the Rothermel kernel entry. */
export const toFeet = (v: Metres): Feet => (v / FT_TO_M) as Feet
export const toFeetPerMinute = (v: MetresPerSecond): FeetPerMinute =>
  (v / FTMIN_TO_MPS) as FeetPerMinute
export const toLbPerFt2 = (v: KgPerSquareMetre): PoundsPerSquareFoot =>
  (v / LBFT2_TO_KGM2) as PoundsPerSquareFoot
export const toLbPerFt3 = (v: KgPerCubicMetre): PoundsPerCubicFoot =>
  (v / LBFT3_TO_KGM3) as PoundsPerCubicFoot
export const toPerFoot = (v: PerMetre): PerFoot => (v * FT_TO_M) as PerFoot
export const toBtuPerLb = (v: KilojoulesPerKg): BtuPerPound => (v / BTULB_TO_KJKG) as BtuPerPound

/** English → SI, at the Rothermel kernel exit. */
export const fromFeet = (v: Feet): Metres => (v * FT_TO_M) as Metres
export const fromFeetPerMinute = (v: FeetPerMinute): MetresPerSecond =>
  (v * FTMIN_TO_MPS) as MetresPerSecond
export const fromLbPerFt2 = (v: PoundsPerSquareFoot): KgPerSquareMetre =>
  (v * LBFT2_TO_KGM2) as KgPerSquareMetre
export const fromPerFoot = (v: PerFoot): PerMetre => (v / FT_TO_M) as PerMetre
export const fromBtuPerFt2Min = (v: BtuPerSquareFootMinute): KilowattsPerSquareMetre =>
  (v * BTUFT2MIN_TO_KWM2) as KilowattsPerSquareMetre

/** Fuel-table loads are published in short tons per acre. */
export const tonsPerAcreToKgM2 = (v: number): KgPerSquareMetre =>
  (v * TONSACRE_TO_KGM2) as KgPerSquareMetre
export const tonsPerAcreToLbFt2 = (v: number): PoundsPerSquareFoot =>
  (v * (TONSACRE_TO_KGM2 / LBFT2_TO_KGM2)) as PoundsPerSquareFoot

/** Exposed so tests can assert the derived factors against the published rounded values. */
export const FACTORS = {
  LBFT2_TO_KGM2,
  LBFT3_TO_KGM3,
  FTMIN_TO_MPS,
  BTULB_TO_KJKG,
  BTUFT2MIN_TO_KWM2,
  TONSACRE_TO_KGM2,
} as const

// ---------------------------------------------------------------------------
// UI boundary conversions
// ---------------------------------------------------------------------------

export const degToRad = (deg: number): Radians => ((deg * Math.PI) / 180) as Radians
export const radToDeg = (r: Radians): number => (r * 180) / Math.PI
export const celsiusToK = (c: number): Kelvin => (c + 273.15) as Kelvin
export const kToCelsius = (k: Kelvin): number => k - 273.15
export const kmhToMps = (kmh: number): MetresPerSecond => (kmh / 3.6) as MetresPerSecond
export const mpsToKmh = (v: MetresPerSecond): number => v * 3.6
/** Chains per hour — the unit published fire-behaviour tables use for rate of spread. */
export const chainsPerHourToMps = (ch: number): MetresPerSecond =>
  ((ch * 20.1168) / 3600) as MetresPerSecond
export const mpsToChainsPerHour = (v: MetresPerSecond): number => (v * 3600) / 20.1168
