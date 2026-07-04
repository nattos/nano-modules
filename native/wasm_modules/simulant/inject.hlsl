// filter.sim.simulant — Pass A: the difference-blend feedback injection.
//
// Faithful port of the original Simulant.wire feedback core (Video Mixers 23+20,
// both mode 11 = DIFFERENCE). Resolume's mixer is out = lerp(A, blend(A,B), op2),
// and the DIFFERENCE quirk (abs(A-B) never goes pure black, leaves halos) is the
// load-bearing behavior of the whole Simulant/Pixulant family — reproduced here.
//
//   fadedPrev = prev * (1 - choke)                       # node 23 (A = black)
//   inject    = colorize(transform(input))               # nodes 36,159,167
//   accumRaw  = lerp(fadedPrev, abs(fadedPrev-inject), injectAmount)   # node 20
//
// accumRaw (node 20's output) feeds BOTH the blur→delay feedback AND the line
// extractor. injectAmount is the flicker-envelope opacity resolved on the CPU
// (see main.cpp) — with the patch's stock knobs it is <=0 (the env is SUBTRACTED
// by default), which clamps to 0, so a fresh drop just decays: a faithful quirk.

#include "nano_color.hlsl"

Texture2D<float4>   delayPrev : register(t0);   // feedback buffer (blurred+decayed)
Texture2D<float4>   inputTex  : register(t1);   // incoming video
SamplerState        samp      : register(s2);   // Linear + ClampToEdge
RWTexture2D<float4> accumRaw  : register(u3);

cbuffer Uniforms : register(b4) {
  float choke, inject_amount, scale, pos_x;   // feedback + placement
  float pos_y, color_alpha, color_contrast, _p0;
  float color_r, color_g, color_b, _p1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  accumRaw.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  // Feedback, faded by (1 - choke) — node 23 (difference vs black = itself).
  float3 prev      = delayPrev.SampleLevel(samp, uv, 0).rgb;
  float3 fadedPrev = prev * (1.0 - choke);

  // Transform the input (scale about centre + translate) — node 36. Gather:
  // map this accum pixel back into input space. Off-frame reads inject nothing.
  float2 iuv = (uv - 0.5 - float2(pos_x, pos_y)) / max(scale, 1e-4) + 0.5;
  float3 inj = float3(0.0, 0.0, 0.0);
  if (all(iuv >= 0.0) && all(iuv <= 1.0)) {
    inj = inputTex.SampleLevel(samp, iuv, 0).rgb;
    // Colorize (node 159) — grey the input and tint by the colour, with a small
    // contrast, then crossfade against the raw input (Transition 167 by alpha).
    float g = nano_luminance(inj);
    g = saturate((g - 0.5) * (1.0 + color_contrast) + 0.5);
    float3 colorized = g * float3(color_r, color_g, color_b);
    inj = lerp(inj, colorized, color_alpha);
  }

  // DIFFERENCE blend feedback — node 20. lerp extrapolates for injectAmount<0
  // (the stock env-subtract case); clamp to Resolume's [0,1] display range.
  float3 diff  = abs(fadedPrev - inj);
  float3 accum = lerp(fadedPrev, diff, inject_amount);
  accum = clamp(accum, 0.0, 1.0);
  accum = select(accum != accum, float3(0.0, 0.0, 0.0), accum);   // NaN sanitize

  accumRaw[gid.xy] = float4(accum, 1.0);
}
