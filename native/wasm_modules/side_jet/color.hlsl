// gen.side_jet — color pass.
//
// JPL-style horizontal jet trail. For each pixel, iterate active jets;
// each contributes brightness = radial_falloff × axial_decay × diamonds × turbulence.
// Color: brightness-driven lerp between edge color (dim) and core color (bright).

#include "nano_hash.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float intensity;
  float head_width;
  float cone_tan;
  float trail_length;

  float axial_decay_curve;
  float radial_sharpness;
  float diamond_amp;
  float diamond_period;

  float shimmer_phase;
  float turb_amp;
  float turb_scale;
  float turb_phase;

  float core_r;
  float core_g;
  float core_b;
  float _pad0;

  float edge_r;
  float edge_g;
  float edge_b;
  float _pad1;

  uint  active_count;
  uint  debug_show_axis;
  uint  _pad2;
  uint  _pad3;
};

struct GpuJet {
  float head_x;
  float dir;             // +1 (LtoR) or -1 (RtoL)
  float centerline_y;
  float transit_seconds; // for motion-vector pass
  float color_seed;
  float _pp0;
  float _pp1;
  float _pp2;
};
StructuredBuffer<GpuJet> jets : register(t3);

static const float TAU = 6.28318530717958;

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base = inputTex[gid.xy];

  float3 add_rgb = float3(0.0, 0.0, 0.0);
  float total_brightness = 0.0;
  bool axis_hit = false;

  uint N = active_count;
  if (N > 16u) N = 16u;
  for (uint i = 0u; i < N; i++) {
    GpuJet j = jets[i];
    // dx > 0 inside the trail (behind the head along motion direction).
    float dx = (j.head_x - uv.x) * j.dir;
    if (dx < 0.0 || dx > trail_length) continue;
    float dy = uv.y - j.centerline_y;

    float cone_hw = head_width + cone_tan * dx;
    if (abs(dy) > cone_hw) continue;

    float rn = dy / max(cone_hw, 1e-5);
    float radial = exp(-rn * rn * radial_sharpness);
    float axial_lin = saturate(1.0 - dx / max(trail_length, 1e-5));
    float axial = pow(max(axial_lin, 1e-5), max(axial_decay_curve, 0.01));
    float diamonds = 1.0 + diamond_amp *
        cos(TAU * (dx / max(diamond_period, 1e-5) + shimmer_phase + j.color_seed));
    float turb = 1.0 + turb_amp * (nano_fbm2(
        float2(dx * turb_scale, dy * turb_scale + turb_phase + j.color_seed * 17.3), 4) - 0.5);

    float brightness = radial * axial * diamonds * turb;
    if (brightness <= 0.0) continue;

    // Brightness-driven core/edge mix (per spec §691 default).
    float3 c = lerp(
        float3(edge_r, edge_g, edge_b),
        float3(core_r, core_g, core_b),
        saturate(brightness));
    add_rgb += c * brightness;
    total_brightness += brightness;

    if (debug_show_axis != 0u && abs(dy) < (1.5 / float(h))) axis_hit = true;
  }

  float3 final_rgb = base.rgb + add_rgb * intensity;
  if (axis_hit) final_rgb = float3(1.0, 0.0, 0.5);
  outputTex[gid.xy] = float4(saturate(final_rgb), base.a);
}
