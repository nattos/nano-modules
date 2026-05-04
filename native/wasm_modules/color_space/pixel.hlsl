// Per-pixel kernel for video.color_space — RGB encoding conversion.
// in/out are independent: 0 = sRGB, 1 = Linear. Always routes
// input → linear → output, so any combination (including identity)
// works without special-casing.

struct FuseUniforms {
  int in_space;
  int out_space;
  int _pad0;
  int _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float3 srgb_to_linear(float3 c) {
  c = saturate(c);
  float3 lo = c / 12.92;
  float3 hi = pow((c + 0.055) / 1.055, 2.4);
  return lerp(lo, hi, step(0.04045, c));
}

[noinline]
float3 linear_to_srgb(float3 c) {
  c = saturate(c);
  float3 lo = c * 12.92;
  float3 hi = 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  return lerp(lo, hi, step(0.0031308, c));
}

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = c.rgb;
  if (u_fuse.in_space == 0)  rgb = srgb_to_linear(rgb);
  if (u_fuse.out_space == 0) rgb = linear_to_srgb(rgb);
  return float4(rgb, c.a);
}
