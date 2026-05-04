// Per-pixel kernel for video.levels — input/output remap with gamma midtone.

struct FuseUniforms {
  float in_low;
  float in_high;
  float gamma_exp;
  float out_low;
  float out_high;
  float _pad_y;
  float _pad_z;
  float _pad_w;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float3 apply_levels(float3 c) {
  float range = max(u_fuse.in_high - u_fuse.in_low, 1e-4);
  float3 x = saturate((c - u_fuse.in_low) / range);
  x = pow(x, u_fuse.gamma_exp);
  return lerp(u_fuse.out_low, u_fuse.out_high, x);
}

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  return float4(saturate(apply_levels(c.rgb)), c.a);
}
