// Per-pixel kernel for color.tone.exposure. Per-channel multiplicative gain.
// The host folds amount + tint into per-channel gains; the shader is
// just a multiply.

struct FuseUniforms {
  float gain_r;
  float gain_g;
  float gain_b;
  float _pad;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = c.rgb * float3(u_fuse.gain_r, u_fuse.gain_g, u_fuse.gain_b);
  return float4(saturate(rgb), c.a);
}
