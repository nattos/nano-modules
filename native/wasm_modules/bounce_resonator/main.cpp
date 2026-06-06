/*
 * gen.bounce_resonator — 4 coupled per-bar mass-on-spring with
 * cross-bar diffusion + non-linear send filters.
 *
 * Trigger semantics (style guide §8.1): gate (bool) and trigger (event)
 * both fire on a 0→1 rising edge of their momentary value — the value is
 * replayed every frame, so edge detection (not patch presence) is what
 * keeps a single press from re-kicking every frame. auto_rate (Poisson)
 * self-fires. Any of the three impulses the resonator at either
 * `bar_target` or all 4 bars simultaneously.
 *
 * Class-like instance model: module_init() compiles the two shared
 * compute PSOs + publishes the schema once per type; each chain entry
 * gets its own State (params, resonator, edge-state/RNG, per-instance
 * buffer/textures) via create(). All instance callbacks take `self`.
 *
 * Outputs:
 *   tex_out                                 — additive bands over tex_in
 *   render_outputs/motion                   — rgba16f motion vectors (0, vy * scale)
 *   bar_y_0..3, bar_vy_0..3                 — float rails for downstream taps
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <effect_utils.h>
#include <effect_coupled_resonator.h>
#include "bounce_resonator_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace bounce_resonator {

static constexpr int BARS = 4;

struct Uniforms {
  float y0, y1, y2, y3;
  float vy0, vy1, vy2, vy3;
  float band_r, band_g, band_b, intensity;
  float band_width, band_softness, position_range, motion_scale;
};
static_assert(sizeof(Uniforms) == 64, "Uniforms layout mismatch");

// Per-instance state. One per chain entry.
struct State {
  // --- Per-instance GPU resources ---
  gpu::Buffer  uniform_buf;
  gpu::Texture motion_tex;
  gpu::Texture zero_motion_tex;        // 1×1 fallback when no upstream
  int          motion_w = 0;
  int          motion_h = 0;
  bool         initialized = false;

  // --- Schema-mirrored params (standard) ---
  bool  gate              = false;
  int   bar_target        = 0;
  bool  bar_target_all    = false;
  float Q                 = 0.3f;
  float coupling          = 0.3f;
  int   coupling_seed     = 0;
  float cross_pregain     = 0.5f;
  int   cross_filter_type = fx::CoupledResonator4::BPF;
  float cross_filter_freq = 0.5f;
  float cross_filter_q    = 0.5f;
  float impulse_strength  = 0.7f;
  int   impulse_mode      = fx::CoupledResonator4::Velocity;
  float color_r           = 1.0f;
  float color_g           = 0.92f;
  float color_b           = 0.78f;
  float intensity         = 1.0f;
  float auto_rate         = 0.2f;

  // --- Tuning ---
  float base_freq_hz      = 4.0f;
  float bar_freq_spread   = 0.2f;
  float per_bar_freq_offsets[BARS] = { 0.0f, 0.0f, 0.0f, 0.0f };
  float band_width        = 0.1f;
  float band_softness     = 0.3f;
  float position_range    = 0.7f;
  float velocity_cap      = 0.5f;
  float motion_scale      = 1.0f;
  int   sub_steps         = 8;

  // --- Runtime state ---
  fx::CoupledResonator4 res;
  // gate (bool) and trigger (event) are both momentary in the IDE — value
  // is 1 while held, 0 on release, replayed every frame (style guide §8.2).
  // Both fire only on a 0→1 rising edge; firing on patch presence would
  // re-kick the resonator every frame (stuck-trigger bug).
  bool     gate_prev      = false;
  float    trigger_prev   = 0.0f;
  uint32_t autotrigger_rng = 0xCAFEBABEu;
};

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static void fire_impulse(State& s) {
  fx::CoupledResonator4::ImpulseMode m = (s.impulse_mode == fx::CoupledResonator4::Position)
    ? fx::CoupledResonator4::Position
    : fx::CoupledResonator4::Velocity;
  if (s.bar_target_all) {
    s.res.impulseAll(clampf(s.impulse_strength, 0.0f, 4.0f), m);
  } else {
    int b = s.bar_target;
    if (b < 0) b = 0;
    if (b > BARS - 1) b = BARS - 1;
    s.res.impulse(b, clampf(s.impulse_strength, 0.0f, 4.0f), m);
  }
}

// Type-level setup: schema + the two shared compute PSOs.
void module_init() {
  state::init("gen.bounce_resonator", {1, 0, 0},
    state::Schema()
      // --- Standard trigger surface ---
      .boolField ("gate",                false,                  state::PrimaryInput)
      .eventField("trigger",                                     state::PrimaryInput)
      .floatField("auto_rate",           0.2f,  0.0f, 1.0f,      state::PrimaryInput)
      .intField  ("bar_target",          0, 0, 3,                state::PrimaryInput)
      .boolField ("bar_target_all",      false,                  state::PrimaryInput)
      // --- Resonator physics ---
      .floatField("Q",                   0.3f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("coupling",            0.3f,  0.0f, 1.0f,      state::PrimaryInput)
      .intField  ("coupling_seed",       0, 0, 0x7FFFFFFF,       state::PrimaryInput)
      .floatField("cross_pregain",       0.5f,  0.0f, 1.0f,      state::PrimaryInput)
      .selectField("cross_filter_type",  fx::CoupledResonator4::BPF, state::PrimaryInput,
                   {{"LPF", 0}, {"BPF", 1}, {"HPF", 2}})
      .floatField("cross_filter_freq",   0.5f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("cross_filter_q",      0.5f,  0.0f, 1.0f,      state::PrimaryInput)
      .floatField("impulse_strength",    0.7f,  0.0f, 2.0f,      state::PrimaryInput)
      .selectField("impulse_mode",       fx::CoupledResonator4::Velocity, state::PrimaryInput,
                   {{"Velocity", 0}, {"Position", 1}})
      .rgbField  ("band_color",          1.0f, 0.92f, 0.78f,     state::PrimaryInput)
      .floatField("intensity",           1.0f, 0.0f, 2.0f,       state::PrimaryInput)
      // --- Tuning ---
      .floatField("base_freq_hz",        4.0f, 0.5f, 20.0f,      state::PrimaryInput)
      .floatField("bar_freq_spread",     0.2f, 0.0f, 1.0f,       state::PrimaryInput)
      .floatField("per_bar_freq_offset_0", 0.0f, -1.0f, 1.0f,    state::PrimaryInput)
      .floatField("per_bar_freq_offset_1", 0.0f, -1.0f, 1.0f,    state::PrimaryInput)
      .floatField("per_bar_freq_offset_2", 0.0f, -1.0f, 1.0f,    state::PrimaryInput)
      .floatField("per_bar_freq_offset_3", 0.0f, -1.0f, 1.0f,    state::PrimaryInput)
      .floatField("band_width",          0.1f, 0.001f, 0.5f,     state::PrimaryInput)
      .floatField("band_softness",       0.3f, 0.01f, 1.0f,      state::PrimaryInput)
      .floatField("position_range",      0.7f, 0.0f, 1.0f,       state::PrimaryInput)
      .floatField("velocity_cap",        0.5f, 0.01f, 2.0f,      state::PrimaryInput)
      .floatField("motion_scale",        1.0f, 0.0f, 2.0f,       state::PrimaryInput)
      .intField  ("sub_steps",           8, 1, 32,                state::PrimaryInput)
      // --- Per-bar output rails ---
      .floatField("bar_y_0",  0.0f, -1.0f, 1.0f, state::PrimaryOutput)
      .floatField("bar_y_1",  0.0f, -1.0f, 1.0f, state::PrimaryOutput)
      .floatField("bar_y_2",  0.0f, -1.0f, 1.0f, state::PrimaryOutput)
      .floatField("bar_y_3",  0.0f, -1.0f, 1.0f, state::PrimaryOutput)
      .floatField("bar_vy_0", 0.0f, -4.0f, 4.0f, state::PrimaryOutput)
      .floatField("bar_vy_1", 0.0f, -4.0f, 4.0f, state::PrimaryOutput)
      .floatField("bar_vy_2", 0.0f, -4.0f, 4.0f, state::PrimaryOutput)
      .floatField("bar_vy_3", 0.0f, -4.0f, 4.0f, state::PrimaryOutput)
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

// Per-instance init tail: reset params/resonator/edge-state, mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  s->gate = false;
  s->gate_prev = false;
  s->trigger_prev = 0.0f;
  s->autotrigger_rng = 0xCAFEBABEu;
  s->motion_w = 0;
  s->motion_h = 0;
  s->res.reset();

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

  // Push current params + step the resonator.
  fx::CoupledResonator4::Params p;
  p.Q                  = clampf(s->Q,                0.0f, 1.0f);
  p.coupling           = clampf(s->coupling,         0.0f, 1.0f);
  p.coupling_seed      = (uint32_t)s->coupling_seed;
  p.cross_pregain      = clampf(s->cross_pregain,    0.0f, 1.0f);
  p.cross_filter_type  = s->cross_filter_type;
  p.cross_filter_freq  = clampf(s->cross_filter_freq, 0.0f, 1.0f);
  p.cross_filter_q     = clampf(s->cross_filter_q,    0.0f, 1.0f);
  p.base_freq_hz       = s->base_freq_hz;
  p.bar_freq_spread    = s->bar_freq_spread;
  for (int i = 0; i < BARS; i++) p.per_bar_freq_offsets[i] = s->per_bar_freq_offsets[i];
  p.velocity_cap       = s->velocity_cap;
  p.sub_steps          = s->sub_steps;
  s->res.setParams(p);
  s->res.step((float)dt);
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
        // Momentary event value (1 held / 0 released), replayed every
        // frame — kick only on the 0→1 rising edge, exactly like gate.
        float v = state::patchFloat(i);
        if (v != 0.0f && s->trigger_prev == 0.0f) fire_impulse(*s);
        s->trigger_prev = v;
      }
      else if (state::pathIs(path, plen, "auto_rate"))           s->auto_rate          = state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_target"))          s->bar_target         = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_target_all"))      s->bar_target_all     = state::patchFloat(i) != 0.0f;
      else if (state::pathIs(path, plen, "Q"))                   s->Q                  = state::patchFloat(i);
      else if (state::pathIs(path, plen, "coupling"))            s->coupling           = state::patchFloat(i);
      else if (state::pathIs(path, plen, "coupling_seed"))       s->coupling_seed      = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "cross_pregain"))       s->cross_pregain      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "cross_filter_type"))   s->cross_filter_type  = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "cross_filter_freq"))   s->cross_filter_freq  = state::patchFloat(i);
      else if (state::pathIs(path, plen, "cross_filter_q"))      s->cross_filter_q     = state::patchFloat(i);
      else if (state::pathIs(path, plen, "impulse_strength"))    s->impulse_strength   = state::patchFloat(i);
      else if (state::pathIs(path, plen, "impulse_mode"))        s->impulse_mode       = (int)state::patchFloat(i);
      else if (state::pathIs(path, plen, "band_color")) {
        auto v = state::patchVec3(i);
        s->color_r = v.x; s->color_g = v.y; s->color_b = v.z;
      }
      else if (state::pathIs(path, plen, "intensity"))           s->intensity          = state::patchFloat(i);
      else if (state::pathIs(path, plen, "base_freq_hz"))        s->base_freq_hz       = state::patchFloat(i);
      else if (state::pathIs(path, plen, "bar_freq_spread"))     s->bar_freq_spread    = state::patchFloat(i);
      else if (state::pathIs(path, plen, "per_bar_freq_offset_0")) s->per_bar_freq_offsets[0] = state::patchFloat(i);
      else if (state::pathIs(path, plen, "per_bar_freq_offset_1")) s->per_bar_freq_offsets[1] = state::patchFloat(i);
      else if (state::pathIs(path, plen, "per_bar_freq_offset_2")) s->per_bar_freq_offsets[2] = state::patchFloat(i);
      else if (state::pathIs(path, plen, "per_bar_freq_offset_3")) s->per_bar_freq_offsets[3] = state::patchFloat(i);
      else if (state::pathIs(path, plen, "band_width"))          s->band_width         = state::patchFloat(i);
      else if (state::pathIs(path, plen, "band_softness"))       s->band_softness      = state::patchFloat(i);
      else if (state::pathIs(path, plen, "position_range"))      s->position_range     = state::patchFloat(i);
      else if (state::pathIs(path, plen, "velocity_cap"))        s->velocity_cap       = state::patchFloat(i);
      else if (state::pathIs(path, plen, "motion_scale"))        s->motion_scale       = state::patchFloat(i);
      else if (state::pathIs(path, plen, "sub_steps"))           s->sub_steps          = (int)state::patchFloat(i);
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
  u.y0  = s->res.y(0);  u.y1  = s->res.y(1);  u.y2  = s->res.y(2);  u.y3  = s->res.y(3);
  u.vy0 = s->res.vy(0); u.vy1 = s->res.vy(1); u.vy2 = s->res.vy(2); u.vy3 = s->res.vy(3);
  u.band_r = s->color_r; u.band_g = s->color_g; u.band_b = s->color_b;
  u.intensity = s->intensity;
  u.band_width    = clampf(s->band_width,    0.0001f, 1.0f);
  u.band_softness = clampf(s->band_softness, 0.001f,  1.0f);
  u.position_range= clampf(s->position_range, 0.0f,   1.0f);
  u.motion_scale  = clampf(s->motion_scale,   0.0f,   8.0f);
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
  publish_output("bar_y_0",  s->res.y(0));
  publish_output("bar_y_1",  s->res.y(1));
  publish_output("bar_y_2",  s->res.y(2));
  publish_output("bar_y_3",  s->res.y(3));
  publish_output("bar_vy_0", s->res.vy(0));
  publish_output("bar_vy_1", s->res.vy(1));
  publish_output("bar_vy_2", s->res.vy(2));
  publish_output("bar_vy_3", s->res.vy(3));
}

} // namespace bounce_resonator
