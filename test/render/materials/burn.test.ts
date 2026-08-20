/**
 * Burn-state plumbing. WP 1.6, consumed by WP 4.6.
 *
 * M1 animates nothing, so what is testable — and what M4 will actually depend on — is the
 * FORMAT: the burn coordinate is monotone and spans the four layers exactly, the packed
 * record round-trips, the default is "everything green", and the ember radiance carries the
 * factor of pi that separates exitance from radiance.
 */

import { describe, expect, it } from 'vitest'
import {
  BURN_FLAG,
  BURN_PROFILE_TEXELS,
  BURN_STATE_STRIDE_BYTES,
  BURN_STATE_UNBURNT,
  CHAR_EMISSIVITY,
  EMBER_MIN_TEMP_K,
  STEFAN_BOLTZMANN,
  burnCoordinate,
  burnProfileBytes,
  burnProfileTextureDescriptor,
  burnStateFromConsumption,
  createBurnStateData,
  emberRadiance,
  emberRadianceThroughCracks,
  modulateBurnCoordinate,
  packBurnState,
  sampleBurnProfile,
  unpackBurnFlags,
  unpackBurnState,
} from '../../../src/render/materials/burn.ts'
import { BURN_LAYER_COUNT, crackMask } from '../../../src/render/materials/patterns.ts'

describe('burn coordinate (spec §7.6)', () => {
  it('is zero unburnt and 3 fully consumed — exactly the four-layer span', () => {
    expect(burnCoordinate(BURN_STATE_UNBURNT)).toBe(0)
    expect(burnCoordinate({ scorch: 1, char: 1, ash: 1, tempK: 300 })).toBe(3)
    // b = 3 must index the LAST layer, which is why the shader clamps the high layer.
    expect(BURN_LAYER_COUNT - 1).toBe(3)
  })

  it('clamps rather than running off the end of the layer run', () => {
    expect(burnCoordinate({ scorch: 5, char: 5, ash: 5, tempK: 0 })).toBe(3)
    expect(burnCoordinate({ scorch: -2, char: -2, ash: -2, tempK: 0 })).toBe(0)
  })

  it('is monotone in consumption fraction, from 0 to 3', () => {
    let previous = -1
    for (let i = 0; i <= 100; i++) {
      const b = burnCoordinate(burnStateFromConsumption(i / 100, 300))
      expect(b).toBeGreaterThanOrEqual(previous)
      previous = b
    }
    expect(burnCoordinate(burnStateFromConsumption(0, 300))).toBeCloseTo(0, 10)
    expect(burnCoordinate(burnStateFromConsumption(1, 300))).toBeCloseTo(3, 10)
  })

  it('uses the spec §7.6 ash ramp verbatim', () => {
    // a = smoothstep(0.75, 1.0, u): zero below 0.75, one at 1.
    expect(burnStateFromConsumption(0.74, 300).ash).toBe(0)
    expect(burnStateFromConsumption(1, 300).ash).toBeCloseTo(1, 10)
    expect(burnStateFromConsumption(0.875, 300).ash).toBeCloseTo(0.5, 10)
  })

  it('overlaps consecutive stages rather than butting them together', () => {
    // A non-overlapping staging produces a visible banded ring travelling up a trunk.
    const mid = burnStateFromConsumption(0.4, 300)
    expect(mid.scorch).toBeGreaterThan(0)
    expect(mid.char).toBeGreaterThan(0)
    expect(mid.char).toBeLessThan(1)
  })
})

describe('per-texel susceptibility modulation', () => {
  it('leads at high susceptibility and lags at low, symmetrically about the mean', () => {
    const b = 1.5
    expect(modulateBurnCoordinate(b, 1, 0.5)).toBeCloseTo(2.0, 10)
    expect(modulateBurnCoordinate(b, 0, 0.5)).toBeCloseTo(1.0, 10)
    expect(modulateBurnCoordinate(b, 0.5, 0.5)).toBeCloseTo(1.5, 10)
  })

  it('cannot push the coordinate outside the layer run', () => {
    expect(modulateBurnCoordinate(3, 1, 2)).toBe(3)
    expect(modulateBurnCoordinate(0, 0, 2)).toBe(0)
  })

  it('is a no-op at zero strength', () => {
    for (const s of [0, 0.25, 1]) {
      expect(modulateBurnCoordinate(1.7, s, 0)).toBeCloseTo(1.7, 10)
    }
  })
})

describe('ember emission (spec §7.6)', () => {
  it('is zero below the 700 K threshold', () => {
    expect(emberRadiance(0)).toBe(0)
    expect(emberRadiance(699)).toBe(0)
    expect(emberRadiance(EMBER_MIN_TEMP_K)).toBe(0)
    expect(emberRadiance(701)).toBeGreaterThan(0)
  })

  it('carries the 1/pi that converts exitance to radiance', () => {
    // Dropping it is a 3.14x brightness error easily mistaken for a tone-mapping problem.
    const T = 1200
    const exitance = CHAR_EMISSIVITY * STEFAN_BOLTZMANN * T ** 4
    expect(emberRadiance(T)).toBeCloseTo(exitance / Math.PI, 6)
    expect(emberRadiance(T)).not.toBeCloseTo(exitance, 0)
  })

  it('scales as T^4', () => {
    expect(emberRadiance(1600) / emberRadiance(800)).toBeCloseTo(16, 6)
  })

  it('glows in the crack floors, not on the intact plate', () => {
    // m_crack is 1 on the plate and 0 in the floor; §7.6 multiplies emission by (1 - m).
    const T = 1100
    const floor = emberRadianceThroughCracks(T, crackMask(0.05, 1))
    const plate = emberRadianceThroughCracks(T, crackMask(0.95, 1))
    expect(floor).toBeGreaterThan(0)
    expect(plate).toBeCloseTo(0, 6)
    expect(floor).toBeGreaterThan(plate)
  })
})

describe('packed per-instance record', () => {
  it('is 8 bytes and defaults to fully green', () => {
    expect(BURN_STATE_STRIDE_BYTES).toBe(8)
    const data = createBurnStateData(1000)
    expect(data.byteLength).toBe(8000)
    const s = unpackBurnState(data, 500)
    expect(burnCoordinate(s)).toBe(0)
    // A zeroed temperature is below the ember threshold, so zero-fill is visually identical
    // to ambient and costs nothing to write.
    expect(emberRadiance(s.tempK)).toBe(0)
  })

  it('round-trips within 8-bit precision', () => {
    const data = createBurnStateData(4)
    const state = { scorch: 0.25, char: 0.75, ash: 0.5, tempK: 1234 }
    packBurnState(data, 2, state, BURN_FLAG.Active)
    const back = unpackBurnState(data, 2)
    expect(back.scorch).toBeCloseTo(state.scorch, 2)
    expect(back.char).toBeCloseTo(state.char, 2)
    expect(back.ash).toBeCloseTo(state.ash, 2)
    expect(back.tempK).toBe(1234)
    expect(unpackBurnFlags(data, 2)).toBe(BURN_FLAG.Active)
    // Neighbouring records untouched — a stride error would smear into them.
    expect(burnCoordinate(unpackBurnState(data, 1))).toBe(0)
    expect(burnCoordinate(unpackBurnState(data, 3))).toBe(0)
  })

  it('packs the u16 temperature little-endian, as the shader unpacks it', () => {
    const data = createBurnStateData(1)
    packBurnState(data, 0, { scorch: 0, char: 0, ash: 0, tempK: 0x0304 })
    expect(data[4]).toBe(0x04)
    expect(data[5]).toBe(0x03)
  })

  it('clamps rather than wrapping out-of-range values', () => {
    const data = createBurnStateData(1)
    packBurnState(data, 0, { scorch: 3, char: -1, ash: 0.5, tempK: 99999 })
    const back = unpackBurnState(data, 0)
    expect(back.scorch).toBe(1)
    expect(back.char).toBe(0)
    expect(back.tempK).toBe(65535)
  })

  it('refuses an out-of-range index instead of writing past the buffer', () => {
    const data = createBurnStateData(2)
    expect(() => packBurnState(data, 2, BURN_STATE_UNBURNT)).toThrow(/out of range/)
    expect(() => unpackBurnState(data, 5)).toThrow(/out of range/)
  })
})

describe('per-tree vertical burn profile (§7.6c)', () => {
  it('is 32 texels per instance', () => {
    expect(BURN_PROFILE_TEXELS).toBe(32)
    expect(burnProfileBytes(80_000)).toBe(32 * 80_000)
    // The whole point of a 1D profile: 80 k trees cost 2.5 MB, not a texture each.
    expect(burnProfileBytes(80_000) / (1024 * 1024)).toBeLessThan(3)
  })

  it('describes an r8unorm texture without STORAGE_BINDING by default', () => {
    // r8unorm storage needs the optional texture-formats-tier1 feature. Defaulting it off
    // keeps the core path valid on an adapter that did not grant it; asking for it is then a
    // visible decision rather than an invisible one.
    const d = burnProfileTextureDescriptor(10)
    expect(d.format).toBe('r8unorm')
    expect((d.size as GPUExtent3DDict).width).toBe(32)
    expect((d.size as GPUExtent3DDict).height).toBe(10)
    expect(d.usage & 0x08).toBe(0)
    expect(burnProfileTextureDescriptor(10, true).usage & 0x08).toBeTruthy()
  })

  it('maps heightFrac 0 to the ground texel and 1 to the top texel', () => {
    // An off-by-half here puts the char line half a texel up every trunk in the world.
    const profile = new Uint8Array(BURN_PROFILE_TEXELS)
    profile[0] = 255
    profile[BURN_PROFILE_TEXELS - 1] = 128
    expect(sampleBurnProfile(profile, 0, 0)).toBeCloseTo(1, 6)
    expect(sampleBurnProfile(profile, 0, 1)).toBeCloseTo(128 / 255, 6)
  })

  it('interpolates between texels, so a scorch line is not a staircase', () => {
    const profile = new Uint8Array(BURN_PROFILE_TEXELS)
    profile.fill(255, 0, 16)
    const mid = sampleBurnProfile(profile, 0, 15.5 / (BURN_PROFILE_TEXELS - 1))
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })
})
