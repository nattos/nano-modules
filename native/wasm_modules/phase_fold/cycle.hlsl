// video.phase_fold — limit-cycle tracer (compute, PARALLEL).
//
// The old version integrated one long trajectory on a SINGLE GPU thread (~900
// serial steps of heavy transcendental math every frame) — it stalled the
// render pass and, under GPU contention, let the device queue back up until the
// browser died. This version is fully parallel: one thread per resting-cycle
// point (PF_NOUT seeds from the nearest cell's baked curve), each tracing a
// SHORT arc (PF_ARC_STEPS) through the blended field. With wind=0 the seeds sit
// on the attractor so the arcs retrace the cycle; with wind the arcs bend with
// the deformed flow, and past the SNIC bifurcation they spiral toward the
// surviving fixed point — exactly the research behaviour. The dense overlap of
// short arcs draws a continuous gold cycle. Segment.c.x carries the seed's
// position around the cycle so the FS can ride a moving highlight on it.

#include "field.hlsl"

RWStructuredBuffer<Segment> segs : register(u2);
StructuredBuffer<float> curve : register(t3);   // PF_CURVE: cells × PF_NOUT × (x,y)

void cy_dead(uint i) {
  Segment s; s.a = float4(0, 0, 0, 0); s.b = float4(0, 0, 0, 1); s.c = float4(0, 0, 0, 0);
  segs[i] = s;
}
void cy_seg(uint i, float2 p0, float2 p1, float arc) {
  Segment s;
  s.a = float4(p0, p1);
  s.b = float4(PF_CODE_CYCLE, 0.95, cycle_width, 0);
  s.c = float4(arc, 0, 0, 0);
  segs[i] = s;
}

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  uint i = tid.x;
  if (i >= (uint)PF_CYCLE_ARCS) return;
  uint base = i * (uint)PF_ARC_STEPS;

  if (pf_weight_sum() < 1e-4) {
    for (uint d = 0u; d < (uint)PF_ARC_STEPS; d++) cy_dead(base + d);
    return;
  }

  // Seed at resting-cycle point i of the nearest cell.
  uint co = ((uint)nearest_cell * (uint)PF_NOUT + i) * 2u;
  float2 p = float2(curve[co], curve[co + 1u]);
  if (nano_is_nan(p.x) || nano_is_nan(p.y)) p = float2(0.3, 0.0);
  float arc = float(i) / float(PF_NOUT);   // position around the cycle (for the FS highlight)

  for (uint s = 0u; s < (uint)PF_ARC_STEPS; s++) {
    float2 q = pf_step(p, PF_TDT);
    if (nano_is_nan(q.x) || nano_is_nan(q.y) || length(q) > 3.0) {
      cy_dead(base + s);
    } else {
      cy_seg(base + s, p, q, arc);
      p = q;
    }
  }
}
