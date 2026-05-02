// video.posterize — Snap RGB (and optionally alpha) to N evenly-spaced levels.
//
// out = round(in * (levels - 1)) / (levels - 1)

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float levels;
  float quantize_alpha;
  float2 _pad;
};

float quantize_channel(float x, float n) {
  float steps = max(n - 1.0, 1.0);
  return round(saturate(x) * steps) / steps;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 rgb = float3(
    quantize_channel(c.r, levels),
    quantize_channel(c.g, levels),
    quantize_channel(c.b, levels)
  );
  float a = lerp(c.a, quantize_channel(c.a, levels), quantize_alpha);
  outputTex[gid.xy] = float4(rgb, a);
}
