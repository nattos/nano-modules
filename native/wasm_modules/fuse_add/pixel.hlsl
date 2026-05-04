// debug.fuse_add — adds an RGB offset, clamps to [0, 1].
// Test-only effect: predictable byte-exact math so multi-stage fusion
// tests can compare standalone vs fused output without ULP slop.

struct FuseUniforms {
  float4 offset;  // .rgb added, .a ignored (kept for 16B alignment)
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 r = saturate(c.rgb + u_fuse.offset.rgb);
  return float4(r, c.a);
}
