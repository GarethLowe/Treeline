// Pass 2 of 3 — bucket scan, portable path.
//
// Hillis-Steele inclusive scan in workgroup memory, converted to exclusive by subtracting the
// thread's own value. Used when the `subgroups` feature is absent. Same results as the
// subgroup path, bit for bit — it is an integer sum, so there is no reassociation error to
// worry about.

var<workgroup> partials: array<u32, SCAN_WG>;

@compute @workgroup_size(SCAN_WG)
fn scan(@builtin(local_invocation_index) tid: u32) {
  let localTotal = bucketLocalTotal(tid);
  partials[tid] = localTotal;
  workgroupBarrier();

  for (var offset = 1u; offset < SCAN_WG; offset = offset << 1u) {
    var addend = 0u;
    if (tid >= offset) {
      addend = partials[tid - offset];
    }
    workgroupBarrier();
    if (tid >= offset) {
      partials[tid] = partials[tid] + addend;
    }
    workgroupBarrier();
  }

  scanTail(tid, partials[tid] - localTotal);
}
