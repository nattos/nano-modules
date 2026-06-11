// video.phase_fold — limit-cycle solver (compute, STATEFUL, double-buffered).
//
// N persistent particles form a ring on the limit cycle. Each frame, each
// particle either RESPAWNS onto the nearest cell's resting-cycle point (timer /
// first frame) or is updated in three steps:
//
//   1. NORMAL relax — `solve_steps` Newton steps along ∇H onto the wind-
//      corrected cycle (H = level + bias + (W·n̂)/(mu·|∇H|), from "normal flow =
//      0"). Moves only along the normal, so the ring keeps its distribution.
//   2. TANGENTIAL random walk — step along the contour tangent by a random
//      signed distance (back and forth). On a true cycle this just jitters /
//      rotates the ring; off it, it explores nearby space.
//   3. NEIGHBOUR spacing — nudge along the tangent toward the midpoint of the
//      two neighbours' OLD positions, so the ring spreads back out evenly
//      instead of bunching under the random walk.
//
// Reads the previous frame's ring (particles_prev) and writes the next
// (particles_next) — ping-ponged on the CPU — so neighbour reads are race-free
// ("old position"). Sanitised on load (a stuck NaN would persist forever).

#include "field.hlsl"
#include "nano_hash.hlsl"

RWStructuredBuffer<float4> particles_next : register(u2);   // write
StructuredBuffer<float>    curve          : register(t3);   // PF_CURVE resting cycles
StructuredBuffer<float4>   particles_prev : register(t4);   // read (last frame)

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  uint i = tid.x;
  if (i >= (uint)PF_PARTICLES) return;
  uint N = (uint)PF_PARTICLES;

  float2 p = particles_prev[i].xy;
  bool reseed = (respawn > 0.5) || nano_is_nan(p.x) || nano_is_nan(p.y);

  if (reseed) {
    uint co = ((uint)nearest_cell * (uint)PF_NOUT + i) * 2u;
    p = float2(curve[co], curve[co + 1u]);
  } else if (pf_weight_sum() >= 1e-4) {
    // 1. Normal relaxation onto the (wind-corrected) cycle.
    uint steps = (uint)max(solve_steps, 1.0);
    for (uint s = 0u; s < steps; s++) {
      PfField f = pf_field(p);
      float gl2 = dot(f.grad, f.grad);
      if (gl2 < 1e-6) break;
      float gl = sqrt(gl2);
      float2 n = f.grad / gl;
      float target = f.lev + bias + clamp(dot(f.W, n) / (f.mu * gl + 1e-3), -0.5, 0.5);
      float2 step = (f.H - target) * f.grad / gl2;
      float sl = length(step);
      if (sl > PF_RELAX_CAP) step *= PF_RELAX_CAP / sl;
      p -= step;
    }

    // Contour tangent (perpendicular to ∇H) at the relaxed position.
    PfField fr = pf_field(p);
    float gl2 = dot(fr.grad, fr.grad);
    if (gl2 > 1e-6) {
      float2 n = fr.grad * rsqrt(gl2);
      float2 t = float2(-n.y, n.x);

      // 2. Tangential random walk — signed distance, back and forth.
      float rnd = nano_hash21(float2(float(i), rand_seed)) * 2.0 - 1.0;
      p += t * (rnd * explore * 0.04);

      // 3. Neighbour spacing — tangential nudge toward the old-neighbour midpoint.
      float2 pl = particles_prev[(i + N - 1u) % N].xy;
      float2 pr = particles_prev[(i + 1u) % N].xy;
      float along = dot(0.5 * (pl + pr) - p, t);
      p += t * (along * spread * 0.5);
    }
  }

  particles_next[i] = float4(p, 0.0, 0.0);
}
