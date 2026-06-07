// gen.bounce_resonator — color pass.
//
// Each bar IS its whole 1/4-width column: fill the entire vertical strip
// with the bar's colour. Brightness = its diffusion value; HUE = its
// diffused hue (band_color's saturation + value supply the rest). Value
// and hue both slosh between bars via the cycling diffusion matrix.

#include "nano_bars.hlsl"
#include "nano_color.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float v0; float v1; float v2; float v3;
  float hue0; float hue1; float hue2; float hue3;
  float band_sat; float band_val; float intensity; float _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base = inputTex[gid.xy];

  uint bar = nano_bar_index(uv.x);
  float vs[4]  = { v0, v1, v2, v3 };
  float hues[4] = { hue0, hue1, hue2, hue3 };
  float vi = vs[bar];

  float3 col = nano_hsv_to_rgb(float3(hues[bar], band_sat, band_val));
  float3 lin = col * (intensity * vi);

  // Warm bloom: energy beyond what the saturated hue can hold (channel > 1)
  // spills as warm white, so a hot bar glows white-hot instead of clipping
  // to a flat, oversaturated colour.
  float peak = max(lin.r, max(lin.g, lin.b));
  float spill = max(peak - 1.0, 0.0);
  lin += float3(1.0, 0.85, 0.6) * spill;

  // Soft exposure rolloff (1 - e^-x): smooth highlight shoulder instead of a
  // hard clip, so highlights roll warmly into white as intensity climbs.
  float3 outc = base.rgb + (1.0 - exp(-lin));
  outputTex[gid.xy] = float4(saturate(outc), base.a);
}
