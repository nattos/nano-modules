// Per-pixel kernel for generator.solid_color.
// Strict-output: writes uniform RGB to every pixel; alpha = 1.

struct FuseUniforms {
  float r, g, b, _pad;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, uint2 vp_size) {
  return float4(u_fuse.r, u_fuse.g, u_fuse.b, 1.0);
}
