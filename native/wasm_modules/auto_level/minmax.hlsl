// color.tone.auto_level — pass 1: luminance min/max over the SN×SN grid.
//
// Atomic min/max of input luminance into a stats buffer. Luminance ≥ 0, so the
// IEEE bit pattern (asint) orders the same as the float. Reset on the CPU each
// frame to (lo = +INF-ish, hi = 0).

#include "common.hlsl"

Texture2D<float4>       inputTex : register(t1);
RWStructuredBuffer<int> stats    : register(u2);   // [0]=lo(asint), [1]=hi(asint), [2..]=hist

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= AL_SN || gid.y >= AL_SN) return;
  float L = max(nano_luminance(inputTex[al_grid_to_pixel(gid.xy)].rgb), 0.0);
  int bits = asint(L);
  int prev;
  InterlockedMin(stats[0], bits, prev);
  InterlockedMax(stats[1], bits, prev);
}
