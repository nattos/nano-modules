// filter.blur.lens — "Lens" — shared shader helpers + baked constants.
//
// A GPU port of the single-plane lens simulation research harness
// (nano-fx-prototypes/lens-sim). Linear-HDR throughout; tonemap only in the
// final pass. This header carries the effect's shared uniform layout, the baked
// spectral/coating/ghost constants (from lenssim/coatings.py + pipeline.py — NOT
// exposed as params), and small math helpers reused across the 10 passes.
//
// The prototype is calibrated on Rec.709 luma; use lens_luma (not the shared
// Rec.601 nano_luminance).

#ifndef LENS_COMMON_HLSL
#define LENS_COMMON_HLSL

static const float PI  = 3.14159265358979;
static const float TAU = 6.28318530717959;

float lens_luma(float3 rgb) {
  return dot(rgb, float3(0.2126, 0.7152, 0.0722));
}

float lens_smoothstep(float e0, float e1, float x) {
  float t = saturate((x - e0) / (e1 - e0));
  return t * t * (3.0 - 2.0 * t);
}

#endif // LENS_COMMON_HLSL
