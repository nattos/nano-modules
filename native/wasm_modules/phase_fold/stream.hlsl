// video.phase_fold — streamline tracer (compute).
//
// One thread per streamline seed (an NS×NS grid over the phase window). Each
// thread integrates the blended vector field for SL_STEPS RK2 steps and writes
// its polyline as a run of line SEGMENTS into the streamline buffer, plus two
// arrowhead segments at an ANIMATED position (flow_phase) so the arrow flows
// down the line. The points are spaced by speed (fixed-dt integration), so an
// arrow advancing at a constant index-rate races through fast regions and
// crawls at the slow spots — the "ghost". The CPU did all this per-frame in the
// prototype; here it is a single compute dispatch. The instanced line raster
// (line_vs/line_fs) draws the segments. PF_SL_SEGS segments are reserved per
// streamline; unused / past-the-end ones are written dead (the VS culls them).

#include "field.hlsl"

RWStructuredBuffer<Segment> segs : register(u2);

static const float PF_C30 = 0.8660254;   // cos(30°)
static const float PF_S30 = 0.5;         // sin(30°)

void write_dead(uint i) {
  Segment s;
  s.a = float4(0, 0, 0, 0);
  s.b = float4(0, 0, 0, 1);   // dead = 1
  segs[i] = s;
}

void write_seg(uint i, float2 p0, float2 p1, float code, float width) {
  Segment s;
  s.a = float4(p0, p1);
  s.b = float4(code, stream_alpha, width, 0);
  segs[i] = s;
}

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  uint idx = tid.x;
  if (idx >= (uint)(PF_NS * PF_NS)) return;
  uint base = idx * (uint)PF_SL_SEGS;

  // Hole → nothing to draw.
  if (pf_weight_sum() < 1e-4) {
    for (uint d = 0u; d < (uint)PF_SL_SEGS; d++) write_dead(base + d);
    return;
  }

  uint gi = idx / (uint)PF_NS;
  uint gj = idx % (uint)PF_NS;
  float x = -extent + (float(gi) + 0.5) / float(PF_NS) * 2.0 * extent;
  float y = -extent + (float(gj) + 0.5) / float(PF_NS) * 2.0 * extent;

  float spx[PF_SL_STEPS + 1];
  float spy[PF_SL_STEPS + 1];
  spx[0] = x; spy[0] = y;
  uint pn = 1u;
  float lim = extent * 1.05;
  for (uint s = 0u; s < (uint)PF_SL_STEPS; s++) {
    float2 q = pf_step(float2(x, y), PF_SL_DT);
    // NaN via nano_is_nan; ±Inf and out-of-bounds via the magnitude check
    // (naga rejects the isfinite/IsNan intrinsic — see nano_sanitize.hlsl).
    if (nano_is_nan(q.x) || nano_is_nan(q.y) || abs(q.x) > lim || abs(q.y) > lim) break;
    x = q.x; y = q.y;
    spx[pn] = x; spy[pn] = y; pn++;
  }

  // Streamline segments, coloured by local speed (faint).
  for (uint k = 0u; k < (uint)PF_SL_STEPS; k++) {
    if (k + 1u < pn) {
      float dx = spx[k + 1u] - spx[k];
      float dy = spy[k + 1u] - spy[k];
      float c = min(0.55, (length(float2(dx, dy)) / PF_SL_DT) * 0.16);
      write_seg(base + k, float2(spx[k], spy[k]), float2(spx[k + 1u], spy[k + 1u]),
                c, stream_width);
    } else {
      write_dead(base + k);
    }
  }

  // Two arrowhead barb segments at the animated flow-phase index.
  uint a0 = base + (uint)PF_SL_STEPS;
  if (pn >= 2u) {
    float off = frac(float(gi) * 0.618 + float(gj) * 0.382);
    float fp = frac(flow_phase + off);
    uint mi = min(pn - 2u, (uint)(fp * float(pn - 1u)));
    float adx = spx[mi + 1u] - spx[mi];
    float ady = spy[mi + 1u] - spy[mi];
    float m = length(float2(adx, ady));
    if (m > 1e-6) {
      float ax = spx[mi], ay = spy[mi];
      float ux = -adx / m, uy = -ady / m;
      float2 l1 = float2(ux * PF_C30 - uy * PF_S30, ux * PF_S30 + uy * PF_C30);
      float2 l2 = float2(ux * PF_C30 + uy * PF_S30, -ux * PF_S30 + uy * PF_C30);
      write_seg(a0 + 0u, float2(ax, ay), float2(ax + PF_ARROW * l1.x, ay + PF_ARROW * l1.y),
                PF_CODE_ARROW, stream_width);
      write_seg(a0 + 1u, float2(ax, ay), float2(ax + PF_ARROW * l2.x, ay + PF_ARROW * l2.y),
                PF_CODE_ARROW, stream_width);
    } else {
      write_dead(a0 + 0u); write_dead(a0 + 1u);
    }
  } else {
    write_dead(a0 + 0u); write_dead(a0 + 1u);
  }
}
