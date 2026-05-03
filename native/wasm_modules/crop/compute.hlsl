// video.crop — Two-mode rectangular crop with optional soft feather.
//
// mode = 0 (Span):  rect centered at `center` (cover-square coords) with
//                   half-extents (half_w, half_h) in cover-square units.
// mode = 1 (Inset): rect specified by per-edge insets in viewport-uv
//                   coordinates: (inset_l, inset_r, inset_t, inset_b).
//
// Pixels inside the rect pass through; outside the rect lerps to `fill`
// over the feather window. feather=0 uses a hard step (pixel-perfect).

#include "nano_coords.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  // Each block sits on a 16-byte boundary; individual `_pad*` scalars
  // (not an array) so the WGSL array-stride rule doesn't silently
  // re-pad the layout. Mirrors the C++ Uniforms struct.
  float center_x, center_y, half_w, half_h;
  float feather, aspect_x, aspect_y, _pad0;
  float fill_r, fill_g, fill_b, fill_a;
  float inset_l, inset_r, inset_t, inset_b;
  int   mode;
  float _pad1, _pad2, _pad3;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float dist;
  if (mode == 0) {
    // Span mode — cover-square anchored crop.
    float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), float2(aspect_x, aspect_y));
    float2 d  = abs(sq - float2(center_x, center_y));
    float2 outside = d - float2(half_w, half_h);
    dist = max(outside.x, outside.y);
  } else {
    // Inset mode — viewport-uv per-edge insets.
    float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
    float dx = max(inset_l - uv.x, uv.x - (1.0 - inset_r));
    float dy = max(inset_t - uv.y, uv.y - (1.0 - inset_b));
    dist = max(dx, dy);
  }

  // feather == 0 → hard step (pixel-perfect staircase, intentional).
  // feather  > 0 → smoothstep over the feather width.
  float t = (feather > 0.0)
      ? smoothstep(0.0, feather, dist)
      : step(0.0, dist);

  float4 src  = inputTex[gid.xy];
  float4 fill = float4(fill_r, fill_g, fill_b, fill_a);
  outputTex[gid.xy] = lerp(src, fill, t);
}
