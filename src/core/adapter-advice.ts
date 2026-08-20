/**
 * What to tell the user when WebGPU handed back the wrong GPU — work package 1.1.
 *
 * Spec §6.8 pitfall 1 requires three things when the selected adapter looks integrated:
 * pass `powerPreference: 'high-performance'` anyway (done in `device.ts`), *show a blocking
 * modal with the three fixes*, and never silently run at 6 fps and let the user conclude
 * the simulation is slow.
 *
 * This module owns the second of those as **data**, not as DOM. The UI package renders it;
 * the boot path decides when. Keeping it here means the condition that produces the advice
 * and the advice itself cannot drift apart, and it keeps the strings out of a work package
 * that has no way to know why they exist.
 */

import type { AdapterReport } from '@contracts/gpu'

export interface Remedy {
  readonly title: string
  readonly detail: string
  /** A `chrome://` URL the user must paste themselves — pages cannot navigate to these. */
  readonly url?: string
}

/**
 * The three fixes, in the order most likely to work on the target machine.
 *
 * Chrome's own documentation states that it "always uses the same GPU adapter that's been
 * allocated for other Chrome workloads, which for laptops is generally the integrated
 * graphics card", and that `powerPreference: 'high-performance'` "doesn't have any impact
 * when calling requestAdapter()" on Windows. So every one of these is an action outside the
 * page: nothing the application can do at runtime changes the selection.
 */
export const HYBRID_GPU_REMEDIES: readonly Remedy[] = [
  {
    title: 'Force the high-performance GPU in Chrome',
    detail:
      'Open chrome://flags, set "Choose the high-performance GPU by default on dual-GPU ' +
      'systems" (#force-high-performance-gpu) to Enabled, and relaunch the browser.',
    url: 'chrome://flags/#force-high-performance-gpu',
  },
  {
    title: 'Set the Windows graphics preference for the browser',
    detail:
      'Windows Settings > System > Display > Graphics, add or select chrome.exe (or ' +
      'msedge.exe), choose Options, and set it to High performance. Then restart the browser.',
  },
  {
    title: 'Set the NVIDIA per-application preference',
    detail:
      'NVIDIA Control Panel > Manage 3D settings > Program Settings, add the browser, and ' +
      'set "Preferred graphics processor" to "High-performance NVIDIA processor".',
  },
]

export interface AdapterAdvice {
  /** True when the app should refuse to start quietly and put this in front of the user. */
  readonly blocking: boolean
  readonly headline: string
  readonly body: string
  readonly remedies: readonly Remedy[]
}

/**
 * Turn an {@link AdapterReport} into the message the boot path shows.
 *
 * Three distinct states, because they need three different responses:
 *
 * - **Integrated adapter** — blocking. The expected outcome is roughly 1/8 the compute and
 *   1/4 the bandwidth of the target part; every frame time measured in this state is
 *   meaningless, and a user who does not know they are on the iGPU will report the
 *   simulation as broken.
 * - **Discrete adapter with limit shortfalls** — not blocking. The capability-tier
 *   fallbacks handle it; the shortfall list is recorded so a later performance number can
 *   be read in context.
 * - **Everything granted** — not blocking, and still reported, because "which adapter did
 *   we actually get" is the first question asked of any timing figure this project records.
 */
export function adapterAdvice(report: AdapterReport): AdapterAdvice {
  const name =
    [report.vendor, report.architecture, report.device].filter((s) => s.length > 0).join(' / ') ||
    report.description ||
    '(unreported)'

  if (report.looksIntegrated) {
    return {
      blocking: true,
      headline: 'ForestFire selected an integrated GPU',
      body:
        `WebGPU handed back "${name}", which looks like an integrated adapter. On this ` +
        'class of machine that is roughly one eighth of the compute and one quarter of the ' +
        'memory bandwidth of the discrete GPU, so the simulation will run at a few frames ' +
        'per second. This is a browser/driver selection problem, not a limit of the ' +
        'simulation, and the page cannot change it from here.',
      remedies: HYBRID_GPU_REMEDIES,
    }
  }

  if (report.limitShortfalls.length > 0) {
    const worst = report.limitShortfalls
      .map((s) => `${s.limit} (wanted ${s.wanted}, adapter caps at ${s.got})`)
      .join('; ')
    return {
      blocking: false,
      headline: `Running on ${name} with reduced limits`,
      body:
        'The adapter could not grant every requested limit, so the affected subsystems use ' +
        `their documented fallback paths: ${worst}.`,
      remedies: [],
    }
  }

  return {
    blocking: false,
    headline: `Running on ${name}`,
    body: 'All requested limits and features were granted.',
    remedies: [],
  }
}

/** Features that were asked for and refused. Empty on the target configuration. */
export function missingFeatures(report: AdapterReport): string[] {
  const granted = new Set<string>(report.grantedFeatures)
  return ['timestamp-query', 'float32-filterable', 'shader-f16', 'subgroups'].filter(
    (f) => !granted.has(f),
  )
}
