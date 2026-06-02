/*
 * generator.gradient — Two-color linear gradient.
 *
 * Standard params:
 *   angle      [-1, +1]  ±180°. 0 = left-to-right.
 *   offset     [-1, +1]  shifts the gradient along its axis (in cover-square units).
 *   softness   [0, 1]    0 = sharp band, 1 = full gradient.
 *
 * Tuning params:
 *   color_a_r/g/b        gradient start colour. Default white.
 *   color_b_r/g/b        gradient end colour. Default black.
 *
 * The gradient runs through the cover-square so it stays consistent across
 * viewport aspect ratios. Generator: ignores the input texture entirely.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "gradient_shaders.h"

#include <cmath>

namespace gradient {

struct FuseUniforms {
  float dir_x, dir_y;
  float offset;
  float softness;
  float color_a_r, color_a_g, color_a_b;
  float color_b_r;
  float color_b_g, color_b_b;
  float aspect_x, aspect_y;
};

// Per-instance state. One per chain entry.
struct State {
  float angle = 0.0f;
  float offset = 0.0f;
  float softness = 1.0f;
  float color_a[3] = { 1.0f, 1.0f, 1.0f };
  float color_b[3] = { 0.0f, 0.0f, 0.0f };
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  float angle = s->angle * 3.14159265358979323846f;
  FuseUniforms u = {};
  u.dir_x = std::cos(angle);
  u.dir_y = std::sin(angle);
  u.offset = s->offset;
  u.softness = s->softness;
  u.color_a_r = s->color_a[0]; u.color_a_g = s->color_a[1]; u.color_a_b = s->color_a[2];
  u.color_b_r = s->color_b[0]; u.color_b_g = s->color_b[1]; u.color_b_b = s->color_b[2];
  u.aspect_x = ax; u.aspect_y = ay;
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("generator.gradient", {1, 0, 0},
    state::Schema()
      .floatField("angle",    0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("offset",   0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("softness", 1.0f,  0.f, 1.f, state::PrimaryInput)
      .rgbField("color_a", 1.0f, 1.0f, 1.0f, state::SecondaryInput)
      .rgbField("color_b", 0.0f, 0.0f, 0.0f, state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
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
  s->angle = 0.0f;
  s->offset = 0.0f;
  s->softness = 1.0f;
  s->color_a[0] = s->color_a[1] = s->color_a[2] = 1.0f;
  s->color_b[0] = s->color_b[1] = s->color_b[2] = 0.0f;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  state::registerFusionByName(state::FusionKind::StrictOutput,
                              "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "angle"))     s->angle = state::patchFloat(i);
    else if (state::pathIs(p, l, "offset"))    s->offset = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness"))  s->softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "color_a")) {
      auto v = state::patchVec3(i); s->color_a[0] = v.x; s->color_a[1] = v.y; s->color_a[2] = v.z;
    }
    else if (state::pathIs(p, l, "color_b")) {
      auto v = state::patchVec3(i); s->color_b[0] = v.x; s->color_b[1] = v.y; s->color_b[2] = v.z;
    }
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

} // namespace gradient
