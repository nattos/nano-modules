// filter.sim.simulant — separable RGB Gaussian blur (Pixel Blur, nodes 30 + 67).
//
// Used TWICE per frame, each as an H then V pass:
//   (1) WAVE blur: the big feedback blur (distance = 200px * WaveSpeed). Repeated
//       every frame, this diffusion IS the outward propagation of the original —
//       there is no wave equation and no zoom-feedback; the "wave" is a blur loop.
//       The V pass also applies the WaveSpeed-tied contrast darkening (node 31)
//       via `gain` (= 1 + contrast) so trailing frames fade.
//   (2) SMOOTHING blur: a small pre-edge blur (node 67, Smoothing) that softens
//       accumRaw before the line extractor so the Sobel traces clean contours.
//
// sigma/step are in uv; taps scale with sigma so a wide blur stays cheap.

Texture2D<float4>   srcTex : register(t0);
SamplerState        samp   : register(s1);   // Linear + ClampToEdge
RWTexture2D<float4> dstTex : register(u2);

cbuffer Uniforms : register(b3) {
  float2 dir;        // (1,0) horizontal or (0,1) vertical
  float  step_uv;    // tap spacing in uv
  float  sigma_uv;   // Gaussian sigma in uv (<=0 → identity)
  float  contrast;   // Bright.Contrast about 0.5 (node 31 wave decay; 0 = none)
  float  _p0, _p1, _p2;
};

static const int N = 16;   // taps each side

// Bright.Contrast (node 31): pivots about mid-grey. The stock WaveSpeed-tied
// contrast is tiny + negative → each feedback pass creeps toward 0.5, which the
// difference blend then churns (it does NOT fade to black — a faithful quirk).
float3 apply_contrast(float3 c) {
  return saturate((c - 0.5) * (1.0 + contrast) + 0.5);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  dstTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  if (sigma_uv <= 1e-6) {
    dstTex[gid.xy] = float4(apply_contrast(srcTex.SampleLevel(samp, uv, 0).rgb), 1.0);
    return;
  }

  float3 acc = float3(0.0, 0.0, 0.0);
  float  wsum = 0.0;
  float  inv2s2 = 1.0 / (2.0 * sigma_uv * sigma_uv);
  [loop] for (int k = -N; k <= N; k++) {
    float d = float(k) * step_uv;
    float w = exp(-d * d * inv2s2);
    acc  += srcTex.SampleLevel(samp, uv + dir * d, 0).rgb * w;
    wsum += w;
  }
  dstTex[gid.xy] = float4(apply_contrast(acc / max(wsum, 1e-5)), 1.0);
}
