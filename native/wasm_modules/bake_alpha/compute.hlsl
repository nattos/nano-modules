// video.bake_alpha — Composite the input texture *over* a solid colour.
//
// Standard alpha-over: out.rgb = src.rgb * src.a + bg.rgb * (1 - src.a),
//                      out.a   = src.a       + bg.a  * (1 - src.a).
// With bg.a = 1 the result is fully opaque (the typical "remove alpha"
// use case). With bg.a = 0 the colour matters only where the input is
// transparent — effectively a transparent-aware composite that still
// preserves the input's own alpha.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float bg_r;
  float bg_g;
  float bg_b;
  float bg_a;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 src = inputTex[gid.xy];
  float4 bg = float4(bg_r, bg_g, bg_b, bg_a);
  float a = saturate(src.a);
  float3 rgb = src.rgb * a + bg.rgb * (1.0 - a);
  float out_a = a + bg.a * (1.0 - a);
  outputTex[gid.xy] = float4(rgb, out_a);
}
