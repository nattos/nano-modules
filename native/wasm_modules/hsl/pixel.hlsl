// Per-pixel kernel for color.hsl — hue rotate + saturation pull + bipolar lightness.

#include "nano_color.hlsl"

struct FuseUniforms {
  float hue_shift;
  float saturation;
  float lightness;
  float _pad;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 hsl = nano_rgb_to_hsl(saturate(c.rgb));

  hsl.x = frac(hsl.x + u_fuse.hue_shift + 1.0);

  if (u_fuse.saturation >= 0.0) {
    hsl.y = saturate(hsl.y + (1.0 - hsl.y) * u_fuse.saturation);
  } else {
    hsl.y = saturate(hsl.y * (1.0 + u_fuse.saturation));
  }

  if (u_fuse.lightness >= 0.0) {
    hsl.z = saturate(hsl.z + (1.0 - hsl.z) * u_fuse.lightness);
  } else {
    hsl.z = saturate(hsl.z * (1.0 + u_fuse.lightness));
  }

  return float4(nano_hsl_to_rgb(hsl), c.a);
}
