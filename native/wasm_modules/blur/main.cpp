/*
 * video.blur — Thin wrapper around `fx::GaussianBlur`.
 *
 * The actual blur machinery lives in `<effect_blur.h>` so it can be
 * reused by future effects (bloom, glow, depth-of-field, soft shadows,
 * any "less local" operation). This file just owns the schema, plumbs
 * the two playable params, and delegates to the utility.
 */

#include <gpu.h>
#include <host.h>
#include <effect_blur.h>

namespace blur {

static fx::GaussianBlur s_blur;
static float s_radius = 0.25f;
static float s_quality = 1.0f;

void init() {
  s_radius = 0.25f;
  s_quality = 1.0f;

  state::init("video.blur", {1, 0, 0},
    state::Schema()
      .floatField("radius",  0.25f, 0.f, 1.f, state::PrimaryInput)
      .floatField("quality", 1.0f,  0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  s_blur.init();
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "radius"))  s_radius  = state::patchFloat(i);
    else if (state::pathIs(p, l, "quality")) s_quality = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_blur.valid() || vp_w <= 0 || vp_h <= 0) return;
  auto input  = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;
  s_blur.applyWithRadius(input, output, vp_w, vp_h, s_radius, s_quality);
  gpu::Device::submit();
}

} // namespace blur
