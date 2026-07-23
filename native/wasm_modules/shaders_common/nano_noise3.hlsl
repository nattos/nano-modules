// nano_noise3.hlsl — 3D gradient noise + ridged fbm.
//
// Gradient (Perlin-style) noise: smoother and more isotropic than the value
// noise in nano_hash.hlsl (no blocky grid glow), quintic fade so second
// derivatives are continuous — matters when a displacement field's *normal*
// is what the eye sees. Output ~[-1, 1].
//
// The fbm variants rotate the domain between octaves (fixed incommensurate
// rotation) so octave grids never align into axis streaks.

#ifndef NANO_NOISE3_HLSL
#define NANO_NOISE3_HLSL

#include "nano_hash.hlsl"

// Per-corner pseudo-gradient in [-1,1]³ (not normalized — cheap, adequate).
// INTEGER hashing (nano_uhash), not the float-frac hashes: fbm octaves push
// lattice coords into the hundreds, where frac(p * 127.1)-style hashes
// degrade into correlated runs — visible as straight-edged "rift" patches
// aligned with the noise lattice. Bitwise mixing is exact at any magnitude.
float3 nano_grad3_(float3 p) {
  int3 i = int3(round(p));
  uint h0 = nano_uhash(uint(i.x) * 0x9E3779B9u ^ uint(i.y) * 0x85EBCA6Bu ^
                       uint(i.z) * 0xC2B2AE35u);
  uint h1 = nano_uhash(h0 ^ 0x68E31DA4u);
  uint h2 = nano_uhash(h1 ^ 0xB5297A4Du);
  return float3(uint3(h0, h1, h2)) * (2.0 / 4294967296.0) - 1.0;
}

// 3D gradient noise, quintic fade. Output roughly [-1, 1].
float nano_gnoise3(float3 p) {
  float3 i = floor(p);
  float3 f = frac(p);
  float3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float c000 = dot(nano_grad3_(i + float3(0, 0, 0)), f - float3(0, 0, 0));
  float c100 = dot(nano_grad3_(i + float3(1, 0, 0)), f - float3(1, 0, 0));
  float c010 = dot(nano_grad3_(i + float3(0, 1, 0)), f - float3(0, 1, 0));
  float c110 = dot(nano_grad3_(i + float3(1, 1, 0)), f - float3(1, 1, 0));
  float c001 = dot(nano_grad3_(i + float3(0, 0, 1)), f - float3(0, 0, 1));
  float c101 = dot(nano_grad3_(i + float3(1, 0, 1)), f - float3(1, 0, 1));
  float c011 = dot(nano_grad3_(i + float3(0, 1, 1)), f - float3(0, 1, 1));
  float c111 = dot(nano_grad3_(i + float3(1, 1, 1)), f - float3(1, 1, 1));
  float x00 = lerp(c000, c100, u.x);
  float x10 = lerp(c010, c110, u.x);
  float x01 = lerp(c001, c101, u.x);
  float x11 = lerp(c011, c111, u.x);
  return lerp(lerp(x00, x10, u.y), lerp(x01, x11, u.y), u.z) * 1.5;
}

// Fixed incommensurate inter-octave rotation (rows ~orthonormal).
static const float3x3 NANO_OCT_ROT3 = float3x3(
     0.36f,  0.48f, -0.80f,
    -0.80f,  0.60f,  0.00f,
     0.48f,  0.64f,  0.60f);

// Standard fbm of gradient noise. `oct` clamped to [1, 6]. Output ~[-1, 1].
float nano_gfbm3(float3 p, int oct, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * nano_gnoise3(p);
    total += amp;
    p = mul(NANO_OCT_ROT3, p) * 2.02 + 11.31;
    amp *= gain;
  }
  return sum / max(total, 1e-4);
}

// Ridged fbm: sharp crests where the noise crosses zero — the flake/ridge
// primitive. `sharp` in [0,1] blends round bumps -> knife ridges.
// Output in [0, 1].
float nano_ridge3(float3 p, int oct, float gain, float sharp) {
  float sum = 0.0;
  float amp = 0.5;
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(nano_gnoise3(p));
    n = lerp(n * n, n * n * n * n, sharp);   // sharpen the crest
    sum += amp * n;
    total += amp;
    p = mul(NANO_OCT_ROT3, p) * 2.02 + 11.31;
    amp *= gain;
  }
  return sum / max(total, 1e-4);
}

#endif // NANO_NOISE3_HLSL
