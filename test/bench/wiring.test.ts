/**
 * Compile-time proof that the one-line hook in `src/main.ts` will link.
 *
 * `src/bench` deliberately types the camera rig and the terrain *structurally* rather than
 * importing WP 1.8's and WP 1.2's classes, so the benchmark imports no package outside its
 * own directory and the contracts. The cost of that is that a signature drift in either
 * would not be caught until someone loaded `?bench` in a browser — which, given the whole
 * problem this package exists to solve, is exactly the wrong place to find out.
 *
 * So the assignment is asserted here instead. `npx tsc --noEmit` fails if the real classes
 * stop satisfying the structural views, and the runtime assertions below are trivial only
 * because the real check happened in the type checker.
 */

import { expect, it } from 'vitest'
import type { Runtime } from '@core/runtime.ts'
import type { TerrainField } from '@world/terrain/field.ts'
import type { CameraRig } from '../../src/camera/rig.ts'
import type { BenchCameraRig, BenchContext, BenchTerrain } from '../../src/bench/index.ts'
import { benchRequested } from '../../src/bench/index.ts'

// WP 1.8's rig and WP 1.2's terrain field satisfy the structural views the driver needs.
type _Rig = CameraRig extends BenchCameraRig ? true : never
type _Terrain = TerrainField extends BenchTerrain ? true : never
const _rigOk: _Rig = true
const _terrainOk: _Terrain = true

/**
 * The exact call the integrator adds to `src/main.ts`, typed against the real objects. If
 * this stops compiling, the documented one-liner is stale.
 */
const theOneLiner = (
  d: { report: BenchContext['adapter'] },
  rt: Runtime,
  rig: CameraRig,
  world: { terrain: TerrainField },
  canvas: HTMLCanvasElement,
  settings: { seed: number; biome: BenchContext['biome'] },
): BenchContext => ({
  adapter: d.report,
  profiler: rt.profiler,
  quality: rt.quality,
  rig,
  terrain: world.terrain,
  canvas,
  seed: settings.seed,
  biome: settings.biome,
})

it('the documented main.ts wiring type-checks', () => {
  expect(typeof theOneLiner).toBe('function')
  expect(_rigOk && _terrainOk).toBe(true)
})

it('activates only on ?bench', () => {
  expect(benchRequested('?bench')).toBe(true)
  expect(benchRequested('?seed=1&bench=worldgen')).toBe(true)
  expect(benchRequested('?seed=1&biome=grassland')).toBe(false)
  expect(benchRequested('')).toBe(false)
})
