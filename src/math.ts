/**
 * Scalar helpers shared across packages. Nothing here is domain-specific and nothing here
 * carries state.
 *
 * What deliberately does NOT live here:
 *
 *  - **The RNGs.** `world/terrain/rng.ts` (SplitMix32), `world/trees/rng.ts` (mulberry32 with
 *    Box–Muller) and `world/vegetation/rng.ts` (mulberry32 + Stafford hashes) are three
 *    different algorithms. They look mergeable and are not: a seed must reproduce the same
 *    world byte for byte, so unifying the streams would silently regenerate every world.
 *  - **`render/materials/noise.ts`.** That file is the CPU oracle for
 *    `shaders/materials/noise.wgsl` and its self-containedness is the point — its `hashU32`
 *    is Wellons' lowbias32, which is a *different function* from terrain's SplitMix32
 *    finaliser and from the PCG hash in `sim/firebrands/brands.ts`, despite the shared name.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Hermite step. A zero-width edge degrades to a hard step rather than emitting NaN. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
