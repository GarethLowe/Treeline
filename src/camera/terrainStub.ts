/**
 * Deterministic analytic terrain for WP 1.8 — spec §90.1 rule 4 ("stubs, never mocks of
 * siblings"). WP 1.2 owns the real `ITerrainField`; this file exists only so the camera
 * can be developed and, more importantly, TESTED without it.
 *
 * It is a closed-form height function with an EXACT analytic gradient, which is worth more
 * than realism here: the walker's slope handling can be checked against a known-steepest
 * point instead of against whatever the noise happened to produce. The escarpment term is
 * deliberately steeper (about 72 degrees) than anything the walker is allowed to climb, so
 * the cliff-blocking and no-tunnelling paths are actually exercised.
 *
 * NOT a stand-in for WP 1.2's output. Nothing outside src/camera may import it.
 */

import { DOMAIN_SIZE_M } from '@contracts/world'
import type { ITerrainField } from '@contracts/world'
import type { Metres, Radians, SlopeTangent } from '@contracts/units'
import { azimuthFromXZ, clamp, v3, vNormalize, type Vec3 } from './math.ts'

/**
 * The pure part of `ITerrainField` — everything the camera actually needs.
 *
 * The camera consumes this rather than `ITerrainField` itself for one reason: the full
 * interface carries two `GPUTexture`s, and requiring them would make every camera test
 * need a live adapter. `ITerrainField` is structurally assignable to `TerrainSampler`, so
 * the integrator passes WP 1.2's real field straight in with no adapter code. There is a
 * compile-time assertion of that in test/camera/terrainStub.test.ts.
 */
export interface TerrainSampler {
  heightAt(x: Metres, z: Metres): Metres
  normalAt(x: Metres, z: Metres): readonly [number, number, number]
  slopeAt(x: Metres, z: Metres): SlopeTangent
  aspectAt(x: Metres, z: Metres): Radians
}

/** Compile-time proof that the real contract satisfies the narrower one. */
export type TerrainSamplerAcceptsContract = ITerrainField extends TerrainSampler ? true : never

export interface StubTerrainParams {
  readonly seed: number
  /** Mean elevation, metres above sea level. */
  readonly baseElevationM: number
  /** Amplitude of the 512 m rolling-hill term. */
  readonly hillAmplitudeM: number
  /** Amplitude of the ~150-200 m secondary ridges. */
  readonly ridgeAmplitudeM: number
  /** Amplitude of the ~40 m surface roughness. This is what the eye-height filter removes. */
  readonly detailAmplitudeM: number
  /** Height of the north-south escarpment. */
  readonly escarpmentHeightM: number
  /** Horizontal run of the escarpment. height/run sets its slope. */
  readonly escarpmentWidthM: number
  /** X position of the escarpment's midpoint. */
  readonly escarpmentXM: number
}

export const DEFAULT_STUB_TERRAIN: StubTerrainParams = {
  seed: 1337,
  baseElevationM: 420,
  hillAmplitudeM: 55,
  ridgeAmplitudeM: 14,
  detailAmplitudeM: 3,
  escarpmentHeightM: 60,
  // A smoothstep of height H over run w has peak gradient 1.5 H / w, here 60 * 1.5 / 30 =
  // 3.0, i.e. 71.6 degrees. That is far steeper than the walker's climb limit even after
  // the hill and ridge terms subtract from it at the worst phase, so the cliff-blocking
  // path is guaranteed to be exercised rather than merely likely to be.
  escarpmentWidthM: 30,
  escarpmentXM: 704,
}

/** Wavelengths chosen mutually irrational-ish so the surface never repeats inside 1 km. */
const L_HILL = 512
const L_RIDGE_X = 197
const L_RIDGE_Z = 149
const L_DETAIL_X = 41
const L_DETAIL_Z = 37

/** Deterministic 32-bit integer hash — same seed always gives the same phases. */
const hashPhase = (seed: number, salt: number): number => {
  let h = (seed ^ (salt * 0x9e3779b9)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  return (h / 0x100000000) * Math.PI * 2
}

/**
 * Analytic terrain. `heightAt` and its gradient are exact closed forms, so `normalAt`,
 * `slopeAt` and `aspectAt` are exact too — no finite differencing, no sampling error.
 */
export class StubTerrain implements TerrainSampler {
  readonly params: StubTerrainParams
  private readonly p0: number
  private readonly p1: number
  private readonly p2: number
  private readonly p3: number

  constructor(params: Partial<StubTerrainParams> = {}) {
    this.params = { ...DEFAULT_STUB_TERRAIN, ...params }
    this.p0 = hashPhase(this.params.seed, 1)
    this.p1 = hashPhase(this.params.seed, 2)
    this.p2 = hashPhase(this.params.seed, 3)
    this.p3 = hashPhase(this.params.seed, 4)
  }

  /** Height and both partial derivatives in one evaluation. */
  sample(x: number, z: number): { h: number; dhdx: number; dhdz: number } {
    const p = this.params
    const kH = (2 * Math.PI) / L_HILL
    const kRx = (2 * Math.PI) / L_RIDGE_X
    const kRz = (2 * Math.PI) / L_RIDGE_Z
    const kDx = (2 * Math.PI) / L_DETAIL_X
    const kDz = (2 * Math.PI) / L_DETAIL_Z

    const sHx = Math.sin(kH * x + this.p0)
    const cHx = Math.cos(kH * x + this.p0)
    const cHz = Math.cos(kH * z + this.p1)
    const sHz = Math.sin(kH * z + this.p1)

    const sRx = Math.sin(kRx * x + this.p2)
    const cRx = Math.cos(kRx * x + this.p2)
    const sRz = Math.sin(kRz * z + this.p3)
    const cRz = Math.cos(kRz * z + this.p3)

    const sDx = Math.sin(kDx * x + this.p1)
    const cDx = Math.cos(kDx * x + this.p1)
    const cDz = Math.cos(kDz * z + this.p2)
    const sDz = Math.sin(kDz * z + this.p2)

    let h = p.baseElevationM
    let dhdx = 0
    let dhdz = 0

    h += p.hillAmplitudeM * sHx * cHz
    dhdx += p.hillAmplitudeM * kH * cHx * cHz
    dhdz += -p.hillAmplitudeM * kH * sHx * sHz

    h += p.ridgeAmplitudeM * sRx * sRz
    dhdx += p.ridgeAmplitudeM * kRx * cRx * sRz
    dhdz += p.ridgeAmplitudeM * kRz * sRx * cRz

    h += p.detailAmplitudeM * sDx * cDz
    dhdx += p.detailAmplitudeM * kDx * cDx * cDz
    dhdz += -p.detailAmplitudeM * kDz * sDx * sDz

    // North-south escarpment: smoothstep in x, constant in z. Analytic derivative
    // 6t(1-t)/w * H, peaking at t = 0.5 with H * 1.5 / w.
    const w = p.escarpmentWidthM
    const t = (x - (p.escarpmentXM - w / 2)) / w
    const tc = clamp(t, 0, 1)
    h += p.escarpmentHeightM * (tc * tc * (3 - 2 * tc))
    if (t > 0 && t < 1) {
      dhdx += (p.escarpmentHeightM * 6 * tc * (1 - tc)) / w
    }

    return { h, dhdx, dhdz }
  }

  heightAt(x: Metres, z: Metres): Metres {
    return this.sample(x, z).h as Metres
  }

  /** Unit normal of the height field: normalize(-dh/dx, 1, -dh/dz). */
  normalAt(x: Metres, z: Metres): readonly [number, number, number] {
    const { dhdx, dhdz } = this.sample(x, z)
    const n = vNormalize(v3(-dhdx, 1, -dhdz))
    return [n.x, n.y, n.z]
  }

  /** Slope as a TANGENT (spec §0.6 rule 4), i.e. |grad h|, not an angle. */
  slopeAt(x: Metres, z: Metres): SlopeTangent {
    const { dhdx, dhdz } = this.sample(x, z)
    return Math.hypot(dhdx, dhdz) as SlopeTangent
  }

  /**
   * Downslope azimuth, radians CLOCKWISE FROM NORTH (north = -Z, east = +X).
   * The downhill direction in world (x, z) is -grad h.
   */
  aspectAt(x: Metres, z: Metres): Radians {
    const { dhdx, dhdz } = this.sample(x, z)
    return azimuthFromXZ(-dhdx, -dhdz) as Radians
  }

  /** Horizontal gradient at a point, as a world-space (x, z) pair. Used by the walker. */
  gradientAt(x: number, z: number): { dhdx: number; dhdz: number } {
    const { dhdx, dhdz } = this.sample(x, z)
    return { dhdx, dhdz }
  }

  /** The steepest point of the default parameter set, for tests that need a known cliff. */
  get escarpmentCentreX(): number {
    return this.params.escarpmentXM
  }
}

/** Convenience: the world extent the camera clamps to. */
export const DOMAIN_M = DOMAIN_SIZE_M

/** A world-space direction from a compass azimuth, on the ground plane. */
export const groundDirection = (azimuthRad: number): Vec3 =>
  v3(Math.sin(azimuthRad), 0, -Math.cos(azimuthRad))
