/**
 * Does a crown ignite? The pure-TypeScript answer, in seconds rather than a 20-minute GPU boot.
 *
 * The canopy chain runs on the GPU, but every piece of physics in it — the plume, the
 * convective coefficient, the voxel kinetics, the ignition gate — is a pure module that Node
 * can run directly. So when the question is "should this crown ignite?", ask the physics, not
 * the renderer. If the CPU says yes and the GPU says no, the bug is in the wiring; if the CPU
 * also says no, the shortfall is in the model or its inputs and no amount of GPU debugging
 * will find it.
 *
 *   npx tsx scripts/crown-probe.mjs      (or: npx vite-node scripts/crown-probe.mjs)
 *
 * Prints the gas temperature a crown-base voxel sees, the heat it receives by each channel,
 * and whether it reaches its ignition gate.
 *
 * **Feed it measured inputs or it is not an oracle.** Every constant below that describes the
 * fire or its field must come from a `?debug` probe line on a real GPU. Answering "no" from an
 * assumed input looks exactly like answering "no" from the physics, and in August 2026 it cost
 * three sessions: see the RESOLVED note in docs/spec/30-canopy-heat-crown.md 7.5.
 */

import { solvePlume, buildPlumeLut, samplePlumeLut, PLUME_LUT_TOP_M } from '../src/sim/canopy/convection/plume.ts'
import { convectiveCoefficient } from '../src/sim/canopy/convection/heatTransfer.ts'
import { makeVoxel, stepVoxel, hasIgnited } from '../src/sim/canopy/kinetics/voxel.ts'

const kWm = (v) => v
const m = (v) => v
const K = (v) => v

// A crowning-intensity surface fire: SB4 high-load blowdown, as the headless runs used.
const INTENSITY_KWM = 8011
const ROS_MPS = 17.49 / 60
const RESIDENCE_S = 15
const FLAME_DEPTH_M = ROS_MPS * RESIDENCE_S

// A conifer crown: canopy bulk density and LAD in the range the voxeliser produces, at the
// crown base where initiation happens.
const CROWN_BASE_M = 8
const CBD = 0.15            // kg/m3, Van Wagner's active-crowning range is 0.05-0.2
const LAD = 1.0             // m2/m3
const FMC = 1.0             // foliar moisture content, fraction (100 %) — Van Wagner's nominal
const AMBIENT_K = 293.15
const PARTICLE_D = 0.001

const profile = solvePlume(
  { intensity: kWm(INTENSITY_KWM), flameDepth: m(FLAME_DEPTH_M) },
  { tempK: K(AMBIENT_K), density: 1.2, potentialTempGradient: 0, wind: () => 2.2 },
)
const lut = buildPlumeLut(profile)

console.log(`fire            I = ${INTENSITY_KWM} kW/m, D = ${FLAME_DEPTH_M.toFixed(2)} m`)
console.log(`plume           B0 = ${profile.buoyancyFlux0.toExponential(2)}, level-off ${profile.levelOffHeight}`)
console.log('')
const cfg = { ambientTempK: AMBIENT_K, windSpeed: 2.2 }
console.log('height   gas(K)   over ambient   w(m/s)   |  at 10 m off-axis')
for (const hgt of [2, 4, 8, 12, 16, 24, 32]) {
  const on = samplePlumeLut(lut, hgt, 0, cfg)
  const off = samplePlumeLut(lut, hgt, 10, cfg)
  console.log(
    `${String(hgt).padStart(5)} m  ${on.gasTempK.toFixed(1).padStart(7)}  ` +
      `${(on.gasTempK - AMBIENT_K).toFixed(1).padStart(12)}  ${on.gasSpeed.toFixed(2).padStart(6)}   |  ` +
      `${off.gasTempK.toFixed(1)} K (${(off.gasTempK - AMBIENT_K).toFixed(1)} over)`,
  )
}

// On the plume axis at the crown base.
// Directly above the fire AND on the tilted centreline. The plume leans downwind, so the
// hottest gas at crown height is NOT above the source — that offset is the whole question.
const above = samplePlumeLut(lut, CROWN_BASE_M, 0, cfg)
const onAxis = samplePlumeLut(lut, CROWN_BASE_M, lut[2 * 4 + 3], cfg)
console.log(`  above source    ${above.gasTempK.toFixed(1)} K`)
console.log(`  on centreline   ${onAxis.gasTempK.toFixed(1)} K (offset ${lut[2 * 4 + 3].toFixed(2)} m downwind)`)
const row = onAxis
const gasK = row.gasTempK
const h = convectiveCoefficient({
  gasTempK: K(gasK),
  solidTempK: K(AMBIENT_K),
  gasSpeed: row.gasSpeed,
  diameter: m(PARTICLE_D),
})

console.log('')
console.log(`at ${CROWN_BASE_M} m on the axis:`)
console.log(`  gas             ${gasK.toFixed(1)} K (${(gasK - AMBIENT_K).toFixed(1)} K over ambient)`)
console.log(`  h               ${h.toFixed(1)} W/m2/K`)

let voxel = makeVoxel({ dryMass: CBD, moisture: FMC, leafAreaDensity: LAD, temperatureK: K(AMBIENT_K) })
console.log(`  ignition gate   ${voxel.ignitionK.toFixed(1)} K`)

const env = {
  gasTemperatureK: K(gasK),
  convectiveCoefficient: h,
  // Measured from the headless probe at 8 m AGL under this fire. 53250 stood here until
  // 2026-08-21 and was wrong by 20x -- the ?debug canopy probe reports "irradiance peak 2.49
  // kW/m2". That single unmeasured input is what made this script answer NO IGNITION and sent
  // three sessions after a plume that was working. If you change a number here, take it from a
  // probe line, not from an estimate.
  irradiance: 2490,
  extinction: 0.5 * LAD,
  leafAreaDensity: LAD,
  particleDiameter: PARTICLE_D,
}

const dt = 0.05
let t = 0
let ignitedAt = null
for (let i = 0; i < 20000; i++) {
  voxel = stepVoxel(voxel, env, dt)
  t += dt
  if (ignitedAt === null && hasIgnited(voxel)) ignitedAt = t
  if (ignitedAt !== null) break
}
console.log('')
console.log(
  ignitedAt === null
    ? `  RESULT          NO IGNITION after ${t.toFixed(0)} s — peak ${voxel.temperatureK.toFixed(1)} K, ` +
        `${((1 - voxel.dryMass / voxel.initialDryMass) * 100).toFixed(1)} % consumed`
    : `  RESULT          IGNITED at t = ${ignitedAt.toFixed(2)} s`,
)

// --- Is buoyancy flux conserved? --------------------------------------------
// In a neutral environment the MTT plume conserves B = g'·w·b along z. If the solve loses it,
// every excess temperature downstream is wrong and no amount of tuning the canopy will help.
console.log('')
console.log('conservation check (neutral: g\'*w*b must stay at B0)')
console.log(`  B0 = ${profile.buoyancyFlux0.toFixed(1)}`)
for (const target of [1, 2, 4, 8, 16, 32]) {
  let k = 0
  for (let i = 0; i < profile.z.length; i++) if (profile.z[i] <= target) k = i
  const g = profile.centrelineBuoyancy[k]
  const w = profile.centrelineVelocity[k]
  const b = profile.halfWidth[k]
  console.log(
    `  z=${String(target).padStart(3)} m  g'=${g.toExponential(2)}  w=${w.toFixed(2)}  ` +
      `b=${b.toFixed(2)}  ->  g'*w*b = ${(g * w * b).toFixed(1)}  ` +
      `dT=${profile.centrelineExcessTempK[k].toFixed(1)} K`,
  )
}

console.log('')
console.log('raw LUT rows [dT, w, b, tilt]  (row i is at i*128/31 m)')
for (let i = 0; i < 6; i++) {
  const o = i * 4
  console.log(
    `  row ${i} (z=${(i * 128 / 31).toFixed(2)} m)  dT=${lut[o].toFixed(1)}  w=${lut[o + 1].toFixed(2)}  ` +
      `b=${lut[o + 2].toFixed(2)}  tilt=${lut[o + 3].toFixed(2)}`,
  )
}
