// generator.grid — Tiled grid in cover-square coordinates with anti-aliased lines.

#include "nano_coords.hlsl"

RWTexture2D<float4> outputTex : register(u0);

cbuffer Uniforms : register(b1) {
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

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  // Pixel → cover-square coordinates.
  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), float2(aspect_x, aspect_y));

  // Shift then tile.
  float2 shifted = sq + float2(offset_x, offset_y);
  float2 cell = frac(shifted / max(cell_size, 1e-4));

  // Distance from each cell axis (frac is [0,1]; lines are at frac=0).
  float dx = min(cell.x, 1.0 - cell.x);
  float dy = min(cell.y, 1.0 - cell.y);
  float min_d = min(dx, dy);

  // Scale to absolute width: line_width is fraction of cell side.
  float half_lw = max(line_width * 0.5, 1e-4);
  float band = max(softness, 1e-4) * half_lw;

  // 1.0 inside the line, 0.0 in the cell interior.
  float k = 1.0 - smoothstep(half_lw - band, half_lw + band, min_d);

  float4 line_col = float4(line_r, line_g, line_b, line_a);
  float4 bg       = float4(bg_r,   bg_g,   bg_b,   bg_a);
  outputTex[gid.xy] = lerp(bg, line_col, k);
}
