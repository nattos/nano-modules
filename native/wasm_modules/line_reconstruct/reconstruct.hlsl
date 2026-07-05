// filter.reconstruct.line — pass 6: reconstruction + composite.
//
// Final version reads the analysis textures and repaints crisp lines/points +
// deband, gated and hierarchically composited (strength enters ONLY here). While
// the branches are built up incrementally, debug_view != 0 renders an internal
// classifier stage (validates detection before the reconstruction lands), and
// debug_view == 0 is a passthrough.

#include "common.hlsl"
#include "nano_color.hlsl"   // nano_hsv_to_rgb (orientation-hue debug)

Texture2D<float4>   inputTex : register(t0);
Texture2D<float4>   m0Tex    : register(t1);   // (cos2t, sin2t, w_est, delta)
Texture2D<float4>   m1Tex    : register(t2);   // (w_line, w_point, w_grad, polarity)
RWTexture2D<float4> outputTex: register(u3);
cbuffer Uniforms : register(b4) { LRUniforms u; };

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c  = inputTex[gid.xy];
  float4 M0 = m0Tex[gid.xy];
  float4 M1 = m1Tex[gid.xy];

  float3 outrgb = c.rgb;   // passthrough default (real composite lands next stage)

  if (u.debug_view == 1u) {
    // Class: line=red, point=green, gradient=blue (raw confidences).
    outrgb = float3(saturate(M1.x), saturate(M1.y), saturate(M1.z));
  } else if (u.debug_view == 2u) {
    // Width: w_est / max_width, gated to line pixels.
    float g = lr_smoothstep(0.15, 0.35, M1.x);
    outrgb = (M0.z / max(u.max_width, 1e-3)).xxx * g;
  } else if (u.debug_view == 3u) {
    // Orientation hue (double-angle of the line normal), value = line weight.
    float ang = atan2(M0.y, M0.x);              // in [-pi, pi]
    float hue = frac(ang / 6.2831853 + 0.5);
    outrgb = nano_hsv_to_rgb(float3(hue, 1.0, saturate(M1.x)));
  }

  outputTex[gid.xy] = float4(saturate(outrgb), c.a);
}
