// gen.bounce_resonator — motion-vector pass.
//
// Per pixel: same per-bar gaussian footprint as the color pass; the
// motion vector emitted is (0, vy_i * motion_scale), weighted by the
// gaussian so motion intensity matches the visible band intensity.
//
// Downstream video.motion_blur consumes render_outputs/motion and
// streaks the bands during fast bounces.

#include "nano_bars.hlsl"

Texture2D<float4>   upstreamTex : register(t0);    // upstream motion (pass-through outside band)
RWTexture2D<float4> motionTex   : register(u1);    // rgba16f

cbuffer Uniforms : register(b2) {
  float y0; float y1; float y2; float y3;
  float vy0; float vy1; float vy2; float vy3;
  float band_r; float band_g; float band_b; float intensity;
  float band_width; float band_softness; float position_range; float motion_scale;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 upstream = upstreamTex[gid.xy];

  uint bar = nano_bar_index(uv.x);
  float ys[4]  = { y0, y1, y2, y3 };
  float vys[4] = { vy0, vy1, vy2, vy3 };
  float yi = ys[bar];
  float vyi = vys[bar];

  float half_range = max(position_range * 0.5, 0.0);
  yi = clamp(yi, -half_range, half_range);
  float band_center = 0.5 + yi;
  float d = uv.y - band_center;

  float bw = max(band_width, 1e-4);
  float bs = max(band_softness, 1e-3);
  float arg = (d / bw) * (d / bw) * 2.0 / (bs * bs);
  float g = exp(-arg);

  // Weighted local motion; blend over upstream by the gaussian weight.
  float2 local = float2(0.0, vyi * motion_scale * g);
  float2 mixed = lerp(upstream.xy, local, saturate(g));
  motionTex[gid.xy] = float4(mixed, 0.0, 0.0);
}
