/*
 * source.noise — Procedural noise generator.
 *
 * Standard params:
 *   algorithm   int        0 = white, 1 = value, 2 = simplex/perlin-style
 *                          fbm, 3 = static (TV-style animated white).
 *   scale       [0, 1]     spatial scale, mapped exponentially to cell sizes.
 *   contrast    [-1, +1]   bipolar contrast curve (signed gamma).
 *   seed        [0, 1]     fixed seed for deterministic patterns.
 *
 * Tuning params:
 *   octaves     int        1..6 (only meaningful for fbm).
 *   color       [0, 1]     0 = greyscale, 1 = independent RGB hashes.
 *   speed       [0, 1]     animation rate. 0 = frozen. White and static
 *                          reroll discretely (up to ~30 Hz); value and fbm
 *                          evolve smoothly through a time axis.
 *
 * Uses an internal accumulator to advance the animation phase, per the
 * style guide's time-handling rule (no `elapsed * rate`).
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "noise_shaders.h"

namespace noise {

// algorithm options — values must match the branch logic in the shader.
enum Algorithm {
  AlgoWhite   = 0,  // uniform white noise
  AlgoValue   = 1,  // value noise
  AlgoFbm     = 2,  // simplex/perlin-style fbm
  AlgoStatic  = 3,  // TV-style animated white
};

struct FuseUniforms {
  int   algorithm;
  float scale;
  float contrast;
  float seed;
  int   octaves;
  float color;
  float static_phase;
  float aspect_x;
  float aspect_y;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

// Per-instance state. One per chain entry.
struct State {
  int   algorithm = 0;
  float scale = 0.5f;
  float contrast = 0.0f;
  float seed = 0.0f;
  int   octaves = 4;
  float color = 0.0f;
  float speed = 0.5f;

  float static_phase = 0.0f;  // accumulator (style guide §2.1)

  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  FuseUniforms u = {};
  u.algorithm = s->algorithm;
  u.scale = s->scale;
  u.contrast = s->contrast;
  u.seed = s->seed;
  u.octaves = s->octaves;
  u.color = s->color;
  u.static_phase = s->static_phase;
  u.aspect_x = ax;
  u.aspect_y = ay;
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("source.noise", {1, 0, 0},
    state::Schema()
      .selectField("algorithm", AlgoWhite, state::PrimaryInput, {
          {"White",  AlgoWhite},
          {"Value",  AlgoValue},
          {"FBM",    AlgoFbm},
          {"Static", AlgoStatic},
      })
      .floatField("scale",   0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("contrast",0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("seed",    0.0f, 0.f, 1.f, state::PrimaryInput)
      .intField("octaves",   4,    1, 6,    state::SecondaryInput)
      .floatField("color",   0.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("speed",   0.5f, 0.f, 1.f, state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::Generator)
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

// Per-instance init tail: defaults + per-instance fusion registration.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->algorithm = 0;
  s->scale = 0.5f;
  s->contrast = 0.0f;
  s->seed = 0.0f;
  s->octaves = 4;
  s->color = 0.0f;
  s->speed = 0.5f;
  s->static_phase = 0.0f;

  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  state::registerFusionByName(state::FusionKind::StrictOutput,
                              "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  // Advance the animation phase as an accumulator. speed=0 freezes; speed=1 →
  // 30 reroll/s for the discrete modes (smooth modes derive a gentler time).
  s->static_phase += static_cast<float>(dt) * (s->speed * 30.0f);
  // Wrap to keep the value bounded (any large modulus is fine).
  if (s->static_phase > 1.0e6f) s->static_phase -= 1.0e6f;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "algorithm")) s->algorithm = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "scale"))     s->scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "contrast"))  s->contrast = state::patchFloat(i);
    else if (state::pathIs(p, l, "seed"))      s->seed = state::patchFloat(i);
    else if (state::pathIs(p, l, "octaves"))   s->octaves = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "color"))     s->color = state::patchFloat(i);
    else if (state::pathIs(p, l, "speed"))     s->speed = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::textureForField("tex_out");
  if (!output.valid()) return;

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace noise
