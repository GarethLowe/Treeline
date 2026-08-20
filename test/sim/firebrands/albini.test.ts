/**
 * WP 3.6 acceptance: "maximum spotting distances fall inside the Albini envelope".
 *
 * The comparison has to be set up honestly or it measures the wrong thing. Albini's z_b is the
 * loft height and his deposition formula covers the descent; the drift term covers the rise. So
 * a fair test gives the Lagrangian solver the SAME loft height Albini predicts, lets it fly the
 * whole trajectory — rise, drift, descent, in-flight burnout — and compares totals. Comparing a
 * descent-only Lagrangian flight against Albini's rise-plus-descent total understates it by
 * 3-7x, which is a bug in the test, not in the solver.
 *
 * Albini's own honest limit applies to what this can prove: he predicts a MAXIMUM distance for
 * a single brand under steady wind, calibrated on US conifers, with no eucalypt-bark, chaparral
 * or gorse parameterisation. So the envelope is asserted for the two classes traceable to
 * measurement, and only bounded for the three estimated ones.
 */

import { describe, expect, it } from 'vitest'
import { m as metres, moistureFraction, mps } from '@contracts/units'
import { albiniPileLoft, albiniSurfaceFireSpot } from '@sim/firebrands/albini.ts'
import {
  BRAND_CLASSES,
  arealDensity,
  equivalentDiameter,
  flightParamsFor,
  flyToGround,
  sampleProjectedArea,
  terminalVelocity,
} from '@sim/firebrands/brands.ts'
import type { BrandClassId, Vec3 } from '@sim/firebrands/brands.ts'
import { heskestadUz, logProfileFrom, logWind } from '../../fixtures/world.ts'

const WINDS = [4.5, 9, 13.4] // m/s at 20 ft: 10, 20, 30 mi/h
const FLAMES = [1.5, 3, 9] // m
const COVER = 9 // m downwind canopy

/**
 * Longest flight over the brand-size distribution, released at the ground into a plume whose
 * analytic loft ceiling equals Albini's z_b for this class. The plume switches off once the
 * brand tops out, which is exactly Albini's structure: loft to z_b, then descend through the
 * wind profile. 40 stratified samples of the −2 power law, so the "maximum" is a maximum over
 * the population and not over one arbitrary brand.
 */
function longestFlight(id: BrandClassId, u20: number, loftHeight: number): {
  distance: number
  time: number
} {
  const c = BRAND_CLASSES[id]
  const sigma = arealDensity(c.shape, c.halfThk)
  const vt = terminalVelocity(c.shape, c.halfThk)
  const profile = logProfileFrom(u20, 6.1)
  const convectiveKw = ((Math.cbrt(loftHeight) * vt) / 1.03) ** 3
  let best = { distance: 0, time: 0 }
  for (let i = 0; i < 40; i++) {
    const dEq = equivalentDiameter(
      sampleProjectedArea((i + 0.5) / 40, c.massMin / sigma, c.massMax / sigma),
    )
    let toppedOut = false
    const wind = (pos: Vec3): Vec3 => {
      if (pos[2] >= loftHeight) toppedOut = true
      return [logWind(profile, pos[2]), 0, toppedOut ? 0 : heskestadUz(convectiveKw, pos[2])]
    }
    const f = flyToGround(
      {
        pos: [0, 0, 1],
        vel: [0, 0, 0],
        halfThk: c.halfThk,
        massFrac: 1,
        areaEq: dEq,
        weight: 1,
        age: 0,
        shape: c.shape,
      },
      wind,
      flightParamsFor(c, moistureFraction(0)),
    )
    if (f.distance > best.distance) best = { distance: f.distance, time: f.time }
  }
  return best
}

describe('Albini reference models (§1)', () => {
  it('scales the way the published formulation does', () => {
    const a = albiniSurfaceFireSpot({
      wind20ft: mps(9),
      flameLength: metres(3),
      coverHeight: metres(COVER),
    })
    // Sanity against BehavePlus's operating range: a 3 m flame in a 20 mi/h wind spots a few
    // hundred metres, not tens and not tens of thousands.
    expect(a.total).toBeGreaterThan(200)
    expect(a.total).toBeLessThan(2000)
    expect(a.total).toBeCloseTo(a.flat + a.drift, 6)

    // z_b rises with flame length and FALLS with wind (f ~ U^-1.01), while the total distance
    // rises with both. Getting the sign of that first one wrong is the classic Albini mistake.
    const windier = albiniSurfaceFireSpot({
      wind20ft: mps(13.4),
      flameLength: metres(3),
      coverHeight: metres(COVER),
    })
    expect(windier.loftHeight).toBeLessThan(a.loftHeight)
    expect(windier.total).toBeGreaterThan(a.total)
    const taller = albiniSurfaceFireSpot({
      wind20ft: mps(9),
      flameLength: metres(9),
      coverHeight: metres(COVER),
    })
    expect(taller.loftHeight).toBeGreaterThan(a.loftHeight)
    expect(taller.total).toBeGreaterThan(a.total)
  })

  it('floors the cover height so the logarithm stays well behaved', () => {
    // h_c <- max(h_c, 2.2 z_b^0.337 - 4.0). Without it a low cover under a high loft sends
    // ln(z_b/h_c) through the roof and the distance with it.
    const bare = albiniSurfaceFireSpot({
      wind20ft: mps(9),
      flameLength: metres(9),
      coverHeight: metres(0.01),
    })
    expect(Number.isFinite(bare.total)).toBe(true)
    expect(bare.total).toBeLessThan(20000)
  })

  it('lofts a burning pile to 12.2 flame heights', () => {
    expect(albiniPileLoft(metres(3))).toBeCloseTo(36.6, 6)
  })
})

describe('acceptance: spot distances inside the Albini envelope', () => {
  it('reproduces Albini within a factor of 2 for both measured brand classes', () => {
    // Measured across 3 windspeeds x 3 flame lengths x 2 classes. Observed range at the time of
    // writing, over 18 cases: 0.76-1.66. The band asserted here is the spec's "within a factor of ~2".
    for (const id of ['conifer-cylinder', 'eucalypt-ribbon'] as const) {
      for (const u20 of WINDS) {
        for (const lf of FLAMES) {
          const a = albiniSurfaceFireSpot({
            wind20ft: mps(u20),
            flameLength: metres(lf),
            coverHeight: metres(COVER),
          })
          const f = longestFlight(id, u20, a.loftHeight)
          const ratio = f.distance / a.total
          expect(ratio, `${id} U=${u20} Lf=${lf} -> ${f.distance.toFixed(0)} m vs ${a.total.toFixed(0)} m`).toBeGreaterThan(0.5)
          expect(ratio, `${id} U=${u20} Lf=${lf} -> ${f.distance.toFixed(0)} m vs ${a.total.toFixed(0)} m`).toBeLessThan(2)
        }
      }
    }
  })

  it('never exceeds the transport-wind-times-burnout bound', () => {
    // The hard physical ceiling: a brand cannot travel further than the wind carries it before
    // it stops glowing. If any class breaks this, the burnout coupling is broken.
    for (const id of Object.keys(BRAND_CLASSES) as BrandClassId[]) {
      const c = BRAND_CLASSES[id]
      for (const u20 of WINDS) {
        const a = albiniSurfaceFireSpot({
          wind20ft: mps(u20),
          flameLength: metres(9),
          coverHeight: metres(COVER),
        })
        const f = longestFlight(id, u20, a.loftHeight)
        const uTop = logWind(logProfileFrom(u20, 6.1), a.loftHeight)
        expect(f.distance).toBeLessThanOrEqual(uTop * c.burnout * 1.01)
        expect(f.time).toBeLessThanOrEqual(c.burnout * 1.01)
      }
    }
  })

  it('burnout, not lofting, is what limits the estimated light classes', () => {
    // Grass fragments burn out in ~25 s, so raising the loft height past a point buys nothing:
    // the brand is dead before it lands. Getting a grass fire to spot 900 m would be the model
    // failing, and this is the assertion that would catch it.
    const short = longestFlight('grass-plate', 9, 50)
    const tall = longestFlight('grass-plate', 9, 400)
    expect(tall.distance).toBeLessThan(short.distance * 2)
    expect(tall.time).toBeLessThan(BRAND_CLASSES['grass-plate'].burnout * 1.01)
  })

  it('eucalypt ribbon outflies conifer from the same loft height', () => {
    // The §5 claim, as a test: same terminal velocity, 3.7x the burnout, so the ribbon is still
    // an ignition source long after the conifer twig has died.
    const ribbon = longestFlight('eucalypt-ribbon', 13.4, 400)
    const conifer = longestFlight('conifer-cylinder', 13.4, 400)
    expect(ribbon.distance).toBeGreaterThan(conifer.distance)
  })
})
