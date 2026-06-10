// video.shape_fold — auto-levels pass 3: invert the histogram into a remap LUT.
//
// Single-invocation pass (port of buildLUT in app.js). Median → 0, contrast
// leveled; `gaussian` blends a linear two-sided percentile stretch (0) with the
// histogram-equalized CDF (1). `level_clip` is a CLAHE-style bin cap so a
// dominant flat region (e.g. a big plain background) can't pin the median onto
// itself. Writes LUT[0..NB-1] plus lo/hi and a blank flag for present.

#include "common.hlsl"

StructuredBuffer<int>     stats : register(t1);   // [0]=lo, [1]=hi, [2..]=hist[NB]
RWStructuredBuffer<float> lut   : register(u2);   // [0..NB-1]=LUT, [NB]=lo, [NB+1]=hi, [NB+2]=blank

groupshared float gCdf[SF_NB];

[numthreads(1, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float lo = asfloat(stats[0]);
  float hi = asfloat(stats[1]);
  lut[SF_NB + 0] = lo;
  lut[SF_NB + 1] = hi;

  // Constant/empty field: no contrast → neutral 0 LUT, flagged blank.
  if (hi - lo <= 1e-5) {
    lut[SF_NB + 2] = 1.0;
    for (uint i = 0u; i < SF_NB; i++) lut[i] = 0.0;
    return;
  }
  lut[SF_NB + 2] = 0.0;

  // CLAHE clip cap + redistribution. Clipping conserves mass, so the clipped
  // total still equals `total` — cdf normalizes by `total` directly.
  float total = 0.0;
  for (uint i = 0u; i < SF_NB; i++) total += float(stats[2u + i]);
  total = max(total, 1.0);

  bool doClip = level_clip > 0.0;
  float cap = doClip ? (level_clip * (total / float(SF_NB))) : 1e30;
  float excess = 0.0;
  if (doClip)
    for (uint i = 0u; i < SF_NB; i++) excess += max(float(stats[2u + i]) - cap, 0.0);
  float add = doClip ? (excess / float(SF_NB)) : 0.0;

  float acc = 0.0;
  for (uint i = 0u; i < SF_NB; i++) {
    float hc = min(float(stats[2u + i]), cap) + add;
    acc += hc;
    gCdf[i] = acc / total;
  }

  // Two-sided percentiles: median → 0, [2%,98%] → ±1. valAt(i) = lo + (i+0.5)/NB·range.
  float range = hi - lo;
  float median = hi, p02 = hi, p98 = hi;
  bool gotM = false, got02 = false, got98 = false;
  for (uint i = 0u; i < SF_NB; i++) {
    float v = lo + (float(i) + 0.5) / float(SF_NB) * range;
    if (!got02 && gCdf[i] >= 0.02) { p02 = v; got02 = true; }
    if (!gotM  && gCdf[i] >= 0.5)  { median = v; gotM = true; }
    if (!got98 && gCdf[i] >= 0.98) { p98 = v; got98 = true; }
  }
  float loSpread = max(median - p02, 1e-4);
  float hiSpread = max(p98 - median, 1e-4);

  for (uint i = 0u; i < SF_NB; i++) {
    float v = lo + float(i) / float(SF_NB - 1u) * range;
    int bin = (int)clamp(floor((v - lo) / (range + 1e-9) * float(SF_NB)), 0.0, float(SF_NB - 1u));
    float lin = (v >= median) ? (v - median) / hiSpread : (v - median) / loSpread;
    float linPos = 0.5 + 0.5 * clamp(lin, -1.0, 1.0);
    float pos = linPos * (1.0 - gaussian) + gCdf[bin] * gaussian;
    lut[i] = 2.0 * pos - 1.0;            // median → 0, both sides span [-1, 1]
  }
}
