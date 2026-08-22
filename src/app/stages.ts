/**
 * Boot stages.
 *
 * Boot is seconds of straight-line CPU and GPU bring-up, and a frozen tab is
 * indistinguishable from a hang. Every init step is a named stage with a state, a duration
 * and — on failure — the error attached to the stage that produced it, so a failure names
 * the subsystem instead of presenting a black canvas.
 *
 * Pure module: no DOM, no GPU. `bootScreen.ts` renders it, `main.ts` and `worldGen.ts`
 * drive it.
 */

export type StageId =
  | 'device'
  | 'materials'
  | 'terrain'
  | 'vegetation'
  | 'tree-meshes'
  | 'renderer'
  | 'fire'
  | 'canopy'
  | 'first-frame'

export type StageState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StageSpec {
  readonly id: StageId
  readonly label: string
}

/** In execution order. `materials` runs before `terrain` because it is the only async one. */
export const STAGES: readonly StageSpec[] = [
  { id: 'device', label: 'GPU device & adapter' },
  { id: 'materials', label: 'PBR material arrays' },
  { id: 'terrain', label: 'Terrain synthesis' },
  { id: 'vegetation', label: 'Vegetation placement' },
  { id: 'tree-meshes', label: 'Tree geometry' },
  { id: 'renderer', label: 'Renderer, sky & cameras' },
  { id: 'fire', label: 'Surface fire solver' },
  { id: 'canopy', label: 'Canopy voxels & radiation' },
  { id: 'first-frame', label: 'First frame' },
]

export interface StageRecord {
  readonly id: StageId
  readonly label: string
  readonly state: StageState
  /** Wall-clock duration once the stage has finished. */
  readonly ms: number
  /** Free-form detail the stage chose to report — counts, sizes, warnings. */
  readonly note: string
  readonly error: unknown
}

export type StageListener = (stages: readonly StageRecord[]) => void

/**
 * Tracks stage state and duration, and notifies a listener on every transition.
 *
 * `run()` is the only way a stage is executed, so a stage cannot be forgotten in a failure
 * path: the try/catch is here, once, rather than at seven call sites.
 */
export class StageTracker {
  readonly #records = new Map<StageId, StageRecord>()
  readonly #listeners: StageListener[] = []
  readonly #now: () => number
  #started = new Map<StageId, number>()

  constructor(now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    this.#now = now
    for (const spec of STAGES) {
      this.#records.set(spec.id, {
        id: spec.id,
        label: spec.label,
        state: 'pending',
        ms: 0,
        note: '',
        error: null,
      })
    }
  }

  onChange(listener: StageListener): void {
    this.#listeners.push(listener)
  }

  get records(): readonly StageRecord[] {
    return STAGES.map((s) => this.#records.get(s.id) as StageRecord)
  }

  begin(id: StageId): void {
    this.#started.set(id, this.#now())
    this.#patch(id, { state: 'running' })
  }

  note(id: StageId, note: string): void {
    this.#patch(id, { note })
  }

  end(id: StageId, note?: string): void {
    const t0 = this.#started.get(id)
    this.#patch(id, {
      state: 'done',
      ms: t0 === undefined ? 0 : this.#now() - t0,
      ...(note === undefined ? {} : { note }),
    })
  }

  fail(id: StageId, error: unknown): void {
    const t0 = this.#started.get(id)
    this.#patch(id, { state: 'failed', ms: t0 === undefined ? 0 : this.#now() - t0, error })
  }

  skip(id: StageId, note: string): void {
    this.#patch(id, { state: 'skipped', note })
  }

  /**
   * Run one stage. Any throw is recorded against *this* stage and re-thrown wrapped in a
   * {@link StageError}, so the boot screen never has to guess which subsystem died.
   */
  async run<T>(id: StageId, body: () => Promise<T> | T): Promise<T> {
    this.begin(id)
    try {
      const result = await body()
      this.end(id)
      return result
    } catch (err) {
      this.fail(id, err)
      throw new StageError(id, this.#records.get(id)?.label ?? id, err)
    }
  }

  #patch(id: StageId, patch: Partial<Omit<StageRecord, 'id' | 'label'>>): void {
    const current = this.#records.get(id)
    if (current === undefined) return
    this.#records.set(id, { ...current, ...patch })
    const snapshot = this.records
    for (const l of this.#listeners) l(snapshot)
  }
}

/** A failure with the stage that produced it attached. */
export class StageError extends Error {
  override readonly name = 'StageError'
  constructor(
    readonly stage: StageId,
    readonly stageLabel: string,
    override readonly cause: unknown,
  ) {
    super(`${stageLabel} failed: ${describeError(cause)}`)
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
