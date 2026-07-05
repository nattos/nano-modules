/*
 * debug.lut3d_test — Verifies 3D textures via an identity color LUT.
 *
 *   Pass 1 (init):   fill a 16×16×16 rgba8 LUT with (x/15, y/15, z/15).
 *                    Bound as `texture_storage_3d<rgba8unorm, write>`.
 *   Pass 2 (apply):  for each pixel, sample LUT at coords derived from
 *                    the input rgb (nearest-neighbor textureLoad — no
 *                    sampler needed). Bound as `texture_3d<f32>`.
 *
 * An identity LUT round-trips the input within 1-bin quantization
 * (~17/255 LSB worst case for a 16³ LUT). The test asserts the output
 * matches the input within that tolerance.
 *
 * Both binding patterns (storage 3D write + sampled 3D read) of the same
 * underlying texture cover the platform's basic 3D texture support.
 *
 * Authored as HLSL (init.hlsl + apply.hlsl) → SPV → {MSL native, WGSL web},
 * the same cross-platform pipeline every other effect uses. The LUT cube is
 * semantic 8-bit, so its storage format (rgba8unorm) is supplied at
 * registerShaderSPV time for the init pass; the apply pass writes tex_out and
 * follows the sketch-default working format. Native takes formats from the
 * bound textures.
 *
 * Class-like instance model: module_init() compiles the two shared
 * compute PSOs + publishes the schema once per type; each chain entry
 * gets its own State (the per-instance 3D LUT texture + "lut built"
 * flag) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "lut3d_test_shaders.h"

namespace lut3d_test {

static constexpr int LUT_DIM = 16;

// Per-instance state. One per chain entry. Holds the per-instance 3D LUT
// texture and its "built once" flag.
struct State {
  gpu::Texture lut;
  bool lut_filled = false;
  bool initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso_init;
static gpu::ComputePSO s_pso_apply;

// Type-level setup: schema + the two shared compute PSOs. Runs once per type.
void module_init() {
  state::init("debug.lut3d_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Init writes the semantic-8-bit LUT cube: pin rgba8unorm so the web naga
  // bridge emits texture_storage_3d<rgba8unorm,write>. Apply writes tex_out
  // and follows the sketch-default working format (no format args); native
  // binds formats from the bound textures either way.
  state::registerShaderSPV("lut3d_test_init",  INIT_SPV,  INIT_SPV_SIZE,  "rgba8unorm", "write");
  state::registerShaderSPV("lut3d_test_apply", APPLY_SPV, APPLY_SPV_SIZE);

  auto cs_init  = gpu::Device::createShaderModuleByName("lut3d_test_init");
  auto cs_apply = gpu::Device::createShaderModuleByName("lut3d_test_apply");
  if (!cs_init || !cs_apply) return;

  s_pso_init = gpu::Device::createComputePSO(cs_init, "main", gpu::Bindings()
      .storageTex3d(0, gpu::TextureFormat::RGBA8));
  s_pso_apply = gpu::Device::createComputePSO(cs_apply, "main", gpu::Bindings()
      .tex2d(0)
      .tex3d(1)
      .storageTex2d(2));

  state::log("lut3d_test: module initialized");
}

// Per-instance construction: allocate State + its own 3D LUT texture.
void* create() {
  auto* s = new State();
  s->lut = gpu::Device::createTexture3D(LUT_DIM, LUT_DIM, LUT_DIM, gpu::TextureFormat::RGBA8);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->lut.release();
  delete s;
}

// Per-instance init tail: reset so the LUT rebuilds; guard PSOs valid.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->lut_filled = false;
  if (!s_pso_init.valid() || !s_pso_apply.valid()) return;
  if (!s->lut.valid()) return;
  s->initialized = true;
  state::log("lut3d_test: initialized");
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)n; (void)pb; (void)off; (void)len; (void)ops;
}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized || w <= 0 || h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid() || !s->lut.valid()) return;

  // First-frame LUT init. After that the LUT is constant — re-running it
  // would be wasted work.
  if (!s->lut_filled) {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_init);
    cp.setTexture(s->lut, 0, 1);  // storage write
    cp.dispatch((LUT_DIM + 3) / 4, (LUT_DIM + 3) / 4, (LUT_DIM + 3) / 4);
    cp.end();
    s->lut_filled = true;
  }

  // Apply LUT to the input.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_apply);
    cp.setTexture(in,     0, 0);  // sampled 2D
    cp.setTexture(s->lut, 1, 0);  // sampled 3D
    cp.setTexture(out,    2, 1);  // storage write 2D
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  gpu::Device::submit();
}

} // namespace lut3d_test
