// Pass 1 of 3 — classify.
//
// One invocation per tree instance: frustum-cull it, pick its LOD (possibly two during a
// cross-fade), reserve record slots, and accumulate the per-bucket counts the scan pass will
// turn into indirect draw arguments.
//
// Hi-Z occlusion culling (spec §7.4) is NOT implemented here. It needs the previous frame's
// depth pyramid, which does not exist until the depth prepass lands, and a half-built
// occlusion test that silently rejects visible trees is far worse than none. The classify
// pass is structured so it drops in as one extra test after the frustum test.

fn emit(instanceIndex: u32, meshId: u32, lod: u32, weight: f32) {
  let b = bucketIndex(meshId, lod);
  if (b >= cullU.bucketCount) {
    atomicAdd(&control[STATS_CLAMP_EVENTS], 1u);
    return;
  }
  let slot = atomicAdd(&control[CONTROL_OFF_RECORD_COUNT], 1u);
  if (slot >= cullU.compactedCapacity) {
    // Reserved past the end. Nothing is written and the bucket count is not incremented, so
    // the draw arguments stay consistent with what is actually in the compacted list.
    atomicAdd(&control[STATS_CLAMP_EVENTS], 1u);
    return;
  }
  records[slot] = vec2<u32>(b, packCompacted(instanceIndex, weight));
  atomicAdd(&control[countsIndex(b)], 1u);
  atomicAdd(&control[STATS_RECORDS_APPENDED], 1u);
  atomicAdd(&control[STATS_TRIANGLES], meshTable[b].triangleCount);
}

@compute @workgroup_size(CULL_WG)
fn classify(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let i = flatIndex(gid, nwg, CULL_WG);
  if (i >= cullU.instanceCount) {
    return;
  }

  let inst = instances[i];
  let centre = vec3<f32>(inst.posX, inst.posY + 0.5 * inst.heightM, inst.posZ);
  let radius = inst.cullRadiusM * cullU.cullRadiusScale;

  if (!sphereInFrustum(centre, radius)) {
    atomicAdd(&control[STATS_TREES_CULLED], 1u);
    return;
  }
  atomicAdd(&control[STATS_TREES_VISIBLE], 1u);

  let dist = distance(centre, frame.cameraPos);
  let hPx = projectedHeightPx(inst.heightM, dist, cullU.ppm);
  let pick = pickLod(hPx, cullU.lodThresholdPx, cullU.fadeFraction);

  emit(i, inst.meshId, pick.lodA, pick.weightA);
  if (pick.count > 1u) {
    emit(i, inst.meshId, pick.lodB, pick.weightB);
  }
}
