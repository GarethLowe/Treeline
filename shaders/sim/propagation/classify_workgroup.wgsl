// Tile compaction, fallback path — spec §6.4.
//
// One `atomicAdd` per workgroup via a workgroup-shared counter. Costs about 2 us more than
// the subgroup ballot at 16,384 tiles and needs no optional feature. The order tiles land in
// the list differs from the subgroup path; the SET is identical, and order does not matter
// because each tile is dispatched independently.
//
// Assembled after propagation.wgsl, which declares the bindings and `tileActive`.

var<workgroup> wgCount: atomic<u32>;
var<workgroup> wgBase: u32;

@compute @workgroup_size(CLASSIFY_WG)
fn tileClassifyWorkgroup(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  if (lid == 0u) { atomicStore(&wgCount, 0u); }
  workgroupBarrier();

  let tid = gid.x;
  var isActive = false;
  if (tid < params.tileCount) { isActive = tileActive(tid); }
  var local = 0u;
  if (isActive) { local = atomicAdd(&wgCount, 1u); }
  workgroupBarrier();

  if (lid == 0u) { wgBase = atomicAdd(&control.tileCount, atomicLoad(&wgCount)); }
  workgroupBarrier();

  if (isActive) {
    let slot = wgBase + local;
    if (slot < arrayLength(&tileList)) { tileList[slot] = tid; }
  }
}
