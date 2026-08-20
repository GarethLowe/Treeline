/**
 * WP 3.4 acceptance: "convective heating dominates the near field as expected".
 *
 * The spec's own §7.5 worked point is the anchor — d = 1 mm needle, u = 2 m s⁻¹, gas at 600 K
 * gives Re = 38, Nu = 3.3, h = 154 W m⁻² K⁻¹ — and the last block reproduces the two-to-three
 * order of magnitude near-field/preheating separation §7.5 derives from it.
 */

import { describe, expect, it } from 'vitest'
import { K, m, mps } from '@contracts/units'
import {
  CB_COEFF_PR070,
  PR_AIR,
  airConductivity,
  airDensity,
  airKinematicViscosity,
  airViscosity,
  convectiveCoefficient,
  convectiveSource,
  nusseltChurchillBernstein,
  nusseltWildland,
} from '@sim/canopy/convection/heatTransfer.ts'
import {
  buildPlumeLut,
  samplePlumeLut,
  solvePlume,
} from '@sim/canopy/convection/plume.ts'
import { kWm } from '@contracts/units'

const needle = { diameter: m(0.001) }

describe('air properties (Sutherland) against the §7.5 worked point at 600 K', () => {
  it('lands within 2 % of the values the spec quotes', () => {
    expect(airKinematicViscosity(600)).toBeCloseTo(5.13e-5, 6) // spec: 5.2e-5
    expect(Math.abs(airKinematicViscosity(600) / 5.2e-5 - 1)).toBeLessThan(0.02)
    expect(airConductivity(600)).toBeCloseTo(0.0462, 4) // spec: 0.0469
    expect(Math.abs(airConductivity(600) / 0.0469 - 1)).toBeLessThan(0.02)
  })

  it('is monotonic and physical across the fire temperature range', () => {
    let lastNu = 0
    let lastK = 0
    for (const t of [300, 500, 700, 900, 1100, 1300]) {
      expect(airViscosity(t)).toBeGreaterThan(lastNu)
      expect(airConductivity(t)).toBeGreaterThan(lastK)
      lastNu = airViscosity(t)
      lastK = airConductivity(t)
      expect(airDensity(t)).toBeCloseTo(101325 / (287.05 * t), 8)
    }
  })
})

describe('Nusselt (Churchill & Bernstein 1977)', () => {
  it('reproduces the §7.5 worked point Re = 38 -> Nu = 3.3', () => {
    expect(nusseltChurchillBernstein(38, 0.7)).toBeCloseTo(3.29, 2)
  })

  it('holds the Pr floor: Nu -> 0.3 as Re -> 0', () => {
    expect(nusseltChurchillBernstein(1e-9)).toBeCloseTo(0.3, 3)
  })

  it('keeps the high-Re bracket — dropping it would be a 5 % error at Re = 3600', () => {
    const withoutBracket = 0.3 + CB_COEFF_PR070 * Math.sqrt(3600)
    // 6 mm twig in a 20 m/s plume. This is why the bracket is not a candidate for §0.5.1 cuts.
    expect(nusseltWildland(3600) / withoutBracket).toBeGreaterThan(1.04)
  })

  it('is exactly the shader form at Pr = 0.70, and within 1.5 % across the air Pr range', () => {
    // Air Pr spans ~0.68-0.72 over 300-1200 K. Nu depends on Pr with an effective exponent of
    // ~0.39 once the denominator's partial cancellation is taken into account, so holding it
    // fixed is worth 1.2 % at the ends of that range.
    for (const re of [0.1, 1, 38, 300, 3600, 4e4]) {
      expect(nusseltWildland(re)).toBeCloseTo(nusseltChurchillBernstein(re, PR_AIR), 10)
      for (const pr of [0.68, 0.72]) {
        expect(
          Math.abs(nusseltWildland(re) / nusseltChurchillBernstein(re, pr) - 1),
        ).toBeLessThan(0.015)
      }
    }
  })
})

describe('convective heat transfer coefficient', () => {
  it('reproduces the §7.5 worked point h = 154 W/m2/K to 1 %', () => {
    // Spec evaluates properties at 600 K. Film temperature of an 1100 K gas over a 300 K solid
    // is 700 K, and it lands on the same answer to within 1 % because nu and k rise together.
    const h = convectiveCoefficient({
      gasTempK: K(1100),
      solidTempK: K(300),
      gasSpeed: mps(2),
      ...needle,
    })
    expect(Math.abs(h / 154 - 1)).toBeLessThan(0.01)
  })

  it('rises with gas speed and falls with element diameter', () => {
    const h = (u: number, d: number): number =>
      convectiveCoefficient({
        gasTempK: K(1100),
        solidTempK: K(300),
        gasSpeed: mps(u),
        diameter: m(d),
      })
    expect(h(8, 0.001)).toBeGreaterThan(h(2, 0.001))
    expect(h(2, 0.006)).toBeLessThan(h(2, 0.001))
    // Nu ~ Re^(1/2) in this range, so h ~ u^(1/2): 4x speed -> ~2x h (a little less, because of
    // the +0.3 conduction floor).
    expect(h(8, 0.001) / h(2, 0.001)).toBeGreaterThan(1.8)
    expect(h(8, 0.001) / h(2, 0.001)).toBeLessThan(2.0)
  })

  it('reaches the h > 100 W/m2/K reported for sub-millimetre fuels', () => {
    expect(
      convectiveCoefficient({
        gasTempK: K(1100),
        solidTempK: K(300),
        gasSpeed: mps(2),
        diameter: m(0.0005),
      }),
    ).toBeGreaterThan(100)
  })

  it('rejects a zero or negative diameter rather than returning Infinity', () => {
    const bad = { gasTempK: K(1100), solidTempK: K(300), gasSpeed: mps(2), diameter: m(0) }
    expect(() => convectiveCoefficient(bad)).toThrow(/positive/)
  })
})

describe('volumetric source', () => {
  const immersed = {
    gasTempK: K(1100),
    solidTempK: K(300),
    gasSpeed: mps(2),
    ...needle,
  }

  it('reproduces the §7.5 immersed-voxel figure, 493 kW/m3 at LAD = 2', () => {
    // A_v = 2 * LAD = 4 m2/m3, dT = 800 K, h ~ 154 -> 154 * 4 * 800 = 493 kW/m3.
    const q = convectiveSource(immersed, 2)
    expect(Math.abs(q / 493e3 - 1)).toBeLessThan(0.02)
  })

  it('is signed — cold gas cools the fuel, and that must not be clamped away', () => {
    const q = convectiveSource(
      { gasTempK: K(280), solidTempK: K(400), gasSpeed: mps(2), ...needle },
      2,
    )
    expect(q).toBeLessThan(0)
  })

  it('scales linearly in LAD, because A_v = 2*LAD', () => {
    expect(convectiveSource(immersed, 4) / convectiveSource(immersed, 2)).toBeCloseTo(2, 6)
  })
})

describe('convection dominates the near field, radiation the preheating (§7.5)', () => {
  /** Sensible + drying energy to bring one 8 m3 voxel at CBD 0.15, FMC 100 % to ignition. */
  const ENERGY_PER_VOXEL_J = 3.6e6
  /**
   * §7.5's preheating reference: 20 m ahead of the front, view factor ~0.03, transmittance ~0.5
   * gives q'''_rad = kappa*G = 0.6 * 1.6 kW/m2 = 0.95 kW/m3. Written out here rather than
   * imported, because WP 3.3 owns radiation and this package may not import a sibling.
   */
  const RAD_PREHEAT_W_PER_M3 = 0.95e3

  it('ignites an immersed voxel in ~1 s and a preheated one in ~8 minutes', () => {
    const qConv = convectiveSource(
      { gasTempK: K(1100), solidTempK: K(300), gasSpeed: mps(2), ...needle },
      2,
    )
    const voxelVolume = 8
    const tConv = ENERGY_PER_VOXEL_J / (qConv * voxelVolume)
    const tRad = ENERGY_PER_VOXEL_J / (RAD_PREHEAT_W_PER_M3 * voxelVolume)

    expect(tConv).toBeGreaterThan(0.7)
    expect(tConv).toBeLessThan(1.1) // spec: ~0.9 s
    expect(tRad).toBeGreaterThan(400)
    expect(tRad).toBeLessThan(550) // spec: ~470 s
    // "Between two and three orders of magnitude apart" — the physical content of §7.5.
    expect(qConv / RAD_PREHEAT_W_PER_M3).toBeGreaterThan(100)
    expect(qConv / RAD_PREHEAT_W_PER_M3).toBeLessThan(1000)
  })

  it('collapses below the radiative term once the plume has diluted, end to end', () => {
    // Full chain: fire line -> plume -> gas state -> h -> q'''. Inside the plume at crown
    // height, convection wins by orders of magnitude; two half-widths off the centreline it
    // has fallen below the radiative preheating term, which is what stops convection from
    // being a long-range mechanism.
    const p = solvePlume({ intensity: kWm(1000), flameDepth: m(1) }, {
      tempK: K(300),
      density: 1.2,
      potentialTempGradient: 0,
      wind: () => 3,
    })
    const lut = buildPlumeLut(p)
    const cfg = { ambientTempK: 300, windSpeed: 3 }
    const z = 16
    const centreOffset = lut[Math.round((z / 128) * 31) * 4 + 3]!
    const b = lut[Math.round((z / 128) * 31) * 4 + 2]!

    const q = (across: number): number => {
      const g = samplePlumeLut(lut, z, across, cfg)
      return convectiveSource(
        { gasTempK: K(g.gasTempK), solidTempK: K(300), gasSpeed: g.gasSpeed, ...needle },
        2,
      )
    }

    // ~38x at 16 m, not the ~500x of the immersed case: by crown height the plume has
    // entrained enough air that its excess temperature is down to ~34 K. Convection still
    // wins comfortably, and that dilution is why it wins only in the near field.
    expect(q(centreOffset)).toBeGreaterThan(20 * RAD_PREHEAT_W_PER_M3)
    expect(q(centreOffset + 3 * b)).toBeLessThan(RAD_PREHEAT_W_PER_M3)
  })
})
