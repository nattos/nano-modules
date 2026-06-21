// nano_histogram.hlsl — shared histogram → CDF helpers for auto-leveling.
//
// The auto-level pattern (source.shape_fold, color.tone.auto_level) buckets a scalar
// field/image into a fixed-size histogram via atomic scatter, then a single-
// thread pass inverts that histogram into a remap curve. The CLAHE-clipped
// cumulative distribution and the percentile lookup are identical across those
// effects, so they live here. The per-effect LUT passes still own how they
// SHAPE the final curve from the CDF (median→0 signed grade vs. 0..1 remap).
//
// Fixed NB = 256 bins (matches the storage-buffer layouts that feed it). The
// stats buffer convention is the caller's: pass the base offset of the bin run.

#ifndef NANO_HISTOGRAM_HLSL
#define NANO_HISTOGRAM_HLSL

#define NANO_HIST_NB 256

// Bin index for value v within [lo, hi], clamped to [0, NB-1].
int nano_hist_bin(float v, float lo, float hi) {
  float t = clamp((v - lo) / max(hi - lo, 1e-5), 0.0, 0.99999);
  return (int)(t * float(NANO_HIST_NB));
}

// CLAHE-clipped, normalized cumulative distribution from a histogram stored at
// stats[base .. base+NB-1]. `clip` caps each bin at `clip × mean` (e.g. 5.0)
// so a dominant flat region can't pin the equalization onto itself; the clipped
// excess is redistributed uniformly (mass-conserving). Fills cdf[0..NB-1] in
// ascending order, ending at 1.0. Intended for single-thread LUT passes.
void nano_hist_cdf(StructuredBuffer<int> stats, uint base, float clip,
                   out float cdf[NANO_HIST_NB]) {
  float total = 0.0;
  for (uint i = 0u; i < NANO_HIST_NB; i++) total += float(stats[base + i]);
  total = max(total, 1.0);

  float cap = clip * (total / float(NANO_HIST_NB));
  float excess = 0.0;
  for (uint j = 0u; j < NANO_HIST_NB; j++) excess += max(float(stats[base + j]) - cap, 0.0);
  float add = excess / float(NANO_HIST_NB);

  float acc = 0.0;
  for (uint k = 0u; k < NANO_HIST_NB; k++) {
    float hc = min(float(stats[base + k]), cap) + add;
    acc += hc;
    cdf[k] = acc / total;
  }
}

// Value (bin-center, in [lo, hi]) at which the CDF first reaches `frac`. e.g.
// frac = 0.5 → the median, 0.02 / 0.98 → the 2nd / 98th percentiles.
float nano_hist_percentile(float cdf[NANO_HIST_NB], float lo, float hi, float frac) {
  float range = hi - lo;
  for (uint i = 0u; i < NANO_HIST_NB; i++) {
    if (cdf[i] >= frac) return lo + (float(i) + 0.5) / float(NANO_HIST_NB) * range;
  }
  return hi;
}

#endif // NANO_HISTOGRAM_HLSL
