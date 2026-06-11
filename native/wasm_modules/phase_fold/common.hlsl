// video.phase_fold — shared math for all passes.
//
// A phase-portrait GENERATOR. The XY pad picks a cell in a GxG atlas of
// emergent level-set limit-cycle FIELDS (x = eccentricity, y = lobedness). The
// baked atlas (PF_CELLS in phase_fold_atlas.h) is uploaded to the GPU as a flat
// storage buffer so every pass can evaluate the blended scalar field H and its
// induced vector field v = level-set flow + WIND(z) directly on-device. This is
// the research testbed's split (evalV/cellH in app.js) ported to native — but
// here the streamline tracing, arrow animation and limit-cycle integration that
// the prototype did on the CPU each frame are done on the GPU as compute passes.
//
// The shared uniform block is bound at register(b0) in EVERY pass (backdrop,
// the two tracers, and the line raster), so this file declares it once and the
// field helpers read it as globals. The atlas cell buffer is bound at
// register(t1) wherever the field is evaluated.

#ifndef PHASE_FOLD_COMMON_HLSL
#define PHASE_FOLD_COMMON_HLSL

// Must match phase_fold_atlas.h AND the constants in main.cpp.
#define PF_K       8u     // blob kernels per cell
#define PF_R       3u     // ring-ridge kernels per cell
#define PF_STRIDE  50u    // floats per cell (4 + K*4 + R*3 + 5)
#define PF_WIND_OFF 45u   // offset of (wdx, wdy, wmax) within a cell

#define PF_NS        15      // streamline seed grid (NS x NS)
#define PF_SL_STEPS  16      // integration steps per streamline = segments stored
#define PF_SL_DT     0.05    // streamline step size
#define PF_NOUT      96      // resting-cycle points per cell (limit-cycle seeds)
#define PF_PARTICLES PF_NOUT // stateful limit-cycle solver particles (one per seed)
#define PF_BREAK_SAMPLES 4   // gradient samples between consecutive particles
#define PF_RELAX_CAP 0.10    // max per-iteration Newton step (solver stability)
#define PF_TDT       0.02    // streamline-style step size
#define PF_STEP_CAP  0.06    // per-step displacement clamp (keeps integration smooth)

// Colour code packed into Segment.b.x — the fragment shader maps it to a palette
// (streamline speed gradient below 0.58, gold limit cycle above 0.8).
#define PF_CODE_CYCLE  0.90   // gold limit-cycle

// Shared uniform block — identical layout in every pass (always register b0).
cbuffer U : register(b0) {
  float res_x;   float res_y;   float extent;       float bias;
  float wind;    float n_bands; float contrast;     float flow_phase;
  float nearest_cell; float respawn; float stream_width; float cycle_width;
  float backdrop_dim; float stream_alpha; float shading_mode; float solve_steps;
  float break_dist;   float explore;  float spread;   float rand_seed;
  float4 corners;   // 4 corner cell indices (as float)
  float4 weights;   // 4 convex blend weights (sum 1, or 0 over a hole)
};

#define PF_TWO_PI 6.28318530718

// One line segment:
//   a = (p0.x, p0.y, p1.x, p1.y)
//   b = (code, alpha, width, dead)
//   c = (arc, stagger, _, _)   — arc ∈ [0,1) position along the line; stagger is
//       a per-streamline phase offset. The fragment shader rides a continuous
//       glow down the line via frac(arc - flow_phase + stagger) — no quantized
//       arrowhead. (The atlas cell buffer + field helpers live in field.hlsl so
//       the line raster can include this header without the t1 cells binding.)
struct Segment { float4 a; float4 b; float4 c; };

float pf_weight_sum() {
  return weights[0] + weights[1] + weights[2] + weights[3];
}

// --- Coordinate mapping (shared by backdrop write and line raster) ---------
//
// The square phase space [-extent,extent]² COVERS the viewport uniformly:
// scaled by the LONG axis, the short axis cropped (no bars). Phase-space y is
// up; screen y is down.

float2 pf_pixel_to_p(float2 px, float2 vp) {
  float mx = max(vp.x, vp.y);
  float2 sq = (px + 0.5 - 0.5 * vp) / (0.5 * mx);
  return float2(sq.x, -sq.y) * extent;
}

// phase space → world uv (y-down, 0 = top row); caller does clip = uv*2-1 and
// lets naga insert the Vulkan→WebGPU y-flip (see flash_particles/vs.hlsl note).
float2 pf_p_to_uv(float2 p, float2 vp) {
  float mx = max(vp.x, vp.y);
  float2 sq = float2(p.x, -p.y) / extent;
  float2 px = sq * (0.5 * mx) + 0.5 * vp;
  return px / vp;
}

// --- Backdrop colormap (diverging RdBu, muted) — port of app.js diverging() --

float3 pf_diverging(float t) {
  float x = saturate(t);
  float3 blue = float3(0.13, 0.30, 0.55), lblue = float3(0.62, 0.74, 0.86);
  float3 white = float3(0.97, 0.97, 0.98);
  float3 lred = float3(0.93, 0.62, 0.50), red = float3(0.62, 0.10, 0.12);
  if (x < 0.25) return lerp(blue, lblue, x / 0.25);
  if (x < 0.5)  return lerp(lblue, white, (x - 0.25) / 0.25);
  if (x < 0.75) return lerp(white, lred, (x - 0.5) / 0.25);
  return lerp(lred, red, (x - 0.75) / 0.25);
}

#endif // PHASE_FOLD_COMMON_HLSL
