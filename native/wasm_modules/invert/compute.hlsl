// video.invert — RGB (and optional alpha) inversion mixed by amount.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float amount;        // 0..1 — interpolation between input and inverted
  float invert_alpha;  // 0 = leave alpha alone, 1 = also invert
  float2 _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 rgb = lerp(c.rgb, 1.0 - c.rgb, amount);
  float a   = lerp(c.a, lerp(c.a, 1.0 - c.a, amount), invert_alpha);
  outputTex[gid.xy] = float4(rgb, a);
}
