/**
 * Foliage renderer configuration.
 *
 * Every number here is a knob the M4 measurement pass is expected to move. Spec §7.4
 * carries an OPEN QUESTION against its own timing figures: the 1.2 ms grass line item is
 * argued from triangle throughput, but grass is alpha-tested foliage whose cost is fill and
 * overdraw, not triangle setup. So the defaults below are chosen to make the *fill* bound
 * controllable — blade count falls with distance in discrete bands, and blade width rises
 * to compensate so apparent cover is preserved while shaded fragments fall — and every one
 * of them is exposed rather than baked into a shader.
 */

import type { Metres, Radians } from '@contracts/units'

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** LOD chain depth. Spec §7.4: L0 full, L1 reduced, L2 branch cards, L3 octahedral impostor. */
export const LOD_COUNT = 4

/**
 * Upper bound on (mesh x LOD) buckets. The bucket scan runs in a single workgroup of 256
 * invocations handling 4 buckets each, so this is a hard structural limit, not a guess.
 * Spec §7.4 budgets 14 species x 4 LODs = 56; the cache in `ITreeMeshSet` keys on
 * (species, quantised parameters) so the real figure is higher, hence the headroom.
 */
export const MAX_BUCKETS = 1024

/** Invocations per workgroup in the cull passes. */
export const CULL_WORKGROUP_SIZE = 256
/** Invocations per workgroup in the single-workgroup bucket scan. Must match MAX_BUCKETS/4. */
export const SCAN_WORKGROUP_SIZE = 256

/**
 * LOD thresholds, expressed as **projected screen height in pixels**, descending.
 *
 * Screen height rather than raw distance because it is the quantity that actually decides
 * whether detail is visible, and it stays correct when the resolution scale moves under the
 * quality controller (a half-resolution frame should take coarser LODs at the same distance).
 *
 * Calibration: these reproduce spec §7.4's distance table for its reference case — a 22 m
 * conifer at 1440p with a 60 degree vertical FOV, where projected height is
 * `22 * 1440 / (2 * tan(30 deg) * d) = 27441 / d` pixels:
 *   - 20 m  -> 1372 px  (L0/L1 boundary)
 *   - 60 m  ->  457 px  (L1/L2 boundary)
 *   - 150 m ->  183 px  (L2/L3 boundary)
 */
export const DEFAULT_LOD_THRESHOLDS_PX: readonly [number, number, number] = [1372, 457, 183]

/**
 * Cross-fade width as a fraction of each threshold. An instance inside the window is
 * appended to BOTH adjacent LOD buckets, with complementary dither weights, so the switch
 * is a dissolve rather than a pop. 0.18 at the L2/L3 boundary is ~15 m of travel for the
 * reference tree, matching spec §7.4's "cross-fade over 15 m".
 */
export const DEFAULT_LOD_FADE_FRACTION = 0.18

// ---------------------------------------------------------------------------
// Grass
// ---------------------------------------------------------------------------

/**
 * Vertices emitted per blade in the triangle-strip stream.
 *
 * Spec §7.4 specifies 8 vertices per blade (3 segments + tip). Because one draw instance is
 * a whole tile of blades, consecutive blades must be separated by degenerate triangles, so
 * the stride is 8 + 2 = 10 and the first two vertices of every blade duplicate its base.
 * That costs 2 degenerate triangles per blade, which are discarded at setup and rasterise
 * nothing — irrelevant against the fill bound this pass actually lives under.
 */
export const GRASS_VERTS_PER_BLADE = 10

/** Invocations per workgroup in the grass tile cull. */
export const GRASS_CULL_WORKGROUP_SIZE = 64

export interface GrassParams {
  /** Peak blade density near the camera. Spec §7.4: 400 blades/m2. */
  readonly densityPerM2: number
  /** Distance at which density starts falling. Spec §7.4 `d0` = 12 m. */
  readonly falloffStartM: Metres
  /** Distance at which density reaches zero and the ground shell takes over. Spec `d1` = 45 m. */
  readonly falloffEndM: Metres
  /** Side length of a grass tile. One draw instance is one tile. */
  readonly tileSizeM: Metres
  /**
   * Distance band edges, ascending, first entry 0 and last entry equal to `falloffEndM`.
   * One indirect draw per band; the band's blade-slot count is fixed by the density at its
   * NEAR edge so no tile in the band is truncated. More bands means less vertex-shader
   * waste and more draw calls; four is the measured-later default.
   */
  readonly bandEdgesM: readonly Metres[]
  /** Blade height range, sampled per blade from its hash. */
  readonly bladeHeightM: readonly [Metres, Metres]
  /** Blade width at the base, before distance compensation. */
  readonly bladeWidthM: Metres
  /**
   * How strongly blade width grows to compensate for thinning. 1.0 preserves apparent
   * cover exactly (width scales as 1/sqrt(density ratio)); 0 disables compensation. Above
   * ~1 the far field starts to look like a lawn of ribbons, so it is clamped in use.
   */
  readonly widthCompensation: number
  /** Fraction of `falloffEndM` over which blades fade out into the ground shell. */
  readonly outerFadeFraction: number
}

export const DEFAULT_GRASS: GrassParams = {
  densityPerM2: 400,
  falloffStartM: 12 as Metres,
  falloffEndM: 45 as Metres,
  tileSizeM: 4 as Metres,
  bandEdgesM: [0, 20, 28, 36, 45] as unknown as readonly Metres[],
  bladeHeightM: [0.18, 0.55] as unknown as readonly [Metres, Metres],
  bladeWidthM: 0.012 as Metres,
  widthCompensation: 1.0,
  outerFadeFraction: 0.15,
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

/**
 * Wind driving foliage animation.
 *
 * M1 synthesises this from a time-varying analytic field. At M5 the real terrain-modified
 * wind field (spec §50, WP 5.4) drives it instead. It is a settable uniform rather than a
 * shader constant precisely so that handover does not have to reopen `IFoliageRenderer`.
 */
export interface WindState {
  /** Direction the wind blows TOWARDS, radians clockwise from north (+Z). */
  readonly directionRad: Radians
  /** Mean speed at blade height. */
  readonly speedMps: number
  /** 0 = steady, 1 = strongly gusty. Modulates the synthetic gust envelope. */
  readonly gustiness: number
}

export const DEFAULT_WIND: WindState = {
  directionRad: 0 as Radians,
  speedMps: 3.5,
  gustiness: 0.35,
}

// ---------------------------------------------------------------------------
// Alpha strategy
// ---------------------------------------------------------------------------

/**
 * How alpha-tested foliage resolves partial coverage.
 *
 * - `alpha-to-coverage` needs `sampleCount > 1` and gives genuinely smooth edges for free,
 *   but multiplies the fill cost that already bounds this pass.
 * - `dither` discards against a screen-space hash. Single-sampled, cheapest, and the
 *   correct choice when TAA is resolving the noise — which it is from M4 onward.
 *
 * The renderer picks `dither` unless `sampleCount > 1`, and never silently enables
 * alpha-to-coverage on a single-sampled target because that is a validation error.
 */
export type AlphaStrategy = 'dither' | 'alpha-to-coverage'

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface FoliageConfig {
  /** Colour attachment formats of the pass `draw()` will be called inside. */
  readonly colorFormats: readonly GPUTextureFormat[]
  readonly depthFormat: GPUTextureFormat
  /** MSAA sample count of that pass. Must match, or pipeline creation fails. */
  readonly sampleCount: number
  /**
   * Depth comparison. Exposed rather than assumed: whether the project ends up on a standard
   * or a reversed depth buffer is a decision for the frame assembly (WP 1.1), and a foliage
   * pass that hardcodes 'less' against a reverse-Z depth buffer draws nothing at all.
   */
  readonly depthCompare: GPUCompareFunction
  readonly depthWriteEnabled: boolean
  /** Viewport height in physical pixels, before `QualitySettings.resolutionScale`. */
  readonly viewportHeightPx: number
  readonly lodThresholdsPx: readonly [number, number, number]
  readonly lodFadeFraction: number
  readonly grass: GrassParams
  readonly alphaStrategy: AlphaStrategy | 'auto'
  /** Alpha cutoff for foliage cards. */
  readonly alphaCutoff: number
  /**
   * Trust `CameraState.frustumPlanes` instead of re-deriving planes from `viewProjMatrix`.
   *
   * Default false. The contract declares `frustumPlanes` as a `Float32Array` but fixes
   * neither the plane ordering, the sign convention, nor whether the normals are
   * normalised, and a sign error there culls the entire world with no error message. Until
   * WP 1.8 documents a convention, deriving them here from a matrix whose convention IS
   * pinned (Gribb & Hartmann, see `cullMath.ts`) is the defensible default.
   */
  readonly useCameraFrustumPlanes: boolean
  /** Enable the `subgroups` fast path in the cull compaction. Falls back automatically. */
  readonly useSubgroups: boolean
  /** Render grass at all. Off is a useful A/B for the fill-bound measurement in M4. */
  readonly enableGrass: boolean
  /** Frames between GPU stats readbacks. Never maps a buffer written this frame. */
  readonly statsLatencyFrames: number
}

export const DEFAULT_FOLIAGE_CONFIG: FoliageConfig = {
  colorFormats: ['rgba16float'],
  depthFormat: 'depth32float',
  sampleCount: 1,
  depthCompare: 'less',
  depthWriteEnabled: true,
  viewportHeightPx: 1440,
  lodThresholdsPx: DEFAULT_LOD_THRESHOLDS_PX,
  lodFadeFraction: DEFAULT_LOD_FADE_FRACTION,
  grass: DEFAULT_GRASS,
  alphaStrategy: 'auto',
  alphaCutoff: 0.4,
  useCameraFrustumPlanes: false,
  useSubgroups: true,
  enableGrass: true,
  statsLatencyFrames: 3,
}

/** Resolve `'auto'` against the sample count. Exposed so the choice is testable. */
export function resolveAlphaStrategy(
  strategy: AlphaStrategy | 'auto',
  sampleCount: number,
): AlphaStrategy {
  if (strategy === 'alpha-to-coverage' || (strategy === 'auto' && sampleCount > 1)) {
    // Alpha-to-coverage on a single-sampled target is a WebGPU validation error, not a
    // no-op. Downgrade rather than fail pipeline creation.
    return sampleCount > 1 ? 'alpha-to-coverage' : 'dither'
  }
  return 'dither'
}
