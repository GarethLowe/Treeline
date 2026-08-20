/**
 * Narrow-band level-set front propagation — work package 2.3, spec §4.6.
 *
 * ## Why a level set (spec §4.6 weighed three schemes; this follows its recommendation)
 *
 * A **cellular automaton** — cell ignites its 8 neighbours after `d/R` — is trivially
 * parallel and cheap, and is rejected on a structural, not a tuning, ground: the reachable
 * set of an 8-neighbour rule is the unit ball of a polygonal metric, so an isotropic fire on
 * flat homogeneous fuel produces an **octagon**, and the error is O(1) in the grid spacing,
 * not O(Δx). Refining the grid does not help. 16 or 24 neighbours buys a 16-gon at 2–3× the
 * cost, and per-direction correction factors have to be re-fit whenever the anisotropy
 * changes — which here is every frame, because the wind gusts.
 *
 * **Marker/front tracking** (FARSITE-style Huygens expansion on a vector perimeter) has no
 * grid anisotropy at all, and is rejected on integration grounds: topology management —
 * merging perimeters, clipping crossovers, rezoning vertices — is serial, branch-heavy
 * pointer work that maps badly onto a compute shader, and firebrands seed new independent
 * ignitions continuously, so merges are the common case rather than the exception.
 *
 * So: **narrow-band level set** (Osher & Sethian 1988), as WRF-Fire and ELMFIRE use.
 * `∂φ/∂t + S(n̂)|∇φ| = 0`, `φ < 0` burnt, front at `φ = 0`. It is Eulerian, so it lives on
 * the same 2048² grid as the fuel state, the heat-release field and the soot source — zero
 * impedance mismatch — and topology change is automatic.
 *
 * ## Defeating the shape artifact — the package's headline requirement
 *
 * Two things do it, and both are necessary:
 *
 * 1. **The Hamiltonian is the ellipse's support function about the rear focus**, not its
 *    radius (see `ellipse.ts`). It is convex and homogeneous of degree one, so the
 *    viscosity solution coincides exactly with the Huygens envelope: the emergent perimeter
 *    *is* the analytic ellipse, with no per-direction fudge factor anywhere.
 * 2. **The discretisation is second order**: ENO2 spatial reconstruction with a local
 *    Lax–Friedrichs flux and TVD-RK2 in time. Because `n̂` comes from the continuous
 *    gradient it takes all directions rather than eight, so the residual anisotropy is
 *    discretisation error — O(Δx²) — instead of a structural bias. First-order upwind alone
 *    still imprints 5–8 % axis/diagonal asymmetry, which is the same order as the CA it
 *    replaced and therefore not worth the trouble.
 *
 * **A note on how this is tested, because the obvious test does not work.** Spec §4.6
 * proposes measuring `|r_axis − r_diag| / r_mean`. That statistic cannot detect the CA
 * artifact at all: on an 8-neighbour graph with exact edge lengths the reachable set passes
 * *exactly* through the true circle on both the axes and the diagonals, and errs by 7.6 %
 * at 22.5° — the octagon's vertices sit precisely where that test does not look. So the
 * isotropy test here sweeps the radius over many angles and takes the worst deviation, and
 * carries an 8-neighbour CA alongside to prove the statistic can fail.
 *
 * ## Reinitialisation
 *
 * `|∇φ|` drifts away from one under the flow, which changes the effective front speed. φ is
 * pushed back toward a signed distance function every `REINIT_INTERVAL` steps by **jump
 * flooding** over the band — sub-cell seeds at the interpolated zero crossings, then
 * halving jumps — rather than by PDE relaxation, which is both slower and moves the front.
 */

import type { IgnitionShape } from '@contracts/sim'
import type { Seconds } from '@contracts/units'
import type { FireEllipse } from './ellipse'
import { alphaX, alphaY } from './ellipse'
import { BAND_M, TILE_CELLS, classifyTiles, tileGrid, type TileGrid } from './activeSet'

/** Spec §4.6: jump-flood reinitialisation every ~32 steps. */
export const REINIT_INTERVAL = 32

/** Far-field φ. Large enough to be inert, small enough to stay exact in f32. */
const FAR = 1e6

function minmod(a: number, b: number): number {
  if (a * b <= 0) return 0
  return Math.abs(a) < Math.abs(b) ? a : b
}

/**
 * The signed-distance field and the scheme that advances it.
 *
 * Grid convention matches the terrain package: cell `(i, j)` is centred at world
 * `((i + 0.5)·Δx, (j + 0.5)·Δx)`, `i` indexes world +x (east) and `j` indexes world +z
 * (south), row-major with `k = j·n + i`.
 */
export class LevelSetField {
  readonly n: number
  readonly cellM: number
  readonly domainM: number
  readonly phi: Float32Array
  /** Time of arrival of the front, seconds; `Infinity` where the front has not passed. */
  readonly arrival: Float32Array

  private readonly work: Float32Array
  private readonly tiles: TileGrid
  private readonly tileMinAbs: Float32Array
  private readonly tileList: Uint32Array
  private readonly siteA: Float32Array
  private readonly siteB: Float32Array

  private nActiveTiles = 0
  private stepsSinceReinit = 0
  private clock = 0

  constructor(n: number, cellM: number) {
    if (!Number.isInteger(n) || n < 3 * TILE_CELLS) {
      throw new RangeError(`level set needs n >= ${3 * TILE_CELLS}, got ${n}`)
    }
    this.n = n
    this.cellM = cellM
    this.domainM = n * cellM
    this.phi = new Float32Array(n * n)
    this.arrival = new Float32Array(n * n)
    this.work = new Float32Array(n * n)
    this.tiles = tileGrid(n, n)
    this.tileMinAbs = new Float32Array(this.tiles.count)
    this.tileList = new Uint32Array(this.tiles.count)
    this.siteA = new Float32Array(2 * n * n)
    this.siteB = new Float32Array(2 * n * n)
    this.reset()
  }

  reset(): void {
    this.phi.fill(FAR)
    this.work.fill(FAR)
    this.arrival.fill(Number.POSITIVE_INFINITY)
    this.tileMinAbs.fill(Number.POSITIVE_INFINITY)
    this.nActiveTiles = 0
    this.stepsSinceReinit = 0
    this.clock = 0
  }

  get simulatedTime(): number {
    return this.clock
  }

  get activeTileCount(): number {
    return this.nActiveTiles
  }

  /** Cells the solver actually touches per step — what indirect dispatch sizes itself to. */
  get activeCellCount(): number {
    return this.nActiveTiles * TILE_CELLS * TILE_CELLS
  }

  /**
   * Stamp an ignition into φ as an exact signed distance, combined with `min` so overlapping
   * ignitions merge without any topology work. Shapes are in world metres.
   */
  ignite(shape: IgnitionShape): void {
    const { n, cellM, phi } = this
    for (let j = 0; j < n; j++) {
      const y = (j + 0.5) * cellM
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * cellM
        const d = signedDistanceTo(shape, x, y)
        const k = j * n + i
        if (d < (phi[k] as number)) {
          phi[k] = d
          this.work[k] = d
        }
        if (d <= 0 && !Number.isFinite(this.arrival[k] as number)) this.arrival[k] = this.clock
      }
    }
    this.rebuildTileSummaryFull()
  }

  /** True where the front has passed. */
  burnt(k: number): boolean {
    return (this.phi[k] as number) <= 0
  }

  /**
   * Sub-cell burnt coverage of a cell, in `[0, 1]`, from the linearised φ. Using this
   * instead of a hard `φ ≤ 0` test removes the ±half-cell quantisation from area and moment
   * measurements, which matters because the numerical front is 2–3 cells wide by
   * construction and a hard threshold would read that smearing as shape error.
   */
  coverage(k: number): number {
    const t = 0.5 - (this.phi[k] as number) / this.cellM
    return t <= 0 ? 0 : t >= 1 ? 1 : t
  }

  burntAreaM2(): number {
    let a = 0
    for (let k = 0; k < this.phi.length; k++) a += this.coverage(k)
    return a * this.cellM * this.cellM
  }

  /**
   * One TVD-RK2 step. `dt` must already satisfy CFL — see `timestep.ts`; this class does not
   * silently sub-divide, because a level set that quietly violates CFL stalls and oscillates
   * in ways that read as physical behaviour.
   */
  step(dt: Seconds, ellipse: FireEllipse): void {
    const n = this.nActiveTilesRefreshed()
    if (n === 0) return
    this.clock += dt
    // SSP-RK2 (Heun) in two buffers rather than three:
    //   φ⁽¹⁾ = φⁿ + Δt·L(φⁿ)                      predictor, blend = 0
    //   φⁿ⁺¹ = ½φⁿ + ½(φ⁽¹⁾ + Δt·L(φ⁽¹⁾))          corrector, blend = ½
    // The corrector reads `φⁿ` only at its own cell, so writing over it is safe, and the
    // 2048² grid keeps one 16.8 MB buffer instead of two.
    this.stage(this.phi, this.work, dt, ellipse, 0, false)
    this.stage(this.work, this.phi, dt, ellipse, 0.5, true)
    this.stepsSinceReinit++
    if (this.stepsSinceReinit >= REINIT_INTERVAL) {
      this.reinitialise()
      this.stepsSinceReinit = 0
    }
  }

  private nActiveTilesRefreshed(): number {
    this.nActiveTiles = classifyTiles(this.tileMinAbs, this.tiles, BAND_M, this.tileList)
    return this.nActiveTiles
  }

  /**
   * `dst = src + dt·L(src)` over the dispatch set, with `L = −H_LLF(∇φ)`.
   *
   * `dst` is only written inside the dispatch set, so the corrector reads a value that is up
   * to one step stale in the two-cell stencil halo at the *outer* edge of that set. Since the
   * dispatch set is the active tiles dilated by a whole tile, those cells are at least 14
   * cells from the front; the resulting first-order error never reaches it, and
   * reinitialisation clears it. Cells at the edge of an *undilated* active tile read only
   * into the halo, which is fully advanced, so the front itself is second-order everywhere.
   */
  private stage(
    src: Float32Array,
    dst: Float32Array,
    dt: number,
    e: FireEllipse,
    blend: number,
    record: boolean,
  ): void {
    const { n, cellM, tileList, nActiveTiles, tiles } = this
    const globalAx = alphaX(e)
    const globalAy = alphaY(e)
    const h = cellM
    const inv = 1 / h
    const inv2 = inv * inv
    const half = 0.5 * h
    const ea = e.a
    const eb = e.b
    const ec = e.c
    const hx = e.hx
    const hy = e.hy
    const last = n - 1

    for (let t = 0; t < nActiveTiles; t++) {
      const tid = tileList[t] as number
      const tx = (tid % tiles.tilesX) * TILE_CELLS
      const ty = Math.floor(tid / tiles.tilesX) * TILE_CELLS
      const iEnd = Math.min(tx + TILE_CELLS, n)
      const jEnd = Math.min(ty + TILE_CELLS, n)
      let minAbs = Number.POSITIVE_INFINITY

      for (let j = ty; j < jEnd; j++) {
        const jm2 = Math.max(j - 2, 0) * n
        const jm1 = Math.max(j - 1, 0) * n
        const j0 = j * n
        const jp1 = Math.min(j + 1, last) * n
        const jp2 = Math.min(j + 2, last) * n

        for (let i = tx; i < iEnd; i++) {
          const im2 = Math.max(i - 2, 0)
          const im1 = Math.max(i - 1, 0)
          const ip1 = Math.min(i + 1, last)
          const ip2 = Math.min(i + 2, last)

          const c = src[j0 + i] as number

          // ---- x reconstruction (ENO2) ----
          const xm1 = src[j0 + im1] as number
          const xm2 = src[j0 + im2] as number
          const xp1 = src[j0 + ip1] as number
          const xp2 = src[j0 + ip2] as number
          const d2xm = (c - 2 * xm1 + xm2) * inv2
          const d2xc = (xp1 - 2 * c + xm1) * inv2
          const d2xp = (xp2 - 2 * xp1 + c) * inv2
          const pxm = (c - xm1) * inv + half * minmod(d2xm, d2xc)
          const pxp = (xp1 - c) * inv - half * minmod(d2xc, d2xp)

          // ---- y reconstruction (ENO2) ----
          const ym1 = src[jm1 + i] as number
          const ym2 = src[jm2 + i] as number
          const yp1 = src[jp1 + i] as number
          const yp2 = src[jp2 + i] as number
          const d2ym = (c - 2 * ym1 + ym2) * inv2
          const d2yc = (yp1 - 2 * c + ym1) * inv2
          const d2yp = (yp2 - 2 * yp1 + c) * inv2
          const pym = (c - ym1) * inv + half * minmod(d2ym, d2yc)
          const pyp = (yp1 - c) * inv - half * minmod(d2yc, d2yp)

          // ---- local Lax–Friedrichs ----
          //
          // The dissipation coefficients are bounded over the *reconstruction box*
          // [pxm,pxp]x[pym,pyp] by evaluating ∇H at its four corners, not by the
          // ellipse-wide bound. That distinction is not cosmetic: with a global bound the
          // viscosity applied at the backing edge is the HEAD rate, which for LB = 2 is 14x
          // the true backing speed and smears the backing fire by ~16 %. Genuinely local
          // coefficients see |∂H/∂p| ≈ the backing rate there instead. Osher & Shu (1991).
          let ax = 0
          let ay = 0
          for (let corner = 0; corner < 4; corner++) {
            const qx = corner & 1 ? pxp : pxm
            const qy = corner & 2 ? pyp : pym
            const dq = qx * hx + qy * hy
            const sq = eb * eb * dq * dq + ea * ea * Math.max(0, qx * qx + qy * qy - dq * dq)
            if (sq <= 1e-24) {
              ax = Math.max(ax, globalAx)
              ay = Math.max(ay, globalAy)
              continue
            }
            const invS = 1 / Math.sqrt(sq)
            const gx = ec * hx + (eb * eb * dq * hx + ea * ea * (qx - dq * hx)) * invS
            const gy = ec * hy + (eb * eb * dq * hy + ea * ea * (qy - dq * hy)) * invS
            if (Math.abs(gx) > ax) ax = Math.abs(gx)
            if (Math.abs(gy) > ay) ay = Math.abs(gy)
          }

          const px = 0.5 * (pxm + pxp)
          const py = 0.5 * (pym + pyp)
          const q = px * hx + py * hy
          const perp = Math.max(0, px * px + py * py - q * q)
          const ham = ec * q + Math.sqrt(eb * eb * q * q + ea * ea * perp)
          const diss = 0.5 * ax * (pxp - pxm) + 0.5 * ay * (pyp - pym)

          const k = j0 + i
          const advanced = c - dt * (ham - diss)
          const before = dst[k] as number
          const next = blend * before + (1 - blend) * advanced
          dst[k] = next
          if (record) {
            if (before > 0 && next <= 0) this.arrival[k] = this.clock
            const abs = next < 0 ? -next : next
            if (abs < minAbs) minAbs = abs
          }
        }
      }
      if (record) this.tileMinAbs[tid] = minAbs
    }
  }

  private rebuildTileSummaryFull(): void {
    const { n, phi, tiles, tileMinAbs } = this
    tileMinAbs.fill(Number.POSITIVE_INFINITY)
    for (let j = 0; j < n; j++) {
      const tRow = Math.floor(j / TILE_CELLS) * tiles.tilesX
      const j0 = j * n
      for (let i = 0; i < n; i++) {
        const tid = tRow + Math.floor(i / TILE_CELLS)
        const a = Math.abs(phi[j0 + i] as number)
        if (a < (tileMinAbs[tid] as number)) tileMinAbs[tid] = a
      }
    }
  }

  // -------------------------------------------------------------------------
  // Jump-flood reinitialisation
  // -------------------------------------------------------------------------

  /**
   * Push φ back toward a signed distance function over the dispatch set.
   *
   * Seeds are the *interpolated* zero crossings on cell edges, not the cell centres, which
   * is what keeps the reinitialised front sub-cell accurate — a cell-centre seeding would
   * quantise the front to the grid every 32 steps and re-introduce exactly the axis-aligned
   * bias the scheme exists to avoid.
   *
   * Jump steps start at `2·TILE_CELLS` rather than `n/2`: distances are only needed inside
   * the band, and the dispatch set is only that wide, so the extra octaves would be work
   * spent computing distances that are then discarded.
   */
  reinitialise(): void {
    const { n, cellM, phi, siteA, siteB } = this
    this.nActiveTilesRefreshed()
    if (this.nActiveTiles === 0) return

    siteA.fill(Number.NaN)
    let anySeed = false
    this.forEachActiveCell((i, j, k) => {
      const c = phi[k] as number
      let best = Number.POSITIVE_INFINITY
      let bx = 0
      let by = 0
      if (c === 0) {
        best = 0
        bx = (i + 0.5) * cellM
        by = (j + 0.5) * cellM
      } else {
        for (let d = 0; d < 4; d++) {
          const ni = i + (NB_X[d] as number)
          const nj = j + (NB_Y[d] as number)
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
          const o = phi[nj * n + ni] as number
          if (c > 0 === o > 0) continue
          const t = c / (c - o)
          const dist = Math.abs(t) * cellM
          if (dist < best) {
            best = dist
            bx = (i + 0.5 + t * (NB_X[d] as number)) * cellM
            by = (j + 0.5 + t * (NB_Y[d] as number)) * cellM
          }
        }
      }
      if (best < Number.POSITIVE_INFINITY) {
        siteA[2 * k] = bx
        siteA[2 * k + 1] = by
        anySeed = true
      }
    })
    if (!anySeed) return

    let src = siteA
    let dst = siteB
    for (let jump = 2 * TILE_CELLS; jump >= 1; jump >>= 1) {
      dst.set(src)
      this.forEachActiveCell((i, j, k) => {
        const px = (i + 0.5) * cellM
        const py = (j + 0.5) * cellM
        let bx = src[2 * k] as number
        let by = src[2 * k + 1] as number
        let best = Number.isNaN(bx) ? Number.POSITIVE_INFINITY : (px - bx) ** 2 + (py - by) ** 2
        for (let d = 0; d < 8; d++) {
          const ni = i + (JFA_X[d] as number) * jump
          const nj = j + (JFA_Y[d] as number) * jump
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
          const o = 2 * (nj * n + ni)
          const ox = src[o] as number
          if (Number.isNaN(ox)) continue
          const oy = src[o + 1] as number
          const dd = (px - ox) ** 2 + (py - oy) ** 2
          if (dd < best) {
            best = dd
            bx = ox
            by = oy
          }
        }
        if (best < Number.POSITIVE_INFINITY) {
          dst[2 * k] = bx
          dst[2 * k + 1] = by
        }
      })
      const swap = src
      src = dst
      dst = swap
    }

    this.forEachActiveCell((i, j, k) => {
      const sx = src[2 * k] as number
      if (Number.isNaN(sx)) return
      const sy = src[2 * k + 1] as number
      const px = (i + 0.5) * cellM
      const py = (j + 0.5) * cellM
      const d = Math.hypot(px - sx, py - sy)
      phi[k] = (phi[k] as number) <= 0 ? -d : d
    })
    this.refreshTileSummary()
  }

  private refreshTileSummary(): void {
    const { n, phi, tiles, tileMinAbs, tileList, nActiveTiles } = this
    for (let t = 0; t < nActiveTiles; t++) {
      const tid = tileList[t] as number
      const tx = (tid % tiles.tilesX) * TILE_CELLS
      const ty = Math.floor(tid / tiles.tilesX) * TILE_CELLS
      const iEnd = Math.min(tx + TILE_CELLS, n)
      const jEnd = Math.min(ty + TILE_CELLS, n)
      let minAbs = Number.POSITIVE_INFINITY
      for (let j = ty; j < jEnd; j++) {
        for (let i = tx; i < iEnd; i++) {
          const a = Math.abs(phi[j * n + i] as number)
          if (a < minAbs) minAbs = a
        }
      }
      tileMinAbs[tid] = minAbs
    }
  }

  private forEachActiveCell(fn: (i: number, j: number, k: number) => void): void {
    const { n, tiles, tileList, nActiveTiles } = this
    for (let t = 0; t < nActiveTiles; t++) {
      const tid = tileList[t] as number
      const tx = (tid % tiles.tilesX) * TILE_CELLS
      const ty = Math.floor(tid / tiles.tilesX) * TILE_CELLS
      const iEnd = Math.min(tx + TILE_CELLS, n)
      const jEnd = Math.min(ty + TILE_CELLS, n)
      for (let j = ty; j < jEnd; j++) {
        for (let i = tx; i < iEnd; i++) fn(i, j, j * n + i)
      }
    }
  }
}

const NB_X = [1, -1, 0, 0]
const NB_Y = [0, 0, 1, -1]
const JFA_X = [-1, 0, 1, -1, 1, -1, 0, 1]
const JFA_Y = [-1, -1, -1, 0, 0, 1, 1, 1]

/**
 * Exact signed distance to an ignition shape, in metres. Negative inside.
 *
 * `IgnitionShape` names its axes `x` and `z` — world coordinates — which map onto the
 * field's `x` and `y` grid axes respectively.
 */
export function signedDistanceTo(shape: IgnitionShape, x: number, y: number): number {
  switch (shape.kind) {
    case 'point':
      return Math.hypot(x - shape.x, y - shape.z) - shape.radius
    case 'line':
      return distanceToSegment(x, y, shape.x0, shape.z0, shape.x1, shape.z1) - shape.width / 2
    case 'ring':
      return Math.abs(Math.hypot(x - shape.x, y - shape.z) - shape.radius) - shape.width / 2
  }
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

