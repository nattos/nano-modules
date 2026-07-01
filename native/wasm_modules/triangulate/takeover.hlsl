// triangulate — stochastic confidence-gated takeover. Seeds are LOCKED in place
// and only TELEPORT to a candidate when it is confidently a better match, with a
// Poisson-gated acceptance (no continuous drift → no swim). Only mismatched
// vertices churn; well-placed seeds stay put indefinitely.
#include "common.hlsl"

StructuredBuffer<uint>  accum : register(t0);
Texture2D<float4>       feat  : register(t1);   // a = importance W
RWStructuredBuffer<Seed> seeds : register(u2);

cbuffer TakeoverUniforms : register(b3) {
  uint  u_count;
  uint  u_w;
  uint  u_h;
  uint  u_frame;
  float u_dt;
  float u_churn;        // 0..1 → Poisson rate
  float u_confidence;   // 0..1 → takeover margin (deadband)
  float u_aspect;       // proc_w / proc_h
  uint  u_mode;         // 0 ridge-protect, 1 cell-residual, 2 feature-weight, 3 blue-noise
  float u_decimation;   // 0..1 slope-merge strength (Ridge Protect)
  uint  u_pad1, u_pad2;
};

float feat_at(float2 pos) {
  int2 p = int2(clamp(pos, float2(0.0, 0.0), float2(0.99999, 0.99999)) * float2(u_w, u_h));
  return max(0.0, feat.Load(int3(p, 0)).a);
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= u_count) return;
  Seed s = seeds[i];

  // NaN guard.
  if (s.pos.x != s.pos.x || s.pos.y != s.pos.y) s.pos = tri_hash2(i, u_frame);

  uint b = i * TRI_ACCUM_STRIDE;
  uint m0 = accum[b + 0];
  uint m1 = accum[b + 1];
  uint m2 = accum[b + 2];
  float massFx = float(max(m0, 1u));
  float mass = float(m0) / TRI_FX;
  float2 ctr = float2(float(m1), float(m2)) / massFx;
  uint cand = accum[b + 3];
  float candW = tri_cand_w(cand);
  float2 candPos = (float2(tri_cand_px(cand), tri_cand_py(cand)) + 0.5) / float2(u_w, u_h);

  float rate_hz = pow(60.0, u_churn) - 1.0;

  // Starved cell (owns ~no pixels): stochastically respawn to break stasis.
  if (mass < 1e-4) {
    float p = 1.0 - exp(-rate_hz * u_dt);
    if (tri_hash_f(i * 9781u + u_frame) < p) s.pos = tri_hash2(i + 1u, u_frame * 3u + 1u);
    seeds[i] = s;
    return;
  }

  // Unweighted (area) centroid — the dispersion target.
  float pixN = float(max(accum[b + 4], 1u));
  float2 area_ctr = float2(float(accum[b + 5]), float(accum[b + 6])) / (pixN * TRI_FX);

  float2 target;
  float confidence;   // 0..1 margin-normalized merge strength
  if (u_mode == 0u) {
    // Ridge Protect — a BIDIRECTIONAL balance so `decimation` is a live knob:
    //   CONCENTRATE: merge uphill onto the cell's peak feature (favoured by HIGH
    //     decimation) → sparse slopes, dense features, big contrast triangles.
    //   DISPERSE: fall back toward the cell's area-centroid (favoured by LOW
    //     decimation) → even, uniform coverage.
    // Both are discrete teleports gated by how far off the seed is, so settled
    // seeds stay put (crisp, no swim); lowering decimation re-spreads and raising
    // it re-coalesces. Features are protected implicitly: at high decimation the
    // disperse term is small AND a peak's candPos == its own spot (nothing to
    // climb), so it holds.
    float rate = rate_hz * u_dt;
    float my_w = s.score;                           // stamped in seed_prep
    float merge_gain = saturate((candW - my_w) / (0.30 * (1.0 - u_decimation) + 0.02));
    float p_merge = 1.0 - exp(-rate * u_decimation * merge_gain);
    float2 dd = (s.pos - area_ctr) * float2(u_aspect, 1.0);
    float disp_gain = saturate(length(dd) / 0.12);
    float p_disp = 1.0 - exp(-rate * (1.0 - u_decimation) * disp_gain);
    float r = tri_hash_f(i * 2654435761u + u_frame);
    if (r < p_merge)                 s.pos = saturate(candPos);
    else if (r < p_merge + p_disp)   s.pos = saturate(area_ctr);
    seeds[i] = s;
    return;
  } else if (u_mode == 1u) {
    // Cell residual: how far the seed sits from its cell's weighted centre.
    target = ctr;
    float2 d = (s.pos - ctr) * float2(u_aspect, 1.0);
    float residual = length(d);
    float margin = 0.01 + u_confidence * 0.15;
    confidence = saturate((residual - margin) / max(margin, 1e-4));
  } else {
    // Feature weight: climb toward the cell's argmax-importance pixel.
    target = candPos;
    float w_inc = feat_at(s.pos);
    float improvement = candW - w_inc;
    if (u_mode == 3u) improvement *= saturate(mass * 4.0);  // blue-noise: damp in sparse cells
    float margin = 0.02 + u_confidence * 0.4;
    confidence = saturate((improvement - margin) / max(margin, 1e-4));
  }

  float lambda = rate_hz * u_dt * confidence;
  float p = 1.0 - exp(-lambda);
  if (tri_hash_f(i * 2654435761u + u_frame) < p) {
    s.pos = saturate(target);
  }

  seeds[i] = s;
}
