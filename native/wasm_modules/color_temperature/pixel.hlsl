// Per-pixel kernel for color.temperature. Per-channel multiplicative
// shift on the orange/blue axis. The host folds temperature into per-channel
// multipliers; the shader is just a multiply.

struct FuseUniforms {
  float mul_r;
  float mul_g;
  float mul_b;
  float _pad;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = c.rgb * float3(u_fuse.mul_r, u_fuse.mul_g, u_fuse.mul_b);
  return float4(saturate(rgb), c.a);
}
