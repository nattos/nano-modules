/*
 * gen.bounce_resonator — 4-bar scalar diffusion network.
 *
 * Each bar holds a scalar value. An internal 240 Hz loop repeatedly
 * multiplies the 4-vector by a mixing matrix (v ← M·v), exchanging value
 * between bars. The whole character lives in the matrix, built from two
 * controls:
 *   feedback — per-second energy gain (1.0 = reverberate forever, max 1.2).
 *   spread   — Gaussian sigma of the inter-bar weight distribution.
 * See effect_diffusion_network.h for the matrix construction + the
 * per-second (not per-step) feedback normalization.
 *
 * Trigger semantics (style guide §8.1): gate (bool) and trigger (event)
 * both fire on a 0→1 rising edge; auto_rate (Poisson) self-fires. Any
 * impulse injects `impulse_strength` of value into `bar_target` (or all 4).
 *
 * Outputs:
 *   tex_out                  — additive bands over tex_in (brightness = value)
 *   render_outputs/motion    — rgba16f motion vectors (passthrough for now)
 *   bar_v_0..3               — float rails for downstream taps
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <effect_utils.h>
#include <effect_diffusion_network.h>
#include "bounce_resonator_shaders.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace bounce_resonator {

static constexpr int BARS = 4;

struct Uniforms {
  float v0, v1, v2, v3;                 // per-bar values
  float hue0, hue1, hue2, hue3;         // per-bar hues (turns)
  float band_sat, band_val, intensity, _pad;
};
static_assert(sizeof(Uniforms) == 48, "Uniforms layout mismatch");

// Per-instance state. One per chain entry.
struct State {
  // --- Per-instance GPU resources ---
  gpu::Buffer  uniform_buf;
  gpu::Texture motion_tex;
  gpu::Texture zero_motion_tex;        // 1×1 fallback when no upstream
  int          motion_w = 0;
  int          motion_h = 0;
  bool         initialized = false;

  // --- Schema-mirrored params ---
  bool  gate              = false;
  int   bar_target        = 0;
  bool  bar_target_all    = false;
  bool  bar_target_random = false;
  float feedback          = 0.90f;
  float spread            = 0.30f;
  float spread_contrast   = 0.0f;
  float decay_shaping     = 0.0f;
  float hue_spread        = 0.0f;
  float hue_converge      = 0.0f;
  int   seed              = 0;
  int   pattern_count     = 4;
  float cycle_rate        = 6.0f;
  float impulse_strength  = 1.0f;
  float color_r           = 1.0f;
  float color_g           = 0.92f;
  float color_b           = 0.78f;
  // band_color decomposed: hue feeds impulses, sat/val feed the shader.
  float band_hue          = 0.0f;
  float band_sat          = 0.0f;
  float band_val          = 1.0f;
  float intensity         = 1.0f;
  float auto_rate         = 0.3f;

  // --- Runtime state ---
  fx::DiffusionNetwork4 net;
  // gate/trigger are momentary in the IDE — value replayed every frame;
  // fire only on the 0→1 rising edge (style guide §8.2).
  bool     gate_prev      = false;
  float    trigger_prev   = 0.0f;
  uint32_t autotrigger_rng = 0xCAFEBABEu;
  uint32_t target_rng      = 0x1357BD13u;   // random bar_target picks
  // Impulses are QUEUED here and injected after the diffusion step (but
  // before render), so a fresh trigger flash is shown solid/undiffused.
  float    pending[BARS]  = {0.0f, 0.0f, 0.0f, 0.0f};
};

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// RGB → (hue turns, saturation, value). Matches nano_color.hlsl's HSV.
static void rgb_to_hsv(float r, float g, float b, float& h, float& s, float& v) {
  float mx = std::max(r, std::max(g, b));
  float mn = std::min(r, std::min(g, b));
  float d = mx - mn;
  v = mx;
  s = (mx > 1e-6f) ? d / mx : 0.0f;
  h = 0.0f;
  if (d > 1e-6f) {
    if      (mx == r) h = (g - b) / d + (g < b ? 6.0f : 0.0f);
    else if (mx == g) h = (b - r) / d + 2.0f;
    else              h = (r - g) / d + 4.0f;
    h /= 6.0f;
  }
}

static void update_band_hsv(State& s) {
  rgb_to_hsv(s.color_r, s.color_g, s.color_b, s.band_hue, s.band_sat, s.band_val);
}

// Queue an impulse (target resolved now, including the random pick) to be
// injected after this frame's diffusion step.
static void fire_impulse(State& s) {
  float amt = clampf(s.impulse_strength, 0.0f, 8.0f);
  if (s.bar_target_all) {
    for (int b = 0; b < BARS; b++) s.pending[b] += amt;
  } else if (s.bar_target_random) {
    s.target_rng = s.target_rng * 1664525u + 1013904223u;
    int b = (int)((s.target_rng >> 8) % (uint32_t)BARS);
    s.pending[b] += amt;
  } else {
    int b = s.bar_target;
    if (b < 0) b = 0;
    if (b > BARS - 1) b = BARS - 1;
    s.pending[b] += amt;
  }
}

// Inject queued impulses into the network. Called after step(), before
// render, so the flash is rendered solid (undiffused). The injected hue is
// always band_color's hue (for now).
static void flush_impulses(State& s) {
  for (int b = 0; b < BARS; b++) {
    if (s.pending[b] != 0.0f) { s.net.impulse(b, s.pending[b], s.band_hue); s.pending[b] = 0.0f; }
  }
}

// Type-level setup: schema + the two shared compute PSOs.
void module_init() {
  state::init("gen.bounce_resonator", {1, 0, 0},
    state::Schema()
      // --- Standard trigger surface ---
      .boolField ("gate",                false,                  state::PrimaryInput)
      .eventField("trigger",                                     state::PrimaryInput)
      .floatField("auto_rate",           0.3f,  0.0f, 1.0f,      state::PrimaryInput)
      .intField  ("bar_target",          0, 0, 3,                state::PrimaryInput)
      .boolField ("bar_target_all",      false,                  state::PrimaryInput)
      .boolField ("bar_target_random",   false,                  state::PrimaryInput)
      // --- Diffusion network ---
      .floatField("feedback",            0.90f, 0.0f, 1.2f,      state::PrimaryInput)
      .floatField("spread",              0.30f, 0.0f, 1.0f,      state::PrimaryInput)
      .floatField("spread_contrast",     0.0f, 0.0f, 1.0f,       state::PrimaryInput)
      .floatField("decay_shaping",       0.0f, -1.0f, 1.0f,      state::PrimaryInput)
      .floatField("hue_spread",          0.0f, 0.0f, 1.0f,       state::PrimaryInput)
      .floatField("hue_converge",        0.0f, 0.0f, 1.0f,       state::PrimaryInput)
      .intField  ("seed",                0, 0, 0x7FFFFFFF,       state::PrimaryInput)
      .intField  ("pattern_count",       4, 1, 16,               state::PrimaryInput)
      .floatField("cycle_rate",          6.0f, 0.0f, 60.0f,      state::PrimaryInput)
      .floatField("impulse_strength",    1.0f,  0.0f, 2.0f,      state::PrimaryInput)
      .rgbField  ("band_color",          1.0f, 0.92f, 0.78f,     state::PrimaryInput)
      .floatField("intensity",           1.0f, 0.0f, 2.0f,       state::PrimaryInput)
      // --- Per-bar output rails ---
      .floatField("bar_v_0",  0.0f, 0.0f, 8.0f, state::PrimaryOutput)
      .floatField("bar_v_1",  0.0f, 0.0f, 8.0f, state::PrimaryOutput)
      .floatField("bar_v_2",  0.0f, 0.0f, 8.0f, state::PrimaryOutput)
      .floatField("bar_v_3",  0.0f, 0.0f, 8.0f, state::PrimaryOutput)
      // --- I/O ---
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      .renderOutputs(state::PrimaryInput,  "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("bounce_resonator_color", COLOR_SPV, COLOR_SPV_SIZE);
  state::registerShaderSPV("bounce_resonator_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("bounce_resonator_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("bounce_resonator_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)
      .uniform(2));

  state::log("bounce_resonator: module initialized");
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->motion_tex.release();
  s->zero_motion_tex.release();
  delete s;
}

// Per-instance init tail: reset params/network/edge-state, mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  s->gate = false;
  s->gate_prev = false;
  s->trigger_prev = 0.0f;
  s->autotrigger_rng = 0xCAFEBABEu;
  s->target_rng = 0x1357BD13u;
  for (int b = 0; b < BARS; b++) s->pending[b] = 0.0f;
  update_band_hsv(*s);
  s->motion_w = 0;
  s->motion_h = 0;
  s->net.reset();

  if (!s_pso_color.valid() || !s_pso_motion.valid()) return;
  if (!s->uniform_buf.valid()) return;

  s->initialized = true;
  state::log("bounce_resonator: initialized");
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized) return;

  // Poisson auto-trigger.
  if (s->auto_rate > 0.0f) {
    float rate_hz = std::pow(60.0f, s->auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      float lambda = rate_hz * (float)dt;
      s->autotrigger_rng = s->autotrigger_rng * 1664525u + 1013904223u;
      float u = (s->autotrigger_rng >> 8) * (1.0f / (float)(1u << 24));
      if (u < 1.0f - std::exp(-lambda)) {
        fire_impulse(*s);
      }
    }
  }

  // Push current params + advance the diffusion network.
  fx::DiffusionNetwork4::Params p;
  p.feedback        = clampf(s->feedback, 0.0f, 1.2f);
  p.spread          = clampf(s->spread,   0.0f, 1.0f);
  p.spread_contrast = clampf(s->spread_contrast, 0.0f, 1.0f);
  p.decay_shaping   = clampf(s->decay_shaping, -1.0f, 1.0f);
  p.hue_spread      = clampf(s->hue_spread, 0.0f, 1.0f);
  p.hue_converge    = clampf(s->hue_converge, 0.0f, 1.0f);
  p.home_hue        = s->band_hue;
  p.seed            = (uint32_t)s->seed;
  p.pattern_count   = s->pattern_count;
  p.rate            = clampf(s->cycle_rate, 0.0f, 60.0f);
  s->net.setParams(p);
  s->net.step((float)dt);

  // Inject queued impulses AFTER stepping (but before render) so a fresh
  // trigger renders as a solid, undiffused flash.
  flush_impulses(*s);
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off, const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    int op = ops[i];

    if (op == state::PatchReplace) {
      if (state::pathIs(path, plen, "gate")) {
        bool new_gate = state::patchFloat(i) != 0.0f;
        if (new_gate && !s->gate_prev) fire_impulse(*s);
        s->gate = new_gate;
        s->gate_prev = new_gate;
      }
      else if (state::pathIs(path, plen, "trigger")) {
        float v = state::patchFloat(i);
        if (v != 0.0f && s->trigger_prev == 0.0f) fire_impulse(*s);
        s->trigger_prev = v;
      }
      else if (state::pathIs(path, plen, "auto_rate"))           s->auto_rate          = state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_target"))          s->bar_target         = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_target_all"))      s->bar_target_all     = state::patchFloat(i) != 0.0f;
      else if (state::pathIs(path, plen, "bar_target_random"))   s->bar_target_random  = state::patchFloat(i) != 0.0f;
      else if (state::pathIs(path, plen, "feedback"))            s->feedback           = state::patchFloat(i);
      else if (state::pathIs(path, plen, "spread"))              s->spread             = state::patchFloat(i);
      else if (state::pathIs(path, plen, "spread_contrast"))     s->spread_contrast    = state::patchFloat(i);
      else if (state::pathIs(path, plen, "decay_shaping"))       s->decay_shaping      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "hue_spread"))          s->hue_spread         = state::patchFloat(i);
      else if (state::pathIs(path, plen, "hue_converge"))        s->hue_converge       = state::patchFloat(i);
      else if (state::pathIs(path, plen, "seed"))                s->seed               = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "pattern_count"))       s->pattern_count      = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "cycle_rate"))          s->cycle_rate         = state::patchFloat(i);
      else if (state::pathIs(path, plen, "impulse_strength"))    s->impulse_strength   = state::patchFloat(i);
      else if (state::pathIs(path, plen, "band_color")) {
        auto v = state::patchVec3(i);
        s->color_r = v.x; s->color_g = v.y; s->color_b = v.z;
        update_band_hsv(*s);
      }
      else if (state::pathIs(path, plen, "intensity"))           s->intensity          = state::patchFloat(i);
    }
  }
}

static void publish_output(const char* name, float value) {
  auto vh = val::number(value);
  state::setValPath(name, vh);
  val::release(vh);
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Pack uniforms.
  Uniforms u = {};
  u.v0 = s->net.value(0); u.v1 = s->net.value(1);
  u.v2 = s->net.value(2); u.v3 = s->net.value(3);
  u.hue0 = s->net.hue(0); u.hue1 = s->net.hue(1);
  u.hue2 = s->net.hue(2); u.hue3 = s->net.hue(3);
  u.band_sat = s->band_sat; u.band_val = s->band_val;
  u.intensity = s->intensity;
  s->uniform_buf.writeOne(u);

  // Pass 1 — color.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Pass 2 — motion. Skip when no downstream consumer (mirror soft_glow).
  if (state::isOutputConnected("render_outputs")) {
    if (!s->motion_tex.valid() || s->motion_w != vp_w || s->motion_h != vp_h) {
      s->motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s->motion_w = vp_w;
      s->motion_h = vp_h;
      if (s->motion_tex.valid()) {
        state::setGpuTexture("render_outputs/motion", s->motion_tex.id);
      }
    }
    if (s->motion_tex.valid()) {
      auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
      if (!upstream.valid()) {
        if (!s->zero_motion_tex.valid()) {
          s->zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
        }
        upstream = s->zero_motion_tex;
      }
      if (upstream.valid()) {
        auto cp = gpu::ComputePass::begin();
        cp.setPSO(s_pso_motion);
        cp.setTexture(upstream,      0, 0);
        cp.setTexture(s->motion_tex, 1, 1);
        cp.setBuffer(s->uniform_buf, 2);
        cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
        cp.end();
      }
    }
  }

  gpu::Device::submit();

  // Publish per-bar output rails.
  publish_output("bar_v_0", s->net.value(0));
  publish_output("bar_v_1", s->net.value(1));
  publish_output("bar_v_2", s->net.value(2));
  publish_output("bar_v_3", s->net.value(3));
}

} // namespace bounce_resonator
