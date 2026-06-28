// warp.legacy.d_wave — wave-blob vertex shader.
//
// One instanced quad per particle, splatted into the polar field texture
// (X = angle, Y = radius). The quad is thin in angle and elongated in radius —
// a vertical streak in field space. Dead/idle slots collapse to a degenerate
// triangle outside clip space so the rasterizer skips them.

StructuredBuffer<float4> particles : register(t0);

cbuffer Uniforms : register(b1) {
  uint  count;
  float ang_halfwidth;   // angular half-extent (thinness)
  float rad_halflen;     // radial half-extent (elongation)
  float decay;           // [0,1] fade toward the rim
  float grain;           // [0,1] per-particle strength jitter
  float _a, _b, _c;
}

struct VsOut {
  float4 pos      : SV_Position;
  float2 local    : TEXCOORD0;                 // quad-local [-1,1]
  nointerpolation float strength : TEXCOORD1;
};

[shader("vertex")]
VsOut main(uint vid : SV_VertexID, uint iid : SV_InstanceID) {
  static const float2 corners[6] = {
    float2(-1.0, -1.0), float2( 1.0, -1.0), float2(-1.0,  1.0),
    float2( 1.0, -1.0), float2( 1.0,  1.0), float2(-1.0,  1.0),
  };
  VsOut o;
  if (iid >= count) {                          // idle → collapse
    o.pos = float4(2.0, 2.0, 2.0, 1.0);
    o.local = float2(0.0, 0.0);
    o.strength = 0.0;
    return o;
  }

  float4 p = particles[iid];
  float ang = p.x, r = p.y, sj = p.z;
  float2 c = corners[vid % 6u];

  // grain jitters each particle's size AND strength (correlated → big = bright).
  float lenJit = lerp(1.0, 0.4 + 1.2 * sj, grain);
  float2 center = float2(ang, r);
  float2 uv = center + c * float2(ang_halfwidth, rad_halflen * lenJit);   // field uv
  o.pos = float4(uv * 2.0 - 1.0, 0.0, 1.0);                               // → clip
  o.local = c;

  // Strength fades toward the rim; grain dials in per-particle variety.
  float fade = saturate(1.0 - decay * r);
  o.strength = lerp(1.0, 0.2 + 1.6 * sj, grain) * fade;
  return o;
}
