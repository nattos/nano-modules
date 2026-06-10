/*
 * gen.chroma_wave — charge-and-burst prismatic wave bloom.
 *
 * A soft super-gaussian blob grows out of the top-center while gated. While
 * held, "pressure" builds: the top flattens into a plateau, the blob breaks
 * XY symmetry (elongates in X) and the density hollows at the top so the mass
 * piles into a downward CRESCENT — the max-pressure point. On release it
 * BURSTS: radius expands rapidly, crescent opens out, contrast shallows, and
 * the colour-grade transfer scrolls so prismatic bands fold and travel down
 * the density gradient (dominant) while secondary bands wash back up the inner
 * edge.
 *
 * Phase machine (CPU): IDLE → CHARGE (held) → BURST (released) → IDLE. The
 * blob's geometry + grade params are computed each frame from `charge_t`
 * (pressure 0→1 while held, capped) and `burst_t` (0→1 over release_s). At the
 * CHARGE→BURST transition we snapshot the strain so the burst expands from
 * wherever the charge got to.
 *
 * Trigger surface (§8.1): real `gate`/`level`/`default_gate_state` hold the
 * charge continuously; `trigger` event + `auto_rate` Poisson synthesize a
 * one-shot hold of `min_sustain_s` then auto-release. The trigger event is
 * IDLE-guarded against state-replay re-arming.
 *
 * The blob's colour is GENERATED (graded from the density field), not read
 * from the input — tex_in is the background we composite the additive bloom
 * over. Single compute pass.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "chroma_wave_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace chroma_wave {

enum Phase : int {
  PHASE_IDLE   = 0,
  PHASE_CHARGE = 1,
  PHASE_BURST  = 2,
};

struct Uniforms {
  // row 0
  float cx;
  float cy;
  float radius;
  float elong;
  // row 1
  float ycomp;
  float sharp;
  float plateau_p;
  float cres;
  // row 2
  float cres_off;
  float grade_freq;
  float grade_phase;
  float hue_span;
  // row 3
  float base_hue;
  float saturation;
  float band_contrast;
  float alpha_gamma;
  // row 4
  float overlay_alpha;
  float intensity;
  float color_r;
  float color_g;
  // row 5
  float color_b;
  float debug_field;
  float band_tilt;
  float _pad1;
};
static_assert(sizeof(Uniforms) == 96, "Uniforms layout mismatch");

struct State {
  gpu::Buffer uniform_buf;
  bool        initialized = false;

  // --- Standard trigger surface ---
  bool  gate               = false;
  float level              = 0.0f;
  float auto_rate          = 0.15f;
  bool  default_gate_state = false;

  // --- Position --- (signed: -1 = left/top edge, 0 = center, +1 = right/
  // bottom edge; range extends to ±2 so the blob can sit well off-canvas.)
  float position_x = 0.0f;
  float position_y = -0.7f;    // top-center

  // --- Charge / pressure shape ---
  float charge_s         = 0.6f;
  float base_radius      = 0.12f;
  float charge_expand    = 2.3f;    // size multiplier reached at full charge
  float size_smoothing   = 0.06f;   // seconds; exp-smooth the blob radius
  float gaussian_sharp   = 4.0f;
  float plateau_amount   = 0.6f;
  float squish_amount    = 0.5f;
  float crescent_amount  = 0.7f;
  float crescent_offset  = 0.5f;

  // --- Burst ---
  float release_s      = 0.7f;
  float release_expand = 3.0f;
  float release_curve  = 0.4f;     // signed slider; fx::signedSliderToExp
  float min_sustain_s  = 0.2f;
  float burst_shallow  = 0.7f;

  // --- Colour grade ---
  float base_hue           = 0.55f;
  float hue_span           = 0.18f;
  float saturation         = 0.85f;
  float grade_freq_hold    = 1.5f;
  float grade_freq_burst   = 7.0f;
  float fold_rate          = 1.5f;
  float band_contrast      = 0.6f;
  float band_tilt          = 0.0f;
  float alpha_gamma        = 1.2f;
  float color_r            = 1.0f;
  float color_g            = 1.0f;
  float color_b            = 1.0f;
  float overlay_alpha_hold = 0.3f;
  float overlay_alpha_burst = 0.7f;
  float intensity          = 1.0f;

  bool  debug_field = false;

  // --- Runtime state machine ---
  Phase    phase         = PHASE_IDLE;
  float    charge_t       = 0.0f;     // pressure 0→1 while held
  float    burst_t        = 0.0f;     // 0→1 over release_s
  float    strain_at_release = 0.0f;  // charge_t snapshot at burst start
  float    smooth_radius  = 0.0f;     // exp-smoothed blob radius
  bool     snap_radius    = true;     // skip smoothing this frame (retrigger)
  bool     gate_prev      = false;
  bool     trigger_prev   = false;    // rising-edge detect for the event field
  bool     trigger_pulse  = false;
  double   trigger_hold_remaining = 0.0;
  double   grade_phase    = 0.0;      // scrolling transfer accumulator
  uint32_t rng_state      = 0xC0FFEE11u;
};

static gpu::ComputePSO s_pso;

static inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }
static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline float smooth01(float x) {
  x = clampf(x, 0.0f, 1.0f);
  return x * x * (3.0f - 2.0f * x);
}
static inline float smoothband(float x, float lo, float hi) {
  if (hi <= lo) return x >= hi ? 1.0f : 0.0f;
  return smooth01((x - lo) / (hi - lo));
}

void module_init() {
  state::init("gen.chroma_wave", {1, 0, 0},
    state::Schema()
      // --- Standard trigger surface ---
      .boolField ("gate",               false,                  state::PrimaryInput)
      .eventField("trigger",                                    state::PrimaryInput)
      .floatField("level",              0.0f, 0.0f, 1.0f,       state::PrimaryInput)
      .floatField("auto_rate",          0.15f, 0.0f, 1.0f,      state::PrimaryInput)
      .boolField ("default_gate_state", false,                  state::PrimaryInput)

      // --- Position --- (signed: -1 = left/top edge, 0 = center, +1 =
      // right/bottom edge; ±2 lets the blob originate off-canvas.)
      .floatField("position_x",         0.0f,  -2.0f, 2.0f,     state::PrimaryInput)
      .floatField("position_y",         -0.7f, -2.0f, 2.0f,     state::PrimaryInput)

      // --- Charge / pressure shape ---
      .floatField("charge_s",           0.6f,  0.05f, 3.0f,     state::PrimaryInput)
      .floatField("base_radius",        0.12f, 0.01f, 10.0f,    state::PrimaryInput)
      .floatField("charge_expand",      2.3f,  1.0f, 8.0f,      state::PrimaryInput)
      .floatField("size_smoothing",     0.06f, 0.0f, 1.0f,      state::PrimaryInput)
      .floatField("gaussian_sharpness", 4.0f,  1.0f, 20.0f,     state::PrimaryInput)
      .floatField("plateau_amount",     0.6f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("squish_amount",      0.5f,  0.0f, 2.0f,      state::PrimaryInput)
      .floatField("crescent_amount",    0.7f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("crescent_offset",    0.5f,  0.1f, 1.5f,      state::PrimaryInput)

      // --- Burst ---
      .floatField("release_s",          0.7f,  0.05f, 3.0f,     state::PrimaryInput)
      .floatField("release_expand",     3.0f,  1.0f, 20.0f,     state::PrimaryInput)
      // Signed power curve (style guide §8.3) via fx::signedSliderToExp:
      // +1 → fast-start/front-loaded burst, -1 → gradual swell, 0 → linear.
      .floatField("release_curve",      0.4f,  -1.0f, 1.0f,     state::PrimaryInput)
      .floatField("min_sustain_s",      0.2f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("burst_shallow",      0.7f,  0.0f, 0.95f,     state::PrimaryInput)

      // --- Colour grade ---
      .floatField("base_hue",           0.55f, 0.0f, 1.0f,      state::PrimaryInput)
      .floatField("hue_span",           0.18f, 0.0f, 1.0f,      state::PrimaryInput)
      .floatField("saturation",         0.85f, 0.0f, 1.0f,      state::PrimaryInput)
      .floatField("grade_freq_hold",    1.5f,  0.0f, 8.0f,      state::PrimaryInput)
      .floatField("grade_freq_burst",   7.0f,  0.0f, 16.0f,     state::PrimaryInput)
      .floatField("fold_rate",          1.5f,  0.0f, 8.0f,      state::PrimaryInput)
      .floatField("band_contrast",      0.6f,  0.0f, 1.0f,      state::PrimaryInput)
      // Skew the bands along the wavefront axis: + leans them toward the
      // leading (down/forward) edge, - toward the trailing (up) edge.
      .floatField("band_tilt",          0.0f,  -2.0f, 2.0f,     state::PrimaryInput)
      .floatField("alpha_gamma",        1.2f,  0.25f, 4.0f,     state::PrimaryInput)
      .rgbField  ("blob_color",         1.0f,  1.0f, 1.0f,      state::PrimaryInput)
      .floatField("overlay_alpha_hold", 0.3f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("overlay_alpha_burst",0.7f,  0.0f, 1.0f,      state::PrimaryInput)
      // Crankable master gain; the shader applies a soft per-channel rolloff so
      // high values saturate into juicy colour rather than clipping to white.
      .floatField("intensity",          1.0f,  0.0f, 32.0f,     state::PrimaryInput)

      // --- Debug ---
      .boolField ("debug_field",        false,                  state::PrimaryInput)

      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("chroma_wave_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("chroma_wave_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));

  state::log("chroma_wave: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->phase = PHASE_IDLE;
  s->charge_t = 0.0f;
  s->burst_t = 0.0f;
  s->strain_at_release = 0.0f;
  s->smooth_radius = 0.0f;
  s->snap_radius = true;
  s->gate_prev = false;
  s->trigger_prev = false;
  s->trigger_pulse = false;
  s->trigger_hold_remaining = 0.0;
  s->grade_phase = 0.0;
  s->rng_state = 0xC0FFEE11u;
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
  state::log("chroma_wave: initialized");
}

// Raw (un-smoothed) blob radius for the current phase. Mirrors the geometry
// in render(); smoothing is layered on top of this in tick().
static float target_radius(const State* s) {
  // radius = base · charge-growth · burst-blowup. base_radius is the master
  // size; charge_expand grows it over the hold; release_expand blows it out.
  switch (s->phase) {
    case PHASE_CHARGE:
      return s->base_radius * lerpf(1.0f, s->charge_expand, s->charge_t);
    case PHASE_BURST: {
      float bt = clampf(s->burst_t, 0.0f, 1.0f);
      float be = std::pow(bt, fx::signedSliderToExp(s->release_curve));
      float radius_rel = s->base_radius * lerpf(1.0f, s->charge_expand, s->strain_at_release);
      return radius_rel * lerpf(1.0f, s->release_expand, be);
    }
    case PHASE_IDLE:
    default:
      return s->base_radius;   // not drawn (overlay alpha 0)
  }
}

// Fire a one-shot pulse (trigger event / auto_rate). Hold long enough to
// fully build pressure (charge_s) AND then dwell at max pressure for
// min_sustain_s before auto-releasing into the burst — otherwise a short
// min_sustain bursts the blob before it has finished charging.
static void fire_pulse(State* s) {
  s->trigger_pulse = true;
  s->trigger_hold_remaining = (double)(s->charge_s + s->min_sustain_s);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;
  float fdt = (float)dt;

  // Poisson auto-trigger (only while not already holding a pulse).
  if (s->auto_rate > 0.0f && !s->trigger_pulse) {
    float rate_hz = std::pow(60.0f, s->auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      float lambda = rate_hz * fdt;
      s->rng_state = s->rng_state * 1664525u + 1013904223u;
      float u = (s->rng_state >> 8) * (1.0f / float(1u << 24));
      if (u < 1.0f - std::exp(-lambda)) fire_pulse(s);
    }
  }

  if (s->trigger_pulse) {
    s->trigger_hold_remaining -= dt;
    if (s->trigger_hold_remaining <= 0.0) s->trigger_pulse = false;
  }

  bool held = s->gate || s->level >= 0.5f || s->default_gate_state;
  bool effective_gate = held || s->trigger_pulse;

  // Phase transitions. Entering CHARGE (fresh trigger OR mid-burst retrigger)
  // snaps the radius so the blob doesn't smoothly slide from a stale size.
  switch (s->phase) {
    case PHASE_IDLE:
      if (effective_gate) { s->phase = PHASE_CHARGE; s->charge_t = 0.0f; s->snap_radius = true; }
      break;
    case PHASE_CHARGE:
      if (!effective_gate) {
        s->strain_at_release = s->charge_t;
        s->phase = PHASE_BURST;
        s->burst_t = 0.0f;
      } else {
        float rate = (s->charge_s > 1e-4f) ? (fdt / s->charge_s) : 1.0f;
        s->charge_t = clampf(s->charge_t + rate, 0.0f, 1.0f);
      }
      break;
    case PHASE_BURST:
      if (effective_gate) {            // re-trigger mid-burst
        s->phase = PHASE_CHARGE;
        s->charge_t = 0.0f;
        s->snap_radius = true;
      } else {
        float rate = (s->release_s > 1e-4f) ? (fdt / s->release_s) : 1.0f;
        s->burst_t += rate;
        if (s->burst_t >= 1.0f) { s->phase = PHASE_IDLE; s->burst_t = 0.0f; s->charge_t = 0.0f; }
      }
      break;
  }

  // Exponential-smooth the overall blob size (softens the hold→release
  // handoff). Snap on retrigger so a fresh note starts crisp.
  float tr = target_radius(s);
  if (s->snap_radius || s->size_smoothing <= 1e-4f) {
    s->smooth_radius = tr;
    s->snap_radius = false;
  } else {
    float alpha = 1.0f - std::exp(-fdt / s->size_smoothing);
    s->smooth_radius += (tr - s->smooth_radius) * alpha;
  }

  // Scrolling transfer phase — gentle while charging, accelerating during the
  // burst foldback (style-guide §2.1 accumulator).
  float fold_speed = s->fold_rate * 0.15f;
  if (s->phase == PHASE_BURST) {
    float be = std::pow(clampf(s->burst_t, 0.0f, 1.0f), fx::signedSliderToExp(s->release_curve));
    fold_speed = s->fold_rate * (0.15f + be);
  }
  s->grade_phase += (double)(fold_speed * fdt);
  // Keep the accumulator bounded (cos is periodic; wrap on 1.0 of t-units).
  if (s->grade_phase > 1024.0) s->grade_phase -= 1024.0;
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (op == state::PatchReplace) {
      if      (state::pathIs(path, plen, "gate")) {
        bool ng = state::patchFloat(i) != 0.0f;
        s->gate = ng;
        s->gate_prev = ng;
      }
      else if (state::pathIs(path, plen, "level"))              s->level = state::patchFloat(i);
      else if (state::pathIs(path, plen, "auto_rate"))          s->auto_rate = state::patchFloat(i);
      else if (state::pathIs(path, plen, "default_gate_state")) s->default_gate_state = state::patchFloat(i) != 0.0f;
      else if (state::pathIs(path, plen, "position_x"))         s->position_x = state::patchFloat(i);
      else if (state::pathIs(path, plen, "position_y"))         s->position_y = state::patchFloat(i);
      else if (state::pathIs(path, plen, "charge_s"))           s->charge_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "base_radius"))        s->base_radius = state::patchFloat(i);
      else if (state::pathIs(path, plen, "charge_expand"))      s->charge_expand = state::patchFloat(i);
      else if (state::pathIs(path, plen, "size_smoothing"))     s->size_smoothing = state::patchFloat(i);
      else if (state::pathIs(path, plen, "gaussian_sharpness")) s->gaussian_sharp = state::patchFloat(i);
      else if (state::pathIs(path, plen, "plateau_amount"))     s->plateau_amount = state::patchFloat(i);
      else if (state::pathIs(path, plen, "squish_amount"))      s->squish_amount = state::patchFloat(i);
      else if (state::pathIs(path, plen, "crescent_amount"))    s->crescent_amount = state::patchFloat(i);
      else if (state::pathIs(path, plen, "crescent_offset"))    s->crescent_offset = state::patchFloat(i);
      else if (state::pathIs(path, plen, "release_s"))          s->release_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "release_expand"))     s->release_expand = state::patchFloat(i);
      else if (state::pathIs(path, plen, "release_curve"))      s->release_curve = state::patchFloat(i);
      else if (state::pathIs(path, plen, "min_sustain_s"))      s->min_sustain_s = state::patchFloat(i);
      else if (state::pathIs(path, plen, "burst_shallow"))      s->burst_shallow = state::patchFloat(i);
      else if (state::pathIs(path, plen, "base_hue"))           s->base_hue = state::patchFloat(i);
      else if (state::pathIs(path, plen, "hue_span"))           s->hue_span = state::patchFloat(i);
      else if (state::pathIs(path, plen, "saturation"))         s->saturation = state::patchFloat(i);
      else if (state::pathIs(path, plen, "grade_freq_hold"))    s->grade_freq_hold = state::patchFloat(i);
      else if (state::pathIs(path, plen, "grade_freq_burst"))   s->grade_freq_burst = state::patchFloat(i);
      else if (state::pathIs(path, plen, "fold_rate"))          s->fold_rate = state::patchFloat(i);
      else if (state::pathIs(path, plen, "band_contrast"))      s->band_contrast = state::patchFloat(i);
      else if (state::pathIs(path, plen, "band_tilt"))          s->band_tilt = state::patchFloat(i);
      else if (state::pathIs(path, plen, "alpha_gamma"))        s->alpha_gamma = state::patchFloat(i);
      else if (state::pathIs(path, plen, "overlay_alpha_hold")) s->overlay_alpha_hold = state::patchFloat(i);
      else if (state::pathIs(path, plen, "overlay_alpha_burst"))s->overlay_alpha_burst = state::patchFloat(i);
      else if (state::pathIs(path, plen, "intensity"))          s->intensity = state::patchFloat(i);
      else if (state::pathIs(path, plen, "debug_field"))        s->debug_field = state::patchFloat(i) != 0.0f;
      else if (state::pathIs(path, plen, "blob_color")) {
        auto v = state::patchVec3(i);
        s->color_r = v.x; s->color_g = v.y; s->color_b = v.z;
      }
    }

    // Event field — momentary (on/off like gate). The executor REPLAYS every
    // stored field (including this one) as a PatchReplace every frame, so we
    // fire only on a genuine rising edge of the VALUE — a phase/value-less
    // guard would re-fire on every return to IDLE and loop forever even with
    // auto_rate at 0. A fresh edge re-triggers mid-cycle, like gate.
    if (state::pathIs(path, plen, "trigger")) {
      bool tval = state::patchFloat(i) != 0.0f;
      if (tval && !s->trigger_prev) fire_pulse(s);
      s->trigger_prev = tval;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  Uniforms u = {};
  // Signed position → uv: -1 = left/top edge, 0 = center, +1 = right/bottom.
  u.cx = s->position_x * 0.5f + 0.5f;
  u.cy = s->position_y * 0.5f + 0.5f;
  u.base_hue = s->base_hue;
  u.hue_span = s->hue_span;
  u.saturation = s->saturation;
  u.band_contrast = s->band_contrast;
  u.band_tilt = s->band_tilt;
  u.alpha_gamma = s->alpha_gamma;
  u.intensity = s->intensity;
  u.color_r = s->color_r;
  u.color_g = s->color_g;
  u.color_b = s->color_b;
  u.cres_off = s->crescent_offset;
  u.grade_phase = (float)s->grade_phase;
  u.debug_field = s->debug_field ? 1.0f : 0.0f;

  // NOTE: u.radius is set once below from the smoothed value; the per-phase
  // blocks only compute the shape params (elong, sharp, plateau, crescent,
  // grade, overlay).
  if (s->phase == PHASE_IDLE) {
    // Nothing to draw — pure passthrough (overlay alpha 0).
    u.elong = 1.0f;
    u.ycomp = 1.0f;
    u.sharp = s->gaussian_sharp;
    u.plateau_p = 1.0f;
    u.cres = 0.0f;
    u.grade_freq = s->grade_freq_hold;
    u.overlay_alpha = 0.0f;
  } else if (s->phase == PHASE_CHARGE) {
    // Pressure builds: blob grows, top flattens to a plateau, X elongates,
    // and the crescent hollows in the later half (max-pressure point).
    float strain = s->charge_t;
    u.elong  = 1.0f + s->squish_amount * strain;
    u.ycomp  = 1.0f / (1.0f + s->squish_amount * strain * 0.4f);
    u.sharp  = s->gaussian_sharp;
    u.plateau_p = 1.0f + s->plateau_amount * 1.2f * strain;
    u.cres = s->crescent_amount * smoothband(strain, 0.3f, 1.0f);
    u.grade_freq = s->grade_freq_hold;
    u.overlay_alpha = s->overlay_alpha_hold;
  } else {  // PHASE_BURST
    float bt = clampf(s->burst_t, 0.0f, 1.0f);
    // Burst progress, shaped by the signed release_curve (style guide §8.3).
    // The default (+0.4) front-loads the blow-up so it's visible while the
    // overlay is still bright; -ve values give a gradual swell instead.
    float be = std::pow(bt, fx::signedSliderToExp(s->release_curve));
    float strain = s->strain_at_release;

    float elong_rel  = 1.0f + s->squish_amount * strain;
    float p_rel      = 1.0f + s->plateau_amount * 1.2f * strain;
    float cres_rel   = s->crescent_amount * smoothband(strain, 0.3f, 1.0f);

    u.elong  = lerpf(elong_rel, 1.0f, be);
    u.ycomp  = 1.0f;
    // Contrast shallows out as it expands.
    u.sharp  = s->gaussian_sharp * lerpf(1.0f, 1.0f - s->burst_shallow, be);
    u.plateau_p = lerpf(p_rel, 1.0f, be);
    // Crescent opens out fast at the start of the burst.
    u.cres = lerpf(cres_rel, 0.0f, smoothband(bt, 0.0f, 0.4f));
    // Many bands appear; the grade goes prismatic.
    u.grade_freq = lerpf(s->grade_freq_hold, s->grade_freq_burst, smoothband(bt, 0.0f, 0.5f));
    // Band contrast washes out toward zero as the blob expands/shallows — the
    // banded structure dissolves into a smooth wash by the end of the release.
    u.band_contrast = s->band_contrast * (1.0f - be);
    // Overlay rises fast to the burst peak, holds through the expansion, then
    // fades over the back half of the release.
    float rise = smoothband(bt, 0.0f, 0.1f);
    float fade = 1.0f - smoothband(bt, 0.45f, 1.0f);
    u.overlay_alpha = lerpf(s->overlay_alpha_hold, s->overlay_alpha_burst, rise) * fade;
  }

  // The per-phase radius above is the raw target; the size we actually render
  // is the smoothed value tracked in tick() (snaps on retrigger).
  u.radius = s->smooth_radius;

  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace chroma_wave
