// debug.atomic_test pass 1 — counts pixels above a luminance threshold
// using InterlockedAdd into a shared 4-bin histogram. Each pixel atomically
// increments a single 32-bit bin selected by floor(luma * 4).

#include "nano_color.hlsl"

Texture2D<float4> inputTex : register(t0);
RWStructuredBuffer<int> bins : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  inputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float4 c = inputTex[gid.xy];
  float luma = nano_luminance(saturate(c.rgb));
  int bin = (int)clamp(luma * 4.0, 0.0, 3.999);
  int unused;
  InterlockedAdd(bins[bin], 1, unused);
}
