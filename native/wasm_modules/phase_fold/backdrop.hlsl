// video.phase_fold — backdrop: the blended scalar field H as diverging bands.
//
// Per pixel: evaluate the height above the (blended) cycle level, band it, and
// write a muted diverging colormap. This seeds tex_out; the streamline and
// limit-cycle raster passes then blend their lines on top (render-pass LOAD).
// Port of the prototype's BANDS_WGSL fragment, as a compute storage-tex write.

#include "field.hlsl"

RWTexture2D<float4> outTex : register(u2);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float2 vp = float2(res_x, res_y);
  if (gid.x >= (uint)res_x || gid.y >= (uint)res_y) return;

  // Hole (all four corners invalid): dark, no field.
  if (pf_weight_sum() < 1e-4) {
    outTex[gid.xy] = float4(0.04, 0.04, 0.06, 1.0);
    return;
  }

  float2 p = pf_pixel_to_p(float2(gid.xy), vp);
  float d = pf_blended_height(p);
  float val = saturate(0.5 + (d - bias) * contrast);
  float band = floor(val * n_bands) / max(n_bands - 1.0, 1.0);
  // Mute the backdrop so the flow lines pop on top of it.
  float3 dim = lerp(float3(0.07, 0.07, 0.09), pf_diverging(band), backdrop_dim);
  outTex[gid.xy] = float4(dim, 1.0);
}
