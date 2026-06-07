// gen.bounce_resonator — color pass.
//
// Each bar IS its whole 1/4-width column: fill the entire vertical strip
// with the bar's colour, brightness = its diffusion value. Value sloshes
// between bars via the cycling diffusion matrix, so the four columns glow
// and trade brightness.

#include "nano_bars.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float v0; float v1; float v2; float v3;
  float band_r; float band_g; float band_b; float intensity;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base = inputTex[gid.xy];

  uint bar = nano_bar_index(uv.x);
  float vs[4] = { v0, v1, v2, v3 };
  float vi = vs[bar];

  float3 add = float3(band_r, band_g, band_b) * (intensity * vi);
  outputTex[gid.xy] = float4(base.rgb + add, base.a);
}
