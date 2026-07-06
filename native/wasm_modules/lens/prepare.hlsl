// filter.blur.lens — pass 1 (prepare). Highlight energy boost (pipeline.pass_prepare :147).
//
// Linearise the sRGB input (REPORT §1: "do sRGB→linear here too") and multiply
// highlights by (1 + hl_boost·mask) so bright points survive the energy-normalised
// bokeh gather as visible discs. Writes linear HDR (RGBA16F).

#include "common.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);
cbuffer Uniforms : register(b2) {
  float u_hl_threshold;
  float u_hl_boost;      // already ×8 host-side
  float _p0, _p1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  float3 lin = lens_srgb_to_linear(c.rgb);
  float  lum = lens_luma(lin);
  float  mask = lens_smoothstep(u_hl_threshold, u_hl_threshold * 2.0, lum);
  outputTex[gid.xy] = float4(lin * (1.0 + u_hl_boost * mask), c.a);
}
