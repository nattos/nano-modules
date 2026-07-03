// source.shape_fold — motion/variance reduce over the RAW FIELD (pre-grade).
//
// The skip-static detector measures frame-to-frame change. Reading it off the
// composited tex_out was wrong: shape_fold histogram-equalizes every frame, so the
// auto-levels LUT periodically reshapes and the whole image flashes even when the
// field is barely moving — the detector read those flashes as motion. So we evaluate
// the field DIRECTLY here (the same sf_field_at the present pass uses), no
// equalization LUT, no grade — a static field → identical values → zero motion.
//
// Motion is the temporal diff of the RAW field, normalized only by dividing by the
// linear range (hi-lo) for perceptual scale. It deliberately does NOT re-level each
// frame the way v = (F-lo)/(hi-lo) would: subtracting the per-frame lo cancels a
// pixel's LEVEL change (a shape brightening / fading / its fill pulsing) whenever
// lo/hi move with it, and for shape_fold the birth/fade animation IS largely a level
// change — so we keep it. Spatial features (Sobel edge, and the variance value V)
// take the range-normalized field, where the lo offset cancels anyway.
//
// One thread per fixed-grid sample: evaluate the field over a 3×3 neighbourhood
// (Sobel edge + local stats), diff the centre vs the persistent previous-frame RAW
// field (motion), and scatter running sums into the per-tile int stats buffer. Slots
// 5-10 are the SIGNED Lucas-Kanade flow sums for the uniform-drift penalty
// (range-normalized gradient vs signed dv). The CPU reads these back.

#include "common.hlsl"   // cbuffer U (terms, res, domain_scale) + sf_field_at + SF_NB

StructuredBuffer<float>   lut       : register(t1);   // auto-levels: [SF_NB]=lo, [SF_NB+1]=hi
// Per-TILE stats: kTileGrid×kTileGrid grid, kSlots ints each.
//   [0] edge  [1] v_sum  [2] v²_sum  [3] motion  [4] count
//   [5] Σnx²  [6] Σny²   [7] Σnx·ny  [8] Σnx·dv  [9] Σny·dv  [10] Σdv²
RWStructuredBuffer<int>   stats     : register(u2);
// Persistent previous-frame LEVELED field per sample (motion = |v - prevV|). Sized
// to the fixed sample grid; sentinel <0 on the first frame → motion 0.
RWStructuredBuffer<float> prevField : register(u3);

static const int   kSlots       = 11;           // ints per tile (must match main.cpp)
static const int   kTileGrid    = 16;
static const int   kSampleGrid  = 256;
static const float kStatsScale  = 65536.0;
static const float kSobelNorm   = 5.65685425;   // sqrt(32): max Sobel |grad| for v in [0,1]
// Edge squash (available for tuning; edge weight defaults off).
static const float kEdgeFloor  = 0.015;
static const float kEdgeSpan   = 0.20;
static const float kEdgeGamma  = 0.5;
// Motion squash — sensitive (leveled-field drift is small but genuine).
static const float kMotionFloor = 0.003;
static const float kMotionSpan  = 0.05;
static const float kMotionGamma = 0.5;

// Raw analytic field at a pixel (matches present's cover-square mapping). No lo/hi,
// no equalization LUT, no grade.
float field_at(int2 p_px, float2 vp) {
  float mx = max(vp.x, vp.y);
  float2 sq = (float2(p_px) + 0.5 - 0.5 * vp) / (0.5 * mx);
  float2 p = sq * domain_scale;
  return sf_field_at(p);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if ((int)gid.x >= kSampleGrid || (int)gid.y >= kSampleGrid) return;
  int2 res = int2((int)res_x, (int)res_y);
  float2 vp = float2(res);
  float lo  = lut[SF_NB + 0];
  float hi  = lut[SF_NB + 1];
  float rng = hi - lo;
  // Normalize by the linear range for perceptual scale (bold shapes ride a big DC
  // offset). Near-flat / blank frame → 0 (no spurious motion). Crucially the range
  // divides the DIFF, it does NOT re-level each frame — so a pixel whose LEVEL
  // shifts (a shape brightening / fading / its fill pulsing) still reads as motion,
  // unlike (F-lo)/(hi-lo) which cancels level changes when lo/hi move with them.
  float invR = (rng < 1e-4) ? 0.0 : 1.0 / rng;

  int2 cell = max(res / kSampleGrid, int2(1, 1));
  int2 p = clamp(int2(gid.xy) * res / kSampleGrid + cell / 2, int2(0, 0), res - 1);

  float f00 = field_at(p + int2(-cell.x, -cell.y), vp), f10 = field_at(p + int2(0, -cell.y), vp), f20 = field_at(p + int2(cell.x, -cell.y), vp);
  float f01 = field_at(p + int2(-cell.x,  0), vp),      f11 = field_at(p,                    vp), f21 = field_at(p + int2(cell.x,  0), vp);
  float f02 = field_at(p + int2(-cell.x, cell.y), vp),  f12 = field_at(p + int2(0, cell.y), vp), f22 = field_at(p + int2(cell.x, cell.y), vp);

  // Clamp to the VISIBLE range [lo,hi]: field below lo displays as black, above hi as
  // peak, so their changes AREN'T on screen and must not count as motion (an "all
  // black" region whose field is still wiggling below lo would otherwise register).
  // Diffing the clamped value (not (F-lo)/range) still keeps level changes WITHIN the
  // visible range while ignoring both the sub-black wiggle and the global re-level.
  f00 = clamp(f00, lo, hi); f10 = clamp(f10, lo, hi); f20 = clamp(f20, lo, hi);
  f01 = clamp(f01, lo, hi); f11 = clamp(f11, lo, hi); f21 = clamp(f21, lo, hi);
  f02 = clamp(f02, lo, hi); f12 = clamp(f12, lo, hi); f22 = clamp(f22, lo, hi);

  // Range-normalized Sobel (the lo offset cancels in a difference), for edge + LK.
  float gx = ((f20 + 2.0 * f21 + f22) - (f00 + 2.0 * f01 + f02)) * invR;
  float gy = ((f02 + 2.0 * f12 + f22) - (f00 + 2.0 * f10 + f20)) * invR;
  float g = saturate(sqrt(gx * gx + gy * gy) / kSobelNorm);              // edge magnitude [0,1]
  float e = pow(saturate((g - kEdgeFloor) / kEdgeSpan), kEdgeGamma);     // contrast-squashed
  float V = (f11 - lo) * invR;   // visible leveled value ∈ [0,1], for the variance feature

  // Motion = temporal diff of the CLAMPED (visible-range) field, normalized by range.
  // prevField stores the clamped value so the diff isn't re-leveled — a level/fill
  // pulse within the visible range counts, but sub-black changes don't. `me` squashed
  // magnitude; `dts` signed for the LK flow sums.
  int sidx = (int)gid.y * kSampleGrid + (int)gid.x;
  float pf = prevField[sidx];
  float dts = (pf < -1e29) ? 0.0 : (f11 - pf) * invR;   // sentinel: first frame → 0
  float m = abs(dts);
  float me = pow(saturate((m - kMotionFloor) / kMotionSpan), kMotionGamma);
  prevField[sidx] = f11;                                 // store CLAMPED visible-range value

  float nx = gx / kSobelNorm;   // normalized gradient (‖(nx,ny)‖ ≤ 1)
  float ny = gy / kSobelNorm;

  int2 tile = clamp(int2(gid.xy) * kTileGrid / kSampleGrid, int2(0, 0), int2(kTileGrid - 1, kTileGrid - 1));
  int ti = (tile.y * kTileGrid + tile.x) * kSlots;

  int prev;   // round (not truncate) to halve quantization error
  InterlockedAdd(stats[ti + 0], (int)(e * kStatsScale + 0.5),     prev);  // soft edge sum
  InterlockedAdd(stats[ti + 1], (int)(V * kStatsScale + 0.5),     prev);
  InterlockedAdd(stats[ti + 2], (int)(V * V * kStatsScale + 0.5), prev);
  InterlockedAdd(stats[ti + 3], (int)(me * kStatsScale + 0.5),    prev);  // soft motion sum
  InterlockedAdd(stats[ti + 4], 1,                                prev);
  // Flow sums (SIGNED; round handles negatives). Per-tile |Σ| ≤ 256 samples → fits.
  InterlockedAdd(stats[ti + 5], (int)round(nx * nx  * kStatsScale), prev);
  InterlockedAdd(stats[ti + 6], (int)round(ny * ny  * kStatsScale), prev);
  InterlockedAdd(stats[ti + 7], (int)round(nx * ny  * kStatsScale), prev);
  InterlockedAdd(stats[ti + 8], (int)round(nx * dts * kStatsScale), prev);
  InterlockedAdd(stats[ti + 9], (int)round(ny * dts * kStatsScale), prev);
  InterlockedAdd(stats[ti + 10], (int)round(dts * dts * kStatsScale), prev);
}
