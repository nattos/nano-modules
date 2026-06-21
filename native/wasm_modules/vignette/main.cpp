/*
 * filter.vignette — Darken (or brighten) the edges of the frame around an
 * anchor point.
 *
 * Standard params:
 *   amount       [-1, +1]   negative darkens, positive lightens. 0 = no-op.
 *   radius       [0, 1]     normalized distance at which falloff starts.
 *                           0 = falloff begins at the anchor, 1 = at the cover-square edge.
 *   softness     [0, 1]     length of the soft-edge falloff (perceptual curve).
 *
 * Tuning params:
 *   center_x, center_y      cover-square anchor (style guide §1.5).
 *                           [0, 0] = viewport centre, [-1, 0] = left edge of cover square.
 *   shape        [0, 1]     0 = perfect circle (cover-square units),
 *                           1 = stretched to the viewport's aspect (rectangular vignette).
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "vignette_shaders.h"

namespace vignette {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl. Includes
// vp_w/vp_h because the per-pixel mapper signature gives only (gid,
// c) — we route the viewport size through the uniform so
// fuse_transform can still compute cover-square coordinates.
struct FuseUniforms {
  float amount;
  float radius;
  float softness;
  float shape;
  float center_x;
  float center_y;
  float aspect_x;
  float aspect_y;
  float vp_w;
  float vp_h;
  float squash;   // signed [-1,+1]: -1 wider-than-tall, +1 taller-than-wide.
  float _pad1;
};

// Per-instance state. One per chain entry.
struct State {
  float amount = -0.5f;
  float radius = 0.6f;
  float softness = 0.4f;
  float shape = 0.0f;
  float center_x = 0.0f;
  float center_y = 0.0f;
  float squash = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  FuseUniforms u = {
    s->amount, s->radius, s->softness, s->shape,
    s->center_x, s->center_y,
    ax, ay,
    static_cast<float>(vp_w), static_cast<float>(vp_h),
    s->squash, 0.f,
  };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("filter.vignette", {1, 0, 0},
    state::Schema()
      .floatField("amount",   -0.5f, -1.f, 1.f, state::PrimaryInput)
      .floatField("radius",    0.6f,  0.f, 1.f, state::PrimaryInput)
      .floatField("softness",  0.4f,  0.f, 1.f, state::PrimaryInput)
      .vec2Field("center", 0.0f, 0.0f, state::SecondaryInput, -1.f, 1.f)
      .floatField("shape",     0.0f,  0.f, 1.f, state::SecondaryInput)
      .floatField("squash",    0.0f, -1.f, 1.f, state::SecondaryInput)
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
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
  s->amount = -0.5f;
  s->radius = 0.6f;
  s->softness = 0.4f;
  s->shape = 0.0f;
  s->center_x = 0.0f;
  s->center_y = 0.0f;
  s->squash = 0.0f;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "amount"))   s->amount   = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius"))   s->radius   = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness")) s->softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "shape"))    s->shape    = state::patchFloat(i);
    else if (state::pathIs(p, l, "squash"))   s->squash   = state::patchFloat(i);
    else if (state::pathIs(p, l, "center")) {
      auto v = state::patchVec2(i); s->center_x = v.x; s->center_y = v.y;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace vignette
