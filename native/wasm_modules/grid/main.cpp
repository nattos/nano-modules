/*
 * generator.grid — Procedural grid pattern.
 *
 * Standard params:
 *   cell_size   [0, 1]   cell side length, in cover-square units (0.05..0.5).
 *   line_width  [0, 1]   line thickness as a fraction of cell side.
 *   softness    [0, 1]   smooth edge between line and fill.
 *
 * Tuning params:
 *   offset_x, offset_y   cover-square shift.
 *   line_r/g/b/a         line colour. Default white opaque.
 *   bg_r/g/b/a           cell fill. Default transparent black.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "grid_shaders.h"

namespace grid {

struct FuseUniforms {
  float cell_size;
  float line_width;
  float softness;
  float offset_x;
  float offset_y;
  float aspect_x;
  float aspect_y;
  float line_r;
  float line_g, line_b, line_a;
  float bg_r;
  float bg_g, bg_b, bg_a;
  float _pad;
};

// Per-instance state. One per chain entry.
struct State {
  float cell = 0.1f;
  float line_width = 0.04f;
  float softness = 0.1f;
  float off_x = 0.0f;
  float off_y = 0.0f;
  float line[4] = { 1.0f, 1.0f, 1.0f, 1.0f };
  float bg[4]   = { 0.0f, 0.0f, 0.0f, 0.0f };
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
  u.cell_size = 0.02f + s->cell * 0.48f;
  u.line_width = s->line_width;
  u.softness = s->softness;
  u.offset_x = s->off_x;
  u.offset_y = s->off_y;
  u.aspect_x = ax;
  u.aspect_y = ay;
  u.line_r = s->line[0]; u.line_g = s->line[1]; u.line_b = s->line[2]; u.line_a = s->line[3];
  u.bg_r   = s->bg[0];   u.bg_g   = s->bg[1];   u.bg_b   = s->bg[2];   u.bg_a   = s->bg[3];
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("generator.grid", {1, 0, 0},
    state::Schema()
      .floatField("cell_size",  0.1f,  0.f, 1.f, state::PrimaryInput)
      .floatField("line_width", 0.04f, 0.f, 1.f, state::PrimaryInput)
      .floatField("softness",   0.1f,  0.f, 1.f, state::PrimaryInput)
      .vec2Field("offset", 0.0f, 0.0f, state::SecondaryInput, -1.f, 1.f)
      .rgbaField("line", 1.0f, 1.0f, 1.0f, 1.0f, state::SecondaryInput)
      .rgbaField("bg",   0.0f, 0.0f, 0.0f, 0.0f, state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  // Strict-output: bind at slots 1+2 (slot 0 unused) so the
  // fragment's register(b2) maps cleanly when fused.
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
  s->cell = 0.1f;
  s->line_width = 0.04f;
  s->softness = 0.1f;
  s->off_x = 0.0f; s->off_y = 0.0f;
  s->line[0] = s->line[1] = s->line[2] = s->line[3] = 1.0f;
  s->bg[0] = s->bg[1] = s->bg[2] = s->bg[3] = 0.0f;
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
    if      (state::pathIs(p, l, "cell_size"))  s->cell = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_width")) s->line_width = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness"))   s->softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "offset")) {
      auto v = state::patchVec2(i); s->off_x = v.x; s->off_y = v.y;
    }
    else if (state::pathIs(p, l, "line")) {
      auto v = state::patchVec4(i);
      s->line[0] = v.x; s->line[1] = v.y; s->line[2] = v.z; s->line[3] = v.w;
    }
    else if (state::pathIs(p, l, "bg")) {
      auto v = state::patchVec4(i);
      s->bg[0] = v.x; s->bg[1] = v.y; s->bg[2] = v.z; s->bg[3] = v.w;
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
  cp.setTexture(output, 1, 1);   // slot 1 (strict-output: slot 0 unused)
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace grid
