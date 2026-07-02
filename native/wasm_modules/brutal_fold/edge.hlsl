// source.brutal_fold — edge/variance reduce over the rendered tex_out.
//
// A GPU flatness detector for the "skip empty" feature. One thread per output
// pixel: read the 3x3 luma neighbourhood of the COMPOSITED frame, run a Sobel
// operator, and scatter four running sums into a small int stats buffer via
// atomics. The CPU reads these back (gpu_poll_readback) and forms the flatness
// metric = blend(luminance std-dev, mean edge energy). This measures the ACTUAL
// rendered output (colour grade + fog + receding layers), unlike the analytic
// CPU proxy it supersedes.
//
// Fixed-point: all three summed quantities are normalized to [0,1] in-shader and
// scaled by 128 for InterlockedAdd (int-only). Count is unscaled. Worst-case slot
// at 4K ≈ N*128 ≈ 1.06e9 < int32 max — see main.cpp kStatsScale.

#include "common.hlsl"   // cbuffer U (res_x/res_y) + nano_luminance

Texture2D<float4>    tex_out : register(t1);
// Per-TILE stats: a kTileGrid×kTileGrid grid, 4 ints each
// [edge_count, luma_sum, luma2_sum, pixel_count]. The CPU forms each tile's local
// variance + edge density and takes the MAX over tiles, so any single structured
// region (an edge OR luma variance anywhere) reads as non-flat — a global stat
// would dilute a small busy area away.
RWStructuredBuffer<int> stats : register(u2);

static const int   kTileGrid   = 16;            // must match main.cpp kTileGrid
static const float kStatsScale = 128.0;
static const float kSobelNorm  = 5.65685425;    // sqrt(32): max Sobel |grad| for luma in [0,1]
// A pixel counts as an EDGE when its Sobel magnitude clears this. Low enough to
// catch a clear black/gray boundary (~0.35) yet reject smooth shading/fog
// gradients (~1e-3). Edges are counted (not summed as energy) and normalized by a
// LINEAR dimension on the CPU, so a concentrated edge registers regardless of the
// area it covers — a frame-mean would wash a 1-D edge out by the 2-D pixel count.
static const float kEdgeThresh = 0.06;

float lumAt(int2 p, int2 res) {
  p = clamp(p, int2(0, 0), res - 1);
  return nano_luminance(tex_out.Load(int3(p, 0)).rgb);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  int2 res = int2((int)res_x, (int)res_y);
  if ((int)gid.x >= res.x || (int)gid.y >= res.y) return;
  int2 p = int2(gid.xy);

  float l00 = lumAt(p + int2(-1, -1), res), l10 = lumAt(p + int2(0, -1), res), l20 = lumAt(p + int2(1, -1), res);
  float l01 = lumAt(p + int2(-1,  0), res), l11 = lumAt(p,                res), l21 = lumAt(p + int2(1,  0), res);
  float l02 = lumAt(p + int2(-1,  1), res), l12 = lumAt(p + int2(0,  1), res), l22 = lumAt(p + int2(1,  1), res);

  float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
  float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
  float g = saturate(sqrt(gx * gx + gy * gy) / kSobelNorm);   // edge magnitude [0,1]
  float L = l11;

  // Route this pixel into its tile's 4 slots.
  int2 tile = clamp(p * kTileGrid / res, int2(0, 0), int2(kTileGrid - 1, kTileGrid - 1));
  int ti = (tile.y * kTileGrid + tile.x) * 4;

  int prev;
  if (g > kEdgeThresh) InterlockedAdd(stats[ti + 0], 1, prev);     // edge-pixel count
  InterlockedAdd(stats[ti + 1], (int)(L * kStatsScale),     prev);
  InterlockedAdd(stats[ti + 2], (int)(L * L * kStatsScale), prev);
  InterlockedAdd(stats[ti + 3], 1,                          prev);
}
