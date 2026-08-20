/**
 * Channel incision from flow accumulation.
 *
 * Droplet erosion produces the *texture* of fluvial terrain — rills, gullies, sediment
 * fans — but on a 1 km domain with a realistic droplet budget it under-cuts the trunk
 * valleys, because a droplet's lifetime is tens of steps and the trunk channel is a
 * thousand cells long. The result is a landscape that looks eroded up close and has no
 * canyon at the bottom of it.
 *
 * The fix is the standard geomorphological one: incise proportionally to upstream
 * contributing area. Stream-power law incision goes as `A^m S^n`; here only the area
 * dependence is used, log-compressed, because the aim is a plausible channel *geometry* to
 * put fire into rather than a landscape-evolution model. Everything downstream reads this
 * as terrain, not as a hydrological prediction, and it is documented as `estimated` under
 * spec §0.7.3 accordingly.
 *
 * Two properties matter for what consumes it:
 *
 * - **Monotone downstream.** Contributing area only increases downstream, so the incision
 *   depth only increases downstream, so incision cannot create a closed basin along a
 *   channel. (Confluence blur can perturb this slightly; the final priority-flood pass in
 *   the generator is what actually guarantees the no-basin property.)
 * - **Banked, not slotted.** The depth field is blurred before it is subtracted, so a
 *   channel gets sloping walls a few cells wide instead of a one-cell vertical slot. A slot
 *   would give the surface solver a single line of near-vertical cells — `tan phi` clamped
 *   at 0.7 in every direction — which is exactly the artefact that makes canyon channelling
 *   look like a bug.
 */

/**
 * Separable box blur of radius `r` nodes, applied `passes` times, on an `n x n` field.
 * Edges clamp. O(n^2) per pass regardless of radius, via a running sum — which is why the
 * blur radius can be set in *metres* and left resolution-independent instead of being
 * whatever a fixed 3-tap kernel happens to reach.
 *
 * Two passes of a box approximate a triangular kernel, which is smooth enough that the
 * channel walls have no visible facet.
 */
export function blurBox(src: Float32Array, n: number, r: number, passes: number): Float32Array {
  const radius = Math.max(0, Math.floor(r))
  const a = Float32Array.from(src)
  if (radius === 0 || passes <= 0) return a
  const b = new Float32Array(n * n)
  const width = 2 * radius + 1
  const inv = 1 / width

  for (let p = 0; p < passes; p++) {
    // Horizontal, running sum with clamped edges.
    for (let j = 0; j < n; j++) {
      const row = j * n
      let sum = (a[row] as number) * (radius + 1)
      for (let i = 1; i <= radius; i++) sum += a[row + Math.min(i, n - 1)] as number
      for (let i = 0; i < n; i++) {
        b[row + i] = sum * inv
        sum += (a[row + Math.min(i + radius + 1, n - 1)] as number) - (a[row + Math.max(i - radius, 0)] as number)
      }
    }
    // Vertical.
    for (let i = 0; i < n; i++) {
      let sum = (b[i] as number) * (radius + 1)
      for (let j = 1; j <= radius; j++) sum += b[Math.min(j, n - 1) * n + i] as number
      for (let j = 0; j < n; j++) {
        a[j * n + i] = sum * inv
        sum +=
          (b[Math.min(j + radius + 1, n - 1) * n + i] as number) -
          (b[Math.max(j - radius, 0) * n + i] as number)
      }
    }
  }
  return a
}

export interface IncisionResult {
  /** Depth actually subtracted at each node, metres. */
  readonly depthM: Float32Array
  readonly maxDepthM: number
  /** Nodes whose contributing area exceeds the channel threshold. */
  readonly channelCells: number
}

export interface IncisionConfig {
  /** Deepest cut applied to a trunk channel, metres. */
  readonly maxDepthM: number
  /** Contributing area, m^2, at which a node starts to count as a channel. */
  readonly thresholdAreaM2: number
  /** Contributing area, m^2, at which the cut reaches `maxDepthM`. */
  readonly saturationAreaM2: number
  /**
   * Half-width of the channel's sloping bank, in NODES. Set from a metre figure by the
   * caller so the bank geometry does not change with grid resolution: a 10 m cut with a
   * 1-node bank is a cliff, and cliffs are what make canyon channelling look like a bug.
   */
  readonly bankRadiusNodes: number
  readonly blurPasses: number
}

/**
 * Subtract a log-of-contributing-area incision profile from `height` in place.
 *
 * `acc` is upslope contributing area in m^2 (from `flowAccumulation`).
 */
export function inciseChannels(
  height: Float32Array,
  acc: Float32Array,
  n: number,
  cfg: IncisionConfig,
): IncisionResult {
  const count = n * n
  const raw = new Float32Array(count)
  const lo = Math.log(cfg.thresholdAreaM2)
  const span = Math.log(cfg.saturationAreaM2) - lo
  let channelCells = 0

  for (let k = 0; k < count; k++) {
    const a = acc[k] as number
    if (a <= cfg.thresholdAreaM2) continue
    channelCells++
    const t = span > 0 ? Math.min(1, (Math.log(a) - lo) / span) : 1
    raw[k] = cfg.maxDepthM * t
  }

  const depth = blurBox(raw, n, cfg.bankRadiusNodes, cfg.blurPasses)
  let maxDepthM = 0
  for (let k = 0; k < count; k++) {
    const d = depth[k] as number
    if (d > maxDepthM) maxDepthM = d
    height[k] = (height[k] as number) - d
  }
  return { depthM: depth, maxDepthM, channelCells }
}
