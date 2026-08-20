/**
 * Measurement helpers for the propagation shape tests.
 *
 * Everything here reads the *zero level set* by sub-cell interpolation rather than counting
 * cells whose φ is negative. That matters: the numerical front is 2–3 cells wide by
 * construction (spec §4.6 says so), so a cell-counting measurement would report that
 * smearing as shape error and a 2 % isotropy criterion would be unmeasurable.
 */

import type { LevelSetField } from '@sim/propagation/levelset'

export type Sampler = (x: number, y: number) => number

/** Bilinear sample of a cell-centred field in world metres, clamped at the edges. */
export function bilinear(values: Float32Array, n: number, cellM: number): Sampler {
  return (x, y) => {
    const fx = Math.min(Math.max(x / cellM - 0.5, 0), n - 1)
    const fy = Math.min(Math.max(y / cellM - 0.5, 0), n - 1)
    const i = Math.min(Math.floor(fx), n - 2)
    const j = Math.min(Math.floor(fy), n - 2)
    const tx = fx - i
    const ty = fy - j
    const a = values[j * n + i] as number
    const b = values[j * n + i + 1] as number
    const c = values[(j + 1) * n + i] as number
    const d = values[(j + 1) * n + i + 1] as number
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }
}

/**
 * Distance from `(cx, cy)` along `(dx, dy)` to where `sample` first crosses `level` from
 * below-or-equal to above. Refined by bisection, so the answer is not quantised to `step`.
 */
export function crossingDistance(
  sample: Sampler,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  level: number,
  maxDistance: number,
  step = 0.05,
): number {
  let prev = 0
  let prevV = sample(cx, cy) - level
  for (let r = step; r <= maxDistance; r += step) {
    const v = sample(cx + dx * r, cy + dy * r) - level
    if (prevV <= 0 && v > 0) {
      let lo = prev
      let hi = r
      for (let it = 0; it < 40; it++) {
        const mid = 0.5 * (lo + hi)
        if (sample(cx + dx * mid, cy + dy * mid) - level <= 0) lo = mid
        else hi = mid
      }
      return 0.5 * (lo + hi)
    }
    prev = r
    prevV = v
  }
  return Number.NaN
}

export interface RadiusProfile {
  readonly radii: readonly number[]
  readonly mean: number
  /** Worst fractional deviation from the mean over ALL sampled angles. */
  readonly maxDeviation: number
  /** The spec §4.6 statistic: |r_axis − r_diag| / r_mean. Blind to the CA octagon. */
  readonly axisDiagonal: number
}

/** Sample the front radius at `count` evenly spaced bearings around a point. */
export function radiusProfile(
  sample: Sampler,
  cx: number,
  cy: number,
  level: number,
  maxDistance: number,
  count = 128,
): RadiusProfile {
  const radii: number[] = []
  for (let i = 0; i < count; i++) {
    const a = (i * 2 * Math.PI) / count
    radii.push(crossingDistance(sample, cx, cy, Math.cos(a), Math.sin(a), level, maxDistance))
  }
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length
  const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - mean) / mean))
  const axis = mean4(sample, cx, cy, level, maxDistance, 0)
  const diag = mean4(sample, cx, cy, level, maxDistance, Math.PI / 4)
  return { radii, mean, maxDeviation, axisDiagonal: Math.abs(axis - diag) / mean }
}

function mean4(
  sample: Sampler,
  cx: number,
  cy: number,
  level: number,
  maxDistance: number,
  offset: number,
): number {
  let sum = 0
  for (let i = 0; i < 4; i++) {
    const a = offset + (i * Math.PI) / 2
    sum += crossingDistance(sample, cx, cy, Math.cos(a), Math.sin(a), level, maxDistance)
  }
  return sum / 4
}

export interface MomentFit {
  readonly areaM2: number
  readonly cx: number
  readonly cy: number
  /** √(λmax/λmin) of the coverage-weighted covariance — the ellipse's length-to-breadth. */
  readonly lengthToBreadth: number
  /** Direction of the major axis, radians in the grid frame. */
  readonly majorAngle: number
}

/**
 * Fit an ellipse to the burnt region by second moments, weighted by the sub-cell coverage
 * so the answer does not quantise to whole cells.
 *
 * For a uniformly filled ellipse the covariance eigenvalues are `B²/4` and `A²/4`, so
 * `√(λmax/λmin)` is exactly the length-to-breadth ratio.
 */
export function momentFit(field: LevelSetField): MomentFit {
  const { n, cellM } = field
  let m0 = 0
  let mx = 0
  let my = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const w = field.coverage(j * n + i)
      if (w <= 0) continue
      m0 += w
      mx += w * (i + 0.5) * cellM
      my += w * (j + 0.5) * cellM
    }
  }
  const cx = mx / m0
  const cy = my / m0
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const w = field.coverage(j * n + i)
      if (w <= 0) continue
      const dx = (i + 0.5) * cellM - cx
      const dy = (j + 0.5) * cellM - cy
      sxx += w * dx * dx
      syy += w * dy * dy
      sxy += w * dx * dy
    }
  }
  sxx /= m0
  syy /= m0
  sxy /= m0
  const half = 0.5 * (sxx + syy)
  const root = Math.sqrt(0.25 * (sxx - syy) ** 2 + sxy * sxy)
  const lMax = half + root
  const lMin = Math.max(half - root, 1e-12)
  return {
    areaM2: m0 * cellM * cellM,
    cx,
    cy,
    lengthToBreadth: Math.sqrt(lMax / lMin),
    majorAngle: 0.5 * Math.atan2(2 * sxy, sxx - syy),
  }
}

/**
 * An 8-neighbour cellular automaton, present purely to prove the isotropy statistic can
 * fail — and to show *why* the spec's axis-versus-diagonal form of it cannot.
 *
 * Arrival time is the shortest-path distance on the 8-connected grid with exact edge
 * lengths, which is what "cell ignites its neighbours after d/R" converges to. Its reachable
 * set passes exactly through the true circle on both the axes and the diagonals and falls
 * ~7.6 % short at 22.5° — the octagon's vertices sit precisely where the spec's test does
 * not look.
 */
export function cellularAutomatonArrival(
  n: number,
  cellM: number,
  cx: number,
  cy: number,
  rate: number,
): Float32Array {
  const arrival = new Float32Array(n * n).fill(Number.POSITIVE_INFINITY)
  const i0 = Math.floor(cx / cellM)
  const j0 = Math.floor(cy / cellM)
  arrival[j0 * n + i0] = 0
  // Dial-free Dijkstra: a simple binary heap keyed on arrival time.
  const heap: number[] = [j0 * n + i0]
  const key = (k: number) => arrival[k] as number
  const push = (k: number) => {
    heap.push(k)
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (key(heap[p] as number) <= key(heap[c] as number)) break
      const t = heap[p] as number
      heap[p] = heap[c] as number
      heap[c] = t
      c = p
    }
  }
  const pop = (): number => {
    const top = heap[0] as number
    const last = heap.pop() as number
    if (heap.length > 0) {
      heap[0] = last
      let p = 0
      for (;;) {
        const l = 2 * p + 1
        const r = l + 1
        let m = p
        if (l < heap.length && key(heap[l] as number) < key(heap[m] as number)) m = l
        if (r < heap.length && key(heap[r] as number) < key(heap[m] as number)) m = r
        if (m === p) break
        const t = heap[p] as number
        heap[p] = heap[m] as number
        heap[m] = t
        p = m
      }
    }
    return top
  }
  const dx = [1, -1, 0, 0, 1, 1, -1, -1]
  const dy = [0, 0, 1, -1, 1, -1, 1, -1]
  while (heap.length > 0) {
    const k = pop()
    const i = k % n
    const j = (k - i) / n
    const t = arrival[k] as number
    for (let d = 0; d < 8; d++) {
      const ni = i + (dx[d] as number)
      const nj = j + (dy[d] as number)
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const step = (d < 4 ? cellM : cellM * Math.SQRT2) / rate
      const nk = nj * n + ni
      if (t + step < (arrival[nk] as number)) {
        arrival[nk] = t + step
        push(nk)
      }
    }
  }
  return arrival
}
