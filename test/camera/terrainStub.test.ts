/**
 * WP 1.8 — the analytic terrain stub.
 *
 * The stub is the oracle the walker tests are written against, so its own derivatives have
 * to be right: if `slopeAt` were wrong, the "walker follows the ground" test would be
 * measuring the wrong thing and would pass anyway.
 */

import { describe, expect, it } from 'vitest'
import { DOMAIN_SIZE_M } from '@contracts/world'
import type { ITerrainField } from '@contracts/world'
import type { Metres } from '@contracts/units'
import {
  DEFAULT_STUB_TERRAIN,
  StubTerrain,
  groundDirection,
  type TerrainSampler,
} from '../../src/camera/terrainStub.ts'
import { azimuthFromXZ } from '../../src/camera/math.ts'

const M = (v: number): Metres => v as Metres

describe('StubTerrain', () => {
  it('is deterministic for a seed and different between seeds', () => {
    const a = new StubTerrain({ seed: 7 })
    const b = new StubTerrain({ seed: 7 })
    const c = new StubTerrain({ seed: 8 })
    let differs = 0
    for (let i = 0; i < 50; i++) {
      const x = M((i * 97) % DOMAIN_SIZE_M)
      const z = M((i * 271) % DOMAIN_SIZE_M)
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z))
      if (Math.abs(a.heightAt(x, z) - c.heightAt(x, z)) > 1e-6) differs++
    }
    expect(differs).toBeGreaterThan(40)
  })

  it('analytic gradient matches central differences everywhere', () => {
    const t = new StubTerrain()
    const h = 1e-3
    let worst = 0
    for (let i = 0; i < 400; i++) {
      const x = 5 + ((i * 37.31) % (DOMAIN_SIZE_M - 10))
      const z = 5 + ((i * 61.77) % (DOMAIN_SIZE_M - 10))
      const g = t.gradientAt(x, z)
      const fdX = (t.heightAt(M(x + h), M(z)) - t.heightAt(M(x - h), M(z))) / (2 * h)
      const fdZ = (t.heightAt(M(x), M(z + h)) - t.heightAt(M(x), M(z - h))) / (2 * h)
      worst = Math.max(worst, Math.abs(g.dhdx - fdX), Math.abs(g.dhdz - fdZ))
    }
    expect(worst).toBeLessThan(1e-4)
  })

  it('normal, slope and aspect are consistent with the gradient', () => {
    const t = new StubTerrain()
    for (let i = 0; i < 200; i++) {
      const x = M(3 + ((i * 53.1) % (DOMAIN_SIZE_M - 6)))
      const z = M(3 + ((i * 89.7) % (DOMAIN_SIZE_M - 6)))
      const g = t.gradientAt(x, z)
      const n = t.normalAt(x, z)
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 9)
      expect(n[1]).toBeGreaterThan(0) // a height field has no overhangs
      // Slope is a TANGENT (spec 0.6 rule 4), which is |grad h|.
      expect(t.slopeAt(x, z)).toBeCloseTo(Math.hypot(g.dhdx, g.dhdz), 9)
      // Aspect is the DOWNSLOPE azimuth: walking along it must lose height.
      const d = groundDirection(t.aspectAt(x, z))
      const step = 0.05
      expect(t.heightAt(M(x + d.x * step), M(z + d.z * step))).toBeLessThan(t.heightAt(x, z))
      expect(t.aspectAt(x, z)).toBeCloseTo(azimuthFromXZ(-g.dhdx, -g.dhdz), 9)
    }
  })

  it('provides terrain steep enough to exercise the walker cliff path', () => {
    const t = new StubTerrain()
    const cx = t.escarpmentCentreX
    // The escarpment is deliberately steeper than any climb limit a walker would use. The
    // hill and ridge terms add to or subtract from it depending on z, so the guarantee is
    // stated as a floor that holds along the WHOLE crest, not at one lucky sample.
    let minCrestSlope = Infinity
    for (let z = 0; z <= DOMAIN_SIZE_M; z += 4) {
      minCrestSlope = Math.min(minCrestSlope, t.slopeAt(M(cx), M(z)))
    }
    expect(minCrestSlope).toBeGreaterThan(1.9)
    expect(Math.atan(minCrestSlope) * (180 / Math.PI)).toBeGreaterThan(62)

    // ...and the rest of the domain is walkable, so a traverse is not just cliff.
    let steepCells = 0
    let samples = 0
    for (let x = 0; x <= DOMAIN_SIZE_M; x += 16) {
      for (let z = 0; z <= DOMAIN_SIZE_M; z += 16) {
        samples++
        if (t.slopeAt(M(x), M(z)) > 1.19) steepCells++
      }
    }
    expect(steepCells / samples).toBeLessThan(0.15)
  })

  it('height stays within a sane elevation band across the domain', () => {
    const t = new StubTerrain()
    const p = DEFAULT_STUB_TERRAIN
    const lo = p.baseElevationM - (p.hillAmplitudeM + p.ridgeAmplitudeM + p.detailAmplitudeM) - 1
    const hi =
      p.baseElevationM +
      p.hillAmplitudeM +
      p.ridgeAmplitudeM +
      p.detailAmplitudeM +
      p.escarpmentHeightM +
      1
    for (let x = 0; x <= DOMAIN_SIZE_M; x += 8) {
      for (let z = 0; z <= DOMAIN_SIZE_M; z += 8) {
        const h = t.heightAt(M(x), M(z))
        expect(Number.isFinite(h)).toBe(true)
        expect(h).toBeGreaterThan(lo)
        expect(h).toBeLessThan(hi)
      }
    }
  })
})

describe('TerrainSampler contract compatibility', () => {
  it('the real ITerrainField satisfies the narrower sampler the camera consumes', () => {
    // Compile-time: if WP 1.2's contract ever stops being assignable, this stops compiling.
    // That is the whole point — the integrator must be able to hand the real field straight
    // in with no adapter.
    const accepts = (_s: TerrainSampler): void => undefined
    const real = null as unknown as ITerrainField
    accepts(real)
    accepts(new StubTerrain())
    expect(true).toBe(true)
  })
})
