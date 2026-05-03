/*
 * video.fast_blur — Thin wrapper around `fx::FastBlur`.
 *
 * The actual blur machinery lives in `<effect_fast_blur.h>` so it can
 * be reused by future effects (bloom, glow, depth-of-field, energy
 * diffusion, anything wanting a wide soft blur cheap). This file just
 * owns the schema, plumbs the iterations param, and delegates.
 */

#include <gpu.h>
#include <host.h>
#include <effect_fast_blur.h>

namespace fast_blur {

static fx::FastBlur s_blur;
static int s_iterations = 4;

void init() {
  s_iterations = 4;

  state::init("video.fast_blur", {1, 0, 0},
    state::Schema()
      .intField("iterations", 4, 1, fx::FastBlur::MAX_ITERATIONS, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  s_blur.init();
}

void tick(double) {}
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "iterations")) {
      s_iterations = (int)state::patchFloat(i);
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_blur.valid() || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  s_blur.apply(in, out, vp_w, vp_h, s_iterations);
  gpu::Device::submit();
}

} // namespace fast_blur
