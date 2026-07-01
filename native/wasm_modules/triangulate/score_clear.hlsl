// triangulate — zero the per-seed accumulator (4 uints/seed) each frame.
#include "common.hlsl"

RWStructuredBuffer<uint> accum : register(u0);

cbuffer ClearUniforms : register(b1) {
  uint u_count;
  uint u_pad0, u_pad1, u_pad2;
};

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= u_count) return;
  uint b = i * TRI_ACCUM_STRIDE;
  accum[b + 0] = 0u;
  accum[b + 1] = 0u;
  accum[b + 2] = 0u;
  accum[b + 3] = 0u;
}
