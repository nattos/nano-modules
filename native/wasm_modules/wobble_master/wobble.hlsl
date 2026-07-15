// warp.legacy.wobble_master — traveling radial pulse ("shockwave") wobble +
// chromatic afterglow.
//
// Each trigger injects a wave PACKET that emanates from the centre and travels
// outward: a ring-shaped radial push with a half-sine leading edge (`width`)
// and an exponential tail, so only what's under the wave distorts. This is the
// analytic form of the Wire patch's 1-D scrolling pulse buffer (a bump injected
// at r=0 each frame, advected outward, rendered as a radial gradient and
// multiplied by a conic direction field). The chroma split is gated by its own
// slower-decaying trail of the same packets — the prismatic "afterglow" the
// Wire patch keeps in a 0.956/frame feedback buffer — so colour fringing
// lingers where the wave has passed even after the geometry recovers.
// `floor_amt` adds a standing concentric sine (the legacy manual mode).

#include "nano_chroma.hlsl"

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float drift;      // carrier phase (accumulated, rings)
  float freq;       // carrier spatial frequency (# rings)
  float amp;        // resolved displacement amplitude (uv, short-axis fraction)
  float chroma;     // resolved chroma split reach (uv, short-axis fraction)
  float hue_shift;  // YIQ hue rotation of the split (radians)
  float center_x;   // pulse centre (uv)
  float center_y;
  float ripple;     // texture under the wave: clean push (0) → oscillation (1)
  float aspect_x;   // min(W,H)/W
  float aspect_y;   // min(W,H)/H
  float floor_amt;  // standing concentric-sine floor (legacy manual mode)
  float width;      // packet leading-edge width (r units, > 0)
  float4 fronts;    // per-pulse front radius (r units); large negative = inactive
  float tail_len;   // displacement decay length behind a front (r units, > 0)
  float chroma_len; // chroma afterglow decay length (r units, > 0)
  float _p0, _p1;
};

static const float TAU     = 6.28318530717958647692;
static const float HALF_PI = 1.57079632679489661923;

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv  = (float2(gid.xy) + 0.5) / float2(W, H);
  float2 asp = float2(aspect_x, aspect_y);

  // Circular distance/direction from the centre (equal pixel units on both
  // axes → the rings are round on any aspect).
  float2 pc = (uv - float2(center_x, center_y)) / asp;
  float r = length(pc);
  float2 dir = (r > 1e-5) ? pc / r : float2(0.0, 0.0);

  // Sum the traveling packets. `on`/`max` masking (not `continue`) so the
  // inactive lanes never feed a positive argument into exp().
  float push = 0.0;   // displacement field under/behind the fronts
  float glow = 0.0;   // chroma afterglow field (longer decay)
  [unroll]
  for (int i = 0; i < 4; i++) {
    float xr = fronts[i] - r;            // distance behind this pulse's front
    float on = (xr >= 0.0) ? 1.0 : 0.0;
    float x  = max(xr, 0.0);
    float edge = sin(min(x / width, 1.0) * HALF_PI);
    push += on * edge * exp(-x / tail_len);
    glow += on * edge * exp(-x / chroma_len);
  }

  float carrier = sin(r * freq * TAU - drift * TAU);
  float fade = smoothstep(0.0, 0.06, r);   // singularity guard at the centre
  float m = fade * (push * (1.0 - ripple + ripple * carrier) + floor_amt * carrier);
  float2 disp = dir * m * amp;             // in circular units

  // Chroma split rides its own field so the fringe survives behind the wave
  // (independent of the instantaneous displacement).
  float cf = fade * saturate(glow + floor_amt * abs(carrier)) * chroma;
  float2 cvec = dir * cf;

  // Convert back to uv via `asp` (round → uv). Red pushed out, blue pulled in.
  float2 sR = (disp + cvec) * asp;
  float2 sG = disp * asp;
  float2 sB = (disp - cvec) * asp;

  float4 col = nano_chroma_offset(inputTex, linearSampler, uv, sR, sG, sB, hue_shift);
  outputTex[gid.xy] = col;
}
