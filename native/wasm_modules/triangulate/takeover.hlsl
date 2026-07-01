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
  uint  u_mode;         // 0 cell-residual, 1 feature-weight, 2 weight+blue-noise
  uint  u_pad0, u_pad1, u_pad2;
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

  float2 target;
  float confidence;   // 0..1 margin-normalized improvement
  if (u_mode == 0u) {
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
    if (u_mode == 2u) improvement *= saturate(mass * 4.0);  // blue-noise: damp in sparse cells
    float margin = 0.02 + u_confidence * 0.4;
    confidence = saturate((improvement - margin) / max(margin, 1e-4));
  }

  float lambda = rate_hz * u_dt * confidence;
  float p = 1.0 - exp(-lambda);
  if (tri_hash_f(i * 2654435761u + u_frame) < p) {
    s.pos = saturate(target);
    s.score = (u_mode == 0u) ? candW : candW;
  }

  seeds[i] = s;
}
