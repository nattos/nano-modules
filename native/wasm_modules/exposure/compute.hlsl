// video.exposure — Per-channel multiplicative gain.
// The host folds amount + tint into per-channel gains, so the shader is just
// a multiply.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float gain_r;
  float gain_g;
  float gain_b;
  float _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 rgb = c.rgb * float3(gain_r, gain_g, gain_b);
  outputTex[gid.xy] = float4(saturate(rgb), c.a);
}
