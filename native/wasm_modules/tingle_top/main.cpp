/*
 * gen.tingle_top — sparkles bundled at the top of each bar while gated,
 * released downward on an envelope when ungated.
 *
 * Particles don't move (unless given a velocity) — they live and die in
 * place. The visible "cascade" is a SPAWN-REGION animation: region_y_max (a
 * CPU envelope) is the lower edge of the spawn band. Gated → snaps to
 * top_band_height (a thin top slice); released → ramps to 1.0 over release_s,
 * so newly-born sparkles appear progressively lower and the cloud drains
 * downward. (Velocity unlocks the "downward_sparkle" preset.)
 *
 * GPU-resident particle pool (update + render + motion passthrough), instance
 * ABI. Trigger surface: gate / trigger / level / auto_rate, with
 * default_gate_state as the at-rest fallback.
 */

#include <gpu.h>
#include <host.h>
#include "tingle_top_shaders.h"

#include <cmath>
#include <cstdint>

namespace tingle_top {

static constexpr int POOL_HARD_MAX = 2048;

struct GpuParticle { float a[4], b[4], c[4]; };   // matches Particle (48 B)
static_assert(sizeof(GpuParticle) == 48, "GpuParticle layout mismatch");

struct UpdateUniforms {
  uint32_t count, pool_max, frame_index, do_reset;
  float    dt, region_y_max, top_band_height, life_s;
  float    respawn_delay_s, life_jitter, size, size_jitter;
  float    vel_x, vel_y, vel_x_jitter, vel_y_jitter;
  float    hue_jitter; uint32_t bar_all, bar_target, respect_bounds;
  uint32_t seed; float _pad0, _pad1, _pad2;
};
static_assert(sizeof(UpdateUniforms) == 96, "UpdateUniforms layout mismatch");

struct RenderUniforms {
  uint32_t count, pool_max, frame_index, debug_region;
  float    intensity, hue, frame_alpha_jitter, alpha_curve;
  uint32_t shape_kind; float shape_param, region_y_max, aspect;
  float    _pad0, _pad1, _pad2, _pad3;
};
static_assert(sizeof(RenderUniforms) == 64, "RenderUniforms layout mismatch");

struct State {
  gpu::Buffer  part_buf, update_uniform_buf, render_uniform_buf;
  gpu::Texture motion_tex, zero_motion_tex;
  int          motion_w = 0, motion_h = 0;
  bool         initialized = false;

  // Standard.
  bool  gate = false;
  float level = 0.0f;
  float auto_rate = 0.0f;
  float top_band_height = 0.1f;
  float release_s = 0.8f;
  float release_curve = 1.5f;
  float min_sustain_s = 0.3f;
  bool  default_gate_state = false;
  float intensity = 1.0f;
  float hue = 0.12f;
  float hue_jitter = 0.08f;
  int   density = 60;
  // Tuning.
  int   bar_target = 0;
  bool  bar_target_all = true;
  float particle_life_ms = 200.0f;
  float respawn_delay_ms = 30.0f;
  float life_jitter = 0.4f;
  float size = 0.008f;
  float size_jitter = 0.5f;
  float frame_alpha_jitter = 0.6f;
  int   shape_kind = 2;
  float shape_param = 0.7f;
  float alpha_curve = 1.5f;
  int   pool_max = 1024;
  int   seed = 12345;
  // Velocity.
  float particle_velocity_y = 0.0f;
  float particle_velocity_x = 0.0f;
  float velocity_y_jitter = 0.0f;
  float velocity_x_jitter = 0.0f;
  bool  respect_position_bounds = true;
  bool  debug_show_region = false;

  // Runtime.
  uint32_t frame_index = 0;
  float    frame_dt = 0.0f;
  bool     needs_reset = true;
  int      last_pool_max = -1, last_seed = 0x7FFFFFFF;
  // Envelope.
  float    region_y_max = 1.0f;
  bool     held_prev = false;
  float    release_t = 1e9f;
  float    sustain_timer = 0.0f;
  bool     gate_prev = false;
  float    trigger_prev = 0.0f;
  uint32_t auto_rng = 0xCAFEBABEu;
};

static gpu::ComputePSO s_pso_update, s_pso_render, s_pso_motion;

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static inline int   clampi(int v, int lo, int hi)       { return v < lo ? lo : (v > hi ? hi : v); }

void module_init() {
  state::init("gen.tingle_top", {1, 0, 0},
    state::Schema()
      .boolField ("gate",                false,                state::PrimaryInput)
      .eventField("trigger",                                   state::PrimaryInput)
      .floatField("level",               0.0f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("auto_rate",           0.0f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("top_band_height",     0.1f, 0.01f, 0.5f,    state::PrimaryInput)
      .floatField("release_s",           0.8f, 0.05f, 4.0f,    state::PrimaryInput)
      .floatField("release_curve",       1.5f, 0.25f, 4.0f,    state::PrimaryInput)
      .floatField("min_sustain_s",       0.3f, 0.0f, 2.0f,     state::PrimaryInput)
      .boolField ("default_gate_state",  false,                state::PrimaryInput)
      .floatField("intensity",           1.0f, 0.0f, 2.0f,     state::PrimaryInput)
      .floatField("hue",                 0.12f, 0.0f, 1.0f,    state::PrimaryInput)
      .floatField("hue_jitter",          0.08f, 0.0f, 0.5f,    state::PrimaryInput)
      .intField  ("density",             60, 1, 400,           state::PrimaryInput)
      .intField  ("bar_target",          0, 0, 3,              state::PrimaryInput)
      .boolField ("bar_target_all",      true,                 state::PrimaryInput)
      .floatField("particle_life_ms",    200.0f, 10.0f, 1000.0f, state::PrimaryInput)
      .floatField("respawn_delay_ms",    30.0f, 0.0f, 500.0f,  state::PrimaryInput)
      .floatField("life_jitter",         0.4f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("size",                0.008f, 0.001f, 0.05f, state::PrimaryInput)
      .floatField("size_jitter",         0.5f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("frame_alpha_jitter",  0.6f, 0.0f, 1.0f,     state::PrimaryInput)
      .selectField("shape_kind",         2, state::PrimaryInput,
                   {{"solid", 0}, {"circle", 1}, {"gaussian", 2}})
      .floatField("shape_param",         0.7f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("alpha_curve",         1.5f, 0.25f, 4.0f,    state::PrimaryInput)
      .intField  ("pool_max",            1024, 8, 2048,        state::PrimaryInput)
      .intField  ("seed",                12345, 0, 0x7FFFFFFF, state::PrimaryInput)
      .floatField("particle_velocity_y", 0.0f, -2.0f, 2.0f,    state::PrimaryInput)
      .floatField("particle_velocity_x", 0.0f, -2.0f, 2.0f,    state::PrimaryInput)
      .floatField("velocity_y_jitter",   0.0f, 0.0f, 1.0f,     state::PrimaryInput)
      .floatField("velocity_x_jitter",   0.0f, 0.0f, 1.0f,     state::PrimaryInput)
      .boolField ("respect_position_bounds", true,             state::PrimaryInput)
      .boolField ("debug_show_region",   false,                state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("tingle_top_update", UPDATE_SPV, UPDATE_SPV_SIZE);
  state::registerShaderSPV("tingle_top_render", RENDER_SPV, RENDER_SPV_SIZE);
  state::registerShaderSPV("tingle_top_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_u = gpu::Device::createShaderModuleByName("tingle_top_update");
  auto cs_r = gpu::Device::createShaderModuleByName("tingle_top_render");
  auto cs_m = gpu::Device::createShaderModuleByName("tingle_top_motion");
  if (!cs_u || !cs_r || !cs_m) return;

  s_pso_update = gpu::Device::createComputePSO(cs_u, "main", gpu::Bindings().storageRW(0).uniform(1));
  s_pso_render = gpu::Device::createComputePSO(cs_r, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2).storage(3));
  s_pso_motion = gpu::Device::createComputePSO(cs_m, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA16F));

  state::log("tingle_top: module initialized");
}

void* create() {
  auto* s = new State();
  s->part_buf           = gpu::Device::createBuffer(sizeof(GpuParticle) * POOL_HARD_MAX, gpu::BufferUsage::Storage);
  s->update_uniform_buf = gpu::Device::createBuffer(sizeof(UpdateUniforms), gpu::BufferUsage::Uniform);
  s->render_uniform_buf = gpu::Device::createBuffer(sizeof(RenderUniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->part_buf.release();
  s->update_uniform_buf.release();
  s->render_uniform_buf.release();
  s->motion_tex.release();
  s->zero_motion_tex.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->frame_index = 0;
  s->frame_dt = 0.0f;
  s->needs_reset = true;
  s->last_pool_max = -1;
  s->last_seed = 0x7FFFFFFF;
  s->motion_w = s->motion_h = 0;
  s->region_y_max = 1.0f;
  s->held_prev = false;
  s->release_t = 1e9f;
  s->sustain_timer = 0.0f;
  s->gate_prev = false;
  s->trigger_prev = 0.0f;
  s->auto_rng = 0xCAFEBABEu;
  if (!s_pso_update.valid() || !s_pso_render.valid() || !s_pso_motion.valid()) return;
  if (!s->part_buf.valid() || !s->update_uniform_buf.valid() || !s->render_uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;
  float fdt = (float)(dt > 0.1 ? 0.1 : (dt < 0.0 ? 0.0 : dt));
  s->frame_dt = fdt;
  s->frame_index++;

  // Poisson auto-trigger → fires a min_sustain pulse.
  if (s->auto_rate > 0.0f) {
    float rate_hz = std::pow(60.0f, s->auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      s->auto_rng = s->auto_rng * 1664525u + 1013904223u;
      float u = (s->auto_rng >> 8) * (1.0f / (float)(1u << 24));
      if (u < 1.0f - std::exp(-rate_hz * fdt)) s->sustain_timer = clampf(s->min_sustain_s, 0.0f, 2.0f);
    }
  }
  if (s->sustain_timer > 0.0f) s->sustain_timer -= fdt;

  // Held this frame: gate priority > trigger pulse > level > default.
  bool held = s->gate || (s->sustain_timer > 0.0f) || (s->level >= 0.5f) || s->default_gate_state;

  // Region envelope: snap to the top band while held, ramp to 1.0 on release.
  float tbh = clampf(s->top_band_height, 0.01f, 0.5f);
  if (held) {
    s->region_y_max = tbh;
  } else {
    if (s->held_prev) s->release_t = 0.0f;          // just released
    s->release_t += fdt;
    float rs = clampf(s->release_s, 0.05f, 4.0f);
    float pr = clampf(s->release_t / rs, 0.0f, 1.0f);
    float shaped = std::pow(pr, clampf(s->release_curve, 0.25f, 4.0f));
    s->region_y_max = tbh + (1.0f - tbh) * shaped;
  }
  s->held_prev = held;
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "gate")) {
      s->gate = state::patchFloat(i) != 0.0f; s->gate_prev = s->gate;
    } else if (state::pathIs(path, plen, "trigger")) {
      float v = state::patchFloat(i);
      if (v != 0.0f && s->trigger_prev == 0.0f) s->sustain_timer = clampf(s->min_sustain_s, 0.0f, 2.0f);
      s->trigger_prev = v;
    }
    else if (state::pathIs(path, plen, "level"))               s->level = state::patchFloat(i);
    else if (state::pathIs(path, plen, "auto_rate"))           s->auto_rate = state::patchFloat(i);
    else if (state::pathIs(path, plen, "top_band_height"))     s->top_band_height = state::patchFloat(i);
    else if (state::pathIs(path, plen, "release_s"))           s->release_s = state::patchFloat(i);
    else if (state::pathIs(path, plen, "release_curve"))       s->release_curve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "min_sustain_s"))       s->min_sustain_s = state::patchFloat(i);
    else if (state::pathIs(path, plen, "default_gate_state"))  s->default_gate_state = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "intensity"))           s->intensity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hue"))                 s->hue = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hue_jitter"))          s->hue_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "density"))             s->density = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "bar_target"))          s->bar_target = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "bar_target_all"))      s->bar_target_all = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "particle_life_ms"))    s->particle_life_ms = state::patchFloat(i);
    else if (state::pathIs(path, plen, "respawn_delay_ms"))    s->respawn_delay_ms = state::patchFloat(i);
    else if (state::pathIs(path, plen, "life_jitter"))         s->life_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "size"))                s->size = state::patchFloat(i);
    else if (state::pathIs(path, plen, "size_jitter"))         s->size_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "frame_alpha_jitter"))  s->frame_alpha_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "shape_kind"))          s->shape_kind = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "shape_param"))         s->shape_param = state::patchFloat(i);
    else if (state::pathIs(path, plen, "alpha_curve"))         s->alpha_curve = state::patchFloat(i);
    else if (state::pathIs(path, plen, "pool_max"))            s->pool_max = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed"))                s->seed = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "particle_velocity_y")) s->particle_velocity_y = state::patchFloat(i);
    else if (state::pathIs(path, plen, "particle_velocity_x")) s->particle_velocity_x = state::patchFloat(i);
    else if (state::pathIs(path, plen, "velocity_y_jitter"))   s->velocity_y_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "velocity_x_jitter"))   s->velocity_x_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "respect_position_bounds")) s->respect_position_bounds = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "debug_show_region"))   s->debug_show_region = state::patchFloat(i) != 0.0f;
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  int pool_max = clampi(s->pool_max, 8, POOL_HARD_MAX);
  int bars = s->bar_target_all ? 4 : 1;
  int count = clampi(clampi(s->density, 1, 400) * bars, 0, pool_max);

  if (pool_max != s->last_pool_max || s->seed != s->last_seed) {
    s->needs_reset = true; s->last_pool_max = pool_max; s->last_seed = s->seed;
  }

  // Pass 1 — update the pool.
  UpdateUniforms uu = {};
  uu.count = (uint32_t)count;
  uu.pool_max = (uint32_t)pool_max;
  uu.frame_index = s->frame_index;
  uu.do_reset = s->needs_reset ? 1u : 0u;
  uu.dt = s->frame_dt;
  uu.region_y_max = clampf(s->region_y_max, 0.0f, 1.0f);
  uu.top_band_height = clampf(s->top_band_height, 0.01f, 0.5f);
  uu.life_s = clampf(s->particle_life_ms, 10.0f, 1000.0f) * 0.001f;
  uu.respawn_delay_s = clampf(s->respawn_delay_ms, 0.0f, 500.0f) * 0.001f;
  uu.life_jitter = clampf(s->life_jitter, 0.0f, 1.0f);
  uu.size = clampf(s->size, 0.001f, 0.05f);
  uu.size_jitter = clampf(s->size_jitter, 0.0f, 1.0f);
  uu.vel_x = clampf(s->particle_velocity_x, -2.0f, 2.0f);
  uu.vel_y = clampf(s->particle_velocity_y, -2.0f, 2.0f);
  uu.vel_x_jitter = clampf(s->velocity_x_jitter, 0.0f, 1.0f);
  uu.vel_y_jitter = clampf(s->velocity_y_jitter, 0.0f, 1.0f);
  uu.hue_jitter = clampf(s->hue_jitter, 0.0f, 0.5f);
  uu.bar_all = s->bar_target_all ? 1u : 0u;
  uu.bar_target = (uint32_t)clampi(s->bar_target, 0, 3);
  uu.respect_bounds = s->respect_position_bounds ? 1u : 0u;
  uu.seed = (uint32_t)s->seed;
  s->update_uniform_buf.writeOne(uu);
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_update);
    cp.setBuffer(s->part_buf, 0);
    cp.setBuffer(s->update_uniform_buf, 1);
    cp.dispatch((pool_max + 63) / 64, 1, 1);
    cp.end();
  }

  // Pass 2 — render.
  RenderUniforms ru = {};
  ru.count = (uint32_t)count;
  ru.pool_max = (uint32_t)pool_max;
  ru.frame_index = s->frame_index;
  ru.debug_region = s->debug_show_region ? 1u : 0u;
  ru.intensity = clampf(s->intensity, 0.0f, 2.0f);
  ru.hue = s->hue;
  ru.frame_alpha_jitter = clampf(s->frame_alpha_jitter, 0.0f, 1.0f);
  ru.alpha_curve = clampf(s->alpha_curve, 0.25f, 4.0f);
  ru.shape_kind = (uint32_t)clampi(s->shape_kind, 0, 2);
  ru.shape_param = clampf(s->shape_param, 0.0f, 1.0f);
  ru.region_y_max = clampf(s->region_y_max, 0.0f, 1.0f);
  ru.aspect = (float)vp_w / (float)vp_h;
  s->render_uniform_buf.writeOne(ru);
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_render);
    cp.setTexture(in, 0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->render_uniform_buf, 2);
    cp.setBuffer(s->part_buf, 3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Pass 3 — motion passthrough.
  if (state::isOutputConnected("render_outputs")) {
    if (!s->motion_tex.valid() || s->motion_w != vp_w || s->motion_h != vp_h) {
      s->motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s->motion_w = vp_w; s->motion_h = vp_h;
      if (s->motion_tex.valid()) state::setGpuTexture("render_outputs/motion", s->motion_tex.id);
    }
    if (s->motion_tex.valid()) {
      auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
      if (!upstream.valid()) {
        if (!s->zero_motion_tex.valid())
          s->zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
        upstream = s->zero_motion_tex;
      }
      if (upstream.valid()) {
        auto cp = gpu::ComputePass::begin();
        cp.setPSO(s_pso_motion);
        cp.setTexture(upstream, 0, 0);
        cp.setTexture(s->motion_tex, 1, 1);
        cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
        cp.end();
      }
    }
  }

  gpu::Device::submit();

  s->needs_reset = false;
  s->frame_dt = 0.0f;
}

} // namespace tingle_top
