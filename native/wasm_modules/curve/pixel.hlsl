// Per-pixel kernel for video.curve.
// CPU folds the slider's signed range into pre-computed exponents.

struct FuseUniforms {
  float rgb_exp;
  float alpha_exp;
  float _pad0;
  float _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = pow(saturate(c.rgb), u_fuse.rgb_exp);
  float a = pow(saturate(c.a), u_fuse.alpha_exp);
  return float4(rgb, a);
}
