/**
 * Burn-state plumbing. WP 1.6, consumed by WP 4.6.
 *
 * M1 does not animate anything. What M1 must do is fix the *format*, because M4 drives
 * albedo, roughness and normal continuously from the simulation's char fraction, and if the
 * per-instance channel does not exist by then, M4 has to reopen the material contract and
 * re-bake every texture. So the layout, the packing, the shader struct and the default
 * (everything zero = fully green) are all decided here and shipped now.
 *
 * ## The state
 *
 * Spec §7.6: per-element state is **four scalars**, not textures — scorch `s`, char `c`,
 * ash `a`, and residual surface temperature `T_s` (K). The burn coordinate is
 *
 *     b = clamp(s + c + a, 0, 3)
 *
 * and materials lerp array layers `floor(b)` and `floor(b)+1` by `frac(b)`. Two texture
 * fetches, one shared texture set for the whole world, no per-instance textures.
 *
 * ## Where the three scalars come from
 *
 * §7.6 states only `a = smoothstep(0.75, 1.0, u)` with `u` = mass consumption fraction. The
 * `s` and `c` ramps below are **authored staging, not published values** — status
 * `estimated` per spec §0.7.3 — chosen so that `b(u)` is monotone with `b(0) = 0` and
 * `b(1) = 3`, and so consecutive stages overlap rather than butt against each other (a
 * non-overlapping stage produces a visible banded ring travelling up a trunk). They are
 * exported separately from `burnCoordinate` so M4 can replace them with a physically derived
 * staging without touching the packing or the shader.
 */

import { clamp01, smoothstep } from './noise.ts'

// ---------------------------------------------------------------------------
// Burn coordinate
// ---------------------------------------------------------------------------

/** The four scalars of spec §7.6. */
export interface BurnState {
  /** Heat-scorched, not yet pyrolysed. 0..1. */
  readonly scorch: number
  /** Charred. 0..1. Drives crack width and ember exposure. */
  readonly char: number
  /** Consumed to ash. 0..1. */
  readonly ash: number
  /** Residual surface temperature, K. Below ~700 K there is no visible emission. */
  readonly tempK: number
}

export const BURN_STATE_UNBURNT: BurnState = { scorch: 0, char: 0, ash: 0, tempK: 293.15 }

/** §7.6: `b = clamp(s + c + a, 0, 3)`. */
export function burnCoordinate(state: BurnState): number {
  const b = clamp01(state.scorch) + clamp01(state.char) + clamp01(state.ash)
  return b < 0 ? 0 : b > 3 ? 3 : b
}

/**
 * Stage ramps from mass consumption fraction `u`.
 *
 * `ash` is spec §7.6 verbatim. `scorch` and `char` are authored (`estimated`); see the file
 * header. Monotonicity in `u` and the `b(0)=0, b(1)=3` endpoints are asserted by the tests,
 * because those are the properties M4 will actually depend on.
 */
export function burnStateFromConsumption(u: number, tempK: number): BurnState {
  const x = clamp01(u)
  return {
    scorch: smoothstep(0, 0.35, x),
    char: smoothstep(0.3, 0.8, x),
    ash: smoothstep(0.75, 1, x), // spec §7.6
    tempK,
  }
}

// ---------------------------------------------------------------------------
// Per-texel modulation
// ---------------------------------------------------------------------------

/**
 * Bias the burn coordinate by the per-texel susceptibility stored in ORM.a.
 *
 * Without this, an instance's whole surface transitions from green to scorch at the same
 * instant, which reads as a material swap rather than as burning. With it, the raised,
 * exposed structure of the material (`susceptibility` is the pattern's own `detail` field,
 * mean 0.5) goes first and the recesses lag, so the transition front follows the bark
 * furrows and the leaf veins.
 *
 * `strength` is in burn-coordinate units: 0.5 means the leading and trailing texels are half
 * a stage apart. The result is clamped to [0, 3] so it can never index outside the run.
 */
export function modulateBurnCoordinate(b: number, susceptibility: number, strength = 0.5): number {
  const biased = b + strength * (clamp01(susceptibility) - 0.5) * 2
  return biased < 0 ? 0 : biased > 3 ? 3 : biased
}

// ---------------------------------------------------------------------------
// Ember emission (§7.6)
// ---------------------------------------------------------------------------

/** Stefan-Boltzmann constant, W m^-2 K^-4. CODATA, exact by the 2019 SI redefinition. */
export const STEFAN_BOLTZMANN = 5.670374419e-8
/** §7.6: emissivity of charred wood. */
export const CHAR_EMISSIVITY = 0.9
/** §7.6: below this there is no visible ember emission. */
export const EMBER_MIN_TEMP_K = 700

/**
 * Radiant exitance of a charred surface as a *radiance*, W m^-2 sr^-1.
 *
 * §7.6: `L = epsilon * sigma * T^4 / pi`. The `/pi` converts the hemispherical exitance of
 * the Stefan-Boltzmann law into the radiance of a Lambertian emitter, which is what a shader
 * actually wants to add to a radiance buffer. Getting that factor wrong is a 3.14x error in
 * ember brightness that is trivially mistaken for a tone-mapping problem.
 *
 * Returns 0 below `EMBER_MIN_TEMP_K`, per spec.
 */
export function emberRadiance(tempK: number): number {
  if (!(tempK > EMBER_MIN_TEMP_K)) return 0
  return (CHAR_EMISSIVITY * STEFAN_BOLTZMANN * tempK ** 4) / Math.PI
}

/**
 * §7.6 crack-mask gating: emission is *inverted* against the crack mask, so the glow comes
 * from the exposed hot interior in the crack floors, not from the intact plate surface.
 *
 * `crackMask` is 1 on the intact plate and 0 in the crack floor (see `crackMask()` in
 * `patterns.ts`), hence the `1 - m`.
 */
export function emberRadianceThroughCracks(tempK: number, crackMask: number): number {
  return emberRadiance(tempK) * (1 - clamp01(crackMask))
}

/**
 * TODO (WP 4.2): the *colour* of ember emission comes from the blackbody LUT specified in
 * spec §7.1.3 — 256 entries over 500-2500 K, built by integrating Planck against the CIE 1931
 * 2-degree colour-matching functions. That LUT belongs to WP 4.2 and this package does not
 * fabricate one: entering unverified CMF values would violate the provenance policy (§0.7.1),
 * and a wrong flame colour is exactly the kind of error the policy exists to prevent.
 *
 * So `materialSample()` in the shader takes the emitter colour as a PARAMETER. M1 passes
 * `EMBER_COLOR_M1_PLACEHOLDER`; M4 passes a LUT fetch, with no change to this package.
 */
export const EMBER_COLOR_M1_PLACEHOLDER: readonly [number, number, number] = [1, 0.42, 0.12]

// ---------------------------------------------------------------------------
// Packed per-instance record
// ---------------------------------------------------------------------------

/**
 * Bytes per instance in the burn-state buffer.
 *
 * 8 bytes, indexed by the `burn-state index` already carried in the 32-byte foliage instance
 * record (spec §7.4). 80 k instances = 640 kB. Sizing this as four f32s instead would cost
 * 1.3 MB for precision nobody can see: `s`, `c` and `a` are visual blend weights read at
 * 8-bit texture precision anyway, and 1 K of temperature resolution is far below what the
 * T^4 emission curve resolves visually.
 */
export const BURN_STATE_STRIDE_BYTES = 8

/** Flag bits in byte 3. */
export const BURN_FLAG = {
  /** The element is currently combusting, as opposed to cooling. Drives M4 ember flicker. */
  Active: 1 << 0,
} as const

/**
 * Pack one instance's burn state at `index` in a buffer.
 *
 * Little-endian by construction (byte writes, not `DataView.setUint32`), because WGSL reads
 * this as `vec2<u32>` and WebGPU buffers are little-endian on every supported platform. Byte
 * writes make that assumption explicit and unbreakable rather than implicit in an endianness
 * flag someone can flip.
 */
export function packBurnState(
  out: Uint8Array,
  index: number,
  state: BurnState,
  flags = 0,
): void {
  const o = index * BURN_STATE_STRIDE_BYTES
  if (o + BURN_STATE_STRIDE_BYTES > out.length) {
    throw new Error(`burn state index ${index} out of range for a ${out.length}-byte buffer`)
  }
  out[o] = Math.round(clamp01(state.scorch) * 255)
  out[o + 1] = Math.round(clamp01(state.char) * 255)
  out[o + 2] = Math.round(clamp01(state.ash) * 255)
  out[o + 3] = flags & 0xff
  const t = Math.max(0, Math.min(65535, Math.round(state.tempK)))
  out[o + 4] = t & 0xff
  out[o + 5] = (t >>> 8) & 0xff
  out[o + 6] = 0
  out[o + 7] = 0
}

export function unpackBurnState(src: Uint8Array, index: number): BurnState {
  const o = index * BURN_STATE_STRIDE_BYTES
  if (o + BURN_STATE_STRIDE_BYTES > src.length) {
    throw new Error(`burn state index ${index} out of range for a ${src.length}-byte buffer`)
  }
  return {
    scorch: (src[o] as number) / 255,
    char: (src[o + 1] as number) / 255,
    ash: (src[o + 2] as number) / 255,
    tempK: (src[o + 4] as number) | ((src[o + 5] as number) << 8),
  }
}

export function unpackBurnFlags(src: Uint8Array, index: number): number {
  return src[index * BURN_STATE_STRIDE_BYTES + 3] ?? 0
}

/**
 * A zero-filled burn-state buffer: every instance unburnt.
 *
 * Zero temperature rather than 293 K is deliberate. `emberRadiance` returns 0 below 700 K, so
 * a zeroed buffer is visually identical to an ambient one, and zero-fill is what
 * `device.createBuffer` gives for free. Storing 293 would mean writing 640 kB at startup to
 * encode "nothing is happening".
 */
export function createBurnStateData(instanceCount: number): Uint8Array {
  return new Uint8Array(instanceCount * BURN_STATE_STRIDE_BYTES)
}

// ---------------------------------------------------------------------------
// Per-tree vertical burn profile (§7.6c)
// ---------------------------------------------------------------------------

/**
 * Texels in one tree's vertical burn profile.
 *
 * §7.6's central trick for avoiding a texture explosion: a tree is charred to 4 m and green
 * above, so its state is a 1D profile up the trunk, not a 2D map over its surface. 32 texels
 * over a 40 m tree is 1.25 m of vertical resolution, which is finer than a scorch-height
 * boundary is ever observed to be sharp.
 */
export const BURN_PROFILE_TEXELS = 32

/**
 * Descriptor for the per-instance burn profile texture: `BURN_PROFILE_TEXELS` wide,
 * `instanceCount` tall, `r8unorm`.
 *
 * `storageWritable` adds `STORAGE_BINDING`, which for `r8unorm` requires the optional
 * `texture-formats-tier1` feature. It was granted on the target configuration (spec §7.1.2,
 * CLOSED note) but feature availability is a property of the *user's* adapter, so the default
 * is off and the fallback is `queue.writeTexture` from the CPU. Passing `true` without the
 * feature is a device-level validation error, not a silent downgrade — which is correct: this
 * must be a visible decision, not an invisible one.
 */
export function burnProfileTextureDescriptor(
  instanceCount: number,
  storageWritable = false,
): GPUTextureDescriptor {
  const TEXTURE_BINDING = 0x04
  const STORAGE_BINDING = 0x08
  const COPY_DST = 0x02
  return {
    label: 'burn-profile',
    size: { width: BURN_PROFILE_TEXELS, height: Math.max(1, instanceCount), depthOrArrayLayers: 1 },
    format: 'r8unorm',
    dimension: '2d',
    mipLevelCount: 1,
    usage: TEXTURE_BINDING | COPY_DST | (storageWritable ? STORAGE_BINDING : 0),
  }
}

/** Bytes the burn profile texture occupies. One byte per texel, no mips. */
export function burnProfileBytes(instanceCount: number): number {
  return BURN_PROFILE_TEXELS * Math.max(1, instanceCount)
}

/**
 * Sample a packed profile the way the shader does: nearest-texel on a normalised height.
 *
 * Exported so a test can assert the CPU and shader agree on the mapping, in particular that
 * `heightFrac = 0` is the ground texel and not the first texel *centre* — an off-by-half here
 * puts the char line half a texel up every trunk in the world.
 */
export function sampleBurnProfile(profile: Uint8Array, rowOffset: number, heightFrac: number): number {
  const t = clamp01(heightFrac) * (BURN_PROFILE_TEXELS - 1)
  const i0 = Math.floor(t)
  const i1 = Math.min(BURN_PROFILE_TEXELS - 1, i0 + 1)
  const f = t - i0
  const a = (profile[rowOffset + i0] ?? 0) / 255
  const b = (profile[rowOffset + i1] ?? 0) / 255
  return a + (b - a) * f
}
