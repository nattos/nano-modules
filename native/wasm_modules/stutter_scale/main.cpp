/*
 * warp.legacy.stutter_scale — "Stutter Scale 2" (v2 of the Resolume Wire patch).
 *
 * A beat-stutter scale/zoom glitch: a phase is quantized into `levels` discrete
 * steps, and on each step boundary a seeded random transform is re-rolled and
 * HELD for that step — a random scale ∈ [min, max], a jitter translation, an
 * optional Y-flip and colour inversion, plus a hue rotation and a
 * contrast/brightness boost. The result crossfades with the untouched input by
 * `intensity`. Very useful for stuttering overlays and logos.
 *
 * Source patch (Wire/Patches/Stutter Scale 2, 96 nodes): a Sweep drives a phase
 * floor-quantized by Levels; On-Change fires a Trigger that re-seeds Random
 * nodes for scale (Min/Max Scale), translation/jitter (Max Jitter / Movement),
 * Flip Y, Hue Rotate, Invert RGB, with Bright.Contrast (Cutoff/Boost), an
 * Attack-Release env (Env Time/Trigger) and an Alpha-Mode blend out.
 *
 * v2 RE-ARCHITECTURE (flagged per DNODE_MIGRATION_NOTES §3): the scheduler is a
 * clean internal phase clock (`rate`) plus an additive `sweep` input (drive it
 * from a beat tap for sync); each step's transform is seeded by the step index
 * (deterministic, reproducible). DROPPED for v2 (recoverable later): the 22 Alpha
 * blend modes (we crossfade), the start/end deadzones, the optical-flow "Use
 * Motion" motion-blur path, and the explicit Attack-Release env (use `intensity`
 * or a tap). `min/max_scale` are raw scale factors; the rest are [0,1].
 *
 * Stateful only in the phase clock; is_identity is CONFIG-only (intensity≈0),
 * which is safe (raising intensity is a config change → un-aliased).
 */

#include <gpu.h>
#include <host.h>
#include "stutter_scale_shaders.h"

#include <cmath>
#include <cstdint>

namespace stutter_scale {

static constexpr float TAU          = 6.28318530717958647692f;
static constexpr float RATE_SCALE   = 2.0f;  // rate=1 → 2 phase units/sec
static constexpr float JITTER_SCALE = 0.5f;  // jitter=1 → up to 0.5 uv translation

struct Uniforms {
  float scale;
  float trans_x;
  float trans_y;
  float flip_y;
  float hue_shift;
  float invert;
  float bright;
  float contrast;
  float intensity;
  float _p0, _p1, _p2;
};
static_assert(sizeof(Uniforms) == 48, "Uniforms layout mismatch");

struct State {
  gpu::Buffer  uniform_buf;
  gpu::Sampler sampler;
  bool initialized = false;

  // Schema-mirrored params.
  float rate       = 0.6f;
  float sweep      = 0.0f;
  int   levels     = 10;
  float min_scale  = 1.0f;
  float max_scale  = 6.0f;
  float jitter     = 0.3f;
  float hue        = 0.0f;
  float boost      = 0.25f;
  float intensity  = 1.0f;
  bool  do_flip    = true;
  bool  do_invert  = false;
  int   seed       = 1234;

  double clock = 0.0; // internal phase accumulator
};

static gpu::ComputePSO s_pso;

static inline uint32_t hash_u32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
static inline float rand01(uint32_t h) { return (h >> 8) * (1.0f / 16777216.0f); }

void module_init() {
  state::init("warp.legacy.stutter_scale", {1, 0, 0},
    state::Schema()
      .floatField("rate", 0.6f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Internal stutter clock speed (0 = driven only by sweep).")
      .floatField("sweep", 0.0f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Phase offset — drive from a beat tap for sync.")
      .intField  ("levels", 10, 1, 25, state::PrimaryInput, 0, nullptr,
                  "Number of discrete stutter steps per phase unit.")
      .floatField("min_scale", 1.0f, 1.0f, 16.0f, state::PrimaryInput, nullptr, 0.05f,
                  nullptr, "Minimum per-step zoom factor.")
      .floatField("max_scale", 6.0f, 1.0f, 16.0f, state::PrimaryInput, nullptr, 0.05f,
                  nullptr, "Maximum per-step zoom factor.")
      .floatField("jitter", 0.3f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Per-step random translation amount.")
      .floatField("hue", 0.0f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Per-step random hue rotation range.")
      .floatField("boost", 0.25f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Contrast/brightness boost.")
      .floatField("intensity", 1.0f, 0.0f, 1.0f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Crossfade with the untouched input.")
      .boolField ("flip", true, state::PrimaryInput, "Allow random Y-flips per step.")
      .boolField ("color_invert", false, state::PrimaryInput, "Allow random colour inversion per step.")
      .intField  ("seed", 1234, 0, 65535, state::PrimaryInput, 0, nullptr, "Random seed.")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("stutter_scale_stutter", STUTTER_SPV, STUTTER_SPV_SIZE,
                           "rgba8unorm", "write");
  auto cs = gpu::Device::createShaderModuleByName("stutter_scale_stutter");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0).sampler(1).storageTex2d(2, gpu::TextureFormat::RGBA8).uniform(3));

  state::log("stutter_scale: module initialized");
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
  s->clock = 0.0;
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (dt < 0.0) dt = 0.0;
  s->clock += dt * (double)s->rate * (double)RATE_SCALE;
  if (s->clock > 1.0e9) s->clock = std::fmod(s->clock, 1.0e6);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "rate"))         s->rate      = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep"))        s->sweep     = state::patchFloat(i);
    else if (state::pathIs(p, l, "levels"))       s->levels    = state::patchInt(i);
    else if (state::pathIs(p, l, "min_scale"))    s->min_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "max_scale"))    s->max_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "jitter"))       s->jitter    = state::patchFloat(i);
    else if (state::pathIs(p, l, "hue"))          s->hue       = state::patchFloat(i);
    else if (state::pathIs(p, l, "boost"))        s->boost     = state::patchFloat(i);
    else if (state::pathIs(p, l, "intensity"))    s->intensity = state::patchFloat(i);
    else if (state::pathIs(p, l, "flip"))         s->do_flip   = state::patchBool(i);
    else if (state::pathIs(p, l, "color_invert")) s->do_invert = state::patchBool(i);
    else if (state::pathIs(p, l, "seed"))         s->seed      = state::patchInt(i);
  }
}

void on_resolume_param(void* self, long long, double) { (void)self; }

// Config-only identity (intensity ≈ 0 → crossfade is all input). Safe: the
// stutter clock is irrelevant when intensity is 0, and raising intensity is a
// config change that un-aliases the stage.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return 0;
  return (s->intensity <= 1e-3f) ? 1 : 0;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Quantize phase into the current step, then seed this step's transform.
  int levels = s->levels < 1 ? 1 : s->levels;
  double phase = s->clock + (double)s->sweep;
  long step = (long)std::floor(phase * (double)levels);
  uint32_t h = hash_u32((uint32_t)(step * 2654435761u) ^ (uint32_t)s->seed);

  float r0 = rand01(h);              h = hash_u32(h);
  float r1 = rand01(h);              h = hash_u32(h);
  float r2 = rand01(h);              h = hash_u32(h);
  float r3 = rand01(h);              h = hash_u32(h);
  float r4 = rand01(h);              h = hash_u32(h);
  float r5 = rand01(h);

  float lo = s->min_scale, hi = s->max_scale;
  Uniforms u = {};
  u.scale     = lo + (hi - lo) * r0;
  u.trans_x   = (r1 * 2.0f - 1.0f) * s->jitter * JITTER_SCALE;
  u.trans_y   = (r2 * 2.0f - 1.0f) * s->jitter * JITTER_SCALE;
  u.flip_y    = (s->do_flip   && r3 < 0.5f) ? 1.0f : 0.0f;
  u.invert    = (s->do_invert && r4 < 0.5f) ? 1.0f : 0.0f;
  u.hue_shift = (r5 * 2.0f - 1.0f) * s->hue * TAU;
  u.bright    = 0.0f;
  u.contrast  = s->boost;
  u.intensity = s->intensity;
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

} // namespace stutter_scale
