// video.shape_fold — present: the auto-leveled field as grayscale or magma.
//
// The square [-1,1]² field COVERS the (possibly non-square) viewport uniformly
// — the long axis spans ±1, the short axis is cropped, no bars — then zoomed by
// `domain_scale` (the SDFs are periodic, so there's always more to reveal; we
// never mask anything out). The field is remapped through the auto-levels LUT
// (median → 0), eased toward black at low contrast, and shown grayscale or
// magma. No line / contour / shading modes — the raw field is the output
// (downstream styles it).

#include "common.hlsl"

StructuredBuffer<float> lut    : register(t1);   // [0..NB-1]=LUT, [NB]=lo, [NB+1]=hi, [NB+2]=blank
RWTexture2D<float4>     outTex : register(u2);

// Juicy rolloff: lift the mids, add an S-curve for contrast pop, and a soft
// highlight shoulder so the bright ridges glow instead of clipping to flat
// white. Applied on every colormap path; grayscale stays a faithful linear
// readout for downstream effects.
float sf_juice(float x) {
  x = saturate(x);
  x = pow(x, 0.82);                            // lift mids — warmer, juicier
  float s = x * x * (3.0 - 2.0 * x);           // smoothstep S-curve (rolls off both ends)
  return saturate(lerp(x, s, 0.55));           // partial S → contrast without crushing
}

float sf_apply_levels(float F, float lo, float hi) {
  float t = saturate((F - lo) / max(hi - lo, 1e-5)) * float(SF_NB - 1u);
  uint i0 = (uint)floor(t);
  uint i1 = min(i0 + 1u, SF_NB - 1u);
  return lerp(lut[i0], lut[i1], frac(t));
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float2 vp = float2(res_x, res_y);
  if (gid.x >= (uint)res_x || gid.y >= (uint)res_y) return;

  // Cover the viewport: uniform scale by the LONG axis, so the square fills the
  // frame (short axis cropped) with no bars. The field is periodic, so the
  // cropped overflow is just more pattern — nothing to mask.
  float mx = max(vp.x, vp.y);
  float2 sq = (float2(gid.xy) + 0.5 - 0.5 * vp) / (0.5 * mx);

  float lo = lut[SF_NB + 0];
  float hi = lut[SF_NB + 1];
  float blank = lut[SF_NB + 2];
  if (blank > 0.5) { outTex[gid.xy] = float4(0, 0, 0, 1); return; }

  float2 p = sq * domain_scale;
  float F0 = sf_field_at(p);
  float F = sf_apply_levels(F0, lo, hi);                 // leveled: median → 0, ~[-1,1]
  float levelStrength = smoothstep(0.0, max(level_ease, 1e-5), hi - lo);
  // Exposure drives the median-centered value before grading: >1 pushes brights
  // into the rolloff, <1 pulls toward mid.
  float g = saturate((F * exposure * 0.5 + 0.5) * levelStrength);
  float3 rgb;
  if (output_mode < 0.5) {
    rgb = float3(g, g, g);                 // Grayscale — linear readout
  } else {
    float j = sf_juice(g);                 // shared juicy rolloff
    if      (output_mode < 1.5) rgb = sf_magma(j);
    else if (output_mode < 2.5) rgb = sf_inferno(j);
    else if (output_mode < 3.5) rgb = sf_viridis(j);
    else if (output_mode < 4.5) rgb = sf_plasma(j);
    else                        rgb = sf_turbo(j);
  }
  outTex[gid.xy] = float4(rgb, 1.0);
}
