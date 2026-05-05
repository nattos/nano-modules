/*
 * video.motion_blur — Per-pixel motion blur from a RenderOutputs rail.
 *
 * Consumes the canonical `render_outputs` struct rail (see
 * state::Schema::renderOutputs); reads the optional `motion` texture
 * and samples `tex_in` along the trail to produce a directional blur.
 * If no upstream effect produces motion, the consumer falls back to a
 * straight `tex_in → tex_out` copy and the chain renders unchanged.
 *
 * The schema field `render_outputs` is declared with the canonical
 * helper so that `isRailCompatible` matches any producer using the
 * same helper — auto-binding is handled by the IDE pin-click flow,
 * with no per-effect plumbing required.
 */

#include <gpu.h>
#include <host.h>
#include "motion_blur_shaders.h"

namespace motion_blur {

struct Uniforms {
  float strength;
  int   samples;
  float _pad0;
  float _pad1;
};

static gpu::ComputePSO s_pso;
static gpu::Buffer     s_uniform_buf;

// Pass-through fallback. When no upstream produces a motion texture
// we bind this all-zero rgba16float surface so the shader's velocity
// resolves to (0, 0) at every pixel, naturally collapsing the
// sample-along-velocity kernel into a copy of `tex_in`. The texture
// is reallocated whenever the viewport size changes; cleared once on
// allocation since the contents never change.
static gpu::Texture s_zero_motion;
static int  s_zero_w = 0;
static int  s_zero_h = 0;

static float s_strength = 1.0f;
static int   s_samples  = 8;
static bool  s_initialized = false;

void init() {
  s_strength = 1.0f;
  s_samples  = 8;
  s_initialized = false;

  state::init("video.motion_blur", {1, 0, 0},
    state::Schema()
      .floatField("strength", 1.0f, 0.f, 4.f, state::PrimaryInput)
      .intField("samples",    8,    1,   16,  state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryInput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  auto cs_mod = gpu::Device::createShaderModuleByName("compute");
  if (!cs_mod) return;

  s_pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings()
      .tex2d(0)
      .tex2d(1)
      .storageTex2d(2, gpu::TextureFormat::RGBA8)
      .uniform(3));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("motion_blur: initialized");
}

void tick(double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "strength")) {
      s_strength = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "samples")) {
      s_samples = (int)state::patchFloat(i);
      if (s_samples < 1) s_samples = 1;
      if (s_samples > 16) s_samples = 16;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in     = gpu::Device::textureForField("tex_in");
  auto out    = gpu::Device::textureForField("tex_out");
  auto motion = gpu::Device::textureForField("render_outputs/motion");
  if (!in.valid() || !out.valid()) return;

  // Pass-through fallback: no upstream produced a motion texture, so
  // bind a viewport-sized all-zero motion surface. With zero velocity
  // at every pixel the shader's gather collapses to `outputTex[gid] =
  // inputTex[gid]` and the chain forwards `tex_in` unchanged. We
  // re-use the same compute shader for both branches because that
  // keeps the binding-layout story dead simple — the chain's
  // intermediate output textures don't carry COPY_DST so a real
  // GPU-side copy isn't an option here.
  if (!motion.valid()) {
    if (!s_zero_motion.valid() || s_zero_w != vp_w || s_zero_h != vp_h) {
      s_zero_motion = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s_zero_w = vp_w;
      s_zero_h = vp_h;
      if (s_zero_motion.valid()) {
        gpu::Device::clear(s_zero_motion, 0.f, 0.f, 0.f, 0.f);
      }
    }
    if (!s_zero_motion.valid()) return;
    motion = s_zero_motion;
  }

  Uniforms u = { s_strength, s_samples, 0.f, 0.f };
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,     0, 0);
  cp.setTexture(motion, 1, 0);
  cp.setTexture(out,    2, 1);
  cp.setBuffer(s_uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace motion_blur
