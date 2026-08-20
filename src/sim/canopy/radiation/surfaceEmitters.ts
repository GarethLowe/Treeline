/**
 * The feeder WP 3.3 was missing: surface fire state → the emitter buffer `CanopyRadiation`
 * scatters into clusters.
 *
 * `CanopyRadiation.encode()` takes `{ emitters, emitterCount, brickList, brickCount }` and
 * nothing in the tree produced any of them, which is the whole reason M3's canopy solver was
 * built, tested and never composed. `emitters.ts` next door has the CPU arithmetic and is the
 * oracle; this runs it on the GPU over the 2048² surface grid so no 16 MB readback is needed.
 *
 * Kept out of `index.ts` for the same reason as `pass.ts`: it imports WGSL and touches
 * `GPUDevice`, and the barrel has to stay importable from a Vitest run under Node.
 */

import type { Kelvin, Metres, PerMetre, Radians } from '@contracts/units'
import { SURFACE_CELLS, SURFACE_CELL_M } from '@contracts/sim'
import {
  DEFAULT_FLAME_ABSORPTION,
  DEFAULT_FLAME_TEMPERATURE_K,
  MAX_RADIANT_FRACTION,
} from './optics.ts'
import { DEFAULT_FLAME_DEPTH_M } from './emitters.ts'
import { CLUSTER_WORKGROUP } from './layout.ts'
import { DEFAULT_SHADER_OPTIONS, buildRadiationShaders, type RadiationShaderOptions } from './shaders.ts'

/** 32 B per record, matching `struct RadEmitter`. */
export const EMITTER_BYTES = 32

/**
 * Emitters the pass will write before it starts dropping them.
 *
 * A 0.5 m grid puts 2 cells per metre of front, and the flaming band is a few cells deep, so
 * a 2 km perimeter with a 5-cell band is ~20 k emitters. 262 144 is an order of magnitude
 * over that at 8 MiB, and the overflow is *counted* rather than wrapped so the HUD can say so
 * if a pathological world ever reaches it.
 */
export const DEFAULT_EMITTER_CAPACITY = 262_144

const COUNTER_SLOTS = 5
const CT_ARG_BYTE_OFFSET = 4

export interface SurfaceEmitterInputs {
  /** WP 2.4's r16float Byram intensity field, kW/m. */
  readonly intensityTexture: GPUTexture
  /** WP 2.4's r8uint lifecycle field. Only BURNING cells carry a flame sheet. */
  readonly stateTexture: GPUTexture
}

export interface FlameGeometry {
  /** D = R · t_r. Left at the §7.3 default until the meteorology module supplies it. */
  readonly flameDepth?: Metres
  /** k_f, §7.7's calibration knob #1. */
  readonly absorption?: PerMetre
  readonly temperature?: Kelvin
  /** Flame tilt from vertical, radians. 0 = upright, no wind. */
  readonly tilt?: Radians
  /** Direction the flame leans, radians in the world x–z plane, 0 = +x. */
  readonly heading?: Radians
}

export interface SurfaceEmitterOptions {
  readonly cells?: number
  readonly cellM?: number
  readonly capacity?: number
  readonly shader?: RadiationShaderOptions
}

const PARAMS_BYTES = 48

export class SurfaceEmitterPass {
  /** `array<RadEmitter>` — hand straight to `CanopyRadiation.encode`. */
  readonly emitters: GPUBuffer
  /**
   * `[count, argX, argY, argZ, overflow]`.
   *
   * Slot 0 doubles as the cluster scatter's `sampleCount`, copied into the radiation params
   * on the GPU; slots 1–3 are the indirect dispatch args for that scatter. Keeping both on
   * the device is what stops the dispatch size and the buffer contents disagreeing — a
   * readback would put one simulation step between them, and a count that is too high makes
   * the scatter re-read the previous step's emitters and invent energy that is no longer
   * burning.
   */
  readonly counter: GPUBuffer

  readonly capacity: number
  readonly cells: number
  readonly cellM: number

  private readonly device: GPUDevice
  private readonly params: GPUBuffer
  private readonly reset: GPUComputePipeline
  private readonly emit: GPUComputePipeline
  private readonly args: GPUComputePipeline
  private readonly resetGroup: GPUBindGroup
  private readonly argsGroup: GPUBindGroup
  private geometry: Required<FlameGeometry>
  private bindGroup: GPUBindGroup | null = null
  private boundTo: SurfaceEmitterInputs | null = null

  constructor(device: GPUDevice, options: SurfaceEmitterOptions = {}) {
    this.device = device
    this.cells = options.cells ?? SURFACE_CELLS
    this.cellM = options.cellM ?? SURFACE_CELL_M
    this.capacity = options.capacity ?? DEFAULT_EMITTER_CAPACITY
    this.geometry = {
      flameDepth: DEFAULT_FLAME_DEPTH_M,
      absorption: DEFAULT_FLAME_ABSORPTION,
      temperature: DEFAULT_FLAME_TEMPERATURE_K,
      tilt: 0 as Radians,
      heading: 0 as Radians,
    }

    this.emitters = device.createBuffer({
      label: 'radiation.emitters',
      size: this.capacity * EMITTER_BYTES,
      usage: GPUBufferUsage.STORAGE,
    })
    this.counter = device.createBuffer({
      label: 'radiation.emitterCounter',
      size: COUNTER_SLOTS * 4,
      // INDIRECT for the scatter dispatch, COPY_SRC to push slot 0 into the cluster params
      // and to read the overflow count for the HUD.
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC,
    })
    this.params = device.createBuffer({
      label: 'radiation.emitParams',
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const code = buildRadiationShaders(options.shader ?? DEFAULT_SHADER_OPTIONS).emitSurface
    const module = device.createShaderModule({ label: 'radiation.emitSurface', code })
    const make = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `radiation.emit.${entryPoint}`,
        layout: 'auto',
        compute: { module, entryPoint },
      })
    this.reset = make('reset')
    this.emit = make('emit')
    this.args = make('args')

    // `reset` and `args` touch only the counter, so `layout: 'auto'` gives each a group-0
    // layout with that one binding — but they are DIFFERENT layout objects, and an implicit
    // layout is only ever compatible with the pipeline that produced it. Sharing one bind
    // group across both is a validation error, and because the canopy rides on the fire's
    // encoder it discards the surface solver's passes too: the symptom is a fire that stops
    // spreading, three subsystems away from the cause.
    const counterOnly = (pipeline: GPUComputePipeline, label: string): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 5, resource: { buffer: this.counter } }],
      })
    this.resetGroup = counterOnly(this.reset, 'radiation.emit.reset.g0')
    this.argsGroup = counterOnly(this.args, 'radiation.emit.args.g0')

    this.writeParams()
  }

  /** Wind-driven flame geometry. Cheap; call whenever the weather moves. */
  setGeometry(geometry: FlameGeometry): void {
    this.geometry = { ...this.geometry, ...geometry }
    this.writeParams()
  }

  /**
   * Rebuild the emitter list from the current fire state.
   *
   * Call at `RAD_UPDATE_INTERVAL_S`, not per substep — see `CanopyRadiation.encode`. The
   * three dispatches are separate passes because each is a genuine read-after-write on the
   * counter, which §6.3 says needs a pass boundary and not a hope.
   */
  encode(encoder: GPUCommandEncoder, inputs: SurfaceEmitterInputs): void {
    const group = this.groupFor(inputs)
    const one = (label: string, pipeline: GPUComputePipeline, bg: GPUBindGroup, x: number, y = 1): void => {
      const pass = encoder.beginComputePass({ label: `radiation.emit.${label}` })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bg)
      pass.dispatchWorkgroups(x, y)
      pass.end()
    }
    one('reset', this.reset, this.resetGroup, 1)
    const groups = Math.ceil(this.cells / 8)
    one('emit', this.emit, group, groups, groups)
    one('args', this.args, this.argsGroup, 1)
  }

  /** Byte offset of the indirect dispatch args inside {@link counter}. */
  get argsOffset(): number {
    return CT_ARG_BYTE_OFFSET
  }

  destroy(): void {
    this.emitters.destroy()
    this.counter.destroy()
    this.params.destroy()
  }

  private groupFor(inputs: SurfaceEmitterInputs): GPUBindGroup {
    const same =
      this.boundTo !== null &&
      this.boundTo.intensityTexture === inputs.intensityTexture &&
      this.boundTo.stateTexture === inputs.stateTexture
    if (same && this.bindGroup !== null) return this.bindGroup
    this.bindGroup = this.device.createBindGroup({
      label: 'radiation.emit.g0',
      layout: this.emit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: inputs.intensityTexture.createView() },
        { binding: 2, resource: inputs.stateTexture.createView() },
        { binding: 4, resource: { buffer: this.emitters } },
        { binding: 5, resource: { buffer: this.counter } },
      ],
    })
    this.boundTo = inputs
    return this.bindGroup
  }

  private writeParams(): void {
    const buf = new ArrayBuffer(PARAMS_BYTES)
    const v = new DataView(buf)
    v.setUint32(0, this.cells, true)
    v.setUint32(4, 0, true)
    v.setFloat32(8, this.cellM, true)
    v.setFloat32(12, 0, true)
    v.setFloat32(16, this.geometry.flameDepth, true)
    v.setFloat32(20, this.geometry.absorption, true)
    v.setFloat32(24, this.geometry.temperature, true)
    v.setFloat32(28, MAX_RADIANT_FRACTION, true)
    v.setFloat32(32, this.geometry.tilt, true)
    v.setFloat32(36, this.geometry.heading, true)
    v.setUint32(40, this.capacity, true)
    v.setUint32(44, 0, true)
    this.device.queue.writeBuffer(this.params, 0, buf)
  }
}

/** Workgroups the cluster scatter would need for `n` emitters. Mirrors `args()` in the WGSL. */
export const scatterGroupsFor = (n: number): number => Math.ceil(n / CLUSTER_WORKGROUP)
