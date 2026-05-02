// nano_color.hlsl — Luminance + RGB↔HSL/HSV conversions.
//
// See EFFECTS_STYLE_GUIDE.md §3.4 (non-RGB working spaces).

#ifndef NANO_COLOR_HLSL
#define NANO_COLOR_HLSL

// Rec. 601 luma — a sensible "perceptual brightness" default for video.
float nano_luminance(float3 rgb) {
  return dot(rgb, float3(0.299, 0.587, 0.114));
}

// ---- HSL ----
// Hue, saturation, lightness all in [0, 1]. Hue wraps via frac().

float3 nano_rgb_to_hsl(float3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float l = (maxc + minc) * 0.5;
  float d = maxc - minc;
  float s = 0.0;
  float h = 0.0;
  if (d > 1e-6) {
    s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-6);
    if      (maxc == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return float3(h, saturate(s), saturate(l));
}

float _nano_hue_to_rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

float3 nano_hsl_to_rgb(float3 hsl) {
  float h = frac(hsl.x);
  float s = saturate(hsl.y);
  float l = saturate(hsl.z);
  if (s < 1e-6) return float3(l, l, l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return float3(
    _nano_hue_to_rgb(p, q, h + 1.0 / 3.0),
    _nano_hue_to_rgb(p, q, h),
    _nano_hue_to_rgb(p, q, h - 1.0 / 3.0)
  );
}

// ---- HSV ----
// Same hue/saturation conventions as HSL; value (V) is just maxc.

float3 nano_rgb_to_hsv(float3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float v = maxc;
  float d = maxc - minc;
  float s = (maxc > 1e-6) ? d / maxc : 0.0;
  float h = 0.0;
  if (d > 1e-6) {
    if      (maxc == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return float3(h, saturate(s), saturate(v));
}

float3 nano_hsv_to_rgb(float3 hsv) {
  float h = frac(hsv.x) * 6.0;
  float s = saturate(hsv.y);
  float v = saturate(hsv.z);
  float c = v * s;
  float x = c * (1.0 - abs(fmod(h, 2.0) - 1.0));
  float m = v - c;
  float3 rgb;
  if      (h < 1.0) rgb = float3(c, x, 0.0);
  else if (h < 2.0) rgb = float3(x, c, 0.0);
  else if (h < 3.0) rgb = float3(0.0, c, x);
  else if (h < 4.0) rgb = float3(0.0, x, c);
  else if (h < 5.0) rgb = float3(x, 0.0, c);
  else              rgb = float3(c, 0.0, x);
  return rgb + m;
}

#endif
