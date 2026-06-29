// warp.legacy.wobble_master — radial-ripple wobble + chromatic dispersion.
//
// A concentric sine ripple emanates from a centre and travels outward; it
// displaces the image radially and splits the colour channels along the same
// radial direction (red pushed out more than blue → a prismatic dispersion).
// The ripple amplitude is gated by a pulse envelope (computed in main.cpp from
// a beat/trigger), so it "pumps" on a beat and decays. v2 of the Resolume Wire
// "Wobble Master 2" (the radial-ripple sibling of chroma_wobble's fbm noise).

#include "nano_chroma.hlsl"

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float drift;      // outward travel phase (accumulated)
  float freq;       // ripple spatial frequency (# rings)
  float amp;        // resolved ripple amplitude (uv, short-axis fraction)
  float chroma;     // radial chromatic dispersion
  float hue_shift;  // YIQ hue rotation of the split (radians)
  float center_x;   // ripple centre (uv)
  float center_y;
  float aspect_x;   // min(W,H)/W
  float aspect_y;   // min(W,H)/H
  float _p0, _p1, _p2;
};

static const float TAU = 6.28318530717958647692;

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv  = (float2(gid.xy) + 0.5) / float2(W, H);
  float2 asp = float2(aspect_x, aspect_y);

  // Circular distance/direction from the centre (equal pixel units on both
  // axes → the rings are round on any aspect).
  float2 pc = (uv - float2(center_x, center_y)) / asp;
  float r = length(pc);
  float2 dir = (r > 1e-5) ? pc / r : float2(0.0, 0.0);

  // Outward-travelling radial sine ripple.
  float wave = sin(r * freq * TAU - drift * TAU);
  float2 disp = dir * wave * amp;        // in circular units

  // Radial chromatic dispersion: red shifts out more, blue less. Convert the
  // displacement back to uv via `asp` (round → uv).
  float2 sR = disp * (1.0 + chroma) * asp;
  float2 sG = disp * asp;
  float2 sB = disp * (1.0 - chroma) * asp;

  float4 col = nano_chroma_offset(inputTex, linearSampler, uv, sR, sG, sB, hue_shift);
  outputTex[gid.xy] = col;
}
