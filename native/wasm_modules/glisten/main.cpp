/*
 * filter.legacy.glisten — image-anchored sparkle fans.
 *
 * A port of the shipped NanoGraph "Glisten". Pipeline:
 *
 *   1. findanchor (compute, single thread) — coarse/fine brightest-spot search
 *      + local luma gradient (stretch direction) + per-channel colour gradient
 *      (local tint). Writes one anchor record to a storage buffer.
 *   2. prefill (compute) — copy tex_in × input_alpha → tex_out base.
 *   3. render (instanced, additive) — draw blades × levels triangle spikes
 *      radiating from the anchor, stretched along the gradient, gradient-shaded.
 *
 * Flicker is a CPU-side envelope (Poisson re-trigger + exponential release)
 * that modulates intensity for a twinkle. Stateful → SeekableApproximate.
 */

#include <gpu.h>
#include <host.h>
#include "glisten_shaders.h"

#include <cmath>
#include <cstdint>

namespace glisten {

static constexpr int ANCHOR_FLOATS = 16;
static constexpr float PI = 3.14159265358979323846f;

struct FindAnchorUniforms {
  float coarse, fine, sampling_width, color_grad_soft;
  float color_grad_squash, color_grad_adjust, _p0, _p1;
};
struct PrefillUniforms { float sr, sg, sb, sa; };
struct VsUniforms {
  float aspect_x, aspect_y, blades, levels;
  float size, shape, spin, sweep;
  float stretch_grad, stretch_squash, blade_falloff, intensity;
  float color_grad_power, value_gain, tint_r, tint_g;
  float tint_b, _p0, _p1, _p2;
};
struct FsUniforms { float falloff, _p0, _p1, _p2; };

struct State {
  gpu::Buffer  anchor_buf;
  gpu::Buffer  find_uniform;
  gpu::Buffer  prefill_uniform;
  gpu::Buffer  vs_uniform;
  gpu::Buffer  fs_uniform;
  gpu::Sampler sampler;
  bool initialized = false;

  // CPU mirrors of schema params.
  int   blades        = 6;
  int   levels        = 6;
  float size          = 0.25f;
  float intensity     = 1.0f;
  float stretch_grad  = 2.0f;
  float tint_r = 1.0f, tint_g = 1.0f, tint_b = 1.0f;
  // Tuning
  float shape         = 1.0f;
  float spin          = 0.0f;
  float sweep         = 1.0f;
  float blade_falloff = 1.5f;
  float stretch_squash = 4.0f;
  float color_grad_power = 1.0f;
  float color_grad_soft  = 0.1f;
  float color_grad_squash = 4.0f;
  float value_gain    = 4.0f;
  float input_alpha   = 1.0f;
  // Flicker
  float flicker_depth   = 0.0f;
  float flicker_rate    = 0.4f;
  float flicker_release = 0.5f;

  // Flicker state.
  float    env = 0.0f;
  uint32_t rng = 0x9E3779B9u;
};

static gpu::ComputePSO s_pso_find;
static gpu::ComputePSO s_pso_prefill;
static gpu::RenderPSO  s_pso_render;

static inline uint32_t lcg_next(uint32_t& s) { s = s * 1664525u + 1013904223u; return s; }
static inline float lcg_unit(uint32_t& s) { return (lcg_next(s) >> 8) * (1.0f / float(1u << 24)); }

void module_init() {
  state::init("filter.legacy.glisten", {1, 0, 0},
    state::Schema()
      // ---- Standard ----
      .floatField("size",          0.25f, 0.01f, 1.0f,   state::PrimaryInput)
      .intField  ("blades",        6,     1,     64,     state::PrimaryInput)
      .intField  ("levels",        6,     1,     24,     state::PrimaryInput)
      .floatField("intensity",     1.0f,  0.0f,  2.0f,   state::PrimaryInput)
      .floatField("stretch_grad",  2.0f,  0.0f,  8.0f,   state::PrimaryInput)
      .rgbField  ("tint",          1.0f, 1.0f, 1.0f,     state::PrimaryInput)
      .floatField("flicker",       0.0f,  0.0f,  1.0f,   state::PrimaryInput)
      // ---- Tuning ----
      .floatField("shape",            1.0f, 0.05f, 4.0f, state::SecondaryInput)
      .floatField("spin",             0.0f, -3.1416f, 3.1416f, state::SecondaryInput)
      .floatField("sweep",            1.0f, 0.05f, 1.0f, state::SecondaryInput)
      .floatField("blade_falloff",    1.5f, 0.1f,  6.0f, state::SecondaryInput)
      .floatField("stretch_squash",   4.0f, 0.1f,  16.0f, state::SecondaryInput)
      .floatField("color_grad_power", 1.0f, 0.0f,  4.0f, state::SecondaryInput)
      .floatField("color_grad_soft",  0.1f, 0.0f,  1.0f, state::SecondaryInput)
      .floatField("color_grad_squash", 4.0f, 0.1f, 16.0f, state::SecondaryInput)
      .floatField("value_gain",       4.0f, 0.0f,  16.0f, state::SecondaryInput)
      .floatField("input_alpha",      1.0f, 0.0f,  1.0f, state::SecondaryInput)
      .floatField("flicker_rate",     0.4f, 0.0f,  1.0f, state::SecondaryInput)
      .floatField("flicker_release",  0.5f, 0.0f,  1.0f, state::SecondaryInput)
      // ---- I/O ----
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("glisten_findanchor", FINDANCHOR_SPV, FINDANCHOR_SPV_SIZE);
  state::registerShaderSPV("glisten_prefill",    PREFILL_SPV,    PREFILL_SPV_SIZE);
  state::registerShaderSPV("glisten_vs",         VS_SPV,         VS_SPV_SIZE);
  state::registerShaderSPV("glisten_fs",         FS_SPV,         FS_SPV_SIZE);

  auto cs_find    = gpu::Device::createShaderModuleByName("glisten_findanchor");
  auto cs_prefill = gpu::Device::createShaderModuleByName("glisten_prefill");
  auto vs         = gpu::Device::createShaderModuleByName("glisten_vs");
  auto fs         = gpu::Device::createShaderModuleByName("glisten_fs");
  if (!cs_find || !cs_prefill || !vs || !fs) return;

  s_pso_find = gpu::Device::createComputePSO(cs_find, "main", gpu::Bindings()
      .tex2d(0).sampler(1).storageRW(2).uniform(3));
  s_pso_prefill = gpu::Device::createComputePSO(cs_prefill, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_pso_render = gpu::Device::createInstancedRenderPSO(
      vs, "main", fs, "main",
      gpu::TextureFormat::Surface,
      gpu::Bindings().storage(0).uniform(1).uniform(2),
      gpu::Device::BlendMode::Additive);

  state::log("glisten: module initialized");
}

void* create() {
  auto* s = new State();
  s->anchor_buf      = gpu::Device::createBuffer(ANCHOR_FLOATS * sizeof(float), gpu::BufferUsage::Storage);
  s->find_uniform    = gpu::Device::createBuffer(sizeof(FindAnchorUniforms), gpu::BufferUsage::Uniform);
  s->prefill_uniform = gpu::Device::createBuffer(sizeof(PrefillUniforms), gpu::BufferUsage::Uniform);
  s->vs_uniform      = gpu::Device::createBuffer(sizeof(VsUniforms), gpu::BufferUsage::Uniform);
  s->fs_uniform      = gpu::Device::createBuffer(sizeof(FsUniforms), gpu::BufferUsage::Uniform);
  s->sampler         = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->anchor_buf.release();
  s->find_uniform.release();
  s->prefill_uniform.release();
  s->vs_uniform.release();
  s->fs_uniform.release();
  s->sampler.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso_find.valid() || !s_pso_prefill.valid() || !s_pso_render.valid()) return;
  s->env = 0.0f;
  s->rng = 0x9E3779B9u;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  float fdt = (float)dt;
  // Poisson re-trigger (§4.1), exponential release.
  float rate_hz = std::pow(60.0f, s->flicker_rate) - 1.0f;
  float lambda = rate_hz * fdt;
  if (lcg_unit(s->rng) < 1.0f - std::exp(-lambda)) s->env = 1.0f;
  float release_time = 0.02f + s->flicker_release * 0.6f;   // seconds
  s->env *= std::exp(-fdt / release_time);
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "size"))            s->size = state::patchFloat(i);
    else if (state::pathIs(p, l, "blades"))          s->blades = state::patchInt(i);
    else if (state::pathIs(p, l, "levels"))          s->levels = state::patchInt(i);
    else if (state::pathIs(p, l, "intensity"))       s->intensity = state::patchFloat(i);
    else if (state::pathIs(p, l, "stretch_grad"))    s->stretch_grad = state::patchFloat(i);
    else if (state::pathIs(p, l, "tint"))            { auto v = state::patchVec3(i); s->tint_r = v.x; s->tint_g = v.y; s->tint_b = v.z; }
    else if (state::pathIs(p, l, "flicker"))         s->flicker_depth = state::patchFloat(i);
    else if (state::pathIs(p, l, "shape"))           s->shape = state::patchFloat(i);
    else if (state::pathIs(p, l, "spin"))            s->spin = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep"))           s->sweep = state::patchFloat(i);
    else if (state::pathIs(p, l, "blade_falloff"))   s->blade_falloff = state::patchFloat(i);
    else if (state::pathIs(p, l, "stretch_squash"))  s->stretch_squash = state::patchFloat(i);
    else if (state::pathIs(p, l, "color_grad_power")) s->color_grad_power = state::patchFloat(i);
    else if (state::pathIs(p, l, "color_grad_soft"))  s->color_grad_soft = state::patchFloat(i);
    else if (state::pathIs(p, l, "color_grad_squash")) s->color_grad_squash = state::patchFloat(i);
    else if (state::pathIs(p, l, "value_gain"))      s->value_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "input_alpha"))     s->input_alpha = state::patchFloat(i);
    else if (state::pathIs(p, l, "flicker_rate"))    s->flicker_rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "flicker_release")) s->flicker_release = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  FindAnchorUniforms fu = {};
  fu.coarse = 24.0f; fu.fine = 8.0f;
  fu.sampling_width = 0.005f;
  fu.color_grad_soft = s->color_grad_soft;
  fu.color_grad_squash = s->color_grad_squash;
  fu.color_grad_adjust = 0.5f;
  s->find_uniform.writeOne(fu);

  PrefillUniforms pu = { s->input_alpha, s->input_alpha, s->input_alpha, 1.0f };
  s->prefill_uniform.writeOne(pu);

  // Flicker modulation: 1 at full env, intensity*(1-depth) at rest.
  float flick = 1.0f - s->flicker_depth * (1.0f - s->env);
  float min_dim = float(vp_w < vp_h ? vp_w : vp_h);

  VsUniforms vu = {};
  vu.aspect_x = min_dim / float(vp_w);
  vu.aspect_y = min_dim / float(vp_h);
  vu.blades = (float)s->blades;
  vu.levels = (float)s->levels;
  vu.size = s->size;
  vu.shape = s->shape;
  vu.spin = s->spin;
  vu.sweep = s->sweep;
  vu.stretch_grad = s->stretch_grad;
  vu.stretch_squash = s->stretch_squash;
  vu.blade_falloff = s->blade_falloff;
  vu.intensity = s->intensity * flick;
  vu.color_grad_power = s->color_grad_power;
  vu.value_gain = s->value_gain;
  vu.tint_r = s->tint_r; vu.tint_g = s->tint_g; vu.tint_b = s->tint_b;
  s->vs_uniform.writeOne(vu);

  FsUniforms fsu = { s->blade_falloff, 0.f, 0.f, 0.f };
  s->fs_uniform.writeOne(fsu);

  // Pass 1 — find anchor.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_find);
    cp.setTexture(in, 0, 0);
    cp.setSampler(s->sampler, 1);
    cp.setBuffer(s->anchor_buf, 2);
    cp.setBuffer(s->find_uniform, 3);
    cp.dispatch(1, 1, 1);
    cp.end();
  }

  // Pass 2 — prefill base.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill);
    cp.setTexture(in, 0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->prefill_uniform, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Pass 3 — instanced sparkle (additive over the prefilled base).
  if (vu.intensity > 0.0f) {
    int instances = s->blades * s->levels;
    auto rp = gpu::RenderPass::beginLoad(out);
    rp.setPSO(s_pso_render);
    rp.setBuffer(s->anchor_buf, 0);
    rp.setBuffer(s->vs_uniform, 1);
    rp.setBuffer(s->fs_uniform, 2);
    rp.draw(3, instances);
    rp.end();
  }

  gpu::Device::submit();
}

} // namespace glisten
