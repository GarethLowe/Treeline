/**
 * `?debug` shader audit.
 *
 * Vitest runs under Node, which has no WebGPU, so no WGSL in this project ever reaches a
 * compiler during `npm test` — four real bugs have shipped through a green suite that way.
 * The only compiler that ever sees these shaders is the browser's, at boot.
 *
 * So record every module the boot path creates and ask each one what the compiler said.
 * `createShaderModule` never throws: WGSL errors surface through `getCompilationInfo()` and
 * through the uncaptured-error handler, and a pipeline built on a broken module silently
 * discards the whole command buffer. This turns that into a line of text.
 *
 * Install before anything creates a pipeline — `main.ts` does it immediately after device
 * bring-up. Warnings are reported as well as errors; a WGSL warning is usually a real
 * portability problem (a reserved keyword that this backend happens to tolerate).
 *
 * **This also audits pipeline CREATION, and that half is not optional.** A shader can compile
 * perfectly and still produce an invalid pipeline — a binding declared FRAGMENT in the layout
 * and read from the vertex stage, a format mismatch, a missing entry point. The synchronous
 * `createRenderPipeline` does not throw for any of those: it returns an INVALID pipeline and
 * emits a console *warning*, every draw using it is silently dropped, and the whole command
 * buffer goes with it. That exact bug turned the screen black with a green test suite, an
 * empty `gpuErrors`, and all eight boot stages reporting success. Compilation-only auditing
 * did not catch it because nothing was wrong with the WGSL.
 */

interface Recorded {
  readonly label: string
  readonly module: GPUShaderModule
}

const recorded: Recorded[] = []

/** Pipelines whose creation failed validation. Empty is the only acceptable state. */
export const pipelineErrors: string[] = []

function auditPipeline<D extends { label?: string | undefined }, P>(
  device: GPUDevice,
  create: (descriptor: D) => P,
  kind: string,
): (descriptor: D) => P {
  return (descriptor: D): P => {
    device.pushErrorScope('validation')
    const pipeline = create(descriptor)
    void device.popErrorScope().then((error) => {
      if (error === null) return
      const label = descriptor.label ?? '(unlabelled)'
      pipelineErrors.push(`${kind} '${label}': ${error.message.split(String.fromCharCode(10))[0] ?? ''}`)
      console.error(`INVALID ${kind} '${label}' — every draw using it will be dropped:`, error.message)
    })
    return pipeline
  }
}

/**
 * Wrap shader-module and pipeline creation so both are auditable.
 *
 * Installed unconditionally, not only under `?debug`: an invalid pipeline is a black screen
 * in the shipping path, and finding out about it requires the check to be running there.
 * The cost is one error scope per pipeline at boot, of which there are about thirty.
 */
export function installShaderAudit(device: GPUDevice): void {
  const originalModule = device.createShaderModule.bind(device)
  device.createShaderModule = (descriptor: GPUShaderModuleDescriptor): GPUShaderModule => {
    const module = originalModule(descriptor)
    recorded.push({ label: descriptor.label ?? '(unlabelled)', module })
    return module
  }
  // Only the SYNCHRONOUS variants need this. The `...Async` forms reject on failure, and the
  // boot stage that awaited them turns that into a visible failure already.
  device.createRenderPipeline = auditPipeline(
    device,
    device.createRenderPipeline.bind(device),
    'render pipeline',
  )
  device.createComputePipeline = auditPipeline(
    device,
    device.createComputePipeline.bind(device),
    'compute pipeline',
  )
}

/** One line per module, plus every compiler message. Errors first. */
export async function shaderAuditReport(): Promise<string> {
  if (recorded.length === 0) {
    return 'no shader modules recorded — installShaderAudit ran too late'
  }
  const lines: string[] = []
  let errors = 0
  let warnings = 0
  for (const { label, module } of recorded) {
    const info = await module.getCompilationInfo()
    const bad = info.messages.filter((m) => m.type !== 'info')
    errors += info.messages.filter((m) => m.type === 'error').length
    warnings += info.messages.filter((m) => m.type === 'warning').length
    lines.push(`${bad.length === 0 ? 'ok  ' : 'MSG '} ${label}`)
    for (const m of bad) {
      lines.push(`       ${m.type} ${m.lineNum}:${m.linePos}  ${m.message.trim()}`)
    }
  }
  const verdict =
    errors > 0
      ? `${errors} ERROR(S), ${warnings} warning(s)`
      : warnings > 0
        ? `no errors, ${warnings} warning(s)`
        : 'all modules compiled clean'
  const pipelines =
    pipelineErrors.length === 0
      ? 'all pipelines created clean'
      : `${pipelineErrors.length} INVALID PIPELINE(S) — every draw using them is dropped`
  return [
    `${recorded.length} shader modules compiled — ${verdict}`,
    `pipelines — ${pipelines}`,
    ...pipelineErrors.map((e) => `  ${e}`),
    '',
    ...lines,
  ].join('\n')
}
