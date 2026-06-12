// video.flow_swarm — density splat fragment shader.
//
// Soft gaussian halo, peak 1.0 at the particle center. Drawn ADDITIVELY into
// the density buffer's R channel, so the accumulated value ≈ the number of
// nearby particles (weighted by the halo) — i.e. local crowding. The halo
// width gives interactions their range for free (no separate convolution).

struct DOut {
  float4 pos    : SV_Position;
  float2 corner : TEXCOORD0;
};

static const float DENSITY_SIGMA = 0.5;

[shader("pixel")]
float4 main(DOut i) : SV_Target0 {
  float r2 = dot(i.corner, i.corner);
  if (r2 > 1.0) discard;                       // round halo, not a square
  float halo = exp(-r2 / (DENSITY_SIGMA * DENSITY_SIGMA));   // 1 at center
  return float4(halo, 0.0, 0.0, 0.0);          // additive into R
}
