/**
 * Procedural material synthesis. WP 1.6.
 *
 * This is the fallback generator required by the assignment: the full material set — bark,
 * needle/leaf atlas, soil, litter, grass, rock, plus the char and ash burn states — is
 * synthesised from noise, with no downloaded assets. M1 runs entirely on these.
 *
 * The design that keeps this honest rather than a pile of one-off shaders: there are six
 * *pattern kinds*, each driven by the same `PatternParams` struct. The TypeScript here and
 * the WGSL in `shaders/materials/generate.wgsl` evaluate the same parameterised function, so
 * the CPU generator is a testable oracle for the GPU one rather than a separate artwork.
 *
 * Burn state is not a seventh pattern kind. Every material is generated at four *stages* —
 * green, scorch, char, ash — from the SAME underlying noise field, so the spatial structure
 * is coherent across the blend and a tree that chars from the bottom up does not shimmer at
 * the boundary. The four stages become four consecutive layers of the shared texture array
 * (spec §7.6), and the shader lerps between `floor(b)` and `floor(b)+1`.
 *
 * Colour targets for the scorch/char/ash stages are the §7.6 table, in LINEAR RGB. They are
 * asserted by the tests, because a material set whose char is not actually char-coloured
 * silently un-grounds every M4 burn visual.
 */

import {
  clamp01,
  fbm2P,
  hash2i,
  hashU32,
  lerp,
  ridged2P,
  rotate2,
  smoothstep,
  u32ToUnit,
  valueNoise2P,
  warp2P,
  worley2P,
} from './noise.ts'

// ---------------------------------------------------------------------------
// Burn stages
// ---------------------------------------------------------------------------

/** Layer within a burnable material's 4-layer run. Spec §7.6. */
export const BURN_STAGE = { Green: 0, Scorch: 1, Char: 2, Ash: 3 } as const
export type BurnStage = (typeof BURN_STAGE)[keyof typeof BURN_STAGE]
export const BURN_STAGES: readonly BurnStage[] = [0, 1, 2, 3]
/** Every burnable material occupies this many consecutive array layers. */
export const BURN_LAYER_COUNT = 4

export interface BurnTarget {
  /** LINEAR RGB. Spec §7.6 table. */
  readonly albedo: readonly [number, number, number]
  readonly roughness: number
}

/**
 * Spec §7.6, "Progressive burn materials". These are the values the whole burn visual is
 * anchored to; they are linear RGB, not sRGB bytes, and the test asserts the generated
 * layers reproduce them in the mean.
 */
export const BURN_TARGETS: readonly [BurnTarget, BurnTarget, BurnTarget, BurnTarget] = [
  { albedo: [0.09, 0.16, 0.05], roughness: 0.55 }, // green foliage
  { albedo: [0.14, 0.08, 0.03], roughness: 0.68 }, // heat-scorched brown
  { albedo: [0.035, 0.033, 0.032], roughness: 0.85 }, // black char
  { albedo: [0.62, 0.61, 0.59], roughness: 0.96 }, // grey ash
]

// ---------------------------------------------------------------------------
// Pattern parameters
// ---------------------------------------------------------------------------

export const PATTERN = {
  /** Trunk bark: worley plates blended with ridged vertical fissures. */
  Bark: 0,
  /** Alpha-tested leaf/needle atlas: one element per atlas cell. */
  FoliageAtlas: 1,
  /** Soil / duff / powder: fbm grain plus scattered pebbles. */
  Granular: 2,
  /** Forest floor litter: overlapping elongated needle and leaf pieces. */
  Litter: 3,
  /** Alpha-tested grass blade card, blades rooted at v=0. */
  Grass: 4,
  /** Fractured rock, non-burnable. */
  Rock: 5,
} as const
export type PatternKind = (typeof PATTERN)[keyof typeof PATTERN]

/**
 * One material's procedural recipe. Kept flat and numeric so it maps 1:1 onto a WGSL struct
 * in a storage buffer — the GPU generator indexes this array by layer, which is what lets
 * the whole material set be produced in a single dispatch.
 */
export interface PatternParams {
  readonly kind: PatternKind
  readonly seed: number
  /** World size of one UV tile, metres. Sets the physical scale of the normal map. */
  readonly tileSizeM: number
  /** Primary feature lattice period along u. Integer, for seamless tiling. */
  readonly periodU: number
  /** Primary feature lattice period along v. Unequal periods give anisotropy for free. */
  readonly periodV: number
  /** Height amplitude of the dominant feature, metres. */
  readonly reliefM: number
  /** 0 = pure ridged fissures, 1 = pure worley plates. Bark only. */
  readonly plateiness: number
  /** Unburnt linear albedo of the raised / lit part of the pattern. */
  readonly baseAlbedo: readonly [number, number, number]
  /** Unburnt linear albedo of the recessed / shadowed part. */
  readonly deepAlbedo: readonly [number, number, number]
  readonly baseRoughness: number
  readonly roughnessVariation: number
  readonly metallic: number
  /** Atlas cells across u and v (FoliageAtlas, Litter, Grass). */
  readonly cellsU: number
  readonly cellsV: number
  /** Element half-width, in cell units. Needles are thin; broadleaves are not. */
  readonly elementWidth: number
  /** Element half-length, in cell units. Must stay <= 0.5 so elements do not cross cells. */
  readonly elementLength: number
  /** Taper exponent toward the element tip. 1 = ellipse-ish, 3 = sharply pointed. */
  readonly tipSharpness: number
  /** Fine grain lattice period (both axes). */
  readonly grainPeriod: number
  /**
   * How completely this material adopts the §7.6 scorch/char/ash targets, per stage.
   * Foliage goes all the way; bark is already brown so its scorch stage moves less.
   */
  readonly burnResponse: readonly [number, number, number]
  /**
   * The mean of this pattern's own `detail` field, measured, not assumed.
   *
   * `applyBurn` modulates the burn-stage target by `1 + k*(detail - detailMean)`, which has
   * mean exactly 1 only if this value is right. Assuming 0.5 works for the bark and ground
   * patterns and is badly wrong for the alpha-tested atlases, whose `detail` is near zero
   * across the empty part of every cell — which would land the char layer well below the
   * published §7.6 albedo while looking, at a glance, fine.
   *
   * Filled in by `packMaterials`; computed by `patternDetailMean`.
   */
  readonly detailMean: number
}

export interface PatternSample {
  /** LINEAR RGB. The generator sRGB-encodes it on the way into the texture. */
  readonly albedo: readonly [number, number, number]
  readonly roughness: number
  readonly occlusion: number
  readonly metallic: number
  /** Linear coverage. Stored un-encoded in the albedo texture's alpha channel. */
  readonly alpha: number
  /**
   * Structure field on [0,1]. Carries the material's own features — bark furrows, leaf
   * veins — into the burn stages, and into the ORM alpha channel as burn susceptibility.
   * Its mean over the tile is `PatternParams.detailMean`, measured rather than assumed.
   */
  readonly detail: number
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function scale3(a: readonly [number, number, number], k: number): [number, number, number] {
  return [a[0] * k, a[1] * k, a[2] * k]
}

/** Per-cell attribute in [0,1) from a cell hash and a stream index. */
function cellUnit(cellHash: number, stream: number): number {
  return u32ToUnit(hashU32((cellHash ^ Math.imul(stream + 1, 0x9e3779b1)) >>> 0))
}

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

/**
 * Height in metres above the tile's mean plane. Split out from `samplePattern` because the
 * generator evaluates it four extra times per texel for the central-difference normal, and
 * it is much cheaper than the full shade.
 */
export function patternHeight(p: PatternParams, u: number, v: number, stage: BurnStage): number {
  let h: number
  switch (p.kind) {
    case PATTERN.Bark: {
      const [wu, wv] = warp2P(u, v, p.periodU, p.periodV, p.seed ^ 0x1b873593, 0.35)
      const w = worley2P(wu, wv, p.periodU, p.periodV, p.seed)
      const plate = smoothstep(0.02, 0.22, w.f2 - w.f1)
      const fissure = ridged2P(u, v, p.periodU * 2, Math.max(1, p.periodV), p.seed + 7, 4, 3)
      const dominant = lerp(fissure, plate, p.plateiness)
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod * 2, p.seed + 11, 3)
      h = p.reliefM * (dominant + 0.22 * grain)
      break
    }
    case PATTERN.FoliageAtlas: {
      const e = foliageElement(p, u, v)
      // Midrib ridge plus lateral veins, both only inside the leaf.
      const midrib = Math.exp(-Math.pow(e.lx / Math.max(1e-4, 0.22 * p.elementWidth), 2))
      const veins = 0.5 + 0.5 * Math.cos(e.ly * 46)
      h = p.reliefM * e.mask * (0.55 * midrib + 0.2 * veins + 0.25 * e.core)
      break
    }
    case PATTERN.Granular: {
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod, p.seed, 5)
      const peb = worley2P(u, v, p.periodU, p.periodV, p.seed + 3)
      const pebble = smoothstep(0.42, 0.14, peb.f1)
      h = p.reliefM * (0.55 * grain + 0.9 * pebble * (0.42 - Math.min(peb.f1, 0.42)))
      break
    }
    case PATTERN.Litter: {
      const e = litterElement(p, u, v)
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod, p.seed + 17, 4)
      h = p.reliefM * (0.3 * grain + e.mask * (0.4 + 0.6 * e.lift))
      break
    }
    case PATTERN.Grass: {
      const e = grassBlade(p, u, v)
      h = p.reliefM * e.mask * (0.4 + 0.6 * e.core)
      break
    }
    case PATTERN.Rock: {
      const w = worley2P(u, v, p.periodU, p.periodV, p.seed)
      const facet = smoothstep(0.0, 0.16, w.f2 - w.f1)
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod, p.seed + 5, 4)
      h = p.reliefM * (0.8 * facet + 0.3 * grain)
      break
    }
    default:
      h = 0
  }
  return h * burnReliefScale(stage)
}

/**
 * Scorch curls and shrinks the surface (relief up slightly); ash is powder and has almost
 * none. Char keeps the parent relief because its cracks come from the *shared* crack field
 * at shade time, not from baked geometry — baking them here and applying the field too would
 * double-count, which §7.6 explicitly warns against.
 */
function burnReliefScale(stage: BurnStage): number {
  switch (stage) {
    case BURN_STAGE.Scorch:
      return 1.15
    case BURN_STAGE.Char:
      return 1.0
    case BURN_STAGE.Ash:
      return 0.35
    default:
      return 1
  }
}

// ---------------------------------------------------------------------------
// Element geometry shared by the atlas-style patterns
// ---------------------------------------------------------------------------

interface Element {
  /** Coverage in [0,1]. */
  readonly mask: number
  /** Signed lateral offset from the element's spine, in cell units. */
  readonly lx: number
  /** Signed offset along the element's spine, in cell units. */
  readonly ly: number
  /** 1 at the spine, falling to 0 at the silhouette. */
  readonly core: number
  readonly cellHash: number
}

/** One leaf or needle per atlas cell, rotated by a per-cell hash. */
function foliageElement(p: PatternParams, u: number, v: number): Element {
  const cu = Math.max(1, p.cellsU)
  const cv = Math.max(1, p.cellsV)
  const gx = u * cu
  const gy = v * cv
  const ix = Math.floor(gx)
  const iy = Math.floor(gy)
  const h = hash2i(((ix % cu) + cu) % cu, ((iy % cv) + cv) % cv, p.seed)
  const angle = cellUnit(h, 0) * Math.PI * 2
  const sizeJitter = 0.75 + 0.5 * cellUnit(h, 1)
  const [lx, ly] = rotate2(gx - ix - 0.5, gy - iy - 0.5, angle)
  const halfLen = Math.min(0.5, p.elementLength) * sizeJitter
  // Taper from the base to the tip.
  const along = clamp01(1 - Math.abs(ly) / Math.max(1e-4, halfLen))
  const halfWidth = p.elementWidth * sizeJitter * Math.pow(along, 1 / Math.max(0.25, p.tipSharpness))
  const d = 1 - Math.abs(lx) / Math.max(1e-4, halfWidth)
  const mask = along <= 0 ? 0 : smoothstep(0, 0.35, d)
  return { mask, lx, ly, core: clamp01(d), cellHash: h }
}

interface LitterElement extends Element {
  /** How far this piece sits above the duff, 0..1. Upper pieces cast onto lower ones. */
  readonly lift: number
}

/**
 * Forest-floor litter: two offset layers of the same cell scheme, so pieces visibly overlap.
 * A single layer reads as a regular lattice of needles no matter how much the cells are
 * jittered, because every cell contains exactly one piece; the second, half-cell-offset layer
 * is what breaks that up. The upper layer wins where it covers, and `lift` records which
 * layer we landed on so the height field can step between them.
 */
function litterElement(p: PatternParams, u: number, v: number): LitterElement {
  const lower = foliageElement(p, u, v)
  // Offset by half a cell in both axes and reseeded: a genuinely independent second layer.
  const cu = Math.max(1, p.cellsU)
  const cv = Math.max(1, p.cellsV)
  const upper = foliageElement(
    { ...p, seed: (p.seed ^ 0x68e31da4) >>> 0 },
    u + 0.5 / cu,
    v + 0.5 / cv,
  )
  if (upper.mask >= lower.mask) {
    return { ...upper, lift: 1 }
  }
  return { ...lower, lift: 0 }
}

/** Grass blades rooted at v = 0, bending with height. Periodic in u only. */
function grassBlade(p: PatternParams, u: number, v: number): Element {
  const cu = Math.max(1, p.cellsU)
  const gx = u * cu
  const ix = Math.floor(gx)
  const fx = gx - ix
  const h = hash2i(((ix % cu) + cu) % cu, 0, p.seed)
  const bend = (cellUnit(h, 2) - 0.5) * 1.2
  const height = 0.55 + 0.45 * cellUnit(h, 3)
  const centre = 0.5 + (cellUnit(h, 0) - 0.5) * 0.5 + bend * v * v
  const alive = v <= height ? 1 : 0
  const taper = clamp01(1 - v / Math.max(1e-4, height))
  const halfWidth = p.elementWidth * (0.25 + 0.75 * Math.pow(taper, 0.6))
  const d = 1 - Math.abs(fx - centre) / Math.max(1e-4, halfWidth)
  const mask = alive * smoothstep(0, 0.3, d)
  return { mask, lx: fx - centre, ly: v, core: clamp01(d), cellHash: h }
}

// ---------------------------------------------------------------------------
// Shade
// ---------------------------------------------------------------------------

/** Full appearance at one texel of one stage. */
export function samplePattern(
  p: PatternParams,
  u: number,
  v: number,
  stage: BurnStage,
): PatternSample {
  const raw = shadeUnburnt(p, u, v)
  return applyBurn(p, raw, stage)
}

/** Grid resolution `patternDetailMean` integrates over. Deterministic, hence reproducible. */
export const DETAIL_MEAN_SAMPLES = 48

/**
 * Measure the mean of a pattern's `detail` field on a fixed grid.
 *
 * A regular grid rather than a random sample, because the result must be bit-identical every
 * run: it feeds the burn-stage modulation, so a wobbly estimate would make the generated
 * textures non-deterministic and break the CPU/GPU comparison.
 *
 * 48x48 = 2304 samples is enough for three decimal places on every pattern in the library,
 * and it runs once per material at build time.
 */
export function patternDetailMean(p: Omit<PatternParams, 'detailMean'>): number {
  const probe: PatternParams = { ...p, detailMean: 0.5 }
  let acc = 0
  const n = DETAIL_MEAN_SAMPLES
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      acc += shadeUnburnt(probe, (x + 0.5) / n, (y + 0.5) / n).detail
    }
  }
  return acc / (n * n)
}

function shadeUnburnt(p: PatternParams, u: number, v: number): PatternSample {
  switch (p.kind) {
    case PATTERN.Bark: {
      const [wu, wv] = warp2P(u, v, p.periodU, p.periodV, p.seed ^ 0x1b873593, 0.35)
      const w = worley2P(wu, wv, p.periodU, p.periodV, p.seed)
      const plate = smoothstep(0.02, 0.22, w.f2 - w.f1)
      const fissure = ridged2P(u, v, p.periodU * 2, Math.max(1, p.periodV), p.seed + 7, 4, 3)
      const dominant = lerp(fissure, plate, p.plateiness)
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod * 2, p.seed + 11, 3)
      // Per-plate colour jitter: real bark plates weather independently.
      const tint = 0.82 + 0.36 * cellUnit(w.cell, 4)
      const detail = clamp01(0.55 * dominant + 0.45 * grain)
      const albedo = scale3(mix3(p.deepAlbedo, p.baseAlbedo, dominant), tint * (0.8 + 0.4 * grain))
      return {
        albedo,
        roughness: clamp01(p.baseRoughness + p.roughnessVariation * (grain - 0.5) * 2),
        // Furrows self-shadow. This is the AO channel earning its place: without it bark
        // reads as a flat noise print under any sky-dominated lighting.
        occlusion: clamp01(0.35 + 0.65 * dominant),
        metallic: p.metallic,
        alpha: 1,
        detail,
      }
    }
    case PATTERN.FoliageAtlas: {
      const e = foliageElement(p, u, v)
      const veins = 0.5 + 0.5 * Math.cos(e.ly * 46)
      const leafTint = 0.78 + 0.44 * cellUnit(e.cellHash, 5)
      // Leaf edges are thinner, lighter and rougher than the centre.
      const centreness = clamp01(e.core)
      const albedo = scale3(mix3(p.baseAlbedo, p.deepAlbedo, centreness * 0.7), leafTint)
      const detail = clamp01(0.6 * centreness + 0.4 * veins)
      return {
        albedo,
        roughness: clamp01(p.baseRoughness + p.roughnessVariation * (0.5 - centreness) * 2),
        occlusion: clamp01(0.6 + 0.4 * centreness),
        metallic: p.metallic,
        alpha: e.mask,
        detail,
      }
    }
    case PATTERN.Granular: {
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod, p.seed, 5)
      const peb = worley2P(u, v, p.periodU, p.periodV, p.seed + 3)
      const pebble = smoothstep(0.42, 0.14, peb.f1)
      const pebTint = 0.8 + 0.4 * cellUnit(peb.cell, 6)
      const base = mix3(p.deepAlbedo, p.baseAlbedo, grain)
      const albedo = scale3(mix3(base, scale3(p.baseAlbedo, pebTint), pebble), 1)
      const detail = clamp01(0.7 * grain + 0.3 * pebble)
      return {
        albedo,
        roughness: clamp01(p.baseRoughness + p.roughnessVariation * (grain - 0.5) * 2),
        occlusion: clamp01(0.55 + 0.45 * grain),
        metallic: p.metallic,
        alpha: 1,
        detail,
      }
    }
    case PATTERN.Litter: {
      const e = litterElement(p, u, v)
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod, p.seed + 17, 4)
      const pieceTint = 0.7 + 0.6 * cellUnit(e.cellHash, 7)
      // Where no piece covers, we see the duff underneath.
      const duff = scale3(p.deepAlbedo, 0.75 + 0.5 * grain)
      const piece = scale3(p.baseAlbedo, pieceTint)
      const albedo = mix3(duff, piece, e.mask)
      const detail = clamp01(0.5 * e.mask + 0.5 * grain)
      return {
        albedo,
        roughness: clamp01(p.baseRoughness + p.roughnessVariation * (grain - 0.5) * 2),
        // Lower-layer pieces sit in the shade of the upper ones.
        occlusion: clamp01(0.45 + 0.35 * grain + 0.2 * e.mask * (0.5 + 0.5 * e.lift)),
        metallic: p.metallic,
        alpha: 1,
        detail,
      }
    }
    case PATTERN.Grass: {
      const e = grassBlade(p, u, v)
      const bladeTint = 0.7 + 0.6 * cellUnit(e.cellHash, 8)
      // Blades are darker and greener at the base, drier toward the tip.
      const albedo = scale3(mix3(p.deepAlbedo, p.baseAlbedo, clamp01(v * 1.3)), bladeTint)
      const detail = clamp01(0.5 * e.core + 0.5 * v)
      return {
        albedo,
        roughness: clamp01(p.baseRoughness + p.roughnessVariation * (v - 0.5) * 2),
        occlusion: clamp01(0.35 + 0.65 * clamp01(v * 1.2)),
        metallic: p.metallic,
        alpha: e.mask,
        detail,
      }
    }
    case PATTERN.Rock: {
      const w = worley2P(u, v, p.periodU, p.periodV, p.seed)
      const facet = smoothstep(0.0, 0.16, w.f2 - w.f1)
      const grain = fbm2P(u, v, p.grainPeriod, p.grainPeriod, p.seed + 5, 4)
      const facetTint = 0.78 + 0.44 * cellUnit(w.cell, 9)
      const albedo = scale3(mix3(p.deepAlbedo, p.baseAlbedo, facet), facetTint * (0.85 + 0.3 * grain))
      const detail = clamp01(0.6 * facet + 0.4 * grain)
      return {
        albedo,
        roughness: clamp01(p.baseRoughness + p.roughnessVariation * (grain - 0.5) * 2),
        occlusion: clamp01(0.4 + 0.6 * facet),
        metallic: p.metallic,
        alpha: 1,
        detail,
      }
    }
    default:
      return {
        albedo: [0, 0, 0],
        roughness: 1,
        occlusion: 1,
        metallic: 0,
        alpha: 1,
        detail: 0.5,
      }
  }
}

/**
 * Move an unburnt sample toward the §7.6 stage target.
 *
 * The modulation is mean-preserving BY CONSTRUCTION: `1 + k*(detail - detailMean)` has mean
 * exactly 1, because `detailMean` is measured from this pattern rather than assumed. So the
 * layer retains spatial variation without biasing its mean away from the published value.
 * That is what makes the reference-value test meaningful — a modulation multiplicative in
 * `detail` would land the char layer at a fraction of the specified albedo, and the test
 * would either fail or have to be loosened into uselessness.
 *
 * Assuming 0.5 instead of measuring is the subtle version of the same bug: it is right for
 * bark and ground, and wrong by ~30% for the alpha-tested atlases, whose `detail` is near
 * zero across the empty part of every cell.
 */
function applyBurn(p: PatternParams, s: PatternSample, stage: BurnStage): PatternSample {
  if (stage === BURN_STAGE.Green) return s
  const target = BURN_TARGETS[stage]
  const w = clamp01(p.burnResponse[stage - 1] ?? 1)
  const mod = 1 + 0.5 * (s.detail - p.detailMean)
  const targetAlbedo = scale3(target.albedo, mod)
  const albedo = mix3(s.albedo, targetAlbedo, w)
  const roughness = lerp(s.roughness, target.roughness, w)
  // Ash is powder: it fills the crevices, so ambient occlusion flattens out.
  const occlusion =
    stage === BURN_STAGE.Ash ? lerp(s.occlusion, 1, 0.6 * w) : lerp(s.occlusion, s.occlusion * 0.85, w)
  // Alpha survives burning: a charred needle is still needle-shaped until it falls off.
  // Ash erodes the silhouette slightly, which is what makes a burnt canopy read as thinner.
  const alpha = stage === BURN_STAGE.Ash ? s.alpha * lerp(1, 0.82, w) : s.alpha
  return { albedo, roughness, occlusion, metallic: s.metallic, alpha, detail: s.detail }
}

// ---------------------------------------------------------------------------
// Alligator crack field (spec §7.6)
// ---------------------------------------------------------------------------

/**
 * One shared tiling 2-channel field for the whole world: R = Worley boundary distance D,
 * G = cell id. Cracks are NOT baked into the char layer — §7.6 makes crack width a function
 * of the live char fraction `c`, so it has to be evaluated at shade time from this field.
 */
export function crackField(u: number, v: number, period: number, seed: number): readonly [number, number] {
  const w = worley2P(u, v, period, period, seed)
  // Normalise f2-f1 into [0,1]; ~0.4 is a typical interior value for jittered Worley.
  const d = clamp01((w.f2 - w.f1) / 0.45)
  return [d, u32ToUnit(w.cell)]
}

/**
 * §7.6: `m_crack = smoothstep(0.5 - 0.35c, 0.5, D)`, char fraction `c` in [0,1].
 *
 * NOTE the sense: `m_crack` is 1 on the *intact* plate and 0 in the crack floor, which is why
 * ember emission in §7.6 is multiplied by `(1 - m_crack)` — the glow comes from the exposed
 * hot interior at the bottom of the crack, not from the surface.
 */
export function crackMask(distance: number, charFraction: number): number {
  const c = clamp01(charFraction)
  const lo = 0.5 - 0.35 * c
  // At c = 0 the edges coincide; `smoothstep` degrades to a step there, which is correct —
  // an uncharred surface has no cracks and the mask should be identically 1 for D > 0.5.
  return smoothstep(lo, 0.5, distance)
}

/** §7.6: crack depth, metres. 3 mm at full char. */
export function crackDepthM(charFraction: number): number {
  return 0.003 * clamp01(charFraction)
}

/**
 * Scale applied to the crack field's analytic gradient before it is packed into 8 bits.
 *
 * The crack texture stores dD/du and dD/dv in its B and A channels so the sampling shader can
 * perturb the surface normal without `dpdx`/`dpdy` — which are fragment-only and would in any
 * case differentiate screen space rather than texture space. `dD/du` runs to roughly
 * `2 * period / 0.45` for a `period`-cell field, so this normalises a 24-cell field into
 * [-1, 1]. Overflow clamps rather than wraps; clamping flattens the sharpest crack walls a
 * little, wrapping would put an inverted normal in the floor of every crack.
 *
 * Must match `CRACK_GRAD_SCALE` in `shaders/materials/crack.wgsl`.
 */
export const CRACK_GRADIENT_SCALE = 0.0075

/** Decode a packed crack gradient channel back to dD/dUV. */
export function decodeCrackGradient(encoded: number): number {
  return (encoded * 2 - 1) / CRACK_GRADIENT_SCALE
}

/** Re-exported so consumers of this module do not need to reach into `noise.ts`. */
export { valueNoise2P, clamp01, smoothstep }
