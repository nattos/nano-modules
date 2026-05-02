// nano_hash.hlsl — Cheap deterministic hashes + value/fbm noise.
//
// All hashes return values in [0, 1). Use these for per-pixel jitter, noise
// generators, dithering, and stable per-id randomness. They're not
// cryptographic — collisions are common — but they're fast and visually
// adequate.

#ifndef NANO_HASH_HLSL
#define NANO_HASH_HLSL

float nano_hash21(float2 p) {
  p = frac(p * float2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return frac(p.x * p.y);
}

float nano_hash31(float3 p) {
  p = frac(p * float3(127.1, 311.7, 74.7));
  p += dot(p, p.yzx + 19.19);
  return frac(p.x * p.y * p.z);
}

// Smoothed value noise on a 2D grid. Cubic Hermite (smoothstep) interpolation
// between four corner hashes.
float nano_value_noise2(float2 p) {
  float2 i = floor(p);
  float2 f = frac(p);
  float a = nano_hash21(i + float2(0, 0));
  float b = nano_hash21(i + float2(1, 0));
  float c = nano_hash21(i + float2(0, 1));
  float d = nano_hash21(i + float2(1, 1));
  float2 u = f * f * (3.0 - 2.0 * f);
  return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
}

// Fractal Brownian motion — sum of value-noise octaves with halving amplitude
// and doubling frequency. `oct` is clamped to [1, 6].
float nano_fbm2(float2 p, int oct) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * nano_value_noise2(p * freq);
    total += amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum / max(total, 1e-4);
}

#endif
