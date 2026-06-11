// video.phase_fold — longest-run select + cycle health + good-cycle morph.
//
// Single-thread pass (the heavy per-segment work already ran in parallel). It:
//   1. Keeps only the LONGEST contiguous (circular) run of live segments and
//      culls the rest (a partly-broken cycle → one arc).
//   2. Writes cycle HEALTH to status[] (PF_ST_*): closed flag, the longest run's
//      arc length, and a respawn-request for next frame's solve — raised when the
//      cycle is broken AND the longest chain's arc length is below `respawn_arc`
//      (rate-limited by a cooldown so it doesn't fire every frame).
//   3. MORPHS the "good" cycle: snap it to the resting cycle on the first frame,
//      else lerp it toward the live ring when the cycle is closed, or back toward
//      the resting cycle when broken. This is the source respawns clone from.
//      The index-wise lerp isn't a clean morph, but it's better than nothing.

#include "common.hlsl"

RWStructuredBuffer<Segment> segs   : register(u2);   // cull in place
RWStructuredBuffer<float4>  good    : register(u3);  // the remembered good cycle
RWStructuredBuffer<float>   status  : register(u4);  // PF_ST_*
StructuredBuffer<float4>    live    : register(t5);  // the relaxed ring (this frame)
StructuredBuffer<float>     curve   : register(t6);  // PF_CURVE resting cycles

float2 pf_curve_seed(uint i) {
  uint co = ((uint)nearest_cell * (uint)PF_NOUT + i) * 2u;
  return float2(curve[co], curve[co + 1u]);
}

[numthreads(1, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
  if (tid.x != 0u) return;
  uint N = (uint)PF_PARTICLES;
  bool hole = pf_weight_sum() < 1e-4;

  // --- longest contiguous run ---
  uint liveCount = 0u;
  uint d0 = 0u;
  bool foundBreak = false;
  for (uint i = 0u; i < N; i++) {
    if (segs[i].b.w > 0.5) { if (!foundBreak) { d0 = i; foundBreak = true; } }
    else liveCount++;
  }

  int  bestStart = 0; uint bestLen = 0u;
  if (liveCount > 0u && !foundBreak) {
    bestStart = 0; bestLen = N;                  // whole ring live → keep all
  } else if (liveCount > 0u) {
    int curStart = 0; uint curLen = 0u;
    for (uint k = 1u; k <= N; k++) {
      uint idx = (d0 + k) % N;
      if (segs[idx].b.w <= 0.5) {
        if (curLen == 0u) curStart = (int)idx;
        curLen++;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else {
        curLen = 0u;
      }
    }
    for (uint i = 0u; i < N; i++) {
      uint rel = (i + N - (uint)bestStart) % N;
      if (rel >= bestLen) segs[i].b.w = 1.0;     // cull outside the longest run
    }
  }

  // --- arc length of the longest run ---
  float arc = 0.0;
  for (uint j = 0u; j < bestLen; j++) {
    uint idx = ((uint)bestStart + j) % N;
    arc += length(segs[idx].a.zw - segs[idx].a.xy);
  }

  bool closed = (!foundBreak) && (liveCount > 0u) && !hole;

  // --- respawn request: broken + short longest chain, rate-limited ---
  float cooldown = status[PF_ST_COOLDOWN];
  float respawnReq = 0.0;
  if (!closed && !hole && arc < respawn_arc) {
    if (cooldown <= 0.5) { respawnReq = 1.0; cooldown = PF_RESPAWN_COOLDOWN; }
    else cooldown -= 1.0;
  } else {
    cooldown = max(cooldown - 1.0, 0.0);
  }
  status[PF_ST_CLOSED]   = closed ? 1.0 : 0.0;
  status[PF_ST_ARC]      = arc;
  status[PF_ST_RESPAWN]  = respawnReq;
  status[PF_ST_COOLDOWN] = cooldown;

  // --- morph the good cycle ---
  float r = saturate(morph_rate);
  for (uint i = 0u; i < N; i++) {
    float2 g = good[i].xy;
    if (good_init < 0.5)      g = pf_curve_seed(i);        // first frame: snap
    else if (closed)          g = lerp(g, live[i].xy, r);  // healthy: track live
    else                      g = lerp(g, pf_curve_seed(i), r);  // broken: decay to rest
    good[i] = float4(g, 0.0, 0.0);
  }
}
