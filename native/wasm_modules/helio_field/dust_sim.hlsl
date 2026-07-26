// source.sdf.helio_field — dust motes: the rail's particle channel.
//
// One thread per particle fills the sdf_field dust buffer (two float4
// rows: pos+radius / normal+seed — effect_sdf_field.h). Placement is a
// pure function of the current sim state: a hash-seeded candidate
// direction KEEPS a mote only where the granule chemistry's b chemical
// is alive — dust rides the granulation, so it inherits the granules'
// whole ecology for free (colonizes the flatlands, starves near strong
// field, frozen exactly at Sim Rate 0). Rejected candidates park at the
// ORIGIN: inside the body every camera ray meets the surface first, so
// a parked mote can never win a splat pixel — no compaction needed.
//
// Milestone note: placement re-derives from the chemistry each frame,
// so while the sim runs, motes hop between granules frame to frame
// (temporal stability is explicitly secondary — sharp-or-absent is the
// contract). The advected persistent pool replaces this in the next
// milestone.

#include "../plume/common.hlsl"
#include "nano_hash.hlsl"

Texture2D<float4>          dustTex  : register(t0);  // chemistry (a, b)
Texture2D<float4>          shellTex : register(t1);  // (h, crest, ...)
SamplerState               samp     : register(s2);
RWStructuredBuffer<float4> parts    : register(u3);

cbuffer DustSimUniforms : register(b4) {
  float count;    // live particle slots
  float seed;     // variation key
  float R;        // body radius, world units
  float lift;     // hover height above the local surface, world units

  float size;     // mote radius, world units (jittered per mote)
  float thresh;   // chemistry b acceptance threshold
  float drift;    // sim clock (reserved: tumble/advection milestone)
  float _p0;
};

float du_rand(uint tid, uint salt) {
  uint h = nano_uhash(tid * 8u + salt + (uint)(seed * 1013.0) * 2654435761u);
  return float(h) * (1.0 / 4294967296.0);
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint tid = gid.x;
  if (tid >= (uint)count) return;

  // Uniform candidate direction on the sphere.
  float z = 1.0 - 2.0 * du_rand(tid, 0u);
  float ph = 6.2831853 * du_rand(tid, 1u);
  float rxy = sqrt(saturate(1.0 - z * z));
  float3 dir = float3(rxy * cos(ph), z, rxy * sin(ph));

  float b = dustTex.SampleLevel(samp, nano_oct_encode(dir), 0).y;
  if (b < thresh) {
    parts[tid * 2u] = float4(0.0, 0.0, 0.0, 0.0);
    parts[tid * 2u + 1u] = float4(0.0, 1.0, 0.0, 0.0);
    return;
  }

  // Hover just above the LOCAL surface (shell h), not the base sphere —
  // motes trace the relief instead of drowning in it.
  float h = shellTex.SampleLevel(samp, nano_oct_encode(dir), 0).x;
  float3 pos = dir * (R + h + lift * (0.6 + 0.8 * du_rand(tid, 2u)));

  float3 n = float3(du_rand(tid, 3u), du_rand(tid, 4u), du_rand(tid, 5u))
           * 2.0 - 1.0;
  float nl = length(n);
  n = nl > 1e-3 ? n / nl : float3(0.0, 1.0, 0.0);

  float sz = size * (0.6 + 0.8 * du_rand(tid, 6u));
  parts[tid * 2u] = float4(pos, sz);
  parts[tid * 2u + 1u] = float4(n, du_rand(tid, 7u));
}
