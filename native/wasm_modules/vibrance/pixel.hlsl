// Per-pixel kernel for video.vibrance.
// Saturation boost biased toward already-unsaturated pixels.

#include "nano_color.hlsl"

struct FuseUniforms {
  float amount;     // [-1, 1]
  float _pad0;
  float _pad1;
  float _pad2;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = saturate(c.rgb);

  float maxc = max(max(rgb.r, rgb.g), rgb.b);
  float minc = min(min(rgb.r, rgb.g), rgb.b);
  float sat = maxc - minc;  // 0..1, simple proxy for saturation

  // amount > 0: push harder on greys; amount < 0: push harder on saturated.
  float weight = (u_fuse.amount >= 0.0) ? (1.0 - sat) : sat;
  float strength = u_fuse.amount * weight;

  float lum = nano_luminance(rgb);
  rgb = lerp(float3(lum, lum, lum), rgb, 1.0 + strength);
  return float4(saturate(rgb), c.a);
}
