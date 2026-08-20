/**
 * Device bring-up — work package 1.1.
 *
 * Implements `IDevice` from `@contracts/gpu`. See docs/spec/10-webgpu-architecture.md §6.1
 * (limit envelope) and §6.8 pitfall 1 (hybrid-GPU laptops).
 *
 * The target machine is a hybrid-GPU laptop (RTX 4070 Laptop + Intel Xe-LPG iGPU). Chrome
 * on Windows generally hands back whichever adapter the browser process is already using,
 * which is usually the iGPU, and `powerPreference: 'high-performance'` is documented as
 * having no effect there. A silent iGPU fallback is ~1/8 the compute and ~1/4 the
 * bandwidth: it reads as a catastrophic performance regression that is not real. So the
 * boot path reports the adapter it actually got and flags it.
 *
 * The negotiation logic here is lifted from the original `src/main.ts` boot path and
 * extended to the full limit set the architecture section asks for.
 */

import type { AdapterReport, WantedFeature } from '@contracts/gpu'
import { WANTED_FEATURES } from '@contracts/gpu'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Limits the simulation and renderer actually depend on, requested above the WebGPU spec
 * defaults. From spec §6.1: *"We request `maxStorageBufferBindingSize: 1 GiB`,
 * `maxBufferSize: 1 GiB`, `maxComputeInvocationsPerWorkgroup: 1024`,
 * `maxComputeWorkgroupSizeX/Y: 1024`, `maxComputeWorkgroupStorageSize: 32768`,
 * `maxStorageBuffersPerShaderStage: 16`, `maxStorageTexturesPerShaderStage: 8`"*.
 *
 * Every one of these is a "better is higher" limit, which is what makes the `Math.min`
 * clamp in {@link clampLimits} the correct direction. Do not add a "better is lower" limit
 * (`minStorageBufferOffsetAlignment`, `minUniformBufferOffsetAlignment`) to this table
 * without also inverting its clamp — those are only ever *lowered*, and §6.1 says not to.
 */
export const REQUIRED_LIMITS = {
  // The 2048² surface grid and the sparse canopy voxel pool both exceed the 128 MiB
  // default storage-buffer binding cap. Every field is SoA precisely so we do not *rely*
  // on this being granted, but where it is granted it removes a whole class of tiling.
  maxStorageBufferBindingSize: 1024 * 1024 * 1024,
  maxBufferSize: 1024 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024,
  maxComputeWorkgroupSizeY: 1024,
  // 5 fields x 2 B x 12³ halo brick = 17.3 KB of workgroup storage for the canopy stencil
  // passes, which exceeds the 16 KiB default. §6.4.
  maxComputeWorkgroupStorageSize: 32768,
  maxStorageBuffersPerShaderStage: 16,
  maxStorageTexturesPerShaderStage: 8,
} as const satisfies Record<string, number>

export type LimitName = keyof typeof REQUIRED_LIMITS

export interface LimitShortfall {
  readonly limit: string
  readonly wanted: number
  readonly got: number
}

export interface ClampedLimits {
  /** What to hand to `requestDevice({ requiredLimits })`. Never exceeds the adapter. */
  readonly requested: Record<string, number>
  /** Limits the adapter could not satisfy. Empty on the target hardware. */
  readonly shortfalls: readonly LimitShortfall[]
}

/**
 * Clamp every requested limit to what the adapter actually supports.
 *
 * Requesting a limit above the adapter maximum **rejects device creation outright** — it is
 * a hard failure, not a silent downgrade — so the clamp is mandatory, and the shortfall
 * list is how the rest of the system learns that a capability tier fallback is needed.
 */
export function clampLimits(adapterLimits: GPUSupportedLimits): ClampedLimits {
  const requested: Record<string, number> = {}
  const shortfalls: LimitShortfall[] = []
  for (const key of Object.keys(REQUIRED_LIMITS) as LimitName[]) {
    const wanted = REQUIRED_LIMITS[key]
    // An adapter is required to report every core limit, but a defensive read costs
    // nothing and keeps a partial fake (or a future limit rename) from producing NaN.
    const got = adapterLimits[key]
    if (typeof got !== 'number' || !Number.isFinite(got)) {
      shortfalls.push({ limit: key, wanted, got: 0 })
      continue
    }
    requested[key] = Math.min(wanted, got)
    if (got < wanted) shortfalls.push({ limit: key, wanted, got })
  }
  return { requested, shortfalls }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * Ask for exactly the wanted features the adapter reports. Requesting a feature the adapter
 * does not have is, like an over-large limit, a hard device-creation failure.
 */
export function negotiateFeatures(available: {
  has(name: string): boolean
}): WantedFeature[] {
  return WANTED_FEATURES.filter((f) => available.has(f))
}

// ---------------------------------------------------------------------------
// The "is this the discrete GPU?" heuristic
// ---------------------------------------------------------------------------

/**
 * Substrings that identify an integrated, software or mobile adapter. `adapter.info` is
 * unnormalised vendor text, so this is a heuristic and is named as one.
 */
const INTEGRATED_MARKERS =
  /\b(intel|uhd|iris|xe-lpg|integrated|llvmpipe|swiftshader|microsoft basic|warp|mali|adreno|apple m\d)\b/

/** Substrings that positively identify the discrete parts this project targets. */
const DISCRETE_MARKERS = /\b(nvidia|geforce|rtx|gtx|quadro|radeon|amd|arc a\d)\b/

/** Flatten `GPUAdapterInfo` into the lowercase haystack both heuristics search. */
export function adapterHaystack(info: {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
}): string {
  return [info.vendor, info.architecture, info.device, info.description]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase()
}

/**
 * Does this adapter look integrated?
 *
 * A positive discrete marker wins over an integrated one, because descriptions like
 * "NVIDIA GeForce RTX 4070 Laptop GPU" on an Intel-chipset machine can carry both. When
 * `adapter.info` is entirely empty — which some browser/privacy configurations produce —
 * this returns `false`: claiming "integrated" on no evidence would fire the blocking modal
 * of §6.8 on a perfectly good discrete GPU. The absence of evidence is visible instead in
 * {@link AdapterReport.description}, which is empty in that case.
 */
export function looksIntegrated(info: {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
}): boolean {
  const hay = adapterHaystack(info)
  if (hay.length === 0) return false
  if (DISCRETE_MARKERS.test(hay)) return false
  return INTEGRATED_MARKERS.test(hay)
}

/** Human-readable adapter name for the HUD and for every exported performance figure. */
export function adapterName(info: {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
}): string {
  const parts = [info.vendor, info.architecture, info.device].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  return parts.length > 0 ? parts.join(' / ') : (info.description ?? '') || '(unreported)'
}

export function buildAdapterReport(
  info: GPUAdapterInfo,
  granted: readonly WantedFeature[],
  shortfalls: readonly LimitShortfall[],
): AdapterReport {
  return {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
    looksIntegrated: looksIntegrated(info),
    grantedFeatures: granted,
    limitShortfalls: shortfalls,
  }
}

// ---------------------------------------------------------------------------
// Device creation
// ---------------------------------------------------------------------------

export interface DeviceOptions {
  /** Canvas to configure. Omit to bring up a device with no swapchain (tests, workers). */
  readonly canvas?: HTMLCanvasElement
  /** Defaults to `'opaque'`; the froxel compositing path never needs canvas alpha. */
  readonly alphaMode?: GPUCanvasAlphaMode
  /**
   * Called when the device is lost for any reason other than an explicit
   * {@link Device.destroy}. §6.8 pitfall 6: a Windows TDR from a >2 s dispatch surfaces
   * here, and the correct response is to rebuild resources, not to show a black canvas.
   */
  readonly onDeviceLost?: (info: GPUDeviceLostInfo) => void
  /** Injection seam for tests. Defaults to `navigator.gpu`. */
  readonly gpu?: GPU
}

export class DeviceError extends Error {
  override readonly name = 'DeviceError'
  constructor(
    message: string,
    /** Machine-readable cause, so the UI can pick the right remediation text. */
    readonly code:
      | 'no-webgpu'
      | 'no-adapter'
      | 'device-request-failed'
      | 'no-canvas-context',
  ) {
    super(message)
  }
}

/** Concrete `IDevice`. Construct via {@link createDevice}. */
export class Device {
  readonly device: GPUDevice
  readonly context: GPUCanvasContext
  readonly canvasFormat: GPUTextureFormat
  readonly report: AdapterReport
  readonly lost: Promise<GPUDeviceLostInfo>

  #destroyed = false
  readonly #features: ReadonlySet<string>

  constructor(init: {
    device: GPUDevice
    context: GPUCanvasContext
    canvasFormat: GPUTextureFormat
    report: AdapterReport
  }) {
    this.device = init.device
    this.context = init.context
    this.canvasFormat = init.canvasFormat
    this.report = init.report
    this.#features = new Set(init.report.grantedFeatures)
    this.lost = init.device.lost
  }

  has(feature: WantedFeature): boolean {
    return this.#features.has(feature)
  }

  get destroyed(): boolean {
    return this.#destroyed
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    // Unconfiguring first releases the swapchain textures before the device goes away,
    // which avoids a "destroyed device" validation error from an in-flight present.
    try {
      this.context.unconfigure()
    } catch {
      // A context whose canvas is already gone throws here; nothing to recover.
    }
    this.device.destroy()
  }
}

/**
 * A canvas context stand-in for headless bring-up (tests, compute-only workers). Every
 * method throws, so a code path that quietly assumes a swapchain fails loudly rather than
 * rendering into nothing.
 */
function headlessContext(): GPUCanvasContext {
  const fail = (): never => {
    throw new DeviceError(
      'This device was created without a canvas; there is no swapchain to present to.',
      'no-canvas-context',
    )
  }
  return {
    canvas: undefined as unknown as HTMLCanvasElement,
    configure: fail,
    unconfigure: () => {},
    getConfiguration: () => null,
    getCurrentTexture: fail,
  } as unknown as GPUCanvasContext
}

/**
 * Request an adapter and device with the project's feature and limit envelope, and
 * configure the canvas.
 *
 * Failure modes are explicit `DeviceError`s rather than `undefined` returns: every one of
 * them needs a different message in front of the user, and none of them is recoverable by
 * the caller retrying.
 */
export async function createDevice(options: DeviceOptions = {}): Promise<Device> {
  const gpu = options.gpu ?? (typeof navigator !== 'undefined' ? navigator.gpu : undefined)
  if (!gpu) {
    throw new DeviceError(
      'WebGPU is not available in this browser. ForestFire needs Chrome or Edge 113+ with WebGPU enabled.',
      'no-webgpu',
    )
  }

  // Still ask for high-performance even though §6.8 records that it is a no-op on Windows:
  // it does work on macOS and on some Windows configurations, and it costs nothing.
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) {
    throw new DeviceError(
      'No WebGPU adapter was returned. Check GPU drivers and browser flags.',
      'no-adapter',
    )
  }

  const granted = negotiateFeatures(adapter.features)
  const { requested, shortfalls } = clampLimits(adapter.limits)

  let device: GPUDevice
  try {
    device = await adapter.requestDevice({
      label: 'forestfire',
      requiredFeatures: granted as unknown as GPUFeatureName[],
      requiredLimits: requested,
    })
  } catch (err) {
    throw new DeviceError(
      `requestDevice() failed: ${err instanceof Error ? err.message : String(err)}`,
      'device-request-failed',
    )
  }

  // Trust the *device*, not the adapter, for what was actually granted.
  const actuallyGranted = granted.filter((f) => device.features.has(f))
  const report = buildAdapterReport(adapter.info, actuallyGranted, shortfalls)

  let context: GPUCanvasContext
  let canvasFormat: GPUTextureFormat
  if (options.canvas) {
    const ctx = options.canvas.getContext('webgpu')
    if (!ctx) {
      device.destroy()
      throw new DeviceError('Could not acquire a WebGPU canvas context.', 'no-canvas-context')
    }
    context = ctx
    canvasFormat = gpu.getPreferredCanvasFormat()
    context.configure({
      device,
      format: canvasFormat,
      alphaMode: options.alphaMode ?? 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
  } else {
    context = headlessContext()
    canvasFormat = gpu.getPreferredCanvasFormat()
  }

  const wrapper = new Device({ device, context, canvasFormat, report })

  if (options.onDeviceLost) {
    const onLost = options.onDeviceLost
    void device.lost.then((info) => {
      // 'destroyed' is our own destroy() call; anything else is a real loss (TDR, driver
      // reset, adapter removal) and needs resource rebuilding.
      if (info.reason !== 'destroyed') onLost(info)
    })
  }

  return wrapper
}

// ---------------------------------------------------------------------------
// Canvas sizing
// ---------------------------------------------------------------------------

/**
 * Size the canvas backing store to its CSS box, capped at `maxDpr` and at the device's
 * `maxTextureDimension2D`. Returns true when the size changed, so the caller can rebuild
 * size-dependent targets exactly on the frames where it matters.
 *
 * Kept separate from `Device` because render-target sizing is also driven by the quality
 * controller's `resolutionScale`, and the two must not both own the canvas.
 */
export function syncCanvasSize(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  maxDpr = 2,
): boolean {
  const dpr = Math.min(globalThis.devicePixelRatio ?? 1, maxDpr)
  const cap = device.limits.maxTextureDimension2D
  const w = Math.max(1, Math.min(cap, Math.floor(canvas.clientWidth * dpr)))
  const h = Math.max(1, Math.min(cap, Math.floor(canvas.clientHeight * dpr)))
  if (canvas.width === w && canvas.height === h) return false
  canvas.width = w
  canvas.height = h
  return true
}
