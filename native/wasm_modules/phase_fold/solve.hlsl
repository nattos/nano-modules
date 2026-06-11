// video.phase_fold — limit-cycle solver (compute, STATEFUL, double-buffered).
//
// N persistent particles form a ring on the limit cycle. Each carries POSITION
// (xy) and VELOCITY (zw); the update is a little force/momentum integrator so
// the ring WOBBLES around the cycle instead of snapping onto it. Each frame a
// particle either RESPAWNS onto the nearest cell's resting-cycle point (timer /
// first frame), or:
//
//   • WALK impulse — a random signed kick along the contour tangent (back and
//     forth); momentum carries it so the ring shimmer-rotates / explores.
//   • RELAXATION sub-steps — `solve_steps` Newton steps toward the wind-
//     corrected cycle, but applied as a FORCE through velocity with `momentum`
//     retention and `step_size` scale. Underdamped → the particle overshoots
//     and wobbles around the cycle (intentional). step_size sets how far each
//     step pushes; momentum sets how much it wobbles.
//   • SPACING — a direct tangential nudge toward the midpoint of the two
//     neighbours' OLD positions, keeping the ring evenly distributed (stable,
//     outside the momentum loop so it doesn't oscillate).
//
// Reads the previous frame's ring (particles_prev) and writes the next
// (particles_next), ping-ponged on the CPU, so neighbour reads are race-free.
// Sanitised on load (a stuck NaN would persist forever).

#include "field.hlsl"
#include "nano_hash.hlsl"

RWStructuredBuffer<float4> particles_next : register(u2);   // write (xy=pos, zw=vel)
StructuredBuffer<float>    curve          : register(t3);   // PF_CURVE resting cycles
StructuredBuffer<float4>   particles_prev : register(t4);   // read (last frame)

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  uint i = tid.x;
  if (i >= (uint)PF_PARTICLES) return;
  uint N = (uint)PF_PARTICLES;

  float4 prev = particles_prev[i];
  float2 p = prev.xy;
  float2 v = prev.zw;
  bool reseed = (respawn > 0.5) || nano_is_nan(p.x) || nano_is_nan(p.y) ||
                nano_is_nan(v.x) || nano_is_nan(v.y);

  if (reseed) {
    uint co = ((uint)nearest_cell * (uint)PF_NOUT + i) * 2u;
    p = float2(curve[co], curve[co + 1u]);
    v = float2(0.0, 0.0);
  } else if (pf_weight_sum() >= 1e-4) {
    // Tangent at the current position (for the walk impulse + spacing).
    PfField f0 = pf_field(p);
    float gl0 = length(f0.grad);
    if (gl0 > 1e-3) {
      float2 t0 = float2(-f0.grad.y, f0.grad.x) / gl0;
      // Walk: random signed tangential velocity impulse — momentum sustains it.
      float rnd = nano_hash21(float2(float(i), rand_seed)) * 2.0 - 1.0;
      v += t0 * (rnd * explore * 0.04);
    }

    // Relaxation as a force, integrated with momentum (underdamped → wobble).
    uint steps = (uint)max(solve_steps, 1.0);
    for (uint s = 0u; s < steps; s++) {
      PfField f = pf_field(p);
      float gl2 = dot(f.grad, f.grad);
      float2 force = float2(0.0, 0.0);
      if (gl2 >= 1e-6) {
        float gl = sqrt(gl2);
        float2 n = f.grad / gl;
        float target = f.lev + bias + clamp(dot(f.W, n) / (f.mu * gl + 1e-3), -0.5, 0.5);
        force = -(f.H - target) * f.grad / gl2;   // toward the cycle (Newton)
        float fl = length(force);
        if (fl > PF_RELAX_CAP) force *= PF_RELAX_CAP / fl;
      }
      v = v * momentum + force * step_size;
      float vl = length(v);
      if (vl > PF_VEL_CAP) v *= PF_VEL_CAP / vl;
      p += v;
    }

    // Spacing: direct tangential nudge toward the old-neighbour midpoint.
    PfField fs = pf_field(p);
    float gls = length(fs.grad);
    if (gls > 1e-3) {
      float2 ts = float2(-fs.grad.y, fs.grad.x) / gls;
      float2 pl = particles_prev[(i + N - 1u) % N].xy;
      float2 pr = particles_prev[(i + 1u) % N].xy;
      float along = dot(0.5 * (pl + pr) - p, ts);
      p += ts * (along * spread * 0.5);
    }
  }

  particles_next[i] = float4(p, v);
}
