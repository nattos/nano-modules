// video.vibrance — Saturation boost weighted by (1 - current_saturation).

#include "nano_color.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float amount;     // [-1, 1]
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 rgb = saturate(c.rgb);

  float maxc = max(max(rgb.r, rgb.g), rgb.b);
  float minc = min(min(rgb.r, rgb.g), rgb.b);
  float sat = maxc - minc;  // 0..1, simple proxy for saturation

  // Weight: positive amount pushes harder on greys; negative pushes harder on saturated pixels.
  float weight = (amount >= 0.0) ? (1.0 - sat) : sat;
  float strength = amount * weight;

  // Apply by lerping the channels around the per-pixel luminance.
  float lum = nano_luminance(rgb);
  rgb = lerp(float3(lum, lum, lum), rgb, 1.0 + strength);

  outputTex[gid.xy] = float4(saturate(rgb), c.a);
}
