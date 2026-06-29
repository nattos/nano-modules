/*
 * warp.legacy.wobble_master — "Wobble Master" (v2 of the Resolume Wire family).
 *
 * Beat-pulsed radial-ripple wobble with chromatic dispersion: a concentric
 * sine ripple travels outward from a centre, displacing the image radially and
 * splitting the colour channels along the radius (prismatic fringing). The
 * ripple amplitude is gated by a pulse envelope so it pumps on a beat/trigger
 * and decays.
 *
 * Source: Wire/Patches/Wobble Master 2 (204 nodes) — beat-synced Ripple/Sin/Cos
 * UV field + the custom YIQ "ChromaOffset" ISF + a Pulse Retrigger/Gate/Pulse
 * Attack system. The team's guidance: the family "needs re-architecting — port
 * as a v2", and "the YIQ ChromaOffset shader is the keeper".
 *
 * v2 RE-ARCHITECTURE (flagged per DNODE_MIGRATION_NOTES §3): the 204-node beat
 * plumbing collapses to one analytic radial ripple (wobble.hlsl) whose phase
 * drifts outward at `wave_speed` (style guide §2.1) and whose amplitude is the
 * standard gate/trigger AR envelope (shared with chroma_wobble/burn_out) plus a
 * manual `amount` floor. The chroma split reuses the shared ChromaOffset helper
 * (nano_chroma.hlsl), here as a RADIAL dispersion (R out / B in). The original
 * beat-clock is driven externally via a wire/tap into the trigger.
 *
 * Stateful trigger envelope → no temporal capability, no is_identity (a
 * triggerable stateful effect must keep ticking — see chroma_wobble).
 */

#include <gpu.h>
#include <host.h>
#include "wobble_master_shaders.h"

#include <cmath>
#include <cstdint>

namespace wobble_master {

static constexpr float AMP_SCALE   = 0.06f; // amplitude=1,env=1 → ~6% short-axis displacement
static constexpr float FREQ_SCALE  = 12.0f; // frequency=1 → 12 rings
static constexpr float WAVE_SCALE  = 0.5f;  // wave_speed=1 → 0.5 ring/sec outward

struct Uniforms {
  float drift;
  float freq;
  float amp;
  float chroma;
  float hue_shift;
  float center_x;
  float center_y;
  float aspect_x;
  float aspect_y;
  float _p0, _p1, _p2;
};
static_assert(sizeof(Uniforms) == 48, "Uniforms layout mismatch");

struct State {
  gpu::Buffer  uniform_buf;
  gpu::Sampler sampler;
  bool initialized = false;

  // Schema-mirrored params.
  float amount    = 0.0f;
  float attack    = 0.05f;
  float release   = 0.8f;
  float amplitude = 0.5f;
  float frequency = 0.5f;
  float wave_speed = 0.5f;
  float chroma    = 0.5f;
  float hue       = 0.0f;
  float center_x  = 0.0f; // cover-square (0 = centre)
  float center_y  = 0.0f;

  // Edge tracking + AR envelope + drift.
  bool   gate_prev = false, trigger_prev = false;
  bool   gate = false, one_shot = false;
  double env = 0.0;
  double drift = 0.0;
};

static gpu::ComputePSO s_pso;

static inline float easeWave(float x) {
  x = x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x);
  return x * x * (3.0f - 2.0f * x);
}

void module_init() {
  state::init("warp.legacy.wobble_master", {1, 0, 0},
    state::Schema()
      .eventField("trigger", state::PrimaryInput)
      .boolField ("gate", false, state::PrimaryInput,
                  "Hold to sustain the ripple; release to decay.")
      .floatField("amount", 0.0f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Manual ripple level (combines with the pulse envelope).")
      .floatField("amplitude", 0.5f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Radial ripple displacement strength.")
      .floatField("frequency", 0.5f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Number of concentric rings.")
      .floatField("wave_speed", 0.5f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Outward travel speed of the ripple.")
      .floatField("chroma", 0.5f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Radial chromatic dispersion (R out / B in).")
      .floatField("hue", 0.0f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Hue rotation of the colour split.")
      .vec2Field ("center", 0.0f, 0.0f, state::PrimaryInput)
      .floatField("attack", 0.05f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  "s", "Pulse envelope ramp-up time.")
      .floatField("release", 0.8f, 0.0f, 5.0f, state::PrimaryInput, nullptr, 0.01f,
                  "s", "Pulse envelope decay time.")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("wobble_master_wobble", WOBBLE_SPV, WOBBLE_SPV_SIZE,
                           "rgba8unorm", "write");
  auto cs = gpu::Device::createShaderModuleByName("wobble_master_wobble");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0).sampler(1).storageTex2d(2, gpu::TextureFormat::RGBA8).uniform(3));

  state::log("wobble_master: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->sampler.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->env = 0.0; s->drift = 0.0; s->one_shot = false;
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (dt < 0.0) dt = 0.0;

  const bool rising = s->gate || s->one_shot;
  if (rising) {
    if (s->attack <= 1e-4f) s->env = 1.0;
    else s->env += dt / (double)s->attack;
    if (s->env >= 1.0) { s->env = 1.0; s->one_shot = false; }
  } else {
    if (s->release <= 1e-4f) s->env = 0.0;
    else s->env -= dt / (double)s->release;
    if (s->env < 0.0) s->env = 0.0;
  }

  s->drift += dt * (double)s->wave_speed * (double)WAVE_SCALE;
  if (s->drift > 1.0e6 || s->drift < -1.0e6) s->drift = std::fmod(s->drift, 1024.0);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "amount"))     s->amount     = state::patchFloat(i);
    else if (state::pathIs(p, l, "amplitude"))  s->amplitude  = state::patchFloat(i);
    else if (state::pathIs(p, l, "frequency"))  s->frequency  = state::patchFloat(i);
    else if (state::pathIs(p, l, "wave_speed")) s->wave_speed = state::patchFloat(i);
    else if (state::pathIs(p, l, "chroma"))     s->chroma     = state::patchFloat(i);
    else if (state::pathIs(p, l, "hue"))        s->hue        = state::patchFloat(i);
    else if (state::pathIs(p, l, "attack"))     s->attack     = state::patchFloat(i);
    else if (state::pathIs(p, l, "release"))    s->release    = state::patchFloat(i);
    else if (state::pathIs(p, l, "center"))     { auto v = state::patchVec2(i); s->center_x = v.x; s->center_y = v.y; }
    else if (state::pathIs(p, l, "gate")) {
      bool g = state::patchBool(i);
      if (g && !s->gate_prev) s->one_shot = false;
      s->gate = g; s->gate_prev = g;
    }
    else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchFloat(i) != 0.0f;
      if (t && !s->trigger_prev) s->one_shot = true;
      s->trigger_prev = t;
    }
  }
}

void on_resolume_param(void* self, long long, double) { (void)self; }

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  float m = easeWave((float)s->env);
  float a = s->amount < 0.0f ? 0.0f : (s->amount > 1.0f ? 1.0f : s->amount);
  float B = 1.0f - (1.0f - a) * (1.0f - m);

  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  Uniforms u = {};
  u.drift     = (float)s->drift;
  u.freq      = s->frequency * FREQ_SCALE + 0.5f;
  u.amp       = B * s->amplitude * AMP_SCALE;
  u.chroma    = s->chroma;
  u.hue_shift = s->hue * 6.28318530717958647692f;
  // center is cover-square (0 = centre); map to uv (0.5 + 0.5*c on the short axis).
  u.center_x  = 0.5f + 0.5f * s->center_x * ((float)min_dim / (float)vp_w);
  u.center_y  = 0.5f + 0.5f * s->center_y * ((float)min_dim / (float)vp_h);
  u.aspect_x  = (float)min_dim / (float)vp_w;
  u.aspect_y  = (float)min_dim / (float)vp_h;
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setSampler(s->sampler, 1);
  cp.setTexture(out, 2, 1);
  cp.setBuffer(s->uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace wobble_master
