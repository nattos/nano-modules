// warp.legacy.d_wave — wave-blob fragment shader.
//
// Soft elongated profile: sharp falloff across the streak (angle) and a gentle,
// long falloff along it (radius). Writes additively into the polar field's red
// channel; overlapping blobs accumulate (the field is RGBA16F, so >1 is fine —
// the warp pass clamps the displacement).

struct In {
  float4 pos      : SV_Position;
  float2 local    : TEXCOORD0;                 // quad-local [-1,1]
  nointerpolation float strength : TEXCOORD1;
};

[shader("pixel")]
float4 main(In i) : SV_Target {
  float ax = i.local.x, ay = i.local.y;
  float mask = exp(-ax * ax * 8.0) * exp(-ay * ay * 2.5);   // thin × long
  // Additive blend is src*src.a + dst, so alpha MUST be 1 for the red strength
  // to accumulate (alpha 0 would add nothing).
  return float4(i.strength * mask, 0.0, 0.0, 1.0);
}
