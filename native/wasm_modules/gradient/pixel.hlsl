// Per-pixel kernel for source.gradient — linear ramp between two colours.

#include "nano_coords.hlsl"

struct FuseUniforms {
  float dir_x;
  float dir_y;
  float offset;
  float softness;
  float color_a_r;
  float color_a_g;
  float color_a_b;
  float color_b_r;
  float color_b_g;
  float color_b_b;
  float aspect_x;
  float aspect_y;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, uint2 vp_size) {
  float2 sq = nano_pixel_to_cover_square(float2(gid), float2(vp_size),
                                          float2(u_fuse.aspect_x, u_fuse.aspect_y));
  float t = dot(sq, float2(u_fuse.dir_x, u_fuse.dir_y)) * 0.5 + 0.5 + u_fuse.offset * 0.5;
  float band = max(u_fuse.softness, 1e-4);
  float k = saturate((t - (0.5 - band * 0.5)) / band);

  float3 a = float3(u_fuse.color_a_r, u_fuse.color_a_g, u_fuse.color_a_b);
  float3 b = float3(u_fuse.color_b_r, u_fuse.color_b_g, u_fuse.color_b_b);
  return float4(lerp(a, b, k), 1.0);
}
