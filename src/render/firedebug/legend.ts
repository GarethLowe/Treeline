/**
 * The legend — WP 2.6.
 *
 * A debug view whose colours have no stated range is a picture, not a measurement, and the
 * whole point of this package is to let M2 be judged. So the legend is not decoration: it is
 * the half that makes the other half mean something.
 *
 * Split in two on purpose. `legendModel` is a pure function of the view and its ranges and
 * is unit-tested; `FireDebugLegend` is the ~40 lines of DOM that draw it, which needs a
 * browser and is not.
 */

import {
  ARRIVAL_RAMP,
  CONSUMED_RAMP,
  DEFAULT_RANGES,
  INTENSITY_RAMP,
  STATE_COLORS,
  rampColor,
  type FireDebugRanges,
  type FireDebugViewId,
  type Ramp,
} from './views.ts'
import { CELL_BURNING, CELL_BURNT, CELL_UNBURNT } from '@contracts/sim.ts'

export interface LegendSwatch {
  /** `#rrggbb`. */
  readonly color: string
  readonly label: string
}

export interface LegendModel {
  readonly view: FireDebugViewId
  readonly title: string
  /** Unit of the quantity, or '' where there isn't one. */
  readonly unit: string
  /** `gradient` = continuous ramp with tick labels; `swatches` = discrete keys. */
  readonly kind: 'gradient' | 'swatches'
  /** Left-to-right for a gradient, top-to-bottom for swatches. */
  readonly swatches: readonly LegendSwatch[]
  /** Present for gradients: the CSS `linear-gradient` colour list. */
  readonly gradientCss: string
  /** Says out loud what the view cannot be trusted for. */
  readonly note: string
}

/** Seconds are the storage unit (spec §0.6 rule 5); minutes exist only in labels like this. */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return '—'
  if (sec < 90) return `${sec.toFixed(sec < 10 ? 1 : 0)} s`
  const min = sec / 60
  if (min < 90) return `${min.toFixed(min < 10 ? 1 : 0)} min`
  return `${(min / 60).toFixed(1)} h`
}

function hex(c: readonly [number, number, number]): string {
  const ch = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(c[0])}${ch(c[1])}${ch(c[2])}`
}

function gradientCss(ramp: Ramp): string {
  return ramp.map((s) => `${hex([s[1], s[2], s[3]])} ${(s[0] * 100).toFixed(0)}%`).join(', ')
}

/** Four ticks across the ramp, labelled with the value each one represents. */
function ticks(ramp: Ramp, valueAt: (t: number) => string, n = 4): LegendSwatch[] {
  const out: LegendSwatch[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    out.push({ color: hex(rampColor(ramp, t)), label: valueAt(t) })
  }
  return out
}

function formatIntensity(kWm: number): string {
  if (kWm >= 1000) return `${(kWm / 1000).toFixed(kWm >= 10000 ? 0 : 1)} MW/m`
  return `${kWm < 100 ? kWm.toFixed(0) : Math.round(kWm)} kW/m`
}

export function legendModel(
  view: FireDebugViewId,
  ranges: FireDebugRanges = DEFAULT_RANGES,
): LegendModel {
  switch (view) {
    case 'state':
      return {
        view,
        title: 'Cell state',
        unit: '',
        kind: 'swatches',
        swatches: [
          { color: hex([0, 0, 0]), label: 'unburnt (not drawn)' },
          {
            color: hex([
              STATE_COLORS[CELL_BURNING][0],
              STATE_COLORS[CELL_BURNING][1],
              STATE_COLORS[CELL_BURNING][2],
            ]),
            label: 'burning',
          },
          {
            color: hex([
              STATE_COLORS[CELL_BURNT][0],
              STATE_COLORS[CELL_BURNT][1],
              STATE_COLORS[CELL_BURNT][2],
            ]),
            label: 'burnt',
          },
        ],
        gradientCss: '',
        note: `${CELL_UNBURNT}/${CELL_BURNING}/${CELL_BURNT} from stateTexture (r8uint)`,
      }
    case 'intensity': {
      const lo = Math.log(ranges.intensityMinKWm)
      const hi = Math.log(ranges.intensityMaxKWm)
      return {
        view,
        title: 'Fireline intensity',
        unit: 'kW/m',
        kind: 'gradient',
        swatches: ticks(INTENSITY_RAMP, (t) => formatIntensity(Math.exp(lo + (hi - lo) * t))),
        gradientCss: gradientCss(INTENSITY_RAMP),
        note: 'log scale; Byram I_B, spec §4.7',
      }
    }
    case 'arrival':
      return {
        view,
        title: 'Time of arrival',
        unit: 's',
        kind: 'gradient',
        swatches: ticks(ARRIVAL_RAMP, (t) => formatSeconds(ranges.arrivalMaxS * t)),
        gradientCss: gradientCss(ARRIVAL_RAMP),
        note: `isochrones every ${formatSeconds(ranges.isochroneIntervalS)}`,
      }
    case 'consumed':
      return {
        view,
        title: 'Fuel consumed',
        unit: 'fraction',
        kind: 'gradient',
        // Fraction, not percent (spec §0.6 rule 3) — the HUD is the only place percent is
        // allowed, and this is not the HUD.
        swatches: ticks(CONSUMED_RAMP, (t) => t.toFixed(2)),
        gradientCss: gradientCss(CONSUMED_RAMP),
        note: 'oven-dry mass fraction',
      }
  }
}

/** Aggregates worth printing under the ramp. Read straight off `IFireOutputs`, no GPU sync. */
export interface LegendStats {
  readonly burntAreaM2: number
  readonly perimeterM: number
  readonly maxFirelineIntensityKWm: number
  readonly activeCellCount: number
  readonly simTimeS: number
}

export function formatStats(s: LegendStats): string {
  const ha = s.burntAreaM2 / 10000
  return [
    `t ${formatSeconds(s.simTimeS)}`,
    `burnt ${ha < 10 ? ha.toFixed(2) : ha.toFixed(1)} ha`,
    `perim ${Math.round(s.perimeterM)} m`,
    `peak ${formatIntensity(s.maxFirelineIntensityKWm)}`,
    `active ${s.activeCellCount}`,
  ].join('  ·  ')
}

/**
 * DOM legend. Absolutely positioned, appended wherever the caller says. Provisional styling
 * to match: this is a debug overlay, not part of the product UI (which is `src/ui`).
 */
export class FireDebugLegend {
  readonly element: HTMLElement
  readonly #title: HTMLElement
  readonly #body: HTMLElement
  readonly #note: HTMLElement
  readonly #stats: HTMLElement

  constructor(doc: Document = document) {
    const el = doc.createElement('div')
    el.style.cssText = [
      'position:absolute',
      'right:12px',
      'bottom:12px',
      'width:220px',
      'padding:8px 10px',
      'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#e8e8e8',
      'background:rgba(12,12,14,0.72)',
      'border:1px solid rgba(255,255,255,0.14)',
      'border-radius:4px',
      'pointer-events:none',
      'z-index:20',
    ].join(';')
    this.#title = doc.createElement('div')
    this.#title.style.cssText = 'font-weight:600;margin-bottom:6px'
    this.#body = doc.createElement('div')
    this.#note = doc.createElement('div')
    this.#note.style.cssText = 'margin-top:6px;opacity:0.6'
    this.#stats = doc.createElement('div')
    this.#stats.style.cssText = 'margin-top:4px;opacity:0.8;word-spacing:-1px'
    el.append(this.#title, this.#body, this.#note, this.#stats)
    this.element = el
  }

  update(view: FireDebugViewId, ranges?: FireDebugRanges, stats?: LegendStats): void {
    const model = legendModel(view, ranges)
    this.#title.textContent = `${model.title}${model.unit ? ` (${model.unit})` : ''}`
    this.#body.replaceChildren(...this.#renderBody(model))
    this.#note.textContent = model.note
    this.#stats.textContent = stats ? formatStats(stats) : ''
  }

  #renderBody(model: LegendModel): HTMLElement[] {
    const doc = this.element.ownerDocument
    if (model.kind === 'swatches') {
      return model.swatches.map((s) => {
        const row = doc.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:6px'
        const chip = doc.createElement('span')
        chip.style.cssText = `width:12px;height:12px;background:${s.color};border:1px solid rgba(255,255,255,0.3)`
        const label = doc.createElement('span')
        label.textContent = s.label
        row.append(chip, label)
        return row
      })
    }
    const bar = doc.createElement('div')
    bar.style.cssText = `height:10px;background:linear-gradient(90deg, ${model.gradientCss});border:1px solid rgba(255,255,255,0.25)`
    const labels = doc.createElement('div')
    labels.style.cssText = 'display:flex;justify-content:space-between;margin-top:3px;font-size:10px'
    for (const s of model.swatches) {
      const span = doc.createElement('span')
      span.textContent = s.label
      labels.append(span)
    }
    return [bar, labels]
  }

  destroy(): void {
    this.element.remove()
  }
}
