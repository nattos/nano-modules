// video.hsl — Hue rotation, saturation pull, and bipolar lightness.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float hue_shift;   // in turns
  float saturation;  // [-1, 1]
  float lightness;   // [-1, 1]
  float _pad;
};

// HSL conversion (0..1 hue, 0..1 sat, 0..1 lightness).
float3 rgb_to_hsl(float3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float l = (maxc + minc) * 0.5;
  float d = maxc - minc;
  float s = 0.0;
  float h = 0.0;
  if (d > 1e-6) {
    s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-6);
    if (maxc == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return float3(h, saturate(s), saturate(l));
}

float hue_to_rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0/2.0) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

float3 hsl_to_rgb(float3 hsl) {
  float h = frac(hsl.x);
  float s = saturate(hsl.y);
  float l = saturate(hsl.z);
  if (s < 1e-6) return float3(l, l, l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return float3(
    hue_to_rgb(p, q, h + 1.0/3.0),
    hue_to_rgb(p, q, h),
    hue_to_rgb(p, q, h - 1.0/3.0)
  );
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 hsl = rgb_to_hsl(saturate(c.rgb));

  // hue rotate (wrap into [0,1))
  hsl.x = frac(hsl.x + hue_shift + 1.0);

  // saturation: -1 → 0 (greyscale), 0 → unchanged, +1 → doubled (clamped)
  if (saturation >= 0.0) {
    hsl.y = saturate(hsl.y + (1.0 - hsl.y) * saturation);
  } else {
    hsl.y = saturate(hsl.y * (1.0 + saturation));
  }

  // lightness: bipolar lift toward white / crush toward black
  if (lightness >= 0.0) {
    hsl.z = saturate(hsl.z + (1.0 - hsl.z) * lightness);
  } else {
    hsl.z = saturate(hsl.z * (1.0 + lightness));
  }

  float3 rgb = hsl_to_rgb(hsl);
  outputTex[gid.xy] = float4(rgb, c.a);
}
