// video.phase_fold — backdrop: the field rendered in the selected shading mode.
//
//   shading_mode 0 (Bands)    — height above the (blended) cycle level, banded
//                               as a muted diverging colormap (the default).
//   shading_mode 1 (Gradient) — the blended FLOW field v = level-set flow +
//                               WIND(z) as a directional flow visualization:
//                               direction → hue, speed → brightness. Because it
//                               reads pf_velocity it inherently includes wind, so
//                               the colours swirl and shift as wind ramps.
//
// This seeds tex_out; the streamline and limit-cycle raster passes then blend
// their lines on top (render-pass LOAD).

#include "field.hlsl"
#include "nano_color.hlsl"

RWTexture2D<float4> outTex : register(u2);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float2 vp = float2(res_x, res_y);
  if (gid.x >= (uint)res_x || gid.y >= (uint)res_y) return;

  // Hole (all four corners invalid): dark, no field.
  if (pf_weight_sum() < 1e-4) {
    outTex[gid.xy] = float4(0.04, 0.04, 0.06, 1.0);
    return;
  }

  float2 p = pf_pixel_to_p(float2(gid.xy), vp);

  if (shading_mode > 0.5) {
    // Gradient (flow field) — direction → hue, speed → brightness. WIND is
    // baked into pf_velocity, so this responds to the wind parameter.
    float2 v = pf_velocity(p);
    float hue = frac(atan2(v.y, v.x) / PF_TWO_PI + 0.5);
    float val = saturate(length(v) * contrast * 0.6);
    float3 rgb = nano_hsv_to_rgb(float3(hue, 0.85, val));
    // Mute toward a near-black base so the flow lines still pop on top.
    float3 dim = lerp(float3(0.05, 0.05, 0.07), rgb, backdrop_dim + 0.25);
    outTex[gid.xy] = float4(dim, 1.0);
    return;
  }

  // Bands — height above the blended cycle level, discretized + diverging.
  float d = pf_blended_height(p);
  float bval = saturate(0.5 + (d - bias) * contrast);
  float band = floor(bval * n_bands) / max(n_bands - 1.0, 1.0);
  float3 dim = lerp(float3(0.07, 0.07, 0.09), pf_diverging(band), backdrop_dim);
  outTex[gid.xy] = float4(dim, 1.0);
}
