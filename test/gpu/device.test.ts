/**
 * Device bring-up — work package 1.1.
 *
 * The two things here that can be silently, expensively wrong are both pure functions over
 * adapter data, and both are tested exhaustively:
 *
 * 1. **Limit clamping.** Requesting a limit above the adapter maximum rejects device
 *    creation outright (spec §6.1) — it is not a downgrade, it is a black screen. The clamp
 *    must never emit a value the adapter cannot meet, and it must record every shortfall so
 *    the capability-tier fallbacks know to engage.
 * 2. **The looksIntegrated heuristic.** §6.8 pitfall 1: Chrome on Windows generally hands
 *    back the iGPU regardless of `powerPreference`, and the resulting ~8x slowdown reads as
 *    a catastrophic regression that is not real. Every performance figure this project
 *    records carries this flag, so a false negative silently corrupts the record.
 */

import { describe, expect, it, vi } from 'vitest'
import type { AdapterReport } from '@contracts/gpu'
import { WANTED_FEATURES } from '@contracts/gpu'
import { HYBRID_GPU_REMEDIES, adapterAdvice, missingFeatures } from '@core/adapter-advice.ts'
import type { DeviceOptions } from '@core/device.ts'
import {
  Device,
  DeviceError,
  REQUIRED_LIMITS,
  adapterName,
  buildAdapterReport,
  clampLimits,
  createDevice,
  looksIntegrated,
  negotiateFeatures,
  syncCanvasSize,
} from '@core/device.ts'
import { ADA_LIMITS, DEFAULT_LIMITS, FakeAdapter, FakeCanvas, FakeGpu } from './fake-webgpu.ts'

const asLimits = (r: Record<string, number>): GPUSupportedLimits =>
  r as unknown as GPUSupportedLimits

describe('REQUIRED_LIMITS matches what spec §6.1 says we request', () => {
  it('asks for 1 GiB bindings and buffers, 1024 invocations and 32 KiB workgroup storage', () => {
    expect(REQUIRED_LIMITS.maxStorageBufferBindingSize).toBe(1024 * 1024 * 1024)
    expect(REQUIRED_LIMITS.maxBufferSize).toBe(1024 * 1024 * 1024)
    expect(REQUIRED_LIMITS.maxComputeInvocationsPerWorkgroup).toBe(1024)
    expect(REQUIRED_LIMITS.maxComputeWorkgroupStorageSize).toBe(32768)
    expect(REQUIRED_LIMITS.maxStorageBuffersPerShaderStage).toBe(16)
    expect(REQUIRED_LIMITS.maxStorageTexturesPerShaderStage).toBe(8)
  })

  it('never requests a limit D3D12 caps below the default, which would fail every device', () => {
    // maxComputeWorkgroupSizeZ (64) and maxComputeWorkgroupsPerDimension (65535) are hard
    // D3D12 caps; asking for more is an unconditional device-creation failure on Windows.
    expect(REQUIRED_LIMITS).not.toHaveProperty('maxComputeWorkgroupSizeZ')
    expect(REQUIRED_LIMITS).not.toHaveProperty('maxComputeWorkgroupsPerDimension')
    expect(REQUIRED_LIMITS).not.toHaveProperty('maxTextureDimension3D')
    expect(REQUIRED_LIMITS).not.toHaveProperty('maxBindGroups')
  })

  it('contains only "higher is better" limits, so Math.min is the right clamp', () => {
    for (const key of Object.keys(REQUIRED_LIMITS)) {
      expect(key, `${key} is a minimum-style limit and must not be clamped with Math.min`)
        .not.toMatch(/^min/)
    }
  })
})

describe('clampLimits', () => {
  it('passes everything through unclamped on the target adapter', () => {
    const { requested, shortfalls } = clampLimits(asLimits(ADA_LIMITS))
    expect(shortfalls).toEqual([])
    for (const [key, want] of Object.entries(REQUIRED_LIMITS)) {
      expect(requested[key]).toBe(want)
    }
  })

  it('never emits a value above the adapter maximum', () => {
    for (const limits of [ADA_LIMITS, DEFAULT_LIMITS]) {
      const { requested } = clampLimits(asLimits(limits))
      for (const [key, value] of Object.entries(requested)) {
        expect(value, `${key} exceeds the adapter and would reject requestDevice()`)
          .toBeLessThanOrEqual(limits[key]!)
      }
    }
  })

  it('records a shortfall for every limit the adapter cannot meet', () => {
    const { requested, shortfalls } = clampLimits(asLimits(DEFAULT_LIMITS))
    const names = shortfalls.map((s) => s.limit).sort()
    expect(names).toEqual([
      'maxBufferSize',
      'maxComputeInvocationsPerWorkgroup',
      'maxComputeWorkgroupSizeX',
      'maxComputeWorkgroupSizeY',
      'maxComputeWorkgroupStorageSize',
      'maxStorageBufferBindingSize',
      'maxStorageBuffersPerShaderStage',
      'maxStorageTexturesPerShaderStage',
    ])
    const binding = shortfalls.find((s) => s.limit === 'maxStorageBufferBindingSize')
    expect(binding).toEqual({
      limit: 'maxStorageBufferBindingSize',
      wanted: 1024 * 1024 * 1024,
      got: 134_217_728,
    })
    // Clamped, so the request still succeeds — degraded, not dead.
    expect(requested['maxStorageBufferBindingSize']).toBe(134_217_728)
  })

  it('treats a limit the adapter does not report at all as a shortfall, not as NaN', () => {
    const partial = { ...ADA_LIMITS }
    delete partial['maxComputeWorkgroupStorageSize']
    const { requested, shortfalls } = clampLimits(asLimits(partial))
    expect(requested).not.toHaveProperty('maxComputeWorkgroupStorageSize')
    expect(shortfalls.map((s) => s.limit)).toContain('maxComputeWorkgroupStorageSize')
    for (const value of Object.values(requested)) expect(Number.isFinite(value)).toBe(true)
  })
})

describe('negotiateFeatures', () => {
  it('requests exactly the wanted features the adapter has', () => {
    const adapter = new Set(['timestamp-query', 'shader-f16', 'depth-clip-control'])
    expect(negotiateFeatures(adapter)).toEqual(['timestamp-query', 'shader-f16'])
  })

  it('requests nothing when the adapter offers nothing — an absent feature is a hard fail', () => {
    expect(negotiateFeatures(new Set())).toEqual([])
  })

  it('covers the full wanted list from the contract', () => {
    expect(negotiateFeatures(new Set(WANTED_FEATURES))).toEqual([...WANTED_FEATURES])
    expect(WANTED_FEATURES).toContain('timestamp-query')
    expect(WANTED_FEATURES).toContain('subgroups')
  })
})

describe('looksIntegrated (spec §6.8 pitfall 1)', () => {
  const cases: [string, Partial<GPUAdapterInfo>, boolean][] = [
    [
      'RTX 4070 Laptop, the target part',
      { vendor: 'nvidia', architecture: 'ada-lovelace', device: '', description: 'NVIDIA GeForce RTX 4070 Laptop GPU' },
      false,
    ],
    [
      'Intel Xe-LPG iGPU, the silent fallback',
      { vendor: 'intel', architecture: 'xe-lpg', device: '', description: 'Intel(R) UHD Graphics' },
      true,
    ],
    ['Intel Iris Xe', { vendor: 'intel', description: 'Intel(R) Iris(R) Xe Graphics' }, true],
    ['SwiftShader software fallback', { vendor: 'google', description: 'SwiftShader Device' }, true],
    ['llvmpipe', { vendor: 'mesa', description: 'llvmpipe (LLVM 15.0.7, 256 bits)' }, true],
    ['Microsoft Basic Render Driver', { description: 'Microsoft Basic Render Driver' }, true],
    ['discrete AMD', { vendor: 'amd', description: 'AMD Radeon RX 7900 XT' }, false],
    [
      'Intel chipset host reporting a discrete NVIDIA part',
      { vendor: 'intel', description: 'NVIDIA GeForce RTX 4070 Laptop GPU' },
      false,
    ],
  ]

  for (const [name, info, expected] of cases) {
    it(`${expected ? 'flags' : 'clears'} ${name}`, () => {
      expect(looksIntegrated(info)).toBe(expected)
    })
  }

  it('does not cry wolf when adapter.info is masked to empty strings', () => {
    // Some privacy configurations report nothing. Claiming "integrated" on no evidence
    // would fire the blocking modal of §6.8 on a perfectly good discrete GPU; the absence
    // of information shows up as an empty description instead.
    expect(looksIntegrated({ vendor: '', architecture: '', device: '', description: '' })).toBe(false)
    expect(looksIntegrated({})).toBe(false)
  })

  it('matches on word boundaries, not on substrings inside unrelated words', () => {
    expect(looksIntegrated({ description: 'Winteldon 9000 Graphics' })).toBe(false)
  })
})

describe('adapterName', () => {
  it('joins the structured fields and falls back to the description', () => {
    expect(adapterName({ vendor: 'nvidia', architecture: 'ada-lovelace', device: '' })).toBe(
      'nvidia / ada-lovelace',
    )
    expect(adapterName({ description: 'NVIDIA GeForce RTX 4070' })).toBe('NVIDIA GeForce RTX 4070')
    expect(adapterName({})).toBe('(unreported)')
  })
})

describe('buildAdapterReport', () => {
  it('carries the granted features, the shortfalls and the integrated flag', () => {
    const info = {
      vendor: 'intel',
      architecture: 'xe-lpg',
      device: '',
      description: 'Intel(R) UHD Graphics',
    } as GPUAdapterInfo
    const report = buildAdapterReport(info, ['timestamp-query'], [
      { limit: 'maxBufferSize', wanted: 1 << 30, got: 1 << 28 },
    ])
    expect(report.looksIntegrated).toBe(true)
    expect(report.grantedFeatures).toEqual(['timestamp-query'])
    expect(report.limitShortfalls).toHaveLength(1)
    expect(report.vendor).toBe('intel')
  })
})

describe('createDevice', () => {
  const targetAdapter = (): FakeAdapter =>
    new FakeAdapter({
      features: [...WANTED_FEATURES],
      limits: ADA_LIMITS,
      info: {
        vendor: 'nvidia',
        architecture: 'ada-lovelace',
        device: '',
        description: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      } as Partial<GPUAdapterInfo>,
    })

  it('asks for the high-performance adapter', async () => {
    const gpu = new FakeGpu({ adapter: targetAdapter() })
    await createDevice({ gpu: gpu.asGpu() })
    expect(gpu.lastRequest?.powerPreference).toBe('high-performance')
  })

  it('hands requestDevice only clamped limits and available features', async () => {
    const adapter = targetAdapter()
    await createDevice({ gpu: new FakeGpu({ adapter }).asGpu() })
    const desc = adapter.lastDeviceDescriptor
    expect(desc?.requiredFeatures).toEqual([...WANTED_FEATURES])
    for (const [key, value] of Object.entries(desc?.requiredLimits ?? {})) {
      expect(value as number).toBeLessThanOrEqual(adapter.limits[key]!)
    }
  })

  it('survives a default-limits adapter by clamping, and reports the shortfalls', async () => {
    const adapter = new FakeAdapter({ features: ['timestamp-query'], limits: DEFAULT_LIMITS })
    const device = await createDevice({ gpu: new FakeGpu({ adapter }).asGpu() })
    expect(device.report.limitShortfalls.length).toBeGreaterThan(0)
    expect(device.report.grantedFeatures).toEqual(['timestamp-query'])
    expect(device.has('timestamp-query')).toBe(true)
    expect(device.has('subgroups')).toBe(false)
  })

  it('flags an integrated adapter in the report rather than failing', async () => {
    const adapter = new FakeAdapter({
      features: [...WANTED_FEATURES],
      info: { vendor: 'intel', description: 'Intel(R) UHD Graphics' } as Partial<GPUAdapterInfo>,
    })
    const device = await createDevice({ gpu: new FakeGpu({ adapter }).asGpu() })
    // Not a failure: the user gets a working (slow) app plus a report that says why. What
    // must never happen is running at 6 fps with nothing to explain it.
    expect(device.report.looksIntegrated).toBe(true)
  })

  it('configures the canvas with the preferred format when one is supplied', async () => {
    const canvas = new FakeCanvas()
    const gpu = new FakeGpu({ adapter: targetAdapter(), preferredFormat: 'bgra8unorm' as GPUTextureFormat })
    const device = await createDevice({ gpu: gpu.asGpu(), canvas: canvas.asCanvas() })
    expect(device.canvasFormat).toBe('bgra8unorm')
    expect(canvas.context.configured?.['format']).toBe('bgra8unorm')
    expect(canvas.context.configured?.['alphaMode']).toBe('opaque')
  })

  it('throws a typed DeviceError when WebGPU is missing', async () => {
    const noGpu = { gpu: undefined } as unknown as DeviceOptions
    await expect(createDevice(noGpu)).rejects.toMatchObject({
      name: 'DeviceError',
      code: 'no-webgpu',
    })
  })

  it('throws a typed DeviceError when no adapter comes back', async () => {
    const gpu = new FakeGpu({ adapter: null })
    await expect(createDevice({ gpu: gpu.asGpu() })).rejects.toMatchObject({ code: 'no-adapter' })
  })

  it('wraps a requestDevice rejection rather than leaking a raw TypeError', async () => {
    const adapter = new FakeAdapter({ failDevice: 'limit out of range' })
    const gpu = new FakeGpu({ adapter })
    const err = await createDevice({ gpu: gpu.asGpu() }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceError)
    expect((err as DeviceError).code).toBe('device-request-failed')
    expect((err as DeviceError).message).toContain('limit out of range')
  })
})

describe('device loss (spec §6.8 pitfall 6)', () => {
  it('calls the handler on a real loss, such as a Windows TDR', async () => {
    const adapter = new FakeAdapter({ features: [...WANTED_FEATURES] })
    const onDeviceLost = vi.fn()
    const device = await createDevice({ gpu: new FakeGpu({ adapter }).asGpu(), onDeviceLost })
    adapter.device!.simulateLoss('unknown' as GPUDeviceLostReason, 'device reset')
    await device.lost
    await Promise.resolve()
    expect(onDeviceLost).toHaveBeenCalledTimes(1)
  })

  it('does not call the handler for our own destroy()', async () => {
    const adapter = new FakeAdapter({ features: [...WANTED_FEATURES] })
    const onDeviceLost = vi.fn()
    const device = await createDevice({ gpu: new FakeGpu({ adapter }).asGpu(), onDeviceLost })
    device.destroy()
    await device.lost
    await Promise.resolve()
    // A destroy-triggered rebuild would loop forever: destroy, rebuild, destroy.
    expect(onDeviceLost).not.toHaveBeenCalled()
  })

  it('destroy() is idempotent and unconfigures the swapchain first', async () => {
    const canvas = new FakeCanvas()
    const adapter = new FakeAdapter({ features: [...WANTED_FEATURES] })
    const device = await createDevice({
      gpu: new FakeGpu({ adapter }).asGpu(),
      canvas: canvas.asCanvas(),
    })
    device.destroy()
    device.destroy()
    expect(canvas.context.unconfigureCount).toBe(1)
    expect(device.destroyed).toBe(true)
  })

  it('exposes the lost promise straight from the device', async () => {
    const adapter = new FakeAdapter({ features: [] })
    const device = await createDevice({ gpu: new FakeGpu({ adapter }).asGpu() })
    expect(device).toBeInstanceOf(Device)
    adapter.device!.simulateLoss()
    const info = await device.lost
    expect(info.reason).toBe('unknown')
  })
})

describe('adapterAdvice (spec §6.8 pitfall 1, "never silently run at 6 fps")', () => {
  const report = (over: Partial<AdapterReport>): AdapterReport => ({
    vendor: 'nvidia',
    architecture: 'ada-lovelace',
    device: '',
    description: 'NVIDIA GeForce RTX 4070 Laptop GPU',
    looksIntegrated: false,
    grantedFeatures: [...WANTED_FEATURES],
    limitShortfalls: [],
    ...over,
  })

  it('blocks on an integrated adapter and offers all three documented fixes', () => {
    const advice = adapterAdvice(report({ looksIntegrated: true, vendor: 'intel' }))
    expect(advice.blocking).toBe(true)
    expect(advice.remedies).toHaveLength(3)
    expect(advice.remedies[0]?.url).toBe('chrome://flags/#force-high-performance-gpu')
    expect(advice.remedies.map((r) => r.detail).join(' ')).toMatch(/Windows Settings/)
    expect(advice.remedies.map((r) => r.detail).join(' ')).toMatch(/NVIDIA Control Panel/)
    expect(advice.body).toContain('intel')
  })

  it('does not block for limit shortfalls, which have documented fallbacks', () => {
    const advice = adapterAdvice(
      report({ limitShortfalls: [{ limit: 'maxBufferSize', wanted: 1 << 30, got: 1 << 28 }] }),
    )
    expect(advice.blocking).toBe(false)
    expect(advice.body).toContain('maxBufferSize')
  })

  it('still names the adapter when everything was granted', () => {
    const advice = adapterAdvice(report({}))
    expect(advice.blocking).toBe(false)
    expect(advice.headline).toContain('nvidia')
    expect(advice.remedies).toEqual([])
  })

  it('lists the features that were refused', () => {
    expect(missingFeatures(report({}))).toEqual([])
    expect(missingFeatures(report({ grantedFeatures: ['shader-f16'] }))).toEqual([
      'timestamp-query',
      'float32-filterable',
      'subgroups',
    ])
  })

  it('has three remedies, all of them actions outside the page', () => {
    // powerPreference is documented as a no-op on Windows, so nothing the application does
    // at runtime can change the selection. Advice that implied otherwise would waste the
    // user's time on the one problem they cannot debug from inside the app.
    expect(HYBRID_GPU_REMEDIES).toHaveLength(3)
    for (const r of HYBRID_GPU_REMEDIES) expect(r.detail.length).toBeGreaterThan(40)
  })
})

describe('syncCanvasSize', () => {
  const fakeDevice = (maxTextureDimension2D: number): GPUDevice =>
    ({ limits: { maxTextureDimension2D } }) as unknown as GPUDevice

  it('sizes the backing store to the CSS box times the capped DPR', () => {
    const canvas = new FakeCanvas()
    canvas.clientWidth = 2560
    canvas.clientHeight = 1440
    const changed = syncCanvasSize(canvas.asCanvas(), fakeDevice(16384), 1)
    expect(changed).toBe(true)
    expect(canvas.width).toBe(2560)
    expect(canvas.height).toBe(1440)
  })

  it('returns false when nothing changed, so targets are not rebuilt every frame', () => {
    const canvas = new FakeCanvas()
    canvas.clientWidth = 800
    canvas.clientHeight = 600
    syncCanvasSize(canvas.asCanvas(), fakeDevice(16384), 1)
    expect(syncCanvasSize(canvas.asCanvas(), fakeDevice(16384), 1)).toBe(false)
  })

  it('clamps to maxTextureDimension2D rather than failing texture creation', () => {
    const canvas = new FakeCanvas()
    canvas.clientWidth = 20000
    canvas.clientHeight = 20000
    syncCanvasSize(canvas.asCanvas(), fakeDevice(8192), 1)
    expect(canvas.width).toBe(8192)
    expect(canvas.height).toBe(8192)
  })

  it('never produces a zero-sized canvas from a hidden element', () => {
    const canvas = new FakeCanvas()
    canvas.clientWidth = 0
    canvas.clientHeight = 0
    syncCanvasSize(canvas.asCanvas(), fakeDevice(8192), 1)
    expect(canvas.width).toBe(1)
    expect(canvas.height).toBe(1)
  })
})
