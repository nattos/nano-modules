// gen.tingle_top — render pass. Per pixel, additively accumulate every alive
// sparkle's mask contribution. Each sparkle fades over its life (alpha_curve)
// and shimmers per frame (frame_alpha_jitter) for the "tingle". Colour is a
// single hue + per-particle hue jitter. Drawn over tex_in.

#include "common.hlsl"

Texture2D<float4>      inputTex : register(t0);
RWTexture2D<float4>    outputTex : register(u1);
StructuredBuffer<Particle> parts : register(t3);

cbuffer Uniforms : register(b2) {
  uint  count; uint pool_max; uint frame_index; uint debug_region;
  float intensity; float hue; float frame_alpha_jitter; float alpha_curve;
  uint  shape_kind; float shape_param; float region_y_max; float aspect;
  float _pad0; float _pad1; float _pad2; float _pad3;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);
  float4 base = inputTex[gid.xy];
  float3 add = float3(0.0, 0.0, 0.0);

  uint n = min(count, pool_max);
  for (uint i = 0u; i < n; i++) {
    Particle p = parts[i];
    float life_remain = p.a.w;
    if (life_remain <= 0.0) continue;
    float sz = p.a.z;
    // Bounding-box reject (aspect-corrected so the dab is round on screen).
    float dx = (uv.x - p.a.x) * aspect;
    float dy = (uv.y - p.a.y);
    if (abs(dx) > sz || abs(dy) > sz) continue;

    float2 nrm = float2(dx, dy) / sz;
    float m = tt_mask(nrm, shape_kind, shape_param);
    if (m <= 0.0) continue;

    float lifeFrac = saturate(life_remain / max(p.b.x, 1e-4));
    float aLife = pow(lifeFrac, max(alpha_curve, 0.01));
    // Per-frame shimmer (the "tingle").
    float shimmer = 1.0 - frame_alpha_jitter * tt_unit(tt_pcg2(i + 0x5A5Au, frame_index));

    float3 col = tt_hsv_to_rgb(float3(hue + p.b.z, 0.7, 1.0));
    add += col * (m * aLife * shimmer * intensity);
  }

  if (debug_region != 0u && abs(uv.y - region_y_max) < (1.5 / float(H))) {
    add += float3(0.0, 0.25, 0.25);
  }

  outputTex[gid.xy] = float4(saturate(base.rgb + add), base.a);
}
