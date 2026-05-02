// nano_curves.hlsl — Slider→exponent and contrast helpers.
//
// See EFFECTS_STYLE_GUIDE.md §1.3.

#ifndef NANO_CURVES_HLSL
#define NANO_CURVES_HLSL

// Map a signed normalized slider [-1, +1] to a power-curve exponent.
//   slider -1 → exp 8        (heavy crush toward dark)
//   slider  0 → exp 1        (identity)
//   slider +1 → exp 1/8      (heavy lift toward bright)
float nano_signed_slider_exp(float slider) {
  return pow(2.0, -slider * 3.0);
}

// Apply a signed-slider power curve to a clamped scalar.
float nano_apply_curve(float x, float slider) {
  return pow(saturate(x), nano_signed_slider_exp(slider));
}

// Component-wise version for RGB.
float3 nano_apply_curve(float3 rgb, float slider) {
  float e = nano_signed_slider_exp(slider);
  return float3(pow(saturate(rgb.r), e),
                pow(saturate(rgb.g), e),
                pow(saturate(rgb.b), e));
}

#endif
