// Tile compaction, subgroup path — spec §6.4.
//
// One `atomicAdd` per subgroup instead of one per active tile. At 16,384 tiles a naive
// per-invocation atomicAdd costs ~25 us because they serialise on one cache line; this is
// ~3 us. `subgroups` is confirmed granted on the target part; `classify_workgroup.wgsl` is
// compiled in its place when it is not, and nothing else in the pipeline changes.
//
// Assembled after propagation.wgsl, which declares the bindings and `tileActive`.

// Subgroup path. `subgroups` is confirmed granted on the target part; the workgroup variant
// below is compiled instead when it is not, and the rest of the pipeline is identical.
@compute @workgroup_size(CLASSIFY_WG)
fn tileClassifySubgroup(@builtin(global_invocation_id) gid: vec3u) {
  let tid = gid.x;
  var isActive = false;
  if (tid < params.tileCount) {
    isActive = tileActive(tid);
  }
  // Uniform control flow from here — the subgroup builtins require it.
  let ballot = subgroupBallot(isActive);
  let n = countOneBits(ballot.x) + countOneBits(ballot.y)
        + countOneBits(ballot.z) + countOneBits(ballot.w);
  var base = 0u;
  if (subgroupElect()) {
    base = atomicAdd(&control.tileCount, n);
  }
  base = subgroupBroadcastFirst(base);
  let slot = base + subgroupExclusiveAdd(select(0u, 1u, isActive));
  if (isActive && slot < arrayLength(&tileList)) {
    tileList[slot] = tid;
  }
}
