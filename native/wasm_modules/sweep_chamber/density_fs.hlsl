// source.particles.sweep_chamber — density splat fragment shader.
//
// Soft gaussian halo, peak 1.0 at the particle center, drawn ADDITIVELY:
//   .r  = Σ halo            — local crowding (≈ neighbour count)
//   .gb = Σ halo · velocity — halo-weighted motion (stream align/diverge)
// The halo width gives interactions their range for free. flow_swarm parity.

struct DOut {
  float4 pos    : SV_Position;
  float2 corner : TEXCOORD0;
  nointerpolation float2 vel : TEXCOORD1;
};

static const float DENSITY_SIGMA = 0.5;

[shader("pixel")]
float4 main(DOut i) : SV_Target0 {
  float r2 = dot(i.corner, i.corner);
  if (r2 > 1.0) discard;                       // round halo, not a square
  float halo = exp(-r2 / (DENSITY_SIGMA * DENSITY_SIGMA));   // 1 at center
  return float4(halo, halo * i.vel.x, halo * i.vel.y, 1.0);
}
