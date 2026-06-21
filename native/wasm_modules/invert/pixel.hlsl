// Per-pixel kernel for color.invert.

struct FuseUniforms {
  float invert_alpha;  // 0 = leave alpha, 1 = also invert
  float _pad0;
  float _pad1;
  float _pad2;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = 1.0 - c.rgb;
  float a = lerp(c.a, 1.0 - c.a, u_fuse.invert_alpha);
  return float4(rgb, a);
}
