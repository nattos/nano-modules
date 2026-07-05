// filter.reconstruct.line — pass 6: reconstruction + composite.
//
// Final version reads the analysis textures and repaints crisp lines/points +
// deband, gated and hierarchically composited (strength enters ONLY here). While
// the branches are built up incrementally, debug_view != 0 renders an internal
// classifier stage (from the SMOOTHED fields), and debug_view == 0 is passthrough.

#include "common.hlsl"
#include "nano_color.hlsl"   // nano_hsv_to_rgb (orientation-hue debug)

Texture2D<float4>   inputTex : register(t0);
Texture2D<float4>   s0Tex    : register(t1);   // smoothed (cos2t, sin2t, w_est, -)
Texture2D<float4>   s1Tex    : register(t2);   // (w_line_s, w_point_s, w_grad_s, ori_coh)
Texture2D<float4>   sdTex    : register(t3);   // (delta_shared, trust, -, -)
RWTexture2D<float4> outputTex: register(u4);
cbuffer Uniforms : register(b5) { LRUniforms u; };

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c  = inputTex[gid.xy];
  float4 S0 = s0Tex[gid.xy];
  float4 S1 = s1Tex[gid.xy];

  float3 outrgb = c.rgb;   // passthrough default (real composite lands next stage)

  if (u.debug_view == 1u) {
    // Class: line=red, point=green, gradient=blue (smoothed weights).
    outrgb = saturate(S1.xyz);
  } else if (u.debug_view == 2u) {
    // Width: w_est / max_width, gated to line pixels.
    float g = lr_smoothstep(0.15, 0.35, S1.x);
    outrgb = (S0.z / max(u.max_width, 1e-3)).xxx * g;
  } else if (u.debug_view == 3u) {
    // Orientation hue (double-angle of the line normal), value = line weight.
    float ang = atan2(S0.y, S0.x);
    float hue = frac(ang / 6.2831853 + 0.5);
    outrgb = nano_hsv_to_rgb(float3(hue, 1.0, saturate(S1.x)));
  } else if (u.debug_view == 4u) {
    // Centerline: signed shared delta (red = +, blue = −), gated to line pixels.
    float d = sdTex[gid.xy].x;
    float g = lr_smoothstep(0.15, 0.35, S1.x);
    outrgb = float3(saturate(d), 0.0, saturate(-d)) * g + 0.05 * g;
  } else if (u.debug_view == 5u) {
    // Coherence: orientation coherence (the crossing veto), grayscale.
    outrgb = saturate(S1.w).xxx;
  }

  outputTex[gid.xy] = float4(saturate(outrgb), c.a);
}
