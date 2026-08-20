/**
 * WGSL source assembly and the shared bind group layout for the sky uniform block.
 *
 * WGSL has no preprocessor and no include mechanism, so the shared sky evaluation is prepended
 * textually. Doing it here — once, in one function — is what stops the full-screen pass and the
 * environment capture from acquiring two subtly different copies of the model.
 */

import skyCommonSrc from '../../../shaders/sky/sky_common.wgsl?raw'
import skyPassSrc from '../../../shaders/sky/sky.wgsl?raw'
import envCaptureSrc from '../../../shaders/sky/env_capture.wgsl?raw'
import envPrefilterSrc from '../../../shaders/sky/env_prefilter.wgsl?raw'

/** Raw sources, exported for the structural tests that check them against the TS packing code. */
export const SKY_COMMON_WGSL = skyCommonSrc
export const SKY_PASS_WGSL = skyPassSrc
export const ENV_CAPTURE_WGSL = envCaptureSrc
export const ENV_PREFILTER_WGSL = envPrefilterSrc

/** Full-screen sky pass source, with the shared block prepended. */
export function skyPassSource(): string {
  return `${skyCommonSrc}\n${skyPassSrc}`
}

/** Environment cube capture source, with the shared block prepended. */
export function envCaptureSource(): string {
  return `${skyCommonSrc}\n${envCaptureSrc}`
}

/** Specular prefilter source. Standalone: it never evaluates the sky model. */
export function envPrefilterSource(): string {
  return envPrefilterSrc
}

/**
 * Layout of the sky uniform block (group 0, binding 0). Shared by the full-screen pass and the
 * environment capture so the same packed buffer can be bound to either.
 */
export function createSkyUniformBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'sky-uniforms',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
    ],
  })
}
