/**
 * WP 3.2 acceptance test — "ignition delays match published piloted-ignition data for the
 * tested fuels" (spec §91, M3 table, row 3.2).
 *
 * Two independent published anchors, both free (USDA treesearch):
 *
 * 1. **McAllister, Finney & Cohen (2010)** measured piloted-ignition delay for dry poplar at
 *    four radiant fluxes in an apparatus built specifically to study crown-fire ignition. The
 *    thermally-thick ignition-delay integral reproduces all four to within 4.3%.
 * 2. **Dietenberger (1996)** measured the critical incident irradiance for piloted ignition of
 *    wood — the flux below which ignition never happens however long you wait. That is the one
 *    absolute number a critical-temperature criterion can be checked against with no fitting at
 *    all, and it comes out within 10%.
 *
 * The two probe different halves of the criterion: (1) the transient, (2) the threshold.
 */

import { describe, expect, it } from 'vitest'
import { CRITICAL_MASS_FLUX, CRITICAL_MASS_FLUX_RANGE, EARLY_OUT_TEMPERATURE_K, IGNITION_TEMPERATURE_BAND_K, SOLID_CONDUCTIVITY, SOLID_DENSITY, SOLID_SPECIFIC_HEAT, STEFAN_BOLTZMANN } from '@sim/canopy/kinetics/constants.ts'
import { moistureHeatSink } from '@sim/canopy/kinetics/evaporation.ts'
import { THERMALLY_THIN_BIOT, biotNumber, characteristicLength, criticalIncidentFlux, effectiveConvection, ignitionDelayThick, ignitionDelayThin, ignitionTemperature, thermalRegime, thickIgnitionReached, thickIgnitionThreshold } from '@sim/canopy/kinetics/ignition.ts'
import { pyrolysateFlux } from '@sim/canopy/kinetics/kinetics.ts'
import { K, m, moistureFraction, s } from '@contracts/units.ts'
import {
  DIETENBERGER_CRITICAL_IRRADIANCE,
  MCALLISTER_2010_DRY_POPLAR,
  MCALLISTER_2011_SUSTAINED_CMF,
  fitThickDelay,
} from './published.ts'

/** Surface ignition temperature used throughout. Middle of Dietenberger's measured band. */
const T_IG = K(620)
const T_AMBIENT = K(300)
/** Grey-surface emissivity for wood. Dietenberger derives ~0.86-0.90 across moisture contents. */
const EMISSIVITY = 0.88

describe('published piloted-ignition delays — McAllister, Finney & Cohen (2010), dry poplar', () => {
  const fit = fitThickDelay(MCALLISTER_2010_DRY_POPLAR)

  it('the thermally-thick delay integral reproduces all four points to 4.3%', () => {
    const errors = MCALLISTER_2010_DRY_POPLAR.map((point) => {
      const predicted = ignitionDelayThick(
        point.flux - fit.criticalFlux,
        T_IG,
        T_AMBIENT,
        fit.thermalInertia,
      )
      return Math.abs(predicted / point.ignitionTime - 1)
    })
    for (const e of errors) expect(e).toBeLessThan(0.043)
    const rms = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length)
    expect(rms).toBeLessThan(0.03)
  })

  it('the fit needs only two constants, and reports what they are', () => {
    // Critical flux 3.2 kW/m2 and an effective thermal inertia of 2.7e5 W^2 s m^-4 K^-2.
    expect(fit.criticalFlux / 1e3).toBeCloseTo(3.23, 1)
    expect(fit.thermalInertia / 1e5).toBeCloseTo(2.69, 1)
  })

  it('records the honest gap: the fitted thermal inertia is ~4x the handbook value', () => {
    // Wood Handbook yellow-poplar: k ~ 0.12 W/m/K, rho ~ 420 kg/m3, c ~ 1250 J/kg/K.
    const handbook = 0.12 * 420 * 1250
    expect(fit.thermalInertia / handbook).toBeGreaterThan(3)
    expect(fit.thermalInertia / handbook).toBeLessThan(5)
    // Which is exactly why canopy foliage is integrated on the THIN branch, where no such
    // constant appears — see the Biot tests below.
  })

  it('the measured delays follow t ~ q^-2, not the thermally-thin t ~ q^-1', () => {
    const first = MCALLISTER_2010_DRY_POPLAR[0]
    const last = MCALLISTER_2010_DRY_POPLAR[3]
    if (!first || !last) throw new Error('table')
    const fluxRatio = last.flux / first.flux
    const timeRatio = first.ignitionTime / last.ignitionTime
    // q ratio 2.5: thin predicts 2.5, thick predicts 6.25. Measured is 7.8, i.e. thick plus a
    // critical-flux offset. A thin model applied to this sample would be 3x wrong.
    expect(timeRatio).toBeGreaterThan(fluxRatio ** 2)
    expect(timeRatio / fluxRatio).toBeGreaterThan(3)
  })
})

describe('published critical irradiance — Dietenberger (1996), FPL', () => {
  it('reproduces both measured critical irradiances within 10%, with no fitting', () => {
    for (const [label, entry] of Object.entries(DIETENBERGER_CRITICAL_IRRADIANCE)) {
      const predicted = criticalIncidentFlux(
        T_IG,
        T_AMBIENT,
        entry.h,
        EMISSIVITY,
        STEFAN_BOLTZMANN,
      )
      const error = Math.abs(predicted / entry.flux - 1)
      expect(error, label).toBeLessThan(0.11)
    }
  })

  it('the LIFT value comes out on the nose at its forced-convection coefficient', () => {
    const lift = criticalIncidentFlux(T_IG, T_AMBIENT, 25, EMISSIVITY, STEFAN_BOLTZMANN)
    expect(lift / 1e3).toBeCloseTo(17.0, 1)
  })

  it('most of the critical flux is re-radiation, not convection', () => {
    // 7.0 kW/m2 of the 11.6 total at h = 10. This is why dropping the 4 sigma T^4 term from
    // the radiative source, as spec §7.5's worked example does, changes the answer completely.
    const reradiation = (EMISSIVITY * STEFAN_BOLTZMANN * (T_IG ** 4 - T_AMBIENT ** 4)) / EMISSIVITY
    const total = criticalIncidentFlux(T_IG, T_AMBIENT, 10, EMISSIVITY, STEFAN_BOLTZMANN)
    expect(reradiation / total).toBeGreaterThan(0.6)
  })

  it('T_ig sits inside Dietenberger\'s measured band', () => {
    expect(T_IG).toBeGreaterThanOrEqual(IGNITION_TEMPERATURE_BAND_K[0])
    expect(T_IG).toBeLessThanOrEqual(IGNITION_TEMPERATURE_BAND_K[1])
  })
})

describe('critical mass flux against McAllister\'s measured matrix', () => {
  it('the shipping constant is the dry-fuel mean and sits inside the measured envelope', () => {
    const dryRow = MCALLISTER_2011_SUSTAINED_CMF[0]
    if (!dryRow) throw new Error('table')
    const mean2011 = dryRow.reduce((a, b) => a + b, 0) / dryRow.length
    const mean2010 =
      MCALLISTER_2010_DRY_POPLAR.reduce((a, p) => a + p.criticalMassFlux, 0) /
      MCALLISTER_2010_DRY_POPLAR.length
    expect(CRITICAL_MASS_FLUX).toBeCloseTo((mean2011 + mean2010) / 2, 4)
    expect(CRITICAL_MASS_FLUX).toBeGreaterThan(CRITICAL_MASS_FLUX_RANGE[0])
    expect(CRITICAL_MASS_FLUX).toBeLessThan(CRITICAL_MASS_FLUX_RANGE[1])
  })

  it('the envelope brackets every value in the published matrix', () => {
    for (const row of MCALLISTER_2011_SUSTAINED_CMF) {
      for (const v of row) {
        expect(v).toBeGreaterThanOrEqual(CRITICAL_MASS_FLUX_RANGE[0])
        expect(v).toBeLessThanOrEqual(CRITICAL_MASS_FLUX_RANGE[1])
      }
    }
  })

  it('the spec\'s 2.5 g/m2/s is real but sits at the wettest, hottest corner', () => {
    const wettest = MCALLISTER_2011_SUSTAINED_CMF[2]
    if (!wettest) throw new Error('table')
    expect(2.5e-3).toBeLessThan(wettest[3] ?? 0)
    expect(2.5e-3).toBeGreaterThan(CRITICAL_MASS_FLUX)
  })
})

describe('the shipping gate: mass flux inverted to a temperature', () => {
  it('lands near 690 K for a representative canopy voxel', () => {
    // CBD 0.15 kg/m3, LAD 2 m2/m3 — spec §7.5's own worked voxel.
    expect(ignitionTemperature(0.15, 2)).toBeCloseTo(689.7, 1)
  })

  it('is the exact inverse of the mass-flux criterion, by construction', () => {
    for (const [dryMass, lad] of [
      [0.05, 1],
      [0.15, 2],
      [0.4, 4],
    ] as const) {
      const tig = ignitionTemperature(dryMass, lad)
      expect(pyrolysateFlux(dryMass, tig, lad)).toBeCloseTo(CRITICAL_MASS_FLUX, 12)
    }
  })

  it('is invariant to canopy bulk density — it depends only on mass per unit leaf area', () => {
    // T_ig = (E/R) / ln(A rho / (mdot_crit 2 LAD)), so it is a function of rho/LAD alone. A
    // denser stand at the same specific leaf area has the same gate, which is the property
    // that matters: the ignition threshold must not drift with stand density.
    const sla = 13.33 // m2 of one-sided leaf area per kg of dry foliage
    const reference = ignitionTemperature(0.15, 0.15 * sla)
    for (const cbd of [0.05, 0.1, 0.2, 0.3, 0.4]) {
      expect(ignitionTemperature(cbd, cbd * sla)).toBeCloseTo(reference, 9)
    }
    expect(reference).toBeCloseTo(689.7, 1)
  })

  it('spans 643-711 K over the plausible specific-leaf-area range', () => {
    // One-sided SLA for conifer needles through broadleaves spans roughly 5-20 m2/kg. That
    // 4x range in leaf area per unit mass is the only thing T_ig responds to, and it moves it
    // by 67 K — the whole uncertainty in the gate, stated.
    const lo = ignitionTemperature(1, 5)
    const hi = ignitionTemperature(1, 20)
    expect(lo).toBeCloseTo(643.4, 1)
    expect(hi).toBeCloseTo(710.8, 1)
    expect(hi - lo).toBeLessThan(70)
  })

  it('refuses to ignite a voxel with too little fuel per unit leaf area', () => {
    // The failure spec §7.6 attributes to a bare temperature threshold: "spurious ignition of
    // thin, hot-but-empty voxels". Inverting the flux criterion removes it for free.
    expect(ignitionTemperature(1e-9, 4)).toBe(Number.POSITIVE_INFINITY)
    expect(ignitionTemperature(0, 2)).toBe(Number.POSITIVE_INFINITY)
  })

  it('the error from freezing T_ig at the initial dry mass is a few kelvin', () => {
    const fresh = ignitionTemperature(0.15, 2)
    expect(ignitionTemperature(0.15 * 0.95, 2) - fresh).toBeLessThan(3)
    expect(ignitionTemperature(0.15 * 0.8, 2) - fresh).toBeLessThan(12)
  })

  it('600 K is only safe as an early-out: it is 7.7x below the measured gate', () => {
    const fluxAt600 = pyrolysateFlux(0.15, K(EARLY_OUT_TEMPERATURE_K), 2)
    expect(CRITICAL_MASS_FLUX / fluxAt600).toBeCloseTo(7.67, 1)
    // And it is below every value McAllister measured, not merely below the mean.
    expect(fluxAt600).toBeLessThan(CRITICAL_MASS_FLUX_RANGE[0])
    // It is a valid early-out because it is unconditionally below the gate.
    expect(EARLY_OUT_TEMPERATURE_K).toBeLessThan(ignitionTemperature(0.4, 4))
  })
})

describe('thermally thin vs thick', () => {
  it('reproduces the spec §7.6 Biot worked points', () => {
    expect(biotNumber(154, m(0.001))).toBeCloseTo(0.19, 2) // 1 mm needle, h = 154
    expect(biotNumber(80, m(0.006))).toBeCloseTo(0.6, 2) // 6 mm twig, h = 80
  })

  it('uses L_c = d/4 for a cylinder', () => {
    expect(characteristicLength(0.004)).toBe(0.001)
  })

  it('classifies foliage as marginal and the 3-6 mm class as thick', () => {
    expect(thermalRegime(biotNumber(154, m(0.001)))).toBe('marginal')
    expect(thermalRegime(biotNumber(80, m(0.006)))).toBe('thick')
    expect(thermalRegime(biotNumber(20, m(0.001)))).toBe('thin')
    expect(THERMALLY_THIN_BIOT).toBe(0.1)
  })

  it('the internal-resistance correction is 1/(1+Bi/2), derived not copied', () => {
    // 1/h_eff = 1/h + L_c/(2k) for a cylinder with L_c = V/A. Spec §7.6 prescribes
    // 1/(1+Bi/4), which is the same physics with Bi built on the RADIUS instead.
    const h = 154
    const lc = characteristicLength(0.001)
    const bi = biotNumber(h, m(0.001))
    expect(effectiveConvection(h, bi)).toBeCloseTo(1 / (1 / h + lc / (2 * SOLID_CONDUCTIVITY)), 9)
    // The deviation from the spec's factor is 4.4% at the spec's own worked point.
    const specForm = h / (1 + bi / 4)
    expect(Math.abs(effectiveConvection(h, bi) / specForm - 1)).toBeCloseTo(0.044, 2)
  })

  it('the correction is negligible for genuinely thin fuel and large for thick', () => {
    expect(effectiveConvection(20, biotNumber(20, m(0.001))) / 20).toBeGreaterThan(0.98)
    expect(effectiveConvection(80, biotNumber(80, m(0.006))) / 80).toBeLessThan(0.78)
  })
})

describe('ignition-delay integral', () => {
  it('the incremental thick criterion reduces exactly to the closed form', () => {
    const inertia = 1.5e5 // spec §7.6's k*rho*c
    const flux = 50e3
    const closed = ignitionDelayThick(flux, T_IG, T_AMBIENT, inertia)
    const threshold = thickIgnitionThreshold(T_IG, T_AMBIENT, inertia)
    expect(thickIgnitionReached(flux * closed * 0.999, s(closed), threshold)).toBe(false)
    expect(thickIgnitionReached(flux * closed * 1.001, s(closed), threshold)).toBe(true)
  })

  it('reproduces the spec §7.6 worked point', () => {
    // "k rho c = 1.5e5, T_ig - T_0 = 300 K, q = 50 kW/m2 -> t_ig = 4.2 s"
    expect(ignitionDelayThick(50e3, K(600), K(300), 1.5e5)).toBeCloseTo(4.24, 1)
  })

  it('the thin delay is linear in flux and carries the full moisture sink', () => {
    const dry = ignitionDelayThin(50e3, T_IG, T_AMBIENT, m(0.001), SOLID_DENSITY, SOLID_SPECIFIC_HEAT)
    expect(ignitionDelayThin(25e3, T_IG, T_AMBIENT, m(0.001), SOLID_DENSITY, SOLID_SPECIFIC_HEAT))
      .toBeCloseTo(2 * dry, 9)
    const wet = ignitionDelayThin(
      50e3,
      T_IG,
      T_AMBIENT,
      m(0.001),
      SOLID_DENSITY,
      SOLID_SPECIFIC_HEAT,
      moistureHeatSink(moistureFraction(1.0), T_AMBIENT),
    )
    // FMC 100% multiplies the delay by 6.3: the whole particle must be dried.
    expect(wet / dry).toBeGreaterThan(6)
    expect(wet / dry).toBeLessThan(6.6)
  })

  it('returns infinity rather than a negative time when the flux is a loss', () => {
    expect(ignitionDelayThin(-1, T_IG, T_AMBIENT, m(0.001), SOLID_DENSITY, SOLID_SPECIFIC_HEAT))
      .toBe(Number.POSITIVE_INFINITY)
    expect(ignitionDelayThick(0, T_IG, T_AMBIENT, 1.5e5)).toBe(Number.POSITIVE_INFINITY)
  })
})
