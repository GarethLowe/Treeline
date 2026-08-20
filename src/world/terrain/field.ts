/**
 * `ITerrainField` — the object every other package sees.
 *
 * Split deliberately in two:
 *
 * - `TerrainQueries` is the whole CPU side, and holds no GPU handle. That is what lets the
 *   pure logic (the part where correctness actually lives) be unit-tested on the CLI, and
 *   what lets a Web Worker generate a world without a device.
 * - `TerrainField` adds the two textures and satisfies the contract.
 *
 * The queries return branded units per spec §0.6: metres, a slope *tangent* (not an angle —
 * `tan phi` is what the spread model consumes, so converting to degrees and back would only
 * create opportunities to lose the convention), and an aspect in radians.
 */

import type { ITerrainField, TerrainParams } from '@contracts/world'
import type { Metres, Radians, SlopeTangent } from '@contracts/units'
import { m, rad, slopeTan } from '@contracts/units'
import type { Heightfield } from './heightfield.ts'
import { generateTerrain, type TerrainGenOptions, type TerrainGeneration } from './generate.ts'

/** The device-free half of `ITerrainField`. */
export type TerrainQueries = Pick<
  ITerrainField,
  'params' | 'heightAt' | 'normalAt' | 'slopeAt' | 'aspectAt' | 'minElevationM' | 'maxElevationM'
>

export class TerrainQueryField implements TerrainQueries {
  readonly params: TerrainParams
  readonly minElevationM: Metres
  readonly maxElevationM: Metres
  /** Generation record: stats, timings, diagnostics, packed texels, flow accumulation. */
  readonly generation: TerrainGeneration
  protected readonly heights: Heightfield

  constructor(generation: TerrainGeneration) {
    this.generation = generation
    this.heights = generation.field
    this.params = generation.params
    this.minElevationM = m(generation.stats.minM)
    this.maxElevationM = m(generation.stats.maxM)
  }

  heightAt(x: Metres, z: Metres): Metres {
    return m(this.heights.heightAt(x, z))
  }

  normalAt(x: Metres, z: Metres): readonly [number, number, number] {
    return this.heights.normalAt(x, z)
  }

  slopeAt(x: Metres, z: Metres): SlopeTangent {
    return slopeTan(this.heights.slopeAt(x, z))
  }

  aspectAt(x: Metres, z: Metres): Radians {
    return rad(this.heights.aspectAt(x, z))
  }
}

/** The full contract object. Textures are owned by this instance; `destroy()` releases them. */
export class TerrainField extends TerrainQueryField implements ITerrainField {
  readonly heightTexture: GPUTexture
  readonly slopeAspectTexture: GPUTexture

  constructor(generation: TerrainGeneration, heightTexture: GPUTexture, slopeAspectTexture: GPUTexture) {
    super(generation)
    this.heightTexture = heightTexture
    this.slopeAspectTexture = slopeAspectTexture
  }

  destroy(): void {
    this.heightTexture.destroy()
    this.slopeAspectTexture.destroy()
  }
}

/** Generate on the CPU only. No device needed. */
export function generateTerrainQueries(
  params: TerrainParams,
  seed: number,
  options?: TerrainGenOptions,
): TerrainQueryField {
  return new TerrainQueryField(generateTerrain(params, seed, options))
}
