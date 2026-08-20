/**
 * Grass field mathematics, in TypeScript.
 *
 * As with `cullMath.ts`, this is the normative reference that `shaders/foliage/grassCull.wgsl`
 * and `grassDraw.wgsl` transliterate, and the oracle the GPU is checked against.
 *
 * THE DESIGN DECISION THIS FILE ENCODES. Spec §7.4 draws grass density from
 * `rho(d) = rho0 * clamp((d1 - d)/(d1 - d0), 0, 1)` and then argues the pass cost from
 * triangle throughput. Its own OPEN QUESTION says that argument counts the wrong bound:
 * alpha-tested grass is fill and overdraw limited, and a triangle count says nothing about
 * either. So the thinning here is built to control *shaded fragments*, and to be countable
 * exactly rather than estimated:
 *
 *   - The field is diced into tiles. One draw instance is one tile.
 *   - Tiles are grouped into distance BANDS. A band issues one indirect draw whose vertex
 *     count is fixed by the density at the band's NEAR edge, so no tile in the band is
 *     truncated.
 *   - Within a tile, blade slots above `activeSlots(tileDistance)` collapse to a degenerate
 *     triangle in the vertex shader. Blade positions are hashed from the slot index, so
 *     dropping the high slots removes a spatially uniform random subset — thinning without
 *     structure, and with no per-blade branch on a hash comparison.
 *   - Because the cutoff is per tile rather than per blade, the number of blades actually
 *     rasterised is a deterministic function of the visible tile set. The cull pass sums it
 *     and `FoliageStats.grassBladesDrawn` reports that sum, not an estimate.
 *   - Blade width grows as density falls, so apparent cover is roughly preserved while the
 *     number of shaded fragments falls. That is the knob that actually moves a fill bound.
 */

import { GRASS_MAX_BANDS } from './layout.ts'
import { GRASS_VERTS_PER_BLADE, type GrassParams } from './config.ts'
import { sphereInFrustum } from './cullMath.ts'
import { DOMAIN_SIZE_M } from '@contracts/world'

/** Spec §7.4 density falloff. Blades per square metre at horizontal distance `d`. */
export function grassDensityAt(distanceM: number, p: GrassParams): number {
  const d0 = p.falloffStartM as number
  const d1 = p.falloffEndM as number
  if (d1 <= d0) return distanceM <= d1 ? p.densityPerM2 : 0
  const t = (d1 - distanceM) / (d1 - d0)
  return p.densityPerM2 * Math.min(Math.max(t, 0), 1)
}

export function bandCount(p: GrassParams): number {
  return Math.max(0, p.bandEdgesM.length - 1)
}

/** Band containing `distanceM`, or -1 if beyond the last edge. Bands are `[near, far)`. */
export function bandOf(distanceM: number, p: GrassParams): number {
  const edges = p.bandEdgesM
  for (let b = 0; b < edges.length - 1; b++) {
    const near = edges[b] as number
    const far = edges[b + 1] as number
    if (distanceM >= near && distanceM < far) return b
  }
  // The far edge itself belongs to the last band, so a tile sitting exactly on d1 is drawn
  // (with zero active slots) rather than falling through the crack between "in a band" and
  // "beyond the field".
  const last = edges[edges.length - 1]
  if (last !== undefined && distanceM === last && edges.length >= 2) return edges.length - 2
  return -1
}

export function tileAreaM2(p: GrassParams): number {
  return (p.tileSizeM as number) * (p.tileSizeM as number)
}

/**
 * Blade slots a band's draw allocates per tile — the density at the band's near edge, which
 * is the highest density any tile in the band can want.
 */
export function bladeSlotsForBand(band: number, p: GrassParams): number {
  const near = p.bandEdgesM[band]
  if (near === undefined) return 0
  return Math.ceil(grassDensityAt(near as number, p) * tileAreaM2(p))
}

/** Blades actually drawn by a tile at `distanceM` inside `band`. Never exceeds the band's slots. */
export function activeSlotsForTile(distanceM: number, band: number, p: GrassParams): number {
  const slots = bladeSlotsForBand(band, p)
  const want = Math.round(grassDensityAt(distanceM, p) * tileAreaM2(p))
  return Math.min(Math.max(want, 0), slots)
}

/**
 * Blade width multiplier that compensates for thinning.
 *
 * Apparent cover goes as `density * width`, so preserving it exactly means width scaling as
 * `1/densityRatio`; scaling as the square root of that is the usual compromise, since blades
 * also shrink in screen space with distance. `widthCompensation` interpolates, and the result
 * is clamped because past about 3x the far field reads as a lawn of ribbons.
 */
export const MAX_WIDTH_COMPENSATION = 3
export function bladeWidthScale(activeSlots: number, fullSlots: number, p: GrassParams): number {
  if (activeSlots <= 0 || fullSlots <= 0) return 1
  const ratio = fullSlots / activeSlots
  const wc = Math.min(Math.max(p.widthCompensation, 0), 1)
  const scale = Math.pow(ratio, 0.5 * wc)
  return Math.min(scale, MAX_WIDTH_COMPENSATION)
}

/** Alpha fade of a blade in the outermost shell, 1 = opaque, 0 = fully faded out. */
export function outerFade(distanceM: number, p: GrassParams): number {
  const d1 = p.falloffEndM as number
  const w = d1 * Math.min(Math.max(p.outerFadeFraction, 0), 1)
  if (w <= 0) return distanceM <= d1 ? 1 : 0
  return Math.min(Math.max((d1 - distanceM) / w, 0), 1)
}

// ---------------------------------------------------------------------------
// Tile grid
// ---------------------------------------------------------------------------

/** Tiles across the whole 1 km domain. */
export function domainTiles(p: GrassParams): number {
  return Math.ceil(DOMAIN_SIZE_M / (p.tileSizeM as number))
}

/** Half-width, in tiles, of the square of candidate tiles centred on the camera. */
export function tileRadius(p: GrassParams): number {
  return Math.ceil((p.falloffEndM as number) / (p.tileSizeM as number)) + 1
}

/** Side length, in tiles, of that square. This is the cull pass's dispatch extent. */
export function tileSpan(p: GrassParams): number {
  return 2 * tileRadius(p) + 1
}

/**
 * Per-band tile list capacity. The whole candidate square is a hard upper bound on any one
 * band's tile count, and the square is small (24x24 = 576 for the defaults), so bounding it
 * exactly buys nothing and a per-band cap that can be exceeded silently drops grass.
 */
export function tileCapacityPerBand(p: GrassParams): number {
  const span = tileSpan(p)
  return span * span
}

export interface GrassTile {
  readonly tileX: number
  readonly tileZ: number
  readonly band: number
  /** Horizontal distance from the camera to the tile centre. */
  readonly distanceM: number
  readonly activeSlots: number
}

export interface GrassCullResult {
  /** Visible tiles per band, in the order the GPU's atomic append would produce them modulo
   *  ordering (the GPU order is nondeterministic; only the SET and the counts are compared). */
  readonly tilesByBand: readonly GrassTile[][]
  /** Per-band indirect draw arguments: vertexCount, instanceCount, firstVertex, firstInstance. */
  readonly drawArgs: readonly (readonly [number, number, number, number])[]
  readonly bladesDrawn: number
  readonly tilesVisible: number
  readonly tilesTested: number
  /** True if any per-band capacity was hit. Surfaced, never silent. */
  readonly clamped: boolean
}

export interface GrassCullInput {
  readonly cameraX: number
  readonly cameraZ: number
  /** Frustum planes in the packed 6x4 form from `cullMath.extractFrustumPlanes`. */
  readonly planes: Float32Array
  /**
   * Vertical half-extent used for the tile's bounding sphere. Grass sits on terrain whose
   * relief inside one tile is unknown to this pass, so the sphere is inflated rather than
   * risking culling a tile that is visible over a ridge.
   */
  readonly verticalMarginM: number
  /** Ground height at the camera, used as the tile sphere's centre height. */
  readonly groundY: number
}

/**
 * CPU simulation of the grass tile cull. The GPU version does exactly this, one tile per
 * invocation, appending with an atomic.
 */
export function cullGrassTiles(input: GrassCullInput, p: GrassParams): GrassCullResult {
  const nb = bandCount(p)
  const tilesByBand: GrassTile[][] = Array.from({ length: nb }, () => [])
  const tileSize = p.tileSizeM as number
  const nTiles = domainTiles(p)
  const radius = tileRadius(p)
  const camTileX = Math.floor(input.cameraX / tileSize)
  const camTileZ = Math.floor(input.cameraZ / tileSize)
  const capacity = tileCapacityPerBand(p)
  // A tile's bounding sphere must cover its whole footprint plus blade height plus relief.
  const sphereRadius =
    Math.hypot(tileSize * 0.5, tileSize * 0.5) +
    (p.bladeHeightM[1] as number) +
    input.verticalMarginM
  let clamped = false
  let tested = 0

  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = camTileX + dx
      const tz = camTileZ + dz
      tested++
      if (tx < 0 || tz < 0 || tx >= nTiles || tz >= nTiles) continue
      const cx = (tx + 0.5) * tileSize
      const cz = (tz + 0.5) * tileSize
      const distanceM = Math.hypot(cx - input.cameraX, cz - input.cameraZ)
      const band = bandOf(distanceM, p)
      if (band < 0) continue
      const cy = input.groundY + input.verticalMarginM
      if (!sphereInFrustum(input.planes, cx, cy, cz, sphereRadius)) continue
      const list = tilesByBand[band]
      if (list === undefined) continue
      if (list.length >= capacity) {
        clamped = true
        continue
      }
      list.push({
        tileX: tx,
        tileZ: tz,
        band,
        distanceM,
        activeSlots: activeSlotsForTile(distanceM, band, p),
      })
    }
  }

  const drawArgs: [number, number, number, number][] = []
  let bladesDrawn = 0
  let tilesVisible = 0
  for (let b = 0; b < nb; b++) {
    const list = tilesByBand[b] ?? []
    const slots = bladeSlotsForBand(b, p)
    drawArgs.push([slots * GRASS_VERTS_PER_BLADE, list.length, 0, 0])
    tilesVisible += list.length
    for (const t of list) bladesDrawn += t.activeSlots
  }

  return { tilesByBand, drawArgs, bladesDrawn, tilesVisible, tilesTested: tested, clamped }
}

/** Validation of a `GrassParams`. Returns human-readable problems; empty means usable. */
export function validateGrassParams(p: GrassParams): string[] {
  const problems: string[] = []
  const edges = p.bandEdgesM
  if (edges.length < 2) problems.push('bandEdgesM needs at least two entries')
  if (bandCount(p) > GRASS_MAX_BANDS) {
    problems.push(`bandEdgesM defines ${bandCount(p)} bands, max is ${GRASS_MAX_BANDS}`)
  }
  if ((edges[0] as number | undefined) !== 0) problems.push('bandEdgesM must start at 0')
  const last = edges[edges.length - 1] as number | undefined
  if (last !== (p.falloffEndM as number)) problems.push('bandEdgesM must end at falloffEndM')
  for (let i = 1; i < edges.length; i++) {
    if ((edges[i] as number) <= (edges[i - 1] as number)) {
      problems.push(`bandEdgesM must be strictly ascending (index ${i})`)
    }
  }
  if ((p.falloffStartM as number) > (p.falloffEndM as number)) {
    problems.push('falloffStartM must not exceed falloffEndM')
  }
  if ((p.tileSizeM as number) <= 0) problems.push('tileSizeM must be positive')
  if (p.densityPerM2 < 0) problems.push('densityPerM2 must be non-negative')
  if ((p.bladeHeightM[0] as number) > (p.bladeHeightM[1] as number)) {
    problems.push('bladeHeightM must be [min, max]')
  }
  return problems
}
