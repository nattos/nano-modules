// source.particles.sweep_chamber — density splat vertex shader.
//
// Splats each live particle as a small quad into the (square, fixed-res)
// density buffer so the next frame's update pass can read local crowding.
// flow_swarm parity — see that file for the aspect-corrected halo rationale.

#include "common.hlsl"

StructuredBuffer<Particle> particles : register(t0);

cbuffer DensityUniforms : register(b1) {
  float radius;     // splat half-size (isotropic uv: 1 unit = min(W,H) px)
  float aspect_x;   // min/W
  float aspect_y;   // min/H
  float _pad;
};

struct DOut {
  float4 pos    : SV_Position;
  float2 corner : TEXCOORD0;   // quad-local [-1,1]² → halo falloff in the FS
  nointerpolation float2 vel : TEXCOORD1;   // particle velocity → motion channels
};

[shader("vertex")]
DOut main(uint vid : SV_VertexID, uint iid : SV_InstanceID) {
  static const float2 corners[6] = {
    float2(-1.0, -1.0), float2( 1.0, -1.0), float2(-1.0,  1.0),
    float2( 1.0, -1.0), float2( 1.0,  1.0), float2(-1.0,  1.0),
  };
  float2 c = corners[vid % 6u];

  Particle p = particles[iid];
  DOut o;
  if (p.a.z <= 0.0) {   // dead → degenerate triangle (culled)
    o.pos = float4(2.0, 2.0, 2.0, 1.0);
    o.corner = float2(0.0, 0.0);
    o.vel = float2(0.0, 0.0);
    return o;
  }
  o.vel = p.b.xy;

  // Aspect-correct the half-extent so the halo is ROUND in screen pixels.
  float2 world = p.a.xy + c * float2(radius * aspect_x, radius * aspect_y);
  o.pos    = float4(world * 2.0 - 1.0, 0.0, 1.0);
  o.corner = c;
  return o;
}
