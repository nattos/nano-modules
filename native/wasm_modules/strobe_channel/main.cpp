/*
 * source.light.strobe_channel — Logistic-map-driven single-bar selector.
 *
 * See SHOW_EFFECTS_PLAN.md for the design. This is the v1 scaffold:
 * - Triangle-wave ping-pong drives the seed x0.
 * - N iterations of x' = r * x * (1 - x) from x0 each frame.
 * - Final x mapped to a bar index in [0, 4); that bar lights up.
 *
 * Deferred: beat sync, region smoothness, transition fade, per-bar hue
 * offsets, external seed tap.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + runtime state + uniform buffer) via create(). All instance callbacks
 * take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "strobe_channel_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace strobe_channel {

struct Uniforms {
  uint32_t active_bar;
  uint32_t bar_count;
  float    intensity;
  float    _pad_h0;

  float    color_r;
  float    color_g;
  float    color_b;
  float    _pad_h1;
};
static_assert(sizeof(Uniforms) == 32, "Uniforms layout mismatch");

// Per-instance state. One per chain entry.
struct State {
  // Schema-mirrored params
  float r                 = 3.95f;
  int   iterations        = 6;
  float ping_pong_rate_hz = 0.5f;
  float seed_low          = 0.1f;
  float seed_high         = 0.9f;
  float color_r           = 1.0f;
  float color_g           = 1.0f;
  float color_b           = 1.0f;
  float intensity         = 1.0f;
  float intensity_mod     = 0.0f;
  int   bar_count         = 4;

  // Runtime state
  double elapsed = 0.0;

  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("source.light.strobe_channel", {1, 0, 0},
    state::Schema()
      .floatField("r",                 3.95f, 0.0f, 4.0f,  state::PrimaryInput)
      .intField  ("iterations",        6,     1,    16,    state::PrimaryInput)
      .floatField("ping_pong_rate_hz", 0.5f,  0.05f, 20.0f, state::PrimaryInput)
      .floatField("seed_low",          0.1f,  0.0f, 1.0f,  state::PrimaryInput)
      .floatField("seed_high",         0.9f,  0.0f, 1.0f,  state::PrimaryInput)
      .rgbField  ("flash_color",       1.0f,  1.0f, 1.0f,  state::PrimaryInput)
      .floatField("intensity",         1.0f,  0.0f, 2.0f,  state::PrimaryInput)
      .floatField("intensity_mod",     0.0f, -1.0f, 1.0f,  state::PrimaryInput)
      .intField  ("bar_count",         4,     2,    16,    state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::Generator)
        .capability(state::Capability::SeekableApproximate)
    );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("strobe_channel_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("strobe_channel_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));

  state::log("strobe_channel: module initialized");
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
  delete s;
}

// Per-instance init tail: reset runtime state + guard on shared PSO.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->elapsed = 0.0;
  s->initialized = false;
  if (!s_pso.valid()) return;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;
  state::log("strobe_channel: initialized");
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->elapsed += dt;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "r"))                 s->r = state::patchFloat(i);
    else if (state::pathIs(path, plen, "iterations"))        s->iterations = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "ping_pong_rate_hz")) s->ping_pong_rate_hz = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed_low"))          s->seed_low = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed_high"))         s->seed_high = state::patchFloat(i);
    else if (state::pathIs(path, plen, "flash_color")) {
      auto v = state::patchVec3(i);
      s->color_r = v.x; s->color_g = v.y; s->color_b = v.z;
    }
    else if (state::pathIs(path, plen, "intensity"))         s->intensity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "intensity_mod"))     s->intensity_mod = state::patchFloat(i);
    else if (state::pathIs(path, plen, "bar_count"))         s->bar_count = (int)state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Triangle-wave ping-pong of the seed.
  float phase = (float)(s->elapsed * (double)s->ping_pong_rate_hz);
  phase = phase - std::floor(phase);       // [0, 1)
  float tri = std::fabs(phase * 2.0f - 1.0f); // [0, 1] tent
  float x = s->seed_low + (s->seed_high - s->seed_low) * tri;

  // Iterate the logistic map.
  int iters = s->iterations;
  if (iters < 1) iters = 1;
  if (iters > 32) iters = 32;
  for (int i = 0; i < iters; i++) {
    x = s->r * x * (1.0f - x);
  }
  if (!std::isfinite(x)) x = 0.5f;
  if (x < 0.0f) x = 0.0f;
  if (x >= 1.0f) x = 0.9999f;

  int bars = s->bar_count;
  if (bars < 1) bars = 1;
  if (bars > 16) bars = 16;
  int active_bar = (int)std::floor(x * (float)bars);
  if (active_bar < 0) active_bar = 0;
  if (active_bar >= bars) active_bar = bars - 1;

  float intensity = s->intensity + s->intensity_mod;
  if (intensity < 0.0f) intensity = 0.0f;

  Uniforms u = {};
  u.active_bar = (uint32_t)active_bar;
  u.bar_count  = (uint32_t)bars;
  u.intensity  = intensity;
  u.color_r    = s->color_r;
  u.color_g    = s->color_g;
  u.color_b    = s->color_b;
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

} // namespace strobe_channel
