// filter.reconstruct.line — pass 6: reconstruction + composite (STAGE 1 skeleton).
//
// Final version reads the analysis textures (stats, pyramid wide level, smoothed
// features M*/S*, colour blurs) and repaints crisp lines/points + deband, gated
// and hierarchically composited (strength enters ONLY here). For now it is a
// passthrough so the effect registers, builds, and proves the identity plumbing;
// each pass is added incrementally (see the staged plan).

#include "common.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);
cbuffer Uniforms : register(b2) { LRUniforms u; };

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  // strength referenced so the cbuffer binding survives naga pruning; the real
  // strength-driven composite lands with the line/point/deband branches.
  float3 outrgb = lerp(c.rgb, c.rgb, saturate(u.strength));
  outputTex[gid.xy] = float4(outrgb, c.a);
}
