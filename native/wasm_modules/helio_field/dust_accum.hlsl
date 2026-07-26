// source.sdf.helio_field — dust density accumulate: particles → a
// fixed-point 128³ count volume (InterlockedAdd; float16 texture
// atomics don't exist, so the accumulation runs in a uint buffer and
// dust_fold normalizes it into the published grid's .a channel).
//
// Each mote deposits 256 total, trilinearly split over its 2×2×2 voxel
// neighborhood — the consumer's bilinear reads then see a smooth
// aggregate medium (fog scattering, sun extinction), which is exactly
// the licensed approximation: individual motes are SHARP only in the
// splat pass; their lighting influence is a soft cloud.

#include "../plume/common.hlsl"

StructuredBuffer<float4>   parts : register(t0);
RWStructuredBuffer<uint>   accum : register(u1);

cbuffer DustAccumUniforms : register(b2) {
  float count;     // live particles
  float _p0, _p1, _p2;
};

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= (uint)count) return;
  float4 r0 = parts[gid.x * 2u];
  if (r0.w <= 0.0) return;   // parked

  const int RES = PLM_VOL_RES;
  float3 f = (r0.xyz * (0.5 / PLM_EXT0) + 0.5) * float(RES) - 0.5;
  int3 v0 = int3(floor(f));
  float3 t = f - float3(v0);
  [unroll] for (int k = 0; k < 8; k++) {
    int3 o = int3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    int3 v = v0 + o;
    if (any(v < 0) || any(v >= RES)) continue;
    float w = (o.x != 0 ? t.x : 1.0 - t.x)
            * (o.y != 0 ? t.y : 1.0 - t.y)
            * (o.z != 0 ? t.z : 1.0 - t.z);
    uint dep = (uint)(w * 256.0 + 0.5);
    if (dep == 0u) continue;
    uint prev;
    InterlockedAdd(accum[(v.z * RES + v.y) * RES + v.x], dep, prev);
  }
}
