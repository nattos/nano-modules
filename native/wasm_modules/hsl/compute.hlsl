// video.hsl — Hue rotation, saturation pull, and bipolar lightness.

#include "nano_color.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float hue_shift;   // in turns
  float saturation;  // [-1, 1]
  float lightness;   // [-1, 1]
  float _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 hsl = nano_rgb_to_hsl(saturate(c.rgb));

  // hue rotate (wrap into [0,1))
  hsl.x = frac(hsl.x + hue_shift + 1.0);

  // saturation: -1 → 0 (greyscale), 0 → unchanged, +1 → doubled (clamped)
  if (saturation >= 0.0) {
    hsl.y = saturate(hsl.y + (1.0 - hsl.y) * saturation);
  } else {
    hsl.y = saturate(hsl.y * (1.0 + saturation));
  }

  // lightness: bipolar lift toward white / crush toward black
  if (lightness >= 0.0) {
    hsl.z = saturate(hsl.z + (1.0 - hsl.z) * lightness);
  } else {
    hsl.z = saturate(hsl.z * (1.0 + lightness));
  }

  float3 rgb = nano_hsl_to_rgb(hsl);
  outputTex[gid.xy] = float4(rgb, c.a);
}
