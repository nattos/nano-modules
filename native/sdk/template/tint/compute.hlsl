// example.color.tint — blend every pixel toward one colour.
//
// Registers are BINDING NUMBERS: t0 / u1 / b2 here must match both the
// gpu::Bindings() order in main.cpp (tex2d(0).storageTex2d(1).uniform(2)) and
// the slots render() binds. A mismatch is not a compile error — it renders black.

struct Params {
  float3 color;
  float  amount;
};
ConstantBuffer<Params> u_params : register(b2);

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float4 c = inputTex[gid.xy];
  outputTex[gid.xy] = float4(lerp(c.rgb, c.rgb * u_params.color, u_params.amount), c.a);
}
