// Pass 2 of 3 — bucket scan, subgroup path.
//
// The exclusive prefix sum over per-thread totals is done with `subgroupExclusiveAdd`, then
// one serial pass over the (at most 64) subgroup totals. That removes the log2(SCAN_WG)
// barrier ladder the workgroup fallback needs: on a 32-wide subgroup this is 8 subgroup sums
// and one 8-element serial scan instead of 8 full workgroup barriers.
//
// The `subgroups` feature is confirmed granted on the target part. It is still optional in
// core WebGPU, so scanWorkgroup.wgsl is compiled instead when it is absent — the renderer
// chooses at pipeline creation and the rest of the pipeline is identical.

// At most SCAN_WG / minimum-subgroup-size entries. The floor on subgroup size across known
// implementations is 4, so 64 covers a 256-thread workgroup with room to spare.
const MAX_SUBGROUPS: u32 = 64u;

var<workgroup> sgTotals: array<u32, MAX_SUBGROUPS>;
var<workgroup> sgOffsets: array<u32, MAX_SUBGROUPS>;

@compute @workgroup_size(SCAN_WG)
fn scan(
  @builtin(local_invocation_index) tid: u32,
  @builtin(subgroup_size) sgSize: u32,
  @builtin(subgroup_invocation_id) sgLane: u32,
) {
  let localTotal = bucketLocalTotal(tid);

  // Both subgroup calls sit in uniform control flow, which they require.
  let sgExclusive = subgroupExclusiveAdd(localTotal);
  let sgSum = subgroupAdd(localTotal);

  let sgIndex = tid / max(sgSize, 1u);
  if (sgLane == 0u && sgIndex < MAX_SUBGROUPS) {
    sgTotals[sgIndex] = sgSum;
  }
  workgroupBarrier();

  if (tid == 0u) {
    let subgroupCount = min((SCAN_WG + sgSize - 1u) / max(sgSize, 1u), MAX_SUBGROUPS);
    var running = 0u;
    for (var i = 0u; i < subgroupCount; i = i + 1u) {
      sgOffsets[i] = running;
      running = running + sgTotals[i];
    }
  }
  workgroupBarrier();

  let base = select(0u, sgOffsets[sgIndex], sgIndex < MAX_SUBGROUPS) + sgExclusive;
  scanTail(tid, base);
}
