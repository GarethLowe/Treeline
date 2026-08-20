/**
 * Headless real-GPU runner. CLEANUP-SPEC 1.11.
 *
 * The problem this solves: the only way to find out whether this app actually renders was to
 * ask the owner to look. Vitest has no WebGPU, and the in-app browser pane does not composite,
 * so `requestAnimationFrame` never fires there and no frame-loop bug can reproduce. Four real
 * bugs have shipped through a green suite, and the black screen of 2026-08-20 shipped through
 * a green suite AND a clean `?debug` AND a clean shader-compilation audit, because the failure
 * was an invalid *pipeline* reported only as a console warning.
 *
 * So: drive a real Chrome over the DevTools Protocol. Headless Chrome composites, which means
 * rAF fires and frames really are produced. Console output — including the GPU validation
 * warnings Chrome emits for invalid pipelines — comes back over `Log.entryAdded`.
 *
 * No dependency: Node 22 has a global `WebSocket` and `fetch`, and CDP is a JSON protocol over
 * one socket. A puppeteer install for this would be several hundred megabytes to do what 150
 * lines already do.
 *
 * ## Usage
 *
 *   node scripts/headless.mjs <url> [options]
 *     --wait <js>       poll this expression until truthy (default: boot finished)
 *     --timeout <ms>    how long to poll for (default 300000)
 *     --eval <js>       evaluate after the wait and print the result
 *     --shot <path>     write a PNG screenshot
 *     --quiet           only print errors and the eval result
 *
 * ## What its numbers are worth
 *
 * FUNCTIONAL results are trustworthy: what rendered, what the probes measured, what Chrome
 * complained about. TIMINGS ARE NOT — the adapter this picks is whatever Chrome selects, which
 * on this machine is the Intel iGPU (crbug 369219127), so every frame time is ~10x off. The
 * adapter is printed on every run so that is never in doubt. Real numbers need the owner's own
 * Chrome; see CLAUDE.md.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env['LOCALAPPDATA'] ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

// Per-process port. A fixed one silently ATTACHES TO A STALE BROWSER when a previous run has
// not exited yet — which shows up as "NO ADAPTER" and a timeout, i.e. looking exactly like a
// broken app rather than a broken runner.
const PORT = 9300 + (process.pid % 600)

function parseArgs(argv) {
  const out = { url: argv[0], timeout: 300_000, quiet: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quiet') out.quiet = true
    else if (a === '--wait') out.wait = argv[++i]
    else if (a === '--eval') out.evaluate = argv[++i]
    else if (a === '--shot') out.shot = argv[++i]
    else if (a === '--timeout') out.timeout = Number(argv[++i])
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is not listening yet.
    }
    await sleep(150)
  }
  throw new Error('Chrome never opened its debugging port')
}

/** Minimal CDP client: one socket, id-matched replies, event listeners. */
class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  listeners = []

  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      c.#ws.addEventListener('open', resolve, { once: true })
      c.#ws.addEventListener('error', reject, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (msg.id !== undefined) {
        const p = c.#pending.get(msg.id)
        c.#pending.delete(msg.id)
        if (p) (msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result))
      } else {
        for (const l of c.listeners) l(msg)
      }
    })
    return c
  }

  send(method, params = {}) {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      completions: false,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw')
    }
    return r.result?.value
  }

  close() {
    this.#ws.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.url) {
    console.error('usage: node scripts/headless.mjs <url> [--wait js] [--eval js] [--shot out.png]')
    process.exit(2)
  }

  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!chrome) throw new Error(`no Chrome found; looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

  const profile = mkdtempSync(join(tmpdir(), 'ff-headless-'))
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // WebGPU. Without a GPU process there is no adapter and the app cannot boot at all.
      '--enable-unsafe-webgpu',
      '--use-angle=d3d11',
      '--disable-gpu-sandbox',
      // New headless composites, but these make it deterministic enough to screenshot.
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--window-size=1280,720',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const cleanup = () => {
    try {
      proc.kill()
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }
  process.on('exit', cleanup)

  const wsUrl = await waitForPort(20_000)
  const cdp = await Cdp.connect(wsUrl)

  const console_ = []
  cdp.listeners.push((msg) => {
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      console_.push({ level: e.level, text: e.text })
      if (e.level === 'error' || e.level === 'warning') {
        if (!args.quiet || e.level === 'error') console.log(`[${e.level}] ${e.text}`)
      }
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      console_.push({ level: msg.params.type, text })
      if (msg.params.type === 'error' || msg.params.type === 'warning') {
        console.log(`[console.${msg.params.type}] ${text}`)
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log(`[exception] ${d.exception?.description ?? d.text}`)
      console_.push({ level: 'error', text: d.exception?.description ?? d.text })
    }
  })

  await cdp.send('Log.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: args.url })

  // Default wait: the boot screen has hidden itself, i.e. a frame really rendered.
  const waitExpr =
    args.wait ?? "(() => document.getElementById('boot')?.hidden === true)()"
  const deadline = Date.now() + args.timeout
  let ready = false
  let lastPhase = ''
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(waitExpr)) {
        ready = true
        break
      }
      if (!args.quiet) {
        const phase = await cdp.evaluate(
          "document.getElementById('boot-phase')?.innerText ?? ''",
        )
        if (phase && phase !== lastPhase) {
          lastPhase = phase
          console.log(`… ${phase}`)
        }
      }
    } catch {
      // Navigation in flight; the document is not there yet.
    }
    await sleep(1000)
  }

  const adapter = await cdp
    .evaluate(
      `(async () => { const a = await navigator.gpu?.requestAdapter?.(); if (!a) return 'NO ADAPTER';
        const i = a.info ?? {}; return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / ') || '(unreported)'; })()`,
    )
    .catch(() => '(query failed)')
  console.log(`adapter          ${adapter}`)
  if (adapter === 'NO ADAPTER') {
    console.log('  ^ Chrome gave no WebGPU adapter. That is a RUNNER problem, not an app one:')
    console.log('    usually a stale chrome.exe still holding the GPU process. Kill it and retry.')
  }
  console.log(`ready            ${ready}${ready ? '' : ' — TIMED OUT'}`)

  if (args.evaluate) {
    const value = await cdp.evaluate(args.evaluate)
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }

  if (args.shot) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(args.shot, Buffer.from(data, 'base64'))
    console.log(`screenshot       ${args.shot}`)
  }

  const errors = console_.filter((c) => c.level === 'error')
  const warnings = console_.filter((c) => c.level === 'warning')
  console.log(`console          ${errors.length} error(s), ${warnings.length} warning(s)`)

  cdp.close()
  cleanup()
  process.exit(ready && errors.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
