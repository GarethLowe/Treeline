/**
 * Rendering contracts: materials, foliage, sky, cameras.
 *
 * What belongs here is a type two packages both have to agree on. What does NOT belong here is
 * an interface naming a single class — those were an artefact of building against frozen
 * contracts during a parallel fan-out that ended with M1, and CLEANUP-SPEC 1.7 listed them for
 * deletion. Add a concrete type and import it.
 */

import type { Kelvin, Metres, Radians, Seconds } from './units.ts'

// ---------------------------------------------------------------------------
// Materials (WP 1.6)
// ---------------------------------------------------------------------------

/**
 * A PBR material. Textures are packed into array layers, not bound individually — the
 * foliage pass draws tens of thousands of instances and cannot afford per-draw bind groups.
 */
export interface MaterialDef {
  readonly id: string
  /** Layer index into the shared texture arrays. */
  readonly layer: number
  readonly baseColorFactor: readonly [number, number, number]
  readonly roughnessFactor: number
  readonly metallicFactor: number
  /** Foliage needs two-sided lighting and alpha test; bark does not. */
  readonly alphaTest: boolean
  readonly doubleSided: boolean
  /**
   * Burn response. M1 authors these but does not animate them; M4 drives `charFraction`
   * from the simulation. Declared here so the material format does not have to change
   * later, which would mean re-baking every texture.
   */
  readonly burnable: boolean
}

export interface IMaterialSystem {
  readonly albedoArray: GPUTexture
  readonly normalArray: GPUTexture
  /** Packed occlusion / roughness / metallic. */
  readonly ormArray: GPUTexture
  get(id: string): MaterialDef
  readonly materials: ReadonlyMap<string, MaterialDef>
  /** Total VRAM used by material textures, for the budget check. */
  readonly bytesUsed: number
  readonly bindGroupLayout: GPUBindGroupLayout
  createBindGroup(device: GPUDevice): GPUBindGroup
}

// ---------------------------------------------------------------------------
// Foliage (WP 1.5)
// ---------------------------------------------------------------------------

export interface FoliageStats {
  readonly treesVisible: number
  readonly treesCulled: number
  readonly drawCalls: number
  readonly trianglesSubmitted: number
  readonly grassBladesDrawn: number
}

// ---------------------------------------------------------------------------
// Sky, sun and environment lighting (WP 1.7)
// ---------------------------------------------------------------------------

/**
 * Solar state. The SAME values feed the sky render and, at M5, the fuel-drying calculation
 * — solar load on a slope is what makes south-facing aspects drier. One source of truth.
 */
export interface SolarState {
  /** Elevation above horizon. Negative at night. */
  readonly elevation: Radians
  /** Azimuth clockwise from north. */
  readonly azimuth: Radians
  /** Direct normal irradiance, W/m2. */
  readonly directIrradiance: number
  /** Diffuse horizontal irradiance, W/m2. */
  readonly diffuseIrradiance: number
  /** Correlated colour temperature of direct sunlight — reddens near the horizon. */
  readonly colorTemperature: Kelvin
  readonly isDaytime: boolean
}

export interface TimeOfDay {
  /** Seconds since local midnight. */
  readonly secondsOfDay: Seconds
  /** 1-366, drives declination and therefore seasonal fire behaviour. */
  readonly dayOfYear: number
}

// ---------------------------------------------------------------------------
// Cameras (WP 1.8)
// ---------------------------------------------------------------------------

export interface CameraState {
  readonly position: readonly [Metres, Metres, Metres]
  readonly forward: readonly [number, number, number]
  readonly up: readonly [number, number, number]
  readonly viewMatrix: Float32Array
  readonly projMatrix: Float32Array
  readonly viewProjMatrix: Float32Array
  /** Inverse view-projection, needed by the froxel pass at M4. */
  readonly invViewProjMatrix: Float32Array
  readonly verticalFov: Radians
  readonly nearM: Metres
  readonly farM: Metres
  readonly aspect: number
  /** Frustum planes for CPU-side culling and for the cull compute pass. */
  readonly frustumPlanes: Float32Array
}

export type CameraMode = 'first-person' | 'free'

// ---------------------------------------------------------------------------
// Frame assembly
// ---------------------------------------------------------------------------

