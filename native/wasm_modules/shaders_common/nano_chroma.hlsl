#ifndef NANO_CHROMA_HLSL
#define NANO_CHROMA_HLSL
// nano_chroma.hlsl — YIQ hue-rotate + chromatic-aberration-via-displacement.
//
// Ported from the Resolume Wire "ChromaOffset" ISF (the reusable "keeper" of
// the Wobble Master / ChromaWobble family): a per-channel UV offset where R/G/B
// are each sampled at a different shift, wrapped in a YIQ hue rotation so the
// fringe can be tinted/rotated in hue space. Shared by the legacy wobble
// effects.

static const float3 kRGBToYPrime = float3(0.299, 0.587, 0.114);
static const float3 kRGBToI      = float3(0.596, -0.275, -0.321);
static const float3 kRGBToQ      = float3(0.212, -0.523, 0.311);
static const float3 kYIQToR      = float3(1.0, 0.956, 0.621);
static const float3 kYIQToG      = float3(1.0, -0.272, -0.647);
static const float3 kYIQToB      = float3(1.0, -1.107, 1.704);

// Rotate hue by `hueShift` radians in YIQ space (chroma/lightness preserved).
float3 nano_shift_hue(float3 color, float hueShift) {
  float YPrime = dot(color, kRGBToYPrime);
  float I = dot(color, kRGBToI);
  float Q = dot(color, kRGBToQ);
  float hue = (abs(I) <= (1.0 / (256.0 * 256.0))) ? 0.0 : atan2(Q, I);
  float chroma = sqrt(I * I + Q * Q);
  hue += hueShift;
  I = chroma * cos(hue);
  Q = chroma * sin(hue);
  float3 yIQ = float3(YPrime, I, Q);
  return float3(dot(yIQ, kYIQToR), dot(yIQ, kYIQToG), dot(yIQ, kYIQToB));
}

// Chromatic aberration: sample `tex` for R/G/B at three UV shifts, each
// hue-rotated by +hueShift, recombine, then rotate the result by -hueShift
// (so HueShift only tints the SPLIT, not the whole image). Verbatim structure
// from the ChromaOffset ISF.
float4 nano_chroma_offset(Texture2D<float4> tex, SamplerState samp, float2 uv,
                          float2 shiftR, float2 shiftG, float2 shiftB,
                          float hueShift) {
  float4 cR = tex.SampleLevel(samp, uv + shiftR, 0.0);
  float4 cG = tex.SampleLevel(samp, uv + shiftG, 0.0);
  float4 cB = tex.SampleLevel(samp, uv + shiftB, 0.0);
  cR.rgb = nano_shift_hue(cR.rgb, hueShift);
  cG.rgb = nano_shift_hue(cG.rgb, hueShift);
  cB.rgb = nano_shift_hue(cB.rgb, hueShift);
  float4 mixed = float4(cR.r, cG.g, cB.b, (cR.a + cG.a + cB.a) / 3.0);
  mixed.rgb = nano_shift_hue(mixed.rgb, -hueShift);
  return mixed;
}

#endif // NANO_CHROMA_HLSL
