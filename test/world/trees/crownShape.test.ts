/**
 * Pure-maths tests for the crown envelope and the target bulk-density field (WP 1.4).
 *
 * This is the layer that turns the Stem's four physical numbers into the field the skeleton
 * grows into. It has no GPU, no randomness that matters, and closed-form answers available
 * for special cases — so it gets tested against those rather than against itself.
 */

import { describe, expect, it } from 'vitest'
import {
  crownAreaFrac,
  crownRadiusFrac,
  crownVolumeM3,
  sampleAttractorField,
  targetBulkDensityAt,
  verticalWeight,
  VerticalMassProfile,
} from '@world/trees/crownShape.ts'
import { formParamsFor, type FormParams } from '@world/trees/speciesForm.ts'
import { STUB_SPECIES } from '../../fixtures/world.ts'
import { Rng } from '@world/trees/rng.ts'

/** A form whose envelope is a perfect cylinder, so the volume integral has a closed form. */
const CYLINDER: FormParams = {
  ...formParamsFor(STUB_SPECIES[0]!),
  tPeak: 0.5,
  gBase: 1,
  gTop: 1,
  pLow: 1,
  pHigh: 1,
}

/** A form whose envelope is a cone: full width at the base, a point at the top, linear. */
const CONE: FormParams = {
  ...formParamsFor(STUB_SPECIES[0]!),
  tPeak: 0,
  gBase: 1,
  gTop: 0,
  pLow: 1,
  pHigh: 1,
}

describe('crown envelope', () => {
  it('is bounded to [0,1] and continuous at the knot for every stub species', () => {
    for (const species of STUB_SPECIES) {
      const f = formParamsFor(species)
      let prev = crownRadiusFrac(f, 0)
      for (let i = 0; i <= 400; i++) {
        const g = crownRadiusFrac(f, i / 400)
        expect(g, species.id).toBeGreaterThanOrEqual(0)
        expect(g, species.id).toBeLessThanOrEqual(1 + 1e-12)
        // No jumps: the largest step over 400 samples must stay small, which catches a
        // discontinuity at tPeak from mismatched exponents.
        expect(Math.abs(g - prev), species.id).toBeLessThan(0.08)
        prev = g
      }
      // The peak of the envelope is 1 by construction.
      expect(crownRadiusFrac(f, f.tPeak)).toBeCloseTo(1, 10)
    }
  })

  it('clamps outside [0,1] rather than extrapolating', () => {
    const f = formParamsFor(STUB_SPECIES[0]!)
    expect(crownRadiusFrac(f, -3)).toBe(crownRadiusFrac(f, 0))
    expect(crownRadiusFrac(f, 7)).toBe(crownRadiusFrac(f, 1))
  })

  it('area fraction is the square of the radius fraction', () => {
    const f = formParamsFor(STUB_SPECIES[3]!)
    for (const t of [0, 0.13, 0.5, 0.77, 1]) {
      expect(crownAreaFrac(f, t)).toBeCloseTo(crownRadiusFrac(f, t) ** 2, 12)
    }
  })
})

describe('crown volume', () => {
  it('reproduces the closed form for a cylinder', () => {
    const r = 3.2
    const d = 11.5
    expect(crownVolumeM3(CYLINDER, r, d)).toBeCloseTo(Math.PI * r * r * d, 6)
  })

  it('reproduces the closed form for a cone (one third of the cylinder)', () => {
    const r = 2.5
    const d = 9
    expect(crownVolumeM3(CONE, r, d)).toBeCloseTo((Math.PI * r * r * d) / 3, 5)
  })

  it('scales as r^2 and linearly in depth', () => {
    const f = formParamsFor(STUB_SPECIES[0]!)
    const base = crownVolumeM3(f, 2, 8)
    expect(crownVolumeM3(f, 4, 8)).toBeCloseTo(base * 4, 6)
    expect(crownVolumeM3(f, 2, 24)).toBeCloseTo(base * 3, 6)
  })

  it('is converged at the default quadrature resolution', () => {
    for (const species of STUB_SPECIES) {
      const f = formParamsFor(species)
      const coarse = crownVolumeM3(f, 3, 10, 256)
      const fine = crownVolumeM3(f, 3, 10, 4096)
      expect(Math.abs(coarse - fine) / fine, species.id).toBeLessThan(1e-4)
    }
  })
})

describe('vertical mass profile', () => {
  it('is a valid inverse CDF: monotone, spanning [0,1]', () => {
    for (const species of STUB_SPECIES) {
      const f = formParamsFor(species)
      const profile = new VerticalMassProfile(f)
      expect(profile.sample(0)).toBeCloseTo(0, 6)
      expect(profile.sample(1)).toBeCloseTo(1, 6)
      let prev = -1
      for (let i = 0; i <= 200; i++) {
        const t = profile.sample(i / 200)
        expect(t, species.id).toBeGreaterThanOrEqual(prev - 1e-12)
        prev = t
      }
    }
  })

  it('samples reproduce the Beta weighting they were built from', () => {
    const f = formParamsFor(STUB_SPECIES[0]!)
    const profile = new VerticalMassProfile(f)
    // Compare the sampled histogram against the analytic weight over five bins.
    const bins = 5
    const counts = new Float64Array(bins)
    const n = 20000
    for (let i = 0; i < n; i++) {
      const t = profile.sample((i + 0.5) / n)
      counts[Math.min(bins - 1, Math.floor(t * bins))]! += 1
    }
    const analytic = new Float64Array(bins)
    let total = 0
    for (let i = 0; i < 2000; i++) {
      const t = (i + 0.5) / 2000
      const w = verticalWeight(f, t)
      analytic[Math.min(bins - 1, Math.floor(t * bins))]! += w
      total += w
    }
    for (let b = 0; b < bins; b++) {
      expect(counts[b]! / n).toBeCloseTo(analytic[b]! / total, 2)
    }
  })
})

describe('target bulk density field', () => {
  /**
   * The defining identity of the derivation chain: integrating the target CBD(z) over the
   * crown cross-section must return the foliar biomass the Stem's declared bulk density
   * implies. If this does not hold, every downstream measurement is measuring the wrong
   * target and the acceptance test would be comparing two consistent wrongs.
   */
  it('integrates back to CBD_declared x V_crown', () => {
    for (const species of STUB_SPECIES) {
      const f = formParamsFor(species)
      const crown = {
        heightM: 18,
        crownBaseM: 5,
        crownRadiusM: 2.8,
        crownBulkDensityKgM3: 0.09,
      }
      const depth = crown.heightM - crown.crownBaseM
      const volume = crownVolumeM3(f, crown.crownRadiusM, depth)
      const declaredMass = crown.crownBulkDensityKgM3 * volume

      // Simpson over t of CBD(t) * A(t) * depth dt.
      const n = 2048
      const h = 1 / n
      const integrand = (t: number): number =>
        targetBulkDensityAt(f, crown, t) *
        Math.PI *
        crown.crownRadiusM ** 2 *
        crownAreaFrac(f, t) *
        depth
      let acc = integrand(0) + integrand(1)
      for (let i = 1; i < n; i++) acc += (i % 2 === 1 ? 4 : 2) * integrand(i * h)
      const integrated = (acc * h) / 3

      expect(integrated / declaredMass, species.id).toBeCloseTo(1, 2)
    }
  })
})

describe('attractor field', () => {
  const crown = { heightM: 20, crownBaseM: 6, crownRadiusM: 3, crownBulkDensityKgM3: 0.08 }

  it('pins a sample at the crown base and at the apex', () => {
    for (const species of STUB_SPECIES) {
      const f = formParamsFor(species)
      const field = sampleAttractorField(f, crown, new Rng(11), 800)
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < field.count; i++) {
        lo = Math.min(lo, field.positions[i * 3 + 1]!)
        hi = Math.max(hi, field.positions[i * 3 + 1]!)
      }
      // Without endpoint pinning this gap scales as 1/n and biases the measured crown base.
      expect(lo, species.id).toBeCloseTo(crown.crownBaseM, 6)
      expect(hi, species.id).toBeCloseTo(crown.heightM, 6)
    }
  })

  it('stays inside the declared envelope', () => {
    const f = formParamsFor(STUB_SPECIES[0]!)
    const field = sampleAttractorField(f, crown, new Rng(5), 3000)
    const depth = crown.heightM - crown.crownBaseM
    for (let i = 0; i < field.count; i++) {
      const y = field.positions[i * 3 + 1]!
      const r = Math.hypot(field.positions[i * 3]!, field.positions[i * 3 + 2]!)
      const t = (y - crown.crownBaseM) / depth
      expect(r).toBeLessThanOrEqual(crown.crownRadiusM * crownRadiusFrac(f, t) + 1e-9)
    }
  })

  it('carries exactly the declared foliar mass, however finely it is sampled', () => {
    const f = formParamsFor(STUB_SPECIES[0]!)
    const expected =
      crown.crownBulkDensityKgM3 *
      crownVolumeM3(f, crown.crownRadiusM, crown.heightM - crown.crownBaseM)
    for (const n of [64, 512, 3000]) {
      const field = sampleAttractorField(f, crown, new Rng(3), n)
      expect(field.totalFoliarMassKg).toBeCloseTo(expected, 9)
      expect(field.massPerAttractorKg * field.count).toBeCloseTo(expected, 9)
    }
  })

  it('is area-uniform in the disc rather than piling mass on the axis', () => {
    // If the radial sample forgot its sqrt, half the points would fall inside r/2 instead
    // of the correct quarter, and the measured bulk density would come out high.
    const f = { ...CYLINDER }
    const field = sampleAttractorField(f, crown, new Rng(9), 20000)
    let inHalf = 0
    for (let i = 0; i < field.count; i++) {
      const r = Math.hypot(field.positions[i * 3]!, field.positions[i * 3 + 2]!)
      if (r < crown.crownRadiusM / 2) inHalf++
    }
    expect(inHalf / field.count).toBeCloseTo(0.25, 2)
  })
})
