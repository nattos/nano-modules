// color.tone.auto_level — pass 4: apply the remap curve to the image.
//
// Per pixel: map luminance through the curve, then scale RGB by the luminance
// ratio so chroma (hue/saturation) is preserved — only tonality changes. Near-
// black pixels (no stable ratio) fall back to the graded grey.

#include "common.hlsl"

StructuredBuffer<float> lut      : register(t1);   // [0..NB-1]=LUT, [NB]=lo, [NB+1]=hi, [NB+2]=blank
Texture2D<float4>       inputTex : register(t2);
RWTexture2D<float4>     outTex   : register(u3);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= (uint)res_x || gid.y >= (uint)res_y) return;
  float4 c = inputTex[gid.xy];

  float blank = lut[AL_NB + 2];
  if (blank > 0.5) { outTex[gid.xy] = c; return; }   // flat luminance → passthrough

  float lo = lut[AL_NB + 0];
  float hi = lut[AL_NB + 1];
  float L  = max(nano_luminance(c.rgb), 0.0);
  float t  = saturate((L - lo) / max(hi - lo, 1e-5));
  float Lp = al_sample_lut(lut, t);                  // remapped luminance

  float3 rgb = (L > 1e-4) ? c.rgb * (Lp / L) : float3(Lp, Lp, Lp);
  outTex[gid.xy] = float4(saturate(rgb), c.a);
}
