// Pass 3 of 3 — scatter.
//
// Writes each classified record into its bucket's contiguous run of the compacted list. One
// atomic per record on a per-bucket cursor; the resulting order within a bucket is arbitrary,
// which is fine because every instance in a bucket shares one draw.
//
// Dispatched over the record CAPACITY rather than the record count, because the count only
// exists on the GPU. An indirect dispatch would avoid the wasted invocations, but an indirect
// workgroup count that exceeds maxComputeWorkgroupsPerDimension is silently skipped in its
// entirety by WebGPU, and trading "a few thousand invocations that return immediately" for
// "a pass that sometimes does not run at all" is not a trade worth making.

@compute @workgroup_size(CULL_WG)
fn scatter(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let i = flatIndex(gid, nwg, CULL_WG);
  let written = min(atomicLoad(&control[CONTROL_OFF_RECORD_COUNT]), cullU.compactedCapacity);
  if (i >= written) {
    return;
  }

  let rec = records[i];
  let b = rec.x;
  if (b >= cullU.bucketCount) {
    return;
  }
  let slot = atomicAdd(&control[cursorsIndex(b)], 1u);
  // The scan may have clamped this bucket's instance count below the number of records that
  // reached it. Without this test the surplus records would spill into the NEXT bucket's run
  // and draw the wrong trees with the wrong mesh — a corruption, not a dropped instance.
  if (slot >= drawArgs[b * 5u + 1u]) {
    atomicAdd(&control[STATS_CLAMP_EVENTS], 1u);
    return;
  }
  let dst = atomicLoad(&control[basesIndex(b)]) + slot;
  if (dst >= cullU.compactedCapacity) {
    atomicAdd(&control[STATS_CLAMP_EVENTS], 1u);
    return;
  }
  compacted[dst] = rec.y;
}
