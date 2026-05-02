// generator.gradient — Linear gradient between two colours.

#include "nano_coords.hlsl"

RWTexture2D<float4> outputTex : register(u0);

cbuffer Uniforms : register(b1) {
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

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), float2(aspect_x, aspect_y));

  // Project onto direction. The cover-square's diagonal is √2 ≈ 1.414, so we
  // scale by 1/√2 to keep the gradient parameter ≈ 0..1 across the visible
  // square's primary axis at angle 0.
  float t = dot(sq, float2(dir_x, dir_y)) * 0.5 + 0.5 + offset * 0.5;
  // softness: 0 = sharp band centred at t=0.5, 1 = full ramp.
  float band = max(softness, 1e-4);
  float k = saturate((t - (0.5 - band * 0.5)) / band);

  float3 a = float3(color_a_r, color_a_g, color_a_b);
  float3 b = float3(color_b_r, color_b_g, color_b_b);
  float3 col = lerp(a, b, k);
  outputTex[gid.xy] = float4(col, 1.0);
}
