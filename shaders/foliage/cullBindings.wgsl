// Bindings shared by the three tree-cull compute passes (classify, scan, scatter).
//
// One bind group layout for all three keeps the encode path to three setPipeline calls and
// one setBindGroup, and means a buffer cannot accidentally be bound differently between
// passes that must agree on its contents.
//
// SIX storage buffers, not ten. Core WebGPU allows only 8 per shader stage, and the obvious
// arrangement — separate buffers for stats, the record counter, and the per-bucket counts,
// cursors and bases — blows through it and fails bind group layout creation. They share the
// `control` buffer instead; see src/render/foliage/layout.ts for its map.

@group(1) @binding(0) var<uniform> cullU: CullUniform;
@group(1) @binding(1) var<storage, read> instances: array<TreeInstance>;
@group(1) @binding(2) var<storage, read> meshTable: array<MeshEntry>;
// (bucketIndex, packedCompacted) per appended record.
@group(1) @binding(3) var<storage, read_write> records: array<vec2<u32>>;
@group(1) @binding(4) var<storage, read_write> compacted: array<u32>;
@group(1) @binding(5) var<storage, read_write> drawArgs: array<u32>;
@group(1) @binding(6) var<storage, read_write> control: array<atomic<u32>>;

fn countsIndex(b: u32) -> u32 {
  return CONTROL_HEADER_U32S + b;
}

fn cursorsIndex(b: u32) -> u32 {
  return CONTROL_HEADER_U32S + cullU.bucketCount + b;
}

fn basesIndex(b: u32) -> u32 {
  return CONTROL_HEADER_U32S + 2u * cullU.bucketCount + b;
}

// Flat invocation index that stays correct if the CPU had to fold an oversized dispatch
// into Y. Indirect dispatches whose workgroup count exceeds maxComputeWorkgroupsPerDimension
// are silently skipped in their entirety by WebGPU — not clamped, not an error — so every
// dispatch in this package is sized on the CPU and every kernel reconstructs its index this
// way rather than assuming a 1-D grid.
fn flatIndex(gid: vec3<u32>, nwg: vec3<u32>, wgSize: u32) -> u32 {
  return gid.x + gid.y * (nwg.x * wgSize);
}
