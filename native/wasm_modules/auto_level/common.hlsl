// color.tone.auto_level — shared block for the auto-leveler passes.
//
// Estimates the input's luminance histogram (minmax → hist over a downsample
// grid), inverts it into a remap curve (buildlut) with two composable options,
// then applies that curve to the image preserving chroma (apply). The remap is
// driven entirely from luminance so colours keep their hue/saturation; only the
// tonal distribution is reshaped.
//
// Curve options (both monotone, both endpoints fixed at 0 and 1):
//   equalize       — blend identity → histogram-equalized (flat distribution).
//   median pull    — blend identity → a gamma that drives the median toward a
//                    target value.
// The two compose: equalize first, then the median pull on the equalized curve.

#ifndef AUTO_LEVEL_COMMON_HLSL
#define AUTO_LEVEL_COMMON_HLSL

#include "nano_color.hlsl"       // nano_luminance
#include "nano_histogram.hlsl"   // NANO_HIST_NB, nano_hist_*

#define AL_NB 256                // histogram bins / LUT entries (== NANO_HIST_NB)
#define AL_SN 128                // histogram downsample grid (SN×SN samples)

// Shared uniform block — identical layout in every pass (always register b0).
cbuffer U : register(b0) {
  float res_x;       float res_y;        float equalize;     float median_target;
  float median_pull; float _al_pad0;     float _al_pad1;     float _al_pad2;
};

// Nearest input pixel for downsample grid cell (gx, gy) ∈ [0, AL_SN)².
uint2 al_grid_to_pixel(uint2 g) {
  return uint2((uint)(((float)g.x + 0.5) / float(AL_SN) * res_x),
               (uint)(((float)g.y + 0.5) / float(AL_SN) * res_y));
}

// Sample the remap LUT at normalized position t ∈ [0, 1] (linear interp).
float al_sample_lut(StructuredBuffer<float> lut, float t) {
  float x = saturate(t) * float(AL_NB - 1);
  uint i0 = (uint)floor(x);
  uint i1 = min(i0 + 1u, AL_NB - 1u);
  return lerp(lut[i0], lut[i1], frac(x));
}

#endif // AUTO_LEVEL_COMMON_HLSL
