/**
 * The heightfield: the CPU-side source of truth for the terrain surface.
 *
 * The surface is *defined* as the piecewise-bilinear interpolant of the node heights (the
 * contract says `heightAt` is "bilinear between samples", so that is the definition, not an
 * approximation of one). Everything else — gradient, slope, aspect, normal — is derived
 * from that same definition, which is what makes the CPU query and the GPU texture agree
 * rather than merely resemble each other. See `conventions.ts`.
 */

import {
  NEIGHBOUR_DIST,
  NEIGHBOUR_DX,
  NEIGHBOUR_DZ,
  azimuthOf,
} from './conventions.ts'

export interface HeightfieldStats {
  readonly minM: number
  readonly maxM: number
  readonly meanM: number
  /** Slope tangent statistics over all nodes. */
  readonly meanSlopeTan: number
  readonly medianSlopeTan: number
  readonly p90SlopeTan: number
  readonly maxSlopeTan: number
}

/** Scratch vector, reused so the hot query path allocates nothing. */
const scratch = { x: 0, z: 0 }

export class Heightfield {
  /** Nodes per side. */
  readonly n: number
  /** Node spacing, metres. */
  readonly cellM: number
  /** Domain extent, metres. `domainM === n * cellM`. */
  readonly domainM: number
  /** Node heights, row-major, index = j * n + i where i indexes x and j indexes z. */
  readonly height: Float32Array
  /** dh/dx at nodes, metres per metre. */
  readonly gradX: Float32Array
  /** dh/dz at nodes, metres per metre. */
  readonly gradZ: Float32Array

  constructor(n: number, domainM: number) {
    if (!Number.isInteger(n) || n < 2) throw new RangeError(`heightfield needs n >= 2, got ${n}`)
    this.n = n
    this.domainM = domainM
    this.cellM = domainM / n
    this.height = new Float32Array(n * n)
    this.gradX = new Float32Array(n * n)
    this.gradZ = new Float32Array(n * n)
  }

  /** World x of node column i (texel-centre convention). */
  nodeX(i: number): number {
    return (i + 0.5) * this.cellM
  }

  /** World z of node row j. */
  nodeZ(j: number): number {
    return (j + 0.5) * this.cellM
  }

  /**
   * Recompute node gradients from the node heights.
   *
   * The gradient at a node is the derivative of the bilinear surface averaged over the four
   * patches that meet there, which is exactly the central difference. At the domain edge
   * only one patch exists, so the difference becomes one-sided — and the divisor is the
   * *actual* sampled span, not a blindly-assumed `2 * cell`, which is where the usual
   * factor-of-two edge bug lives.
   */
  recomputeGradients(): void {
    const { n, cellM, height, gradX, gradZ } = this
    for (let j = 0; j < n; j++) {
      const jm = j > 0 ? j - 1 : 0
      const jp = j < n - 1 ? j + 1 : n - 1
      const invDz = 1 / ((jp - jm) * cellM)
      const rowM = jm * n
      const rowP = jp * n
      const row = j * n
      for (let i = 0; i < n; i++) {
        const im = i > 0 ? i - 1 : 0
        const ip = i < n - 1 ? i + 1 : n - 1
        const invDx = 1 / ((ip - im) * cellM)
        gradX[row + i] = ((height[row + ip] as number) - (height[row + im] as number)) * invDx
        gradZ[row + i] = ((height[rowP + i] as number) - (height[rowM + i] as number)) * invDz
      }
    }
  }

  /**
   * Bilinear weights for a world position. Writes the base node index and the two fractions
   * into the supplied object; positions outside the node range clamp to the edge, matching
   * a `clamp-to-edge` sampler exactly.
   */
  private locate(x: number, z: number, out: { i0: number; j0: number; tx: number; tz: number }): void {
    const n = this.n
    let fx = x / this.cellM - 0.5
    let fz = z / this.cellM - 0.5
    if (!(fx > 0)) fx = 0 // also catches NaN
    else if (fx > n - 1) fx = n - 1
    if (!(fz > 0)) fz = 0
    else if (fz > n - 1) fz = n - 1
    const i0 = fx >= n - 1 ? n - 2 : Math.floor(fx)
    const j0 = fz >= n - 1 ? n - 2 : Math.floor(fz)
    out.i0 = i0
    out.j0 = j0
    out.tx = fx - i0
    out.tz = fz - j0
  }

  private readonly loc = { i0: 0, j0: 0, tx: 0, tz: 0 }

  /** Metres above sea level, bilinear between node samples. */
  heightAt(x: number, z: number): number {
    const { n, height } = this
    const loc = this.loc
    this.locate(x, z, loc)
    const a = loc.j0 * n + loc.i0
    const b = a + n
    const h00 = height[a] as number
    const h10 = height[a + 1] as number
    const h01 = height[b] as number
    const h11 = height[b + 1] as number
    const top = h00 + loc.tx * (h10 - h00)
    const bot = h01 + loc.tx * (h11 - h01)
    return top + loc.tz * (bot - top)
  }

  /**
   * Terrain gradient (dh/dx, dh/dz) at a world position, as the bilinear interpolant of the
   * node gradients. Writes into `out` to keep the query allocation-free.
   */
  gradientAt(x: number, z: number, out: { x: number; z: number }): void {
    const { n, gradX, gradZ } = this
    const loc = this.loc
    this.locate(x, z, loc)
    const a = loc.j0 * n + loc.i0
    const b = a + n
    const tx = loc.tx
    const tz = loc.tz
    const gx0 = (gradX[a] as number) + tx * ((gradX[a + 1] as number) - (gradX[a] as number))
    const gx1 = (gradX[b] as number) + tx * ((gradX[b + 1] as number) - (gradX[b] as number))
    const gz0 = (gradZ[a] as number) + tx * ((gradZ[a + 1] as number) - (gradZ[a] as number))
    const gz1 = (gradZ[b] as number) + tx * ((gradZ[b + 1] as number) - (gradZ[b] as number))
    out.x = gx0 + tz * (gx1 - gx0)
    out.z = gz0 + tz * (gz1 - gz0)
  }

  /** Slope as a tangent — magnitude of the horizontal gradient. */
  slopeAt(x: number, z: number): number {
    this.gradientAt(x, z, scratch)
    return Math.hypot(scratch.x, scratch.z)
  }

  /**
   * Downslope azimuth, radians clockwise from north, in [0, 2*pi).
   *
   * Aspect is undefined on a perfectly flat cell; 0 is returned there. Callers that care
   * (solar load on a slope, for one) should gate on `slopeAt` rather than reading meaning
   * into that zero.
   */
  aspectAt(x: number, z: number): number {
    this.gradientAt(x, z, scratch)
    if (scratch.x === 0 && scratch.z === 0) return 0
    return azimuthOf(-scratch.x, -scratch.z)
  }

  /** Unit surface normal, y-up. */
  normalAt(x: number, z: number): [number, number, number] {
    this.gradientAt(x, z, scratch)
    const gx = scratch.x
    const gz = scratch.z
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1)
    return [-gx * inv, inv, -gz * inv]
  }

  /** Slope tangent and aspect at an exact node — what the GPU texture stores. */
  nodeSlopeAspect(index: number): readonly [number, number] {
    const gx = this.gradX[index] as number
    const gz = this.gradZ[index] as number
    const slope = Math.hypot(gx, gz)
    const aspect = gx === 0 && gz === 0 ? 0 : azimuthOf(-gx, -gz)
    return [slope, aspect]
  }

  stats(): HeightfieldStats {
    const { height, n } = this
    const count = n * n
    let min = Infinity
    let max = -Infinity
    let sum = 0
    for (let k = 0; k < count; k++) {
      const h = height[k] as number
      if (h < min) min = h
      if (h > max) max = h
      sum += h
    }
    const slopes = new Float64Array(count)
    let slopeSum = 0
    for (let k = 0; k < count; k++) {
      const s = Math.hypot(this.gradX[k] as number, this.gradZ[k] as number)
      slopes[k] = s
      slopeSum += s
    }
    slopes.sort()
    const q = (f: number): number => slopes[Math.min(count - 1, Math.floor(f * count))] as number
    return {
      minM: min,
      maxM: max,
      meanM: sum / count,
      meanSlopeTan: slopeSum / count,
      medianSlopeTan: q(0.5),
      p90SlopeTan: q(0.9),
      maxSlopeTan: slopes[count - 1] as number,
    }
  }

  /**
   * True when every interior node has a strictly lower 8-neighbour, i.e. the field contains
   * no closed basins. Boundary nodes drain off the domain edge and are exempt.
   */
  hasNoClosedBasins(): boolean {
    return this.findClosedBasins(1).length === 0
  }

  /** Node indices of local minima (closed basins), up to `limit` of them. */
  findClosedBasins(limit = 64): number[] {
    const { n, height } = this
    const pits: number[] = []
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i
        const h = height[c] as number
        let drains = false
        for (let k = 0; k < 8; k++) {
          const nb = (j + (NEIGHBOUR_DZ[k] as number)) * n + i + (NEIGHBOUR_DX[k] as number)
          if ((height[nb] as number) < h) {
            drains = true
            break
          }
        }
        if (!drains) {
          pits.push(c)
          if (pits.length >= limit) return pits
        }
      }
    }
    return pits
  }

  /**
   * D8 steepest-descent receiver for every node: the index of the neighbour the water goes
   * to, or -1 where the node drains off the domain edge. Slope is compared per unit
   * *distance*, so diagonals are not spuriously preferred.
   */
  computeReceivers(): Int32Array {
    const { n, height, cellM } = this
    const recv = new Int32Array(n * n)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        const h = height[c] as number
        let best = -1
        let bestDrop = 0
        for (let k = 0; k < 8; k++) {
          const ni = i + (NEIGHBOUR_DX[k] as number)
          const nj = j + (NEIGHBOUR_DZ[k] as number)
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) {
            // Off the domain edge: an outlet. Treated as an unbeatable receiver so edge
            // cells always terminate a flow path instead of pooling against the border.
            best = -1
            bestDrop = Infinity
            break
          }
          const nb = nj * n + ni
          const drop = (h - (height[nb] as number)) / ((NEIGHBOUR_DIST[k] as number) * cellM)
          if (drop > bestDrop) {
            bestDrop = drop
            best = nb
          }
        }
        recv[c] = best
      }
    }
    return recv
  }
}
