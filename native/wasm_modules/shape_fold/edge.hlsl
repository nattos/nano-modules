// source.shape_fold — motion/variance reduce over the rendered tex_out.
//
// The "skip empty" detector for an evolving-shape GENERATOR. Unlike brutal_fold
// (which hunts flat SOLID-COLOUR frames), shape_fold is auto-leveled and thus is
// essentially NEVER flat — every frame reads as busy. What we want to skip here
// is a large, richly-detailed construct that just sits there, barely MOVING. So
// the dominant feature is MOTION (frame-to-frame change), and the CPU reduces it
// by the GLOBAL MEAN (see main.cpp), not the per-tile MAX brutal_fold uses.
//
// Because shape_fold's shapes have SOFT edges (SDF gradients, no hard steps), a
// moving construct shifts luma by only a small amount per pixel — a fraction of
// what a moving hard edge does in brutal_fold. So the motion squash here is much
// more sensitive (small floor/span): a gentle drift still registers as motion.
// Variance/edge are still computed (per tile) for tuning + the debug view, but
// default off — they'd read "busy" on every frame and defeat the purpose.
//
// One thread per fixed-grid sample: read the 3x3 luma neighbourhood of the
// COMPOSITED frame (Sobel edge + local luma stats), diff against the persistent
// previous-frame luma (motion), and scatter four running sums into a small int
// stats buffer via atomics. The CPU reads these back (gpu_poll_readback).
//
// Fixed-point: all summed quantities are normalized to [0,1] and scaled by
// kStatsScale for InterlockedAdd (int-only); count unscaled. Per-tile sums (≤256
// samples) stay far under int32.

#include "common.hlsl"       // cbuffer U (res_x/res_y — the first two scalars)
#include "nano_color.hlsl"   // nano_luminance (Rec.601)

Texture2D<float4>    tex_out : register(t1);
// Per-TILE stats: a kTileGrid×kTileGrid grid, kSlots ints each
// [edge_sum, luma_sum, luma2_sum, motion_sum, pixel_count].
RWStructuredBuffer<int>   stats     : register(u2);
// Persistent previous-frame luma at each sample point (motion = |L - prevL|).
// Sized to the fixed sample grid, so it never reallocs on viewport resize.
// Sentinel <0 on the first frame → motion 0 (no spurious spike). Each thread
// owns one slot (no race).
RWStructuredBuffer<float> prevLuma  : register(u3);

static const int   kSlots       = 5;            // ints per tile (must match main.cpp)
static const int   kTileGrid    = 16;           // must match main.cpp kTileGrid
// Sample on a fixed grid, NOT per output pixel: bounded, resolution-independent
// work (256² threads) + far less atomic contention. Each 16×16 tile gets 256
// samples. Sample spacing is res/256 (~4-8px).
static const int   kSampleGrid  = 256;          // must match main.cpp kSampleGrid
static const float kStatsScale  = 65536.0;      // must match main.cpp kStatsScale
static const float kSobelNorm   = 5.65685425;   // sqrt(32): max Sobel |grad| for luma in [0,1]

// Edge squash (only used when the edge weight is enabled for tuning; shape_fold
// has no hard edges so this defaults off). Same contrast-squash shape as
// brutal_fold: deadzone `floor`, `span` maps to a full edge, `gamma`<1 lifts the
// low end.
static const float kEdgeFloor  = 0.015;
static const float kEdgeSpan   = 0.20;
static const float kEdgeGamma  = 0.5;
// MOTION squash — MUCH more sensitive than the edge squash. shape_fold's soft
// gradients move luma by only a small amount per frame, and (crucially) a truly
// static field re-levels to an IDENTICAL frame, so there is no auto-levels
// jitter floor to hide behind: real motion here is small but genuine. The floor
// only needs to swallow fixed-point round noise (~1/kStatsScale); `span` maps a
// modest 0.05 luma delta to "full" motion so even a gentle drift saturates.
static const float kMotionFloor = 0.003;
static const float kMotionSpan  = 0.05;
static const float kMotionGamma = 0.5;

float lumAt(int2 p, int2 res) {
  p = clamp(p, int2(0, 0), res - 1);
  return nano_luminance(tex_out.Load(int3(p, 0)).rgb);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if ((int)gid.x >= kSampleGrid || (int)gid.y >= kSampleGrid) return;
  int2 res = int2((int)res_x, (int)res_y);
  // Map this sample to a pixel centre; the Sobel reads its 3x3 neighbourhood
  // spaced `cell` pixels apart (a coarse full-frame Sobel at sampling res).
  int2 cell = max(res / kSampleGrid, int2(1, 1));
  int2 p = clamp(int2(gid.xy) * res / kSampleGrid + cell / 2, int2(0, 0), res - 1);

  float l00 = lumAt(p + int2(-cell.x, -cell.y), res), l10 = lumAt(p + int2(0, -cell.y), res), l20 = lumAt(p + int2(cell.x, -cell.y), res);
  float l01 = lumAt(p + int2(-cell.x,  0), res),      l11 = lumAt(p,                       res), l21 = lumAt(p + int2(cell.x,  0), res);
  float l02 = lumAt(p + int2(-cell.x, cell.y), res),  l12 = lumAt(p + int2(0, cell.y), res),   l22 = lumAt(p + int2(cell.x, cell.y), res);

  float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
  float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
  float g = saturate(sqrt(gx * gx + gy * gy) / kSobelNorm);              // edge magnitude [0,1]
  float e = pow(saturate((g - kEdgeFloor) / kEdgeSpan), kEdgeGamma);     // contrast-squashed
  float L = l11;

  // Motion = temporal frame difference at this sample, with the sensitive squash.
  int sidx = (int)gid.y * kSampleGrid + (int)gid.x;
  float pl = prevLuma[sidx];
  float m = (pl < 0.0) ? 0.0 : abs(L - pl);
  float me = pow(saturate((m - kMotionFloor) / kMotionSpan), kMotionGamma);
  prevLuma[sidx] = L;

  // Route this sample into its tile's slots (tile from the SAMPLE grid).
  int2 tile = clamp(int2(gid.xy) * kTileGrid / kSampleGrid, int2(0, 0), int2(kTileGrid - 1, kTileGrid - 1));
  int ti = (tile.y * kTileGrid + tile.x) * kSlots;

  int prev;   // round (not truncate) to halve quantization error
  InterlockedAdd(stats[ti + 0], (int)(e * kStatsScale + 0.5),     prev);  // soft edge sum
  InterlockedAdd(stats[ti + 1], (int)(L * kStatsScale + 0.5),     prev);
  InterlockedAdd(stats[ti + 2], (int)(L * L * kStatsScale + 0.5), prev);
  InterlockedAdd(stats[ti + 3], (int)(me * kStatsScale + 0.5),    prev);  // soft motion sum
  InterlockedAdd(stats[ti + 4], 1,                                prev);
}
