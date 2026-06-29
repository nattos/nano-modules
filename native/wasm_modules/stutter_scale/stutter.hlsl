// warp.legacy.stutter_scale — the per-step transform + grade pass.
//
// All the stutter SCHEDULING (quantizing a phase into discrete steps, re-rolling
// a seeded random transform per step) happens in main.cpp; this shader just
// applies the resolved transform for the current step: a centred scale + a
// jitter translation + optional Y-flip, then a contrast/brightness boost, a hue
// rotation, and an optional colour inversion — finally crossfaded with the
// untouched input by `intensity`. v2 of the Resolume Wire "Stutter Scale 2".

#include "nano_chroma.hlsl"

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float scale;       // zoom factor for this step (>1 = zoom in)
  float trans_x;     // jitter translation (uv)
  float trans_y;
  float flip_y;      // 0/1 — flip the sampled Y
  float hue_shift;   // radians
  float invert;      // 0/1 — invert RGB
  float bright;      // brightness add
  float contrast;    // contrast add (around mid-grey)
  float intensity;   // crossfade with the untouched input
  float alpha_scale; // output alpha multiplier (transparent endpoints)
  float _p0, _p1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  // Centred scale + jitter translation.
  float inv = (scale > 1e-4) ? (1.0 / scale) : 1.0;
  float2 src = (uv - 0.5) * inv + 0.5 + float2(trans_x, trans_y);
  if (flip_y > 0.5) src.y = 1.0 - src.y;

  float4 col = inputTex.SampleLevel(linearSampler, src, 0.0);

  // Contrast/brightness boost.
  col.rgb = (col.rgb - 0.5) * (1.0 + contrast) + 0.5 + bright;
  // Hue rotate.
  if (abs(hue_shift) > 1e-4) col.rgb = nano_shift_hue(col.rgb, hue_shift);
  // Colour inversion.
  if (invert > 0.5) col.rgb = 1.0 - col.rgb;
  col.rgb = saturate(col.rgb);

  // Crossfade with the untouched input, then scale alpha (transparent
  // endpoints fade the whole output toward 0 alpha).
  float4 base = inputTex.SampleLevel(linearSampler, uv, 0.0);
  float4 outc = lerp(base, col, saturate(intensity));
  outc.a *= saturate(alpha_scale);
  outputTex[gid.xy] = outc;
}
