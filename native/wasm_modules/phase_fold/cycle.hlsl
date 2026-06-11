// video.phase_fold — limit-cycle tracer (compute).
//
// A single thread integrates a long trajectory from a seed on the resting cycle
// (seed_x/seed_y, the nearest cell's stored cycle point, picked on the CPU) and
// writes it as a run of gold line segments. Because the seed sits on the
// attracting cycle, the trajectory traces it out (and, when wind kills the
// cycle, spirals into the surviving fixed point). A small animated marker rides
// the trajectory at the flow_phase index — slow where the cycle is slow (the
// ghost). This is its own toggleable stage, separate from the streamlines. The
// integration is inherently sequential (each step depends on the last), so it
// runs on one thread; PF_NTRAJ is kept modest for that reason.

#include "field.hlsl"

RWStructuredBuffer<Segment> segs : register(u2);

void cy_dead(uint i) {
  Segment s; s.a = float4(0, 0, 0, 0); s.b = float4(0, 0, 0, 1);
  segs[i] = s;
}
void cy_seg(uint i, float2 p0, float2 p1, float code, float width, float alpha) {
  Segment s; s.a = float4(p0, p1); s.b = float4(code, alpha, width, 0);
  segs[i] = s;
}

[numthreads(1, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  if (tid.x != 0u) return;
  uint total = (uint)PF_NTRAJ + (uint)PF_CYCLE_EXTRA;

  if (pf_weight_sum() < 1e-4) {
    for (uint d = 0u; d < total; d++) cy_dead(d);
    return;
  }

  float2 t = float2(seed_x, seed_y);
  if (nano_is_nan(t.x) || nano_is_nan(t.y)) t = float2(0.3, 0.0);   // NaN guard (no isfinite)
  float2 prev = t;

  uint target = (uint)(frac(flow_phase) * float(PF_NTRAJ));
  float2 marker = t;
  bool alive = true;

  for (uint s = 0u; s < (uint)PF_NTRAJ; s++) {
    if (alive) {
      float2 q = pf_step(t, PF_TDT);
      // NaN via nano_is_nan; ±Inf caught by length(q) > 3 (naga has no isfinite).
      if (nano_is_nan(q.x) || nano_is_nan(q.y) || length(q) > 3.0) {
        alive = false;
      } else {
        cy_seg(s, prev, q, PF_CODE_CYCLE, cycle_width, 0.95);
        if (s <= target) marker = q;
        prev = q; t = q;
        continue;
      }
    }
    cy_dead(s);
  }

  // Animated marker: a small diamond riding the trajectory.
  uint m0 = (uint)PF_NTRAJ;
  float ds = 0.03;
  float2 up = marker + float2(0, ds), rt = marker + float2(ds, 0);
  float2 dn = marker + float2(0, -ds), lf = marker + float2(-ds, 0);
  cy_seg(m0 + 0u, up, rt, PF_CODE_CYCLE, cycle_width, 1.0);
  cy_seg(m0 + 1u, rt, dn, PF_CODE_CYCLE, cycle_width, 1.0);
  cy_seg(m0 + 2u, dn, lf, PF_CODE_CYCLE, cycle_width, 1.0);
  cy_seg(m0 + 3u, lf, up, PF_CODE_CYCLE, cycle_width, 1.0);
  cy_dead(m0 + 4u);
  cy_dead(m0 + 5u);
}
