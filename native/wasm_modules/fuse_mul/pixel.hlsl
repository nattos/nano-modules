// debug.fuse_mul — multiplies RGB by a uniform scale, clamps to [0, 1].
// Test-only effect: predictable byte-exact math.

struct FuseUniforms {
  float4 scale;  // .rgb multiplier, .a ignored (kept for 16B alignment)
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 r = saturate(c.rgb * u_fuse.scale.rgb);
  return float4(r, c.a);
}
