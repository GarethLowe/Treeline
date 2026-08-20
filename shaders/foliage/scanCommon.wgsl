// Pass 2 of 3 — bucket scan, shared body.
//
// Turns the per-bucket counts the classify pass accumulated into (a) bucket base offsets in
// the compacted list and (b) the indirect draw arguments. MAX_BUCKETS is fixed and small, so
// this is a single workgroup of SCAN_WG threads handling BUCKETS_PER_SCAN_THREAD buckets
// each — no multi-level scan, no second dispatch, no round trip to the CPU.
//
// Two entry points exist (scanSubgroup.wgsl / scanWorkgroup.wgsl) and share everything below.

fn bucketLocalTotal(tid: u32) -> u32 {
  var total = 0u;
  let first = tid * BUCKETS_PER_SCAN_THREAD;
  for (var k = 0u; k < BUCKETS_PER_SCAN_THREAD; k = k + 1u) {
    let b = first + k;
    if (b < cullU.bucketCount) {
      total = total + atomicLoad(&control[countsIndex(b)]);
    }
  }
  return total;
}

// `threadBase` is the exclusive prefix sum of the per-thread totals.
fn scanTail(tid: u32, threadBase: u32) {
  var running = threadBase;
  let first = tid * BUCKETS_PER_SCAN_THREAD;
  for (var k = 0u; k < BUCKETS_PER_SCAN_THREAD; k = k + 1u) {
    let b = first + k;
    if (b >= cullU.bucketCount) {
      continue;
    }
    var count = atomicLoad(&control[countsIndex(b)]);
    // The classify pass already refuses to append past capacity, so this can only fire if a
    // caller mis-sized the buffers. Clamp and record it rather than emitting a draw whose
    // instance range runs off the end of the compacted list.
    if (running + count > cullU.compactedCapacity) {
      count = select(0u, cullU.compactedCapacity - running, cullU.compactedCapacity > running);
      atomicAdd(&control[STATS_CLAMP_EVENTS], 1u);
    }
    atomicStore(&control[basesIndex(b)], running);
    atomicStore(&control[cursorsIndex(b)], 0u);

    let entry = meshTable[b];
    let o = b * 5u;
    drawArgs[o + 0u] = entry.indexCount;
    drawArgs[o + 1u] = count;
    drawArgs[o + 2u] = entry.firstIndex;
    drawArgs[o + 3u] = entry.baseVertex;
    // firstInstance stays 0: the `indirect-first-instance` feature is granted on the target
    // part but nothing here needs it, and the per-bucket base is read from the control
    // buffer inside the vertex shader instead.
    drawArgs[o + 4u] = 0u;

    running = running + count;
  }
}
