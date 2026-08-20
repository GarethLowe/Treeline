/**
 * GPU resources and compute passes for the surface Rothermel kernel (WP 2.2).
 *
 * This package owns the state buffer layout and the two ROS passes and nothing else. The
 * level-set advance, the active-cell compaction and the indirect dispatch are WP 2.3; the
 * consumption/burnout passes and the `IFireOutputs` textures are WP 2.4. Both allocate
 * against `grid` rather than allocating their own copies of the state — which is why `phi`
 * and `ignitionTime` are allocated here even though nothing in this file writes them: the
 * footprint question in §4.3 cannot be answered by a package that owns only half the state.
 */

import {
  PLANE_COUNT,
  SURFACE_CELLS,
  SURFACE_CELL_COUNT,
  FIELDS,
  writeField,
} from './layout.ts'
import type { FieldName } from './layout.ts'
import { SURFACE_WORKGROUP, buildSurfaceShaders } from './shaders.ts'
import type { SurfaceShaderOptions } from './shaders.ts'
import type { CoefficientLut } from './coefficients.ts'
import type { MoistureVector } from './rothermel.ts'

export interface SurfaceGrid {
  /** 3 u32 planes, structure-of-arrays. Plane p starts at `p * SURFACE_CELL_COUNT` words. */
  readonly stateWords: GPUBuffer
  /** r32float level set. Ping-pong: ENO2 reads a ±2-cell neighbourhood. Index with `phiIndex`. */
  readonly phi: readonly [GPUBuffer, GPUBuffer]
  /** r32float t_ign, written with atomicMin — order-independent, so no ping-pong. */
  readonly ignitionTime: GPUBuffer
  /** 2×u32 = pack2x16float(R_head, LB) and pack2x16float(headingX, headingY). */
  readonly ellipseCache: GPUBuffer
  /** 1×u32 = pack2x16float(R0 [m/s], I_R [kW/m²]). The §4.3 factorisation cache. */
  readonly rosBase: GPUBuffer
  readonly fuelLut: GPUBuffer
  destroy(): void
}

export function createSurfaceGrid(device: GPUDevice, lut: CoefficientLut): SurfaceGrid {
  const n = SURFACE_CELL_COUNT
  // Read at call time, not at module scope: `GPUBufferUsage` is a runtime global and does
  // not exist under Node, where the pure parts of this package are unit-tested.
  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  const buf = (label: string, bytes: number, usage = STORAGE): GPUBuffer =>
    device.createBuffer({ label: `surface.${label}`, size: bytes, usage })

  const fuelLut = buf('fuelLut', lut.data.byteLength)
  device.queue.writeBuffer(fuelLut, 0, lut.data)

  const grid: SurfaceGrid = {
    stateWords: buf('stateWords', n * 4 * PLANE_COUNT),
    phi: [buf('phi0', n * 4), buf('phi1', n * 4)],
    ignitionTime: buf('ignitionTime', n * 4),
    ellipseCache: buf('ellipseCache', n * 8),
    rosBase: buf('rosBase', n * 4),
    fuelLut,
    destroy() {
      this.stateWords.destroy()
      this.phi[0].destroy()
      this.phi[1].destroy()
      this.ignitionTime.destroy()
      this.ellipseCache.destroy()
      this.rosBase.destroy()
      this.fuelLut.destroy()
    },
  }
  return grid
}

// ---------------------------------------------------------------------------
// Writing cell state
// ---------------------------------------------------------------------------

export interface CellInit {
  readonly fuelModelId: number
  readonly flags: number
  /** FRACTION, 5 channels, in `MoistureVector` order. */
  readonly moisture: MoistureVector
  /** Remaining mass FRACTION per size class, 0-1. Defaults to untouched fuel. */
  readonly mass?: readonly [number, number, number, number, number]
}

/** Pack one cell into its three plane words. Mirrored by `loadCellState` in common.wgsl. */
export function packCell(c: CellInit): [number, number, number] {
  const w: [number, number, number] = [0, 0, 0]
  writeField(w, 'fuelModelId', c.fuelModelId)
  writeField(w, 'flags', c.flags)
  writeField(w, 'moistureDead1h', c.moisture[0])
  writeField(w, 'moistureDead10h', c.moisture[1])
  writeField(w, 'moistureDead100h', c.moisture[2])
  writeField(w, 'moistureLiveHerb', c.moisture[3])
  writeField(w, 'moistureLiveWoody', c.moisture[4])
  const mass = c.mass ?? [1, 1, 1, 1, 1]
  const massFields: readonly FieldName[] = ['mass1h', 'mass10h', 'mass100h', 'massHerb', 'massWoody']
  massFields.forEach((f, i) => writeField(w, f, mass[i] ?? 1))
  return w
}

/**
 * Write `cells[i]` into cell index `i`. Three `writeBuffer` calls, one per plane — the whole
 * point of the SoA layout is that a run of cells is contiguous in each plane.
 */
export function writeContiguousCells(
  device: GPUDevice,
  grid: SurfaceGrid,
  cells: readonly CellInit[],
): void {
  const planes = [new Uint32Array(cells.length), new Uint32Array(cells.length), new Uint32Array(cells.length)]
  cells.forEach((c, i) => {
    const w = packCell(c)
    planes[0]![i] = w[0]
    planes[1]![i] = w[1]
    planes[2]![i] = w[2]
  })
  for (let p = 0; p < PLANE_COUNT; p++) {
    device.queue.writeBuffer(grid.stateWords, p * SURFACE_CELL_COUNT * 4, planes[p]!)
  }
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

export interface SurfaceWeatherUniform {
  /** MIDFLAME wind, m/s. */
  readonly midflameWind: number
  /** Azimuth the wind blows TOWARD, radians clockwise from north. */
  readonly windAzimuth: number
}

export interface SurfaceRosPasses {
  /** ~1 Hz sim time: re-evaluate R₀ and I_R from the moisture field. */
  encodeMoistureTick(encoder: GPUCommandEncoder): void
  /** Every substep: wind and slope factors, ellipse parameters. */
  encodeSubstep(encoder: GPUCommandEncoder, weather: SurfaceWeatherUniform): void
  destroy(): void
}

const DISPATCH = Math.ceil(SURFACE_CELLS / SURFACE_WORKGROUP)

export function createSurfaceRosPasses(
  device: GPUDevice,
  grid: SurfaceGrid,
  slopeAspect: GPUTextureView,
  opts: SurfaceShaderOptions,
): SurfaceRosPasses {
  const src = buildSurfaceShaders(opts)

  const paramsBuffer = device.createBuffer({
    label: 'surface.substepParams',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const params = new Float32Array(4)

  const readOnly: GPUBufferBindingLayout = { type: 'read-only-storage' }
  const readWrite: GPUBufferBindingLayout = { type: 'storage' }

  const baseLayout = device.createBindGroupLayout({
    label: 'surface.rosBase',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: readOnly },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: readOnly },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: readWrite },
    ],
  })
  const substepLayout = device.createBindGroupLayout({
    label: 'surface.rosSubstep',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: readOnly },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: readOnly },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: readOnly },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: readWrite },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  })

  const pipeline = (label: string, code: string, layout: GPUBindGroupLayout): GPUComputePipeline =>
    device.createComputePipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    })

  const basePipeline = pipeline('surface.ros_base', src.rosBase, baseLayout)
  const substepPipeline = pipeline('surface.ros_substep', src.rosSubstep, substepLayout)

  const baseGroup = device.createBindGroup({
    layout: baseLayout,
    entries: [
      { binding: 0, resource: { buffer: grid.stateWords } },
      { binding: 1, resource: { buffer: grid.fuelLut } },
      { binding: 2, resource: { buffer: grid.rosBase } },
    ],
  })
  const substepGroup = device.createBindGroup({
    layout: substepLayout,
    entries: [
      { binding: 0, resource: { buffer: grid.stateWords } },
      { binding: 1, resource: { buffer: grid.fuelLut } },
      { binding: 2, resource: { buffer: grid.rosBase } },
      { binding: 3, resource: { buffer: grid.ellipseCache } },
      { binding: 4, resource: slopeAspect },
      { binding: 5, resource: { buffer: paramsBuffer } },
    ],
  })

  const run = (encoder: GPUCommandEncoder, label: string, p: GPUComputePipeline, g: GPUBindGroup) => {
    const pass = encoder.beginComputePass({ label })
    pass.setPipeline(p)
    pass.setBindGroup(0, g)
    pass.dispatchWorkgroups(DISPATCH, DISPATCH, 1)
    pass.end()
  }

  return {
    encodeMoistureTick(encoder) {
      run(encoder, 'surface.moistureTick', basePipeline, baseGroup)
    },
    encodeSubstep(encoder, weather) {
      params[0] = weather.midflameWind
      params[1] = weather.windAzimuth
      device.queue.writeBuffer(paramsBuffer, 0, params)
      run(encoder, 'surface.substep', substepPipeline, substepGroup)
    },
    destroy() {
      paramsBuffer.destroy()
    },
  }
}

/** Exposed so the GPU test can assert the byte offsets it reads back. */
export const PLANE_WORD_OFFSET = (plane: number): number => plane * SURFACE_CELL_COUNT
export { FIELDS }
