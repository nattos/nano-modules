// color.tone.auto_level — pass 2: luminance histogram over the SN×SN grid.
//
// Buckets input luminance into NB bins across [lo, hi] (from pass 1) via atomic
// add. Runs after minmax in the same submit, so the lo/hi writes are visible.

#include "common.hlsl"

Texture2D<float4>       inputTex : register(t1);
RWStructuredBuffer<int> stats    : register(u2);   // [0]=lo, [1]=hi, [2..]=hist[NB]

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= AL_SN || gid.y >= AL_SN) return;
  float L = max(nano_luminance(inputTex[al_grid_to_pixel(gid.xy)].rgb), 0.0);
  float lo = asfloat(stats[0]);
  float hi = asfloat(stats[1]);
  int bin = nano_hist_bin(L, lo, hi);
  int prev;
  InterlockedAdd(stats[2 + bin], 1, prev);
}
