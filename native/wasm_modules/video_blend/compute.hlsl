// Video Blend — blends two input textures with opacity.
// output = A * (1 - opacity) + B * opacity

Texture2D<float4> inputA : register(t0);
Texture2D<float4> inputB : register(t1);
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float opacity;
  float _pad0;
  float _pad1;
  float _pad2;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 a = inputA[gid.xy];
  float4 b = inputB[gid.xy];
  float3 blended = a.rgb * (1.0 - opacity) + b.rgb * opacity;
  outputTex[gid.xy] = float4(blended, 1.0);
}
