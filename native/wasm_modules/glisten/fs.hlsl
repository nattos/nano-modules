// filter.legacy.glisten — sparkle fragment shader (additive).
//
// Soft falloff from the bright anchor apex out to each blade tip. Output is
// straight colour + alpha; the additive PSO does src.rgb * src.a + dst.

cbuffer U : register(b2) {
  float falloff;   // blade falloff exponent
  float _p0, _p1, _p2;
};

struct VsOut {
  float4 pos    : SV_Position;
  float  radial : TEXCOORD0;
  float4 color  : TEXCOORD1;
};

[shader("pixel")]
float4 main(VsOut i) : SV_Target0 {
  float a = i.color.a * pow(saturate(1.0 - i.radial), max(falloff, 0.1));
  if (a <= 0.0) discard;
  return float4(i.color.rgb, a);
}
