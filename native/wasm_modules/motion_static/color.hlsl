// debug.motion_static — color pass.
//
// Reads tex_in. For each pixel, computes the motion vector via the
// shared `ms_motion_at` and (optionally) blends an HSV-polar
// visualization of that vector over the input. Pixels with no motion
// (below threshold) get the input verbatim — opacity only modulates
// the color contribution at moving pixels.
//
// The motion pass writes the same vectors at full strength regardless
// of opacity, so consumers like motion_blur observe the underlying
// background even when the visualization is hidden.

#include "common.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float threshold;
  float swirl;
  float jitter;
  float seed;
  float opacity;
  float vis_scale;
  float _pad0;
  float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 base = inputTex[gid.xy];
  float2 v = ms_motion_at(gid.xy, float2(w, h), threshold, swirl, jitter, seed);

  // Pixels with zero motion (below threshold) blend with zero
  // contribution — they pass through whatever opacity is set to.
  float3 vis = ms_motion_to_color(v, vis_scale);
  // Use the visualization brightness as the "is there a vector here"
  // signal — pixels with magnitude zero produce val=0, so the
  // visualization contributes nothing even at opacity=1. This means
  // opacity controls "how visible are the dots that ARE moving."
  float vis_alpha = saturate(opacity * saturate(length(v) * vis_scale));
  float3 rgb = lerp(base.rgb, vis, vis_alpha);
  outputTex[gid.xy] = float4(rgb, base.a);
}
