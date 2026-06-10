/*
 * video.twitch_mask — roaming "twitch" vignette glitch.
 *
 * Each frame, suppresses a random oval region of the input: a vignette anchored
 * at a per-frame random point, with a bipolar `shape` (+ blacks the rim, -
 * blacks the centre). Pulled out of video.local_delay's spatial mask; the per-
 * frame anchor/strength logic is shared via fx::TwitchMask (effect_twitch_mask.h)
 * and the GPU mask via shaders_common/nano_twitch.hlsl.
 *
 * Stateful (per-instance PRNG advances each frame when amount > 0), so NOT a
 * fused mapper. is_identity holds only at amount == 0 (no draw, no state change).
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include <effect_twitch_mask.h>
#include "twitch_mask_shaders.h"

#include <cstdint>

namespace twitch_mask {

// Layout MUST match cbuffer U in compute.hlsl.
struct Uniforms {
  float shape, radius, softness, strength;
  float anchor_x, anchor_y, aspect_x, aspect_y;
  float vp_w, vp_h, _pad0, _pad1;
};

struct State {
  // --- Schema-mirrored params ---
  float amount   = 0.0f;    // 0 = off; modulation depth + intensity skew
  float shape    = -0.5f;   // -1..1 bipolar like `vignette`
  float radius   = 0.3f;
  float softness = 0.3f;
  float position = 0.0f;    // -1 outer-ring spawn, +1 centre spawn

  // Roaming twitch — owns its own per-instance PRNG.
  fx::TwitchMask twitch;
  // This frame's drawn anchor + strength (updated in tick).
  float anchor_x = 0.0f, anchor_y = 0.0f, strength = 0.0f;

  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Distinct PRNG seed per instance (no wall-clock / RNG primitive needed).
static uint32_t s_seed_counter = 0x9E3779B9u;

void module_init() {
  state::init("video.twitch_mask", {1, 0, 0},
    state::Schema()
      // 0 = off; modulation depth into the mask. 0..0.5 ramps depth, 0.5..1
      // boosts the random per-frame intensity (cuts harder, more often).
      .floatField("amount",   0.0f,  0.0f, 1.0f, state::PrimaryInput)
      // Bipolar pattern. Sign sets polarity (+ blacks the rim, - the centre);
      // magnitude morphs |1| radial → |0.5| linear gradient → |0| solid.
      .floatField("shape",   -0.5f, -1.0f, 1.0f, state::PrimaryInput)
      .floatField("radius",   0.3f,  0.0f, 1.0f, state::PrimaryInput)
      .floatField("softness", 0.3f,  0.0f, 1.0f, state::PrimaryInput)
      // Spawn bias: -1 → outer ring, +1 → centre (scaled out by radius).
      .floatField("position", 0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
}

void* create() {
  auto* s = new State();
  s_seed_counter = s_seed_counter * 1664525u + 1013904223u;
  s->twitch.seed(s_seed_counter ^ 0x7717C4u);
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
  s->amount = 0.0f;
  s->shape = -0.5f;
  s->radius = 0.3f;
  s->softness = 0.3f;
  s->position = 0.0f;
  s->anchor_x = s->anchor_y = s->strength = 0.0f;
  s->initialized = false;
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
}

// Draw this frame's random anchor + strength (once per frame).
void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;
  (void)dt;
  auto f = s->twitch.update({ s->amount, s->shape, s->radius, s->softness, s->position });
  s->anchor_x = f.anchor_x;
  s->anchor_y = f.anchor_y;
  s->strength = f.strength;
}

void on_resolume_param(void*, long long, double) {}

// Pass-through when amount == 0: no draw, strength stays 0 → mask multiplier 1.
// No state advances at amount == 0, so skipping is safe.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->amount == 0.0f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "amount"))   s->amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "shape"))    s->shape = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius"))   s->radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness")) s->softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "position")) s->position = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input  = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  Uniforms u = {};
  u.shape = s->shape;
  u.radius = s->radius;
  u.softness = s->softness;
  u.strength = s->strength;
  u.anchor_x = s->anchor_x;
  u.anchor_y = s->anchor_y;
  u.aspect_x = ax;
  u.aspect_y = ay;
  u.vp_w = (float)vp_w;
  u.vp_h = (float)vp_h;
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace twitch_mask
