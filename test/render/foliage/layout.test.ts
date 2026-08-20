import { describe, expect, it } from 'vitest'
import {
  BUCKET_UNIFORM_STRIDE_BYTES,
  COMPACTED_FADE_MAX,
  COMPACTED_MAX_INSTANCES,
  CULL_UNIFORM_BYTES,
  DRAW_ARGS_BYTES,
  DRAW_INDEXED_ARGS_BYTES,
  FRAME_OFF_FRUSTUM,
  FRAME_OFF_SKY_IRRADIANCE,
  FRAME_OFF_SUN_DIR,
  FRAME_OFF_SUN_IRRADIANCE,
  FRAME_UNIFORM_BYTES,
  GRASS_UNIFORM_BYTES,
  INSTANCE_STRIDE_BYTES,
  MESH_ENTRY_STRIDE_BYTES,
  STATS_BYTES,
  VERTEX_STRIDE_BYTES,
  boundingSphereCentreY,
  clampDispatch,
  clampInstanceCount,
  packCompacted,
  unpackCompacted,
} from '@render/foliage/layout'

describe('buffer layouts', () => {
  it('keeps every uniform struct 16-byte aligned and every stride 4-byte aligned', () => {
    for (const size of [FRAME_UNIFORM_BYTES, CULL_UNIFORM_BYTES, GRASS_UNIFORM_BYTES]) {
      expect(size % 16).toBe(0)
    }
    for (const stride of [
      INSTANCE_STRIDE_BYTES,
      MESH_ENTRY_STRIDE_BYTES,
      VERTEX_STRIDE_BYTES,
      DRAW_ARGS_BYTES,
      DRAW_INDEXED_ARGS_BYTES,
      STATS_BYTES,
    ]) {
      expect(stride % 4).toBe(0)
    }
    // The frustum array is a vec4 array and must start 16-aligned, and sunDir follows it.
    expect(FRAME_OFF_FRUSTUM % 16).toBe(0)
    expect(FRAME_OFF_SUN_DIR).toBe(FRAME_OFF_FRUSTUM + 6 * 16)
    // Irradiance follows the sunDir/alphaCutoff vec4. This pass emits physical radiance, so
    // it needs W/m2 rather than a shading constant; without it foliage was ~58x darker than
    // the terrain it composites against and read as pure black. Both are vec3 — the light in
    // this scene is not white — so each takes a 16-byte block of its own.
    expect(FRAME_OFF_SUN_IRRADIANCE).toBe(FRAME_OFF_SUN_DIR + 16)
    expect(FRAME_OFF_SUN_IRRADIANCE % 16).toBe(0)
    expect(FRAME_OFF_SKY_IRRADIANCE).toBe(FRAME_OFF_SUN_IRRADIANCE + 16)
    expect(FRAME_OFF_SKY_IRRADIANCE % 16).toBe(0)
    // No trailing gap beyond the vec3's own padding.
    expect(FRAME_UNIFORM_BYTES).toBe(FRAME_OFF_SKY_IRRADIANCE + 16)
  })

  it('uses a dynamic-uniform stride that satisfies minUniformBufferOffsetAlignment', () => {
    expect(BUCKET_UNIFORM_STRIDE_BYTES % 256).toBe(0)
  })

  it('places the bounding sphere at the mid-height of the stem', () => {
    expect(boundingSphereCentreY(100, 22)).toBe(111)
  })
})

describe('compacted record packing', () => {
  it('round-trips instance index and fade weight', () => {
    for (const index of [0, 1, 12345, COMPACTED_MAX_INSTANCES - 1]) {
      for (const fade of [0, 0.25, 0.5, 1]) {
        const packed = packCompacted(index, fade)
        const out = unpackCompacted(packed)
        expect(out.instanceIndex).toBe(index)
        expect(out.fade01).toBeCloseTo(fade, 3)
      }
    }
  })

  it('clamps out-of-range fade weights instead of corrupting the index', () => {
    const low = unpackCompacted(packCompacted(999, -5))
    expect(low.instanceIndex).toBe(999)
    expect(low.fade01).toBe(0)
    const high = unpackCompacted(packCompacted(999, 5))
    expect(high.instanceIndex).toBe(999)
    expect(high.fade01).toBe(1)
  })

  it('keeps the packed value inside the unsigned 32-bit range', () => {
    const packed = packCompacted(COMPACTED_MAX_INSTANCES - 1, 1)
    expect(packed).toBeGreaterThan(0)
    expect(packed).toBeLessThanOrEqual(0xffffffff)
    expect(packed >>> 20).toBe(COMPACTED_FADE_MAX)
  })
})

describe('indirect argument clamping', () => {
  // WebGPU §16.1.2: an indirect dispatch whose workgroup count exceeds
  // maxComputeWorkgroupsPerDimension is silently skipped ENTIRELY — not clamped, not an
  // error. Anything computing dispatch sizes has to clamp them itself, so the helper that
  // does it is tested rather than assumed.
  it('passes through in-range dispatches unchanged', () => {
    const c = clampDispatch(313, 1, 1, 65535)
    expect(c).toEqual({ x: 313, y: 1, z: 1, clamped: false })
  })

  it('folds an oversized X into Y rather than dropping work', () => {
    const c = clampDispatch(200_000, 1, 1, 65535)
    expect(c.clamped).toBe(true)
    expect(c.x).toBe(65535)
    expect(c.x * c.y).toBeGreaterThanOrEqual(200_000)
  })

  it('clamps Y and Z to the limit and reports it', () => {
    const c = clampDispatch(1, 90_000, 90_000, 65535)
    expect(c.clamped).toBe(true)
    expect(c.y).toBe(65535)
    expect(c.z).toBe(65535)
  })

  it('never emits a negative or fractional dispatch', () => {
    const c = clampDispatch(-5, 2.7, 1, 65535)
    expect(c.x).toBe(0)
    expect(c.y).toBe(2)
    expect(c.z).toBe(1)
  })

  it('clamps instance counts against the allocated capacity', () => {
    expect(clampInstanceCount(5, 10)).toEqual({ count: 5, clamped: false })
    expect(clampInstanceCount(50, 10)).toEqual({ count: 10, clamped: true })
    expect(clampInstanceCount(-3, 10)).toEqual({ count: 0, clamped: false })
  })
})
