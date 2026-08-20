/**
 * TS 5.7 made typed arrays generic over their backing buffer, so a bare `Float32Array` is
 * `Float32Array<ArrayBufferLike>` — which admits `SharedArrayBuffer`, which the WebGPU
 * typings reject. Handing over `view.buffer` with an explicit offset is exact; casting the
 * view itself would paper over a genuinely shared buffer.
 *
 * Nothing in this project allocates a `SharedArrayBuffer` (the COOP/COEP headers that would
 * make one available are not set), so the assertion is sound at every call site.
 */
export const rawBuffer = (view: ArrayBufferView): ArrayBuffer => view.buffer as ArrayBuffer
