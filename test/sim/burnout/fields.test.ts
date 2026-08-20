/**
 * The output fields — WP 2.4.
 *
 * The headline assertion is determinism: the same ignition, with the cell writes applied in a
 * different order, must produce **bit-identical** output. That is what the M6 CSV export
 * depends on, and it cannot be established by inspection of a compute shader — it has to be
 * a property of the combining operations, tested here on the CPU oracle that the shader is a
 * port of.
 *
 * The other assertions guard the two things that would break it silently:
 *   - the f32-bits-as-u32 ordering trick the GPU atomics rely on;
 *   - `state`/`consumed` being *derived* from arrival rather than accumulated.
 */

import { describe, expect, it } from 'vitest'
import { CELL_BURNING, CELL_BURNT, CELL_UNBURNT } from '@contracts/sim'
import { kWm, s } from '@contracts/units'
import { burnoutModelFor } from '@sim/burnout/consumption.ts'
import {
  ARRIVAL_NEVER,
  ARRIVAL_NEVER_BITS,
  FireOutputFields,
  PERIMETER_DEBIAS,
  bitsToF32,
  f32Bits,
  quantiseUnorm8,
} from '@sim/burnout/fields.ts'
import {
  AGG_BURNT_CELLS,
  AGG_MAX_INTENSITY_BITS,
  AGG_PERIM_EDGES,
  AGGREGATE_SLOTS,
  BURNOUT_MODEL_FLOATS,
  decodeAggregates,
  packBurnoutModels,
  packFuelIndex,
} from '@sim/burnout/layout.ts'
import { STUB_FUEL_MODELS, stubFuelModel, stubResidenceTime } from '../../fixtures/world.ts'

const MODELS = STUB_FUEL_MODELS.map((f) => burnoutModelFor(f, stubResidenceTime(f)))
const CELL_M = 0.5

/** Small deterministic LCG — no dependency, and a seeded shuffle has to be reproducible. */
function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 0x100000000
  }
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice()
  const rand = lcg(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

interface Write {
  readonly index: number
  readonly time: number
  readonly intensity: number
}

/**
 * A synthetic ignition that produces MANY competing writes per cell — which is the point.
 * Each cell is offered an arrival time by several notional propagation paths (the direct
 * radial one and four detours), so `min` actually has work to do and an order-dependent
 * combiner would show up immediately.
 */
function ignitionWrites(n: number, ros: number): Write[] {
  const cx = (n - 1) / 2
  const cy = (n - 1) / 2
  const writes: Write[] = []
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const index = y * n + x
      const dx = (x - cx) * CELL_M
      const dy = (y - cy) * CELL_M
      const direct = Math.hypot(dx, dy) / ros
      if (direct > 30) continue
      for (const detour of [1.0, 1.31, 1.07, 2.4, 1.19]) {
        writes.push({
          index,
          time: direct * detour,
          // Intensity varies per path too, so `max` is exercised the same way.
          intensity: 400 + 90 * Math.sin(index * 0.7 + detour),
        })
      }
    }
  }
  return writes
}

function apply(fields: FireOutputFields, writes: readonly Write[]): void {
  for (const w of writes) {
    fields.recordArrival(w.index, s(w.time))
    fields.recordIntensity(w.index, kWm(w.intensity))
  }
}

function bytes(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
}

describe('f32 bit patterns as atomic keys', () => {
  // `burnout.wgsl` does atomicMin/atomicMax on bitcast<u32> of these values. That is only
  // equivalent to float min/max because IEEE-754 orders non-negative floats the same way
  // their unsigned bit patterns order. If that ever stopped holding, arrival times would come
  // out scheduler-dependent and nothing else in this file would notice.
  it('sort non-negative floats identically to their unsigned bits', () => {
    const values = [
      0, 1.4e-45, 1e-38, 0.001, 0.5, 1, 1.0000001, 2, 1e6, 3.4028234663852886e38,
    ]
    for (let i = 1; i < values.length; i++) {
      const lo = Math.fround(values[i - 1] as number)
      const hi = Math.fround(values[i] as number)
      if (lo === hi) continue
      expect(f32Bits(lo)).toBeLessThan(f32Bits(hi))
    }
  })

  it('round-trips, and the never-arrived sentinel is the documented bit pattern', () => {
    expect(f32Bits(ARRIVAL_NEVER)).toBe(ARRIVAL_NEVER_BITS)
    expect(bitsToF32(ARRIVAL_NEVER_BITS)).toBe(ARRIVAL_NEVER)
    expect(Number.isFinite(ARRIVAL_NEVER)).toBe(true) // not Infinity — see fields.ts
    expect(bitsToF32(f32Bits(1234.5))).toBe(1234.5)
  })
})

describe('order independence', () => {
  const N = 64
  const base = ignitionWrites(N, 1.5)

  it('is bit-identical across shuffled write orders', () => {
    const reference = new FireOutputFields(N)
    apply(reference, base)
    reference.resolve(s(20), MODELS)

    for (const seed of [1, 7, 99, 123456]) {
      const other = new FireOutputFields(N)
      apply(other, shuffled(base, seed))
      other.resolve(s(20), MODELS)

      expect(bytes(other.arrivalTime)).toEqual(bytes(reference.arrivalTime))
      expect(bytes(other.peakIntensity)).toEqual(bytes(reference.peakIntensity))
      expect(bytes(other.state)).toEqual(bytes(reference.state))
      expect(bytes(other.consumed)).toEqual(bytes(reference.consumed))
      expect(other.aggregate(CELL_M)).toEqual(reference.aggregate(CELL_M))
    }
  })

  it('is unchanged by replaying every write a second time (idempotent)', () => {
    const once = new FireOutputFields(N)
    apply(once, base)
    once.resolve(s(20), MODELS)

    const twice = new FireOutputFields(N)
    apply(twice, base)
    apply(twice, shuffled(base, 31))
    twice.resolve(s(20), MODELS)

    expect(bytes(twice.arrivalTime)).toEqual(bytes(once.arrivalTime))
    expect(bytes(twice.consumed)).toEqual(bytes(once.consumed))
  })

  it('re-resolving at the same clock time changes nothing', () => {
    const f = new FireOutputFields(N)
    apply(f, base)
    f.resolve(s(20), MODELS)
    const first = bytes(f.consumed).slice()
    f.resolve(s(20), MODELS)
    expect(bytes(f.consumed)).toEqual(first)
  })

  it('keeps the earliest arrival, not the last write', () => {
    const f = new FireOutputFields(4)
    f.recordArrival(5, s(90))
    f.recordArrival(5, s(12))
    f.recordArrival(5, s(45))
    expect(f.arrivalTime[5]).toBe(12)
    f.recordIntensity(5, kWm(100))
    f.recordIntensity(5, kWm(700))
    f.recordIntensity(5, kWm(300))
    expect(f.peakIntensity[5]).toBe(700)
  })

  it('drops poisoned writes rather than letting them win the min', () => {
    const f = new FireOutputFields(4)
    f.recordArrival(2, s(NaN))
    f.recordArrival(2, s(-1))
    expect(f.arrivalTime[2]).toBe(ARRIVAL_NEVER)
    f.recordIntensity(2, kWm(NaN))
    expect(f.peakIntensity[2]).toBe(0)
  })
})

describe('state and consumption over time', () => {
  const fuel = stubFuelModel('SB1')
  const model = burnoutModelFor(fuel, stubResidenceTime(fuel))

  function atTime(now: number): { state: number; consumed: number } {
    const f = new FireOutputFields(4)
    f.recordArrival(0, s(0))
    f.resolve(s(now), [model])
    return { state: f.state[0] as number, consumed: f.consumed[0] as number }
  }

  it('goes unburnt -> burning -> burnt, and keeps consuming after the flame is out', () => {
    expect(atTime(-1).state).toBe(CELL_UNBURNT)
    expect(atTime(0.5).state).toBe(CELL_BURNING)
    expect(atTime(model.residenceTime * 0.99).state).toBe(CELL_BURNING)
    expect(atTime(model.residenceTime * 1.01).state).toBe(CELL_BURNT)

    // The point of the whole package: BURNT is a lifecycle label, not the end of combustion.
    const justBurnt = atTime(model.residenceTime * 1.01).consumed
    const later = atTime(model.residenceTime * 20).consumed
    expect(justBurnt).toBeLessThan(0.3 * 255)
    expect(later).toBeGreaterThan(justBurnt)
    expect(atTime(model.burnoutTime).consumed).toBe(255)
  })

  it('leaves unarrived cells untouched', () => {
    const f = new FireOutputFields(4)
    f.recordArrival(0, s(0))
    f.resolve(s(100), MODELS)
    expect(f.state[1]).toBe(CELL_UNBURNT)
    expect(f.consumed[1]).toBe(0)
    expect(f.arrivalTime[1]).toBe(ARRIVAL_NEVER)
  })

  it('quantises to r8unorm the way the GPU does', () => {
    expect(quantiseUnorm8(0)).toBe(0)
    expect(quantiseUnorm8(1)).toBe(255)
    expect(quantiseUnorm8(1.5)).toBe(255)
    expect(quantiseUnorm8(-0.2)).toBe(0)
    expect(quantiseUnorm8(0.5)).toBe(128)
  })
})

describe('aggregates', () => {
  /** Independent recount, written the dumbest way possible so it cannot share a bug. */
  function bruteForce(f: FireOutputFields): { burntAreaM2: number; edges: number; maxI: number } {
    let burnt = 0
    let edges = 0
    let maxI = 0
    for (let y = 0; y < f.n; y++) {
      for (let x = 0; x < f.n; x++) {
        const i = y * f.n + x
        maxI = Math.max(maxI, f.peakIntensity[i] as number)
        if ((f.arrivalTime[i] as number) >= ARRIVAL_NEVER) continue
        burnt++
        const neighbours: readonly (readonly [number, number])[] = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]
        for (const [nx, ny] of neighbours) {
          const inside = nx >= 0 && ny >= 0 && nx < f.n && ny < f.n
          if (!inside || (f.arrivalTime[ny * f.n + nx] as number) >= ARRIVAL_NEVER) edges++
        }
      }
    }
    return { burntAreaM2: burnt * CELL_M * CELL_M, edges, maxI }
  }

  it('match a brute-force recount', () => {
    const f = new FireOutputFields(48)
    apply(f, ignitionWrites(48, 1.0))
    f.resolve(s(9), MODELS)
    const agg = f.aggregate(CELL_M)
    const brute = bruteForce(f)
    expect(agg.burntAreaM2).toBe(brute.burntAreaM2)
    expect(agg.perimeterM).toBeCloseTo(brute.edges * CELL_M * PERIMETER_DEBIAS, 12)
    expect(agg.maxFirelineIntensity).toBe(brute.maxI)
  })

  it('recovers the area and perimeter of a known disc', () => {
    // 40 m radius disc on a 0.5 m grid. Area is exact to one cell; the staircase perimeter is
    // debiased by pi/4, so it should land within a couple of percent of 2*pi*r.
    const n = 200
    const r = 40
    const f = new FireOutputFields(n)
    const c = (n - 1) / 2
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (Math.hypot((x - c) * CELL_M, (y - c) * CELL_M) <= r) f.recordArrival(y * n + x, s(1))
      }
    }
    const agg = f.aggregate(CELL_M)
    expect(agg.burntAreaM2 / (Math.PI * r * r)).toBeCloseTo(1, 2)
    expect(agg.perimeterM / (2 * Math.PI * r)).toBeCloseTo(1, 1)
  })

  it('counts the domain edge as perimeter when the fire runs off the grid', () => {
    const n = 8
    const f = new FireOutputFields(n)
    for (let i = 0; i < n * n; i++) f.recordArrival(i, s(1))
    const agg = f.aggregate(CELL_M)
    expect(agg.burntAreaM2).toBe(n * n * CELL_M * CELL_M)
    // Every one of the 4n boundary cell edges is exposed.
    expect(agg.perimeterM).toBeCloseTo(4 * n * CELL_M * PERIMETER_DEBIAS, 12)
  })

  it('reports nothing for an unburnt grid', () => {
    const agg = new FireOutputFields(8).aggregate(CELL_M)
    expect(agg).toEqual({
      burntAreaM2: 0,
      perimeterM: 0,
      maxFirelineIntensity: 0,
      // Null, not the middle of the grid: an unlit fire has no plume, and defaulting the
      // position is exactly the bug the centroid exists to fix.
      flamingCentroid: null,
      flamingCells: 0,
    })
  })
})

describe('GPU buffer layout', () => {
  it('packs the model table the way the shader struct reads it', () => {
    const packed = packBurnoutModels(MODELS)
    expect(packed.length).toBe(MODELS.length * BURNOUT_MODEL_FLOATS)

    MODELS.forEach((model, mi) => {
      const base = mi * BURNOUT_MODEL_FLOATS
      // invTau[0] is dead1h; a class with no loading carries 0 so the shader's
      // "inv_tau <= 0 -> nothing to burn" branch does not need the loading.
      expect(packed[base + 0]).toBeCloseTo(1 / model.tau.dead1h, 7)
      expect(packed[base + 10]).toBeCloseTo(model.residenceTime, 5)
      expect(packed[base + 11]).toBeCloseTo(model.totalLoad, 6)

      let fractionSum = 0
      for (let c = 0; c < 5; c++) fractionSum += packed[base + 5 + c] as number
      expect(fractionSum).toBeCloseTo(1, 5)
    })

    const gr2 = packed.slice(0, BURNOUT_MODEL_FLOATS)
    expect(gr2[1]).toBe(0) // GR2 has no 10-h loading
    expect(gr2[6]).toBe(0)
  })

  it('refuses a table that cannot be addressed by the 8-bit per-cell index', () => {
    const tooMany = Array.from({ length: 257 }, () => MODELS[0]!)
    expect(() => packBurnoutModels(tooMany)).toThrow(/8-bit/)
    expect(() => packBurnoutModels([])).toThrow(/empty/)
  })

  it('packs four fuel indices per word, little-endian', () => {
    const words = packFuelIndex(Uint8Array.from([1, 2, 3, 4, 255, 0, 0, 0]))
    expect(words.length).toBe(2)
    expect(words[0]).toBe(0x04030201)
    expect(words[1]).toBe(0x000000ff)
  })

  it('decodes the atomic counters into the published aggregates', () => {
    const raw = new Uint32Array(AGGREGATE_SLOTS)
    raw[AGG_BURNT_CELLS] = 400
    raw[AGG_PERIM_EDGES] = 80
    raw[AGG_MAX_INTENSITY_BITS] = f32Bits(1234)
    const agg = decodeAggregates(raw, CELL_M)
    expect(agg.burntAreaM2).toBe(100)
    expect(agg.perimeterM).toBeCloseTo(80 * CELL_M * PERIMETER_DEBIAS, 12)
    expect(agg.maxFirelineIntensity).toBe(1234)
  })
})
