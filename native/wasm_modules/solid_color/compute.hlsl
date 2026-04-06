// Solid Color Generator — fills output texture with a uniform color.

RWTexture2D<float4> outputTex : register(u0);

cbuffer Uniforms : register(b1) {
  float red;
  float green;
  float blue;
  float _pad;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  outputTex[gid.xy] = float4(red, green, blue, 1.0);
}
