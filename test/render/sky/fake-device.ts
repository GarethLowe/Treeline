/**
 * A recording stand-in for `GPUDevice`, so the sky renderer and the environment lighting can be
 * exercised on the CLI without a browser or an adapter.
 *
 * It is NOT a WebGPU implementation and does not pretend to validate anything the real backend
 * would. What it does is record what the classes ask for — buffer sizes, bind group entries,
 * compute dispatch shapes, queue writes — which is exactly what the amortisation logic and the
 * buffer layouts need to be tested on. Shader compilation and pixel output are the integrator's
 * in-browser smoke test; everything upstream of them is checkable here.
 *
 * The WebGPU flag namespaces (`GPUBufferUsage` and friends) are runtime globals in a browser and
 * only types under @webgpu/types, so they are installed on `globalThis` here.
 */

export interface RecordedBuffer {
  readonly label: string
  readonly size: number
  readonly usage: number
  destroyed: boolean
}

export interface RecordedWrite {
  readonly target: RecordedBuffer
  readonly offset: number
  readonly byteLength: number
}

export interface RecordedDispatch {
  readonly label: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly pipeline: string
}

export interface RecordedDraw {
  readonly pipeline: string
  readonly vertexCount: number
  readonly bindGroups: number[]
}

export interface FakeGpu {
  readonly device: GPUDevice
  readonly buffers: RecordedBuffer[]
  readonly writes: RecordedWrite[]
  readonly dispatches: RecordedDispatch[]
  readonly draws: RecordedDraw[]
  readonly shaderSources: string[]
  readonly textures: { label: string; mipLevelCount: number; format: string; layers: number }[]
  readonly renderPipelines: string[]
  readonly computePipelines: string[]
  newEncoder(): GPUCommandEncoder
  newRenderPass(): GPURenderPassEncoder
  reset(): void
}

function installGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>
  g['GPUBufferUsage'] ??= {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  }
  g['GPUTextureUsage'] ??= {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  }
  g['GPUShaderStage'] ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
  g['GPUMapMode'] ??= { READ: 1, WRITE: 2 }
}

export function createFakeGpu(): FakeGpu {
  installGlobals()

  const buffers: RecordedBuffer[] = []
  const writes: RecordedWrite[] = []
  const dispatches: RecordedDispatch[] = []
  const draws: RecordedDraw[] = []
  const shaderSources: string[] = []
  const textures: { label: string; mipLevelCount: number; format: string; layers: number }[] = []
  const renderPipelines: string[] = []
  const computePipelines: string[] = []

  const device = {
    createBuffer(desc: GPUBufferDescriptor) {
      const rec: RecordedBuffer = {
        label: desc.label ?? '',
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
      }
      buffers.push(rec)
      return {
        __rec: rec,
        size: desc.size,
        usage: desc.usage,
        label: desc.label ?? '',
        destroy() {
          rec.destroyed = true
        },
      }
    },
    createTexture(desc: GPUTextureDescriptor) {
      const size = desc.size as { width: number; height: number; depthOrArrayLayers?: number }
      textures.push({
        label: desc.label ?? '',
        mipLevelCount: desc.mipLevelCount ?? 1,
        format: String(desc.format),
        layers: size.depthOrArrayLayers ?? 1,
      })
      return {
        label: desc.label ?? '',
        createView(viewDesc?: GPUTextureViewDescriptor) {
          return { __view: viewDesc ?? {}, label: desc.label ?? '' }
        },
        destroy() {},
      }
    },
    createSampler(desc?: GPUSamplerDescriptor) {
      return { __sampler: desc ?? {} }
    },
    createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) {
      return { __layout: desc }
    },
    createBindGroup(desc: GPUBindGroupDescriptor) {
      return { __bindGroup: desc, label: desc.label ?? '' }
    },
    createPipelineLayout(desc: GPUPipelineLayoutDescriptor) {
      return { __pipelineLayout: desc }
    },
    createShaderModule(desc: GPUShaderModuleDescriptor) {
      shaderSources.push(desc.code)
      return { __module: desc.label ?? '' }
    },
    createRenderPipeline(desc: GPURenderPipelineDescriptor) {
      renderPipelines.push(desc.label ?? '')
      return { __pipeline: desc.label ?? '', __kind: 'render' }
    },
    createComputePipeline(desc: GPUComputePipelineDescriptor) {
      computePipelines.push(desc.label ?? '')
      return { __pipeline: desc.label ?? '', __kind: 'compute' }
    },
    queue: {
      writeBuffer(
        target: { __rec: RecordedBuffer },
        offset: number,
        data: ArrayBufferView | ArrayBuffer,
      ) {
        writes.push({
          target: target.__rec,
          offset,
          byteLength: 'byteLength' in data ? data.byteLength : 0,
        })
      },
      submit() {},
    },
  }

  function newEncoder(): GPUCommandEncoder {
    return {
      beginComputePass(desc?: GPUComputePassDescriptor) {
        let pipeline = ''
        return {
          setPipeline(p: { __pipeline: string }) {
            pipeline = p.__pipeline
          },
          setBindGroup() {},
          dispatchWorkgroups(x: number, y = 1, z = 1) {
            dispatches.push({ label: desc?.label ?? '', x, y, z, pipeline })
          },
          end() {},
        }
      },
    } as unknown as GPUCommandEncoder
  }

  function newRenderPass(): GPURenderPassEncoder {
    let pipeline = ''
    const bindGroups: number[] = []
    return {
      setPipeline(p: { __pipeline: string }) {
        pipeline = p.__pipeline
      },
      setBindGroup(index: number) {
        bindGroups.push(index)
      },
      draw(vertexCount: number) {
        draws.push({ pipeline, vertexCount, bindGroups: [...bindGroups] })
      },
      end() {},
    } as unknown as GPURenderPassEncoder
  }

  return {
    device: device as unknown as GPUDevice,
    buffers,
    writes,
    dispatches,
    draws,
    shaderSources,
    textures,
    renderPipelines,
    computePipelines,
    newEncoder,
    newRenderPass,
    reset() {
      writes.length = 0
      dispatches.length = 0
      draws.length = 0
    },
  }
}

/** A minimal `CameraState` for driving the sky pass. */
export function fakeCamera(): import('../../../src/contracts/render.ts').CameraState {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  return {
    position: [500, 2, 500] as unknown as readonly [
      import('../../../src/contracts/units.ts').Metres,
      import('../../../src/contracts/units.ts').Metres,
      import('../../../src/contracts/units.ts').Metres,
    ],
    forward: [0, 0, -1],
    up: [0, 1, 0],
    viewMatrix: identity,
    projMatrix: identity,
    viewProjMatrix: identity,
    invViewProjMatrix: identity,
    verticalFov: 1.0 as import('../../../src/contracts/units.ts').Radians,
    nearM: 0.1 as import('../../../src/contracts/units.ts').Metres,
    farM: 5000 as import('../../../src/contracts/units.ts').Metres,
    aspect: 16 / 9,
    frustumPlanes: new Float32Array(24),
  }
}
