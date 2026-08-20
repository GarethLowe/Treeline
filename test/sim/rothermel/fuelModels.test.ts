/**
 * The fuel model table is data, and data needs a check that it was transcribed correctly rather
 * than plausibly. Spec §4.3 tabulates 13 of the 40 Scott & Burgan rows independently, so those
 * 13 are a genuine in-repo authority to assert the transcription against — ~130 numbers that
 * either agree or do not.
 */

import { describe, expect, it } from 'vitest'
import { MODELS } from '../../../src/provenance.ts'
import { ALL_FUEL_MODELS, ANDERSON_TO_SB, FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { FACTORS, fracToPct, toFeet, toPerFoot } from '@contracts/units.ts'
import { FUEL_SIZE_CLASSES } from '@contracts/sim.ts'

const tonsPerAcre = (kgm2: number): number => kgm2 / FACTORS.TONSACRE_TO_KGM2

/** Spec §4.3, verbatim: code, [1h, 10h, 100h, herb, woody] t/ac, [s1h, sHerb, sWood], depth ft, Mx %, type. */
const SPEC_TABLE: readonly [
  string,
  readonly [number, number, number, number, number],
  readonly [number, number | null, number | null],
  number,
  number,
  'static' | 'dynamic',
][] = [
  ['GR1', [0.1, 0, 0, 0.3, 0], [2200, 2000, null], 0.4, 15, 'dynamic'],
  ['GR2', [0.1, 0, 0, 1.0, 0], [2000, 1800, null], 1.0, 15, 'dynamic'],
  ['GR4', [0.25, 0, 0, 1.9, 0], [2000, 1800, null], 2.0, 15, 'dynamic'],
  ['GS1', [0.2, 0, 0, 0.5, 0.65], [2000, 1800, 1800], 0.9, 15, 'dynamic'],
  ['SH2', [1.35, 2.4, 0.75, 0, 3.85], [2000, null, 1600], 1.0, 15, 'static'],
  ['SH5', [3.6, 2.1, 0, 0, 2.9], [750, null, 1600], 6.0, 15, 'static'],
  ['SH7', [3.5, 5.3, 2.2, 0, 3.4], [750, null, 1600], 6.0, 15, 'static'],
  ['TU1', [0.2, 0.9, 1.5, 0.2, 0.9], [2000, 1800, 1600], 0.6, 20, 'dynamic'],
  ['TU5', [4.0, 4.0, 3.0, 0, 3.0], [1500, null, 750], 1.0, 25, 'static'],
  ['TL2', [1.4, 2.3, 2.2, 0, 0], [2000, null, null], 0.2, 25, 'static'],
  ['TL5', [1.15, 2.5, 4.4, 0, 0], [2000, null, 1600], 0.6, 25, 'static'],
  ['TL8', [5.8, 1.4, 1.1, 0, 0], [1800, null, null], 0.3, 35, 'static'],
  ['SB1', [1.5, 3.0, 11.0, 0, 0], [2000, null, null], 1.0, 25, 'static'],
]

describe('fuel model table vs spec §4.3', () => {
  it.each(SPEC_TABLE)('%s matches the spec row', (code, load, sav, depthFt, mxPct, type) => {
    const f = FUEL_MODELS.get(code)
    expect(f.type).toBe(type)
    expect(tonsPerAcre(f.load.dead1h)).toBeCloseTo(load[0], 6)
    expect(tonsPerAcre(f.load.dead10h)).toBeCloseTo(load[1], 6)
    expect(tonsPerAcre(f.load.dead100h)).toBeCloseTo(load[2], 6)
    expect(tonsPerAcre(f.load.liveHerb)).toBeCloseTo(load[3], 6)
    expect(tonsPerAcre(f.load.liveWoody)).toBeCloseTo(load[4], 6)
    expect(toPerFoot(f.sav.dead1h)).toBeCloseTo(sav[0], 6)
    // A dash in the spec table means the class carries no load, so its SAV is irrelevant.
    if (sav[1] !== null) expect(toPerFoot(f.sav.liveHerb)).toBeCloseTo(sav[1], 6)
    if (sav[2] !== null) expect(toPerFoot(f.sav.liveWoody)).toBeCloseTo(sav[2], 6)
    expect(toFeet(f.depth)).toBeCloseTo(depthFt, 6)
    expect(fracToPct(f.moistureOfExtinctionDead)).toBeCloseTo(mxPct, 6)
  })

  it('uses the shared 10-h and 100-h SAV constants across the whole S&B set', () => {
    for (const [code] of SPEC_TABLE) {
      const f = FUEL_MODELS.get(code)
      expect(toPerFoot(f.sav.dead10h), code).toBeCloseTo(109, 6)
      expect(toPerFoot(f.sav.dead100h), code).toBeCloseTo(30, 6)
    }
  })

  it('gives GR6 the 9000 BTU/lb heat content and everything else 8000', () => {
    const btu = (code: string) => FUEL_MODELS.get(code).heatContent / FACTORS.BTULB_TO_KJKG
    expect(btu('GR6')).toBeCloseTo(9000, 6)
    for (const f of ALL_FUEL_MODELS) {
      if (f.code === 'GR6') continue
      expect(f.heatContent / FACTORS.BTULB_TO_KJKG, f.code).toBeCloseTo(8000, 6)
    }
  })
})

describe('table completeness and shape', () => {
  it('carries all 40 Scott & Burgan models, the Anderson 13, and the UK set', () => {
    const prefixes = ['GR', 'GS', 'SH', 'TU', 'TL', 'SB']
    const counts = [9, 4, 9, 5, 9, 4]
    prefixes.forEach((p, i) => {
      const n = counts[i] ?? 0
      for (let k = 1; k <= n; k++) expect(FUEL_MODELS.has(`${p}${k}`), `${p}${k}`).toBe(true)
    })
    for (let k = 1; k <= 13; k++) expect(FUEL_MODELS.has(`FM${k}`), `FM${k}`).toBe(true)
    expect(ALL_FUEL_MODELS.filter((f) => f.code.startsWith('UK-')).length).toBe(13)
    expect(FUEL_MODELS.codes.length).toBe(40 + 13 + 13)
  })

  it('has no duplicate codes', () => {
    expect(new Set(FUEL_MODELS.codes).size).toBe(FUEL_MODELS.codes.length)
  })

  it('throws on an unknown code rather than returning a silent default', () => {
    expect(() => FUEL_MODELS.get('NOPE')).toThrow(/unknown fuel model/)
    expect(FUEL_MODELS.has('NOPE')).toBe(false)
  })

  it('every entry is physically well formed', () => {
    for (const f of ALL_FUEL_MODELS) {
      expect(f.depth, f.code).toBeGreaterThan(0)
      expect(f.heatContent, f.code).toBeGreaterThan(0)
      let total = 0
      for (const c of FUEL_SIZE_CLASSES) {
        expect(f.load[c], `${f.code}.${c}`).toBeGreaterThanOrEqual(0)
        expect(f.sav[c], `${f.code}.${c}`).toBeGreaterThanOrEqual(0)
        // A class with load must have a SAV, or its surface area silently vanishes.
        if (f.load[c] > 0) expect(f.sav[c], `${f.code}.${c} sav`).toBeGreaterThan(0)
        total += f.load[c]
      }
      expect(total, f.code).toBeGreaterThan(0)
    }
  })

  it('every fuel lineage carries a real citation with a locator (spec §0.7.1)', () => {
    // Per-model records collapsed into one table on 2026-08-20, so the claim is now made once
    // per LINEAGE (Scott & Burgan, Anderson, UK) rather than repeated on all 67 entries.
    const fuels = MODELS.filter((m) => m.subsystem === 'Surface fire behaviour')
    expect(fuels.length).toBeGreaterThan(0)
    for (const m of fuels) {
      expect(m.ref.length, m.id).toBeGreaterThan(0)
      expect(m.locator.length, `${m.id} locator`).toBeGreaterThan(0)
    }
  })

  it('maps Anderson codes onto S&B codes that all exist', () => {
    for (const [anderson, sb] of Object.entries(ANDERSON_TO_SB)) {
      expect(FUEL_MODELS.has(anderson), anderson).toBe(true)
      for (const code of sb) expect(FUEL_MODELS.has(code), code).toBe(true)
    }
  })
})

describe('the UK set', () => {
  it('is labelled `estimated`, because its SAV values are assigned not measured', () => {
    const uk = MODELS.find((m) => m.id === 'fuel-models-uk')
    expect(uk, 'a UK fuel-set record must exist in src/provenance.ts').toBeDefined()
    expect(uk?.status).toBe('estimated')
  })

  it('routes gorse through SH7 with a reduced depth, labelled substituted', () => {
    const gorse = FUEL_MODELS.get('UK-GORSE-MATURE')
    const sh7 = FUEL_MODELS.get('SH7')
    // The substitution's known bias now reads in `docs/spec/_provenance-notes.md`; what the
    // code still owes is the STATUS, because that is what the HUD shows the user.
    expect(MODELS.find((m) => m.id === 'fuel-model-uk-gorse')?.status).toBe('substituted')
    expect(gorse.load).toEqual(sh7.load)
    expect(gorse.sav).toEqual(sh7.sav)
    expect(gorse.depth).toBeLessThan(sh7.depth)
    expect(gorse.depth).toBeCloseTo(1.5, 9)
  })

  it('carries the Calluna age classes, bracken, Molinia, pasture and stubble', () => {
    for (const code of [
      'UK-CALLUNA-PIONEER',
      'UK-CALLUNA-EARLY-BUILDING',
      'UK-CALLUNA-TALL-BUILDING',
      'UK-CALLUNA-MATURE',
      'UK-CALLUNA-DEGENERATE',
      'UK-BRACKEN-LITTER',
      'UK-BRACKEN-GREEN',
      'UK-GORSE-MATURE',
      'UK-MOLINIA-CURED',
      'UK-PASTURE-GRAZED',
      'UK-CEREAL-STUBBLE',
    ]) {
      expect(FUEL_MODELS.has(code), code).toBe(true)
    }
  })

  it('keeps Calluna loads inside the 0.23-6.27 kg/m2 growth-cycle span of §7.3.2', () => {
    for (const f of ALL_FUEL_MODELS.filter((x) => x.code.startsWith('UK-CALLUNA'))) {
      const total = FUEL_SIZE_CLASSES.reduce((a, c) => a + f.load[c], 0)
      expect(total, f.code).toBeGreaterThanOrEqual(0.23)
      expect(total, f.code).toBeLessThanOrEqual(6.27)
    }
  })
})
