/**
 * The boot and progress screen.
 *
 * Two jobs, and the second one is the reason this file is as long as it is.
 *
 * 1. **Progress.** World generation is seconds of straight-line CPU. A frozen tab is
 *    indistinguishable from a hang, so every stage reports its state and its real duration.
 *
 * 2. **Diagnosis.** When a subsystem fails the screen must say *which* and *what it said*.
 *    A blank canvas with an error in the console is the outcome this file exists to prevent.
 *
 * The adapter report is load-bearing: on this machine the browser silently selects the Intel
 * iGPU over the RTX 4070, and every frame time measured in that state is ~10x off and
 * meaningless. `adapter-advice.ts` ships the advice as DATA; this is the UI layer for it.
 */

import type { AdapterReport } from '@contracts/gpu.ts'
import { adapterAdvice, missingFeatures, type AdapterAdvice } from '@core/adapter-advice.ts'
import { describeError, StageError, type StageRecord } from './stages.ts'
import { ms } from './format.ts'

type Tone = 'ok' | 'warn' | 'err' | 'dim'

const MARKS: Record<StageRecord['state'], string> = {
  pending: '·',
  running: '▸',
  done: '✓',
  failed: '✕',
  skipped: '–',
}

export class BootScreen {
  readonly #root: HTMLElement
  readonly #phase: HTMLElement
  readonly #bar: HTMLElement
  readonly #stages: HTMLElement
  readonly #reportHeading: HTMLElement
  readonly #report: HTMLElement
  readonly #msg: HTMLElement
  readonly #remedies: HTMLElement
  #subFraction = 0

  constructor(doc: Document = document) {
    this.#root = must(doc, 'boot')
    this.#phase = must(doc, 'boot-phase')
    this.#bar = must(doc, 'bar').firstElementChild as HTMLElement
    this.#stages = must(doc, 'stages')
    this.#reportHeading = must(doc, 'report-heading')
    this.#report = must(doc, 'report')
    this.#msg = must(doc, 'msg')
    this.#remedies = must(doc, 'remedies')
  }

  setPhase(text: string): void {
    this.#phase.textContent = text
  }

  /** Fraction inside the current stage, so a long stage's bar still moves. */
  setSubProgress(fraction: number): void {
    this.#subFraction = Math.min(1, Math.max(0, fraction))
  }

  renderStages(records: readonly StageRecord[]): void {
    this.#stages.replaceChildren()
    for (const r of records) {
      const li = document.createElement('li')
      li.dataset['state'] = r.state
      li.append(
        span('mark', MARKS[r.state]),
        span('label', r.label),
        span('t', r.state === 'done' || r.state === 'failed' ? ms(r.ms, 0) : ''),
        span('note', r.state === 'failed' ? describeError(r.error) : r.note),
      )
      this.#stages.append(li)
    }
    const done = records.filter((r) => r.state === 'done' || r.state === 'skipped').length
    const total = Math.max(1, records.length)
    this.#bar.style.width = `${(((done + this.#subFraction) / total) * 100).toFixed(1)}%`
  }

  /** The adapter block, including the integrated-GPU warning and its remediation. */
  renderAdapter(report: AdapterReport, deviceLimits: Record<string, number>): AdapterAdvice {
    const advice = adapterAdvice(report)
    this.#reportHeading.hidden = false
    this.#report.replaceChildren()

    const name =
      [report.vendor, report.architecture, report.device].filter((s) => s.length > 0).join(' / ') ||
      report.description ||
      '(unreported)'
    this.#row('Adapter', name)
    if (report.description) this.#row('Description', report.description)
    this.#row(
      'GPU selection',
      report.looksIntegrated
        ? 'looks INTEGRATED — every frame time below is ~10x off and not comparable'
        : 'discrete GPU (as requested)',
      report.looksIntegrated ? 'warn' : 'ok',
    )
    this.#row('Features granted', report.grantedFeatures.join(', ') || '(none)')
    const missing = missingFeatures(report)
    if (missing.length > 0) this.#row('Features refused', missing.join(', '), 'warn')
    this.#row(
      'Limit shortfalls',
      report.limitShortfalls.length === 0
        ? 'none'
        : report.limitShortfalls.map((s) => `${s.limit} ${s.got}/${s.wanted}`).join('; '),
      report.limitShortfalls.length === 0 ? 'ok' : 'warn',
    )
    for (const [k, v] of Object.entries(deviceLimits)) this.#row(k, String(v), 'dim')
    this.#row(
      'crossOriginIsolated',
      String(typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false),
      typeof crossOriginIsolated === 'boolean' && crossOriginIsolated ? 'ok' : 'warn',
    )

    this.renderAdvice(advice)
    return advice
  }

  renderAdvice(advice: AdapterAdvice): void {
    this.#msg.className = advice.blocking ? 'warn' : advice.remedies.length > 0 ? 'warn' : 'ok'
    this.#msg.textContent = `${advice.headline}\n${advice.body}`
    this.#remedies.replaceChildren()
    for (const r of advice.remedies) {
      const div = document.createElement('div')
      div.className = 'r'
      const title = document.createElement('div')
      title.className = 'rt'
      title.textContent = r.title
      const detail = document.createElement('div')
      detail.className = 'rd'
      detail.textContent = r.detail
      div.append(title, detail)
      if (r.url !== undefined) {
        const url = document.createElement('div')
        url.className = 'rd'
        const code = document.createElement('code')
        // A page cannot navigate to chrome://, so this is text to copy, never a link.
        code.textContent = r.url
        url.append(document.createTextNode('paste into the address bar: '), code)
        div.append(url)
      }
      this.#remedies.append(div)
    }
  }

  /** Append arbitrary warnings collected during generation. */
  renderWarnings(warnings: readonly string[]): void {
    if (warnings.length === 0) return
    const block = document.createElement('div')
    block.className = 'warn'
    block.textContent = `\n${warnings.map((w) => `warning: ${w}`).join('\n')}`
    this.#msg.append(block)
  }

  /**
   * Terminal failure. Names the stage, the owning package and the underlying error, and
   * keeps the boot screen up rather than falling through to a black canvas.
   */
  renderFailure(err: unknown): void {
    this.setPhase('failed')
    this.#msg.className = 'err'
    const lines: string[] = []
    if (err instanceof StageError) {
      lines.push(`Stage "${err.stageLabel}" failed.`)
      lines.push('')
      lines.push(describeError(err.cause))
    } else {
      lines.push('Boot failed before any stage started.')
      lines.push('')
      lines.push(describeError(err))
    }
    lines.push('')
    lines.push('Reload with ?debug to dump subsystem state.')
    this.#msg.textContent = lines.join('\n')

    const cause = err instanceof StageError ? err.cause : err
    if (cause instanceof Error && typeof cause.stack === 'string') {
      const pre = document.createElement('pre')
      pre.className = 'trace'
      pre.textContent = cause.stack
      this.#remedies.replaceChildren(pre)
    }
    this.show()
  }

  /** Free-form preformatted block — used by `?debug` for the smoke-test dump. */
  appendBlock(heading: string, body: string): void {
    const h = document.createElement('h2')
    h.textContent = heading
    const pre = document.createElement('pre')
    pre.className = 'trace'
    pre.textContent = body
    this.#root.firstElementChild?.append(h, pre)
  }

  show(): void {
    this.#root.hidden = false
  }

  hide(): void {
    this.#root.hidden = true
  }

  #row(term: string, value: string, tone?: Tone): void {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    if (tone) dd.className = tone
    this.#report.append(dt, dd)
  }
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = cls
  el.textContent = text
  return el
}

function must(doc: Document, id: string): HTMLElement {
  const el = doc.getElementById(id)
  if (el === null) throw new Error(`index.html is missing #${id}`)
  return el
}
