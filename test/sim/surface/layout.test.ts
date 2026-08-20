/**
 * State layout and the §4.3 VRAM footprint.
 *
 *   npx vitest run test/sim/surface/layout.test.ts
 */

import { describe, expect, it } from 'vitest'
import {
  DEAD_MOISTURE_FULL_SCALE,
  FIELDS,
  LIVE_MOISTURE_FULL_SCALE,
  MIB,
  PLANE_COUNT,
  SUBSTEP_BYTES_PER_CELL,
  SURFACE_BUFFERS,
  SURFACE_CELLS,
  SURFACE_CELL_COUNT,
  SURFACE_STATE_BYTES,
  SURFACE_STATE_BYTES_PER_CELL_ACTUAL,
  SURFACE_STATE_MB,
  SURFACE_STATE_MIB,
  footprintReport,
  readField,
  writeField,
} from '@sim/surface/layout'
import type { FieldName } from '@sim/surface/layout'
import { SURFACE_STATE_BYTES_PER_CELL } from '@contracts/sim'
import { packCell } from '@sim/surface/surfacePass'

describe('packed cell state', () => {
  it('is exactly the 12 bytes the contract declares, in 3 u32 planes', () => {
    expect(PLANE_COUNT * 4).toBe(SURFACE_STATE_BYTES_PER_CELL)
    expect(Object.keys(FIELDS)).toHaveLength(12)
  })

  it('gives every field a distinct byte — no accidental aliasing', () => {
    const slots = new Set(Object.values(FIELDS).map((f) => `${f.plane}:${f.byte}`))
    expect(slots.size).toBe(12)
  })

  it('keeps the two ROS passes on planes 0 and 1 only', () => {
    // The ROS kernel reads fuelModelId + the five moistures. If any of those drifts to plane
    // 2 the substep pass silently gains 4 B/cell of traffic, which is the pass's whole budget.
    const rosFields: readonly FieldName[] = [
      'fuelModelId',
      'moistureDead1h',
      'moistureDead10h',
      'moistureDead100h',
      'moistureLiveHerb',
      'moistureLiveWoody',
    ]
    for (const f of rosFields) expect(FIELDS[f].plane).toBeLessThan(2)
  })

  it('round-trips moisture through unorm8 within the quantisation it advertises', () => {
    for (const mf of [0.02, 0.06, 0.15, 0.35, 0.6]) {
      const w: [number, number, number] = [0, 0, 0]
      writeField(w, 'moistureDead1h', mf)
      expect(readField(w, 'moistureDead1h')).toBeCloseTo(mf, 2)
      expect(Math.abs(readField(w, 'moistureDead1h') - mf)).toBeLessThan(
        DEAD_MOISTURE_FULL_SCALE / 255 / 2 + 1e-12,
      )
    }
    for (const mf of [0.6, 1.2, 2.0, 3.5]) {
      const w: [number, number, number] = [0, 0, 0]
      writeField(w, 'moistureLiveHerb', mf)
      expect(Math.abs(readField(w, 'moistureLiveHerb') - mf)).toBeLessThan(
        LIVE_MOISTURE_FULL_SCALE / 255 / 2 + 1e-12,
      )
    }
  })

  it('packs a whole cell without fields overwriting each other', () => {
    const w = packCell({
      fuelModelId: 2,
      flags: 5,
      moisture: [0.06, 0.07, 0.08, 0.6, 1.5],
      mass: [1, 0.8, 0.6, 0.4, 0.2],
    })
    expect(readField(w, 'fuelModelId')).toBe(2)
    expect(readField(w, 'flags')).toBe(5)
    expect(readField(w, 'moistureDead1h')).toBeCloseTo(0.06, 2)
    expect(readField(w, 'moistureDead10h')).toBeCloseTo(0.07, 2)
    expect(readField(w, 'moistureDead100h')).toBeCloseTo(0.08, 2)
    expect(readField(w, 'moistureLiveHerb')).toBeCloseTo(0.6, 1)
    expect(readField(w, 'moistureLiveWoody')).toBeCloseTo(1.5, 1)
    expect(readField(w, 'massWoody')).toBeCloseTo(0.2, 2)
  })
})

describe('§4.3 OPEN QUESTION — the surface state footprint', () => {
  it('is 4_194_304 cells at 0.5 m', () => {
    expect(SURFACE_CELLS).toBe(2048)
    expect(SURFACE_CELL_COUNT).toBe(4_194_304)
  })

  it('adds up to 36 B/cell = 144 MiB = 151.0 MB', () => {
    expect(SURFACE_STATE_BYTES_PER_CELL_ACTUAL).toBe(36)
    expect(SURFACE_STATE_BYTES).toBe(150_994_944)
    expect(SURFACE_STATE_MIB).toBe(144)
    expect(SURFACE_STATE_MB).toBeCloseTo(151.0, 1)
  })

  it('carries exactly one ping-pong pair, and it is φ', () => {
    const pinged = SURFACE_BUFFERS.filter((b) => b.copies > 1)
    expect(pinged.map((b) => b.name)).toEqual(['phi'])
    expect(pinged[0]!.copies).toBe(2)
    // The omission that made the spec's figure low: 16 MiB of second φ buffer.
    expect((4 * SURFACE_CELL_COUNT) / MIB).toBe(16)
  })

  it('shows why the spec figure did not reconcile', () => {
    // §4.3's own field list, counted without φ ping-pong and without the R0/I_R cache:
    const specFieldList = (12 + 4 + 4 + 8) * SURFACE_CELL_COUNT
    expect(specFieldList / MIB).toBe(112) // = 117.4 MB decimal, not "113 MB" either way
    expect(SURFACE_STATE_BYTES - specFieldList).toBe(8 * SURFACE_CELL_COUNT) // φ copy + R0 cache
  })

  it('reports its own derivation', () => {
    const r = footprintReport()
    expect(r).toContain('144 MiB')
    expect(r).toContain('MiB = 2^20 B')
  })
})

describe('substep traffic', () => {
  it('is 24 B/cell = 96 MiB full-grid', () => {
    expect(SUBSTEP_BYTES_PER_CELL).toBe(24)
    expect((SUBSTEP_BYTES_PER_CELL * SURFACE_CELL_COUNT) / MIB).toBe(96)
  })
})
