/**
 * Deterministic stand-in for WP 2.2's per-cell rate-of-spread cache.
 *
 * Rule C of the fan-out: where a package needs data a sibling will eventually produce, it
 * consumes a **stub in its own directory**, never an import. WP 2.2 owns the `rgba16float`
 * texture holding `(R_head, LB, headingX, headingY)` per cell (spec §4.3); this fills one
 * with a rate that responds to wind in the right direction and with the right sign, and
 * nothing more.
 *
 * **This is not physics and must never ship.** The head rate here is a linear stand-in, not
 * Rothermel. The `LB` and the heading, on the other hand, ARE the shipping relations — they
 * are this package's own (`ellipse.ts`), so the stub exercises the real ellipse code and only
 * fakes the number WP 2.2 owns.
 */

import type { MetresPerSecond, Radians } from '@contracts/units'
import { mps } from '@contracts/units'
import { fireEllipse, lengthToBreadth } from './ellipse'

/** IEEE-754 binary16 encoder. `rgba16float` textures take raw halves. */
export function toHalf(value: number): number {
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  f32[0] = value
  const x = u32[0] as number
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x007f_ffff
  if (exp >= 0x1f) return sign | 0x7c00 // overflow -> Inf
  if (exp <= 0) {
    if (exp < -10) return sign
    const sub = (mant | 0x0080_0000) >>> (1 - exp + 13)
    return sign | sub
  }
  exp = exp << 10
  return sign | exp | (mant >>> 13)
}

export interface StubField {
  /** Head-fire rate of spread with no wind. Grass litter order of magnitude. */
  readonly baseRate?: MetresPerSecond
  /** How much midflame wind adds. Linear — a placeholder for Rothermel's `1 + φ_w + φ_s`. */
  readonly windGain?: number
  /** Cells where this returns false cannot burn: R_head = 0, so the front stalls there. */
  readonly burnable?: (i: number, j: number) => boolean
}

/**
 * Fill a `Uint16Array` sized `4 · n · n` with the packed cache. Exposed separately from the
 * texture upload so the packing is testable without a device.
 */
export function packRosCache(
  n: number,
  midflameWind: MetresPerSecond,
  windDirection: Radians,
  field: StubField = {},
): Uint16Array<ArrayBuffer> {
  const base = field.baseRate ?? mps(0.02)
  const gain = field.windGain ?? 0.35
  const rate = base + gain * Math.max(0, midflameWind)
  const e = fireEllipse(mps(rate), midflameWind, windDirection)
  const lb = lengthToBreadth(midflameWind)
  // Backed by an explicit ArrayBuffer so it satisfies `GPUAllowSharedBufferSource` — the
  // default `ArrayBufferLike` element type does not, because it admits SharedArrayBuffer.
  const out = new Uint16Array(new ArrayBuffer(8 * n * n))
  const hHead = toHalf(e.head)
  const hZero = toHalf(0)
  const hLb = toHalf(lb)
  const hx = toHalf(e.hx)
  const hy = toHalf(e.hy)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = 4 * (j * n + i)
      const burnable = field.burnable ? field.burnable(i, j) : true
      out[k] = burnable ? hHead : hZero
      out[k + 1] = hLb
      out[k + 2] = hx
      out[k + 3] = hy
    }
  }
  return out
}

export function createStubRosCache(device: GPUDevice, n: number): GPUTexture {
  return device.createTexture({
    label: 'propagation.rosCache.stub',
    size: [n, n],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
}

export function uploadRosCache(
  device: GPUDevice,
  texture: GPUTexture,
  n: number,
  midflameWind: MetresPerSecond,
  windDirection: Radians,
  field: StubField = {},
): void {
  const data = packRosCache(n, midflameWind, windDirection, field)
  device.queue.writeTexture({ texture }, data, { bytesPerRow: 8 * n, rowsPerImage: n }, [n, n])
}
