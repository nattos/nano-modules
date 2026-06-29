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

// Integer-domain hash. The float hashes above multiply by ~127 then take
// frac(), so they collapse for large coordinates: once the product exceeds a
// few hundred thousand the float32 ULP grows past ~0.1 and frac() only yields a
// handful of distinct levels → structured banding instead of noise. Use this
// for fine integer grids (e.g. per-pixel white noise) where the inputs are
// large integers — bitwise integer mixing is exact regardless of magnitude.
uint nano_uhash(uint x) {
  x ^= x >> 17;
  x *= 0xed5ad4bbu;
  x ^= x >> 11;
  x *= 0xac4c1b51u;
  x ^= x >> 15;
  x *= 0x31848babu;
  x ^= x >> 14;
  return x;
}

// 3D integer hash → [0, 1). Sequentially mixes the three components so any one
// changing decorrelates the result.
float nano_hash31i(int3 p) {
  uint h = nano_uhash(uint(p.x));
  h = nano_uhash(h + uint(p.y));
  h = nano_uhash(h + uint(p.z));
  return float(h) * (1.0 / 4294967296.0);
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

// Smoothed value noise on a 3D grid. Trilinear (smoothstep) interpolation
// between the eight corner hashes. Use the third axis for time to get a
// smoothly evolving 2D field.
float nano_value_noise3(float3 p) {
  float3 i = floor(p);
  float3 f = frac(p);
  float3 u = f * f * (3.0 - 2.0 * f);
  float c000 = nano_hash31(i + float3(0, 0, 0));
  float c100 = nano_hash31(i + float3(1, 0, 0));
  float c010 = nano_hash31(i + float3(0, 1, 0));
  float c110 = nano_hash31(i + float3(1, 1, 0));
  float c001 = nano_hash31(i + float3(0, 0, 1));
  float c101 = nano_hash31(i + float3(1, 0, 1));
  float c011 = nano_hash31(i + float3(0, 1, 1));
  float c111 = nano_hash31(i + float3(1, 1, 1));
  float x00 = lerp(c000, c100, u.x);
  float x10 = lerp(c010, c110, u.x);
  float x01 = lerp(c001, c101, u.x);
  float x11 = lerp(c011, c111, u.x);
  return lerp(lerp(x00, x10, u.y), lerp(x01, x11, u.y), u.z);
}

// 3D fractal Brownian motion — the 3D analogue of nano_fbm2. `oct` is
// clamped to [1, 6]. Higher octaves also evolve faster on the time axis.
float nano_fbm3(float3 p, int oct) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * nano_value_noise3(p * freq);
    total += amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum / max(total, 1e-4);
}

#endif
