/**
 * GPU device, scheduling and profiling contracts. See docs/spec/10-webgpu-architecture.md §6.7.
 *
 * FROZEN for M1. Do not edit during fan-out — a change here invalidates every work package
 * in flight. If you believe something is wrong, stop and report rather than editing.
 */


// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

/** Optional features the project requests. All were granted on the target config (even the iGPU). */
export const WANTED_FEATURES = [
  'timestamp-query',
  'float32-filterable',
  'shader-f16',
  'texture-formats-tier1',
  'texture-formats-tier2',
  'subgroups',
  'indirect-first-instance',
] as const

export type WantedFeature = (typeof WANTED_FEATURES)[number]

export interface AdapterReport {
  readonly vendor: string
  readonly architecture: string
  readonly device: string
  readonly description: string
  /**
   * True when the adapter looks integrated. On hybrid laptops the browser hands back the
   * iGPU under a range of conditions even with powerPreference:'high-performance', and the
   * resulting ~10x frame time reads as a catastrophic regression that is not real. Every
   * performance figure recorded anywhere must carry this flag.
   */
  readonly looksIntegrated: boolean
  readonly grantedFeatures: readonly WantedFeature[]
  /** Requested limits the adapter could not satisfy. Empty on the target hardware. */
  readonly limitShortfalls: readonly { readonly limit: string; readonly wanted: number; readonly got: number }[]
}


// ---------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------

/**
 * Passes are grouped into phases before timing.
 *
 * Chrome quantises timestamp query results to 100 us as a timing-attack mitigation, and
 * nine of the twelve simulation passes are below that. A shipping build therefore CANNOT
 * resolve per-pass microseconds. Grouping into phases of >=300 us keeps quantisation under
 * ~30% of a sample, and the EMA averages the rest out. Per-pass figures are only ever
 * obtained in dev builds with WebGPU developer features enabled.
 */
export type Phase = 'surface' | 'canopy' | 'fluid' | 'brands' | 'render'

export const PHASES: readonly Phase[] = ['surface', 'canopy', 'fluid', 'brands', 'render']

export interface FrameTimings {
  /** EMA per phase, milliseconds. Decay 0.98 over >=120 frames. */
  readonly phaseMs: Readonly<Record<Phase, number>>
  /** 30-frame median whole-frame GPU time. What the quality controller actually reads. */
  readonly medianFrameMs: number
  /** CPU-timeline wall clock for the whole submit, via onSubmittedWorkDone(). Always available. */
  readonly submitMs: number
  /** True when timestamps are unquantised (dev build). Per-pass numbers are only trustworthy then. */
  readonly highResolution: boolean
}

export interface IFrameProfiler {
  /** Wrap a compute pass so it is attributed to a phase. */
  beginComputePass(encoder: GPUCommandEncoder, phase: Phase, label: string): GPUComputePassEncoder
  beginRenderPass(
    encoder: GPUCommandEncoder,
    phase: Phase,
    label: string,
    desc: GPURenderPassDescriptor,
  ): GPURenderPassEncoder
  /** Call once per frame after encoding, before submit. */
  resolve(encoder: GPUCommandEncoder): void
  /** Latest timings. Reads frame n-3; never maps a buffer touched this frame. */
  readonly timings: FrameTimings
}

// ---------------------------------------------------------------------------
// Quality scaling
// ---------------------------------------------------------------------------

/** 0 = lowest, 5 = full. See spec §6.7. */
export type QualityLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface QualitySettings {
  readonly resolutionScale: number
  readonly froxelMarchSteps: number
  readonly nearFieldParticleBudget: number
  readonly radiationRays: number
}

/** Monotonic in q. Frozen from spec §6.7. */
export const QUALITY_TABLE: readonly QualitySettings[] = [
  { resolutionScale: 0.6, froxelMarchSteps: 24, nearFieldParticleBudget: 20_000, radiationRays: 8 },
  { resolutionScale: 0.7, froxelMarchSteps: 32, nearFieldParticleBudget: 40_000, radiationRays: 8 },
  { resolutionScale: 0.8, froxelMarchSteps: 48, nearFieldParticleBudget: 80_000, radiationRays: 16 },
  { resolutionScale: 0.9, froxelMarchSteps: 64, nearFieldParticleBudget: 160_000, radiationRays: 16 },
  { resolutionScale: 1.0, froxelMarchSteps: 96, nearFieldParticleBudget: 320_000, radiationRays: 32 },
  { resolutionScale: 1.0, froxelMarchSteps: 128, nearFieldParticleBudget: 640_000, radiationRays: 32 },
]


// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

