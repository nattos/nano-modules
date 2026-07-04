// shape_burst/common.hlsl — shared uniforms + shape SDFs + perimeter distortion
// for the color pass (compute.hlsl) and the motion-vector pass (motion.hlsl).

#ifndef SHAPE_BURST_COMMON_HLSL
#define SHAPE_BURST_COMMON_HLSL

#include "nano_coords.hlsl"
#include "nano_hash.hlsl"

#define MAX_DRAW 16

cbuffer Uniforms : register(b2) {
  float2 u_aspect;         // cover-square aspect (ax, ay)
  float2 u_center;         // burst center, cover-square coords
  float4 u_color;          // ring color (rgba; a = opacity)
  float4 u_bg;             // custom background color (rgba)
  uint   u_shape_kind;     // 0 = circle, 1 = square, 2 = triangle
  uint   u_composite;      // 0 = black, 1 = transparent, 2 = custom, 3 = input
  float  u_thickness;      // ring thickness, cover-square units
  float  u_px;             // one pixel in cover-square units (AA band)
  uint   u_count;          // number of valid entries in u_scales / u_speeds
  float  u_tilt;           // -1..+1: shift motion magnitude inner<->outer edge
  float  u_motion_strength;// overall motion-vector scale
  uint   _p0;
  float  u_dist_amount;    // distortion displacement scale (0 = off)
  float  u_dist_freq;      // perimeter noise frequency
  float  u_dist_radius;    // twitch-mask region radius (cover-square)
  float  u_dist_soft;      // twitch-mask falloff
  float2 u_anchor;         // per-frame roaming twitch anchor (cover-square)
  float  u_twitch_strength;// this frame's twitch intensity [0,1]
  float  _p1;
  float4 u_scales[MAX_DRAW / 4];    // per-voice ring radius (cover-square units)
  float4 u_speeds[MAX_DRAW / 4];    // per-voice radius change per frame (signed)
  float4 u_rotations[MAX_DRAW / 4]; // per-voice shape rotation (radians)
  float4 u_dist_seeds[MAX_DRAW / 4];// per-voice noise seed offset
};

// Rotate a sample point into the shape's local frame (rotate by -angle).
// No-op on circles (length is invariant).
float2 sb_unrotate(float2 p, float angle) {
  float c = cos(angle), s = sin(angle);
  return float2(c * p.x + s * p.y, -s * p.x + c * p.y);
}

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

// Signed radial displacement (cover-square units) of the boundary at the
// "canonical" position `bp` = angle-direction × radius (so every pixel across
// the stroke width at one angle shares it → the whole stroke pushes/pulls as a
// unit). A roaming twitch mask (strong near the per-frame anchor) weights a
// bipolar fbm noise, giving a mask-gated random push/pull along the perimeter.
float sb_distort(float2 bp, float seed) {
  if (u_dist_amount <= 0.0 || u_twitch_strength <= 0.0) return 0.0;
  float t = smoothstep(u_dist_radius, u_dist_radius + max(u_dist_soft, 1e-4),
                       length(bp - u_anchor));
  float mask = u_twitch_strength * (1.0 - t);        // 1 near anchor → 0 far
  float n = nano_fbm2(bp * (1.0 + u_dist_freq * 110.0) + seed, 4);
  return u_dist_amount * mask * (n * 2.0 - 1.0);      // bipolar in/out
}

#endif
