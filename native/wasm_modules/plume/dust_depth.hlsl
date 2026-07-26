// source.sdf.plume — dust splat pass 1: per-pixel nearest-particle depth.
//
// One thread per particle: project, then InterlockedMin(asuint(t)) over
// the disc footprint. Positive-float bit patterns order like the floats,
// so the uint min IS the depth min. Surface occlusion is resolved HERE
// (pixels where the surface is nearer never enter the buffer): occlusion
// along one ray is monotone in t, so pass 2 needs no scene read at all —
// a winning entry is a visible entry.

#define DUST_UB_REG b3
#include "dust_common.hlsl"

Texture2D<float4>        sceneTex : register(t1);   // .a = surface hit t
RWStructuredBuffer<uint> depthBuf : register(u2);

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= (uint)cam_p.w) return;
  float3 pos, nrm;
  float seed, t, rp;
  float2 ctr;
  if (!du_project(gid.x, pos, nrm, seed, ctr, t, rp)) return;

  int W = (int)vp.x, H = (int)vp.y;
  int x0 = max((int)floor(ctr.x - rp), 0);
  int x1 = min((int)floor(ctr.x + rp), W - 1);
  int y0 = max((int)floor(ctr.y - rp), 0);
  int y1 = min((int)floor(ctr.y + rp), H - 1);
  uint du = asuint(t);
  for (int py = y0; py <= y1; py++) {
    for (int px = x0; px <= x1; px++) {
      float2 d = float2(px, py) + 0.5 - ctr;
      if (dot(d, d) > rp * rp) continue;
      if (t >= sceneTex.Load(int3(px, py, 0)).a) continue;
      uint prev;
      InterlockedMin(depthBuf[py * W + px], du, prev);
    }
  }
}
