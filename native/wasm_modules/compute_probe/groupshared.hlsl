// debug.compute_probe case 0 — workgroup (groupshared) memory.
//
// A 32x4 = 128-thread group — deliberately NOT 8x8, so a backend that ignores
// [numthreads] (MSL carries it only as the `nano_threadgroup` hint) runs the
// wrong group shape: half the shared slots stay unwritten, the OR-mask is
// incomplete, and the dispatch covers the wrong pixels. Every pixel of a
// correct run is green; anything else is red or black.
groupshared uint g_vals[128];
groupshared uint g_mask[4];

RWTexture2D<float4> outTex : register(u0);

[numthreads(32, 4, 1)]
void main(uint3 gid : SV_DispatchThreadID, uint li : SV_GroupIndex) {
  if (li < 4u) g_mask[li] = 0u;
  g_vals[li] = li * 3u + 1u;
  GroupMemoryBarrierWithGroupSync();

  uint prior;
  InterlockedOr(g_mask[li >> 5], 1u << (li & 31u), prior);
  GroupMemoryBarrierWithGroupSync();

  uint mirror = 127u - li;
  bool ok = g_vals[mirror] == mirror * 3u + 1u &&
            g_mask[0] == 0xffffffffu && g_mask[1] == 0xffffffffu &&
            g_mask[2] == 0xffffffffu && g_mask[3] == 0xffffffffu;

  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outTex[gid.xy] = ok ? float4(0.0, 1.0, 0.0, 1.0) : float4(1.0, 0.0, 0.0, 1.0);
}
