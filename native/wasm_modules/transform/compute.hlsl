// warp.transform — Affine resample with bilinear sampling.
//
// Per output pixel:
//   1. Convert dispatch coord → cover-square coord.
//   2. Inverse-transform around pivot: undo translate, undo rotate, undo scale.
//   3. Convert back to viewport uv and bilinear-sample the input.
//
// Wrap mode: 0 = clamp to edge, 1 = transparent outside,
//            2 = repeat, 3 = mirror.

#include "nano_coords.hlsl"

Texture2D<float4>   inputTex  : register(t0);
SamplerState        samp      : register(s2);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b3) {
  float scale_x;
  float scale_y;
  float cos_r;
  float sin_r;
  float translate_x;
  float translate_y;
  float pivot_x;
  float pivot_y;
  float aspect_x;
  float aspect_y;
  float wrap_mode;
  float _pad;
};

float wrap_uv(float x, float mode) {
  if (mode < 0.5) return clamp(x, 0.0, 1.0);                 // 0: clamp
  if (mode < 1.5) return x;                                  // 1: transparent (handled by caller)
  if (mode < 2.5) return frac(x + 1024.0);                   // 2: repeat
  // 3: mirror
  float t = frac(x * 0.5 + 1024.0) * 2.0;
  return t < 1.0 ? t : 2.0 - t;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  // Output uv → cover-square coords.
  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), float2(aspect_x, aspect_y));

  // Inverse: subtract translate, then move into pivot frame, undo rotate, undo scale, return to global.
  float2 t = sq - float2(translate_x, translate_y);
  float2 p = t - float2(pivot_x, pivot_y);
  float2 rp = float2( cos_r * p.x + sin_r * p.y,
                     -sin_r * p.x + cos_r * p.y);
  float2 sp = rp / float2(scale_x, scale_y);
  float2 src_sq = sp + float2(pivot_x, pivot_y);

  // Cover-square → uv.
  float2 src_uv = src_sq * float2(aspect_x, aspect_y) + 0.5;

  if (wrap_mode > 0.5 && wrap_mode < 1.5) {
    if (src_uv.x < 0.0 || src_uv.x > 1.0 || src_uv.y < 0.0 || src_uv.y > 1.0) {
      outputTex[gid.xy] = float4(0, 0, 0, 0);
      return;
    }
  } else {
    src_uv.x = wrap_uv(src_uv.x, wrap_mode);
    src_uv.y = wrap_uv(src_uv.y, wrap_mode);
  }

  // Bilinear sample via the bound sampler at mip 0.
  outputTex[gid.xy] = inputTex.SampleLevel(samp, src_uv, 0.0);
}
