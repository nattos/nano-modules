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
  float g = saturate((F * 0.5 + 0.5) * levelStrength);
  float3 rgb = (output_mode > 0.5) ? sf_magma(g) : float3(g, g, g);
  outTex[gid.xy] = float4(rgb, 1.0);
}
