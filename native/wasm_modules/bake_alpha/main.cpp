/*
 * video.bake_alpha — Composite the input *over* a chosen background
 * colour. Practical use case: "remove alpha" by baking a transparent
 * image onto a solid colour (default opaque black). With a
 * transparent background the input's own alpha is preserved.
 *
 * Parameters:
 *   color (rgba)  — the background. Default opaque black.
 */

#include <gpu.h>
#include <host.h>
#include "bake_alpha_shaders.h"

namespace bake_alpha {

struct Uniforms {
  float r, g, b, a;  // 16 bytes — natural alignment for std140.
};

static float s_color[4] = { 0.0f, 0.0f, 0.0f, 1.0f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_color[0] = 0.0f; s_color[1] = 0.0f; s_color[2] = 0.0f; s_color[3] = 1.0f;
  s_initialized = false;

  state::init("video.bake_alpha", {1, 0, 0},
    state::Schema()
      .rgbaField("color", 0.0f, 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "color")) {
      auto v = state::patchVec4(i);
      s_color[0] = v.x; s_color[1] = v.y; s_color[2] = v.z; s_color[3] = v.w;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  Uniforms u = { s_color[0], s_color[1], s_color[2], s_color[3] };
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace bake_alpha
