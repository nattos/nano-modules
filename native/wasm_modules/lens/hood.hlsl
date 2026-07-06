// filter.blur.lens — pass 4 (in-frame veiling glare). Bright sources within the
// frame scatter into a wide, coating-tinted bloom that lifts the blacks
// (pipeline.pass_hood :251). Composites the pre-blurred highlight map (veil) onto
// the image: out = img + strength · veil · flare_tint.

#include "common.hlsl"

Texture2D<float4>   srcTex    : register(t0);   // current linear-HDR image
Texture2D<float4>   veilTex   : register(t1);   // Blur16(hi, 0.06·md); rgb = hi
RWTexture2D<float4> outputTex : register(u2);
// NB: WGSL uniform buffers require a float3 to be 16-byte aligned, so the
// flare_tint (vec3) MUST come first (offset 0) — a leading scalar would push it
// to offset 4 and naga rejects the layout.
cbuffer Uniforms : register(b3) {
  float3 u_flare_tint;
  float  u_strength;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float4 src = srcTex[gid.xy];
  float3 add = u_strength * veilTex[gid.xy].rgb * u_flare_tint;
  outputTex[gid.xy] = float4(src.rgb + add, src.a);
}
