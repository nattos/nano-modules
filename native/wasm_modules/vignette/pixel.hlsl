// Per-pixel kernel for video.vignette.
// Mapper signature has no vp_size, so prepare() writes it into u_fuse.

#include "nano_coords.hlsl"

struct FuseUniforms {
  float amount;
  float radius;
  float softness;
  float shape;
  float center_x;
  float center_y;
  float aspect_x;
  float aspect_y;
  float vp_w;     // written by prepare() — mapper fuse_transform has no
  float vp_h;     // viewport-size parameter, so we route it via uniform.
  float squash;   // signed [-1,+1]: -1 wider-than-tall, +1 taller-than-wide.
  float _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float2 sq = nano_pixel_to_cover_square(float2(gid),
                                          float2(u_fuse.vp_w, u_fuse.vp_h),
                                          float2(u_fuse.aspect_x, u_fuse.aspect_y));
  float2 d  = sq - float2(u_fuse.center_x, u_fuse.center_y);

  float2 metric = lerp(float2(1.0, 1.0),
                        float2(u_fuse.aspect_x, u_fuse.aspect_y) * 2.0,
                        u_fuse.shape);
  // squash: reciprocal-symmetric ellipse aspect. +1 shrinks the y-metric so
  // the bright region reaches further vertically (taller-than-wide); -1 the
  // opposite. k = 2^squash, applied as (k, 1/k).
  float k = exp2(u_fuse.squash);
  metric *= float2(k, 1.0 / k);
  float dist = length(d * metric);

  float t = smoothstep(u_fuse.radius,
                        u_fuse.radius + max(u_fuse.softness, 1e-4),
                        dist);
  float gain = 1.0 + u_fuse.amount * t;

  return float4(saturate(c.rgb * gain), c.a);
}
