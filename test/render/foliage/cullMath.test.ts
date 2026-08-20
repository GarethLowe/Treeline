import { describe, expect, it } from 'vitest'
import { REVERSED_Z } from '../../../src/camera/math.ts'
import {
  PLANE_COUNT,
  PLANE_FAR,
  PLANE_FLOATS,
  PLANE_NEAR,
  bucketIndex,
  extractFrustumPlanes,
  pixelsPerMetreAtUnitDepth,
  planeDistance,
  projectedHeightPx,
  selectLod,
  selectLodWithFade,
  sphereInFrustum,
} from '@render/foliage/cullMath'
import { DEFAULT_LOD_THRESHOLDS_PX, LOD_COUNT } from '@render/foliage/config'
import { mat4TransformPoint, v3 } from '../../../src/camera/math.ts'
import { makeCamera } from './cameraHelper.ts'

const thresholds = [...DEFAULT_LOD_THRESHOLDS_PX]

describe('frustum extraction', () => {
  const camera = makeCamera({ eye: [0, 2, 0], target: [0, 2, -1] })
  const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)

  it('produces unit-length normals', () => {
    for (let i = 0; i < PLANE_COUNT; i++) {
      const len = Math.hypot(planes[i * 4]!, planes[i * 4 + 1]!, planes[i * 4 + 2]!)
      expect(len).toBeCloseTo(1, 5)
    }
  })

  it('agrees with a direct clip-space test on a grid of points', () => {
    // The two tests are independent: one is the plane form, the other transforms the point
    // and checks the clip volume directly. Agreement on a grid is what rules out a
    // transposed matrix or an inverted plane sign.
    // Deliberately irrational-ish steps: a point landing exactly ON a plane is a tie the two
    // formulations are allowed to break differently, and testing ties tests nothing.
    let checked = 0
    for (let x = -61.3; x <= 61.3; x += 13.7) {
      for (let y = -21.1; y <= 21.1; y += 9.3) {
        for (let z = -123.7; z <= 41.9; z += 17.3) {
          const clip = mat4TransformPoint(camera.viewProjMatrix, v3(x, y, z))
          const insideClip =
            clip.w > 0 &&
            Math.abs(clip.x) <= clip.w &&
            Math.abs(clip.y) <= clip.w &&
            clip.z >= 0 &&
            clip.z <= clip.w
          const insidePlanes = sphereInFrustum(planes, x, y, z, 0)
          expect(insidePlanes).toBe(insideClip)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('rejects points behind the camera and accepts points in front', () => {
    expect(sphereInFrustum(planes, 0, 2, 10, 0)).toBe(false)
    expect(sphereInFrustum(planes, 0, 2, -10, 0)).toBe(true)
  })

  it('uses the WebGPU near plane, not the OpenGL one', () => {
    // With z in [0, w] the near plane is row 2 alone. Under the OpenGL derivation the near
    // plane lands behind the eye and stops rejecting anything, so a point 1 m BEHIND the
    // camera would pass. This asserts the specific failure mode.
    const behind = planeDistance(planes, PLANE_NEAR, 0, 2, 1)
    expect(behind).toBeLessThan(0)
    const inFront = planeDistance(planes, PLANE_NEAR, 0, 2, -1)
    expect(inFront).toBeGreaterThan(0)
  })

  it('rejects beyond the far plane', () => {
    expect(planeDistance(planes, PLANE_FAR, 0, 2, -5000)).toBeLessThan(0)
  })

  it('accepts a sphere whose centre is outside but whose volume overlaps', () => {
    // Centre 1 m behind the camera, radius 5 m: still partly visible, must not be culled.
    expect(sphereInFrustum(planes, 0, 2, 1, 5)).toBe(true)
  })
})

describe('projected size and LOD selection', () => {
  it('reproduces the calibration case from config.ts', () => {
    // 1440p, 60 degree vertical FOV: pixels per metre at 1 m is 1440 / (2 tan 30) = 1247.1
    const ppm = pixelsPerMetreAtUnitDepth(1440, 1, Math.PI / 3)
    expect(ppm).toBeCloseTo(1440 / (2 * Math.tan(Math.PI / 6)), 4)
    // A 22 m conifer at 20 m should sit right at the L0/L1 threshold.
    expect(projectedHeightPx(22, 20, ppm)).toBeCloseTo(thresholds[0]!, 0)
    expect(projectedHeightPx(22, 60, ppm)).toBeCloseTo(thresholds[1]!, 0)
    expect(projectedHeightPx(22, 150, ppm)).toBeCloseTo(thresholds[2]!, 0)
  })

  it('is monotonic in distance', () => {
    const ppm = pixelsPerMetreAtUnitDepth(1440, 1, Math.PI / 3)
    let previous = -1
    for (let d = 1; d <= 600; d += 1) {
      const lod = selectLod(projectedHeightPx(22, d, ppm), thresholds)
      expect(lod).toBeGreaterThanOrEqual(previous)
      expect(lod).toBeLessThan(LOD_COUNT)
      previous = lod
    }
    expect(previous).toBe(LOD_COUNT - 1)
  })

  it('is monotonic in distance under cross-fade too', () => {
    // Under a fade the finest emitted LOD must never get finer as the camera retreats.
    const ppm = pixelsPerMetreAtUnitDepth(1440, 1, Math.PI / 3)
    let previousFinest = -1
    for (let d = 1; d <= 600; d += 0.5) {
      const recs = selectLodWithFade(projectedHeightPx(22, d, ppm), thresholds, 0.18)
      const finest = Math.min(...recs.map((r) => r.lod))
      expect(finest).toBeGreaterThanOrEqual(previousFinest)
      previousFinest = finest
    }
  })

  it('emits complementary weights inside a fade window and one record outside', () => {
    const t = thresholds[1]!
    const inside = selectLodWithFade(t, thresholds, 0.18)
    expect(inside).toHaveLength(2)
    expect(inside[0]!.lod).toBe(1)
    expect(inside[1]!.lod).toBe(2)
    expect(inside[0]!.weight + inside[1]!.weight).toBeCloseTo(1, 6)
    expect(inside[0]!.weight).toBeCloseTo(0.5, 6)

    const outside = selectLodWithFade(t * 1.5, thresholds, 0.18)
    expect(outside).toHaveLength(1)
    expect(outside[0]!.weight).toBe(1)
  })

  it('never emits more than two records, and weights always sum to one', () => {
    for (let h = 0; h < 4000; h += 3.7) {
      const recs = selectLodWithFade(h, thresholds, 0.35)
      expect(recs.length).toBeGreaterThanOrEqual(1)
      expect(recs.length).toBeLessThanOrEqual(2)
      const sum = recs.reduce((a, r) => a + r.weight, 0)
      expect(sum).toBeCloseTo(1, 6)
      for (const r of recs) {
        expect(r.lod).toBeGreaterThanOrEqual(0)
        expect(r.lod).toBeLessThan(LOD_COUNT)
      }
    }
  })

  it('degenerates to a hard switch when the fade is disabled', () => {
    for (let h = 0; h < 3000; h += 11) {
      const recs = selectLodWithFade(h, thresholds, 0)
      expect(recs).toHaveLength(1)
      expect(recs[0]!.lod).toBe(selectLod(h, thresholds))
    }
  })

  it('handles a camera standing inside a tree without producing NaN', () => {
    const h = projectedHeightPx(22, 0, 1247)
    expect(Number.isFinite(h)).toBe(true)
    expect(selectLod(h, thresholds)).toBe(0)
  })
})

describe('bucket indexing', () => {
  it('is dense and collision-free across meshes and LODs', () => {
    const seen = new Set<number>()
    for (let mesh = 0; mesh < 40; mesh++) {
      for (let lod = 0; lod < LOD_COUNT; lod++) {
        const b = bucketIndex(mesh, lod, LOD_COUNT)
        expect(seen.has(b)).toBe(false)
        seen.add(b)
      }
    }
    expect(seen.size).toBe(40 * LOD_COUNT)
    expect(Math.max(...seen)).toBe(40 * LOD_COUNT - 1)
  })
})
