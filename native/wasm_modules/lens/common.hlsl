// filter.blur.lens — "Lens" — shared shader helpers + baked constants.
//
// A GPU port of the single-plane lens simulation research harness
// (nano-fx-prototypes/lens-sim). Linear-HDR throughout; tonemap only in the
// final pass. This header carries small math helpers reused across the passes.
// The prototype is calibrated on Rec.709 luma; use lens_luma.

#ifndef LENS_COMMON_HLSL
#define LENS_COMMON_HLSL

static const float LENS_PI  = 3.14159265358979;
static const float LENS_TAU = 6.28318530717959;

float lens_luma(float3 rgb) {
  return dot(rgb, float3(0.2126, 0.7152, 0.0722));
}

// smoothstep, matching optics.smoothstep (clamped Hermite).
float lens_smoothstep(float e0, float e1, float x) {
  float t = saturate((x - e0) / (e1 - e0));
  return t * t * (3.0 - 2.0 * t);
}

// smoothstep_down (optics.py:152): 1 where x<edge, 0 where x>edge, soft ramp of
// half-width max(edge*softness,1e-4) centred on `edge`.
float lens_smoothstep_down(float edge, float x, float softness) {
  float w = max(edge * softness, 1e-4);
  float t = saturate((x - (edge - w)) / (2.0 * w));
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

// sRGB <-> linear (pipeline._linear_to_srgb :484; inverse for ingest per REPORT §1).
float3 lens_srgb_to_linear(float3 c) {
  float3 lo = c / 12.92;
  float3 hi = pow(max((c + 0.055) / 1.055, 0.0), 2.4);
  return float3(c.r <= 0.04045 ? lo.r : hi.r,
                c.g <= 0.04045 ? lo.g : hi.g,
                c.b <= 0.04045 ? lo.b : hi.b);
}
float3 lens_linear_to_srgb(float3 c) {
  c = saturate(c);
  float3 lo = c * 12.92;
  float3 hi = 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  return float3(c.r <= 0.0031308 ? lo.r : hi.r,
                c.g <= 0.0031308 ? lo.g : hi.g,
                c.b <= 0.0031308 ? lo.b : hi.b);
}

// Narkowicz ACES filmic fit (pipeline._aces :489).
float3 lens_aces(float3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

#endif // LENS_COMMON_HLSL
