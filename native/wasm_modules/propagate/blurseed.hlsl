// filter.sim.propagate — separable Gaussian blur, used TWICE in the pipeline:
//
//  (A) Blur the SEED (low-pass the input). Clean contours require a smooth field,
//      and re-seeding the raw, full-detail input every frame turns its texture /
//      noise into thousands of tiny closed-loop contours (the "fragmented" look).
//      is_input=1 reads rgb→luma on the first (horizontal) pass.
//
//  (B) Blur the FIELD each frame. The big advection step samples far away, so any
//      per-cell noise in near-flat regions becomes random directions → a blocky
//      dither. Keeping the field smooth (is_input=0, reads .r) removes it at the
//      root while keeping the propagating fronts.
//
// Runs twice per use: horizontal then vertical. Output is RGBA16F with the
// blurred value in .r; .b is carried through from the CENTER tap unblurred (so
// the field's stored luma survives the field blur). Tap spacing scales with
// sigma so a wide blur stays cheap; the field is dynamic so tap-slide is invisible.

#include "nano_color.hlsl"

Texture2D<float4>   srcTex : register(t0);
SamplerState        samp   : register(s1);   // Linear + ClampToEdge
RWTexture2D<float4> dstTex : register(u2);    // RGBA16F, smoothed luma in .r

cbuffer Uniforms : register(b3) {
  float2 dir;        // (1,0) horizontal or (0,1) vertical
  float  step_uv;    // tap spacing in uv
  float  sigma_uv;   // Gaussian sigma in uv (0 → identity passthrough)
  float  is_input;   // 1 → read rgb→luma (pass 1); 0 → read .r (pass 2)
  float  _p0, _p1, _p2;
};

static const int N = 16;   // taps each side

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  dstTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  // Center tap — its .b (stored luma) is carried through unblurred.
  float4 center = srcTex.SampleLevel(samp, uv, 0);

  if (sigma_uv <= 1e-6) {
    float v = (is_input > 0.5) ? nano_luminance(center.rgb) : center.r;
    dstTex[gid.xy] = float4(v, 0.0, center.b, 0.0);
    return;
  }

  float acc = 0.0, wsum = 0.0;
  float inv2s2 = 1.0 / (2.0 * sigma_uv * sigma_uv);
  [loop] for (int k = -N; k <= N; k++) {
    float d = float(k) * step_uv;
    float w = exp(-d * d * inv2s2);
    float4 c = srcTex.SampleLevel(samp, uv + dir * d, 0);
    float v = (is_input > 0.5) ? nano_luminance(c.rgb) : c.r;
    acc += v * w;
    wsum += w;
  }
  dstTex[gid.xy] = float4(acc / max(wsum, 1e-5), 0.0, center.b, 0.0);
}
