/**
 * WP 3.3 cost. §6.3's open question asks for two things: a figure, and **which bound it came
 * from**. This file answers both, and is explicit about what is measured and what is reasoned.
 *
 * **MEASURED** (by running the reference solver over a realistic scene, here, on the CLI):
 * the work — extinction samples, cluster-scan trip counts, selection rescans, bytes moved.
 *
 * **REASONED** (from published RTX 4070 Laptop rates): the conversion of that work into
 * microseconds. There is no target GPU in this environment, and the machine's in-app browser
 * runs on the Intel iGPU, whose timings are roughly 10x off and would be worse than no number
 * at all. So: real work counts, device rates from the datasheet, and the arithmetic shown.
 *
 * The conclusion — that the pass is **texture-sampler bound**, not bandwidth bound and not
 * ALU bound — is the part that actually needed answering, because §6.3 flags its own 900 us
 * estimate as "reasoned from ray count and ALU rather than from the bandwidth bound that
 * actually governs". It is neither. The extinction field was deliberately sized at 4.19 MB so
 * it stays L2-resident, which is what moved the bottleneck to the TMUs.
 *
 * A per-pass timestamp query on the target machine supersedes every number below.
 *
 *   npx vitest run test/sim/canopy/radiation/budget.test.ts
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CLUSTER_OPTIONS, buildClusters } from '@sim/canopy/radiation/emitters.ts'
import { emptyExtinctionField, gatherIrradiance } from '@sim/canopy/radiation/gather.ts'
import { EMIT_CLUSTER_CAP, RAD_CELL_COUNT, RAD_CELL_M, RAD_NI, RAD_NJ, RAD_NK, RAD_UPDATE_HZ, RAY_TAPS } from '@sim/canopy/radiation/layout.ts'
import type { EmitterSample, RadCluster } from '@sim/canopy/radiation/emitters.ts'

// ---------------------------------------------------------------------------
// Device rates — RTX 4070 Laptop (AD106). REASONED, from the published spec.
// ---------------------------------------------------------------------------

/** 4608 shader cores at ~2.1 GHz, 2 flops per FMA. */
const FP32_OPS_PER_S = 4608 * 2.1e9 * 2
/**
 * 144 TMUs at ~2.1 GHz do one bilinear-filtered fetch per clock. A trilinear fetch from a 3D
 * texture is two of those, so half rate. This is the pass's binding resource.
 */
const TRILINEAR3D_PER_S = (144 * 2.1e9) / 2
/** §6.3's own effective figure: 256 GB/s peak, ~75% achievable through Dawn/D3D12. */
const DRAM_BYTES_PER_S = 190e9
/** Frames per second the whole budget is written against. */
const TARGET_FPS = 60

/**
 * Instruction counts for the WGSL inner loops. REASONED by reading the shader, not measured:
 * a subtract-3, dot-3, add, reciprocal, multiply, two FMAs and a compare for the scan; an
 * FMA-3, the sample address arithmetic and an add for each march tap.
 */
const SCAN_OPS_PER_CLUSTER = 12
const MARCH_OPS_PER_TAP = 6
const TAIL_OPS = 20

// ---------------------------------------------------------------------------
// A realistic scene. §6.3's "typical" is a ~2 km perimeter with ~4% of the surface
// grid and ~40,000 active canopy voxels; the worst case is a fully occupied canopy.
// ---------------------------------------------------------------------------

/** A 2 km closed perimeter of 0.5 m surface cells, plus a band of flaming crown behind it. */
function matureFireEmitters(): EmitterSample[] {
  const out: EmitterSample[] = []
  const radius = 2000 / (2 * Math.PI)
  const cells = Math.round(2000 / 0.5)
  for (let n = 0; n < cells; n++) {
    const a = (n / cells) * 2 * Math.PI
    out.push({
      x: 512 + radius * Math.cos(a),
      y: 0.9,
      z: 512 + radius * Math.sin(a),
      powerW: 1.0e5,
      radiusM: 0.5,
    })
  }
  // ~4000 flaming crown voxels just inside the perimeter.
  for (let n = 0; n < 4000; n++) {
    const a = ((n * 2.399) % (2 * Math.PI))
    const r = radius - 4 - (n % 10)
    out.push({
      x: 512 + r * Math.cos(a),
      y: 8 + (n % 6) * 2,
      z: 512 + r * Math.sin(a),
      powerW: 1.5e6,
      radiusM: 1,
    })
  }
  return out
}

function uniformField(kappa: number) {
  const f = emptyExtinctionField(RAD_NI, RAD_NJ, RAD_NK, RAD_CELL_M)
  f.kappa.fill(kappa)
  return f
}

/** Average the per-receiver work over a spread of receivers around the fire. */
function measureWork(clusters: readonly RadCluster[], rayCount: number) {
  const field = uniformField(0.3)
  let taps = 0
  let scanned = 0
  let rescans = 0
  const samples = 240
  for (let n = 0; n < samples; n++) {
    const a = (n / samples) * 2 * Math.PI
    const r = 40 + (n % 12) * 30
    const g = gatherIrradiance(
      512 + r * Math.cos(a),
      6 + (n % 8) * 4,
      512 + r * Math.sin(a),
      clusters,
      field,
      { rayCount, taps: RAY_TAPS },
    )
    taps += g.taps
    scanned += g.scanned
    rescans += g.rescans
  }
  return { taps: taps / samples, scanned: scanned / samples, rescans: rescans / samples }
}

interface Cost {
  readonly samplerUs: number
  readonly aluUs: number
  readonly dramUs: number
  readonly totalUs: number
  readonly perFrameUs: number
  readonly bound: 'sampler' | 'alu' | 'dram'
}

/** Convert MEASURED work into REASONED microseconds. */
function cost(
  work: { taps: number; scanned: number; rescans: number },
  receivers: number,
  rayCount: number,
): Cost {
  const samplerUs = ((work.taps * receivers) / TRILINEAR3D_PER_S) * 1e6
  const opsPerReceiver =
    work.scanned * SCAN_OPS_PER_CLUSTER +
    work.rescans * rayCount +
    work.taps * MARCH_OPS_PER_TAP +
    TAIL_OPS
  const aluUs = ((opsPerReceiver * receivers) / FP32_OPS_PER_S) * 1e6

  // DRAM: the 4.19 MB extinction field is read once into a 32 MB L2 and then hit from cache;
  // the cluster list is 32 KB and uniform across every workgroup. What actually crosses the
  // bus is the brick list, the irradiance writes, and that one field fill.
  const bytes = 4.19e6 + receivers * 4 + receivers * 2 + EMIT_CLUSTER_CAP * 32
  const dramUs = (bytes / DRAM_BYTES_PER_S) * 1e6

  const totalUs = Math.max(samplerUs, aluUs, dramUs)
  const bound = samplerUs >= aluUs && samplerUs >= dramUs ? 'sampler' : aluUs >= dramUs ? 'alu' : 'dram'
  return { samplerUs, aluUs, dramUs, totalUs, perFrameUs: (totalUs * RAD_UPDATE_HZ) / TARGET_FPS, bound }
}

describe('scene', () => {
  it('a 2 km perimeter fire bins to well under the cluster cap', () => {
    const r = buildClusters(matureFireEmitters(), DEFAULT_CLUSTER_OPTIONS)
    expect(r.overflowBins).toBe(0)
    expect(r.clusters.length).toBeLessThan(EMIT_CLUSTER_CAP / 2)
    // The 16 m bin turns 4000 surface cells plus 4000 crown voxels into a few hundred
    // clusters. It is NOT 2000/16 = 125: a curved front clips far more grid cells than its
    // length implies and the crown band is a volume. This measurement is what set the cap.
    expect(r.clusters.length).toBeGreaterThan(300)
    expect(r.clusters.length).toBeLessThan(500)
  })
})

describe('cost', () => {
  const clusters = buildClusters(matureFireEmitters(), DEFAULT_CLUSTER_OPTIONS).clusters
  // §7.4's own figure for a fully occupied canopy: 3.1e5 active half-res cells, which is
  // ~15% of the 2.1e6 cells on the 4 m grid.
  const WORST_RECEIVERS = 3.1e5
  const TYPICAL_RECEIVERS = 40000 / 8

  it('is texture-sampler bound, which is the answer §6.3 asked for', () => {
    const c = cost(measureWork(clusters, 8), WORST_RECEIVERS, 8)
    expect(c.bound).toBe('sampler')
    // Not close: the sampler term is several times the other two.
    expect(c.samplerUs).toBeGreaterThan(c.aluUs)
    expect(c.samplerUs).toBeGreaterThan(c.dramUs * 4)
  })

  it('fits a full-canopy solve in well under a millisecond at the 8-ray floor', () => {
    const c = cost(measureWork(clusters, 8), WORST_RECEIVERS, 8)
    // Reported so a change shows up in the diff rather than only in a profiler.
    // eslint-disable-next-line no-console
    console.log(
      `worst case, 8 rays: sampler ${c.samplerUs.toFixed(0)} us, ALU ${c.aluUs.toFixed(0)} us, ` +
        `DRAM ${c.dramUs.toFixed(0)} us -> ${c.totalUs.toFixed(0)} us/solve, ` +
        `${c.perFrameUs.toFixed(3)} us/frame amortised (${c.bound}-bound)`,
    )
    expect(c.totalUs).toBeLessThan(700)
  })

  it('stays inside the 3 ms simulation budget even at the 32-ray quality ceiling', () => {
    const c = cost(measureWork(clusters, 32), WORST_RECEIVERS, 32)
    // eslint-disable-next-line no-console
    console.log(
      `worst case, 32 rays: ${c.totalUs.toFixed(0)} us/solve, ` +
        `${c.perFrameUs.toFixed(3)} us/frame amortised (${c.bound}-bound)`,
    )
    expect(c.totalUs).toBeLessThan(2500)
    expect(c.perFrameUs).toBeLessThan(300)
  })

  it('costs a small fraction of a frame once amortised at RAD_UPDATE_HZ', () => {
    // This is the number that matters: §6.3 schedules the pass at 1/1 on a 1/120 s substep,
    // which would be 120 solves per second against our 7.5.
    const c = cost(measureWork(clusters, 8), WORST_RECEIVERS, 8)
    expect(RAD_UPDATE_HZ / TARGET_FPS).toBeCloseTo(0.125, 6)
    expect(c.perFrameUs).toBeLessThan(100)
    // ...and against §6.3's own schedule, a 16x saving on the same solve.
    expect((c.totalUs * 120) / TARGET_FPS).toBeGreaterThan(c.perFrameUs * 15)
  })

  it('is negligible for the §6.3 typical mature fire', () => {
    const c = cost(measureWork(clusters, 8), TYPICAL_RECEIVERS, 8)
    expect(c.totalUs).toBeLessThan(80)
  })

  it('cannot trip the ~2 s Windows TDR limit even at the ceiling', () => {
    // §6.8 pitfall 6 wants any dispatch above ~50 ms chunked. Ours is two orders below.
    const c = cost(measureWork(clusters, 32), RAD_CELL_COUNT, 32)
    expect(c.totalUs).toBeLessThan(50_000)
  })
})

describe('memory', () => {
  it('keeps both fields inside the L2 that makes the pass sampler-bound', () => {
    const fieldBytes = RAD_CELL_COUNT * 2
    expect(fieldBytes).toBeCloseTo(4.19e6, -5)
    // AD106 has 32 MB of L2; two 4.19 MB fields plus a 16 KB cluster list fit with room for
    // the rest of the frame's working set.
    expect(2 * fieldBytes + EMIT_CLUSTER_CAP * 32).toBeLessThan(12e6)
  })

  it('is far smaller than the §7.4 pipeline it replaces', () => {
    const ours = 2 * RAD_CELL_COUNT * 2 + EMIT_CLUSTER_CAP * 32 + 64 * 64 * 8 * 5 * 4
    // §7.2's budget line: 33.6 MB double-buffered SH volume + 9.6 MB mipped pair pyramid.
    expect(ours).toBeLessThan(0.25 * 43.2e6)
  })
})
