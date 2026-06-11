// video.phase_fold — limit-cycle solver (compute, STATEFUL).
//
// N persistent particles form a ring on the limit cycle and are iteratively
// relaxed onto it. Each frame, each particle either RESPAWNS onto the nearest
// cell's resting-cycle point (on the hard respawn timer, on the first frame, or
// when the cell changes) or takes `solve_steps` Newton steps along ∇H toward the
// cycle. The cycle is where the flow's NORMAL component is zero; solving
// v·n̂ = 0 with n̂ = ∇H/|∇H| gives the wind-corrected target level
//   H* = level + bias + (W·n̂) / (mu·|∇H|)
// so the relaxed ring captures the wind bulge. Particles move only along the
// normal, so the ring keeps its angular distribution (no tangential bunching).
// The buffer persists across frames — sanitize on load (a stray NaN would stick
// forever, see nano_sanitize.hlsl).

#include "field.hlsl"

RWStructuredBuffer<float4> particles : register(u2);   // xy = position
StructuredBuffer<float> curve : register(t3);          // PF_CURVE resting cycles

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  uint i = tid.x;
  if (i >= (uint)PF_PARTICLES) return;

  float2 p = particles[i].xy;
  bool reseed = (respawn > 0.5) || nano_is_nan(p.x) || nano_is_nan(p.y);

  if (reseed) {
    uint co = ((uint)nearest_cell * (uint)PF_NOUT + i) * 2u;
    p = float2(curve[co], curve[co + 1u]);
  } else if (pf_weight_sum() >= 1e-4) {
    uint steps = (uint)max(solve_steps, 1.0);
    for (uint s = 0u; s < steps; s++) {
      PfField f = pf_field(p);
      float gl2 = dot(f.grad, f.grad);
      if (gl2 < 1e-6) break;              // critical point — stop
      float gl = sqrt(gl2);
      float2 n = f.grad / gl;
      // Wind-corrected target level (from v·n̂ = 0). Clamp so a near-critical
      // |∇H| can't fling the target.
      float target = f.lev + bias + clamp(dot(f.W, n) / (f.mu * gl + 1e-3), -0.5, 0.5);
      float2 step = (f.H - target) * f.grad / gl2;   // Newton step onto H = target
      float sl = length(step);
      if (sl > PF_RELAX_CAP) step *= PF_RELAX_CAP / sl;
      p -= step;
    }
  }

  particles[i] = float4(p, 0.0, 0.0);
}
