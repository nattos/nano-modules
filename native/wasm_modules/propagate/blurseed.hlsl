// filter.sim.propagate — Pass 0: blur the seed (low-pass the input).
//
// Clean contours require a SMOOTH field. The dominant source of high-frequency
// detail is re-seeding the raw, full-detail input every frame — its texture /
// noise turns into thousands of tiny closed-loop contours (the "fragmented"
// look). So before the input ever enters the sim we low-pass its luma with a
// separable Gaussian (this is the Blur / Resize stage the original Simulant
// leaned on). Run twice: horizontal then vertical.
//
//   pass 1 (is_input=1): read the raw input rgb → luma, blur along X → scratch.
//   pass 2 (is_input=0): read the scratch .r, blur along Y → seed texture.
//
// Output is RGBA16F with the smoothed luma in .r. Tap spacing scales with sigma
// so a wide blur stays cheap; the field is dynamic so the mild tap-slide shimmer
// is invisible.

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

  // Sample-and-luma helper inlined below (HLSL has no closures).
  if (sigma_uv <= 1e-6) {
    float4 c = srcTex.SampleLevel(samp, uv, 0);
    float v = (is_input > 0.5) ? nano_luminance(c.rgb) : c.r;
    dstTex[gid.xy] = float4(v, 0.0, 0.0, 0.0);
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
  dstTex[gid.xy] = float4(acc / max(wsum, 1e-5), 0.0, 0.0, 0.0);
}
