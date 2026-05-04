// debug.fuse_solid — strict-output mapper. Writes a uniform color to
// every output pixel, ignoring whatever the input texture (if any)
// contains. Test-only effect: lets the strict-out top + mapper tails
// fusion path be exercised without depending on real generators.

struct FuseUniforms {
  float4 color;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

// Strict-output signature: receives gid + viewport size (no input c).
// The runtime fuser substitutes vp_size with textureDimensions(outputTex)
// when this is the top of a fused run.
[noinline]
float4 fuse_transform(uint2 gid, uint2 vp_size) {
  return u_fuse.color;
}
