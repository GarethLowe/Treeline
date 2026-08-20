/**
 * Hydrological conditioning: depression filling and flow accumulation.
 *
 * Why this is here at all: droplet erosion alone leaves a scatter of one-cell pits and
 * disconnected pools, and a heightfield full of closed basins is not just ugly — it breaks
 * every downstream consumer. Flow accumulation cannot be computed on it, so the channel
 * network never becomes coherent, and the fire model inherits a domain speckled with tiny
 * sinks whose slope and aspect point nowhere in particular.
 *
 * The fix is Priority-Flood + epsilon (Barnes, Lehman & Mulla 2014, *Priority-flood: an
 * optimal depression-filling and watershed-labeling algorithm for digital elevation
 * models*, Computers & Geosciences 62). Cells are popped from the domain edge inwards in
 * ascending elevation; any neighbour lower than the current water level is raised to it
 * plus a tiny increment. The result is guaranteed to have **zero** closed basins and a
 * strictly monotone descent from every cell to the domain boundary, with filled depressions
 * becoming near-flat lake floors rather than holes.
 *
 * The pop order it produces is itself valuable: it is ascending in filled elevation, which
 * makes its reverse a valid topological order for routing flow downstream. That saves a
 * separate O(N log N) sort in the accumulation pass.
 */

import { NEIGHBOUR_DX, NEIGHBOUR_DZ } from './conventions.ts'
import type { Heightfield } from './heightfield.ts'

/**
 * Minimum rise applied per filled cell, metres.
 *
 * Chosen against float32: heights here are hundreds to thousands of metres, where one ulp
 * of float32 is ~6e-5 m at 1000 m. An increment near that size would round away on store
 * and reintroduce the flat spots this pass exists to remove, so the increment is also
 * floored at a relative 1.2e-6 of the elevation — about 10 ulp — and the store is verified.
 * The resulting lake-floor gradient (1e-3 over a 1 m cell) is four orders of magnitude
 * below anything the slope term in the spread model can notice.
 */
const EPS_FILL_M = 1e-3

export interface PriorityFloodResult {
  /** Node indices in the order they were popped: ascending in filled elevation. */
  readonly order: Int32Array
  /** How many nodes were raised. */
  readonly filledCells: number
  /** Deepest single fill, metres — the depth of the largest depression removed. */
  readonly maxFillDepthM: number
}

/** Binary min-heap over (key, value) pairs, backed by typed arrays. */
class MinHeap {
  private readonly keys: Float64Array
  private readonly vals: Int32Array
  private size = 0
  /** Key of the most recently popped element. */
  poppedKey = 0

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity)
    this.vals = new Int32Array(capacity)
  }

  get length(): number {
    return this.size
  }

  push(key: number, val: number): void {
    const { keys, vals } = this
    let i = this.size++
    keys[i] = key
    vals[i] = val
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((keys[parent] as number) <= (keys[i] as number)) break
      const tk = keys[parent] as number
      const tv = vals[parent] as number
      keys[parent] = keys[i] as number
      vals[parent] = vals[i] as number
      keys[i] = tk
      vals[i] = tv
      i = parent
    }
  }

  pop(): number {
    const { keys, vals } = this
    const outVal = vals[0] as number
    this.poppedKey = keys[0] as number
    const last = --this.size
    keys[0] = keys[last] as number
    vals[0] = vals[last] as number
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      if (l >= last) break
      const r = l + 1
      let m = l
      if (r < last && (keys[r] as number) < (keys[l] as number)) m = r
      if ((keys[i] as number) <= (keys[m] as number)) break
      const tk = keys[m] as number
      const tv = vals[m] as number
      keys[m] = keys[i] as number
      vals[m] = vals[i] as number
      keys[i] = tk
      vals[i] = tv
      i = m
    }
    return outVal
  }
}

/**
 * Fill every depression in place with an epsilon gradient. Returns the pop order, which the
 * caller reuses for flow accumulation.
 */
export function priorityFloodFill(field: Heightfield): PriorityFloodResult {
  const { n, height } = field
  const count = n * n
  const closed = new Uint8Array(count)
  const order = new Int32Array(count)
  const heap = new MinHeap(count)

  // Seed with the whole boundary: these are the outlets.
  for (let i = 0; i < n; i++) {
    const top = i
    const bottom = (n - 1) * n + i
    closed[top] = 1
    heap.push(height[top] as number, top)
    if (n > 1) {
      closed[bottom] = 1
      heap.push(height[bottom] as number, bottom)
    }
  }
  for (let j = 1; j < n - 1; j++) {
    const left = j * n
    const right = j * n + n - 1
    closed[left] = 1
    heap.push(height[left] as number, left)
    closed[right] = 1
    heap.push(height[right] as number, right)
  }

  let k = 0
  let filledCells = 0
  let maxFillDepthM = 0

  while (heap.length > 0) {
    const c = heap.pop()
    const level = heap.poppedKey
    order[k++] = c
    const ci = c % n
    const cj = (c - ci) / n
    for (let d = 0; d < 8; d++) {
      const ni = ci + (NEIGHBOUR_DX[d] as number)
      const nj = cj + (NEIGHBOUR_DZ[d] as number)
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nb = nj * n + ni
      if (closed[nb] === 1) continue
      closed[nb] = 1
      const orig = height[nb] as number
      if (orig <= level) {
        // Raise just enough that the stored float32 is strictly above the water level.
        const step = Math.max(EPS_FILL_M, Math.abs(level) * 1.2e-6)
        let raised = level + step
        height[nb] = raised
        if ((height[nb] as number) <= level) {
          raised = level + step * 16
          height[nb] = raised
        }
        const depth = (height[nb] as number) - orig
        if (depth > maxFillDepthM) maxFillDepthM = depth
        filledCells++
      }
      heap.push(height[nb] as number, nb)
    }
  }

  return { order, filledCells, maxFillDepthM }
}

/**
 * Upslope contributing area per node, in square metres, routed D8 down the steepest
 * descent. Requires a depression-free field (run `priorityFloodFill` first) so that every
 * node has a strictly lower receiver and the routing terminates.
 *
 * `order` must be the ascending-elevation pop order from the fill; it is walked in reverse
 * so a node's own area is complete before it is pushed downstream.
 */
export function flowAccumulation(
  field: Heightfield,
  order: Int32Array,
  receivers: Int32Array,
): Float32Array {
  const { n, cellM } = field
  const count = n * n
  const cellArea = cellM * cellM
  const acc = new Float32Array(count)
  acc.fill(cellArea)
  for (let k = count - 1; k >= 0; k--) {
    const c = order[k] as number
    const r = receivers[c] as number
    if (r >= 0) acc[r] = (acc[r] as number) + (acc[c] as number)
  }
  return acc
}

/**
 * Longest number of D8 steps taken to reach the domain edge from any node, and whether any
 * flow path failed to terminate. A finite result across the whole grid is the operational
 * definition of "the drainage network is connected and flows downhill".
 */
export function drainagePathCheck(
  field: Heightfield,
  receivers: Int32Array,
): { readonly maxPathSteps: number; readonly unresolved: number } {
  const { n } = field
  const count = n * n
  const steps = new Int32Array(count).fill(-1)
  let maxPathSteps = 0
  let unresolved = 0
  const stack: number[] = []

  for (let start = 0; start < count; start++) {
    if ((steps[start] as number) >= 0) continue
    let c = start
    stack.length = 0
    let guard = 0
    // Walk downstream until a node with a known distance (or an outlet) is reached.
    while (c >= 0 && (steps[c] as number) < 0) {
      if (guard++ > count) {
        unresolved++
        break
      }
      stack.push(c)
      c = receivers[c] as number
    }
    // -1 means "the next node downstream is off the domain", so the last node on the stack
    // ends up at 0. Otherwise resume from the already-known distance of the joined path.
    let base = c >= 0 ? (steps[c] as number) : -1
    for (let s = stack.length - 1; s >= 0; s--) {
      base += 1
      const node = stack[s] as number
      steps[node] = base
      if (base > maxPathSteps) maxPathSteps = base
    }
  }
  return { maxPathSteps, unresolved }
}

export { EPS_FILL_M }
