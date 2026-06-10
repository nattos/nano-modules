/*
 * video.shape_fold — evolving-shape generator.
 *
 * Productionized from the shape-fold research testbed. A baked 3D atlas of
 * resolved shape parameters — axes frequency (x) × simplicity (y) × temporal-
 * complexity (z) — is interpolated on the CPU each frame (sampleTerms) down to
 * a handful of "terms" + dc/bold_gain; those ride in the uniform buffer and the
 * GPU evaluates the scalar SDF field from them. The atlas itself never touches
 * the GPU (it's CPU-only constant data in shape_fold_atlas.h).
 *
 * The field is histogram auto-leveled (median → 0) every frame and shown as
 * grayscale or magma — the raw field, no line/contour/shading modes (dropped on
 * purpose; downstream effects style it). The square field COVERS the viewport
 * uniformly (no bars) with a domain `scale` zoom.
 *
 * Autopilot spirals the (x,y) automatically via an epicycle. It is
 * NON-destructive: it overrides the effective XY internally for rendering but
 * never mutates the frequency/simplicity inputs — instead it broadcasts the
 * current XY on the autopilot_x / autopilot_y output fields so the web UI's
 * custom XY-pad editor can show the live position.
 *
 * GPU passes (one submit): minmax → hist → buildlut → present (auto-levels),
 * sharing common.hlsl. Generator → only tex_out, no tex_in. Multi-pass → NO
 * fusion. Internal time/orbit clock → NOT is_identity.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "shape_fold_shaders.h"
#include "shape_fold_atlas.h"

#include <cmath>
#include <cstdint>
#include <algorithm>

namespace shape_fold {

// Must match the #defines in common.hlsl (the HLSL constants aren't visible to
// C++; the shaders header carries only SPV bytecode).
static constexpr int SF_MAX_TERMS = 8;     // resolved-term array size in the uniform block
static constexpr int SF_NB        = 256;   // histogram bins / LUT entries
static constexpr int SF_SN        = 160;   // auto-levels downsample grid

static constexpr float kPi = 3.14159265358979323846f;
static constexpr float kLoopSecs = 6.0f;   // time_speed=1 → ~6 s loop (testbed dt/6)

// Autopilot epicycle constants (verbatim from app.js). Two summed circular
// motions, 90° out of phase, incommensurate rates → sweeps the annulus without
// stalling at the centre.
static constexpr float kApA = 0.29f, kApB = 0.16f, kApW2 = 0.382f, kApPhi = kPi * 0.5f;
// Golden angle — used to advance the orbit on a snap/trigger jump so each new
// point is well-spread and distinct even when the orbit is barely drifting.
static constexpr float kGoldenAngle = 2.39996323f;

// Uniform block — mirrors SF_UNIFORMS in common.hlsl (std140). 3 scalar rows
// then the resolved terms (per term: (theta,mtheta,curv,freq)(phase,h,k,amp)
// (mix,spc,_,_)).
struct Uniforms {
  float res_x, res_y, n_terms, dc;
  float bold_gain, birth_softness, domain_scale, level_ease;
  float output_mode, exposure, _pad1, _pad2;
  float terms[SF_MAX_TERMS * 3 * 4];
};
static_assert(sizeof(Uniforms) == (12 + SF_MAX_TERMS * 3 * 4) * 4, "Uniforms layout");

// stats buffer (ints): [0]=lo(asint), [1]=hi(asint), [2..2+NB-1]=hist.
static constexpr int kStatsInts = 2 + SF_NB;
// lut buffer (floats): [0..NB-1]=LUT, [NB]=lo, [NB+1]=hi, [NB+2]=blank.
static constexpr int kLutFloats = SF_NB + 4;

struct State {
  gpu::Buffer uniform_buf;
  gpu::Buffer stats_buf;
  gpu::Buffer lut_buf;
  bool initialized = false;

  // --- Schema-mirrored params ---
  float frequency           = 0.25f;
  float simplicity          = 0.85f;
  float temporal_complexity = 0.66f;
  float scale               = 1.0f;    // domain zoom (>1 reveals beyond [-1,1])
  float time_speed          = 0.58f;   // [0,1] quadratic → ~1.0 actual (≈6 s loop)
  float ease                = 0.0f;
  float birth_softness      = 0.45f;
  bool  autopilot           = false;
  float ap_speed            = 0.43f;   // [0,1] quadratic → ~0.6 actual
  bool  ap_snap             = false;
  float ap_hold_period      = 2.0f;    // seconds; 0 = no auto-jump (trigger only)
  float ap_hold_jitter      = 0.0f;    // 0..1 → randomize each hold interval ±fraction
  float level_ease          = 0.25f;
  float exposure            = 1.0f;    // pre-grade value drive (boost / reduce)
  int   output_mode         = 1;       // 0 = Grayscale, 1 = Magma (default)

  // --- Internal clocks (advanced in tick) ---
  float clock_t   = 0.0f;              // loop phase 0..1
  float orbit     = 0.0f;              // autopilot epicycle phase
  float snap_accum = 0.0f;            // snap-mode hold timer
  float next_hold  = 0.0f;            // jittered target for the current interval
  uint32_t rng     = 0x2545F491u;     // per-instance PRNG state (seeded in create)
  bool  held_valid = false;
  float held_x = 0.5f, held_y = 0.5f;
  float eff_x = 0.25f, eff_y = 0.85f;  // effective XY used for rendering
  float ap_jump_prev = 0.0f;           // rising-edge state for the jump trigger
  bool  ap_jump_pending = false;       // a trigger fired since the last tick
};

static void apply_visibility(bool autopilot, bool ap_snap) {
  state::setFieldHidden("ap_speed",       !autopilot);
  state::setFieldHidden("ap_snap",        !autopilot);
  state::setFieldHidden("ap_hold_period", !(autopilot && ap_snap));
  state::setFieldHidden("ap_hold_jitter", !(autopilot && ap_snap));
  state::setFieldHidden("ap_jump",        !(autopilot && ap_snap));
}

static void on_state_ready(void* self);

// Type-shared, compiled once in module_init().
static gpu::ComputePSO s_pso_minmax;
static gpu::ComputePSO s_pso_hist;
static gpu::ComputePSO s_pso_buildlut;
static gpu::ComputePSO s_pso_present;

void module_init() {
  state::init("video.shape_fold", {1, 0, 0},
    state::Schema()
      // --- Shape axes (the custom XY pad drives frequency + simplicity) ---
      .floatField("frequency", 0.25f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("simplicity", 0.85f, 0.0f, 1.0f, state::PrimaryInput)
      // Temporal-complexity (z): 0 = hold still → 1 = animate as richly as the
      // shape allows (trilinear trajectory layer select).
      .floatField("temporal_complexity", 0.66f, 0.0f, 1.0f, state::PrimaryInput)
      // Zoom. Higher = zoom IN (bigger features); lower zooms out, revealing
      // more of the periodic field beyond the prototype's [-1,1] window.
      .floatField("scale", 1.0f, 0.1f, 8.0f, state::PrimaryInput)
      // --- Animation ---
      // Autoplay clock speed (0 = frozen). [0,1] with a quadratic bend onto the
      // real 0..3 range, so the low end has fine control.
      .floatField("time_speed", 0.58f, 0.0f, 1.0f, state::PrimaryInput)
      // Time-warp (bipolar). τ(t) = t − (ease/2π)·sin(2π t). +1 = rest at the
      // loop point, surge through the middle; −1 = surge at the loop point, rest
      // in the middle; 0 = uniform. |ease|≤1 keeps it monotone.
      .floatField("ease", 0.0f, -1.0f, 1.0f, state::PrimaryInput)
      // How gradually AND-edges fade in/out (the soft birth gate width).
      .floatField("birth_softness", 0.45f, 0.02f, 1.0f, state::PrimaryInput)
      // --- Autopilot (non-destructive XY override + broadcast) ---
      .boolField("autopilot", false, state::PrimaryInput)
      // Orbit speed. [0,1] with a quadratic bend onto the real 0.05..3 range.
      .floatField("ap_speed", 0.43f, 0.0f, 1.0f, state::PrimaryInput)
      // Snap: hold the current shape, then jump to a new point.
      .boolField("ap_snap", false, state::PrimaryInput)
      // Hold seconds between auto-jumps. 0 = never auto-jump (hold until the
      // jump trigger fires).
      .floatField("ap_hold_period", 2.0f, 0.0f, 8.0f, state::PrimaryInput)
      // Randomize each hold interval by ± this fraction of the base period.
      .floatField("ap_hold_jitter", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      // Jump now — switch to a fresh point immediately (and reset the hold timer).
      .eventField("ap_jump", state::PrimaryInput)
      // --- Auto-levels (histogram normalization, median → 0) ---
      // Below this contrast, taper the auto-levels boost so the field eases
      // toward black instead of flashing as it collapses to solid.
      .floatField("level_ease", 0.25f, 0.0f, 0.5f, state::PrimaryInput)
      // --- Output ---
      // Pre-grade value drive: >1 boosts (pushes brights into the rolloff),
      // <1 reduces toward mid. 1 = unity.
      .floatField("exposure", 1.0f, 0.0f, 4.0f, state::PrimaryInput)
      .selectField("output_mode", 1, state::PrimaryInput,
                   {{"Grayscale", 0}, {"Magma", 1}, {"Inferno", 2},
                    {"Viridis", 3}, {"Plasma", 4}, {"Turbo", 5}})
      // Broadcast: the effective XY (epicycle when autopilot is on, else the
      // input XY) so the custom editor can show the live position.
      .floatField("autopilot_x", 0.25f, 0.0f, 1.0f, state::SecondaryOutput)
      .floatField("autopilot_y", 0.85f, 0.0f, 1.0f, state::SecondaryOutput)
      // --- I/O: pure generator (no input) ---
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // minmax/hist/buildlut write storage BUFFERS (no format hint); present writes
  // an rgba8 storage texture (default).
  state::registerShaderSPV("shape_fold_minmax",   MINMAX_SPV,   MINMAX_SPV_SIZE);
  state::registerShaderSPV("shape_fold_hist",     HIST_SPV,     HIST_SPV_SIZE);
  state::registerShaderSPV("shape_fold_buildlut", BUILDLUT_SPV, BUILDLUT_SPV_SIZE);
  state::registerShaderSPV("shape_fold_present",  PRESENT_SPV,  PRESENT_SPV_SIZE);

  auto cs_minmax   = gpu::Device::createShaderModuleByName("shape_fold_minmax");
  auto cs_hist     = gpu::Device::createShaderModuleByName("shape_fold_hist");
  auto cs_buildlut = gpu::Device::createShaderModuleByName("shape_fold_buildlut");
  auto cs_present  = gpu::Device::createShaderModuleByName("shape_fold_present");
  if (!cs_minmax || !cs_hist || !cs_buildlut || !cs_present) return;

  s_pso_minmax = gpu::Device::createComputePSO(cs_minmax, "main", gpu::Bindings()
      .uniform(0)
      .storageRW(1));       // stats (atomic min/max)

  s_pso_hist = gpu::Device::createComputePSO(cs_hist, "main", gpu::Bindings()
      .uniform(0)
      .storageRW(1));       // stats (atomic add)

  s_pso_buildlut = gpu::Device::createComputePSO(cs_buildlut, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)           // stats (read)
      .storageRW(2));       // lut (write)

  s_pso_present = gpu::Device::createComputePSO(cs_present, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)                                   // lut (read)
      .storageTex2d(2, gpu::TextureFormat::RGBA8)); // tex_out

  state::log("shape_fold: module initialized");
}

// Distinct PRNG seed per instance (no wall-clock / RNG primitive needed).
static uint32_t s_seed_counter = 0x9E3779B9u;

void* create() {
  auto* s = new State();
  s_seed_counter = s_seed_counter * 1664525u + 1013904223u;
  s->rng = s_seed_counter ^ 0xC0FFEEu;
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->stats_buf   = gpu::Device::createBuffer(kStatsInts * sizeof(int32_t), gpu::BufferUsage::Storage);
  s->lut_buf     = gpu::Device::createBuffer(kLutFloats * sizeof(float), gpu::BufferUsage::Storage);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->stats_buf.release();
  s->lut_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_pso_minmax.valid() || !s_pso_hist.valid() ||
      !s_pso_buildlut.valid() || !s_pso_present.valid()) return;
  if (!s->uniform_buf.valid() || !s->stats_buf.valid() || !s->lut_buf.valid()) return;
  s->initialized = true;
  state::setOnStateReady(&on_state_ready);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_visibility(s->autopilot, s->ap_snap);
}

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static inline float lerpf(float a, float b, float f) { return a + (b - a) * f; }
static inline int   clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Per-instance uniform random in [0,1) (LCG).
static inline float rng_unit(State* s) {
  s->rng = s->rng * 1664525u + 1013904223u;
  return (float)((s->rng >> 8) & 0xFFFFFFu) / (float)0x1000000;
}

// Epicycle position at a given orbit phase. Two summed circular motions, 90°
// out of phase — sweeps the annulus without stalling at the centre. Clamped to
// stay inside the pad. Port of app.js's autopilot.
static inline void orbit_xy(float orbit, float& ox, float& oy) {
  float a1 = orbit;
  float a2 = orbit * kApW2 + kApPhi;
  ox = clampf(0.5f + kApA * std::cos(a1) + kApB * std::cos(a2), 0.03f, 0.97f);
  oy = clampf(0.5f + kApA * std::sin(a1) + kApB * std::sin(a2), 0.03f, 0.97f);
}

// Advance the internal clocks and compute the effective (broadcast) XY.
void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  float fdt = (float)dt;

  // Quadratic speed response: the [0,1] params bend onto their real ranges
  // (time 0..3, ap 0.05..3) so the low end has fine control.
  float time_actual = s->time_speed * s->time_speed * 3.0f;
  float ap_actual   = 0.05f + s->ap_speed * s->ap_speed * (3.0f - 0.05f);

  s->clock_t += fdt * time_actual / kLoopSecs;
  s->clock_t -= std::floor(s->clock_t);

  if (s->autopilot) {
    s->orbit -= fdt * ap_actual;                 // clockwise drift

    bool trig = s->ap_jump_pending;
    s->ap_jump_pending = false;

    if (s->ap_snap) {
      bool hold_on = s->ap_hold_period > 1e-4f;
      bool jump = trig || !s->held_valid;        // trigger or first frame
      if (hold_on) {                             // auto-jump only when Hold > 0
        s->snap_accum += fdt;
        if (s->snap_accum >= s->next_hold) jump = true;
      }
      if (jump) {
        // Hold ON: snap to where the drifting orbit currently is — "where the
        // continuous autopilot point would have been" (auto-jump AND trigger).
        // Hold OFF: the trigger advances to a fresh random orbit point.
        if (trig && !hold_on && s->held_valid) s->orbit -= kGoldenAngle;
        orbit_xy(s->orbit, s->held_x, s->held_y);
        s->held_valid = true;
        s->snap_accum = 0.0f;                     // reset the hold timer
        // Schedule the next interval, jittered ± a fraction of the base period.
        float jit = s->ap_hold_jitter * (2.0f * rng_unit(s) - 1.0f);
        s->next_hold = s->ap_hold_period * (1.0f + jit);
        if (s->next_hold < 0.02f) s->next_hold = 0.02f;
      }
      s->eff_x = s->held_x; s->eff_y = s->held_y;
    } else {
      if (trig) s->orbit -= kGoldenAngle;         // a manual switch in continuous too
      orbit_xy(s->orbit, s->eff_x, s->eff_y);
      s->held_valid = false;
    }
  } else {
    s->eff_x = s->frequency;
    s->eff_y = s->simplicity;
    s->held_valid = false;          // re-enabling snap jumps immediately
    s->snap_accum = 0.0f;
    s->ap_jump_pending = false;     // ignore triggers while autopilot is off
  }

  // Broadcast the effective XY so the editor can show the live position.
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
  bool mode_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "frequency"))           s->frequency = state::patchFloat(i);
    else if (state::pathIs(path, plen, "simplicity"))          s->simplicity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "temporal_complexity")) s->temporal_complexity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "scale"))               s->scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "time_speed"))          s->time_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ease"))                s->ease = state::patchFloat(i);
    else if (state::pathIs(path, plen, "birth_softness"))      s->birth_softness = state::patchFloat(i);
    else if (state::pathIs(path, plen, "autopilot"))           { bool v = state::patchFloat(i) != 0.0f; if (v != s->autopilot) { s->autopilot = v; mode_changed = true; } }
    else if (state::pathIs(path, plen, "ap_speed"))            s->ap_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ap_snap"))             { bool v = state::patchFloat(i) != 0.0f; if (v != s->ap_snap) { s->ap_snap = v; mode_changed = true; } }
    else if (state::pathIs(path, plen, "ap_hold_period"))      s->ap_hold_period = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ap_hold_jitter"))      s->ap_hold_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ap_jump")) {
      float v = state::patchFloat(i);
      if (v != 0.0f && s->ap_jump_prev == 0.0f) s->ap_jump_pending = true;  // rising edge
      s->ap_jump_prev = v;
    }
    else if (state::pathIs(path, plen, "level_ease"))          s->level_ease = state::patchFloat(i);
    else if (state::pathIs(path, plen, "exposure"))            s->exposure = state::patchFloat(i);
    else if (state::pathIs(path, plen, "output_mode"))         s->output_mode = (int)state::patchFloat(i);
  }
  if (mode_changed) apply_visibility(s->autopilot, s->ap_snap);
}

// CPU atlas resolve: bilinear over (x,y) for base/cell fields, trilinear over
// (x,y,z) for the temporal trajectory, then the periodic time model. Port of
// sampleTerms in app.js. Fills u.terms / u.n_terms / u.dc / u.bold_gain.
static void sample_terms(const State* s, float sx, float sy, float t, Uniforms& u) {
  const int G = SF_GRID, B = SF_NTERMS, Z = SF_NZ;
  float fx = clampf(sx, 0.0f, 1.0f) * (G - 1);
  float fy = clampf(sy, 0.0f, 1.0f) * (G - 1);
  int x0 = clampi((int)std::floor(fx), 0, G - 1), y0 = clampi((int)std::floor(fy), 0, G - 1);
  int x1 = std::min(x0 + 1, G - 1), y1 = std::min(y0 + 1, G - 1);
  float tx = fx - x0, ty = fy - y0;
  int c00 = y0 * G + x0, c01 = y0 * G + x1, c10 = y1 * G + x0, c11 = y1 * G + x1;
  float fz = clampf(s->temporal_complexity, 0.0f, 1.0f) * (Z - 1);
  int z0 = clampi((int)std::floor(fz), 0, Z - 1), z1 = std::min(z0 + 1, Z - 1);
  float tz = fz - z0;

  auto baseBi = [&](const float* arr, int i) {
    return lerpf(lerpf(arr[c00 * B + i], arr[c01 * B + i], tx),
                 lerpf(arr[c10 * B + i], arr[c11 * B + i], tx), ty);
  };
  auto layerBi = [&](const float* arr, int i, int z) {
    int o = z * B;
    return lerpf(lerpf(arr[c00 * Z * B + o + i], arr[c01 * Z * B + o + i], tx),
                 lerpf(arr[c10 * Z * B + o + i], arr[c11 * Z * B + o + i], tx), ty);
  };
  auto scriptTri = [&](const float* arr, int i) {
    return lerpf(layerBi(arr, i, z0), layerBi(arr, i, z1), tz);
  };
  auto cellBi = [&](const float* arr) {
    return lerpf(lerpf(arr[c00], arr[c01], tx), lerpf(arr[c10], arr[c11], tx), ty);
  };

  // Eased time: rests at the loop point, surges through the middle. Seamless
  // (τ(0)=0, τ(1)=1) so integer omega/drift keep the loop closed.
  float tau = t - (s->ease / (2.0f * kPi)) * std::sin(2.0f * kPi * t);

  int nt = std::min(B, SF_MAX_TERMS);
  for (int i = 0; i < nt; i++) {
    float h0 = baseBi(SF_H, i), phase0 = baseBi(SF_PHASE, i);
    float ampH = scriptTri(SF_AMP_H, i);
    float omega = std::round(scriptTri(SF_OMEGA_H, i));   // integer periods → loop closes
    float psi = scriptTri(SF_PSI_H, i);
    float drift = std::round(scriptTri(SF_DRIFT, i));
    float h = h0 + ampH * std::sin(2.0f * kPi * (omega * tau + psi));   // periodic height/birth
    float phase = phase0 + drift * tau;                                // periodic normal sweep
    int o = i * 3 * 4;
    u.terms[o + 0] = baseBi(SF_THETA, i);
    u.terms[o + 1] = baseBi(SF_MTHETA, i);
    u.terms[o + 2] = baseBi(SF_CURV, i);
    u.terms[o + 3] = baseBi(SF_FREQ, i);
    u.terms[o + 4] = phase;
    u.terms[o + 5] = h;
    u.terms[o + 6] = baseBi(SF_K, i);
    u.terms[o + 7] = baseBi(SF_AMP, i);
    u.terms[o + 8] = baseBi(SF_MIX, i);
    u.terms[o + 9] = baseBi(SF_SPC, i);
    u.terms[o + 10] = 0.0f;
    u.terms[o + 11] = 0.0f;
  }
  for (int i = nt; i < SF_MAX_TERMS; i++) {
    int o = i * 3 * 4;
    for (int k = 0; k < 12; k++) u.terms[o + k] = 0.0f;
  }
  u.n_terms = (float)nt;
  u.dc = cellBi(SF_DC);
  u.bold_gain = cellBi(SF_BOLD_GAIN);
}

// Buffer-only dispatch: uniform at slot 0, plus up to two storage buffers.
static inline void disp_buf(const gpu::ComputePSO& pso, int x, int y,
                            const gpu::Buffer& ub,
                            const gpu::Buffer* b1, int b1slot,
                            const gpu::Buffer* b2, int b2slot) {
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(pso);
  cp.setBuffer(ub, 0);
  if (b1) cp.setBuffer(*b1, b1slot);
  if (b2) cp.setBuffer(*b2, b2slot);
  cp.dispatch(x, y);
  cp.end();
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  Uniforms u = {};
  u.res_x = (float)vp_w;
  u.res_y = (float)vp_h;
  u.birth_softness = s->birth_softness;
  // `scale` is user-facing zoom (higher = zoom IN = bigger features), so the
  // sampled domain shrinks: p = sq / scale.
  u.domain_scale = (s->scale > 1e-4f) ? 1.0f / s->scale : 1.0f;
  u.level_ease = s->level_ease;
  u.exposure = s->exposure;
  u.output_mode = (float)s->output_mode;
  sample_terms(s, s->eff_x, s->eff_y, s->clock_t, u);
  s->uniform_buf.writeOne(u);

  // Reset stats: lo = +INF-ish (max i32), hi = 0 (F ≥ 0), hist = 0.
  int32_t reset[kStatsInts];
  reset[0] = 0x7fffffff;
  reset[1] = 0;
  for (int i = 2; i < kStatsInts; i++) reset[i] = 0;
  s->stats_buf.write(reset, kStatsInts);

  int sg = (SF_SN + 7) / 8;

  // 1 — field min/max over the SN×SN grid.
  disp_buf(s_pso_minmax, sg, sg, s->uniform_buf, &s->stats_buf, 1, nullptr, 0);
  // 2 — histogram into the same stats buffer.
  disp_buf(s_pso_hist, sg, sg, s->uniform_buf, &s->stats_buf, 1, nullptr, 0);
  // 3 — invert the histogram into the remap LUT (single invocation).
  disp_buf(s_pso_buildlut, 1, 1, s->uniform_buf, &s->stats_buf, 1, &s->lut_buf, 2);

  // 4 — present: auto-leveled field → grayscale / magma, square-fit.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_present);
    cp.setBuffer(s->uniform_buf, 0);
    cp.setBuffer(s->lut_buf, 1);
    cp.setTexture(out, 2, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace shape_fold
