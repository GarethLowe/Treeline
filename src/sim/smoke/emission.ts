/**
 * Smoke source terms — WP 4.1's half of the froxel pipeline that is physics rather than
 * plumbing, and therefore testable without a GPU.
 *
 * The renderer (§7.1.2) needs three fields over the domain: total dry smoke aerosol mass
 * concentration ρ_s, the composition scalar f = m_EC/(m_EC + m_OC), and gas temperature. This
 * module owns what *creates* them; `field.ts` owns advecting them.
 *
 * ## Two masses, never a ratio
 *
 * f is carried as **elemental-carbon mass alongside total mass**, and the ratio is formed at
 * sample time. §7.1.2 is explicit that mass-averaging ω₀ is wrong because it is a ratio; the
 * same argument applies one level up to f itself the moment two parcels of different
 * composition mix. Two extensive quantities advect correctly under any transport scheme; their
 * quotient does not.
 *
 * ## Status
 *
 * The composition endmembers are the spec's, traced to Reid et al. (2005) §2.4 p. 834. The
 * **soot yield is `estimated`** — see `SMOKE_YIELD_PROVENANCE`. It scales the whole plume's
 * opacity linearly, so it is the first number to check against a photograph and the first to
 * replace with a sourced figure.
 */

import { FUEL_SIZE_CLASSES } from '@contracts/sim'
import type { CellBurnoutModel } from '@sim/burnout/consumption.ts'

/**
 * Total dry smoke PM emitted per kg of fuel consumed, kg/kg.
 *
 * Biomass-burning PM2.5 emission factors are conventionally quoted in g/kg: roughly 5–8 for
 * savanna and grass and 13–18 for extratropical forest with duff, the spread driven by how
 * much of the burn is smouldering. 0.013 is the extratropical-forest end of that band and is
 * what the shipping conifer world should use.
 *
 * **`estimated`.** The band above is recalled, not read: no page-cited primary source was
 * consulted for it in this session, and project policy (§0.7) forbids treating a constant that
 * way as anything better. It enters the rendered image linearly — double it and the plume is
 * twice as opaque — so it is a calibration knob with a physical name, not a measurement.
 */
export const SOOT_YIELD_FLAMING = 0.013
/** Smouldering combustion emits several times more particulate per kg than flaming does. */
export const SOOT_YIELD_SMOULDERING = 0.030

/**
 * f = m_EC/(m_EC + m_OC) at the source, by combustion regime.
 *
 * Spec §7.1.2, from Reid et al. (2005) §2.4 p. 834: flaming-dominated smoke has ω₀(550) ≈ 0.75
 * and smouldering-dominated ≈ 0.90; inverted through the Pokhrel et al. (2016) 532 nm fit those
 * are f = 0.22 and f = 0.08.
 */
export const F_FLAMING = 0.22
export const F_SMOULDERING = 0.08

/**
 * Heat of combustion of dry wildland fuel, J/kg. The same 18 600 kJ/kg the Rothermel kernel
 * uses for its low heat content, so the smoke field's temperature source and the surface
 * spread model cannot disagree about how much energy a kilogram releases.
 */
export const HEAT_OF_COMBUSTION = 18.6e6

/** Fraction of released heat that goes into the convective column rather than radiating away. */
export const CONVECTIVE_FRACTION = 0.65

/**
 * Mass loss rate of a cell at `sinceArrival` seconds after the front passed, kg m⁻² s⁻¹.
 *
 * The analytic derivative of the burnout curve WP 2.4 already integrates, so the smoke source
 * and the fuel consumption cannot drift apart. Taking a finite difference of `consumedTexture`
 * between frames would need a second copy of a 4 MiB field and would put the source one frame
 * behind the fuel it came from.
 */
export function massLossRate(model: CellBurnoutModel, sinceArrival: number): number {
  if (!(sinceArrival > 0)) return 0
  let rate = 0
  for (const c of FUEL_SIZE_CLASSES) {
    const load = model.load[c]
    if (load <= 0) continue
    const invTau = 1 / model.tau[c]
    rate += load * invTau * Math.exp(-invTau * sinceArrival)
  }
  return rate
}

/**
 * Split a cell's mass loss between flaming and smouldering.
 *
 * Flaming lasts for the bed's residence time; everything after it is smouldering. That is the
 * same boundary WP 2.4 uses to label a cell BURNING or BURNT, so the renderer's composition
 * field and the HUD's lifecycle state change regime at the same instant rather than at two
 * thresholds that drift apart.
 */
export function flamingFraction(model: CellBurnoutModel, sinceArrival: number): number {
  return sinceArrival < model.residenceTime ? 1 : 0
}

export interface SmokeSource {
  /** Total dry smoke PM, kg m⁻² s⁻¹. */
  readonly totalMassRate: number
  /** Elemental-carbon component of the above, kg m⁻² s⁻¹. Advected separately; see the header. */
  readonly ecMassRate: number
  /** Convective heat release, W m⁻². */
  readonly heatRate: number
}

/** The three source terms a burning surface cell injects into the smoke field. */
export function smokeSource(model: CellBurnoutModel, sinceArrival: number): SmokeSource {
  const loss = massLossRate(model, sinceArrival)
  if (loss <= 0) return { totalMassRate: 0, ecMassRate: 0, heatRate: 0 }
  const flaming = flamingFraction(model, sinceArrival)
  const yieldKgKg = flaming * SOOT_YIELD_FLAMING + (1 - flaming) * SOOT_YIELD_SMOULDERING
  const f = flaming * F_FLAMING + (1 - flaming) * F_SMOULDERING
  const total = loss * yieldKgKg
  return {
    totalMassRate: total,
    ecMassRate: total * f,
    heatRate: loss * HEAT_OF_COMBUSTION * CONVECTIVE_FRACTION,
  }
}

/**
 * Composition of a mixed parcel. The whole reason both masses are carried.
 *
 * Returns the flaming endmember for an empty parcel rather than 0: f = 0 would claim pure
 * organic carbon, which is the most-scattering, brightest smoke there is, and painting empty
 * air with it is the wrong way to be wrong.
 */
export function compositionOf(totalMass: number, ecMass: number): number {
  if (!(totalMass > 0)) return F_FLAMING
  return Math.min(1, Math.max(0, ecMass / totalMass))
}



