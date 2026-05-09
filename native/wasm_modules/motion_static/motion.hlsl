// debug.motion_static — motion pass.
//
// Computes the same per-pixel velocity as the colour pass and writes
// it to the rgba16float motion texture. Pixels below the noise
// threshold inherit `upstreamMotion` — the upstream effect's
// render_outputs/motion when our render_outputs_in is connected, or
// zero otherwise (1x1 fallback texture; out-of-bounds loads return
// zero per WebGPU spec). Active pixels override with this stage's
// local velocity.
//
// This per-pixel sparseness is what makes the effect a stress test for
// downstream tile-based velocity reductions (e.g. McGuire reconstruction).

#include "common.hlsl"

RWTexture2D<float4> motionTex      : register(u0);
Texture2D<float4>   upstreamMotion : register(t2);

cbuffer Uniforms : register(b1) {
  float threshold;
  float swirl;
  float jitter;
  float seed;
  // Below: ignored by motion pass. Layout MUST match color.hlsl so a
  // single CPU-side uniform buffer binds cleanly into both shaders.
  float _pad_opacity;
  float _pad_vis_scale;
  float _pad0;
  float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 v = ms_motion_at(gid.xy, float2(w, h), threshold, swirl, jitter, seed);
  // ms_motion_at returns exactly (0, 0) for sub-threshold pixels; use
  // a length test rather than a separate activation flag so the local
  // path stays a drop-in replacement.
  float2 upstream = upstreamMotion[gid.xy].xy;
  float2 out_vel = (length(v) > 0.0) ? v : upstream;
  motionTex[gid.xy] = float4(out_vel.x, out_vel.y, 0.0, 0.0);
}
