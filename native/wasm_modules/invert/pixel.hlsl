// Per-pixel kernel for video.invert.

struct FuseUniforms {
  float amount;        // 0..1 — interpolation between input and inverted
  float invert_alpha;  // 0 = leave alpha, 1 = also invert
  float _pad0;
  float _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = lerp(c.rgb, 1.0 - c.rgb, u_fuse.amount);
  float a = lerp(c.a, lerp(c.a, 1.0 - c.a, u_fuse.amount), u_fuse.invert_alpha);
  return float4(rgb, a);
}
