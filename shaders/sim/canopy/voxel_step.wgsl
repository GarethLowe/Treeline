// The canopy voxel update — the pass that makes M3 a simulation rather than four libraries.
//
// WP 3.1 shipped the sparse store and said it "owns the voxel iteration". WP 3.2 shipped the
// kinetics as pure TypeScript. WP 3.3 shipped radiation up to an irradiance field. WP 3.4
// shipped convection as a function library whose header says *"whoever wires this into WP 3.1's
// voxel pass must profile it"*. **Nobody wrote that pass.** This is it.
//
// One invocation per ALLOCATED voxel slot — not per dense voxel. The store's whole point is
// that 1.2 M slots cover a domain of 16.8 M dense voxels, so iterating slots is a 14x saving
// and needs no occupancy test.
//
// The ORACLE is `src/sim/canopy/kinetics/voxel.ts::stepVoxel`. Every branch below mirrors one
// there, in the same order, and `test/sim/canopy/voxelStep.test.ts` asserts the constants
// match. Where they disagree, TypeScript is right.
//
// Bind groups:
//   0  this pass's own params and the slot->coordinate map
//   1  WP 3.1's storage (canopyStorageWgsl emits the declarations)
//   2  WP 3.3's irradiance field
//   3  WP 3.4's plume uniforms (convection.wgsl declares them)

struct VoxelStepParams {
  dt: f32,
  // Slots actually allocated. Past this the pools hold the grow-path spares, which must not
  // be stepped: they have no geometry and would pyrolyse a voxel that does not exist.
  slotCount: u32,
  // Ambient air temperature, K. The floor every voxel relaxes back towards.
  ambientK: f32,
  // Fuel particle diameter, m. Sets the Biot number and therefore the thermal regime.
  particleDiameter: f32,
};

@group(0) @binding(0) var<uniform> vparams: VoxelStepParams;
// Column index of each slot, so a slot can recover its (i, j, k) without a search. Built once
// at world build alongside the layout; see `buildSlotMap` in `voxelStep.ts`.
@group(0) @binding(1) var<storage, read> slotColumn: array<u32>;
// [0] = voxels currently flaming, [1] = voxels that have ever ignited. HUD and acceptance.
@group(0) @binding(2) var<storage, read_write> voxelStats: array<atomic<u32>>;

@group(2) @binding(0) var irradianceTex: texture_3d<f32>;
@group(2) @binding(1) var irradianceSamp: sampler;

const PHASE_WET: u32 = 0u;
const PHASE_DRY: u32 = 1u;
const PHASE_PYROLYSING: u32 = 2u;
const PHASE_FLAMING: u32 = 3u;
const PHASE_CHAR: u32 = 4u;

const ST_FLAMING: u32 = 0u;
const ST_EVER_IGNITED: u32 = 1u;
// Crown fuel, remaining and initial, as dry DENSITY summed over voxels x CROWN_MASS_SCALE.
//
// A count of flaming voxels cannot answer "what fraction of the crown burned": voxels are not
// equal and Van Wagner's CFB is a mass fraction. These two make the measured answer available,
// which `vanWagner.ts` has always preferred over its own curve (`measuredCrownConsumedFraction`)
// and never once been given — so every crown fire this project has ever reported was the
// empirical nomogram narrating over a 3D canopy that was not consulted.
//
// Density, not mass, because every voxel has the same volume: it cancels in the ratio, so
// carrying it would only add a way to get the units wrong.
//
// Fixed point because WGSL has no f32 atomics.
const ST_CROWN_DRY: u32 = 2u;
const ST_CROWN_INITIAL: u32 = 3u;
// Diagnostics: the hottest voxel and how many are meaningfully above ambient. Without these,
// "the canopy is not igniting" cannot be told apart from "the canopy is not being HEATED",
// and those have completely different causes — one is kinetics, the other is the radiation or
// convection chain that feeds them.
const ST_MAX_TEMP: u32 = 4u;
const ST_WARM_COUNT: u32 = 5u;
// The convective channel, measured at the voxels instead of inferred from a CPU probe.
//
// `crown-probe.mjs` says this plume reaches 636 K on its tilted centreline at crown base and
// only 349 K directly above the fire, while the GPU's hottest voxel reads 373 K -- i.e. every
// heated voxel appears to sample the cold side. These two say whether that is true and why:
// ST_MAX_GAS is the hottest gas ANY occupied voxel sees, and ST_MIN_OFFSET is the closest any
// of them gets to the tilted centreline. Core found but cold => downstream of convection;
// never closer than a metre => the core is narrower than the 2 m voxel that must resolve it.
const ST_MAX_GAS: u32 = 6u;
const ST_MIN_OFFSET: u32 = 7u;
// |offset| in centimetres, saturated. atomicMin needs an unsigned distance, so the sign is
// dropped; the sentinel below is what "no voxel was inside the plume at all" looks like.
const OFFSET_SCALE: f32 = 100.0;
const OFFSET_NONE: u32 = 0xffffffffu;
// Max-gas and max-temp are separate atomics and need not describe the SAME voxel, so on their
// own they cannot tell "the voxel in the plume core is stalled" from "the core is over bare
// ground and the warm voxels are elsewhere". These two are gated on one condition, so they do.
const ST_HOT_GAS_COUNT: u32 = 8u;
const ST_MAX_TEMP_HOT: u32 = 9u;
const ST_STALLED: u32 = 10u;
const HOT_GAS_K: f32 = 800.0;
// Hot-gas voxels pinned at the water boiling plateau, spending the whole step on evaporation.
//
// This is the signature of the 2026-08-21 bug and the cheapest guard against its return: the
// canopy stepped on the caller's dt while the surface stepped on dt x timeScale, so at the
// default 8x the crowns got an eighth of the drying time the fire that dried them got. They
// sat here forever. A run with voxels stalled and none ever igniting is that bug, back.
const TEMP_SCALE: f32 = 16.0;
/// 50 K over a 293 K ambient: unambiguously heated by the fire, not by the diurnal cycle.
const WARM_K: f32 = 343.0;

// Irradiance is stored in kW m^-2 (f16 tops out at 65504 and a flame sheet is 117600 W m^-2).
const KW_TO_W: f32 = 1000.0;

/// `p.xz` is world, `aglY` is height above the ground under it.
///
/// The radiation grid's vertical axis is height above ground, not elevation — see the header
/// of `emit_surface.wgsl`. Passing an absolute Y here samples a kilometre and a half outside
/// the field, which clamps to zero and looks exactly like a fire that is not radiating.
fn sampleIrradiance(p: vec3f, aglY: f32) -> f32 {
  let uvw = (vec3f(p.x - RAD_ORIGIN_X, p.z - RAD_ORIGIN_Z, aglY - RAD_ORIGIN_Y) / RAD_CELL_M)
    / vec3f(RAD_NI_F, RAD_NJ_F, RAD_NK_F);
  return textureSampleLevel(irradianceTex, irradianceSamp, uvw, 0.0).r * KW_TO_W;
}

/// Net radiative source, W m^-3. Mirrors `radiativeSource()`: absorption of the incident
/// field at the voxel's own extinction, less its own re-emission over the same area.
fn radiativeSource(irradiance: f32, extinction: f32, lad: f32, temperatureK: f32) -> f32 {
  let t2 = temperatureK * temperatureK;
  let emitted = STEFAN_BOLTZMANN * t2 * t2 * 2.0 * lad;
  return extinction * irradiance - emitted;
}

// `start`, not `from`: `from` is a WGSL reserved word. The CPU oracle spells the same
// parameter `from` legally, which is exactly how a transliteration acquires one.
fn approach(start: f32, steady: f32, dt: f32, tau: f32) -> f32 {
  return steady + (start - steady) * exp(-dt / tau);
}

struct Water { free: f32, bound: f32, surplus: f32 };

/// Spend `energy` (J m^-3) at the pinned boiling point, free water first. Mirrors
/// `evaporateWater()`; the ORDER matters, because bound water costs desorption enthalpy on
/// top of the latent heat and taking it first would under-count the sink.
fn evaporateWater(freeIn: f32, boundIn: f32, energy: f32) -> Water {
  var free = max(0.0, freeIn);
  var bound = max(0.0, boundIn);
  var left = max(0.0, energy);

  if (free > 0.0) {
    let capacity = free * WATER_LATENT_HEAT;
    if (left >= capacity) {
      left = left - capacity;
      free = 0.0;
    } else {
      free = free - left / WATER_LATENT_HEAT;
      left = 0.0;
    }
  }
  if (left > 0.0 && bound > 0.0) {
    let perKg = WATER_LATENT_HEAT + BOUND_WATER_DESORPTION_HEAT;
    let capacity = bound * perKg;
    if (left >= capacity) {
      left = left - capacity;
      bound = 0.0;
    } else {
      bound = bound - left / perKg;
      left = 0.0;
    }
  }
  return Water(free, bound, left);
}

/// Invert the pyrolysate flux for the gate temperature. `INF` when the voxel holds too little
/// solid per unit leaf area to ever reach the critical flux — which is the correct answer, and
/// is what stops thin hot empty voxels igniting spuriously (spec §7.6).
/// Below this the voxel has no meaningful fuel surface and cannot ignite.
///
/// LAD is stored as f16, whose denormals reach 6e-8. The gate temperature is
/// PYROLYSIS_E_OVER_R / ln(A * m / (m_crit * 2 * LAD)), so a voxel holding ordinary mass over
/// a denormal LAD gets a gate BELOW AMBIENT and is born flaming. That is precisely the
/// "spurious ignition of thin, hot-but-empty voxels" spec §7.6 warns about, and it showed up
/// as 6 voxels alight in a forest with no fire in it. A tenth of a square metre of leaf per
/// cubic metre is already two orders below the sparsest real canopy.
const LAD_MIN: f32 = 1e-3;

fn ignitionTemperature(dryMass: f32, lad: f32) -> f32 {
  let area = 2.0 * lad;
  if (dryMass <= 0.0 || lad < LAD_MIN) { return 1e30; }
  let ratio = (PYROLYSIS_A * dryMass) / (CRITICAL_MASS_FLUX * area);
  if (ratio <= 1.0) { return 1e30; }
  return PYROLYSIS_E_OVER_R / log(ratio);
}

fn classify(temperatureK: f32, dryMass: f32, initialDryMass: f32, flux: f32, ignitionK: f32) -> u32 {
  if (temperatureK >= ignitionK) {
    // Flaming until the solid is spent, then char. `initialDryMass` is what makes "spent"
    // relative to what was there, so a sparse voxel is not born as char.
    if (initialDryMass > 0.0 && dryMass <= CHAR_FRACTION * initialDryMass) { return PHASE_CHAR; }
    return PHASE_FLAMING;
  }
  if (flux >= PYROLYSING_FRACTION * CRITICAL_MASS_FLUX) { return PHASE_PYROLYSING; }
  return PHASE_DRY;
}

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3u) {
  let v = gid.x;
  if (v >= vparams.slotCount) { return; }

  let lad = canopy_lad(v);
  let initialDry = canopy_dry_density(v);
  if (!(initialDry > 0.0) || !(lad >= LAD_MIN)) { return; }

  // Reconstruct the world position. `slotColumn` gives the column; the vertical index is the
  // slot's offset inside that column's run, which is exactly how the layout packs it.
  let column = slotColumn[v];
  let ci = i32(column % CANOPY_NXY);
  let cj = i32(column / CANOPY_NXY);
  let col = canopyColumns[column];
  let zStart = i32(col.header & CANOPY_Z_MASK);
  let ck = zStart + i32(v - col.offset);
  let centre = canopy_voxel_centre(ci, cj, ck);

  var temperature = canopy_temperature(v);
  if (!(temperature > 0.0)) { temperature = vparams.ambientK; }
  var dryMass = canopy_foliage_fraction(v) * initialDry;
  var free = canopy_free_water(v);
  var bound = canopy_bound_water(v);
  var charFrac = canopy_char_fraction(v);
  var charMass = charFrac * initialDry;

  let extinction = canopy_extinction(v);
  // The plume needs absolute world Y (its source carries its own ground height); the
  // irradiance field needs height above ground. Same voxel, two frames, and the compiler
  // cannot tell them apart.
  let irradiance = sampleIrradiance(centre, (f32(ck) + 0.5) * CANOPY_CELL);
  let gas = plumeGasStateAtWorld(centre);
  let diameter = vparams.particleDiameter;
  let dt = vparams.dt;

  // Set while this step went entirely into evaporation and the voxel stayed at the plateau.
  var pinnedOnWater = false;
  let heatCapacity = dryMass * SOLID_SPECIFIC_HEAT + charMass * CHAR_SPECIFIC_HEAT +
    (free + bound) * WATER_SPECIFIC_HEAT;
  if (!(heatCapacity > 0.0)) { return; }

  let h = convectiveCoefficient(gas.tempK, temperature, gas.speed, diameter);
  // The Biot correction is WP 3.2's and multiplies the h WP 3.4 returns — see the note at the
  // top of convectiveSourceW. Applying it in both places would halve the coupling twice.
  let bi = (h * (diameter * 0.25)) / SOLID_CONDUCTIVITY;
  let exchangeArea = 2.0 * lad;
  let conductance = (h / (1.0 + bi * 0.5)) * exchangeArea;

  let radiative = radiativeSource(irradiance, extinction, lad, temperature);
  // Pool C is WP 3.1's flux pool and this is what it is for: the net volumetric source this
  // voxel saw, W m^-3. It is also what makes binding 4 live — a storage buffer a shader
  // declares and never touches is dropped from a `layout: 'auto'` pipeline, and the bind
  // group that supplies it then fails with "binding index 4 not present in the bind group
  // layout", three files from anything that looks related.
  canopyPoolC[v] = radiative + conductance * (gas.tempK - temperature);
  let hasWater = (free + bound) > 0.0;
  let boiling = WATER_BOILING_K;

  if (conductance > 0.0) {
    let tau = heatCapacity / conductance;
    let steady = gas.tempK + radiative / conductance;

    if (hasWater && temperature < boiling && steady > boiling) {
      // Heat to the boiling point, then spend what is left of the step evaporating.
      let toBoil = tau * log((steady - temperature) / (steady - boiling));
      if (toBoil >= dt) {
        temperature = approach(temperature, steady, dt, tau);
      } else {
        pinnedOnWater = true;
        let pinnedPower = conductance * (gas.tempK - boiling) + radiative;
        let w = evaporateWater(free, bound, pinnedPower * (dt - toBoil));
        free = w.free;
        bound = w.bound;
        temperature = boiling;
        if (w.surplus > 0.0) {
          pinnedOnWater = false;
          // Bone dry mid-step. Recomputing tau against the now-lighter voxel is what keeps
          // the hand-off energy-consistent.
          let dryCapacity = heatCapacity - (canopy_free_water(v) + canopy_bound_water(v)) * WATER_SPECIFIC_HEAT;
          let dryTau = max(dryCapacity, 1e-9) / conductance;
          temperature = approach(boiling, steady, w.surplus / pinnedPower, dryTau);
        }
      }
    } else if (hasWater && temperature >= boiling) {
      pinnedOnWater = true;
      let pinnedPower = conductance * (gas.tempK - temperature) + radiative;
      if (pinnedPower > 0.0) {
        let w = evaporateWater(free, bound, pinnedPower * dt);
        free = w.free;
        bound = w.bound;
        if (w.surplus > 0.0) {
          pinnedOnWater = false;
          let dryCapacity = heatCapacity - (canopy_free_water(v) + canopy_bound_water(v)) * WATER_SPECIFIC_HEAT;
          let dryTau = max(dryCapacity, 1e-9) / conductance;
          temperature = approach(temperature, steady, w.surplus / pinnedPower, dryTau);
        }
      } else {
        temperature = approach(temperature, steady, dt, tau);
      }
    } else {
      temperature = approach(temperature, steady, dt, tau);
    }
  } else {
    // Radiation only. Explicit is fine with no convective term to make it stiff, but the
    // boiling point is still an exact barrier and the step is split there.
    var energy = radiative * dt;
    if (hasWater && energy > 0.0) {
      if (temperature < boiling) {
        let toBoil = (boiling - temperature) * heatCapacity;
        if (energy <= toBoil) {
          temperature = temperature + energy / heatCapacity;
          energy = 0.0;
        } else {
          temperature = boiling;
          energy = energy - toBoil;
        }
      }
      if (energy > 0.0) {
        let w = evaporateWater(free, bound, energy);
        free = w.free;
        bound = w.bound;
        temperature = temperature + w.surplus / heatCapacity;
      }
    } else {
      temperature = temperature + energy / heatCapacity;
    }
  }

  // --- Pyrolysis -----------------------------------------------------------
  let rate = PYROLYSIS_A * exp(-PYROLYSIS_E_OVER_R / max(temperature, 1.0));
  let nextDry = select(dryMass, dryMass * exp(-rate * dt), dryMass > 0.0 && rate > 0.0);
  let lost = dryMass - nextDry;
  charMass = charMass + lost * CHAR_YIELD;
  let flux = select(0.0, lost / (exchangeArea * dt), exchangeArea > 0.0 && dt > 0.0);
  dryMass = nextDry;

  if (lost > 0.0) {
    let capacity = dryMass * SOLID_SPECIFIC_HEAT + charMass * CHAR_SPECIFIC_HEAT +
      (free + bound) * WATER_SPECIFIC_HEAT;
    if (capacity > 0.0) {
      temperature = temperature - (lost * PYROLYSIS_HEAT) / capacity;
    }
  }

  let phase = classify(temperature, dryMass, initialDry, flux, ignitionTemperature(initialDry, lad));
  if (phase == PHASE_FLAMING) {
    atomicAdd(&voxelStats[ST_FLAMING], 1u);
  }
  if (phase == PHASE_FLAMING || phase == PHASE_CHAR) {
    atomicAdd(&voxelStats[ST_EVER_IGNITED], 1u);
  }

  // Crown fuel budget. `initialDry` is the voxel's dry density as voxelised, and `dryMass` is
  // what is left of it — their ratio over the whole canopy is the measured crown consumed
  // fraction. Accumulated every step for every occupied voxel, so it costs two atomics on a
  // pass that is already running.
  atomicAdd(&voxelStats[ST_CROWN_DRY], u32(max(dryMass, 0.0) * CROWN_MASS_SCALE));
  atomicAdd(&voxelStats[ST_CROWN_INITIAL], u32(max(initialDry, 0.0) * CROWN_MASS_SCALE));
  atomicMax(&voxelStats[ST_MAX_TEMP], u32(max(temperature, 0.0) * TEMP_SCALE));
  if (temperature >= WARM_K) { atomicAdd(&voxelStats[ST_WARM_COUNT], 1u); }
  atomicMax(&voxelStats[ST_MAX_GAS], u32(max(gas.tempK, 0.0) * TEMP_SCALE));
  atomicMin(&voxelStats[ST_MIN_OFFSET], u32(min(abs(gas.offsetM) * OFFSET_SCALE, 4.2e9)));
  if (gas.tempK >= HOT_GAS_K) {
    atomicAdd(&voxelStats[ST_HOT_GAS_COUNT], 1u);
    atomicMax(&voxelStats[ST_MAX_TEMP_HOT], u32(max(temperature, 0.0) * TEMP_SCALE));
    if (pinnedOnWater) { atomicAdd(&voxelStats[ST_STALLED], 1u); }
  }

  // --- Write back ----------------------------------------------------------
  // f16 saturates at 65504 and temperature never approaches it, but a NaN here would poison
  // the voxel permanently, so clamp to a physical band rather than trusting the arithmetic.
  let outT = clamp(temperature, 1.0, 3000.0);
  canopyPoolA[v].x = canopy_pack_word0(outT, select(0.0, dryMass / initialDry, initialDry > 0.0));
  canopyPoolA[v].z = canopy_pack_water(free, bound);
  canopyPoolA[v].w =
    (u32(saturate(select(0.0, charMass / initialDry, initialDry > 0.0)) * 255.0 + 0.5) & 0xffu) |
    ((phase & 0xffu) << 8u) |
    ((pack2x16float(vec2f(flux, 0.0)) & 0xffffu) << 16u);
}

@compute @workgroup_size(1)
fn clearStats() {
  atomicStore(&voxelStats[ST_FLAMING], 0u);
  atomicStore(&voxelStats[ST_EVER_IGNITED], 0u);
  atomicStore(&voxelStats[ST_CROWN_DRY], 0u);
  atomicStore(&voxelStats[ST_CROWN_INITIAL], 0u);
  atomicStore(&voxelStats[ST_MAX_TEMP], 0u);
  atomicStore(&voxelStats[ST_WARM_COUNT], 0u);
  atomicStore(&voxelStats[ST_MAX_GAS], 0u);
  atomicStore(&voxelStats[ST_MIN_OFFSET], OFFSET_NONE);
  atomicStore(&voxelStats[ST_HOT_GAS_COUNT], 0u);
  atomicStore(&voxelStats[ST_MAX_TEMP_HOT], 0u);
  atomicStore(&voxelStats[ST_STALLED], 0u);
}
