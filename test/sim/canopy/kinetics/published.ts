/**
 * Published data WP 3.2 is validated against. Free sources only (spec §0.7.1).
 *
 * Transcribed from the PDFs, not from memory. Both McAllister tables were read from the USDA
 * treesearch copies; the two papers share the 20 kW/m2, 40 kW/m2 and 50 kW/m2 dry points
 * (75.3, 16.7, 9.7 s) and differ only at 30 kW/m2 (30.0 vs 28.0 s, different sample batches),
 * which is itself a useful check that the transcription is right.
 */

/**
 * McAllister, Finney & Cohen (2010), VI ICFFR Coimbra, Table 1.
 * Dry poplar, 1 m/s oxidiser flow. Incident radiant flux W/m2, time to ignition s,
 * critical mass flux kg/m2/s.
 * https://research.fs.usda.gov/treesearch/39357
 */
export const MCALLISTER_2010_DRY_POPLAR = [
  { flux: 20e3, ignitionTime: 75.3, criticalMassFlux: 1.288e-3 },
  { flux: 30e3, ignitionTime: 30.0, criticalMassFlux: 1.527e-3 },
  { flux: 40e3, ignitionTime: 16.7, criticalMassFlux: 1.733e-3 },
  { flux: 50e3, ignitionTime: 9.7, criticalMassFlux: 2.193e-3 },
] as const

/**
 * McAllister et al. (2011), Table 1 — same apparatus, poplar, three moisture contents.
 * `moisture` is the FRACTION of oven-dry mass (the paper tabulates 0.2 / 8 / 18.5 %).
 * https://research.fs.usda.gov/treesearch/40243
 */
export const MCALLISTER_2011_MOISTURE = [
  { moisture: 0.002, times: [75.3, 28.0, 16.7, 9.7] },
  { moisture: 0.08, times: [90.7, 38.7, 20.7, 12.7] },
  { moisture: 0.185, times: [106.3, 48.3, 22.7, 13.3] },
] as const
export const MCALLISTER_2011_FLUXES = [20e3, 30e3, 40e3, 50e3] as const

/** Sustained-flaming critical mass flux, kg/m2/s, across the full 2011 (flux x moisture) matrix. */
export const MCALLISTER_2011_SUSTAINED_CMF = [
  [1.305e-3, 1.43e-3, 1.749e-3, 1.875e-3],
  [1.735e-3, 1.953e-3, 2.16e-3, 2.716e-3],
  [1.985e-3, 2.465e-3, 2.464e-3, 2.978e-3],
] as const

/**
 * Dietenberger (1996), FPL, p. 195. Critical incident irradiance for piloted ignition of wood,
 * with the convective coefficient of the apparatus it was measured or extrapolated for.
 * `h` for the LIFT is not quoted in the paper — 25 W/m2/K is the value that reproduces the
 * measured 17 kW/m2 and is stated in the test as an inferred, not published, number.
 * https://research.fs.usda.gov/treesearch/8878
 */
export const DIETENBERGER_CRITICAL_IRRADIANCE = {
  /** Explicitly quoted: h_c = 0.01 kW/m2/K, turbulent free convection on a vertical wall. */
  freeConvection: { h: 10, flux: 10.5e3 },
  /** LIFT apparatus, forced convection. h inferred. */
  lift: { h: 25, flux: 17e3 },
} as const

/** Least-squares fit of `t^(-1/2)` against flux — the thermally-thick ignition-delay form. */
export function fitThickDelay(
  points: readonly { readonly flux: number; readonly ignitionTime: number }[],
): { readonly criticalFlux: number; readonly thermalInertia: number } {
  const xs = points.map((p) => p.flux)
  const ys = points.map((p) => 1 / Math.sqrt(p.ignitionTime))
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx
    sxy += dx * ((ys[i] ?? 0) - my)
    sxx += dx * dx
  }
  const slope = sxy / sxx
  const criticalFlux = -(my - slope * mx) / slope
  // 1/slope = sqrt((pi/4) k rho c) * dT, so k rho c = 1 / (slope^2 (pi/4) dT^2).
  return { criticalFlux, thermalInertia: 1 / (slope * slope * (Math.PI / 4) * 320 * 320) }
}
