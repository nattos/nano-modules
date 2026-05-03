// video.crop — Box mask in cover-square coordinates with soft feather.
// Pixels inside the box pass through; outside fades to fill colour.

#include "nano_coords.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float center_x;
  float center_y;
  float half_w;
  float half_h;
  float feather;
  float aspect_x;
  float aspect_y;
  float fill_r;
  float fill_g;
  float fill_b;
  float fill_a;
  float _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  // Pixel → cover-square coords.
  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), float2(aspect_x, aspect_y));
  float2 d  = abs(sq - float2(center_x, center_y));

  // Distance outside the box edges, per axis. Negative inside, positive outside.
  float2 outside = d - float2(half_w, half_h);

  // Combined falloff: max of both axes' outside distances. 0 inside, +ve outside.
  float dist = max(outside.x, outside.y);
  // feather == 0 → hard step (pixel-perfect staircase, intentional).
  // feather  > 0 → smoothstep over the feather width.
  float t = (feather > 0.0)
      ? smoothstep(0.0, feather, dist)
      : step(0.0, dist);

  float4 src  = inputTex[gid.xy];
  float4 fill = float4(fill_r, fill_g, fill_b, fill_a);
  outputTex[gid.xy] = lerp(src, fill, t);
}
