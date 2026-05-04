// Per-pixel kernel for video.bake_alpha — alpha-over a solid bg colour.

struct FuseUniforms {
  float bg_r;
  float bg_g;
  float bg_b;
  float bg_a;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 src) {
  float a = saturate(src.a);
  float3 rgb = src.rgb * a + float3(u_fuse.bg_r, u_fuse.bg_g, u_fuse.bg_b) * (1.0 - a);
  float out_a = a + u_fuse.bg_a * (1.0 - a);
  return float4(rgb, out_a);
}
