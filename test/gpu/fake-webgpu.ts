/**
 * A deterministic in-memory stand-in for the slice of WebGPU that work package 1.1 touches.
 *
 * Not a mock of a sibling package (rule D of the fan-out): it is a stub of the *platform*,
 * living inside this package's own test tree. It exists because the parts of the device
 * bring-up and the profiler that can actually be wrong — limit clamping, feature
 * negotiation, the ring-buffer state machine, the "never map a buffer touched this frame"
 * rule — are pure bookkeeping around a handful of API calls, and none of that bookkeeping
 * needs a GPU to be checked.
 *
 * Deliberately faithful in the two places fidelity matters:
 *
 * - `mapAsync` completion is a *deferred* promise. Tests can hold all three staging buffers
 *   in flight and assert the profiler drops a sample rather than stalling.
 * - `resolveQuerySet` writes whatever timestamps the test scripted, and
 *   `copyBufferToBuffer` really copies bytes, so the profiler's readback path is exercised
 *   end to end rather than short-circuited.
 */

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

/**
 * `GPUBufferUsage` and friends are runtime globals in a browser and simply absent under
 * Node. The values are the ones the WebGPU specification fixes, so code under test sees the
 * same bit patterns it would in Chrome.
 */
export function installWebGPUGlobals(): void {
  const g = globalThis as Record<string, unknown>
  g['GPUBufferUsage'] ??= {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  }
  g['GPUMapMode'] ??= { READ: 0x0001, WRITE: 0x0002 }
  g['GPUTextureUsage'] ??= {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  }
  g['GPUShaderStage'] ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 }
}

installWebGPUGlobals()

/** Let every queued microtask (and any promise chained onto one) run. */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Deferred completion
// ---------------------------------------------------------------------------

/** Gate for `mapAsync` / `onSubmittedWorkDone` completion, so tests control the timeline. */
export class CompletionGate {
  #pending: (() => void)[] = []
  /** When true, work completes on the next microtask instead of waiting for `flush()`. */
  auto = true

  enqueue(apply: () => void): Promise<undefined> {
    if (this.auto) {
      return Promise.resolve().then(() => {
        apply()
        return undefined
      })
    }
    return new Promise<undefined>((resolve) => {
      this.#pending.push(() => {
        apply()
        resolve(undefined)
      })
    })
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  flush(): void {
    const pending = this.#pending
    this.#pending = []
    for (const f of pending) f()
  }
}

// ---------------------------------------------------------------------------
// Buffers, query sets, encoders
// ---------------------------------------------------------------------------

export class FakeBuffer {
  readonly bytes: Uint8Array
  destroyed = false
  mapRequests = 0
  #mapped = false
  #mappedOffset = 0
  #mappedSize = 0

  constructor(
    readonly label: string,
    readonly size: number,
    readonly usage: number,
    readonly gate: CompletionGate,
  ) {
    this.bytes = new Uint8Array(size)
  }

  mapAsync(_mode: number, offset = 0, size?: number): Promise<undefined> {
    if (this.destroyed) return Promise.reject(new Error(`buffer ${this.label} is destroyed`))
    if (this.#mapped) return Promise.reject(new Error(`buffer ${this.label} is already mapped`))
    this.mapRequests += 1
    const sz = size ?? this.size - offset
    return this.gate.enqueue(() => {
      if (this.destroyed) throw new Error(`buffer ${this.label} destroyed before map completed`)
      this.#mapped = true
      this.#mappedOffset = offset
      this.#mappedSize = sz
    })
  }

  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    if (!this.#mapped) throw new Error(`buffer ${this.label} is not mapped`)
    const sz = size ?? this.#mappedSize - (offset - this.#mappedOffset)
    return this.bytes.slice(offset, offset + sz).buffer
  }

  unmap(): void {
    this.#mapped = false
  }

  get isMapped(): boolean {
    return this.#mapped
  }

  destroy(): void {
    this.destroyed = true
  }
}

export class FakeQuerySet {
  destroyed = false
  constructor(
    readonly label: string,
    readonly type: string,
    readonly count: number,
  ) {}
  destroy(): void {
    this.destroyed = true
  }
}

export interface RecordedPass {
  readonly kind: 'compute' | 'render'
  readonly label: string | undefined
  readonly timed: boolean
  readonly beginIndex: number | undefined
  readonly endIndex: number | undefined
}

export class FakePass {
  ended = false
  end(): void {
    if (this.ended) throw new Error('pass ended twice')
    this.ended = true
  }
  setPipeline(): void {}
  setBindGroup(): void {}
  dispatchWorkgroups(): void {}
  draw(): void {}
}

export class FakeCommandEncoder {
  readonly passes: RecordedPass[] = []
  readonly openPasses: FakePass[] = []
  readonly debugGroupStack: string[] = []
  readonly debugGroups: string[] = []
  readonly copies: { src: string; dst: string; size: number }[] = []
  resolveCalls = 0
  finished = false

  constructor(
    readonly label: string | undefined,
    readonly device: FakeDevice,
  ) {}

  #begin(kind: 'compute' | 'render', desc: Record<string, unknown> | undefined): FakePass {
    const tw = desc?.['timestampWrites'] as
      | { beginningOfPassWriteIndex?: number; endOfPassWriteIndex?: number }
      | undefined
    this.passes.push({
      kind,
      label: desc?.['label'] as string | undefined,
      timed: tw !== undefined,
      beginIndex: tw?.beginningOfPassWriteIndex,
      endIndex: tw?.endOfPassWriteIndex,
    })
    const pass = new FakePass()
    this.openPasses.push(pass)
    return pass
  }

  beginComputePass(desc?: Record<string, unknown>): FakePass {
    return this.#begin('compute', desc)
  }

  beginRenderPass(desc?: Record<string, unknown>): FakePass {
    return this.#begin('render', desc)
  }

  resolveQuerySet(
    _querySet: FakeQuerySet,
    firstQuery: number,
    queryCount: number,
    destination: FakeBuffer,
    destinationOffset: number,
  ): void {
    this.resolveCalls += 1
    this.device.writeScriptedTimestamps(destination, destinationOffset, firstQuery, queryCount)
  }

  copyBufferToBuffer(
    source: FakeBuffer,
    sourceOffset: number,
    destination: FakeBuffer,
    destinationOffset: number,
    size: number,
  ): void {
    destination.bytes.set(source.bytes.subarray(sourceOffset, sourceOffset + size), destinationOffset)
    this.copies.push({ src: source.label, dst: destination.label, size })
  }

  pushDebugGroup(label: string): void {
    this.debugGroupStack.push(label)
    this.debugGroups.push(label)
  }

  popDebugGroup(): void {
    if (this.debugGroupStack.length === 0) throw new Error('popDebugGroup with no open group')
    this.debugGroupStack.pop()
  }

  finish(): { label: string | undefined } {
    if (this.openPasses.some((p) => !p.ended)) {
      throw new Error('finish() with an unfinished pass — this would be a validation error')
    }
    if (this.debugGroupStack.length > 0) throw new Error('finish() with an open debug group')
    this.finished = true
    return { label: this.label }
  }
}

// ---------------------------------------------------------------------------
// Device and queue
// ---------------------------------------------------------------------------

/** Adapter/device limits for the target machine (RTX 4070 Laptop, Chrome/D3D12, Win11). */
export const ADA_LIMITS: Record<string, number> = {
  maxStorageBufferBindingSize: 2_147_483_643,
  maxBufferSize: 2_147_483_644,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024,
  maxComputeWorkgroupSizeY: 1024,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupStorageSize: 32768,
  maxComputeWorkgroupsPerDimension: 65535,
  maxStorageBuffersPerShaderStage: 16,
  maxStorageTexturesPerShaderStage: 8,
  maxTextureDimension2D: 16384,
  maxTextureDimension3D: 2048,
  maxBindGroups: 4,
}

/** Limits of a device that grants only the WebGPU spec defaults. */
export const DEFAULT_LIMITS: Record<string, number> = {
  maxStorageBufferBindingSize: 134_217_728,
  maxBufferSize: 268_435_456,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeWorkgroupsPerDimension: 65535,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxBindGroups: 4,
}

export class FakeQueue {
  readonly submits: unknown[][] = []
  readonly workDoneGate = new CompletionGate()

  submit(buffers: unknown[]): void {
    this.submits.push(buffers)
  }

  onSubmittedWorkDone(): Promise<undefined> {
    return this.workDoneGate.enqueue(() => {})
  }
}

export interface FakeDeviceOptions {
  readonly features?: readonly string[]
  readonly limits?: Record<string, number>
  readonly label?: string
}

export class FakeDevice {
  readonly features: Set<string>
  readonly limits: Record<string, number>
  readonly queue = new FakeQueue()
  readonly buffers: FakeBuffer[] = []
  readonly querySets: FakeQuerySet[] = []
  readonly encoders: FakeCommandEncoder[] = []
  readonly mapGate = new CompletionGate()
  readonly label: string
  destroyed = false

  /** Timestamps (ns) `resolveQuerySet` will write, indexed by query slot. */
  scriptedTimestamps: BigUint64Array = new BigUint64Array(0)

  #lostResolve!: (info: GPUDeviceLostInfo) => void
  readonly lost: Promise<GPUDeviceLostInfo>

  constructor(options: FakeDeviceOptions = {}) {
    this.features = new Set(options.features ?? [])
    this.limits = { ...(options.limits ?? ADA_LIMITS) }
    this.label = options.label ?? 'fake'
    this.lost = new Promise<GPUDeviceLostInfo>((resolve) => {
      this.#lostResolve = resolve
    })
  }

  createBuffer(desc: { label?: string; size: number; usage: number }): FakeBuffer {
    const b = new FakeBuffer(desc.label ?? '', desc.size, desc.usage, this.mapGate)
    this.buffers.push(b)
    return b
  }

  createQuerySet(desc: { label?: string; type: string; count: number }): FakeQuerySet {
    const q = new FakeQuerySet(desc.label ?? '', desc.type, desc.count)
    this.querySets.push(q)
    return q
  }

  createCommandEncoder(desc?: { label?: string }): FakeCommandEncoder {
    const e = new FakeCommandEncoder(desc?.label, this)
    this.encoders.push(e)
    return e
  }

  destroy(): void {
    this.destroyed = true
    this.#lostResolve({ reason: 'destroyed', message: 'destroy() was called' } as GPUDeviceLostInfo)
  }

  /** Simulate a driver reset / TDR (spec §6.8 pitfall 6). */
  simulateLoss(reason: GPUDeviceLostReason = 'unknown' as GPUDeviceLostReason, message = 'TDR'): void {
    this.#lostResolve({ reason, message } as GPUDeviceLostInfo)
  }

  writeScriptedTimestamps(
    destination: FakeBuffer,
    destinationOffset: number,
    firstQuery: number,
    queryCount: number,
  ): void {
    const view = new DataView(destination.bytes.buffer, destination.bytes.byteOffset)
    for (let i = 0; i < queryCount; i++) {
      const v = this.scriptedTimestamps[firstQuery + i] ?? 0n
      view.setBigUint64(destinationOffset + i * 8, v, true)
    }
  }

  /** Cast to the real type at the boundary; the shape above is the subset actually used. */
  asDevice(): GPUDevice {
    return this as unknown as GPUDevice
  }
}

// ---------------------------------------------------------------------------
// Adapter and navigator.gpu
// ---------------------------------------------------------------------------

export interface FakeAdapterOptions {
  readonly info?: Partial<GPUAdapterInfo>
  readonly features?: readonly string[]
  readonly limits?: Record<string, number>
  /** Reject `requestDevice` — the failure mode when a requested limit exceeds the adapter. */
  readonly failDevice?: string
}

export class FakeAdapter {
  readonly features: Set<string>
  readonly limits: Record<string, number>
  readonly info: GPUAdapterInfo
  lastDeviceDescriptor: GPUDeviceDescriptor | undefined
  device: FakeDevice | undefined

  constructor(readonly options: FakeAdapterOptions = {}) {
    this.features = new Set(options.features ?? [])
    this.limits = { ...(options.limits ?? ADA_LIMITS) }
    this.info = {
      vendor: '',
      architecture: '',
      device: '',
      description: '',
      ...options.info,
    } as GPUAdapterInfo
  }

  async requestDevice(desc?: GPUDeviceDescriptor): Promise<FakeDevice> {
    this.lastDeviceDescriptor = desc
    if (this.options.failDevice) throw new TypeError(this.options.failDevice)
    // Mirror the real validation: an over-large limit is a hard rejection, not a downgrade.
    for (const [key, value] of Object.entries(desc?.requiredLimits ?? {})) {
      const cap = this.limits[key]
      if (cap === undefined || (value as number) > cap) {
        throw new TypeError(`requiredLimits.${key} = ${String(value)} exceeds adapter maximum`)
      }
    }
    for (const f of desc?.requiredFeatures ?? []) {
      if (!this.features.has(f)) throw new TypeError(`feature ${f} is not available`)
    }
    const opts: FakeDeviceOptions = {
      features: [...(desc?.requiredFeatures ?? [])] as string[],
      limits: { ...(desc?.requiredLimits as Record<string, number> | undefined) },
      label: desc?.label ?? 'fake',
    }
    this.device = new FakeDevice(opts)
    return this.device
  }
}

export interface FakeGpuOptions {
  readonly adapter?: FakeAdapter | null
  readonly preferredFormat?: GPUTextureFormat
}

export class FakeGpu {
  lastRequest: GPURequestAdapterOptions | undefined
  constructor(readonly options: FakeGpuOptions = {}) {}

  async requestAdapter(opts?: GPURequestAdapterOptions): Promise<FakeAdapter | null> {
    this.lastRequest = opts
    const a = this.options.adapter
    return a === undefined ? new FakeAdapter() : a
  }

  getPreferredCanvasFormat(): GPUTextureFormat {
    return this.options.preferredFormat ?? ('bgra8unorm' as GPUTextureFormat)
  }

  asGpu(): GPU {
    return this as unknown as GPU
  }
}

/** Minimal canvas with a WebGPU context, for the swapchain-configuring path. */
export class FakeCanvas {
  clientWidth = 1280
  clientHeight = 720
  width = 300
  height = 150
  readonly context = {
    configured: undefined as Record<string, unknown> | undefined,
    unconfigureCount: 0,
    configure(desc: Record<string, unknown>): void {
      this.configured = desc
    },
    unconfigure(): void {
      this.unconfigureCount += 1
    },
    getCurrentTexture(): unknown {
      throw new Error('no swapchain in the fake')
    },
  }

  getContext(kind: string): unknown {
    return kind === 'webgpu' ? this.context : null
  }

  asCanvas(): HTMLCanvasElement {
    return this as unknown as HTMLCanvasElement
  }
}

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

/**
 * Seeded PRNG (mulberry32). Every statistical assertion in this package is about a
 * *converged mean*, and a converged mean tested with `Math.random()` is a flaky test that
 * fails once a month for no reproducible reason. Seeded, it either passes or it is a real
 * regression.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
