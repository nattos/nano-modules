/*
 * source.solid_color — Solid color texture generator.
 *
 * Fills the render target with a uniform RGB color.
 *
 * Parameters:
 *   color (rgb, default mid-grey)
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "solid_color_shaders.h"

namespace solid_color {

struct Uniforms {
  float r, g, b, _pad;
};

static float s_r = 0.5f, s_g = 0.5f, s_b = 0.5f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_r = 0.5f; s_g = 0.5f; s_b = 0.5f;
  s_initialized = false;

  state::init("generator.solid_color", {1, 0, 0},
    state::Schema()
      .rgbField("color", 0.5f, 0.5f, 0.5f, state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto mod = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!mod) return;

  s_pso = gpu::Device::createComputePSO(mod, metal ? "main_" : "main", gpu::Bindings().storageTex2d(0, gpu::TextureFormat::RGBA8).uniform(1));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }

void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "color")) {
      auto v = state::patchVec3(i);
      s_r = v.x; s_g = v.y; s_b = v.z;
    }
  }
}


void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::renderTarget();
  Uniforms u = { s_r, s_g, s_b, 0 };
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(output, 0, 1); // slot 0, write
  cp.setBuffer(s_uniform_buf, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace solid_color
