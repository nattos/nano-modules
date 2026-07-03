// source.shape_fold — motion/variance reduce over the LEVELED FIELD (pre-grade).
//
// The skip-static detector measures frame-to-frame change. Reading it off the
// composited tex_out was wrong: shape_fold histogram-equalizes every frame, so the
// auto-levels LUT periodically reshapes and the whole image flashes even when the
// field is barely moving — the detector read those flashes as motion. Instead we
// evaluate the field DIRECTLY here (the same sf_field_at the present pass uses) and
// apply only the STABLE linear lo/hi normalization (v = (F-lo)/(hi-lo) ∈ [0,1]) —
// NOT the per-frame equalization LUT, NOT the cosmetic grade. A static field → an
// identical v → exactly zero motion, no flash to suppress. v is also normalized, so
// bold shapes (≈0 raw-field variance, riding a big DC offset) still read as high
// variance — the leveled field is the right perceptual signal for every feature.
//
// One thread per fixed-grid sample: evaluate v over a 3×3 neighbourhood (Sobel edge
// + local stats), diff the centre vs the persistent previous-frame v (motion), and
// scatter running sums into the per-tile int stats buffer. Slots 5-10 are the
// SIGNED Lucas-Kanade flow sums for the uniform-drift penalty (normalized gradient
// vs signed dv). The CPU reads these back.

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

// Linearly-leveled field at a pixel (matches present's cover-square mapping), [0,1].
// Uses only the field + linear lo/hi — no equalization LUT, no grade → temporally
// stable. hi-lo tiny (near-flat / blank frame) → 0 (no spurious motion).
float leveled_at(int2 p_px, float2 vp, float lo, float hi) {
  float rng = hi - lo;
  if (rng < 1e-4) return 0.0;
  float mx = max(vp.x, vp.y);
  float2 sq = (float2(p_px) + 0.5 - 0.5 * vp) / (0.5 * mx);
  float2 p = sq * domain_scale;
  return saturate((sf_field_at(p) - lo) / rng);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if ((int)gid.x >= kSampleGrid || (int)gid.y >= kSampleGrid) return;
  int2 res = int2((int)res_x, (int)res_y);
  float2 vp = float2(res);
  float lo = lut[SF_NB + 0];
  float hi = lut[SF_NB + 1];

  int2 cell = max(res / kSampleGrid, int2(1, 1));
  int2 p = clamp(int2(gid.xy) * res / kSampleGrid + cell / 2, int2(0, 0), res - 1);

  float v00 = leveled_at(p + int2(-cell.x, -cell.y), vp, lo, hi), v10 = leveled_at(p + int2(0, -cell.y), vp, lo, hi), v20 = leveled_at(p + int2(cell.x, -cell.y), vp, lo, hi);
  float v01 = leveled_at(p + int2(-cell.x,  0), vp, lo, hi),      v11 = leveled_at(p,                    vp, lo, hi), v21 = leveled_at(p + int2(cell.x,  0), vp, lo, hi);
  float v02 = leveled_at(p + int2(-cell.x, cell.y), vp, lo, hi),  v12 = leveled_at(p + int2(0, cell.y), vp, lo, hi), v22 = leveled_at(p + int2(cell.x, cell.y), vp, lo, hi);

  float gx = (v20 + 2.0 * v21 + v22) - (v00 + 2.0 * v01 + v02);
  float gy = (v02 + 2.0 * v12 + v22) - (v00 + 2.0 * v10 + v20);
  float g = saturate(sqrt(gx * gx + gy * gy) / kSobelNorm);              // edge magnitude [0,1]
  float e = pow(saturate((g - kEdgeFloor) / kEdgeSpan), kEdgeGamma);     // contrast-squashed
  float V = v11;

  // Motion = temporal diff of the LEVELED FIELD. `me` is the squashed magnitude;
  // `dts` the raw signed diff for the flow (Lucas-Kanade) sums.
  int sidx = (int)gid.y * kSampleGrid + (int)gid.x;
  float pv = prevField[sidx];
  float dts = (pv < 0.0) ? 0.0 : (V - pv);
  float m = abs(dts);
  float me = pow(saturate((m - kMotionFloor) / kMotionSpan), kMotionGamma);
  prevField[sidx] = V;

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
