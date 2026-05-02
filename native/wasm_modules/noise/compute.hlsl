// generator.noise — Procedural noise with multiple algorithms.
//
// Algorithms:
//   0 = white          (per-pixel hash from coords + seed)
//   1 = value noise    (interpolated grid hashes)
//   2 = fractal value  (octaves of value noise — pseudo "perlin"/fbm)
//   3 = static         (white noise re-seeded by an animated phase)

#include "nano_coords.hlsl"
#include "nano_hash.hlsl"
#include "nano_curves.hlsl"

RWTexture2D<float4> outputTex : register(u0);

cbuffer Uniforms : register(b1) {
  int   algorithm;
  float scale;
  float contrast;
  float seed;
  int   octaves;
  float color;
  float static_phase;
  float aspect_x;
  float aspect_y;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

float channel_for(float2 sq, float chan_offset) {
  // scale: [0, 1] → cells per cover-square dimension on an exponential ramp.
  // 0 → 4 cells (large), 1 → 64 cells (fine).
  float cells = lerp(4.0, 64.0, scale);
  float2 p = sq * cells + float2(chan_offset, chan_offset * 1.7);

  if (algorithm == 0) {
    // White: per-pixel hash, completely uncorrelated.
    return nano_hash21(floor(p * 256.0) + seed * 1024.0);
  }
  if (algorithm == 1) {
    return nano_value_noise2(p + seed * 16.0);
  }
  if (algorithm == 2) {
    return nano_fbm2(p + seed * 16.0, octaves);
  }
  // Static: white noise re-seeded each "frame chunk" by static_phase.
  float frame_id = floor(static_phase);
  return nano_hash31(float3(p, frame_id + seed * 16.0));
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), float2(aspect_x, aspect_y));

  float r = channel_for(sq, 0.0);
  float g = (color > 0.5) ? channel_for(sq, 41.0) : r;
  float b = (color > 0.5) ? channel_for(sq, 79.0) : r;

  r = nano_apply_curve(r, contrast);
  g = nano_apply_curve(g, contrast);
  b = nano_apply_curve(b, contrast);

  outputTex[gid.xy] = float4(saturate(float3(r, g, b)), 1.0);
}
