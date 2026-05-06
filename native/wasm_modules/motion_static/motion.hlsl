// debug.motion_static — motion pass.
//
// Computes the same per-pixel velocity as the colour pass and writes
// it directly into the rgba16float motion texture. Below-threshold
// pixels emit (0, 0, 0, 0), giving the downstream consumer a sparse
// motion field that's perfect for stress-testing the McGuire
// reconstruction's tile-based velocity reduction.

#include "common.hlsl"

RWTexture2D<float4> motionTex : register(u0);

cbuffer Uniforms : register(b1) {
  float threshold;
  float swirl;
  float jitter;
  float seed;
  // Below: ignored by motion pass. Layout MUST match color.hlsl so a
  // single CPU-side uniform buffer binds cleanly into both shaders.
  float _pad_opacity;
  float _pad_vis_scale;
  float _pad0;
  float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 v = ms_motion_at(gid.xy, float2(w, h), threshold, swirl, jitter, seed);
  motionTex[gid.xy] = float4(v.x, v.y, 0.0, 0.0);
}
