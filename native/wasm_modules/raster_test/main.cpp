/*
 * debug.raster_test — the raster paths no other test-only effect reaches.
 *
 *   case 0 (blend): clear tex_out to mid grey, END the pass, then draw over it
 *     in a second pass that LOADS the target (RenderPass::beginLoad) — three
 *     quads in the first three of four columns, one PSO per blend equation
 *     (createInstancedRenderPSO with a BlendMode):
 *       col 0  AlphaOver (1,0,0,0.5)  → (0.75, 0.25, 0.25)
 *       col 1  Additive  (0,0,1,0.5)  → (0.5,  0.5,  1.0 )
 *       col 2  Replace   (0,1,0,0.25) → (0,    1,    0,   0.25)
 *       col 3  untouched grey
 *     The fragment shader discards the right quarter of every quad, so the
 *     grey shows through there — a discard that doesn't happen paints it.
 *
 *   case 1 (indirect): a compute pass writes {6, count, 0, 0} into a buffer
 *     and the draw takes its size from it (RenderPass::drawIndirect). The
 *     quads fill `count` of 8 columns white over black; the CPU never passes
 *     the count to the draw.
 *
 *   cases 2/3 (MRT blends): one draw of the column-1 quad, (0,0,1,0.5), into
 *     TWO grey-loaded attachments whose PSO gives each its own blend
 *     (createInstancedRenderPSOMRT's per-target list):
 *       case 2  {Additive, Replace}  → tex_out (target 0) shows Additive
 *       case 3  {Replace, Additive}  → target 1 is copied to tex_out, so it
 *                                      shows Additive too
 *     Either target ignoring its entry lands on AlphaOver or Replace instead.
 *
 * Layout is by column only, so the result doesn't depend on which way a
 * backend's raster y points.
 */

#include <gpu.h>
#include <host.h>
#include "raster_test_shaders.h"

namespace raster_test {

struct QuadUniforms {
  float rect[4];
  float color[4];
  float columns;
  float discard_from;
  float pad[2];
};

struct ArgsUniforms {
  uint32_t count;
  uint32_t pad[3];
};

struct State {
  int mode = 0;
  int count = 3;
  gpu::Buffer quad[3];
  gpu::Buffer columns_quad;
  gpu::Buffer args;
  gpu::Buffer args_uniforms;
  gpu::Texture scratch;
  int scratch_w = 0, scratch_h = 0;
  bool initialized = false;
};

static gpu::RenderPSO  s_pso_alpha, s_pso_add, s_pso_replace;
static gpu::RenderPSO  s_pso_mrt_add_first, s_pso_mrt_add_second;
static gpu::ComputePSO s_pso_args;

void module_init() {
  state::init("debug.raster_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .intField("case", 0, 0, 3)
      .intField("count", 3, 0, 8)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("raster_test_vs",   VS_SPV,   VS_SPV_SIZE);
  state::registerShaderSPV("raster_test_fs",   FS_SPV,   FS_SPV_SIZE);
  state::registerShaderSPV("raster_test_args", ARGS_SPV, ARGS_SPV_SIZE);
  state::registerShaderSPV("raster_test_fs_mrt", FS_MRT_SPV, FS_MRT_SPV_SIZE);
  auto vs = gpu::Device::createShaderModuleByName("raster_test_vs");
  auto fs = gpu::Device::createShaderModuleByName("raster_test_fs");
  auto cs = gpu::Device::createShaderModuleByName("raster_test_args");
  auto fs_mrt = gpu::Device::createShaderModuleByName("raster_test_fs_mrt");
  if (!vs || !fs || !cs || !fs_mrt) return;

  auto quadBindings = gpu::Bindings().uniform(0);
  s_pso_alpha = gpu::Device::createInstancedRenderPSO(vs, "main", fs, "main",
      gpu::TextureFormat::Surface, quadBindings, gpu::Device::BlendMode::AlphaOver);
  s_pso_add = gpu::Device::createInstancedRenderPSO(vs, "main", fs, "main",
      gpu::TextureFormat::Surface, quadBindings, gpu::Device::BlendMode::Additive);
  s_pso_replace = gpu::Device::createInstancedRenderPSO(vs, "main", fs, "main",
      gpu::TextureFormat::Surface, quadBindings, gpu::Device::BlendMode::Replace);
  s_pso_args = gpu::Device::createComputePSO(cs, "main",
      gpu::Bindings().storageRW(0).uniform(1));
  using BM = gpu::Device::BlendMode;
  const auto surf = gpu::TextureFormat::Surface;
  s_pso_mrt_add_first = gpu::Device::createInstancedRenderPSOMRT(
      vs, "main", fs_mrt, "main", {surf, surf}, quadBindings,
      {BM::Additive, BM::Replace});
  s_pso_mrt_add_second = gpu::Device::createInstancedRenderPSOMRT(
      vs, "main", fs_mrt, "main", {surf, surf}, quadBindings,
      {BM::Replace, BM::Additive});
}

void* create() { return new State(); }

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (auto& b : s->quad) b.release();
  s->columns_quad.release();
  s->args.release();
  s->args_uniforms.release();
  s->scratch.release();
  delete s;
}

static gpu::Buffer quadBuffer(float x0, float x1, const float color[4],
                              float columns) {
  QuadUniforms q = {};
  q.rect[0] = x0; q.rect[1] = 0.0f; q.rect[2] = x1; q.rect[3] = 1.0f;
  for (int i = 0; i < 4; i++) q.color[i] = color[i];
  q.columns = columns;
  q.discard_from = columns > 0.0f ? 2.0f : 0.75f;  // indirect: no discard
  auto b = gpu::Device::createBuffer(sizeof(QuadUniforms), gpu::BufferUsage::Uniform);
  if (b.valid()) b.writeOne(q);
  return b;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_pso_alpha.valid() || !s_pso_add.valid() || !s_pso_replace.valid() ||
      !s_pso_args.valid() || !s_pso_mrt_add_first.valid() ||
      !s_pso_mrt_add_second.valid())
    return;
  const float red[4]   = {1.0f, 0.0f, 0.0f, 0.5f};
  const float blue[4]  = {0.0f, 0.0f, 1.0f, 0.5f};
  const float green[4] = {0.0f, 1.0f, 0.0f, 0.25f};
  const float white[4] = {1.0f, 1.0f, 1.0f, 1.0f};
  s->quad[0] = quadBuffer(0.00f, 0.25f, red, 0.0f);
  s->quad[1] = quadBuffer(0.25f, 0.50f, blue, 0.0f);
  s->quad[2] = quadBuffer(0.50f, 0.75f, green, 0.0f);
  s->columns_quad = quadBuffer(0.0f, 1.0f, white, 8.0f);
  s->args = gpu::Device::createBuffer(sizeof(uint32_t) * 4, gpu::BufferUsage::Storage);
  s->args_uniforms = gpu::Device::createBuffer(sizeof(ArgsUniforms), gpu::BufferUsage::Uniform);
  s->initialized = s->args.valid() && s->args_uniforms.valid();
  if (s->initialized) state::log("raster_test: initialized");
}

void tick(void*, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    if (state::pathIs(p, len[i], "case"))       s->mode  = state::patchInt(i);
    else if (state::pathIs(p, len[i], "count")) s->count = state::patchInt(i);
  }
}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  if (s->mode == 2 || s->mode == 3) {
    if (!s->scratch.valid() || s->scratch_w != w || s->scratch_h != h) {
      s->scratch.release();
      s->scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::Surface);
      s->scratch_w = w;
      s->scratch_h = h;
    }
    if (!s->scratch.valid()) return;
    auto rp = gpu::RenderPass::beginMRT({
        {out, 0.5f, 0.5f, 0.5f, 1.0f, false},
        {s->scratch, 0.5f, 0.5f, 0.5f, 1.0f, false},
    });
    rp.setPSO(s->mode == 2 ? s_pso_mrt_add_first : s_pso_mrt_add_second);
    rp.setBuffer(s->quad[1], 0);
    rp.draw(6, 1);
    rp.end();
    if (s->mode == 3) gpu::Device::copy(s->scratch, out);
  } else if (s->mode == 1) {
    ArgsUniforms a = {};
    a.count = static_cast<uint32_t>(s->count < 0 ? 0 : s->count);
    s->args_uniforms.writeOne(a);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_args);
    cp.setBuffer(s->args, 0);
    cp.setBuffer(s->args_uniforms, 1);
    cp.dispatch(1);
    cp.end();

    auto rp = gpu::RenderPass::begin(out, 0.0f, 0.0f, 0.0f, 1.0f);
    rp.setPSO(s_pso_replace);
    rp.setBuffer(s->columns_quad, 0);
    rp.drawIndirect(s->args);
    rp.end();
  } else {
    // An empty clearing pass, then a separate pass that must LOAD it.
    auto clear = gpu::RenderPass::begin(out, 0.5f, 0.5f, 0.5f, 1.0f);
    clear.end();

    auto rp = gpu::RenderPass::beginLoad(out);
    const gpu::RenderPSO psos[3] = {s_pso_alpha, s_pso_add, s_pso_replace};
    for (int i = 0; i < 3; i++) {
      rp.setPSO(psos[i]);
      rp.setBuffer(s->quad[i], 0);
      rp.draw(6, 1);
    }
    rp.end();
  }
  gpu::Device::submit();
}

}  // namespace raster_test
