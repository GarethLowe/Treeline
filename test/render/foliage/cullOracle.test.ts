import { describe, expect, it } from 'vitest'
import { REVERSED_Z } from '../../../src/camera/math.ts'
import { runCullOracle } from './cullOracle.ts'
import {
  extractFrustumPlanes,
  pixelsPerMetreAtUnitDepth,
  PLANE_FLOATS,
  sphereInFrustum,
} from '@render/foliage/cullMath'
import {
  INSTANCE_FLOATS,
  INSTANCE_OFF_CULL_RADIUS,
  INSTANCE_OFF_HEIGHT,
  INSTANCE_OFF_MESH_ID,
  INSTANCE_OFF_POS_X,
  INSTANCE_OFF_POS_Y,
  INSTANCE_OFF_POS_Z,
  boundingSphereCentreY,
} from '@render/foliage/layout'
import { DEFAULT_FOLIAGE_CONFIG, LOD_COUNT } from '@render/foliage/config'
import { buildFoliageScene } from '@render/foliage/sceneBuild'
import { StubTreeMeshSet, StubVegetationSet, createCpuStubMaterialSystem } from '../../fixtures/world.ts'
import { makeCamera } from './cameraHelper.ts'
import type { BucketEntry } from '@render/foliage/sceneBuild'

interface SyntheticInstance {
  x: number
  y: number
  z: number
  height: number
  radius: number
  meshId: number
}

function packInstances(list: readonly SyntheticInstance[]): ArrayBuffer {
  const buf = new ArrayBuffer(list.length * INSTANCE_FLOATS * 4)
  const f = new Float32Array(buf)
  const u = new Uint32Array(buf)
  list.forEach((inst, i) => {
    const o = i * INSTANCE_FLOATS
    f[o + INSTANCE_OFF_POS_X] = inst.x
    f[o + INSTANCE_OFF_POS_Y] = inst.y
    f[o + INSTANCE_OFF_POS_Z] = inst.z
    f[o + INSTANCE_OFF_HEIGHT] = inst.height
    f[o + INSTANCE_OFF_CULL_RADIUS] = inst.radius
    u[o + INSTANCE_OFF_MESH_ID] = inst.meshId
  })
  return buf
}

function syntheticBuckets(meshCount: number): BucketEntry[] {
  const buckets: BucketEntry[] = []
  for (let mesh = 0; mesh < meshCount; mesh++) {
    for (let lod = 0; lod < LOD_COUNT; lod++) {
      // Triangle counts falling with LOD, in the spirit of spec §7.4's table.
      const tris = [25000, 8000, 1500, 2][lod] ?? 2
      buckets.push({
        indexCount: tris * 3,
        firstIndex: mesh * 1000 + lod * 10,
        baseVertex: mesh * 500 + lod * 5,
        triangleCount: tris,
        refHeightM: 22,
        lod,
        meshId: mesh,
      })
    }
  }
  return buckets
}

const camera = makeCamera({ eye: [0, 2, 0], target: [0, 2, -1] })
const planes = extractFrustumPlanes(new Float32Array(PLANE_FLOATS), camera.viewProjMatrix as never, REVERSED_Z)
const ppm = pixelsPerMetreAtUnitDepth(1440, 1, camera.verticalFov as number)

function oracle(instances: readonly SyntheticInstance[], fade = DEFAULT_FOLIAGE_CONFIG.lodFadeFraction) {
  const buckets = syntheticBuckets(2)
  return {
    buckets,
    result: runCullOracle({
      instanceData: packInstances(instances),
      instanceCount: instances.length,
      buckets,
      cameraPos: [0, 2, 0],
      planes,
      pixelsPerMetre: ppm,
      lodThresholdsPx: [...DEFAULT_FOLIAGE_CONFIG.lodThresholdsPx],
      fadeFraction: fade,
      cullRadiusScale: 1,
      compactedCapacity: instances.length * 2,
    }),
  }
}

describe('cull oracle — visibility', () => {
  it('culls instances behind the camera and keeps instances in front', () => {
    const instances: SyntheticInstance[] = [
      { x: 0, y: 0, z: -30, height: 22, radius: 11, meshId: 0 }, // in front
      { x: 0, y: 0, z: -80, height: 22, radius: 11, meshId: 0 }, // in front, further
      { x: 0, y: 0, z: 30, height: 22, radius: 11, meshId: 0 }, // behind
      { x: 0, y: 0, z: 200, height: 22, radius: 11, meshId: 0 }, // far behind
      { x: 400, y: 0, z: -30, height: 22, radius: 11, meshId: 0 }, // far off to the side
    ]
    const { result } = oracle(instances)
    expect(result.treesVisible).toBe(2)
    expect(result.treesCulled).toBe(3)
    expect(result.perInstanceLods[2]).toEqual([])
    expect(result.perInstanceLods[3]).toEqual([])
    expect(result.perInstanceLods[4]).toEqual([])
    expect(result.perInstanceLods[0]!.length).toBeGreaterThan(0)
  })

  it('every accepted instance passes an independent sphere test, and every rejected one fails', () => {
    const instances: SyntheticInstance[] = []
    for (let i = 0; i < 500; i++) {
      const a = (i / 500) * Math.PI * 2
      const r = 5 + (i % 37) * 8
      instances.push({
        x: Math.cos(a) * r,
        y: 0,
        z: Math.sin(a) * r,
        height: 4 + (i % 20),
        radius: 2 + (i % 7),
        meshId: i % 2,
      })
    }
    const { result } = oracle(instances)
    instances.forEach((inst, i) => {
      const visible = sphereInFrustum(
        planes,
        inst.x,
        boundingSphereCentreY(inst.y, inst.height),
        inst.z,
        inst.radius,
      )
      expect(result.perInstanceLods[i]!.length > 0).toBe(visible)
    })
    expect(result.treesVisible + result.treesCulled).toBe(instances.length)
  })
})

describe('cull oracle — LOD and buckets', () => {
  it('selects monotonically coarser LODs with distance', () => {
    const instances: SyntheticInstance[] = []
    for (let d = 5; d <= 500; d += 5) {
      instances.push({ x: 0, y: 0, z: -d, height: 22, radius: 11, meshId: 0 })
    }
    const { result } = oracle(instances, 0)
    let previous = -1
    for (let i = 0; i < instances.length; i++) {
      const lods = result.perInstanceLods[i]!
      expect(lods).toHaveLength(1)
      expect(lods[0]!).toBeGreaterThanOrEqual(previous)
      previous = lods[0]!
    }
    expect(previous).toBe(LOD_COUNT - 1)
  })

  it('routes each instance to the bucket for its own mesh', () => {
    const instances: SyntheticInstance[] = [
      { x: 0, y: 0, z: -30, height: 22, radius: 11, meshId: 0 },
      { x: 2, y: 0, z: -30, height: 22, radius: 11, meshId: 1 },
    ]
    const { result } = oracle(instances, 0)
    const lod0 = result.perInstanceLods[0]![0]!
    const lod1 = result.perInstanceLods[1]![0]!
    expect(result.bucketCounts[0 * LOD_COUNT + lod0]).toBe(1)
    expect(result.bucketCounts[1 * LOD_COUNT + lod1]).toBe(1)
  })

  it('emits two records for an instance inside a cross-fade window', () => {
    // Place the tree at exactly the L1/L2 boundary distance.
    const t = DEFAULT_FOLIAGE_CONFIG.lodThresholdsPx[1]
    const distance = (22 * ppm) / t
    const { result } = oracle([{ x: 0, y: 0, z: -distance, height: 22, radius: 11, meshId: 0 }])
    expect(result.perInstanceLods[0]).toEqual([1, 2])
    expect(result.recordsAppended).toBe(2)
    expect(result.treesVisible).toBe(1)
  })
})

describe('cull oracle — internal consistency', () => {
  const veg = new StubVegetationSet({ seed: 7, stemDensityPerHa: 120 })
  const scene = buildFoliageScene(veg, new StubTreeMeshSet(), createCpuStubMaterialSystem())
  const result = runCullOracle({
    instanceData: scene.instanceData,
    instanceCount: scene.instanceCount,
    buckets: scene.buckets,
    cameraPos: [512, 20, 512],
    planes: extractFrustumPlanes(
      new Float32Array(PLANE_FLOATS),
      makeCamera({ eye: [512, 20, 512], target: [512, 18, 0] }).viewProjMatrix as never,
      REVERSED_Z,
    ),
    pixelsPerMetre: ppm,
    lodThresholdsPx: [...DEFAULT_FOLIAGE_CONFIG.lodThresholdsPx],
    fadeFraction: DEFAULT_FOLIAGE_CONFIG.lodFadeFraction,
    cullRadiusScale: 1,
    compactedCapacity: scene.instanceCount * 2,
  })

  it('has a real scene to work with', () => {
    expect(scene.instanceCount).toBeGreaterThan(1000)
    expect(scene.buckets.length).toBe(scene.meshCount * LOD_COUNT)
  })

  it('accounts for every instance exactly once', () => {
    expect(result.treesVisible + result.treesCulled).toBe(scene.instanceCount)
    expect(result.treesVisible).toBeGreaterThan(0)
    expect(result.treesCulled).toBeGreaterThan(0)
    expect(result.clamped).toBe(false)
  })

  it('has bucket counts summing to the records appended', () => {
    const sum = result.bucketCounts.reduce((a, b) => a + b, 0)
    expect(sum).toBe(result.recordsAppended)
    // One record per visible tree, plus one extra for each tree mid-cross-fade.
    expect(result.recordsAppended).toBeGreaterThanOrEqual(result.treesVisible)
    expect(result.recordsAppended).toBeLessThanOrEqual(result.treesVisible * 2)
  })

  it('has bases that are the exclusive prefix sum of the counts', () => {
    let running = 0
    for (let b = 0; b < result.bucketCounts.length; b++) {
      expect(result.bucketBases[b]).toBe(running)
      running += result.bucketCounts[b]!
    }
    expect(running).toBe(result.recordsAppended)
  })

  it('writes draw arguments that match the mesh table and the counts', () => {
    for (let b = 0; b < scene.buckets.length; b++) {
      const entry = scene.buckets[b]!
      expect(result.drawArgs[b * 5 + 0]).toBe(entry.indexCount)
      expect(result.drawArgs[b * 5 + 1]).toBe(result.bucketCounts[b])
      expect(result.drawArgs[b * 5 + 2]).toBe(entry.firstIndex)
      expect(result.drawArgs[b * 5 + 3]).toBe(entry.baseVertex)
      // firstInstance stays zero: no dependency on the indirect-first-instance feature.
      expect(result.drawArgs[b * 5 + 4]).toBe(0)
    }
  })

  it('reports a triangle count consistent with the per-bucket totals', () => {
    let expected = 0
    for (let b = 0; b < scene.buckets.length; b++) {
      expected += (result.bucketCounts[b] ?? 0) * (scene.buckets[b]?.triangleCount ?? 0)
    }
    expect(result.trianglesSubmitted).toBe(expected)
  })
})

describe('cull oracle — clamping', () => {
  it('reports clamping rather than overrunning the compacted list', () => {
    const instances: SyntheticInstance[] = []
    for (let i = 0; i < 50; i++) {
      instances.push({ x: i * 0.5 - 12, y: 0, z: -40, height: 22, radius: 11, meshId: 0 })
    }
    const buckets = syntheticBuckets(1)
    const result = runCullOracle({
      instanceData: packInstances(instances),
      instanceCount: instances.length,
      buckets,
      cameraPos: [0, 2, 0],
      planes,
      pixelsPerMetre: ppm,
      lodThresholdsPx: [...DEFAULT_FOLIAGE_CONFIG.lodThresholdsPx],
      fadeFraction: 0,
      cullRadiusScale: 1,
      compactedCapacity: 10,
    })
    expect(result.clamped).toBe(true)
    expect(result.recordsAppended).toBe(10)
    const sum = result.bucketCounts.reduce((a, b) => a + b, 0)
    expect(sum).toBe(10)
  })
})
