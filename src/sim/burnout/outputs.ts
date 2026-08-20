/**
 * `IFireOutputs` on the GPU — WP 2.4.
 *
 * Publishes the four `IFireOutputs` textures and owns the one compute pass that derives the
 * two of them nobody else writes — intensity and consumed fraction — from the arrival time
 * and rate-of-spread fields WP 2.3 stamps as the level set front passes each cell.
 *
 * Kept in a module of its own, imported by nothing that runs under Vitest, so the physics in
 * `consumption.ts` and the field semantics in `fields.ts` stay testable on the CLI without a
 * device. This file is plumbing; the correctness lives next door.
 *
 * ## How WP 2.3 feeds it — RECONCILED 2026-08-19
 *
 * It used to declare two per-cell atomic accumulators for the propagation shader to scatter
 * into, via `record_arrival` / `record_intensity` in the WGSL. **The propagation shader never
 * bound them**, so `intensityTexture` and `consumedTexture` were structurally zero for as long
 * as both packages had existed, and the HUD reported that as a known gap rather than as
 * physics. The accumulators are gone.
 *
 * WP 2.3 already stamps `arrivalTime` when a cell's phi crosses zero. It now also stamps the
 * normal rate of spread at that instant into `rosArrival`, which is the one quantity that
 * cannot be recovered afterwards. This pass reads both and computes Byram (1959)
 * `I = I_R * t_r * R` plus the burnout curve. No scatter, no atomics per cell, and the result
 * is order-independent by construction — which is what the M6 CSV export needs.
 *
 * ## Memory, on the 2048² grid
 *
 * Nothing here allocates a field. All five textures belong to the solver (32 MiB in total for
 * state, intensity, arrival, consumed and rosArrival); this class adds the fuel index (4 MiB)
 * and three small buffers. The 32 MiB of accumulators the old design needed are saved outright.
 */

import { rawBuffer } from '@gpu/raw.ts'
import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/sim'
import type { IFireOutputs } from '@contracts/sim'
import type { KilowattsPerMetre, Seconds } from '@contracts/units'
import { kWm } from '@contracts/units'
import BURNOUT_WGSL from './burnout.wgsl?raw'
import type { CellBurnoutModel } from './consumption.ts'
import {
  AGGREGATE_SLOTS,
  decodeAggregates,
  packBurnoutModels,
  packFuelIndex,
} from './layout.ts'

export { BURNOUT_WGSL }

/**
 * The field textures WP 2.3's solver already owns. Passing them in is what makes this class
 * a *stage* over the solver's state rather than a parallel copy of it — the previous design
 * allocated its own 2048^2 set and waited for a writer that never bound them.
 */
export interface BurnoutFields {
  /** Written here: UNBURNT / BURNING / BURNT lifecycle. WP 2.3 stamps 1 on arrival. */
  readonly state: GPUTexture
  /** Written here: peak Byram fireline intensity [kW/m], r16float. */
  readonly intensity: GPUTexture
  /** Read here, written by WP 2.3: time of arrival [s], r32float, MAX_VALUE = never. */
  readonly arrivalTime: GPUTexture
  /** Written here: consumed fraction of the cell's loading, r8unorm. */
  readonly consumed: GPUTexture
  /** Read here, written by WP 2.3: normal rate of spread at arrival [m/s], r16float. */
  readonly rosArrival: GPUTexture
}

export interface FireOutputsOptions {
  /** Grid is `cells × cells`. Defaults to the shipping surface grid. */
  readonly cells?: number
  readonly cellM?: number
  /** Field textures from the surface solver. Required — see {@link BurnoutFields}. */
  readonly fields: BurnoutFields
}

const RESOLVE_WORKGROUP = 8
/** `struct Params` in burnout.wgsl, padded to a 16-byte multiple. */
const PARAMS_BYTES = 32

export class FireOutputs implements IFireOutputs {
  readonly stateTexture: GPUTexture
  readonly intensityTexture: GPUTexture
  readonly arrivalTimeTexture: GPUTexture
  readonly consumedTexture: GPUTexture

  burntAreaM2 = 0
  perimeterM = 0
  maxFirelineIntensity: KilowattsPerMetre = kWm(0)

  readonly cells: number
  readonly cellM: number

  /** Read-only input: normal rate of spread at arrival [m/s]. Owned by the solver. */
  readonly rosArrivalTexture: GPUTexture
  /** Centroid of the flaming front, world metres. Null when nothing is alight. */
  flamingCentroid: { readonly x: number; readonly z: number } | null = null
  flamingCells = 0

  private readonly device: GPUDevice
  private readonly params: GPUBuffer
  private readonly modelBuffer: GPUBuffer
  private readonly fuelIndexBuffer: GPUBuffer
  private readonly aggregateBuffer: GPUBuffer
  private readonly aggregateStaging: GPUBuffer
  private readonly resolvePipeline: GPUComputePipeline
  private readonly resolveGroup0: GPUBindGroup
  private readonly resolveGroup1: GPUBindGroup
  private readonly modelCount: number
  private readingBack = false
  /** A copy into the staging buffer has been encoded and not yet mapped. */
  private copyPending = false

  constructor(
    device: GPUDevice,
    models: readonly CellBurnoutModel[],
    options: FireOutputsOptions,
  ) {
    // r8uint / r8unorm / r16float need tier1 to be storage-bindable. Failing here with a
    // sentence beats failing in shader validation with a format enum.
    if (!device.features.has('texture-formats-tier1')) {
      throw new Error(
        'FireOutputs needs the "texture-formats-tier1" feature for r8uint/r8unorm/r16float ' +
          'storage textures. Request it when creating the device.',
      )
    }

    // Read inside the constructor, never at module scope: this module is imported by
    // `app/fire.ts`, which Vitest loads under Node where the WebGPU globals do not exist.
    // A module-level `GPUBufferUsage.STORAGE` throws at import time and takes the whole
    // suite's fire tests with it.
    const STORAGE = GPUBufferUsage.STORAGE

    this.device = device
    this.modelCount = models.length
    this.cells = options.cells ?? SURFACE_CELLS
    this.cellM = options.cellM ?? SURFACE_CELL_M
    const n = this.cells
    const cellCount = n * n

    const fields = options.fields
    this.stateTexture = fields.state
    this.intensityTexture = fields.intensity
    this.arrivalTimeTexture = fields.arrivalTime
    this.consumedTexture = fields.consumed
    this.rosArrivalTexture = fields.rosArrival

    this.aggregateBuffer = device.createBuffer({
      label: 'fire-aggregates',
      size: AGGREGATE_SLOTS * 4,
      // COPY_DST as well as COPY_SRC: `resolve` zeroes this with `encoder.clearBuffer`, which
      // is a copy destination. Without the flag that call is a validation error, and a
      // validation error DISCARDS THE WHOLE COMMAND BUFFER — including every compute pass the
      // surface solver encoded before it. The symptom is a fire that never starts, with no
      // exception and nothing thrown; the diagnosis is three stages upstream of the cause.
      usage: STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    this.aggregateStaging = device.createBuffer({
      label: 'fire-aggregates-staging',
      size: AGGREGATE_SLOTS * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const packed = packBurnoutModels(models)
    this.modelBuffer = device.createBuffer({
      label: 'fire-burnout-models',
      size: packed.byteLength,
      usage: STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this.modelBuffer, 0, rawBuffer(packed), packed.byteOffset, packed.byteLength)

    // One fuel model everywhere until the vegetation layer says otherwise.
    this.fuelIndexBuffer = device.createBuffer({
      label: 'fire-fuel-index',
      size: Math.ceil(cellCount / 4) * 4,
      usage: STORAGE | GPUBufferUsage.COPY_DST,
    })

    this.params = device.createBuffer({
      label: 'fire-burnout-params',
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.writeParams(0 as Seconds, models.length, 0)

    const module = device.createShaderModule({ label: 'burnout', code: BURNOUT_WGSL })
    this.resolvePipeline = device.createComputePipeline({
      label: 'burnout-resolve',
      layout: 'auto',
      compute: { module, entryPoint: 'resolve' },
    })

    this.resolveGroup0 = device.createBindGroup({
      label: 'burnout-resolve-g0',
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.modelBuffer } },
        { binding: 2, resource: { buffer: this.fuelIndexBuffer } },
        { binding: 5, resource: { buffer: this.aggregateBuffer } },
      ],
    })
    this.resolveGroup1 = device.createBindGroup({
      label: 'burnout-resolve-g1',
      layout: this.resolvePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.stateTexture.createView() },
        { binding: 1, resource: this.intensityTexture.createView() },
        { binding: 3, resource: this.consumedTexture.createView() },
        { binding: 4, resource: this.arrivalTimeTexture.createView() },
        { binding: 5, resource: this.rosArrivalTexture.createView() },
      ],
    })
  }

  /**
   * Re-pack the burnout model table in place. The entry count may not change: the buffer is
   * sized once and the bind group holds it, so a different count would need both rebuilt.
   * This exists because the burnout curve depends on the fuel model, and the fuel model is a
   * live HUD control.
   */
  setModels(models: readonly CellBurnoutModel[]): void {
    if (models.length !== this.modelCount) {
      throw new Error(
        `setModels: expected ${this.modelCount} models, got ${models.length}. ` +
          'The table is sized at construction; changing its length needs a new FireOutputs.',
      )
    }
    const packed = packBurnoutModels(models)
    this.device.queue.writeBuffer(this.modelBuffer, 0, rawBuffer(packed), packed.byteOffset, packed.byteLength)
  }

  /** Per-cell fuel model index, row-major, one byte per cell. */
  setFuelIndex(perCell: Uint8Array): void {
    const cellCount = this.cells * this.cells
    if (perCell.length !== cellCount) {
      throw new Error(`setFuelIndex: expected ${cellCount} entries, got ${perCell.length}`)
    }
    const words = packFuelIndex(perCell)
    this.device.queue.writeBuffer(this.fuelIndexBuffer, 0, rawBuffer(words), words.byteOffset, words.byteLength)
  }

  /**
   * Zero the published aggregates. The GPU-side counters are cleared by `resolve` itself, so
   * this only resets what the HUD is reading between the call and the next readback.
   */
  clear(_encoder: GPUCommandEncoder): void {
    this.burntAreaM2 = 0
    this.perimeterM = 0
    this.maxFirelineIntensity = kWm(0)
  }

  /**
   * Solver fields → intensity, consumed, state and the aggregates, for simulated clock time
   * `now`. Idempotent: the pass never reads its own output, so re-running it at the same
   * `now` reproduces the same textures bit for bit.
   *
   * `reactionIntensity` is the Rothermel I_R for the current fuel and weather, in kW/m². Pass
   * 0 and the intensity field is 0 — which is honest, not broken: without a reaction intensity
   * there is no Byram intensity to report.
   */
  resolve(encoder: GPUCommandEncoder, now: Seconds, reactionIntensity = 0): void {
    this.writeParams(now, this.modelCount, reactionIntensity)
    encoder.clearBuffer(this.aggregateBuffer)
    const pass = encoder.beginComputePass({ label: 'burnout-resolve' })
    pass.setPipeline(this.resolvePipeline)
    pass.setBindGroup(0, this.resolveGroup0)
    pass.setBindGroup(1, this.resolveGroup1)
    const groups = Math.ceil(this.cells / RESOLVE_WORKGROUP)
    pass.dispatchWorkgroups(groups, groups)
    pass.end()
    // Skipped while a readback is in flight. Encoding a copy into a buffer with a pending
    // `mapAsync` does not throw — WebGPU discards the ENTIRE command buffer with a console
    // warning, taking every compute pass in it along. That failure mode cost this project a
    // day once already; see the readback ring in `propagation/solver.ts`. One frame of a
    // stale aggregate is the correct price.
    if (!this.readingBack) {
      encoder.copyBufferToBuffer(this.aggregateBuffer, 0, this.aggregateStaging, 0, AGGREGATE_SLOTS * 4)
      this.copyPending = true
    }
  }

  /**
   * Pull the aggregates back and update the published fields. One frame of latency, which is
   * what the HUD wants anyway — stalling the queue to make a number one frame fresher is a
   * bad trade. Concurrent calls are dropped rather than queued.
   */
  async readAggregates(): Promise<void> {
    // `copyPending` is what makes this alternate rather than starve. Without it the sequence
    // is: map (readingBack := true) -> resolve skips its copy -> map completes -> map again ->
    // resolve skips again, forever. The copy is never encoded and every aggregate reads zero,
    // which looks exactly like a fire that is not burning.
    if (this.readingBack || !this.copyPending) return
    this.readingBack = true
    this.copyPending = false
    try {
      await this.aggregateStaging.mapAsync(GPUMapMode.READ)
      const raw = new Uint32Array(this.aggregateStaging.getMappedRange().slice(0))
      this.aggregateStaging.unmap()
      const agg = decodeAggregates(raw, this.cellM)
      this.burntAreaM2 = agg.burntAreaM2
      this.perimeterM = agg.perimeterM
      this.maxFirelineIntensity = agg.maxFirelineIntensity
      this.flamingCentroid = agg.flamingCentroid
      this.flamingCells = agg.flamingCells
    } finally {
      this.readingBack = false
    }
  }

  /** The textures belong to the solver, which destroys them. Only the buffers are ours. */
  destroy(): void {
    for (const b of [
      this.aggregateBuffer,
      this.aggregateStaging,
      this.modelBuffer,
      this.fuelIndexBuffer,
      this.params,
    ]) {
      b.destroy()
    }
  }

  private writeParams(now: Seconds, modelCount: number, reactionIntensity: number): void {
    const buf = new ArrayBuffer(PARAMS_BYTES)
    const view = new DataView(buf)
    view.setFloat32(0, now, true)
    view.setFloat32(4, this.cellM, true)
    view.setUint32(8, this.cells, true)
    view.setUint32(12, modelCount, true)
    view.setFloat32(16, reactionIntensity, true)
    this.device.queue.writeBuffer(this.params, 0, buf)
  }
}
