// video.phase_fold — keep only the longest contiguous cycle run (compute).
//
// The build pass marks each segment live/dead independently, so a partly-broken
// cycle leaves several disconnected runs. We want only the LONGEST contiguous
// run drawn. The heavy work (the per-segment break test / field eval) already
// ran in parallel; all that's left is an O(N) scan over N booleans to find the
// longest circular run and cull the rest — trivial on a single thread (same
// shape as shape_fold's single-invocation buildlut pass). Runs in place on the
// segment buffer: it only ever SETS dead, never clears it.

#include "common.hlsl"

RWStructuredBuffer<Segment> segs : register(u2);

[numthreads(1, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  if (tid.x != 0u) return;
  uint N = (uint)PF_PARTICLES;

  // Count live segments and find a break to start the circular scan from.
  uint live = 0u;
  uint d0 = 0u;
  bool foundBreak = false;
  for (uint i = 0u; i < N; i++) {
    if (segs[i].b.w > 0.5) {            // dead
      if (!foundBreak) { d0 = i; foundBreak = true; }
    } else {
      live++;
    }
  }
  if (live == 0u) return;               // nothing drawn — leave as-is
  if (!foundBreak) return;              // whole ring is live — keep all

  // Walk the ring from the break, tracking the longest run of live segments.
  int  bestStart = -1; uint bestLen = 0u;
  int  curStart  = -1; uint curLen  = 0u;
  for (uint k = 1u; k <= N; k++) {
    uint idx = (d0 + k) % N;
    if (segs[idx].b.w <= 0.5) {         // live
      if (curLen == 0u) curStart = (int)idx;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curLen = 0u;
    }
  }

  // Cull every segment outside [bestStart, bestStart + bestLen).
  for (uint i = 0u; i < N; i++) {
    uint rel = (i + N - (uint)bestStart) % N;
    if (rel >= bestLen) segs[i].b.w = 1.0;   // mark dead
  }
}
