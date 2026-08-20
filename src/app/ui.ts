/**
 * Dev HUD and control panel. DOM only — no GPU, no state of its own.
 *
 * The HUD is a single `<div>` with `white-space: pre`, rewritten a few times a second.
 * Deliberate: forty individually-updated spans is forty layout invalidations per update for
 * a panel nobody interacts with, and this is a diagnostic surface, not a UI.
 *
 * The provenance block is not decoration. Spec §0.7.4 is normative: confidence must be
 * visible at the point of use, not buried in a document. M1 renders no fire behaviour yet,
 * but the world's shape already comes from models with unequal confidence — the sun's
 * position is validated to 0.1° against an ephemeris; the weights deciding where the trees
 * stand are declared engineering estimates. One badge for both would be exactly the failure
 * §0.7 warns about.
 */

import type { AdapterReport, FrameTimings, QualityLevel, QualitySettings } from '@contracts/gpu.ts'
import { overallStatus, provenanceLines } from '../provenance.ts'
import { PHASES } from '@contracts/gpu.ts'
import type { CameraMode, FoliageStats, SolarState } from '@contracts/render.ts'
import { BIOME_IDS, type BiomeId } from '@contracts/world.ts'
import { biomeParams } from '@world/vegetation/biomes.ts'
import { FUEL_MODELS } from '@sim/rothermel/fuelModels.ts'
import { clock, compass, count, deg, ms, row } from './format.ts'
import type { AppSettings } from './settings.ts'
import { isQualityLevel, parseSeed, toolFrom } from './settings.ts'

export interface HudFrame {
  readonly timings: FrameTimings
  readonly fps: number
  readonly quality: QualityLevel
  readonly qualityPinned: boolean
  readonly settings: QualitySettings
  readonly cameraMode: CameraMode
  readonly position: readonly [number, number, number]
  readonly groundY: number
  readonly pointerLocked: boolean
  readonly foliage: FoliageStats
  readonly droppedStems: number
  readonly clampEvents: number
  readonly terrainTriangles: number
  readonly solar: SolarState
  readonly secondsOfDay: number
  readonly dayOfYear: number
  readonly exposure: number
  readonly renderWidth: number
  readonly renderHeight: number
  /** Absent until the M2 solver is up. */
  readonly fire?: FireHudFrame
}

/**
 * The fire block, split by **how each number was obtained**, because they are not equally
 * trustworthy and spec §0.7.4 makes that distinction normative rather than editorial.
 *
 * - `predicted` — WP 2.1's pure kernel on level ground. Validated to 0.32 % against published
 *   rate of spread, but it is a prediction for the *stated* conditions, not a readout of the
 *   grid: the GPU applies each cell's own slope.
 * - `measured` — read back from the solver's own counters. What actually happened.
 * - `missing` — a field the contract publishes that nothing currently writes. Named, not
 *   silently zeroed; a HUD that prints "0 kW/m" for an unwired field is worse than one that
 *   says the field is unwired.
 */
export interface FireHudFrame {
  readonly running: boolean
  readonly timeScale: number
  readonly simTimeS: number
  readonly fuelModelCode: string
  readonly fuelModelName: string
  readonly ignitionCount: number
  readonly windMps: number
  readonly windFromDeg: number
  readonly dead1hPct: number
  /** WP 2.1 head-fire prediction on level ground. */
  readonly predicted: {
    readonly rateOfSpreadMps: number
    readonly firelineIntensityKWm: number
    readonly flameLengthM: number
    readonly lengthToBreadth: number
    readonly effectiveWindMps: number
    readonly extinguished: boolean
  }
  /** Read back from the GPU. One to three steps stale, deliberately — see `solver.readback`. */
  readonly measured: {
    readonly burntAreaM2: number
    readonly perimeterM: number
    readonly activeCellCount: number
    readonly maxFirelineIntensityKWm: number
    readonly dispatchOverflowed: boolean
  }
  /** Contract fields nothing writes yet, with the work package that owes them. */
  readonly missing: readonly string[]
  readonly crown?: {
    readonly classification: string
    readonly criticalIntensityKWm: number
    readonly crownFractionBurned: number
    /** True when CFB is the Van Wagner curve, not a measurement of the voxel field. */
    readonly cfbIsDiagnostic: boolean
    /** WP 3.5: non-empty when this stand is outside Van Wagner's validated envelope. */
    readonly envelopeWarnings: readonly string[]
  }
  readonly firebrands?: {
    readonly airborne: number
    readonly landed: number
    readonly ignitionsCaused: number
    readonly maxSpotDistanceM: number
  }
}

export class Hud {
  readonly #el: HTMLElement
  readonly #header: string

  constructor(adapter: AdapterReport, stemCount: number, uniqueMeshes: number, doc: Document = document) {
    const el = doc.getElementById('hud')
    if (el === null) throw new Error('index.html is missing #hud')
    this.#el = el
    const name =
      [adapter.vendor, adapter.architecture, adapter.device].filter((s) => s.length > 0).join(' / ') ||
      adapter.description ||
      '(unreported)'
    this.#header = [
      row('adapter', name),
      adapter.looksIntegrated
        ? 'INTEGRATED GPU — frame times below are ~10x off and not comparable to the 60 fps target'
        : row('gpu class', 'discrete (as requested)'),
      row('world', `${count(stemCount)} stems, ${uniqueMeshes} unique tree meshes`),
    ].join('\n')
  }

  set visible(v: boolean) {
    this.#el.hidden = !v
  }

  get visible(): boolean {
    return !this.#el.hidden
  }

  update(f: HudFrame): void {
    const p = f.timings.phaseMs
    const x = f.position[0] as number
    const y = f.position[1] as number
    const z = f.position[2] as number
    const lines = [
      this.#header,
      '',
      row('fps / frame', `${f.fps.toFixed(0)} / ${ms(f.timings.medianFrameMs)} gpu, ${ms(f.timings.submitMs)} submit`),
      row('render target', `${f.renderWidth}x${f.renderHeight} @ ${(f.settings.resolutionScale * 100).toFixed(0)}%`),
      row('quality', `${f.quality}${f.qualityPinned ? ' (pinned)' : ' (auto)'}`),
      f.timings.highResolution ? '' : row('', 'phase times quantised to 100 us (not a dev build)'),
      ...PHASES.map((phase) => row(`  ${phase}`, ms(p[phase], 3))),
      '',
      row('camera', `${f.cameraMode}${f.pointerLocked ? '' : ' — click to look'}`),
      row('position', `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)} m (ground ${f.groundY.toFixed(1)} m)`),
      '',
      row('trees vis/cull', `${count(f.foliage.treesVisible)} / ${count(f.foliage.treesCulled)}`),
      row('draw calls', String(f.foliage.drawCalls)),
      row('triangles', `${count(f.foliage.trianglesSubmitted)} foliage + ${count(f.terrainTriangles)} terrain`),
      row('grass blades', count(f.foliage.grassBladesDrawn)),
      f.droppedStems > 0 ? row('DROPPED STEMS', count(f.droppedStems)) : '',
      f.clampEvents > 0 ? row('GPU CLAMPS', count(f.clampEvents)) : '',
      '',
      row('time of day', `${clock(f.secondsOfDay)} day ${f.dayOfYear}`),
      row(
        'sun',
        `elev ${deg(f.solar.elevation)} az ${deg(f.solar.azimuth)} ${compass(f.solar.azimuth)}` +
          ` ${f.solar.isDaytime ? 'day' : 'night'}`,
      ),
      row('irradiance', `${f.solar.directIrradiance.toFixed(0)} DNI / ${f.solar.diffuseIrradiance.toFixed(0)} DHI W/m2`),
      row('exposure', f.exposure.toExponential(2)),
      ...(f.fire === undefined ? [] : ['', ...fireLines(f.fire)]),
      '',
      `provenance — weakest contributor: ${overallStatus()}`,
      ...provenanceLines().map((l) => `  ${l}`),
    ]
    this.#el.textContent = lines.filter((l) => l !== '').join('\n')
  }
}

/**
 * The fire block. Exported so it can be tested without a DOM — the labelling is the point of
 * it, and a "measured" number that is really a prediction is the exact failure §0.7 is about.
 */
export function fireLines(f: FireHudFrame): readonly string[] {
  const p = f.predicted
  const mm = f.measured
  const chPerH = (mps: number): number => (mps * 3600) / 20.1168
  const lines = [
    row(
      'FIRE',
      `${f.running ? `running ${f.timeScale}x` : 'PAUSED'} · t+${clock(f.simTimeS)} sim` +
        ` · ${f.ignitionCount} ignition${f.ignitionCount === 1 ? '' : 's'}`,
    ),
    row('fuel model', `${f.fuelModelCode} — ${f.fuelModelName}`),
    row(
      'conditions',
      `${f.windMps.toFixed(1)} m/s midflame from ${f.windFromDeg.toFixed(0)}°` +
        ` · ${f.dead1hPct.toFixed(1)}% dead 1-h`,
    ),
    '',
    row('  predicted', 'head fire, level ground — WP 2.1 kernel'),
    p.extinguished
      ? row('    ROS', 'EXTINGUISHED — moisture at or above extinction, nothing can carry fire')
      : row(
          '    ROS',
          `${(p.rateOfSpreadMps * 60).toFixed(2)} m/min (${chPerH(p.rateOfSpreadMps).toFixed(1)} ch/h)`,
        ),
    row('    intensity', `${p.firelineIntensityKWm.toFixed(0)} kW/m Byram`),
    row('    flame length', `${p.flameLengthM.toFixed(2)} m`),
    row('    ellipse L:B', `${p.lengthToBreadth.toFixed(2)} at U_eff ${p.effectiveWindMps.toFixed(2)} m/s`),
    '',
    row('  measured', 'read back from the solver'),
    row('    burnt area', `${(mm.burntAreaM2 / 10_000).toFixed(2)} ha (${count(Math.round(mm.burntAreaM2))} m2)`),
    row('    perimeter', `${mm.perimeterM.toFixed(0)} m`),
    row('    active cells', count(mm.activeCellCount)),
    mm.dispatchOverflowed
      ? row('    DISPATCH OVERFLOW', 'a substep was clamped and work was DROPPED — numbers invalid')
      : '',
  ]

  if (f.crown !== undefined) {
    lines.push(
      '',
      row('  crown fire', f.crown.classification.toUpperCase()),
      row('    critical I', `${f.crown.criticalIntensityKWm.toFixed(0)} kW/m Van Wagner I_0`),
      row(
        '    CFB',
        `${(f.crown.crownFractionBurned * 100).toFixed(0)} %` +
          (f.crown.cfbIsDiagnostic ? ' — Van Wagner curve, not measured from the canopy' : ''),
      ),
      ...f.crown.envelopeWarnings.map((wgn) => `    OUTSIDE ENVELOPE: ${wgn}`),
    )
  }
  if (f.firebrands !== undefined) {
    lines.push(
      '',
      row('  firebrands', `${count(f.firebrands.airborne)} airborne, ${count(f.firebrands.landed)} landed`),
      row('    spot fires', `${count(f.firebrands.ignitionsCaused)} caused`),
      row('    max spot', `${f.firebrands.maxSpotDistanceM.toFixed(0)} m`),
    )
  }
  if (f.missing.length > 0) {
    lines.push('', row('  NOT WIRED', 'contract fields nothing writes yet:'))
    for (const s of f.missing) lines.push(`    ${s}`)
  }
  // '' means "omit this row" here, the same as everywhere else in this file — `Hud.update`
  // strips them. Grouping is carried by the two-space indent, not by blank lines.
  return lines
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface ControlHandlers {
  readonly onLive: (patch: Partial<AppSettings>) => void
  readonly onRegenerate: (seed: number, biome: BiomeId) => void
  readonly onTeleport: () => void
  /** Ignite at the crosshair. Right-clicking the terrain does the same thing. */
  readonly onIgnite: () => void
  readonly onResetFire: () => void
}

export class Controls {
  readonly #el: HTMLElement

  constructor(settings: AppSettings, handlers: ControlHandlers, doc: Document = document) {
    const el = doc.getElementById('controls')
    if (el === null) throw new Error('index.html is missing #controls')
    this.#el = el
    el.replaceChildren()

    el.append(heading('World'))
    const seed = input('text', String(settings.seed))
    const biome = select(
      BIOME_IDS.map((b) => [b, biomeParams(b).displayName] as const),
      settings.biome,
    )
    el.append(field('seed', seed), field('biome', biome))
    const regen = button('Regenerate (takes seconds)')
    regen.addEventListener('click', () => {
      const chosen = (BIOME_IDS as readonly string[]).includes(biome.value)
        ? (biome.value as BiomeId)
        : settings.biome
      handlers.onRegenerate(parseSeed(seed.value), chosen)
    })
    el.append(regen)

    // --- Fire -----------------------------------------------------------------------------
    // Moisture is entered as a PERCENT here and nowhere else, because that is how every
    // published fuel table quotes it and asking for 0.06 invites an order-of-magnitude slip.
    // `weatherFromSettings` in main.ts divides by 100 exactly once (spec §0.6).
    el.append(heading('Fire'))

    const ignite = button('Ignite at crosshair  (or right-click the ground)')
    ignite.addEventListener('click', () => handlers.onIgnite())
    el.append(ignite)

    const tool = select(
      [
        ['point', 'point'],
        ['line', 'line (across the wind)'],
        ['ring', 'ring'],
      ],
      settings.ignitionTool,
    )
    tool.addEventListener('change', () => {
      const v = toolFrom(tool.value)
      if (v !== null) handlers.onLive({ ignitionTool: v })
    })
    el.append(field('ignition', tool))

    const ignR = range(0.5, 60, 0.5, settings.ignitionRadiusM)
    const ignRLabel = valueLabel(`${settings.ignitionRadiusM.toFixed(1)} m`)
    ignR.addEventListener('input', () => {
      ignRLabel.textContent = `${Number(ignR.value).toFixed(1)} m`
      handlers.onLive({ ignitionRadiusM: Number(ignR.value) })
    })
    el.append(field('size', ignR), field('', ignRLabel))

    const wind = range(0, 15, 0.1, settings.windMps)
    const windLabel = valueLabel(`${settings.windMps.toFixed(1)} m/s midflame`)
    wind.addEventListener('input', () => {
      windLabel.textContent = `${Number(wind.value).toFixed(1)} m/s midflame`
      handlers.onLive({ windMps: Number(wind.value) })
    })
    el.append(field('wind', wind), field('', windLabel))

    const windDir = range(0, 359, 1, settings.windFromDeg)
    const windDirLabel = valueLabel(`from ${settings.windFromDeg}°`)
    windDir.addEventListener('input', () => {
      windDirLabel.textContent = `from ${windDir.value}°`
      handlers.onLive({ windFromDeg: Number(windDir.value) })
    })
    el.append(field('wind dir', windDir), field('', windDirLabel))

    const mc = range(1, 40, 0.5, settings.dead1hPct)
    const mcLabel = valueLabel(`${settings.dead1hPct.toFixed(1)} % dead 1-h`)
    mc.addEventListener('input', () => {
      mcLabel.textContent = `${Number(mc.value).toFixed(1)} % dead 1-h`
      handlers.onLive({ dead1hPct: Number(mc.value) })
    })
    el.append(field('moisture', mc), field('', mcLabel))

    const herb = range(30, 250, 5, settings.liveHerbPct)
    const herbLabel = valueLabel(`${settings.liveHerbPct.toFixed(0)} % live herb`)
    herb.addEventListener('input', () => {
      herbLabel.textContent = `${Number(herb.value).toFixed(0)} % live herb`
      handlers.onLive({ liveHerbPct: Number(herb.value) })
    })
    el.append(field('curing', herb), field('', herbLabel))

    const fuel = select(
      [['', 'biome default'], ...FUEL_MODELS.codes.map((c) => [c, c] as const)],
      settings.fuelModel ?? '',
    )
    fuel.addEventListener('change', () =>
      handlers.onLive({ fuelModel: fuel.value === '' ? null : fuel.value }),
    )
    el.append(field('fuel model', fuel))

    const scale = select(
      [1, 2, 4, 8, 16, 32, 64].map((n) => [String(n), `${n}x real time`] as const),
      String(settings.fireTimeScale),
    )
    // Multiplies the number of fixed steps, never their size (spec §0.5.1) — so this costs
    // GPU time linearly and does not degrade the solver or invalidate the HUD's numbers.
    scale.addEventListener('change', () => handlers.onLive({ fireTimeScale: Number(scale.value) }))
    el.append(field('sim speed', scale))

    const run = select(
      [
        ['1', 'running'],
        ['0', 'paused'],
      ],
      settings.firePaused ? '0' : '1',
    )
    run.addEventListener('change', () => handlers.onLive({ firePaused: run.value === '0' }))
    el.append(field('solver', run))

    const view = select(
      [
        ['off', 'off'],
        ['state', 'state'],
        ['arrival', 'arrival isochrones'],
        ['intensity', 'intensity (WP 2.4 gap)'],
        ['consumed', 'consumed (WP 2.4 gap)'],
      ],
      settings.fireView,
    )
    view.addEventListener('change', () => handlers.onLive({ fireView: view.value }))
    el.append(field('overlay', view))

    const resetFire = button('Reset fire')
    resetFire.addEventListener('click', () => handlers.onResetFire())
    el.append(resetFire)

    el.append(heading('Sky'))
    const time = range(0, 86340, 60, settings.secondsOfDay)
    const timeLabel = valueLabel(clock(settings.secondsOfDay))
    time.addEventListener('input', () => {
      const s = Number(time.value)
      timeLabel.textContent = clock(s)
      handlers.onLive({ secondsOfDay: s })
    })
    el.append(field('time', time), field('', timeLabel))

    const day = range(1, 366, 1, settings.dayOfYear)
    const dayLabel = valueLabel(String(settings.dayOfYear))
    day.addEventListener('input', () => {
      dayLabel.textContent = day.value
      handlers.onLive({ dayOfYear: Number(day.value) })
    })
    el.append(field('day of year', day), field('', dayLabel))

    const rate = select(
      [
        ['0', 'frozen'],
        ['0.05', '3 min/s'],
        ['0.25', '15 min/s'],
        ['1', '1 hour/s'],
        ['4', '4 hours/s'],
      ],
      String(settings.hoursPerSecond),
    )
    rate.addEventListener('change', () => handlers.onLive({ hoursPerSecond: Number(rate.value) }))
    el.append(field('sun rate', rate))

    const stops = range(-4, 4, 0.25, settings.exposureStops)
    const stopsLabel = valueLabel(`${settings.exposureStops.toFixed(2)} EV`)
    stops.addEventListener('input', () => {
      stopsLabel.textContent = `${Number(stops.value).toFixed(2)} EV`
      handlers.onLive({ exposureStops: Number(stops.value) })
    })
    el.append(field('exposure', stops), field('', stopsLabel))

    el.append(heading('Render'))
    const quality = select(
      [
        ['auto', 'adaptive'],
        ...([0, 1, 2, 3, 4, 5] as const).map((q) => [String(q), `pinned ${q}`] as const),
      ],
      settings.qualityPin === null ? 'auto' : String(settings.qualityPin),
    )
    quality.addEventListener('change', () => {
      const v = Number(quality.value)
      handlers.onLive({ qualityPin: quality.value === 'auto' || !isQualityLevel(v) ? null : v })
    })
    el.append(field('quality', quality))

    const grass = select(
      [
        ['1', 'on'],
        ['0', 'off (rebuild)'],
      ],
      settings.grassEnabled ? '1' : '0',
    )
    grass.addEventListener('change', () => handlers.onLive({ grassEnabled: grass.value === '1' }))
    el.append(field('grass', grass))

    const speed = range(1, 200, 1, settings.cameraSpeed)
    const speedLabel = valueLabel(`${settings.cameraSpeed.toFixed(0)} m/s`)
    speed.addEventListener('input', () => {
      speedLabel.textContent = `${Number(speed.value).toFixed(0)} m/s`
      handlers.onLive({ cameraSpeed: Number(speed.value) })
    })
    el.append(field('drone speed', speed), field('', speedLabel))

    const teleport = button('Teleport to centre')
    teleport.addEventListener('click', () => handlers.onTeleport())
    el.append(teleport)

    const hint = doc.createElement('div')
    hint.className = 'hint'
    hint.textContent =
      'click canvas for pointer lock · WASD move · Space/C up-down · Shift sprint · F toggle camera · ' +
      'H hide HUD · right-click ground to ignite · V cycle fire overlay · Shift+R reset fire'
    el.append(hint)
  }

  set visible(v: boolean) {
    this.#el.hidden = !v
  }
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3')
  h.textContent = text
  return h
}

function field(label: string, control: HTMLElement): HTMLElement {
  const div = document.createElement('div')
  div.className = 'row'
  const l = document.createElement('label')
  l.textContent = label
  div.append(l, control)
  return div
}

function valueLabel(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'val'
  span.textContent = text
  return span
}

function input(type: string, value: string): HTMLInputElement {
  const el = document.createElement('input')
  el.type = type
  el.value = value
  return el
}

function range(min: number, max: number, step: number, value: number): HTMLInputElement {
  const el = document.createElement('input')
  el.type = 'range'
  el.min = String(min)
  el.max = String(max)
  el.step = String(step)
  el.value = String(value)
  return el
}

function select(options: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const el = document.createElement('select')
  for (const [v, label] of options) {
    const opt = document.createElement('option')
    opt.value = v
    opt.textContent = label
    el.append(opt)
  }
  el.value = value
  return el
}

function button(text: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.textContent = text
  return el
}
