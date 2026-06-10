// video.auto_level — pass 3: invert the histogram into the remap curve.
//
// Single-invocation pass. Builds a 0..1 → 0..1 monotone curve as the
// composition of two weighted options:
//
//   A(t) = lerp(identity, equalized, equalize)
//        identity reproduces the input value (lo + t·range); equalized is the
//        CLAHE-clipped CDF (flat output histogram). equalize ∈ [0,1] weights.
//
//   final(t) = lerp(A(t), pow(A(t), gamma), median_pull)
//        gamma maps the post-equalize median m → median_target, so the median
//        slides toward the target; median_pull ∈ [0,1] weights how far.
//
// Both endpoints stay fixed (0→0, 1→1), so neutral params (equalize = 0,
// median_pull = 0) reproduce the input exactly. Writes LUT[0..NB-1] plus
// lo/hi and a blank flag for the apply pass.

#include "common.hlsl"

static const float AL_CLIP = 5.0;   // CLAHE flat-region bin cap (× mean)

StructuredBuffer<int>     stats : register(t1);   // [0]=lo, [1]=hi, [2..]=hist[NB]
RWStructuredBuffer<float> lut   : register(u2);   // [0..NB-1]=LUT, [NB]=lo, [NB+1]=hi, [NB+2]=blank

[numthreads(1, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float lo = asfloat(stats[0]);
  float hi = asfloat(stats[1]);
  lut[AL_NB + 0] = lo;
  lut[AL_NB + 1] = hi;

  // Constant luminance: no distribution to reshape → flag blank (apply passes
  // the input through untouched).
  if (hi - lo <= 1e-5) {
    lut[AL_NB + 2] = 1.0;
    for (uint i = 0u; i < AL_NB; i++) lut[i] = lo;
    return;
  }
  lut[AL_NB + 2] = 0.0;

  float range = hi - lo;
  float cdf[NANO_HIST_NB];
  nano_hist_cdf(stats, 2u, AL_CLIP, cdf);

  // Post-equalize median position: identity output med_v, equalized output 0.5.
  float med_v = nano_hist_percentile(cdf, lo, hi, 0.5);
  float m   = clamp(lerp(med_v, 0.5, equalize), 1e-3, 1.0 - 1e-3);
  float tgt = clamp(median_target, 1e-3, 1.0 - 1e-3);
  float gamma = clamp(log(tgt) / log(m), 0.1, 10.0);   // maps m → tgt

  for (uint i = 0u; i < AL_NB; i++) {
    float t     = float(i) / float(AL_NB - 1u);
    float ident = lo + t * range;                 // reproduces the input value
    float A     = lerp(ident, cdf[i], equalize);  // equalize option
    float B     = pow(saturate(max(A, 1e-4)), gamma);
    lut[i] = lerp(A, B, median_pull);             // median-pull option
  }
}
