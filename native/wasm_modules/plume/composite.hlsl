// source.sdf.plume — final composite (fog pipeline only).
//
// Full-res: body from the scene buffer (rgb, .a = hit distance), fog from
// the half-res fog buffer (rgb = in-scatter, .a = transmittance, bilinear
// upsample — fog is soft), over the input, faded by the global opacity.

#include "nano_hash.hlsl"

Texture2D<float4>   sceneTex   : register(t0);
Texture2D<float4>   fogTex     : register(t1);
Texture2D<float4>   bgTex      : register(t2);
SamplerState        linearSamp : register(s3);
RWTexture2D<float4> outTex     : register(u4);

cbuffer CompUniforms : register(b5) {
  float opacity;
  float has_bg;
  float exposure;   // linear gain on the fog in-scatter (see below)
  float black;      // black level: >0 lift, <0 crush
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float4 bg = has_bg > 0.5 ? bgTex.Load(int3(int(gid.x), int(gid.y), 0))
                           : float4(0.0, 0.0, 0.0, 0.0);
  float4 scene = sceneTex.Load(int3(int(gid.x), int(gid.y), 0));
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);
  // 4-tap tent upsample of the half-res fog: averages out the march's IGN
  // jitter dither (a single bilinear tap leaves a faint 2-px diamond
  // lattice in high-banding regions, e.g. backlit fog shadows). Fog is
  // soft by construction, so the extra half-texel of blur costs nothing.
  uint FW, FH;
  fogTex.GetDimensions(FW, FH);
  float2 ft = 0.5 / float2(FW, FH);
  float4 fog = (fogTex.SampleLevel(linearSamp, uv + float2( ft.x,  ft.y), 0)
              + fogTex.SampleLevel(linearSamp, uv + float2(-ft.x,  ft.y), 0)
              + fogTex.SampleLevel(linearSamp, uv + float2( ft.x, -ft.y), 0)
              + fogTex.SampleLevel(linearSamp, uv + float2(-ft.x, -ft.y), 0))
             * 0.25;

  // Miss sentinel is 6e4 — the largest sentinel that survives the RGBA16F
  // scene buffer (f16 tops out at 65504; anything bigger reads back NaN).
  bool hit = scene.a < 1.0e4;
  float3 c = hit ? scene.rgb : bg.rgb;
  float cover = hit ? 1.0 : 0.0;

  // Fog integrates in front of the body (the march stopped at its depth).
  // Exposure applies to the fog's LINEAR in-scatter here — the surface
  // color already took the same gain ahead of its shoulder in march.hlsl.
  c = fog.rgb * exposure + c * fog.a;
  cover = max(cover, 1.0 - fog.a);

  // Black level: >0 lifts the floor toward a filmic pedestal, <0 crushes
  // the darks to true black. Graded before the opacity fade (opacity 0
  // stays pure passthrough) and BEFORE the dither below, so the ±half-LSB
  // amplitude stays exact at the output quantizer no matter how the grade
  // reshapes the gradients.
  c = black >= 0.0 ? black + (1.0 - black) * c
                   : max((c + black) / (1.0 + black), 0.0);

  float3 outc = lerp(bg.rgb, c, opacity);
  // ±half-LSB output dither. The soft looks are built from huge shallow
  // gradients (fog haze, grazing-sun key rolloff), and the downstream
  // 8-bit output quantizes them into visible contour bands — one gray
  // level every ~10 px reads as banding on a dark display. Dithering
  // before that rounding breaks the contours into invisible grain; IGN
  // keeps neighboring pixels maximally spread, and the pattern is static
  // (stable in motion). Costs one hash.
  outc += (nano_ign(float2(gid.xy)) - 0.5) * (1.0 / 255.0);
  outTex[gid.xy] = float4(outc, max(bg.a, cover * opacity));
}
