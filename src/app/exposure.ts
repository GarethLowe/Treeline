/**
 * Auto-exposure for the HDR pipeline.
 *
 * Everything upstream of the tone mapper is *physical*: WP 1.7's sky emits spectral radiance
 * in W/(m² sr), and the terrain pass emits `albedo/π × irradiance` in the same units. That is
 * deliberate — it is what lets M4's blackbody flame colour composite against the sky without
 * a fudge factor — but it means the buffer spans about thirteen orders of magnitude between
 * a moonless night and the solar disc, and *something* has to choose where 0.18 sits.
 *
 * Doing it analytically from the solar state rather than by reading the frame back:
 *
 *   E_total  = DNI·sin(elevation) + DHI          horizontal irradiance, W/m²
 *   L_scene  = meanAlbedo · E_total / π          radiance of an average lit surface
 *   exposure = keyValue / L_scene
 *
 * A histogram-based auto-exposure would be more faithful but needs a readback, a compute
 * pass and a temporal filter, and it would hunt during the diurnal scrub. This has no
 * latency, is exactly reproducible for a given time of day, and is a single scalar the HUD
 * can show — which matters, because "the screen is black" and "the exposure is 1e-5" are
 * different bugs and this makes them distinguishable.
 *
 * Pure module. `test/app/exposure.test.ts` pins the monotonicity and the night clamp.
 */

/** Middle grey. The photographic convention. */
export const KEY_VALUE = 0.14

/**
 * Assumed scene reflectance, per biome.
 *
 * This was a single 0.22 — "vegetation and dry ground sit near 0.2" — and it is the reason the
 * conifer world rendered about 0.8 stops under. A closed conifer canopy is one of the darkest
 * natural land covers there is: published broadband albedo runs 0.08–0.15, against 0.16–0.26
 * for grass and up to ~0.35 for dry bare soil. Metering a forest as though it reflected 0.22
 * under-exposes it by exactly the ratio of the assumption to the truth.
 *
 * The renderer's own numbers agree: `patterns.ts` gives green foliage a linear albedo of
 * [0.09, 0.16, 0.05], luminance 0.14. Vegetation is only bright in the near infrared, which
 * never reaches the screen.
 *
 * These are broadband-albedo figures for the dominant cover of each biome, chosen to match the
 * material albedos the world actually renders with rather than a generic landscape average.
 */
export const BIOME_MEAN_ALBEDO: Readonly<Record<string, number>> = {
  'western-us-conifer': 0.13,
  'grassland-savanna': 0.21,
  'mediterranean-chaparral': 0.17,
  'eucalypt-dry-forest': 0.15,
  'uk-mixed-field-forest': 0.18,
}

/** Fallback for an unknown biome. Mid-way across the table, not the old forest-blind 0.22. */
export const MEAN_ALBEDO = 0.17

/** Mean reflectance to meter for. Unknown ids fall back rather than throw: a mis-exposed
 *  frame is recoverable with the EV slider, a boot failure is not. */
export const meanAlbedoFor = (biome: string | undefined): number =>
  (biome === undefined ? undefined : BIOME_MEAN_ALBEDO[biome]) ?? MEAN_ALBEDO

/**
 * Exposure is clamped rather than allowed to run to the true night value.
 *
 * Full moonlight is ~3 mlx, roughly 1e-4 W/m². Letting the key value chase that would light
 * the night like noon, which is both physically silly and a good way to make a rendering bug
 * invisible. The ceiling holds night at "you can see the terrain silhouette against the
 * stars", which is what a real dark-adapted eye gets.
 */
export const MAX_EXPOSURE = 0.02
export const MIN_EXPOSURE = 1e-6

export interface ExposureInputs {
  /** Direct normal irradiance, W/m². */
  readonly directIrradiance: number
  /** Diffuse horizontal irradiance, W/m². */
  readonly diffuseIrradiance: number
  /** Solar elevation, radians. Negative at night. */
  readonly elevation: number
  /** User exposure compensation in stops. 0 = automatic. */
  readonly compensationStops?: number
  /** Biome id, to pick the metering reflectance. Falls back to {@link MEAN_ALBEDO}. */
  readonly biome?: string
}

/** Horizontal irradiance on flat ground, W/m². */
export function horizontalIrradiance(inputs: ExposureInputs): number {
  const cos = Math.max(0, Math.sin(inputs.elevation))
  return Math.max(0, inputs.directIrradiance) * cos + Math.max(0, inputs.diffuseIrradiance)
}

/** Linear multiplier applied to HDR radiance before the tone curve. */
export function autoExposure(inputs: ExposureInputs): number {
  // The floor is roughly civil-twilight sky, so the transition into night is smooth rather
  // than a step onto the clamp.
  const e = Math.max(0.02, horizontalIrradiance(inputs))
  const sceneRadiance = (meanAlbedoFor(inputs.biome) * e) / Math.PI
  const raw = KEY_VALUE / sceneRadiance
  const stops = inputs.compensationStops ?? 0
  const compensated = raw * 2 ** stops
  return Math.min(MAX_EXPOSURE * 2 ** Math.max(0, stops), Math.max(MIN_EXPOSURE, compensated))
}

/**
 * Smooth the exposure across frames so the diurnal scrub does not strobe.
 *
 * Adaptation is done in log space because exposure is multiplicative; a linear lerp between
 * 1e-5 and 1e-3 spends almost all its time at the bright end.
 */
export function adaptExposure(current: number, target: number, dtSeconds: number, halfLifeSeconds = 0.35): number {
  if (!(current > 0)) return target
  if (!(target > 0)) return current
  const k = halfLifeSeconds <= 0 ? 1 : 1 - Math.pow(0.5, dtSeconds / halfLifeSeconds)
  return Math.exp(Math.log(current) + (Math.log(target) - Math.log(current)) * Math.min(1, Math.max(0, k)))
}
