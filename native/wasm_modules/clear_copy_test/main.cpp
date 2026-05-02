/*
 * debug.clear_copy_test — Verifies texture clear + texture-to-texture copy.
 *
 *   1. Allocate a scratch texture (rgba8unorm, same size as output).
 *   2. gpu::Device::clear(scratch, R, G, B, A) — fills it with a constant.
 *   3. gpu::Device::copy(scratch, output) — verbatim byte copy.
 *
 * If clear works, the scratch holds the constant. If copy works, the
 * output holds the same constant. The test asserts a uniform output
 * matching the constant — a regression in either path collapses the
 * pixel value to whatever the texture was previously holding.
 *
 * Constant is hard-coded to (0.5, 0.0, 1.0, 1.0) ≈ (128, 0, 255, 255).
 */

#include <gpu.h>
#include <host.h>

namespace clear_copy_test {

static gpu::Texture s_scratch;
static int s_scratch_w = 0;
static int s_scratch_h = 0;
static bool s_initialized = false;

void init() {
  s_initialized = false;

  state::init("debug.clear_copy_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  s_initialized = true;
  state::log("clear_copy_test: initialized");
}

void tick(double) {}
void on_param_change(int, double) {}
void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int w, int h) {
  if (!s_initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  if (!s_scratch.valid() || s_scratch_w != w || s_scratch_h != h) {
    s_scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s_scratch_w = w;
    s_scratch_h = h;
  }
  if (!s_scratch.valid()) return;

  gpu::Device::clear(s_scratch, 0.5f, 0.0f, 1.0f, 1.0f);
  gpu::Device::copy(s_scratch, out);
  gpu::Device::submit();
}

} // namespace clear_copy_test
