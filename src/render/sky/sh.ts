/**
 * Order-2 (9 coefficient) spherical harmonics for environment irradiance. **Pure.**
 *
 * Ramamoorthi & Hanrahan (2001), "An Efficient Representation for Irradiance Environment Maps",
 * SIGGRAPH 2001. The result they prove is the reason this is only nine numbers: the cosine
 * lobe used by Lambertian diffuse is so smooth that its SH expansion is down 1% by order 2, so
 * nine coefficients reproduce diffuse irradiance from an arbitrary environment to within ~1%.
 * For a sky — which is smoother still than a typical indoor environment — the error is smaller.
 *
 * Two conventions that matter downstream:
 *  - Directions are world space, +Y up, matching `sunDirection()` in `solar.ts`.
 *  - The buffer handed to the GPU stores irradiance coefficients, i.e. the *radiance*
 *    coefficients already multiplied by the convolution weights A_l = pi, 2pi/3, pi/4. The
 *    shader therefore evaluates E(n) = sum_i c_i Y_i(n) with no further constants, which is one
 *    less place for a factor of pi to go missing.
 */

/** Number of coefficients in an order-2 expansion. */
export const SH_COEFFICIENT_COUNT = 9

/** Bytes in the GPU-side buffer: 9 x vec4<f32> (rgb + pad, std140-friendly). */
export const SH_BUFFER_BYTES = SH_COEFFICIENT_COUNT * 4 * 4

/** One RGB SH expansion: `coeffs[i]` is [r, g, b] for basis function i. */
export type ShRgb = [number, number, number][]

/**
 * Real SH basis, bands 0..2, evaluated for a unit direction. Order matches the standard
 * (l, m) enumeration: 00, 1-1, 10, 11, 2-2, 2-1, 20, 21, 22.
 */
export function shBasis(dir: readonly [number, number, number]): number[] {
  const [x, y, z] = dir
  return [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ]
}

/** Lambertian convolution weights per band (Ramamoorthi & Hanrahan Eq. 8). */
export const SH_COSINE_CONVOLUTION: readonly number[] = [
  Math.PI,
  (2 * Math.PI) / 3,
  (2 * Math.PI) / 3,
  (2 * Math.PI) / 3,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
]

export function zeroSh(): ShRgb {
  return Array.from({ length: SH_COEFFICIENT_COUNT }, () => [0, 0, 0] as [number, number, number])
}

/**
 * Deterministic near-uniform sphere sampling (Fibonacci lattice). Deterministic rather than
 * stochastic so identical solar state always produces identical lighting — an environment probe
 * that shimmers between frames because it was Monte-Carlo sampled is a bug that only shows up
 * once the fire is moving.
 */
export function sphereDirections(count: number): [number, number, number][] {
  const out: [number, number, number][] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = i * golden
    out.push([r * Math.cos(phi), y, r * Math.sin(phi)])
  }
  return out
}

/**
 * Project a radiance function over the full sphere onto SH. Returns *radiance* coefficients.
 *
 * @param radiance evaluated per direction, returning linear RGB in W/(m^2 sr).
 * @param samples number of directions; 4096 is ample for a sky (the integrand is band-limited).
 */
export function projectRadianceToSh(
  radiance: (dir: readonly [number, number, number]) => readonly [number, number, number],
  samples = 4096,
): ShRgb {
  const dirs = sphereDirections(samples)
  const sh = zeroSh()
  const dOmega = (4 * Math.PI) / samples
  for (const dir of dirs) {
    const L = radiance(dir)
    const basis = shBasis(dir)
    for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
      const b = basis[i]! * dOmega
      const c = sh[i]!
      c[0] += L[0] * b
      c[1] += L[1] * b
      c[2] += L[2] * b
    }
  }
  return sh
}

/** Radiance coefficients -> irradiance coefficients (multiply by the cosine-lobe weights). */
export function convolveWithCosineLobe(sh: ShRgb): ShRgb {
  return sh.map((c, i) => {
    const a = SH_COSINE_CONVOLUTION[i]!
    return [c[0] * a, c[1] * a, c[2] * a] as [number, number, number]
  })
}

/**
 * Evaluate an expansion in a direction. If `sh` holds irradiance coefficients (post
 * convolution) this returns irradiance in W/m^2 for a surface with that normal; if it holds
 * radiance coefficients it returns the band-limited radiance.
 */
export function evaluateSh(sh: ShRgb, dir: readonly [number, number, number]): [number, number, number] {
  const basis = shBasis(dir)
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
    const c = sh[i]!
    const y = basis[i]!
    r += c[0] * y
    g += c[1] * y
    b += c[2] * y
  }
  return [r, g, b]
}

/** Irradiance for a normal, clamped at zero — SH ringing can push a dark direction negative. */
export function shIrradiance(
  irradianceSh: ShRgb,
  normal: readonly [number, number, number],
): [number, number, number] {
  const e = evaluateSh(irradianceSh, normal)
  return [Math.max(0, e[0]), Math.max(0, e[1]), Math.max(0, e[2])]
}

/** Pack into the GPU layout: 9 x vec4<f32>, w unused (padding). */
export function packShToFloat32(sh: ShRgb): Float32Array<ArrayBuffer> {
  const out = new Float32Array(SH_COEFFICIENT_COUNT * 4)
  for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
    const c = sh[i]!
    out[i * 4 + 0] = c[0]
    out[i * 4 + 1] = c[1]
    out[i * 4 + 2] = c[2]
    out[i * 4 + 3] = 0
  }
  return out
}

/** Inverse of `packShToFloat32`, for tests and for readback checks. */
export function unpackShFromFloat32(data: Float32Array): ShRgb {
  const sh = zeroSh()
  for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
    sh[i] = [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0]
  }
  return sh
}

/**
 * Add a delta-function light (the sun, or the moon) to a *radiance* expansion.
 *
 * A directional source is not band-limited, so projecting it by sampling would miss it entirely
 * unless a sample happened to land inside the disc. It is added analytically instead: a source
 * delivering `irradiance` W/m^2 on a surface facing it contributes `irradiance * Y_i(dir)` to
 * each radiance coefficient.
 */
export function addDirectionalToSh(
  sh: ShRgb,
  dir: readonly [number, number, number],
  irradiance: readonly [number, number, number],
): ShRgb {
  const basis = shBasis(dir)
  return sh.map((c, i) => {
    const y = basis[i]!
    return [c[0] + irradiance[0] * y, c[1] + irradiance[1] * y, c[2] + irradiance[2] * y] as [
      number,
      number,
      number,
    ]
  })
}
