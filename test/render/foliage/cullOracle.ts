/**
 * CPU simulation of the whole tree cull pipeline.
 *
 * The GPU does this in three passes (classify → bucket scan → scatter). This function does
 * it in one loop and produces exactly the numbers those passes must write: per-bucket
 * instance counts, bucket base offsets, the indirect draw arguments, and the stats block.
 *
 * It exists for two reasons, and both matter:
 *   1. It is the acceptance oracle. `test/render/foliage/gpu.test.ts` runs the real compute
 *      passes when a device is available and asserts the indirect args buffer matches this,
 *      element for element. Without an oracle, "the culling works" is an opinion.
 *   2. It runs with no GPU at all, so the culling logic is unit-testable in CI on the CLI,
 *      which is where the correctness of this package actually lives.
 *
 * The one thing it deliberately does NOT reproduce is the ORDER of instances within a
 * bucket. That order comes from atomic append and is nondeterministic on the GPU by design;
 * comparing it would be testing the scheduler, not the cull.
 */

import { LOD_COUNT } from '@render/foliage/config.ts'
import {
  INSTANCE_FLOATS,
  INSTANCE_OFF_CULL_RADIUS,
  INSTANCE_OFF_HEIGHT,
  INSTANCE_OFF_MESH_ID,
  INSTANCE_OFF_POS_X,
  INSTANCE_OFF_POS_Y,
  INSTANCE_OFF_POS_Z,
  boundingSphereCentreY,
} from '@render/foliage/layout.ts'
import {
  bucketIndex,
  projectedHeightPx,
  selectLodWithFade,
  sphereInFrustum,
} from '@render/foliage/cullMath.ts'
import type { BucketEntry } from '@render/foliage/sceneBuild.ts'

export interface CullOracleInput {
  readonly instanceData: ArrayBuffer
  readonly instanceCount: number
  readonly buckets: readonly BucketEntry[]
  readonly cameraPos: readonly [number, number, number]
  /** Packed 6x4 planes from `extractFrustumPlanes`. */
  readonly planes: Float32Array
  /** From `pixelsPerMetreAtUnitDepth`. */
  readonly pixelsPerMetre: number
  readonly lodThresholdsPx: readonly number[]
  readonly fadeFraction: number
  /** Safety factor on the stored bounding-sphere radius. 1 unless a caller wants slack. */
  readonly cullRadiusScale: number
  /** Capacity of the compacted list, in records. Overflow is clamped and reported. */
  readonly compactedCapacity: number
}

export interface CullOracleResult {
  /** Records appended per bucket. */
  readonly bucketCounts: Int32Array
  /** Exclusive prefix sum of `bucketCounts` — where each bucket's records start. */
  readonly bucketBases: Int32Array
  /** 5 u32 per bucket: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
  readonly drawArgs: Uint32Array
  readonly treesVisible: number
  readonly treesCulled: number
  readonly recordsAppended: number
  readonly trianglesSubmitted: number
  /** Per-instance LOD assignment, finest first. Only for tests; the GPU does not store this. */
  readonly perInstanceLods: readonly (readonly number[])[]
  readonly clamped: boolean
}

export function runCullOracle(input: CullOracleInput): CullOracleResult {
  const f = new Float32Array(input.instanceData)
  const u = new Uint32Array(input.instanceData)
  const bucketCount = input.buckets.length
  const counts = new Int32Array(bucketCount)
  const perInstanceLods: number[][] = []
  let visible = 0
  let culled = 0
  let records = 0
  let triangles = 0
  let clamped = false

  for (let i = 0; i < input.instanceCount; i++) {
    const o = i * INSTANCE_FLOATS
    const x = f[o + INSTANCE_OFF_POS_X] ?? 0
    const y = f[o + INSTANCE_OFF_POS_Y] ?? 0
    const z = f[o + INSTANCE_OFF_POS_Z] ?? 0
    const h = f[o + INSTANCE_OFF_HEIGHT] ?? 0
    const r = (f[o + INSTANCE_OFF_CULL_RADIUS] ?? 0) * input.cullRadiusScale
    const meshId = u[o + INSTANCE_OFF_MESH_ID] ?? 0
    const cy = boundingSphereCentreY(y, h)

    if (!sphereInFrustum(input.planes, x, cy, z, r)) {
      culled++
      perInstanceLods.push([])
      continue
    }
    visible++
    const dist = Math.hypot(
      x - input.cameraPos[0],
      cy - input.cameraPos[1],
      z - input.cameraPos[2],
    )
    const hPx = projectedHeightPx(h, dist, input.pixelsPerMetre)
    const lodRecords = selectLodWithFade(hPx, input.lodThresholdsPx, input.fadeFraction)
    const lods: number[] = []
    for (const rec of lodRecords) {
      const b = bucketIndex(meshId, Math.min(rec.lod, LOD_COUNT - 1), LOD_COUNT)
      if (b < 0 || b >= bucketCount) continue
      if (records >= input.compactedCapacity) {
        clamped = true
        continue
      }
      counts[b] = (counts[b] ?? 0) + 1
      records++
      triangles += input.buckets[b]?.triangleCount ?? 0
      lods.push(rec.lod)
    }
    perInstanceLods.push(lods)
  }

  const bases = new Int32Array(bucketCount)
  let running = 0
  for (let b = 0; b < bucketCount; b++) {
    bases[b] = running
    running += counts[b] ?? 0
  }

  const drawArgs = new Uint32Array(bucketCount * 5)
  for (let b = 0; b < bucketCount; b++) {
    const entry = input.buckets[b]
    const o = b * 5
    drawArgs[o + 0] = entry?.indexCount ?? 0
    drawArgs[o + 1] = counts[b] ?? 0
    drawArgs[o + 2] = entry?.firstIndex ?? 0
    drawArgs[o + 3] = entry?.baseVertex ?? 0
    drawArgs[o + 4] = 0
  }

  return {
    bucketCounts: counts,
    bucketBases: bases,
    drawArgs,
    treesVisible: visible,
    treesCulled: culled,
    recordsAppended: records,
    trianglesSubmitted: triangles,
    perInstanceLods,
    clamped,
  }
}
