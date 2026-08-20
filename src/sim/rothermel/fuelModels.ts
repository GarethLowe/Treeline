/**
 * The fuel model database: Anderson (1982) 13, Scott & Burgan (2005) 40, and the project's UK
 * set from spec §60 §7.3.2.
 *
 * All three share one schema (spec §4.3) — five load classes, per-class SAV, depth, dead
 * moisture of extinction, heat content — so there is no mapping problem, only three sources of
 * rows in one table.
 *
 * **Units.** The published tables are in short tons per acre, feet, ft^-1, BTU/lb and *percent*
 * moisture of extinction. The rows below are transcribed in exactly those units so they stay
 * checkable against the source papers line by line; conversion to the SI storage convention of
 * spec §0.6 happens once, here, at the parse boundary. The `pctToFrac` call on `mxPct` is the
 * only place a moisture percentage crosses into the simulation.
 *
 * The UK rows are natively SI in their source (§7.3.2 tabulates kg m^-2 and m^-1) and are kept
 * that way rather than being round-tripped through English units for cosmetic uniformity.
 */

import type { FuelSizeClass, FuelModel, FuelModelType, IFuelModelTable } from '@contracts/sim.ts'
import type { Feet, KgPerSquareMetre, PerFoot, PerMetre } from '@contracts/units.ts'
import {
  FACTORS,
  fromFeet,
  fromPerFoot,
  kJkg,
  kgm2,
  m,
  moisturePercent,
  pctToFrac,
  perM,
  tonsPerAcreToKgM2,
} from '@contracts/units.ts'

/** Constants shared across the whole Scott & Burgan and Anderson sets (spec §4.3). */
const SAV_10H_PER_FT = 109
const SAV_100H_PER_FT = 30
const DEFAULT_HEAT_BTU_LB = 8000

// `units.ts` exports the English branded types and the conversions out of them, but no
// constructors into them — English quantities are not supposed to be created outside a kernel
// boundary. The published tables are exactly such a boundary, so they are made here and
// immediately converted; nothing English escapes this file.
const asFeet = (v: number): Feet => v as Feet
const asPerFoot = (v: number): PerFoot => v as PerFoot

/** A row as published: tons/acre, feet, ft^-1, percent, BTU/lb. */
interface PublishedRow {
  readonly code: string
  readonly name: string
  readonly type: FuelModelType
  /** t/ac: [1-h, 10-h, 100-h, live herb, live woody] */
  readonly load: readonly [number, number, number, number, number]
  /** ft^-1: [1-h, live herb, live woody]. 10-h and 100-h are the shared constants. */
  readonly sav: readonly [number, number, number]
  readonly depthFt: number
  readonly mxPct: number
  readonly heatBtuLb?: number
}

/**
 * Scott & Burgan (2005) RMRS-GTR-153, the 40 standard fire behavior fuel models.
 *
 * The 13 rows that spec §4.3 tabulates independently (GR1, GR2, GR4, GS1, SH2, SH5, SH7, TU1,
 * TU5, TL2, TL5, TL8, SB1) are asserted against that table in the tests, which is a genuine
 * check of this transcription against an in-repo authoritative source.
 */
const SCOTT_BURGAN_ROWS: readonly PublishedRow[] = [
  // --- GR: grass ---------------------------------------------------------------------------
  { code: 'GR1', name: 'Short, sparse dry climate grass', type: 'dynamic', load: [0.10, 0, 0, 0.30, 0], sav: [2200, 2000, 0], depthFt: 0.4, mxPct: 15 },
  { code: 'GR2', name: 'Low load dry climate grass', type: 'dynamic', load: [0.10, 0, 0, 1.00, 0], sav: [2000, 1800, 0], depthFt: 1.0, mxPct: 15 },
  { code: 'GR3', name: 'Low load very coarse humid climate grass', type: 'dynamic', load: [0.10, 0.40, 0, 1.50, 0], sav: [1500, 1300, 0], depthFt: 2.0, mxPct: 30 },
  { code: 'GR4', name: 'Moderate load dry climate grass', type: 'dynamic', load: [0.25, 0, 0, 1.90, 0], sav: [2000, 1800, 0], depthFt: 2.0, mxPct: 15 },
  { code: 'GR5', name: 'Low load humid climate grass', type: 'dynamic', load: [0.40, 0, 0, 2.50, 0], sav: [1800, 1600, 0], depthFt: 1.5, mxPct: 40 },
  { code: 'GR6', name: 'Moderate load humid climate grass', type: 'dynamic', load: [0.10, 0, 0, 3.40, 0], sav: [2200, 2000, 0], depthFt: 1.5, mxPct: 40, heatBtuLb: 9000 },
  { code: 'GR7', name: 'High load dry climate grass', type: 'dynamic', load: [1.00, 0, 0, 5.40, 0], sav: [2000, 1800, 0], depthFt: 3.0, mxPct: 15 },
  { code: 'GR8', name: 'High load very coarse humid climate grass', type: 'dynamic', load: [0.50, 1.00, 0, 7.30, 0], sav: [1500, 1300, 0], depthFt: 4.0, mxPct: 30 },
  { code: 'GR9', name: 'Very high load humid climate grass', type: 'dynamic', load: [1.00, 1.00, 0, 9.00, 0], sav: [1800, 1600, 0], depthFt: 5.0, mxPct: 40 },
  // --- GS: grass-shrub ---------------------------------------------------------------------
  { code: 'GS1', name: 'Low load dry climate grass-shrub', type: 'dynamic', load: [0.20, 0, 0, 0.50, 0.65], sav: [2000, 1800, 1800], depthFt: 0.9, mxPct: 15 },
  { code: 'GS2', name: 'Moderate load dry climate grass-shrub', type: 'dynamic', load: [0.50, 0.50, 0, 0.60, 1.00], sav: [2000, 1800, 1800], depthFt: 1.5, mxPct: 15 },
  { code: 'GS3', name: 'Moderate load humid climate grass-shrub', type: 'dynamic', load: [0.30, 0.25, 0, 1.45, 1.25], sav: [1800, 1600, 1600], depthFt: 1.8, mxPct: 40 },
  { code: 'GS4', name: 'High load humid climate grass-shrub', type: 'dynamic', load: [1.90, 0.30, 0.10, 3.40, 7.10], sav: [1800, 1600, 1600], depthFt: 2.1, mxPct: 40 },
  // --- SH: shrub ---------------------------------------------------------------------------
  { code: 'SH1', name: 'Low load dry climate shrub', type: 'dynamic', load: [0.25, 0.25, 0, 0.15, 1.30], sav: [2000, 1800, 1600], depthFt: 1.0, mxPct: 15 },
  { code: 'SH2', name: 'Moderate load dry climate shrub', type: 'static', load: [1.35, 2.40, 0.75, 0, 3.85], sav: [2000, 0, 1600], depthFt: 1.0, mxPct: 15 },
  { code: 'SH3', name: 'Moderate load humid climate shrub', type: 'static', load: [0.45, 3.00, 0, 0, 6.20], sav: [1600, 0, 1400], depthFt: 2.4, mxPct: 40 },
  { code: 'SH4', name: 'Low load humid climate timber-shrub', type: 'static', load: [0.85, 1.15, 0.20, 0, 2.55], sav: [2000, 1800, 1600], depthFt: 3.0, mxPct: 30 },
  { code: 'SH5', name: 'High load dry climate shrub', type: 'static', load: [3.60, 2.10, 0, 0, 2.90], sav: [750, 0, 1600], depthFt: 6.0, mxPct: 15 },
  { code: 'SH6', name: 'Low load humid climate shrub', type: 'static', load: [2.90, 1.45, 0, 0, 1.40], sav: [750, 0, 1600], depthFt: 2.0, mxPct: 30 },
  { code: 'SH7', name: 'Very high load dry climate shrub', type: 'static', load: [3.50, 5.30, 2.20, 0, 3.40], sav: [750, 0, 1600], depthFt: 6.0, mxPct: 15 },
  { code: 'SH8', name: 'High load humid climate shrub', type: 'static', load: [2.05, 3.40, 0.85, 0, 4.35], sav: [750, 0, 1600], depthFt: 3.0, mxPct: 40 },
  { code: 'SH9', name: 'Very high load humid climate shrub', type: 'dynamic', load: [4.50, 2.45, 0, 1.55, 7.05], sav: [750, 1800, 1500], depthFt: 4.4, mxPct: 40 },
  // --- TU: timber-understorey --------------------------------------------------------------
  { code: 'TU1', name: 'Light load dry climate timber-grass-shrub', type: 'dynamic', load: [0.20, 0.90, 1.50, 0.20, 0.90], sav: [2000, 1800, 1600], depthFt: 0.6, mxPct: 20 },
  { code: 'TU2', name: 'Moderate load humid climate timber-shrub', type: 'static', load: [0.95, 1.80, 1.25, 0, 0.20], sav: [2000, 0, 1600], depthFt: 1.0, mxPct: 30 },
  { code: 'TU3', name: 'Moderate load humid climate timber-grass-shrub', type: 'dynamic', load: [1.10, 0.15, 0.25, 0.65, 1.10], sav: [1800, 1600, 1400], depthFt: 1.3, mxPct: 30 },
  { code: 'TU4', name: 'Dwarf conifer with understory', type: 'static', load: [4.50, 0, 0, 0, 2.00], sav: [2300, 0, 2000], depthFt: 0.5, mxPct: 12 },
  { code: 'TU5', name: 'Very high load dry climate timber-shrub', type: 'static', load: [4.00, 4.00, 3.00, 0, 3.00], sav: [1500, 0, 750], depthFt: 1.0, mxPct: 25 },
  // --- TL: timber litter -------------------------------------------------------------------
  { code: 'TL1', name: 'Low load compact conifer litter', type: 'static', load: [1.00, 2.20, 3.60, 0, 0], sav: [2000, 0, 0], depthFt: 0.2, mxPct: 30 },
  { code: 'TL2', name: 'Low load broadleaf litter', type: 'static', load: [1.40, 2.30, 2.20, 0, 0], sav: [2000, 0, 0], depthFt: 0.2, mxPct: 25 },
  { code: 'TL3', name: 'Moderate load confier litter', type: 'static', load: [0.50, 2.20, 2.80, 0, 0], sav: [2000, 0, 0], depthFt: 0.3, mxPct: 20 },
  { code: 'TL4', name: 'Small downed logs', type: 'static', load: [0.50, 1.50, 4.20, 0, 0], sav: [2000, 0, 0], depthFt: 0.4, mxPct: 25 },
  { code: 'TL5', name: 'High load conifer litter', type: 'static', load: [1.15, 2.50, 4.40, 0, 0], sav: [2000, 0, 1600], depthFt: 0.6, mxPct: 25 },
  { code: 'TL6', name: 'Moderate load broadleaf litter', type: 'static', load: [2.40, 1.20, 1.20, 0, 0], sav: [2000, 0, 0], depthFt: 0.3, mxPct: 25 },
  { code: 'TL7', name: 'Large downed logs', type: 'static', load: [0.30, 1.40, 8.10, 0, 0], sav: [2000, 0, 0], depthFt: 0.4, mxPct: 25 },
  { code: 'TL8', name: 'Long-needle litter', type: 'static', load: [5.80, 1.40, 1.10, 0, 0], sav: [1800, 0, 0], depthFt: 0.3, mxPct: 35 },
  { code: 'TL9', name: 'Very high load broadleaf litter', type: 'static', load: [6.65, 3.30, 4.15, 0, 0], sav: [1800, 0, 1600], depthFt: 0.6, mxPct: 35 },
  // --- SB: slash-blowdown ------------------------------------------------------------------
  { code: 'SB1', name: 'Low load activity fuel', type: 'static', load: [1.50, 3.00, 11.00, 0, 0], sav: [2000, 0, 0], depthFt: 1.0, mxPct: 25 },
  { code: 'SB2', name: 'Moderate load activity or low load blowdown', type: 'static', load: [4.50, 4.25, 4.00, 0, 0], sav: [2000, 0, 0], depthFt: 1.0, mxPct: 25 },
  { code: 'SB3', name: 'High load activity fuel or moderate load blowdown', type: 'static', load: [5.50, 2.75, 3.00, 0, 0], sav: [2000, 0, 0], depthFt: 1.2, mxPct: 25 },
  { code: 'SB4', name: 'High load blowdown', type: 'static', load: [5.25, 3.50, 5.25, 0, 0], sav: [2000, 0, 0], depthFt: 2.7, mxPct: 25 },
]

/**
 * Anderson (1982) INT-122, the original 13. All static, all 8000 BTU/lb, live SAV 1500 ft^-1.
 * Model 2's live load is herbaceous; 4, 5, 7 and 10 carry it as live woody.
 */
const ANDERSON_ROWS: readonly PublishedRow[] = [
  { code: 'FM1', name: 'Short grass (1 ft)', type: 'static', load: [0.74, 0, 0, 0, 0], sav: [3500, 1500, 1500], depthFt: 1.0, mxPct: 12 },
  { code: 'FM2', name: 'Timber grass and understory', type: 'static', load: [2.00, 1.00, 0.50, 0.50, 0], sav: [3000, 1500, 1500], depthFt: 1.0, mxPct: 15 },
  { code: 'FM3', name: 'Tall grass (2.5 ft)', type: 'static', load: [3.01, 0, 0, 0, 0], sav: [1500, 1500, 1500], depthFt: 2.5, mxPct: 25 },
  { code: 'FM4', name: 'Chaparral (6 ft)', type: 'static', load: [5.01, 4.01, 2.00, 0, 5.01], sav: [2000, 1500, 1500], depthFt: 6.0, mxPct: 20 },
  { code: 'FM5', name: 'Brush (2 ft)', type: 'static', load: [1.00, 0.50, 0, 0, 2.00], sav: [2000, 1500, 1500], depthFt: 2.0, mxPct: 20 },
  { code: 'FM6', name: 'Dormant brush, hardwood slash', type: 'static', load: [1.50, 2.50, 2.00, 0, 0], sav: [1750, 1500, 1500], depthFt: 2.5, mxPct: 25 },
  { code: 'FM7', name: 'Southern rough', type: 'static', load: [1.13, 1.87, 1.50, 0, 0.37], sav: [1750, 1500, 1500], depthFt: 2.5, mxPct: 40 },
  { code: 'FM8', name: 'Closed timber litter', type: 'static', load: [1.50, 1.00, 2.50, 0, 0], sav: [2000, 1500, 1500], depthFt: 0.2, mxPct: 30 },
  { code: 'FM9', name: 'Hardwood litter', type: 'static', load: [2.92, 0.41, 0.15, 0, 0], sav: [2500, 1500, 1500], depthFt: 0.2, mxPct: 25 },
  { code: 'FM10', name: 'Timber (litter and understory)', type: 'static', load: [3.01, 2.00, 5.01, 0, 2.00], sav: [2000, 1500, 1500], depthFt: 1.0, mxPct: 25 },
  { code: 'FM11', name: 'Light logging slash', type: 'static', load: [1.50, 4.51, 5.51, 0, 0], sav: [1500, 1500, 1500], depthFt: 1.0, mxPct: 15 },
  { code: 'FM12', name: 'Medium logging slash', type: 'static', load: [4.01, 14.03, 16.53, 0, 0], sav: [1500, 1500, 1500], depthFt: 2.3, mxPct: 20 },
  { code: 'FM13', name: 'Heavy logging slash', type: 'static', load: [7.01, 23.04, 28.05, 0, 0], sav: [1500, 1500, 1500], depthFt: 3.0, mxPct: 25 },
]

/**
 * The UK set, spec §60 §7.3.2. Natively SI.
 *
 * Two mapping decisions, both recorded in `UK_FUELS.openQuestions`:
 *  - Where §7.3.2 gives a range, the midpoint is used.
 *  - The moss/litter layer occupies the dead 10-h slot but keeps the row's own assigned SAV,
 *    because the 109 ft^-1 Scott & Burgan constant would erase its surface-area contribution
 *    and reproduce exactly the under-prediction §7.3.2 warns about.
 *
 * Every row carries one SAV because that is what the source gives: a single assigned band per
 * fuel, not a per-class inventory.
 */
interface UkRow {
  readonly code: string
  readonly name: string
  readonly type: FuelModelType
  /** kg/m^2: fine dead (1-h), moss/litter (10-h slot), live */
  readonly fineDead: number
  readonly mossLitter: number
  readonly live: number
  readonly liveClass: 'liveHerb' | 'liveWoody'
  readonly depthM: number
  readonly savPerM: number
  readonly mxPct: number
}

const UK_ROWS: readonly UkRow[] = [
  { code: 'UK-CALLUNA-PIONEER', name: 'Calluna heather, pioneer (0-6 yr)', type: 'static', fineDead: 0.055, mossLitter: 0.25, live: 0.20, liveClass: 'liveWoody', depthM: 0.15, savPerM: 6000, mxPct: 30 },
  { code: 'UK-CALLUNA-EARLY-BUILDING', name: 'Calluna heather, early building (7-10 yr)', type: 'static', fineDead: 0.141, mossLitter: 0.50, live: 0.624, liveClass: 'liveWoody', depthM: 0.187, savPerM: 6000, mxPct: 30 },
  { code: 'UK-CALLUNA-TALL-BUILDING', name: 'Calluna heather, tall building (10-14 yr)', type: 'static', fineDead: 0.212, mossLitter: 0.761, live: 0.259, liveClass: 'liveWoody', depthM: 0.381, savPerM: 5500, mxPct: 30 },
  { code: 'UK-CALLUNA-MATURE', name: 'Calluna heather, mature (14-20 yr)', type: 'static', fineDead: 0.220, mossLitter: 1.019, live: 1.214, liveClass: 'liveWoody', depthM: 0.557, savPerM: 5000, mxPct: 30 },
  { code: 'UK-CALLUNA-DEGENERATE', name: 'Calluna heather, degenerate (>21 yr)', type: 'static', fineDead: 0.35, mossLitter: 1.25, live: 1.40, liveClass: 'liveWoody', depthM: 0.65, savPerM: 5000, mxPct: 30 },
  { code: 'UK-BRACKEN-LITTER', name: 'Bracken, cured litter (spring/autumn)', type: 'static', fineDead: 0.75, mossLitter: 0.20, live: 0, liveClass: 'liveHerb', depthM: 0.20, savPerM: 7500, mxPct: 20 },
  { code: 'UK-BRACKEN-GREEN', name: 'Bracken, green fronds (Jun-Sep)', type: 'static', fineDead: 0.10, mossLitter: 0, live: 0.70, liveClass: 'liveHerb', depthM: 1.30, savPerM: 7500, mxPct: 20 },
  { code: 'UK-MOLINIA-CURED', name: 'Molinia, cured (Dec-Apr)', type: 'static', fineDead: 0.85, mossLitter: 0.20, live: 0, liveClass: 'liveHerb', depthM: 0.45, savPerM: 9500, mxPct: 25 },
  { code: 'UK-PASTURE-GRAZED', name: 'Improved pasture, grazed', type: 'dynamic', fineDead: 0.06, mossLitter: 0, live: 0.30, liveClass: 'liveHerb', depthM: 0.10, savPerM: 9500, mxPct: 15 },
  { code: 'UK-CEREAL-STUBBLE', name: 'Cereal stubble', type: 'static', fineDead: 0.30, mossLitter: 0, live: 0, liveClass: 'liveHerb', depthM: 0.25, savPerM: 10000, mxPct: 15 },
  { code: 'UK-CEREAL-STANDING', name: 'Standing cereal, ripe', type: 'dynamic', fineDead: 0.45, mossLitter: 0, live: 0.30, liveClass: 'liveHerb', depthM: 1.00, savPerM: 10000, mxPct: 20 },
  { code: 'UK-BROADLEAF-LITTER', name: 'Broadleaf litter (oak/beech/ash)', type: 'static', fineDead: 0.55, mossLitter: 0.25, live: 0, liveClass: 'liveHerb', depthM: 0.055, savPerM: 5000, mxPct: 18 },
]

function fromPublished(row: PublishedRow): FuelModel {
  const [w1, w10, w100, wHerb, wWoody] = row.load
  const [sav1, savHerb, savWoody] = row.sav
  return {
    code: row.code,
    name: row.name,
    type: row.type,
    load: {
      dead1h: tonsPerAcreToKgM2(w1),
      dead10h: tonsPerAcreToKgM2(w10),
      dead100h: tonsPerAcreToKgM2(w100),
      liveHerb: tonsPerAcreToKgM2(wHerb),
      liveWoody: tonsPerAcreToKgM2(wWoody),
    },
    sav: {
      dead1h: fromPerFoot(asPerFoot(sav1)),
      dead10h: fromPerFoot(asPerFoot(SAV_10H_PER_FT)),
      dead100h: fromPerFoot(asPerFoot(SAV_100H_PER_FT)),
      liveHerb: fromPerFoot(asPerFoot(savHerb)),
      liveWoody: fromPerFoot(asPerFoot(savWoody)),
    },
    depth: fromFeet(asFeet(row.depthFt)),
    // The one and only percent -> fraction crossing for these rows.
    moistureOfExtinctionDead: pctToFrac(moisturePercent(row.mxPct)),
    heatContent: kJkg((row.heatBtuLb ?? DEFAULT_HEAT_BTU_LB) * FACTORS.BTULB_TO_KJKG),
  }
}

function fromUk(row: UkRow): FuelModel {
  const zero = kgm2(0)
  const sav = perM(row.savPerM)
  const live: Record<'liveHerb' | 'liveWoody', KgPerSquareMetre> = {
    liveHerb: row.liveClass === 'liveHerb' ? kgm2(row.live) : zero,
    liveWoody: row.liveClass === 'liveWoody' ? kgm2(row.live) : zero,
  }
  const liveSav: Record<'liveHerb' | 'liveWoody', PerMetre> = {
    liveHerb: row.liveClass === 'liveHerb' ? sav : perM(0),
    liveWoody: row.liveClass === 'liveWoody' ? sav : perM(0),
  }
  return {
    code: row.code,
    name: row.name,
    type: row.type,
    load: {
      dead1h: kgm2(row.fineDead),
      dead10h: kgm2(row.mossLitter),
      dead100h: zero,
      liveHerb: live.liveHerb,
      liveWoody: live.liveWoody,
    },
    sav: {
      dead1h: sav,
      dead10h: row.mossLitter > 0 ? sav : perM(0),
      dead100h: perM(0),
      liveHerb: liveSav.liveHerb,
      liveWoody: liveSav.liveWoody,
    },
    depth: m(row.depthM),
    moistureOfExtinctionDead: pctToFrac(moisturePercent(row.mxPct)),
    heatContent: kJkg(DEFAULT_HEAT_BTU_LB * FACTORS.BTULB_TO_KJKG),
  }
}

/** Gorse: SH7 with the depth reduced to the §7.3.2 lower bound (spec §4.9). */
function ukGorse(sh7: FuelModel): FuelModel {
  return {
    ...sh7,
    code: 'UK-GORSE-MATURE',
    name: 'Gorse (Ulex europaeus), mature — SH7 substitution',
    depth: m(1.5),
  }
}

const ENTRIES: FuelModel[] = [
  ...SCOTT_BURGAN_ROWS.map((r) => fromPublished(r)),
  ...ANDERSON_ROWS.map((r) => fromPublished(r)),
  ...UK_ROWS.map(fromUk),
]

const BY_CODE = new Map<string, FuelModel>(ENTRIES.map((f) => [f.code, f]))

{
  const sh7 = BY_CODE.get('SH7')
  if (sh7 === undefined) throw new Error('fuel model table: SH7 missing, gorse cannot be derived')
  const gorse = ukGorse(sh7)
  ENTRIES.push(gorse)
  BY_CODE.set(gorse.code, gorse)
}

class FuelModelTable implements IFuelModelTable {
  readonly codes: readonly string[] = ENTRIES.map((f) => f.code)

  get(code: string): FuelModel {
    const found = BY_CODE.get(code)
    if (found === undefined) throw new Error(`unknown fuel model '${code}'`)
    return found
  }

  has(code: string): boolean {
    return BY_CODE.has(code)
  }
}

/**
 * `fuelModelId` 0. A zeroed surface grid is non-burnable, not grassland — the whole reason the
 * id is reserved rather than being the first real model.
 */
export const NON_BURNABLE_ID = 0

/** The five size classes in the order the GPU state buffer and the LUT store them. */
export const FUEL_SIZE_CLASS_ORDER: readonly FuelSizeClass[] = [
  'dead1h',
  'dead10h',
  'dead100h',
  'liveHerb',
  'liveWoody',
]

export const FUEL_MODELS: IFuelModelTable = new FuelModelTable()

/** All entries, for sweeps and for the HUD's model picker. */
export const ALL_FUEL_MODELS: readonly FuelModel[] = ENTRIES

/**
 * Anderson-13 to Scott & Burgan correspondences for authoring convenience (spec §4.3).
 * These are *not* equivalences — they are the nearest-behaviour suggestions from the source.
 */
export const ANDERSON_TO_SB: Readonly<Record<string, readonly string[]>> = {
  FM1: ['GR1', 'GR2'],
  FM2: ['GS1'],
  FM3: ['GR4', 'GR7'],
  FM4: ['SH5', 'SH7'],
  FM5: ['SH2'],
  FM8: ['TL2', 'TL3'],
  FM9: ['TL8', 'TL9'],
  FM10: ['TU5'],
  FM11: ['SB1'],
  FM12: ['SB2'],
  FM13: ['SB3'],
}
