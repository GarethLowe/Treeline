/**
 * Byte-level buffer layouts shared between TypeScript and WGSL.
 *
 * These constants exist in exactly one place and are asserted against the WGSL struct sizes
 * by `test/render/foliage/layout.test.ts`. A silent disagreement between the two sides here
 * does not throw — it reads garbage transforms and draws a forest in the wrong place.
 */

// ---------------------------------------------------------------------------
// Tree instance record — 32 B, matching spec §7.4's 80k x 32 B = 2.6 MB budget
// ---------------------------------------------------------------------------

/**
 * ```wgsl
 * struct TreeInstance {          // 32 B
 *   posX: f32, posY: f32, posZ: f32,   // trunk base, world metres
 *   heightM: f32,                       // total height; scale = heightM / mesh.refHeightM
 *   rotationY: f32,                     // radians about +Y
 *   cullRadiusM: f32,                   // bounding-sphere radius about the sphere centre
 *   meshId: u32,                        // index into the mesh table
 *   burnStateIndex: u32,                // M4 hook; zero at M1
 * }
 * ```
 *
 * Spec §7.4 lists a rotation quaternion. A tree rotates about the vertical only — a quat
 * would spend 16 B to store 4 B of information and would cost a normalise in the vertex
 * shader. The 12 B saved carry the bounding-sphere radius instead, which the cull pass
 * genuinely needs and would otherwise have to guess from height.
 */
export const INSTANCE_STRIDE_BYTES = 32
export const INSTANCE_FLOATS = INSTANCE_STRIDE_BYTES / 4

export const INSTANCE_OFF_POS_X = 0
export const INSTANCE_OFF_POS_Y = 1
export const INSTANCE_OFF_POS_Z = 2
export const INSTANCE_OFF_HEIGHT = 3
export const INSTANCE_OFF_ROTATION_Y = 4
export const INSTANCE_OFF_CULL_RADIUS = 5
export const INSTANCE_OFF_MESH_ID = 6
export const INSTANCE_OFF_BURN_STATE = 7

/**
 * The bounding sphere centre is `(posX, posY + 0.5 * heightM, posZ)`.
 *
 * Stated once, here, because it is a convention the cull shader and the instance builder
 * must agree on and neither can validate independently.
 */
export function boundingSphereCentreY(posY: number, heightM: number): number {
  return posY + 0.5 * heightM
}

// ---------------------------------------------------------------------------
// Mesh table entry — 32 B, one per (mesh, LOD) bucket
// ---------------------------------------------------------------------------

/**
 * ```wgsl
 * struct MeshEntry {             // 32 B
 *   indexCount: u32, firstIndex: u32, baseVertex: u32, triangleCount: u32,
 *   refHeightM: f32, lod: u32, meshId: u32, _pad: u32,
 * }
 * ```
 */
export const MESH_ENTRY_STRIDE_BYTES = 32
export const MESH_ENTRY_U32S = MESH_ENTRY_STRIDE_BYTES / 4

export const MESH_OFF_INDEX_COUNT = 0
export const MESH_OFF_FIRST_INDEX = 1
export const MESH_OFF_BASE_VERTEX = 2
export const MESH_OFF_TRIANGLE_COUNT = 3
export const MESH_OFF_REF_HEIGHT = 4
export const MESH_OFF_LOD = 5
export const MESH_OFF_MESH_ID = 6

// ---------------------------------------------------------------------------
// Vertex layout — 36 B interleaved
// ---------------------------------------------------------------------------

/** position (3xf32) | normal (3xf32) | uv (2xf32) | materialSlot (u32) */
export const VERTEX_STRIDE_BYTES = 36
export const VERTEX_FLOATS = 9

export const VERTEX_ATTRIBUTES: readonly GPUVertexAttribute[] = [
  { shaderLocation: 0, offset: 0, format: 'float32x3' },
  { shaderLocation: 1, offset: 12, format: 'float32x3' },
  { shaderLocation: 2, offset: 24, format: 'float32x2' },
  { shaderLocation: 3, offset: 32, format: 'uint32' },
]

// ---------------------------------------------------------------------------
// Material params — 32 B per slot
// ---------------------------------------------------------------------------

/**
 * ```wgsl
 * struct MaterialParams {        // 32 B
 *   baseColor: vec3<f32>, roughness: f32,
 *   layer: u32, flags: u32, metallic: f32, _pad: f32,
 * }
 * ```
 * Built from `IMaterialSystem.materials`, resolved once at atlas-build time so the vertex
 * stream can carry a plain slot index and the fragment shader needs no map lookup.
 */
export const MATERIAL_PARAMS_STRIDE_BYTES = 32
export const MATERIAL_FLAG_ALPHA_TEST = 1 << 0
export const MATERIAL_FLAG_DOUBLE_SIDED = 1 << 1
export const MATERIAL_FLAG_BURNABLE = 1 << 2

// ---------------------------------------------------------------------------
// Compacted instance list entry — 4 B
// ---------------------------------------------------------------------------

/**
 * `(fadeQ12 << 20) | instanceIndex20`.
 *
 * 20 bits of instance index caps the set at 1,048,576 trees against a spec budget of 80k.
 * 12 bits of dither weight is far finer than the 8-bit ordered dither that consumes it.
 */
export const COMPACTED_INDEX_BITS = 20
export const COMPACTED_MAX_INSTANCES = 1 << COMPACTED_INDEX_BITS
export const COMPACTED_FADE_MAX = (1 << 12) - 1

export function packCompacted(instanceIndex: number, fade01: number): number {
  const q = Math.max(0, Math.min(COMPACTED_FADE_MAX, Math.round(fade01 * COMPACTED_FADE_MAX)))
  return ((q << COMPACTED_INDEX_BITS) | (instanceIndex & (COMPACTED_MAX_INSTANCES - 1))) >>> 0
}

export function unpackCompacted(v: number): { instanceIndex: number; fade01: number } {
  return {
    instanceIndex: v & (COMPACTED_MAX_INSTANCES - 1),
    fade01: (v >>> COMPACTED_INDEX_BITS) / COMPACTED_FADE_MAX,
  }
}

// ---------------------------------------------------------------------------
// Indirect draw arguments
// ---------------------------------------------------------------------------

/** `drawIndexedIndirect`: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
export const DRAW_INDEXED_ARGS_U32S = 5
export const DRAW_INDEXED_ARGS_BYTES = DRAW_INDEXED_ARGS_U32S * 4
/** `drawIndirect`: vertexCount, instanceCount, firstVertex, firstInstance. */
export const DRAW_ARGS_U32S = 4
export const DRAW_ARGS_BYTES = DRAW_ARGS_U32S * 4

/**
 * `firstInstance` is left at zero in every indirect draw this package writes.
 *
 * The `indirect-first-instance` feature is granted on the target hardware, but depending on
 * it would make the whole renderer conditional on an optional feature for the sake of one
 * addition. Instead the per-bucket base offset is read inside the vertex shader from
 * `bucketBase[]`, with the bucket id supplied by a dynamic-offset uniform. Same number of
 * draws, same GPU-authored counts, zero optional-feature dependency — the same reasoning
 * spec §7.4 applies to `multiDrawIndirect`.
 */
export const INDIRECT_FIRST_INSTANCE = 0

// ---------------------------------------------------------------------------
// Stats buffer
// ---------------------------------------------------------------------------

/** u32 slots in the GPU stats buffer. */
export const STATS_TREES_VISIBLE = 0
export const STATS_TREES_CULLED = 1
/** Number of appended (instance, LOD) records, which exceeds treesVisible during cross-fades. */
export const STATS_RECORDS_APPENDED = 2
export const STATS_TRIANGLES = 3
export const STATS_GRASS_BLADES = 4
export const STATS_GRASS_TILES = 5
/** Set non-zero by the args kernels when a count had to be clamped. Surfaced, never silent. */
export const STATS_CLAMP_EVENTS = 6
export const STATS_U32S = 8
export const STATS_BYTES = STATS_U32S * 4

// ---------------------------------------------------------------------------
// Control buffer — stats, counters and the per-bucket tables, in ONE binding
// ---------------------------------------------------------------------------

/**
 * The cull passes need five separate GPU-written u32 tables: stats, the record counter, and
 * per-bucket counts, cursors and bases. Binding them separately costs five storage-buffer
 * slots, and **`maxStorageBuffersPerShaderStage` is 8 in core WebGPU** — with the instance,
 * mesh, record, compacted and draw-argument buffers that is 10, which fails bind group layout
 * creation outright. (Confirmed on hardware: the first version of this package did exactly
 * that and Dawn rejected the layout.) Raising the limit at device creation would work but
 * would make this package's viability depend on a limit request made in WP 1.1.
 *
 * So they share one buffer:
 *
 * ```
 *   [0  .. 8)                 stats
 *   [8]                       recordCount
 *   [9  .. 12)                reserved
 *   [12 .. 12 + n)            per-bucket counts
 *   [12 + n .. 12 + 2n)       per-bucket cursors
 *   [12 + 2n .. 12 + 3n)      per-bucket bases
 * ```
 *
 * Every slot is a u32 and every writer is atomic, so the whole thing binds once as
 * `array<atomic<u32>>` and the offsets are computed from `bucketCount`.
 */
export const CONTROL_OFF_STATS = 0
export const CONTROL_OFF_RECORD_COUNT = 8
export const CONTROL_HEADER_U32S = 12

export const controlCountsIndex = (bucket: number, bucketCount: number): number =>
  CONTROL_HEADER_U32S + bucket * 1 + 0 * bucketCount
export const controlCursorsIndex = (bucket: number, bucketCount: number): number =>
  CONTROL_HEADER_U32S + bucketCount + bucket
export const controlBasesIndex = (bucket: number, bucketCount: number): number =>
  CONTROL_HEADER_U32S + 2 * bucketCount + bucket
export const controlU32s = (bucketCount: number): number =>
  CONTROL_HEADER_U32S + 3 * Math.max(bucketCount, 1)

// ---------------------------------------------------------------------------
// Per-bucket dynamic uniform
// ---------------------------------------------------------------------------

/**
 * One `u32` bucket id, but bound with `hasDynamicOffset`, so the stride must satisfy
 * `minUniformBufferOffsetAlignment` (256 B on every known implementation).
 */
export const BUCKET_UNIFORM_STRIDE_BYTES = 256

// ---------------------------------------------------------------------------
// Frame uniform — 176 B
// ---------------------------------------------------------------------------

/**
 * ```wgsl
 * struct FrameUniform {                    // 208 B
 *   viewProj: mat4x4<f32>,                 //   0  (64)
 *   cameraPos: vec3<f32>, timeSec: f32,    //  64  (16)
 *   windDir: vec2<f32>, windSpeed: f32, gustiness: f32,  // 80 (16)
 *   frustum: array<vec4<f32>, 6>,          //  96  (96) -- LEFT,RIGHT,BOTTOM,TOP,NEAR,FAR
 *   sunDir: vec3<f32>, alphaCutoff: f32,   // 192 (16)
 * }
 * ```
 *
 * `sunDir` and the shading it drives are M1 placeholders in the sense that WP 1.7 owns the
 * real sky and environment lighting — but they are a real directional term, not a constant
 * colour, and they live in a uniform rather than a shader constant so that hooking up
 * `IEnvironmentLighting` at integration is a write, not a recompile.
 */
export const FRAME_UNIFORM_BYTES = 240
export const FRAME_OFF_VIEW_PROJ = 0
export const FRAME_OFF_CAMERA_POS = 64
export const FRAME_OFF_TIME = 76
export const FRAME_OFF_WIND_DIR = 80
export const FRAME_OFF_WIND_SPEED = 88
export const FRAME_OFF_GUSTINESS = 92
export const FRAME_OFF_FRUSTUM = 96
export const FRAME_OFF_SUN_DIR = 192
export const FRAME_OFF_ALPHA_CUTOFF = 204
/**
 * Sun and sky irradiance, W/m2, **per channel**. Added because this pass was originally
 * written as an LDR shading pass — `albedo * (N.L + ambient)`, peaking near 1.0 — while the
 * terrain, sky and tone mapper all work in PHYSICAL RADIANCE (`albedo/pi * irradiance`,
 * ~58 W/m2/sr at a 54 degree sun). Composited together, foliage came out ~58x too dark and
 * rendered as pure black silhouettes at any exposure.
 *
 * RGB rather than scalar because the light in this scene is not white: the beam reddens
 * through airmass and through smoke (extinction goes as lambda^-1.76), and the sky's ambient
 * is strongly blue. A scalar made foliage the only surface in the frame lit by a grey sun
 * while the terrain beside it, which reads the same sky, was lit by a coloured one.
 * Magnitudes are unchanged: both vectors carry the scalar irradiance times a peak-normalised
 * tint, so this shifts hue without touching exposure.
 *
 * vec3 alignment is 16 B, hence the two 4-byte gaps and 240 rather than 224.
 */
export const FRAME_OFF_SUN_IRRADIANCE = 208
export const FRAME_OFF_SKY_IRRADIANCE = 224

// ---------------------------------------------------------------------------
// Cull uniform — 64 B
// ---------------------------------------------------------------------------

/**
 * ```wgsl
 * struct CullUniform {                     // 64 B
 *   instanceCount: u32, bucketCount: u32, lodCount: u32, compactedCapacity: u32,  // 0
 *   lodThresholdPx: vec4<f32>,             // 16  (xyz used, w unused)
 *   fadeFraction: f32, pixelsPerMetreAtUnitDepth: f32, cullRadiusScale: f32, _pad: f32, // 32
 *   grassPad: vec4<f32>,                   // 48
 * }
 * ```
 *
 * `pixelsPerMetreAtUnitDepth = viewportHeightPx * resolutionScale / (2 * tan(fov/2))`, so
 * the shader's projected screen height is one divide: `h * ppm / distance`.
 */
export const CULL_UNIFORM_BYTES = 64
export const CULL_OFF_INSTANCE_COUNT = 0
export const CULL_OFF_BUCKET_COUNT = 4
export const CULL_OFF_LOD_COUNT = 8
export const CULL_OFF_COMPACTED_CAPACITY = 12
export const CULL_OFF_LOD_THRESHOLDS = 16
export const CULL_OFF_FADE_FRACTION = 32
export const CULL_OFF_PPM = 36
export const CULL_OFF_CULL_RADIUS_SCALE = 40

// ---------------------------------------------------------------------------
// Grass uniform — 80 B
// ---------------------------------------------------------------------------

/**
 * ```wgsl
 * struct GrassUniform {                    // 96 B
 *   tileSizeM: f32, densityPerM2: f32, falloffStartM: f32, falloffEndM: f32,   //  0
 *   bandCount: u32, tileSpanTiles: u32, tileCapacityPerBand: u32, domainTiles: u32, // 16
 *   bladeHeightMin: f32, bladeHeightMax: f32, bladeWidthM: f32, widthCompensation: f32, // 32
 *   outerFadeFraction: f32, cameraTileX: i32, cameraTileZ: i32, verticalMarginM: f32, // 48
 *   bandEdges: vec4<f32>,   // edges 1..4; edge 0 is 0, band b spans [edge(b), edge(b+1)) // 64
 *   materialLayer: u32, alphaCutoff: f32, _pad0: f32, _pad1: f32,              // 80
 * }
 * ```
 */
export const GRASS_UNIFORM_BYTES = 96
export const GRASS_MAX_BANDS = 4

// ---------------------------------------------------------------------------
// Indirect-argument clamping
// ---------------------------------------------------------------------------

/**
 * Clamp an indirect *dispatch* triple, folding overflow into Y.
 *
 * Per WebGPU §16.1.2 an indirect dispatch whose workgroup count exceeds
 * `maxComputeWorkgroupsPerDimension` is **silently skipped in its entirety** on the queue
 * timeline. It is not clamped, it is not an error, and nothing is surfaced — the symptom is
 * a whole pass of work that simply did not happen. Anything computing dispatch dimensions
 * on the GPU must therefore clamp them itself.
 *
 * This package's compute dispatches are all direct (their sizes are CPU-known), so this is
 * used by the tests as the reference for the WGSL helper of the same name, and is exported
 * for the integrator to reuse when the M2/M3 packages start feeding indirect dispatches in.
 */
export function clampDispatch(
  x: number,
  y: number,
  z: number,
  maxPerDimension: number,
): { x: number; y: number; z: number; clamped: boolean } {
  let cx = Math.max(0, Math.floor(x))
  let cy = Math.max(0, Math.floor(y))
  const cz = Math.min(Math.max(0, Math.floor(z)), maxPerDimension)
  let clamped = cz !== Math.max(0, Math.floor(z))
  if (cx > maxPerDimension) {
    // Fold the excess into Y rather than dropping it. The kernel reconstructs the flat
    // index as `x + y * dispatchWidth` and bounds-checks against the true count.
    const rows = Math.ceil(cx / maxPerDimension)
    cy = cy * rows
    cx = maxPerDimension
    clamped = true
  }
  if (cy > maxPerDimension) {
    cy = maxPerDimension
    clamped = true
  }
  return { x: cx, y: cy, z: cz, clamped }
}

/** Clamp an instance count against the capacity actually allocated for it. */
export function clampInstanceCount(count: number, capacity: number): { count: number; clamped: boolean } {
  const c = Math.max(0, Math.floor(count))
  return c > capacity ? { count: capacity, clamped: true } : { count: c, clamped: false }
}

/**
 * Fixed-point scale for the per-instance peak fireline intensity, kW/m into a u32.
 *
 * 16 gives about 0.06 kW/m of resolution and a ceiling of 2.7e8 kW/m, which is six orders of
 * magnitude above the most intense crown fire ever measured. The value only has to be the
 * same on both sides of the boundary — hence living here rather than in either shader.
 */
export const BURN_PEAK_SCALE = 16

/**
 * Fixed-point scale for the per-instance crown consumed fraction, which is a 0..1 unorm.
 * WGSL has no float atomics and this is accumulated with `atomicMax`, so it is carried as an
 * integer. 65535 makes the quantum finer than any burn stage transition can show.
 */
export const BURN_CROWN_SCALE = 65535
