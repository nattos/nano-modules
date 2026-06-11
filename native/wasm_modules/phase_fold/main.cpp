/*
 * video.phase_fold — emergent limit-cycle phase-portrait generator.
 *
 * Productionized from the phase-fold research testbed. A baked GxG atlas of
 * emergent level-set limit-cycle FIELDS (axes eccentricity x × lobedness y) is
 * uploaded to the GPU as a flat cell buffer. The XY pad picks 4 corner cells +
 * blend weights on the CPU each frame; everything else runs on the GPU:
 *
 *   backdrop (compute) — the blended scalar field H, banded as a muted
 *                        diverging colormap. Seeds tex_out.
 *   stream   (compute) — traces an NS×NS grid of streamlines through the blended
 *                        vector field v = level-set flow + WIND(z); a continuous
 *                        glow rides down each line (flow_phase), no quantized
 *                        arrowhead.
 *   cycle    (compute) — PARALLEL limit-cycle tracer: one thread per resting-
 *                        cycle point (PF_CURVE seeds), each tracing a short arc
 *                        through the blended field. Dense overlap draws a
 *                        continuous gold cycle that deforms / dies with wind.
 *                        (Replaces a single-thread 900-step serial integration
 *                        that stalled the pipeline and backed up the GPU queue.)
 *   line raster (vs/fs) — draws the traced segments as soft anti-aliased quads,
 *                        blended over the backdrop. Streamlines and the limit-
 *                        cycle tracer are SEPARATE, independently toggleable
 *                        stages.
 *
 * The prototype did the tracing / arrow animation / cycle integration on the
 * CPU every frame; here it is all GPU compute. WIND (z) is the non-potential
 * z-axis force that distorts then kills the cycle (SNIC bifurcation). An
 * optional autopilot spirals the XY automatically and broadcasts its live
 * position (autopilot_x/y) without mutating the inputs. Pure generator (no
 * input). Multi-pass + raster → NO fusion. Internal clock → NOT is_identity.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "phase_fold_shaders.h"
#include "phase_fold_atlas.h"

#include <cmath>
#include <cstdint>
#include <algorithm>

namespace phase_fold {

// Must match common.hlsl.
static constexpr int   PF_NS          = 15;    // streamline seed grid
static constexpr int   PF_SL_STEPS    = 16;    // segments stored per streamline
static constexpr int   PF_CYCLE_ARCS  = PF_NOUT;  // parallel cycle arcs (one per seed)
static constexpr int   PF_ARC_STEPS   = 8;     // steps (segments) per cycle arc
static constexpr float PF_EXTENT      = 1.35f; // phase window half-size

static constexpr int   kStreamSegs = PF_NS * PF_NS * PF_SL_STEPS;     // 3600
static constexpr int   kCycleSegs  = PF_CYCLE_ARCS * PF_ARC_STEPS;    // 768
static constexpr int   kSegFloats  = 12;       // Segment = 3×float4
static constexpr int   kCellFloats  = PF_GRID * PF_GRID * PF_STRIDE;
static constexpr int   kCurveFloats = PF_GRID * PF_GRID * PF_NOUT * 2;

static constexpr float kPi = 3.14159265358979323846f;

// Autopilot epicycle (port of app.js): two summed circular motions 90° out of
// phase, incommensurate rates → sweeps the pad without stalling at the centre.
static constexpr float kApA = 0.34f, kApB = 0.16f, kApW2 = 0.382f, kApPhi = kPi * 0.5f;

// Uniform block — mirrors `U` in common.hlsl (std140, 96 bytes).
struct Uniforms {
  float res_x, res_y, extent, bias;
  float wind, n_bands, contrast, flow_phase;
  float nearest_cell, _pad2, stream_width, cycle_width;
  float backdrop_dim, stream_alpha, shading_mode, _pad1;
  float corners[4];
  float weights[4];
};
static_assert(sizeof(Uniforms) == 96, "Uniforms layout");

struct State {
  gpu::Buffer uniform_buf;
  gpu::Buffer cell_buf;     // PF_CELLS, uploaded once
  gpu::Buffer curve_buf;    // PF_CURVE (resting cycles), uploaded once — cycle seeds
  gpu::Buffer stream_buf;   // streamline segments
  gpu::Buffer cycle_buf;    // limit-cycle segments
  bool initialized = false;

  // --- Schema-mirrored params ---
  float eccentricity = 0.2f;   // XY pad x
  float lobedness    = 0.2f;   // XY pad y
  float wind         = 0.0f;   // z (non-potential force)
  float bias         = 0.0f;   // shifts the cycle level
  float scale        = 1.0f;   // domain zoom (higher = zoom IN, like shape_fold)
  bool  interpolate  = true;   // blend H across 4 cells vs snap
  int   shading_mode = 0;      // 0 = Bands (height field), 1 = Gradient (flow)
  float bands        = 13.0f;  // backdrop contour bands
  float contrast     = 1.6f;   // backdrop band contrast
  float backdrop_dim = 0.42f;  // backdrop colour strength (muting)
  bool  show_streamlines = true;
  float stream_width = 0.012f;
  float flow_speed   = 0.5f;   // arrow animation rate
  float line_opacity = 0.55f;
  bool  show_limit_cycle = true;
  float cycle_width  = 0.02f;
  bool  autopilot    = false;
  float ap_speed     = 0.35f;

  // --- Internal clocks (advanced in tick) ---
  float flow_phase = 0.0f;
  float orbit      = 0.0f;
  float eff_x = 0.2f, eff_y = 0.2f;   // effective XY used for rendering
};

static void apply_visibility(const State* s) {
  state::setFieldHidden("stream_width", !s->show_streamlines);
  state::setFieldHidden("flow_speed",   !s->show_streamlines);
  state::setFieldHidden("cycle_width",  !s->show_limit_cycle);
  state::setFieldHidden("ap_speed",     !s->autopilot);
}

static void on_state_ready(void* self);

// Type-shared, compiled once in module_init().
static gpu::ComputePSO s_pso_backdrop;
static gpu::ComputePSO s_pso_stream;
static gpu::ComputePSO s_pso_cycle;
static gpu::RenderPSO  s_pso_lines;

void module_init() {
  state::init("video.phase_fold", {1, 0, 0},
    state::Schema()
      // --- Shape axes (the custom XY pad drives eccentricity + lobedness) ---
      .floatField("eccentricity", 0.2f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("lobedness", 0.2f, 0.0f, 1.0f, state::PrimaryInput)
      // Wind (z): the non-potential force that distorts the cycle and, past the
      // bifurcation, kills it (the orbit collapses to a fixed point).
      .floatField("wind", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      // Bias shifts the cycle level → slides the limit cycle across contours.
      .floatField("bias", 0.0f, -0.6f, 0.6f, state::PrimaryInput)
      // Domain zoom. Higher = zoom IN (bigger features); lower zooms out.
      .floatField("scale", 1.0f, 0.1f, 8.0f, state::PrimaryInput)
      .boolField("interpolate", true, state::PrimaryInput)
      // --- Backdrop ---
      // Shading: the height-field Bands (default) or the wind-aware flow Gradient.
      .selectField("shading_mode", 0, state::PrimaryInput, {{"Bands", 0}, {"Gradient", 1}})
      .floatField("bands", 13.0f, 2.0f, 24.0f, state::PrimaryInput)
      .floatField("contrast", 1.6f, 0.4f, 4.0f, state::PrimaryInput)
      .floatField("backdrop_dim", 0.42f, 0.0f, 1.0f, state::PrimaryInput)
      // --- Streamlines (toggleable stage) ---
      .boolField("show_streamlines", true, state::PrimaryInput)
      .floatField("stream_width", 0.012f, 0.002f, 0.05f, state::PrimaryInput)
      .floatField("flow_speed", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("line_opacity", 0.55f, 0.0f, 1.0f, state::PrimaryInput)
      // --- Limit-cycle tracer (toggleable stage) ---
      .boolField("show_limit_cycle", true, state::PrimaryInput)
      .floatField("cycle_width", 0.02f, 0.004f, 0.06f, state::PrimaryInput)
      // --- Autopilot (non-destructive XY override + broadcast) ---
      .boolField("autopilot", false, state::PrimaryInput)
      .floatField("ap_speed", 0.35f, 0.0f, 1.0f, state::PrimaryInput)
      // Broadcast: effective XY so the custom editor shows the live position.
      .floatField("autopilot_x", 0.2f, 0.0f, 1.0f, state::SecondaryOutput)
      .floatField("autopilot_y", 0.2f, 0.0f, 1.0f, state::SecondaryOutput)
      // --- I/O: pure generator (no input) ---
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("phase_fold_backdrop", BACKDROP_SPV, BACKDROP_SPV_SIZE);
  state::registerShaderSPV("phase_fold_stream",   STREAM_SPV,   STREAM_SPV_SIZE);
  state::registerShaderSPV("phase_fold_cycle",    CYCLE_SPV,    CYCLE_SPV_SIZE);
  state::registerShaderSPV("phase_fold_line_vs",  LINE_VS_SPV,  LINE_VS_SPV_SIZE);
  state::registerShaderSPV("phase_fold_line_fs",  LINE_FS_SPV,  LINE_FS_SPV_SIZE);

  auto cs_backdrop = gpu::Device::createShaderModuleByName("phase_fold_backdrop");
  auto cs_stream   = gpu::Device::createShaderModuleByName("phase_fold_stream");
  auto cs_cycle    = gpu::Device::createShaderModuleByName("phase_fold_cycle");
  auto vs_lines    = gpu::Device::createShaderModuleByName("phase_fold_line_vs");
  auto fs_lines    = gpu::Device::createShaderModuleByName("phase_fold_line_fs");
  if (!cs_backdrop || !cs_stream || !cs_cycle || !vs_lines || !fs_lines) return;

  s_pso_backdrop = gpu::Device::createComputePSO(cs_backdrop, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)                                    // cells (read)
      .storageTex2d(2, gpu::TextureFormat::RGBA8));  // tex_out

  s_pso_stream = gpu::Device::createComputePSO(cs_stream, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)        // cells (read)
      .storageRW(2));    // stream segments (write)

  s_pso_cycle = gpu::Device::createComputePSO(cs_cycle, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)        // cells (read)
      .storageRW(2)      // cycle segments (write)
      .storage(3));      // curve / resting-cycle seeds (read)

  s_pso_lines = gpu::Device::createInstancedRenderPSO(
      vs_lines, "main", fs_lines, "main", gpu::TextureFormat::Surface,
      gpu::Bindings()
          .uniform(0)    // shared uniforms (vertex)
          .storage(1),   // segment buffer (vertex)
      gpu::Device::BlendMode::AlphaOver);

  state::log("phase_fold: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->cell_buf    = gpu::Device::createBuffer(kCellFloats * sizeof(float), gpu::BufferUsage::Storage);
  s->curve_buf   = gpu::Device::createBuffer(kCurveFloats * sizeof(float), gpu::BufferUsage::Storage);
  s->stream_buf  = gpu::Device::createBuffer(kStreamSegs * kSegFloats * sizeof(float), gpu::BufferUsage::Storage);
  s->cycle_buf   = gpu::Device::createBuffer(kCycleSegs * kSegFloats * sizeof(float), gpu::BufferUsage::Storage);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->cell_buf.release();
  s->curve_buf.release();
  s->stream_buf.release();
  s->cycle_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_pso_backdrop.valid() || !s_pso_stream.valid() ||
      !s_pso_cycle.valid() || !s_pso_lines.valid()) return;
  if (!s->uniform_buf.valid() || !s->cell_buf.valid() || !s->curve_buf.valid() ||
      !s->stream_buf.valid() || !s->cycle_buf.valid()) return;
  // Upload the (immutable) atlas cell + resting-cycle buffers once.
  s->cell_buf.write(PF_CELLS, kCellFloats);
  s->curve_buf.write(PF_CURVE, kCurveFloats);
  s->initialized = true;
  state::setOnStateReady(&on_state_ready);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_visibility(s);
}

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static inline int   clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Port of app.js corners(): bilinear (smoothstep) 4-cell blend or nearest snap,
// re-weighted by per-cell validity. Also returns the nearest cell (for the
// limit-cycle seed) and whether any valid cell was hit.
static void compute_corners(const State* s, float sx, float sy,
                            float corners[4], float weights[4], int& nearest) {
  const int G = PF_GRID;
  float fx = clampf(sx, 0.0f, 1.0f) * (G - 1);
  float fy = clampf(sy, 0.0f, 1.0f) * (G - 1);
  int x0, x1, y0, y1; float tx, ty;
  if (s->interpolate) {
    x0 = clampi((int)std::floor(fx), 0, G - 1); x1 = std::min(x0 + 1, G - 1); tx = fx - x0;
    y0 = clampi((int)std::floor(fy), 0, G - 1); y1 = std::min(y0 + 1, G - 1); ty = fy - y0;
    tx = tx * tx * (3.0f - 2.0f * tx);   // smoothstep → C¹ across grid lines
    ty = ty * ty * (3.0f - 2.0f * ty);
  } else {
    x0 = x1 = clampi((int)std::lround(fx), 0, G - 1);
    y0 = y1 = clampi((int)std::lround(fy), 0, G - 1);
    tx = ty = 0.0f;
  }
  int idx[4] = { y0 * G + x0, y0 * G + x1, y1 * G + x0, y1 * G + x1 };
  float w[4] = { (1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty };
  float sum = 0.0f;
  for (int i = 0; i < 4; i++) { w[i] *= PF_VALID[idx[i]]; sum += w[i]; }
  if (sum > 1e-4f) for (int i = 0; i < 4; i++) w[i] /= sum;
  for (int i = 0; i < 4; i++) { corners[i] = (float)idx[i]; weights[i] = w[i]; }
  int c = clampi((int)std::lround(sx * (G - 1)), 0, G - 1);
  int r = clampi((int)std::lround(sy * (G - 1)), 0, G - 1);
  nearest = r * G + c;
}

static inline void orbit_xy(float orbit, float& ox, float& oy) {
  ox = clampf(0.5f + kApA * std::cos(orbit) + kApB * std::cos(orbit * kApW2 + kApPhi), 0.01f, 0.99f);
  oy = clampf(0.5f + kApA * std::sin(orbit) + kApB * std::sin(orbit * kApW2 + kApPhi), 0.01f, 0.99f);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  float fdt = (float)dt;

  // Arrows flow down the streamlines (frozen at flow_speed = 0).
  s->flow_phase += fdt * s->flow_speed * 0.4f;
  s->flow_phase -= std::floor(s->flow_phase);

  if (s->autopilot) {
    float ap_actual = 0.05f + s->ap_speed * s->ap_speed * (1.6f - 0.05f);
    s->orbit -= fdt * ap_actual;   // clockwise drift
    orbit_xy(s->orbit, s->eff_x, s->eff_y);
  } else {
    s->eff_x = s->eccentricity;
    s->eff_y = s->lobedness;
  }

  auto vx = val::number(s->eff_x);
  state::setValPath("autopilot_x", vx);
  val::release(vx);
  auto vy = val::number(s->eff_y);
  state::setValPath("autopilot_y", vy);
  val::release(vy);
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  bool vis_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "eccentricity"))   s->eccentricity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "lobedness"))      s->lobedness = state::patchFloat(i);
    else if (state::pathIs(path, plen, "wind"))           s->wind = state::patchFloat(i);
    else if (state::pathIs(path, plen, "bias"))           s->bias = state::patchFloat(i);
    else if (state::pathIs(path, plen, "scale"))          s->scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "interpolate"))    s->interpolate = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "shading_mode"))   s->shading_mode = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "bands"))          s->bands = state::patchFloat(i);
    else if (state::pathIs(path, plen, "contrast"))       s->contrast = state::patchFloat(i);
    else if (state::pathIs(path, plen, "backdrop_dim"))   s->backdrop_dim = state::patchFloat(i);
    else if (state::pathIs(path, plen, "show_streamlines")) { bool v = state::patchFloat(i) != 0.0f; if (v != s->show_streamlines) { s->show_streamlines = v; vis_changed = true; } }
    else if (state::pathIs(path, plen, "stream_width"))   s->stream_width = state::patchFloat(i);
    else if (state::pathIs(path, plen, "flow_speed"))     s->flow_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "line_opacity"))   s->line_opacity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "show_limit_cycle")) { bool v = state::patchFloat(i) != 0.0f; if (v != s->show_limit_cycle) { s->show_limit_cycle = v; vis_changed = true; } }
    else if (state::pathIs(path, plen, "cycle_width"))    s->cycle_width = state::patchFloat(i);
    else if (state::pathIs(path, plen, "autopilot"))      { bool v = state::patchFloat(i) != 0.0f; if (v != s->autopilot) { s->autopilot = v; vis_changed = true; } }
    else if (state::pathIs(path, plen, "ap_speed"))       s->ap_speed = state::patchFloat(i);
  }
  if (vis_changed) apply_visibility(s);
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  int nearest = 0;
  Uniforms u = {};
  u.res_x = (float)vp_w;
  u.res_y = (float)vp_h;
  // Domain zoom: higher scale → smaller visible extent → bigger features.
  u.extent = PF_EXTENT / (s->scale > 1e-2f ? s->scale : 1e-2f);
  u.shading_mode = (float)s->shading_mode;
  u.bias = s->bias;
  u.wind = s->wind;
  u.n_bands = s->bands;
  u.contrast = s->contrast;
  u.flow_phase = s->flow_phase;
  u.stream_width = s->stream_width;
  u.cycle_width = s->cycle_width;
  u.backdrop_dim = s->backdrop_dim;
  u.stream_alpha = s->line_opacity;
  compute_corners(s, s->eff_x, s->eff_y, u.corners, u.weights, nearest);
  // The parallel cycle tracer seeds on the nearest cell's baked resting cycle
  // (curve_buf), so it just needs the cell index.
  u.nearest_cell = (float)nearest;
  s->uniform_buf.writeOne(u);

  // 1 — backdrop (seeds tex_out).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_backdrop);
    cp.setBuffer(s->uniform_buf, 0);
    cp.setBuffer(s->cell_buf, 1);
    cp.setTexture(out, 2, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // 2 — streamlines: trace (compute) then raster over the backdrop.
  if (s->show_streamlines) {
    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(s_pso_stream);
      cp.setBuffer(s->uniform_buf, 0);
      cp.setBuffer(s->cell_buf, 1);
      cp.setBuffer(s->stream_buf, 2);
      cp.dispatch((PF_NS * PF_NS + 63) / 64, 1, 1);
      cp.end();
    }
    {
      auto rp = gpu::RenderPass::beginLoad(out);
      rp.setPSO(s_pso_lines);
      rp.setBuffer(s->uniform_buf, 0);
      rp.setBuffer(s->stream_buf, 1);
      rp.draw(6, kStreamSegs);
      rp.end();
    }
  }

  // 3 — limit-cycle tracer: integrate (compute) then raster over the backdrop.
  if (s->show_limit_cycle) {
    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(s_pso_cycle);
      cp.setBuffer(s->uniform_buf, 0);
      cp.setBuffer(s->cell_buf, 1);
      cp.setBuffer(s->cycle_buf, 2);
      cp.setBuffer(s->curve_buf, 3);
      cp.dispatch((PF_CYCLE_ARCS + 63) / 64, 1, 1);
      cp.end();
    }
    {
      auto rp = gpu::RenderPass::beginLoad(out);
      rp.setPSO(s_pso_lines);
      rp.setBuffer(s->uniform_buf, 0);
      rp.setBuffer(s->cycle_buf, 1);
      rp.draw(6, kCycleSegs);
      rp.end();
    }
  }

  gpu::Device::submit();
}

} // namespace phase_fold
