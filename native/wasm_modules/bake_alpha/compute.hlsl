// video.bake_alpha — Premultiply RGB by alpha.
//
// out.rgb = lerp(in.rgb, in.rgb * in.a, amount)
// out.a   = in.a

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float amount;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 c = inputTex[gid.xy];
  float3 baked = c.rgb * c.a;
  outputTex[gid.xy] = float4(lerp(c.rgb, baked, amount), c.a);
}
