/**
 * Triangle accumulation for generated tree geometry (WP 1.4).
 *
 * Deliberately dumb: push vertices, push indices, emit a `TreeLod`. The only structure it
 * imposes is that each material's index range is contiguous, because `TreeLod.submeshes`
 * carries (start, count) ranges and the foliage renderer issues one indirect draw per
 * material slot. Interleaving materials would force a sort at upload time.
 */

import type { TreeLod } from '@contracts/world.ts'

export type TreeMaterial = 'bark' | 'foliage' | 'ribbon'

/**
 * Typed arrays that double on overflow, rather than `number[]` plus a copy at the end.
 * A LOD-0 crown is ~20 000 triangles and ~25 000 vertices; at 8 floats and 3 indices each
 * that is over 250 000 boxed pushes per LOD, three LODs per tree and a few hundred trees per
 * world, which measurably dominated generation before this.
 */
export class MeshBuilder {
  private px: Float32Array
  private nrm: Float32Array
  private uv: Float32Array
  private idx: Uint32Array
  private nVerts = 0
  private nIdx = 0
  private readonly ranges: { material: TreeMaterial; start: number; count: number }[] = []
  private open: { material: TreeMaterial; start: number } | null = null

  constructor(vertexCapacity = 4096, indexCapacity = 8192) {
    this.px = new Float32Array(vertexCapacity * 3)
    this.nrm = new Float32Array(vertexCapacity * 3)
    this.uv = new Float32Array(vertexCapacity * 2)
    this.idx = new Uint32Array(indexCapacity)
  }

  /** Open a contiguous index range for `material`. Closes any range already open. */
  begin(material: TreeMaterial): void {
    this.end()
    this.open = { material, start: this.nIdx }
  }

  end(): void {
    if (this.open === null) return
    const count = this.nIdx - this.open.start
    if (count > 0) this.ranges.push({ material: this.open.material, start: this.open.start, count })
    this.open = null
  }

  get vertexCount(): number {
    return this.nVerts
  }

  get triangleCount(): number {
    return this.nIdx / 3
  }

  private growVertices(): void {
    const cap = this.px.length / 3
    const next = cap * 2
    const px = new Float32Array(next * 3)
    px.set(this.px)
    const nrm = new Float32Array(next * 3)
    nrm.set(this.nrm)
    const uv = new Float32Array(next * 2)
    uv.set(this.uv)
    this.px = px
    this.nrm = nrm
    this.uv = uv
  }

  private growIndices(need: number): void {
    let next = this.idx.length * 2
    while (next < this.nIdx + need) next *= 2
    const idx = new Uint32Array(next)
    idx.set(this.idx)
    this.idx = idx
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): number {
    if (this.nVerts * 3 + 3 > this.px.length) this.growVertices()
    const i = this.nVerts++
    this.px[i * 3] = x
    this.px[i * 3 + 1] = y
    this.px[i * 3 + 2] = z
    this.nrm[i * 3] = nx
    this.nrm[i * 3 + 1] = ny
    this.nrm[i * 3 + 2] = nz
    this.uv[i * 2] = u
    this.uv[i * 2 + 1] = v
    return i
  }

  tri(a: number, b: number, c: number): void {
    if (this.nIdx + 3 > this.idx.length) this.growIndices(3)
    this.idx[this.nIdx++] = a
    this.idx[this.nIdx++] = b
    this.idx[this.nIdx++] = c
  }

  /** Quad as two triangles, wound a-b-c / a-c-d. */
  quad(a: number, b: number, c: number, d: number): void {
    if (this.nIdx + 6 > this.idx.length) this.growIndices(6)
    const i = this.idx
    let n = this.nIdx
    i[n++] = a
    i[n++] = b
    i[n++] = c
    i[n++] = a
    i[n++] = c
    i[n++] = d
    this.nIdx = n
  }

  build(): TreeLod {
    this.end()
    return {
      positions: this.px.slice(0, this.nVerts * 3),
      normals: this.nrm.slice(0, this.nVerts * 3),
      uvs: this.uv.slice(0, this.nVerts * 2),
      indices: this.idx.slice(0, this.nIdx),
      submeshes: this.ranges.map((r) => ({ material: r.material, start: r.start, count: r.count })),
      triangleCount: this.nIdx / 3,
    }
  }
}

// ---------------------------------------------------------------------------
// Small vector helpers. Kept local rather than pulled from a sibling's math module:
// packages import from @contracts and from their own directory only.
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number]

export function normalise(v: Vec3): Vec3 {
  const m = Math.hypot(v[0], v[1], v[2])
  if (m < 1e-12) return [0, 1, 0]
  return [v[0] / m, v[1] / m, v[2] / m]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Any unit vector perpendicular to `v`, chosen to stay well-conditioned. */
export function perpendicular(v: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  return normalise(cross(v, ref))
}
