// video.flow_swarm — fragment shader.
//
// Color = captured-input ↔ solid blend (the default look), optionally tinted
// toward a flow-direction/speed hue. Alpha = life fade × opacity × shape mask.
// Straight (non-premultiplied) output; the PSO's blend factors multiply rgb by
// alpha, so the same shader serves both the alpha-over and additive PSOs.

#include "common.hlsl"

cbuffer Uniforms : register(b2) {
  float color_blend;     // 0 = captured input color, 1 = solid_color
  float solid_r;
  float solid_g;
  float solid_b;

  float tint_by_flow;    // 0 = off, 1 = full hue-by-direction tint
  float opacity;         // global alpha multiplier
  float alpha_curve;     // life-fade exponent
  float shape_param;

  uint  shape_kind;      // 0 solid · 1 circle · 2 gaussian
  float exposure;        // rgb multiplier (clips to white in rgba8)
  float _pad0;
  float _pad1;
};

[shader("pixel")]
float4 main(VsOut i) : SV_Target0 {
  float mask = fsw_mask(i.corner, shape_kind, shape_param);
  if (mask <= 0.0) discard;

  float life_norm = i.col_life.w;
  float alpha = pow(saturate(life_norm), max(alpha_curve, 1e-3)) * saturate(opacity) * mask;
  if (alpha <= 0.0) discard;

  float3 base = lerp(i.col_life.rgb, float3(solid_r, solid_g, solid_b),
                     saturate(color_blend));

  // Optional flow tint: hue from velocity direction, brightness from speed.
  if (tint_by_flow > 1e-3) {
    float hue = frac(atan2(i.vel.y, i.vel.x) / 6.28318530718 + 0.5);
    float val = saturate(i.vel.z * 4.0);
    float3 flow_col = fsw_hsv_to_rgb(float3(hue, 0.85, max(val, 0.3)));
    base = lerp(base, flow_col, saturate(tint_by_flow));
  }

  base *= max(exposure, 0.0);
  return float4(base, alpha);
}
