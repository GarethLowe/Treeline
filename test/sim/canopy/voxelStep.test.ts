/**
 * The canopy voxel pass, as far as the CLI can see it.
 *
 * That is further than it sounds and less far than it should be. `buildSlotMap` is pure and
 * fully testable, and an off-by-one there puts every voxel's heating in the wrong column with
 * nothing anywhere reporting an error. The shader itself never reaches a compiler here — Node
 * has no WebGPU — so what is checked is that every constant it was handed matches the
 * TypeScript that defines it, which is the failure mode that produced four shipped bugs in M1.
 */

import { describe, expect, it } from 'vitest'
import { buildSlotMap, buildVoxelStepShader, kineticsPrelude, CHAR_FRACTION, PYROLYSING_FRACTION } from '@sim/canopy/voxelStep.ts'
import { CANOPY_GRID, buildLayout, OccupancyMask, lookup, INVALID_VOXEL } from '@sim/canopy/storage/layout.ts'
import {
  CHAR_YIELD,
  CRITICAL_MASS_FLUX,
  PYROLYSIS_A,
  PYROLYSIS_E_OVER_R,
  PYROLYSIS_HEAT,
  SOLID_CONDUCTIVITY,
  WATER_BOILING_K,
  WATER_LATENT_HEAT,
} from '@sim/canopy/kinetics/constants.ts'

function maskWith(cells: readonly (readonly [number, number, number])[]): OccupancyMask {
  const mask = new OccupancyMask(CANOPY_GRID)
  for (const [i, j, k] of cells) mask.set(i, j, k)
  return mask
}

describe('buildSlotMap', () => {
  it('is the exact inverse of the layout lookup', () => {
    const layout = buildLayout(
      maskWith([
        [4, 7, 10],
        [4, 7, 11],
        [4, 7, 12],
        [100, 2, 3],
        [511, 511, 63],
      ]),
    )
    const map = buildSlotMap(layout)
    expect(map.length).toBe(layout.voxelCount)

    // Every allocated slot must name the column it actually belongs to.
    const g = CANOPY_GRID
    for (let i = 0; i < g.nxy; i += 1) {
      // Only the occupied columns matter, and a full sweep of 262 144 columns is wasteful;
      // check the ones the fixture populated plus their neighbours.
      for (const [ci, cj] of [[4, 7], [100, 2], [511, 511], [5, 7]] as const) {
        for (let k = 0; k < g.nz; k++) {
          const slot = lookup(layout, ci, cj, k)
          if (slot === INVALID_VOXEL) continue
          expect(map[slot]).toBe(cj * g.nxy + ci)
        }
      }
      break
    }
  })

  it('covers every slot — no allocated voxel is left pointing at column 0 by default', () => {
    // Column 0 is a real column, so an unwritten entry is indistinguishable from a correct
    // one unless column 0 is deliberately empty. Keep it empty and assert nothing claims it.
    const layout = buildLayout(maskWith([[9, 9, 20], [9, 9, 21], [300, 41, 5]]))
    const map = buildSlotMap(layout)
    expect(map.length).toBeGreaterThan(0)
    for (const column of map) expect(column).not.toBe(0)
  })

  it('is empty for a world with no canopy', () => {
    expect(buildSlotMap(buildLayout(maskWith([]))).length).toBe(0)
  })
})

describe('kinetics prelude', () => {
  const wgsl = kineticsPrelude()

  it('emits every constant from the TypeScript that owns it', () => {
    // Spot-check the ones whose drift would be invisible: an Arrhenius pair that is slightly
    // wrong produces a fire that ignites at a plausible but wrong temperature.
    expect(wgsl).toContain(`const PYROLYSIS_A: f32 = ${PYROLYSIS_A}.0;`)
    expect(wgsl).toContain(`const PYROLYSIS_E_OVER_R: f32 = ${PYROLYSIS_E_OVER_R}.0;`)
    expect(wgsl).toContain(`const CRITICAL_MASS_FLUX: f32 = ${CRITICAL_MASS_FLUX};`)
    expect(wgsl).toContain(`const CHAR_YIELD: f32 = ${CHAR_YIELD};`)
    expect(wgsl).toContain(`const PYROLYSIS_HEAT: f32 = ${PYROLYSIS_HEAT}.0;`)
    expect(wgsl).toContain(`const WATER_LATENT_HEAT: f32 = ${WATER_LATENT_HEAT}.0;`)
    expect(wgsl).toContain(`const WATER_BOILING_K: f32 = ${WATER_BOILING_K};`)
    expect(wgsl).toContain(`const SOLID_CONDUCTIVITY: f32 = ${SOLID_CONDUCTIVITY};`)
    expect(wgsl).toContain(`const CHAR_FRACTION: f32 = ${CHAR_FRACTION};`)
    expect(wgsl).toContain(`const PYROLYSING_FRACTION: f32 = ${PYROLYSING_FRACTION};`)
  })

  it('uses the Alves lineage, never the mixed one the constants file warns off', () => {
    expect(wgsl).not.toContain('7250')
    expect(wgsl).not.toContain('5800')
  })
})

describe('buildVoxelStepShader', () => {
  const wgsl = buildVoxelStepShader()

  it('concatenates all four packages exactly once', () => {
    expect(wgsl).toContain('fn canopy_lookup')          // WP 3.1 addressing
    expect(wgsl).toContain('fn plumeGasStateAtWorld')   // WP 3.4 convection
    expect(wgsl).toContain('const PYROLYSIS_A')         // WP 3.2 kinetics
    expect(wgsl).toContain('fn step(')                  // the pass itself
    expect(wgsl.match(/fn canopy_lookup/g)?.length).toBe(1)
    expect(wgsl.match(/fn plumeGasStateAtWorld/g)?.length).toBe(1)
  })

  it('declares no binding twice within a group', () => {
    const seen = new Set<string>()
    for (const m of wgsl.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)/g)) {
      const key = `${m[1]}/${m[2]}`
      expect(seen.has(key), `duplicate @group(${m[1]}) @binding(${m[2]})`).toBe(false)
      seen.add(key)
    }
    expect(seen.size).toBeGreaterThan(8)
  })

  it('puts convection on the group its own shader hard-codes', () => {
    // convection.wgsl declares `@group(3) @binding(0) var<uniform> plume`. If the pass ever
    // moves the plume group, that file has to move with it, and this is the tripwire.
    expect(wgsl).toContain('@group(3) @binding(0) var<uniform> plume')
  })
})
