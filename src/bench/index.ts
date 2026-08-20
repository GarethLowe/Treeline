/**
 * `?bench` — the frame benchmark driver. Work package 3.7.
 *
 * WHY THIS EXISTS. Every millisecond figure in the specification is *reasoned*, not
 * measured. No frame has ever been rendered on the target GPU: the development environment
 * only ever exposes the Intel iGPU, and its browser pane does not composite. Spec §0.5.1
 * forbids trading accuracy against a predicted cost, so until the owner runs this in their
 * own Chrome, M3 has no licence to cut anything.
 *
 * HOW IT HOOKS IN. It does not own the frame loop and does not render. It runs its own
 * `requestAnimationFrame` loop *alongside* the application's, and each tick it:
 *
 *   1. writes the next pose from `path.ts` straight into the camera rig, and
 *   2. reads whatever the profiler has finished with.
 *
 * That is the whole coupling, and it is why the integrator only has to add one line. The
 * pose is written to the free camera with `setPosition`, which clears velocity, so the
 * application's own `rig.update()` — running with no input, because the bench detaches the
 * DOM binding — cannot move it. Whether this rAF runs before or after the application's
 * within a given frame only changes which frame a pose lands on, never the sequence, so the
 * measurement is unaffected either way.
 *
 * COST OF THE HARNESS ITSELF. Per frame: one terrain height query, ~12 arithmetic
 * operations, three number pushes into preallocated arrays. Reasoned, not measured, because
 * it is arithmetic against a 16.67 ms budget — call it under 10 µs. The DOM panel is only
 * written at the end of the run.
 *
 * WHAT IT DOES NOT MEASURE. Per-pass microseconds (Chrome quantises timestamp results to
 * 100 µs and `src/gpu/profiler.ts` correctly refuses to report below the phase level), and
 * anything faster than the display refresh in the rAF row, which is vsync-locked. See the
 * caveats `report.ts` prints; both are stated in the output rather than left to the reader.
 *
 * ---
 *
 * WIRING. `src/bench` is not imported by anything. The integrator adds exactly one line to
 * `src/main.ts`, at the end of `build()`, immediately after `startLoop(stages)`:
 *
 * ```ts
 * import { benchRequested, startBench } from './bench/index.ts'
 * // ... at the end of build(), after startLoop(stages):
 * if (benchRequested()) void startBench({ adapter: d.report, profiler: rt.profiler, quality: rt.quality, rig, terrain: world.terrain, canvas, seed: settings.seed, biome: settings.biome })
 * ```
 *
 * `test/bench/wiring.test.ts` type-checks that exact call against the real `Runtime`,
 * `CameraRig` and `TerrainField`, so it fails at build time if it goes stale.
 *
 * Run it as `?bench` (add `&hud=0` — the HUD's 5 Hz DOM writes are not part of what is
 * being measured), or `?bench=worldgen` to append the CPU world-generation stages.
 */

import type { AdapterReport, Phase, QualityLevel } from '@contracts/gpu.ts'
import { PHASES } from '@contracts/gpu.ts'
import type { Metres, Radians } from '@contracts/units.ts'
import { m } from '@contracts/units.ts'
import type { BiomeId } from '@contracts/world.ts'
import type { FrameProfiler } from '@gpu/profiler.ts'
import type { QualityController } from '@gpu/quality.ts'
import { PATH_DT, benchPose } from './path.ts'
import type { BenchMeta, BenchRun, BenchSample } from './report.ts'
import { formatMarkdown } from './report.ts'
import { benchWorldGen } from './worldgen.ts'

export * from './path.ts'
export * from './report.ts'
export * from './worldgen.ts'

/** Structural view of WP 1.8's `CameraRig`. Structural so `src/bench` imports no sibling. */
export interface BenchCameraRig {
  setMode(mode: 'first-person' | 'free'): void
  setOrientation(yaw: Radians, pitch: Radians): void
  detach(): void
  readonly free: { setPosition(x: number, y: number, z: number): void }
}

/** Structural view of WP 1.2's terrain query. */
export interface BenchTerrain {
  heightAt(x: Metres, z: Metres): Metres
}

export interface BenchContext {
  readonly adapter: AdapterReport
  readonly profiler: FrameProfiler
  readonly quality: QualityController
  readonly rig: BenchCameraRig
  readonly terrain: BenchTerrain
  readonly canvas: HTMLCanvasElement
  readonly seed: number
  readonly biome: BiomeId
  readonly options?: BenchOptions
}

export interface BenchOptions {
  /**
   * Frames discarded per level before sampling starts.
   *
   * 150, because the profiler's phase EMA has decay 0.98 (time constant ~50 frames, spec
   * §6.7 asks for >= 120 to converge) and its whole-frame median window is 30. Sampling
   * before that reports the *previous* quality level, which is exactly the error that would
   * make a sweep look flat.
   */
  readonly warmupFrames?: number
  /** Frames sampled per level. 240 = 4 s at 60 fps, ~6 path cycles of the altitude sweep. */
  readonly measureFrames?: number
  /** Levels to sweep, in order. Default 0..5. */
  readonly levels?: readonly QualityLevel[]
  /** Also run the CPU world-generation benchmark. Adds ~9 s. Default false. */
  readonly worldGen?: boolean
  /** Called with progress text as the sweep runs. */
  readonly onProgress?: (text: string) => void
}

export const DEFAULT_WARMUP_FRAMES = 150
export const DEFAULT_MEASURE_FRAMES = 240
const ALL_LEVELS: readonly QualityLevel[] = [0, 1, 2, 3, 4, 5]

/** True when the page was loaded with `?bench`. */
export function benchRequested(search: string = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).has('bench')
}

/** `?bench=worldgen` also runs the CPU world-generation stages. */
function worldGenRequested(search: string): boolean {
  return new URLSearchParams(search).get('bench') === 'worldgen'
}

/**
 * Run the sweep. Resolves with the raw run once every level has been measured.
 *
 * Pins the quality controller for the duration and restores adaptation afterwards, so a
 * measurement run cannot be contaminated by the controller reacting to the level it is
 * being measured at.
 */
export async function startBench(ctx: BenchContext): Promise<BenchRun> {
  const opt = ctx.options ?? {}
  const search = globalThis.location?.search ?? ''
  const warmupFrames = opt.warmupFrames ?? DEFAULT_WARMUP_FRAMES
  const measureFrames = opt.measureFrames ?? DEFAULT_MEASURE_FRAMES
  const levels = opt.levels ?? ALL_LEVELS
  const progress = opt.onProgress ?? ((t: string) => console.info(`[bench] ${t}`))

  // No user input for the whole run: a stray mouse move would move the camera off the path
  // and every comparison after it would be against a different scene.
  ctx.rig.detach()
  ctx.rig.setMode('free')

  const groundY = (x: number, z: number): number => ctx.terrain.heightAt(m(x), m(z)) as number
  const samples: BenchSample[] = []

  for (const level of levels) {
    ctx.quality.pin(level)
    progress(`quality ${level}: warming up (${warmupFrames} frames)`)
    await runSegment(ctx, groundY, warmupFrames, null, level)
    progress(`quality ${level}: measuring (${measureFrames} frames)`)
    await runSegment(ctx, groundY, measureFrames, samples, level)
    const own = samples.filter((s) => s.level === level)
    const meanMs = own.reduce((a, s) => a + s.rafDeltaMs, 0) / Math.max(1, own.length)
    progress(`quality ${level}: ${meanMs.toFixed(2)} ms mean (${(1000 / meanMs).toFixed(1)} fps)`)
  }

  ctx.quality.pin(null)

  const meta: BenchMeta = {
    adapter: ctx.adapter,
    timestamps: ctx.profiler.enabled,
    highResolution: ctx.profiler.timings.highResolution,
    seed: ctx.seed,
    biome: ctx.biome,
    canvasWidth: ctx.canvas.width,
    canvasHeight: ctx.canvas.height,
    warmupFrames,
    measureFrames,
    userAgent: globalThis.navigator?.userAgent ?? '(unknown)',
    startedAt: new Date().toISOString(),
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  }

  let worldGen: BenchRun['worldGen']
  if (opt.worldGen ?? worldGenRequested(search)) {
    progress('CPU world generation (this blocks the tab for several seconds)')
    await nextFrame()
    worldGen = benchWorldGen({ seed: ctx.seed, biome: ctx.biome }).stages
  }

  const run: BenchRun = worldGen === undefined ? { meta, samples } : { meta, samples, worldGen }
  progress('done')
  showResults(run)
  return run
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve)
  })

/**
 * Drive `frames` rendered frames along the path, optionally recording each one.
 *
 * The path clock advances by a FIXED {@link PATH_DT} per frame rather than by wall time, so
 * every quality level renders exactly the same pose sequence. A wall-clock path would let a
 * slow level cover more ground than a fast one and the levels would not be comparable.
 */
async function runSegment(
  ctx: BenchContext,
  groundY: (x: number, z: number) => number,
  frames: number,
  into: BenchSample[] | null,
  level: QualityLevel,
): Promise<void> {
  let lastGpuSamples = ctx.profiler.gpuSamplesSeen
  let lastT = await nextFrame()

  for (let i = 0; i < frames; i++) {
    // Path time restarts per segment, so warmup and measurement of every level traverse the
    // identical stretch of path. Comparability beats path coverage here.
    const pose = benchPose(i * PATH_DT, groundY)
    ctx.rig.free.setPosition(pose.x, pose.y, pose.z)
    ctx.rig.setOrientation(pose.yaw, pose.pitch)

    const t = await nextFrame()
    const rafDeltaMs = t - lastT
    lastT = t

    if (into === null) continue

    // Only attach phase numbers when a NEW timestamp readback has landed. Repeating the
    // previous one would silently narrow the p95 spread by counting one measurement many
    // times.
    const seen = ctx.profiler.gpuSamplesSeen
    let phaseMs: Record<Phase, number> | null = null
    if (seen !== lastGpuSamples) {
      lastGpuSamples = seen
      const src = ctx.profiler.lastPhaseMs
      const copy = {} as Record<Phase, number>
      for (const p of PHASES) copy[p] = src[p]
      phaseMs = copy
    }

    into.push({
      level,
      rafDeltaMs,
      submitMs: ctx.profiler.timings.submitMs,
      phaseMs,
      altitudeFraction: pose.altitudeFraction,
    })
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Put the markdown on screen in a selectable textarea and offer the raw samples as JSON.
 *
 * A textarea rather than a rendered table: the deliverable is a copy-pasteable markdown
 * block, and a textarea is the one element that gives select-all and copy for free with no
 * clipboard permission prompt to fail on.
 */
export function showResults(run: BenchRun, doc: Document = document): HTMLElement {
  const markdown = formatMarkdown(run)
  console.info(markdown)

  const panel = doc.createElement('div')
  panel.id = 'bench-results'
  panel.style.cssText =
    'position:fixed;inset:4vh 4vw;z-index:9999;background:#111;color:#ddd;' +
    'border:1px solid #444;border-radius:6px;padding:12px;display:flex;flex-direction:column;' +
    'gap:8px;font:12px/1.4 ui-monospace,monospace'

  if (run.meta.adapter.looksIntegrated) {
    const warn = doc.createElement('div')
    warn.textContent =
      '!! INTEGRATED GPU — THESE NUMBERS ARE NOT A RESULT. Roughly 10x off. Do not record them.'
    warn.style.cssText = 'background:#7a1010;color:#fff;padding:8px;font-weight:bold'
    panel.append(warn)
  }

  const area = doc.createElement('textarea')
  area.readOnly = true
  area.value = markdown
  area.style.cssText =
    'flex:1;width:100%;background:#000;color:#cfc;border:1px solid #333;font:inherit;padding:8px'
  panel.append(area)

  const bar = doc.createElement('div')
  bar.style.cssText = 'display:flex;gap:8px'
  bar.append(
    button(doc, 'Select all markdown', () => {
      area.focus()
      area.select()
    }),
    button(doc, 'Download JSON', () => downloadJson(run, doc)),
    button(doc, 'Close', () => panel.remove()),
  )
  panel.append(bar)

  doc.body.append(panel)
  return panel
}

function button(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
  const b = doc.createElement('button')
  b.textContent = label
  b.style.cssText = 'padding:6px 10px;background:#222;color:#ddd;border:1px solid #555;cursor:pointer'
  b.addEventListener('click', onClick)
  return b
}

/** Raw samples, so two runs can be diffed rather than eyeballed. */
export function downloadJson(run: BenchRun, doc: Document = document): void {
  const blob = new Blob([JSON.stringify(run, null, 1)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = `forestfire-bench-${run.meta.seed}-${run.meta.startedAt.replace(/[:.]/g, '-')}.json`
  a.click()
  // Revoke on the next task, not synchronously: Chrome has not necessarily started the
  // download read when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
