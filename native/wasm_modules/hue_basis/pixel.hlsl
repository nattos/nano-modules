// Per-pixel kernel for color.hue_basis — channel-mix into a basis
// defined by three hues. CPU pre-uploads M's columns (forward) or
// M^-1's columns (reverse).

struct FuseUniforms {
  float4 col0;
  float4 col1;
  float4 col2;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 v = c.rgb;
  float3 r = float3(dot(u_fuse.col0.xyz, v),
                    dot(u_fuse.col1.xyz, v),
                    dot(u_fuse.col2.xyz, v));
  return float4(r, c.a);
}
