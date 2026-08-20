/**
 * WP 3.5 — stand aggregation from M1 vegetation.
 *
 * The assertion that matters most here is the negative one: stand canopy bulk density must
 * come from the caller, never from `Stem.crownBulkDensity`. The per-stem field is
 * within-crown and several times larger, and using it would put every conifer stand above
 * the 0.05 kg m⁻³ active-crowning threshold at any spread rate.
 */

import { describe, expect, it } from 'vitest'
import { kgm3, m, moistureFraction } from '@contracts/units.ts'
import { aggregateStand } from '@sim/canopy/crown/stand.ts'
import type { CrownStem } from '@sim/canopy/crown/stand.ts'
import { criticalInitiationIntensity } from '@sim/canopy/crown/vanWagner.ts'

const stem = (
  heightM: number,
  crownBaseM: number,
  fmc: number,
  hasLadderFuels = false,
): CrownStem => ({
  heightM: m(heightM),
  crownBaseM: m(crownBaseM),
  foliarMoisture: moistureFraction(fmc),
  hasLadderFuels,
})

describe('aggregateStand', () => {
  it('averages crown base and foliar moisture over stems that have a crown', () => {
    const s = aggregateStand([stem(20, 4, 1.0), stem(24, 8, 1.2)], kgm3(0.12))
    expect(s.canopyBaseHeight).toBeCloseTo(6, 10)
    expect(s.foliarMoisture).toBeCloseTo(1.1, 10)
    expect(s.canopyBulkDensity).toBeCloseTo(0.12, 10)
  })

  it('ignores stems with no crown depth rather than letting them pull the mean down', () => {
    // A dead or suppressed stem with crownBase == height carries no canopy fuel. Counting it
    // would drag the stand crown base toward its own height and its moisture into the mean.
    const withDead = aggregateStand([stem(20, 4, 1.0), stem(30, 30, 0.3)], kgm3(0.12))
    const without = aggregateStand([stem(20, 4, 1.0)], kgm3(0.12))
    expect(withDead.canopyBaseHeight).toBeCloseTo(without.canopyBaseHeight, 12)
    expect(withDead.foliarMoisture).toBeCloseTo(without.foliarMoisture, 12)
  })

  it('returns an empty stand for an empty stem list without dividing by zero', () => {
    const s = aggregateStand([], kgm3(0.12))
    expect(s.canopyBaseHeight).toBe(0)
    expect(s.canopyBulkDensity).toBe(0)
    expect(s.foliarMoisture).toBe(0)
    expect(Number.isNaN(s.canopyBaseHeight)).toBe(false)
  })

  it('takes stand bulk density from the caller, never from the stems', () => {
    // Same stems, two different stand densities: the aggregate follows the caller. This is
    // the M1 `species.ts` within-crown / stand distinction, asserted.
    const stems = [stem(20, 4, 1.0)]
    expect(aggregateStand(stems, kgm3(0.08)).canopyBulkDensity).toBeCloseTo(0.08, 12)
    expect(aggregateStand(stems, kgm3(0.35)).canopyBulkDensity).toBeCloseTo(0.35, 12)
  })

  it('clamps a negative stand bulk density instead of propagating it', () => {
    expect(aggregateStand([stem(20, 4, 1.0)], kgm3(-1)).canopyBulkDensity).toBe(0)
  })

  it('lowers crown base for ladder-fuelled stems only when a ladder height is supplied', () => {
    const stems = [stem(20, 6, 1.0, true), stem(20, 6, 1.0, false)]
    expect(aggregateStand(stems, kgm3(0.12)).canopyBaseHeight).toBeCloseTo(6, 10)
    const withLadder = aggregateStand(stems, kgm3(0.12), { ladderFuelCbhM: m(1.5) })
    expect(withLadder.canopyBaseHeight).toBeCloseTo((1.5 + 6) / 2, 10)
    // And that lowering is what makes the stand torch sooner, which is the whole point.
    expect(
      criticalInitiationIntensity(withLadder.canopyBaseHeight, withLadder.foliarMoisture),
    ).toBeLessThan(criticalInitiationIntensity(m(6), moistureFraction(1.0)))
  })

  it('never raises a stem crown base above its own value via the ladder option', () => {
    const stems = [stem(20, 1, 1.0, true)]
    expect(aggregateStand(stems, kgm3(0.12), { ladderFuelCbhM: m(5) }).canopyBaseHeight).toBeCloseTo(
      1,
      10,
    )
  })

  it('is a single linear pass — 50k stems in a few tenths of a millisecond', () => {
    const stems: CrownStem[] = []
    for (let i = 0; i < 50_000; i++) stems.push(stem(18 + (i % 10), 3 + (i % 5), 1.0 + (i % 3) / 10))
    aggregateStand(stems, kgm3(0.12)) // warm-up
    const t0 = performance.now()
    const s = aggregateStand(stems, kgm3(0.12))
    const ms = performance.now() - t0
    expect(s.canopyBaseHeight).toBeGreaterThan(0)
    expect(ms).toBeLessThan(50) // generous; this runs once at world load, not per step
    // eslint-disable-next-line no-console
    console.log(`aggregateStand(50k stems): ${ms.toFixed(3)} ms`)
  })
})
