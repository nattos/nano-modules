/*
 * gen.strobe_channel — Logistic-map-driven single-bar selector.
 *
 * See SHOW_EFFECTS_PLAN.md for the design. This is the v1 scaffold:
 * - Triangle-wave ping-pong drives the seed x0.
 * - N iterations of x' = r * x * (1 - x) from x0 each frame.
 * - Final x mapped to a bar index in [0, 4); that bar lights up.
 *
 * Deferred: beat sync, region smoothness, transition fade, per-bar hue
 * offsets, external seed tap.
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

static gpu::ComputePSO s_pso;
static gpu::Buffer     s_uniform_buf;
static bool s_initialized = false;

// Schema-mirrored params
static float s_r                 = 3.95f;
static int   s_iterations        = 6;
static float s_ping_pong_rate_hz = 0.5f;
static float s_seed_low          = 0.1f;
static float s_seed_high         = 0.9f;
static float s_color_r           = 1.0f;
static float s_color_g           = 1.0f;
static float s_color_b           = 1.0f;
static float s_intensity         = 1.0f;
static float s_intensity_mod     = 0.0f;
static int   s_bar_count         = 4;

// Runtime state
static double s_elapsed = 0.0;

void init() {
  s_elapsed = 0.0;
  s_initialized = false;

  state::init("gen.strobe_channel", {1, 0, 0},
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
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("strobe_channel_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("strobe_channel_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("strobe_channel: initialized");
}

void tick(double dt) {
  s_elapsed += dt;
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "r"))                 s_r = state::patchFloat(i);
    else if (state::pathIs(path, plen, "iterations"))        s_iterations = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "ping_pong_rate_hz")) s_ping_pong_rate_hz = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed_low"))          s_seed_low = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed_high"))         s_seed_high = state::patchFloat(i);
    else if (state::pathIs(path, plen, "flash_color")) {
      auto v = state::patchVec3(i);
      s_color_r = v.x; s_color_g = v.y; s_color_b = v.z;
    }
    else if (state::pathIs(path, plen, "intensity"))         s_intensity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "intensity_mod"))     s_intensity_mod = state::patchFloat(i);
    else if (state::pathIs(path, plen, "bar_count"))         s_bar_count = (int)state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Triangle-wave ping-pong of the seed.
  float phase = (float)(s_elapsed * (double)s_ping_pong_rate_hz);
  phase = phase - std::floor(phase);       // [0, 1)
  float tri = std::fabs(phase * 2.0f - 1.0f); // [0, 1] tent
  float x = s_seed_low + (s_seed_high - s_seed_low) * tri;

  // Iterate the logistic map.
  int iters = s_iterations;
  if (iters < 1) iters = 1;
  if (iters > 32) iters = 32;
  for (int i = 0; i < iters; i++) {
    x = s_r * x * (1.0f - x);
  }
  if (!std::isfinite(x)) x = 0.5f;
  if (x < 0.0f) x = 0.0f;
  if (x >= 1.0f) x = 0.9999f;

  int bars = s_bar_count;
  if (bars < 1) bars = 1;
  if (bars > 16) bars = 16;
  int active_bar = (int)std::floor(x * (float)bars);
  if (active_bar < 0) active_bar = 0;
  if (active_bar >= bars) active_bar = bars - 1;

  float intensity = s_intensity + s_intensity_mod;
  if (intensity < 0.0f) intensity = 0.0f;

  Uniforms u = {};
  u.active_bar = (uint32_t)active_bar;
  u.bar_count  = (uint32_t)bars;
  u.intensity  = intensity;
  u.color_r    = s_color_r;
  u.color_g    = s_color_g;
  u.color_b    = s_color_b;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace strobe_channel
