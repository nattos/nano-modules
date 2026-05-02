// generator.noise — Procedural noise with multiple algorithms.
//
// Algorithms:
//   0 = white          (per-pixel hash from coords + seed)
//   1 = value noise    (interpolated grid hashes)
//   2 = fractal value  (octaves of value noise — pseudo "perlin"/fbm)
//   3 = static         (white noise re-seeded by an animated phase)

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

// Cheap, deterministic hash returning a value in [0, 1).
float hash21(float2 p) {
  p = frac(p * float2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return frac(p.x * p.y);
}

float hash31(float3 p) {
  p = frac(p * float3(127.1, 311.7, 74.7));
  p += dot(p, p.yzx + 19.19);
  return frac(p.x * p.y * p.z);
}

float value_noise(float2 p) {
  float2 i = floor(p);
  float2 f = frac(p);
  float a = hash21(i + float2(0, 0));
  float b = hash21(i + float2(1, 0));
  float c = hash21(i + float2(0, 1));
  float d = hash21(i + float2(1, 1));
  float2 u = f * f * (3.0 - 2.0 * f);  // smoothstep
  return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
}

float fbm(float2 p, int oct) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float total_amp = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * value_noise(p * freq);
    total_amp += amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum / max(total_amp, 1e-4);
}

// Apply the same pow-curve as `video.curve`: contrast=-1 → exp 8 (crush),
// contrast=+1 → exp 1/8 (lift). Operates on already-normalized [0, 1].
float apply_contrast(float x, float c) {
  float e = pow(2.0, -c * 3.0);
  return pow(saturate(x), e);
}

float channel_for(float2 sq, float chan_offset) {
  // scale: [0, 1] → cells per cover-square dimension on an exponential ramp.
  // 0 → 4 cells (large), 1 → 64 cells (fine).
  float cells = lerp(4.0, 64.0, scale);
  float2 p = sq * cells + float2(chan_offset, chan_offset * 1.7);

  if (algorithm == 0) {
    // White: per-pixel hash, completely uncorrelated.
    return hash21(floor(p * 256.0) + seed * 1024.0);
  }
  if (algorithm == 1) {
    return value_noise(p + seed * 16.0);
  }
  if (algorithm == 2) {
    return fbm(p + seed * 16.0, octaves);
  }
  // Static: white noise re-seeded each "frame chunk" by static_phase.
  float frame_id = floor(static_phase);
  return hash31(float3(p, frame_id + seed * 16.0));
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float2 sq = (uv - 0.5) / float2(aspect_x, aspect_y);

  float r = channel_for(sq, 0.0);
  float g = (color > 0.5) ? channel_for(sq, 41.0) : r;
  float b = (color > 0.5) ? channel_for(sq, 79.0) : r;

  r = apply_contrast(r, contrast);
  g = apply_contrast(g, contrast);
  b = apply_contrast(b, contrast);

  outputTex[gid.xy] = float4(saturate(float3(r, g, b)), 1.0);
}
