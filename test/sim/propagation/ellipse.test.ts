import { describe, expect, it } from 'vitest'
import { MODELS } from '../../../src/provenance.ts'
import { mps, rad } from '@contracts/units'
import {
  LB_MAX,
  alphaX,
  alphaY,
  ellipseFromRates,
  fireEllipse,
  hamiltonian,
  headToBackRatio,
  isotropicEllipse,
  lengthToBreadth,
} from '@sim/propagation/ellipse'

/** 1 mi/h in m/s, exactly. */
const MIH = 1609.344 / 3600

/** Anderson (1983) Eq. 17 verbatim, in mi/h — the thing this package went and read. */
const andersonEq17 = (uMih: number) => 0.936 * Math.exp(0.1147 * uMih) + 0.461 * Math.exp(-0.0692 * uMih)

describe('Anderson (1983) length-to-breadth — the closed open question', () => {
  it('reproduces Eq. 17 with the Finney zero-wind shift, on wind in mi/h', () => {
    for (const uMih of [0, 1, 2, 4, 6, 8, 10, 12]) {
      const expected = Math.min(andersonEq17(uMih) - 0.397, LB_MAX)
      expect(lengthToBreadth(mps(uMih * MIH))).toBeCloseTo(expected, 10)
    }
  })

  it('is exactly 1 in still air — a no-wind fire is a circle', () => {
    // Anderson's Eq. 17 alone gives 1.397 at U = 0; it was fitted over 2-12 mi/h and was
    // never meant to be evaluated at zero. The -0.397 is Finney's normalisation, and
    // without it the level set would grow an ellipse in still air.
    expect(lengthToBreadth(mps(0))).toBe(1)
    expect(andersonEq17(0)).toBeCloseTo(1.397, 12)
  })

  it('rejects the spec §4.6 exponents: they are the same relation on wind in m/s', () => {
    // 0.2566 / 0.1147 === 0.1548 / 0.0692 === 2.2369..., the mi/h-per-m/s factor. So the
    // spec's constants reproduce this implementation only when fed the *m/s* number.
    expect(0.2566 / 0.1147).toBeCloseTo(3600 / 1609.344, 3)
    expect(0.1548 / 0.0692).toBeCloseTo(3600 / 1609.344, 3)
    const specForm = (uMih: number) =>
      0.936 * Math.exp(0.2566 * uMih) + 0.461 * Math.exp(-0.1548 * uMih) - 0.397
    for (const uMps of [1, 2, 3, 4]) {
      // Only to 3 dp: the published pairs are each rounded independently, so they are not
      // exact multiples of one another.
      expect(specForm(uMps)).toBeCloseTo(lengthToBreadth(mps(uMps)), 3)
    }
    // ...and applied to a mi/h number, as spec §4.6 instructs, it is wildly high: the cap
    // binds at 8.6 mi/h midflame instead of 19.1.
    expect(specForm(8.6)).toBeGreaterThan(LB_MAX)
    expect(lengthToBreadth(mps(8.6 * MIH))).toBeLessThan(2.6)
  })

  it('agrees with Anderson Eq. 18 and with his statement about Fons slope', () => {
    // Eq. 18 on the same page: d/b = 1/(0.534 exp(-0.1147U)) = 1.873 exp(0.1147U).
    expect(1 / 0.534).toBeCloseTo(1.873, 3)
    // "These equations have nearly twice the slope of equation 16 or 17" — Fons' l/w = 1 + 0.5U
    // over his stated 2-12 mi/h range.
    const slope = (andersonEq17(12) - andersonEq17(2)) / 10
    expect(0.5 / slope).toBeGreaterThan(1.9)
    expect(0.5 / slope).toBeLessThan(2.5)
  })

  it('is monotone and capped at 8', () => {
    let prev = 0
    for (let u = 0; u <= 40; u += 0.25) {
      const lb = lengthToBreadth(mps(u))
      expect(lb).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(lb).toBeLessThanOrEqual(LB_MAX)
      prev = lb
    }
    expect(lengthToBreadth(mps(40))).toBe(LB_MAX)
    // The cap binds at 19.1 mi/h = 8.5 m/s midflame.
    expect(lengthToBreadth(mps(8.4))).toBeLessThan(LB_MAX)
    expect(lengthToBreadth(mps(8.6))).toBe(LB_MAX)
  })

  it('is registered with a page citation in the one provenance table', () => {
    const rec = MODELS.find((m) => m.id === 'anderson-1983-length-to-breadth')
    expect(rec, 'anderson-1983-lb must be in src/provenance.ts').toBeDefined()
    expect(rec?.locator).toContain('Eq. 17')
    expect(rec?.url).toContain('Anderson_1983_INT-RP-305')
  })
})

describe('elliptical decomposition', () => {
  it('satisfies the spec §4.6 identities', () => {
    for (const lb of [1, 1.5, 2, 3, 5, 8]) {
      const e = ellipseFromRates(0.7, lb, 1, 0)
      expect(e.head).toBeCloseTo(e.b + e.c, 12)
      expect(e.backing).toBeCloseTo(e.b - e.c, 12)
      expect(e.flank).toBeCloseTo(e.a, 12)
      expect(e.b / e.a).toBeCloseTo(lb, 10)
      expect(e.head).toBeCloseTo(0.7, 12)
      if (lb > 1) {
        // R_b = R_head / HB, the spec's form, agrees with the eccentricity form used here.
        expect(e.backing).toBeCloseTo(0.7 / headToBackRatio(lb), 10)
      }
    }
  })

  it('degenerates to a circle at LB = 1 without dividing by zero', () => {
    const e = ellipseFromRates(0.4, 1, 0.6, -0.8)
    expect(e.a).toBeCloseTo(0.4, 12)
    expect(e.b).toBeCloseTo(0.4, 12)
    expect(e.c).toBe(0)
    expect(headToBackRatio(1)).toBeCloseTo(1, 12)
    expect(e.backing).toBeCloseTo(0.4, 12)
  })

  it('normalises the heading', () => {
    const e = ellipseFromRates(1, 3, 3, 4)
    expect(Math.hypot(e.hx, e.hy)).toBeCloseTo(1, 12)
    expect(e.hx).toBeCloseTo(0.6, 12)
  })

  it('converts a compass heading to the project world frame', () => {
    // azimuth -> (sin a, -cos a) in (x, z); north = -z, east = +x.
    const north = fireEllipse(mps(1), mps(0), rad(0))
    expect(north.hx).toBeCloseTo(0, 12)
    expect(north.hy).toBeCloseTo(-1, 12)
    const east = fireEllipse(mps(1), mps(0), rad(Math.PI / 2))
    expect(east.hx).toBeCloseTo(1, 12)
    expect(east.hy).toBeCloseTo(0, 12)
  })

  it('applies the §4.5 spread-rate rail before decomposition, never after', () => {
    // Pathological: head rate above the wind that is supposed to be driving it.
    const railed = fireEllipse(mps(9), mps(3), rad(0))
    expect(railed.head).toBeCloseTo(3, 12)
    // Flank and backing follow from the *capped* head and are not capped again.
    expect(railed.backing).toBeCloseTo(3 * ((1 - eccOf(railed.lengthToBreadth)) / (1 + eccOf(railed.lengthToBreadth))), 10)
    expect(fireEllipse(mps(9), mps(3), rad(0), { spreadRateRail: false }).head).toBeCloseTo(9, 12)
    // min() is idempotent, so a kernel that already applied it changes nothing.
    expect(fireEllipse(mps(3), mps(3), rad(0)).head).toBeCloseTo(3, 12)
    // Inert in practice: R/U_eff ~ 0.01-0.2 at realistic rates.
    expect(fireEllipse(mps(0.2), mps(4), rad(0)).head).toBeCloseTo(0.2, 12)
  })
})

const eccOf = (lb: number) => Math.sqrt(Math.max(0, lb * lb - 1)) / lb

describe('the support-function Hamiltonian', () => {
  it('hits head, flank and backing rates at mu = 1, 0, -1', () => {
    const e = ellipseFromRates(0.9, 3.4, 1, 0)
    expect(hamiltonian(1, 0, e)).toBeCloseTo(e.head, 12)
    expect(hamiltonian(-1, 0, e)).toBeCloseTo(e.backing, 12)
    expect(hamiltonian(0, 1, e)).toBeCloseTo(e.flank, 12)
    expect(hamiltonian(0, -1, e)).toBeCloseTo(e.flank, 12)
  })

  it('is positively homogeneous of degree one', () => {
    const e = ellipseFromRates(0.9, 3.4, 0.6, -0.8)
    for (const scale of [0.25, 2, 17]) {
      expect(hamiltonian(0.3 * scale, -0.7 * scale, e)).toBeCloseTo(scale * hamiltonian(0.3, -0.7, e), 10)
    }
  })

  it('is convex — the property that makes the viscosity solution the Huygens envelope', () => {
    const e = ellipseFromRates(0.9, 4, 0.6, -0.8)
    // Convexity of a degree-1 homogeneous H is subadditivity: H(p+q) <= H(p) + H(q).
    for (let i = 0; i < 64; i++) {
      const a = (i * 2 * Math.PI) / 64
      for (let j = 0; j < 64; j++) {
        const b = (j * 2 * Math.PI) / 64
        const px = Math.cos(a)
        const py = Math.sin(a)
        const qx = Math.cos(b)
        const qy = Math.sin(b)
        expect(hamiltonian(px + qx, py + qy, e)).toBeLessThanOrEqual(
          hamiltonian(px, py, e) + hamiltonian(qx, qy, e) + 1e-12,
        )
      }
    }
  })

  it('is the support function, NOT the ellipse radius — they are different curves', () => {
    const e = ellipseFromRates(1, 3, 1, 0)
    // Ellipse radius from the rear focus at angle theta: r = (b^2 - c^2) / (b - c*cos theta) ... the
    // point is only that the two disagree away from the axes, so a radius-based Hamiltonian
    // would produce a different (wrong) perimeter.
    const theta = Math.PI / 3
    const nx = Math.cos(theta)
    const ny = Math.sin(theta)
    const support = hamiltonian(nx, ny, e)
    const semiLatus = (e.b * e.b - e.c * e.c) / e.b
    const radius = semiLatus / (1 - (e.c / e.b) * Math.cos(Math.PI - theta))
    expect(Math.abs(support - radius)).toBeGreaterThan(0.02)
  })

  it('is isotropic when LB = 1', () => {
    const e = isotropicEllipse(0.5)
    for (let i = 0; i < 32; i++) {
      const a = (i * 2 * Math.PI) / 32
      expect(hamiltonian(Math.cos(a), Math.sin(a), e)).toBeCloseTo(0.5, 12)
    }
  })
})

describe('Lax-Friedrichs dissipation coefficients', () => {
  it('bound |dH/dp| exactly, per axis', () => {
    for (const bearing of [0, 0.4, 1.1, 2.9, 5.5]) {
      const e = ellipseFromRates(0.8, 3.2, Math.cos(bearing), Math.sin(bearing))
      const ax = alphaX(e)
      const ay = alphaY(e)
      const eps = 1e-6
      for (let i = 0; i < 128; i++) {
        const a = (i * 2 * Math.PI) / 128
        const px = Math.cos(a)
        const py = Math.sin(a)
        const dx = (hamiltonian(px + eps, py, e) - hamiltonian(px - eps, py, e)) / (2 * eps)
        const dy = (hamiltonian(px, py + eps, e) - hamiltonian(px, py - eps, e)) / (2 * eps)
        expect(Math.abs(dx)).toBeLessThanOrEqual(ax + 1e-9)
        expect(Math.abs(dy)).toBeLessThanOrEqual(ay + 1e-9)
      }
    }
  })

  it('are tighter than the isotropic b + c bound on the flanks', () => {
    const e = ellipseFromRates(1, 5, 1, 0) // wind along +x
    expect(alphaY(e)).toBeLessThan(0.35 * e.head)
    expect(alphaX(e)).toBeCloseTo(e.head, 10)
  })
})
