// Per-pixel kernel for source.grid — tiled grid in cover-square coords
// with anti-aliased lines. Strict-output: no input texture sampled.

#include "nano_coords.hlsl"

struct FuseUniforms {
  float cell_size;
  float line_width;
  float softness;
  float offset_x;
  float offset_y;
  float aspect_x;
  float aspect_y;
  float line_r;
  float line_g;
  float line_b;
  float line_a;
  float bg_r;
  float bg_g;
  float bg_b;
  float bg_a;
  float _pad;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, uint2 vp_size) {
  float2 sq = nano_pixel_to_cover_square(float2(gid), float2(vp_size),
                                          float2(u_fuse.aspect_x, u_fuse.aspect_y));
  float2 shifted = sq + float2(u_fuse.offset_x, u_fuse.offset_y);
  float2 cell = frac(shifted / max(u_fuse.cell_size, 1e-4));

  float dx = min(cell.x, 1.0 - cell.x);
  float dy = min(cell.y, 1.0 - cell.y);
  float min_d = min(dx, dy);

  float half_lw = max(u_fuse.line_width * 0.5, 1e-4);
  float band = max(u_fuse.softness, 1e-4) * half_lw;
  float k = 1.0 - smoothstep(half_lw - band, half_lw + band, min_d);

  float4 line_col = float4(u_fuse.line_r, u_fuse.line_g, u_fuse.line_b, u_fuse.line_a);
  float4 bg = float4(u_fuse.bg_r, u_fuse.bg_g, u_fuse.bg_b, u_fuse.bg_a);
  return lerp(bg, line_col, k);
}
