// triangulate — reset the edge buffer to the empty sentinel and zero the append
// counter, once per frame before edge extraction.
RWStructuredBuffer<uint> edges   : register(u0);
RWStructuredBuffer<uint> counter : register(u1);

cbuffer ClearEdgeUniforms : register(b2) {
  uint u_max;
  uint u_p0, u_p1, u_p2;
};

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= u_max) return;
  edges[i] = 0xFFFFFFFFu;
  if (i == 0u) counter[0] = 0u;
}
