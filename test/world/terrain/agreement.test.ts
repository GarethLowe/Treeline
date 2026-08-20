/**
 * "CPU query matches the GPU texture within tolerance" — the acceptance criterion for this
 * package — split into the two halves that can actually be attributed when one fails.
 *
 * 1. **Packing and sampling rule** (runs everywhere, no device). Does the CPU query agree
 *    with the documented sampling of the texels we are about to upload? This is where the
 *    f16 quantisation of slope and aspect, the texel-centre convention, the clamp-to-edge
 *    behaviour and the gradient-vector interpolation are all pinned. If terrain looks wrong
 *    on screen and THIS passes, the packing is not the problem.
 * 2. **The real device** (runs only where WebGPU exists). Does the shader, on hardware,
 *    reproduce the same numbers from the uploaded textures? This catches an upload stride
 *    bug, a wrong texture format, an f16 conversion that disagrees with the hardware's, or
 *    a transcription slip between sampling.ts and terrain_sample.wgsl.
 *
 * Under Vitest on the CLI only (1) runs. (2) is the integrator's in-browser smoke check and
 * runs automatically anywhere `navigator.gpu` is present.
 */

import { describe, expect, it } from 'vitest'
import { m } from '@contracts/units'
import { DEFAULT_TERRAIN_PARAMS, generateTerrain } from '@world/terrain/generate.ts'
import { generateTerrainQueries } from '@world/terrain/field.ts'
import { angleDelta, packTerrainTexels, sampleTexels } from '@world/terrain/sampling.ts'
import { Rng } from '@world/terrain/rng.ts'
import { Heightfield } from '@world/terrain/heightfield.ts'
import { DOMAIN_SIZE_M } from '@contracts/world'

const GRID = 256
const DROPS = 12_000
const SEED = 4242

/**
 * Derived, not tuned to pass.
 *
 * - **Height** comes from the same `r32float` texels the CPU holds, so the only difference
 *   is the order of the multiply-adds. Micrometres.
 * - **Slope** is blended from f16-quantised gradient vectors rather than f32 ones. A texel
 *   of slope `s` carries a gradient error of about `s * 2e-3` (half an f16 ulp of the
 *   stored angle dominates the stored tangent's), so the blended tangent is good to ~1e-3
 *   over the whole field.
 * - **Aspect** is the ill-conditioned one, and honestly so. The angular error is roughly
 *   `(mean texel slope / blended slope) * 2e-3` — bounded where the four surrounding
 *   gradients agree, and unbounded exactly where they cancel, which is to say precisely on
 *   ridge crests and in thalwegs. That is not a defect of the encoding: on a knife-edge
 *   crest the downslope azimuth genuinely flips through 180 degrees within one cell, so no
 *   representation has a well-defined answer there.
 *
 *   So aspect is asserted where it means something. Below `flatSlopeCutoff` (tan 0.05,
 *   2.9 degrees) Rothermel's slope factor carries `tan^2 = 0.0025` and the solar
 *   aspect correction is likewise negligible, so the value is not used by anything; above
 *   it, agreement must be inside a degree. A percentile bound over the whole field, flat
 *   ground included, keeps the ill-conditioned tail from hiding a real regression.
 */
const TOL = {
  heightM: 1e-5,
  slopeTan: 3e-3,
  aspectRad: 0.02,
  aspectP999Rad: 0.02,
  normal: 3e-3,
  flatSlopeCutoff: 0.05,
}

describe('texel packing reproduces the CPU query', () => {
  const gen = generateTerrain({ ...DEFAULT_TERRAIN_PARAMS, relief: 0.8 }, SEED, {
    gridN: GRID,
    droplets: DROPS,
  })
  const field = gen.field
  const texels = packTerrainTexels(field)

  it('packs the declared sizes and formats', () => {
    expect(texels.n).toBe(GRID)
    expect(texels.cellM).toBe(DOMAIN_SIZE_M / GRID)
    expect(texels.height).toHaveLength(GRID * GRID)
    expect(texels.slopeAspect).toHaveLength(GRID * GRID * 2)
    // 4 bytes per texel on both, so a row is a multiple of the 256-byte copy alignment.
    expect((GRID * 4) % 256).toBe(0)
  })

  it('rejects a grid that would break the 256-byte row alignment', () => {
    // 100 texels * 4 bytes = 400 bytes per row, which copyTextureToBuffer will not accept.
    // Caught at pack time rather than as an opaque WebGPU validation error at upload.
    expect(() => packTerrainTexels(new Heightfield(100, DOMAIN_SIZE_M))).toThrow(/multiple of 64/)
    expect(() => generateTerrain(DEFAULT_TERRAIN_PARAMS, 1, { gridN: 100, droplets: 0 })).toThrow(
      /multiple of 64/,
    )
  })

  it('stores exact node heights', () => {
    for (const k of [0, 1, GRID + 7, GRID * GRID - 1, (GRID * GRID) >> 1]) {
      expect(texels.height[k]).toBe(field.height[k])
    }
  })

  it('agrees with the CPU query at 20000 interior positions', () => {
    const r = new Rng(SEED ^ 0x1234)
    let worstH = 0
    let worstS = 0
    let worstA = 0
    let worstN = 0
    let flat = 0
    const allAspectErrors: number[] = []

    for (let k = 0; k < 20_000; k++) {
      const x = r.range(0, DOMAIN_SIZE_M)
      const z = r.range(0, DOMAIN_SIZE_M)
      const s = sampleTexels(texels, x, z)
      const ch = field.heightAt(x, z)
      const cs = field.slopeAt(x, z)
      const ca = field.aspectAt(x, z)
      const cn = field.normalAt(x, z)

      worstH = Math.max(worstH, Math.abs(s.height - ch))
      worstS = Math.max(worstS, Math.abs(s.slopeTan - cs))
      worstN = Math.max(
        worstN,
        Math.abs(s.normal[0] - (cn[0] as number)),
        Math.abs(s.normal[1] - (cn[1] as number)),
        Math.abs(s.normal[2] - (cn[2] as number)),
      )
      const da = Math.abs(angleDelta(s.aspect, ca))
      allAspectErrors.push(da)
      if (cs < TOL.flatSlopeCutoff) flat++
      else worstA = Math.max(worstA, da)
    }

    allAspectErrors.sort((p, q) => p - q)
    const p999 = allAspectErrors[Math.floor(0.999 * (allAspectErrors.length - 1))] as number

    console.info(
      `[terrain packing] worst dh=${worstH.toExponential(2)} m, ds=${worstS.toExponential(2)}, ` +
        `da=${worstA.toExponential(2)} rad on slopes >${TOL.flatSlopeCutoff}, ` +
        `da p99.9=${p999.toExponential(2)} rad over all samples, dn=${worstN.toExponential(2)} ` +
        `(${flat} flat samples excluded from the aspect maximum)`,
    )
    expect(worstH).toBeLessThan(TOL.heightM)
    expect(worstS).toBeLessThan(TOL.slopeTan)
    expect(worstA).toBeLessThan(TOL.aspectRad)
    expect(p999).toBeLessThan(TOL.aspectP999Rad)
    expect(worstN).toBeLessThan(TOL.normal)
    expect(flat / 20_000).toBeLessThan(0.5) // the field must not be mostly flat
  })

  it('agrees across the aspect wrap at north, where naive angle blending fails', () => {
    // The failure this guards against is specific: blending the STORED aspect instead of the
    // gradient turns a boundary between 0.01 rad and 6.27 rad into ~3.14 rad — due south
    // where the answer is due north. So the test hunts for sample points whose four
    // surrounding texels straddle the seam and checks those specifically.
    const n = texels.n
    const cell = texels.cellM
    let checked = 0
    let worst = 0
    for (let j = 1; j < n - 1 && checked < 400; j++) {
      for (let i = 1; i < n - 1 && checked < 400; i++) {
        const a00 = field.nodeSlopeAspect(j * n + i)[1]
        const a10 = field.nodeSlopeAspect(j * n + i + 1)[1]
        const straddles =
          (a00 < 0.35 && a10 > 2 * Math.PI - 0.35) || (a10 < 0.35 && a00 > 2 * Math.PI - 0.35)
        if (!straddles) continue
        checked++
        const x = (i + 1) * cell // midway between texel i and i+1
        const z = (j + 0.5) * cell
        const s = sampleTexels(texels, x, z)
        if (field.slopeAt(x, z) < TOL.flatSlopeCutoff) continue
        worst = Math.max(worst, Math.abs(angleDelta(s.aspect, field.aspectAt(x, z))))
      }
    }
    expect(checked).toBeGreaterThan(20) // the seam must actually occur in this field
    expect(worst).toBeLessThan(TOL.aspectRad)
  })

  it('clamps outside the domain the same way on both paths', () => {
    for (const [x, z] of [
      [-50, -50],
      [-1, 500],
      [DOMAIN_SIZE_M + 200, DOMAIN_SIZE_M + 200],
      [500, DOMAIN_SIZE_M + 1],
      [0, 0],
      [DOMAIN_SIZE_M, DOMAIN_SIZE_M],
    ] as const) {
      const s = sampleTexels(texels, x, z)
      expect(s.height).toBeCloseTo(field.heightAt(x, z), 4)
      expect(s.slopeTan).toBeCloseTo(field.slopeAt(x, z), 2)
    }
  })

  it('exposes the same values through the contract object', () => {
    const q = generateTerrainQueries({ ...DEFAULT_TERRAIN_PARAMS, relief: 0.8 }, SEED, {
      gridN: GRID,
      droplets: DROPS,
    })
    const x = m(377.25)
    const z = m(613.75)
    expect(q.heightAt(x, z)).toBeCloseTo(field.heightAt(x, z), 6)
    expect(q.slopeAt(x, z)).toBeCloseTo(field.slopeAt(x, z), 6)
    expect(q.aspectAt(x, z)).toBeCloseTo(field.aspectAt(x, z), 6)
    const nq = q.normalAt(x, z)
    expect(Math.hypot(nq[0], nq[1], nq[2])).toBeCloseTo(1, 9)
  })
})

// ---------------------------------------------------------------------------
// Live device. Skipped on the CLI; runs in a WebGPU-capable host.
// ---------------------------------------------------------------------------

const hasWebGpu =
  typeof navigator !== 'undefined' && (navigator as { gpu?: unknown }).gpu !== undefined

describe.skipIf(!hasWebGpu)('CPU query matches the uploaded GPU texture', () => {
  it('reads back a probe of 4096 positions within tolerance', async () => {
    // Imported dynamically: this module pulls in WGSL through the Vite raw loader and needs
    // a device, neither of which should be a precondition for the CPU tests above.
    const { createTerrainField, verifyCpuGpuAgreement, probePositions, AGREEMENT_TOLERANCE } =
      await import('@world/terrain/gpu.ts')

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    expect(adapter).not.toBeNull()
    const device = await adapter!.requestDevice()

    const field = createTerrainField(
      device,
      { ...DEFAULT_TERRAIN_PARAMS, relief: 0.8 },
      SEED,
      { gridN: GRID, droplets: DROPS },
    )
    const report = await verifyCpuGpuAgreement(
      device,
      field,
      probePositions(4096, DOMAIN_SIZE_M),
    )
    console.info('[terrain gpu agreement]', report)

    expect(report.samples).toBe(4096)
    expect(report.maxHeightErrorM).toBeLessThan(AGREEMENT_TOLERANCE.heightM)
    expect(report.maxSlopeError).toBeLessThan(AGREEMENT_TOLERANCE.slopeTan)
    expect(report.maxAspectErrorRad).toBeLessThan(AGREEMENT_TOLERANCE.aspectRad)
    expect(report.maxNormalError).toBeLessThan(AGREEMENT_TOLERANCE.normal)
    expect(report.failures).toEqual([])
    expect(report.pass).toBe(true)

    field.destroy()
    device.destroy()
  }, 120_000)
})
