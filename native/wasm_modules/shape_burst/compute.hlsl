// shape_burst/compute.hlsl — draws up to N concentric expanding rings
// (circle / square / triangle) over a background, one compute dispatch.
//
// Each active "voice" contributes a ring at its own scale (cover-square units).
// Rings are hard-cut solid (no fade); antialiased with a fixed-width smoothstep
// band (house style — no fwidth in this tree). Composited alpha-over onto a
// background chosen by composite_mode (black / transparent / custom / input).

#include "nano_coords.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

#define MAX_DRAW 16

cbuffer Uniforms : register(b2) {
  float2 u_aspect;        // cover-square aspect (ax, ay)
  float2 u_center;        // burst center, cover-square coords
  float4 u_color;         // ring color (rgba; a = opacity)
  float4 u_bg;            // custom background color (rgba)
  uint   u_shape_kind;    // 0 = circle, 1 = square, 2 = triangle
  uint   u_composite;     // 0 = black, 1 = transparent, 2 = custom, 3 = input
  float  u_thickness;     // ring thickness, cover-square units
  float  u_px;            // one pixel in cover-square units (AA band)
  uint   u_count;         // number of valid entries in u_scales
  uint   _p0; uint _p1; uint _p2;
  float4 u_scales[MAX_DRAW / 4];  // per-voice ring radius (cover-square units)
};

// --- Signed-distance to each unit shape's boundary. All 1-homogeneous, so a
//     ring at radius s is sdShape(p / s) * s. ---
float sd_circle(float2 p) { return length(p) - 1.0; }

float sd_box(float2 p) {
  float2 d = abs(p) - 1.0;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// iq equilateral triangle (unit size, 1-homogeneous).
float sd_triangle(float2 p) {
  const float k = sqrt(3.0);
  p.x = abs(p.x) - 1.0;
  p.y = p.y + 1.0 / k;
  if (p.x + k * p.y > 0.0) p = float2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0, 0.0);
  return -length(p) * sign(p.y);
}

float sd_shape(float2 p, uint kind) {
  if (kind == 1u) return sd_box(p);
  if (kind == 2u) return sd_triangle(p);
  return sd_circle(p);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  // Background per composite mode.
  float4 acc;
  if      (u_composite == 0u) acc = float4(0.0, 0.0, 0.0, 1.0);          // black
  else if (u_composite == 1u) acc = float4(0.0, 0.0, 0.0, 0.0);          // transparent
  else if (u_composite == 2u) acc = u_bg;                               // custom
  else                        acc = inputTex.Load(int3(gid.xy, 0));      // input

  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), u_aspect);
  float2 p  = sq - u_center;

  const float half_t = max(u_thickness * 0.5, 1e-5);
  const float aa     = max(u_px, 1e-5);

  for (uint i = 0u; i < u_count; ++i) {
    float s = u_scales[i / 4u][i % 4u];
    if (s <= 0.0) continue;
    float d   = sd_shape(p / s, u_shape_kind) * s;   // signed distance to ring's centerline shape
    float cov = smoothstep(half_t + aa, half_t - aa, abs(d));
    if (cov <= 0.0) continue;
    float a = u_color.a * cov;                        // alpha-over
    acc.rgb = lerp(acc.rgb, u_color.rgb, a);
    acc.a   = a + acc.a * (1.0 - a);
  }

  outputTex[gid.xy] = acc;
}
