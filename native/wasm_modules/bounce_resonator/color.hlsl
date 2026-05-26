// gen.bounce_resonator — color pass.
//
// Per pixel: identify bar; compute gaussian band centered on the
// resonator's current y_i (clamped to ±position_range/2 from bar
// center); add band_color * intensity * gaussian over tex_in.
//
// Unlike plasma's hard-step rendering, soft band edges are intentional
// here — physical resonance reads better with a gradient (per spec).

#include "nano_bars.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float y0; float y1; float y2; float y3;
  float vy0; float vy1; float vy2; float vy3;          // not used in color
  float band_r; float band_g; float band_b; float intensity;
  float band_width; float band_softness; float position_range; float motion_scale; // motion_scale unused here
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base = inputTex[gid.xy];

  uint bar = nano_bar_index(uv.x);
  float ys[4] = { y0, y1, y2, y3 };
  float yi = ys[bar];

  // Clamp position to ±position_range/2 from center (so the band never
  // leaves the bar even when the oscillator swings hard).
  float half_range = max(position_range * 0.5, 0.0);
  yi = clamp(yi, -half_range, half_range);
  float band_center = 0.5 + yi;
  float d = uv.y - band_center;

  // Gaussian-like brightness. Width guard so 0 doesn't divide.
  float bw = max(band_width, 1e-4);
  float bs = max(band_softness, 1e-3);
  float arg = (d / bw) * (d / bw) * 2.0 / (bs * bs);
  float g = exp(-arg);

  float3 add = float3(band_r, band_g, band_b) * (intensity * g);
  outputTex[gid.xy] = float4(base.rgb + add, base.a);
}
