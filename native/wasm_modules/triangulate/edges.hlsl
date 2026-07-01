// triangulate — Delaunay edge extraction from the JFA Voronoi id texture.
// A 2×2 forward block containing >=3 distinct cell ids is a Voronoi vertex (a
// Delaunay circumcenter): the participating seeds are mutually Delaunay-adjacent,
// so we append their connecting edges. Each Delaunay edge is captured at the two
// vertices bounding its shared Voronoi boundary. Emission is gated to the pixel
// whose own cell is the block's minimum id (canonical) to cut duplicates; any
// residual duplicates simply overdraw the same line.
#include "common.hlsl"

Texture2D<float>         idTex   : register(t0);
RWStructuredBuffer<uint> edges   : register(u1);
RWStructuredBuffer<uint> counter : register(u2);

cbuffer EdgeUniforms : register(b3) {
  uint u_w;
  uint u_h;
  uint u_max;
  uint u_pad;
};

void emit(uint a, uint b) {
  if (a == b) return;
  uint lo = min(a, b), hi = max(a, b);
  uint slot;
  InterlockedAdd(counter[0], 1u, slot);
  if (slot < u_max) edges[slot] = (lo << 16) | hi;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= u_w || gid.y >= u_h) return;
  int2 dim = int2(u_w, u_h);
  int2 p  = int2(gid.xy);
  int2 pr = min(p + int2(1, 0), dim - 1);
  int2 pd = min(p + int2(0, 1), dim - 1);
  int2 pe = min(p + int2(1, 1), dim - 1);

  float fs[4];
  fs[0] = idTex.Load(int3(p,  0));
  fs[1] = idTex.Load(int3(pr, 0));
  fs[2] = idTex.Load(int3(pd, 0));
  fs[3] = idTex.Load(int3(pe, 0));

  int ids[4];
  int n = 0;
  [unroll]
  for (int k = 0; k < 4; ++k) {
    if (fs[k] < 0.0) continue;
    int v = (int)fs[k];
    bool dup = false;
    for (int m = 0; m < n; ++m) if (ids[m] == v) dup = true;
    if (!dup) ids[n++] = v;
  }
  if (n < 3) return;

  // Canonical emitter: only the pixel whose own cell is the min id.
  int mn = ids[0];
  for (int m = 1; m < n; ++m) mn = min(mn, ids[m]);
  if (fs[0] < 0.0 || (int)fs[0] != mn) return;

  for (int a = 0; a < n; ++a)
    for (int b = a + 1; b < n; ++b)
      emit((uint)ids[a], (uint)ids[b]);
}
