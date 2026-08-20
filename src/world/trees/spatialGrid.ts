/**
 * Uniform spatial hash for nearest-point queries during tree generation (WP 1.4).
 *
 * Generation has two O(n*m) inner loops — attractor-to-node association in the colonisation
 * step, and foliage-element-to-branch-tip attachment. At 3200 attractors, 1800 foliage
 * elements and ~900 nodes that is over four million distance tests per tree, which at a few
 * hundred unique meshes is the difference between a world that builds in a second and one
 * that builds in ten. This makes both loops roughly linear.
 */

export class PointGrid {
  private readonly cells = new Map<number, number[]>()

  constructor(private readonly cellSize: number) {}

  private key(x: number, y: number, z: number): number {
    const ix = Math.floor(x / this.cellSize)
    const iy = Math.floor(y / this.cellSize)
    const iz = Math.floor(z / this.cellSize)
    // 10 bits per axis. Far-apart cells can alias onto one bucket; that only ever adds
    // candidates to a query, and every candidate is distance-tested, so it costs time and
    // never correctness.
    return (((ix & 1023) << 20) | ((iy & 1023) << 10) | (iz & 1023)) >>> 0
  }

  insert(index: number, x: number, y: number, z: number): void {
    const k = this.key(x, y, z)
    const bucket = this.cells.get(k)
    if (bucket) bucket.push(index)
    else this.cells.set(k, [index])
  }

  /**
   * Nearest inserted index to (x,y,z), searching outward in rings of cells until something
   * is found or `maxRings` is exhausted. Returns -1 if nothing is within reach.
   */
  nearest(
    x: number,
    y: number,
    z: number,
    px: (i: number) => number,
    py: (i: number) => number,
    pz: (i: number) => number,
    maxRings = 6,
  ): number {
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    let best = -1
    let bestD2 = Infinity

    for (let ring = 0; ring <= maxRings; ring++) {
      for (let ox = -ring; ox <= ring; ox++) {
        for (let oy = -ring; oy <= ring; oy++) {
          for (let oz = -ring; oz <= ring; oz++) {
            // Only the shell of this ring is new.
            if (ring > 0 && Math.abs(ox) !== ring && Math.abs(oy) !== ring && Math.abs(oz) !== ring) {
              continue
            }
            const k =
              ((((cx + ox) & 1023) << 20) | (((cy + oy) & 1023) << 10) | ((cz + oz) & 1023)) >>> 0
            const bucket = this.cells.get(k)
            if (bucket === undefined) continue
            for (let i = 0; i < bucket.length; i++) {
              const idx = bucket[i]!
              const dx = px(idx) - x
              const dy = py(idx) - y
              const dz = pz(idx) - z
              const d2 = dx * dx + dy * dy + dz * dz
              if (d2 < bestD2) {
                bestD2 = d2
                best = idx
              }
            }
          }
        }
      }
      // One extra ring after the first hit: a point in a diagonal neighbour can still beat
      // one found in the current shell.
      if (best >= 0 && ring >= 1) break
    }
    return best
  }
}
