// filter.blur.lens — pass 6 (halation + bloom). Highlights bleed a soft glow — a
// neutral gentle bloom + a wider warm halation ring (pipeline.pass_glow :434).
// Composites two pre-blurred highlight maps (σ 0.02·md and 0.05·md) onto the image.

#include "common.hlsl"

Texture2D<float4>   srcTex    : register(t0);   // current linear-HDR image
Texture2D<float4>   bloomTex  : register(t1);   // Blur16(hi, 0.02·md)
Texture2D<float4>   halTex    : register(t2);   // Blur16(hi, 0.05·md)
RWTexture2D<float4> outputTex : register(u3);
cbuffer Uniforms : register(b4) {
  float u_bloom;
  float u_halation;
  float2 _p;
  float3 u_hal_color;
  float _p2;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float4 src = srcTex[gid.xy];
  float3 rgb = src.rgb
             + bloomTex[gid.xy].rgb * u_bloom
             + halTex[gid.xy].rgb * u_hal_color * u_halation;
  outputTex[gid.xy] = float4(rgb, src.a);
}
