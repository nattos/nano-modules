/*
 * debug.motion_rect — Test producer for the canonical RenderOutputs rail.
 *
 * Overlays a moving colored rectangle on its input texture (color pass)
 * and writes per-pixel velocity vectors into an rgba16float side texture
 * (motion pass), publishing the side texture as `render_outputs/motion`
 * so downstream consumers (e.g. video.motion_blur) can pick it up via
 * the auto-binding struct rail mechanism.
 *
 * Pixels inside the rect carry velocity = (cx - cx_prev, cy - cy_prev)
 * in uv-space (so [-1, 1] worst case). Pixels outside the rect carry
 * zero velocity. Tests asserting the chain end-to-end can rely on
 * "blurred inside the rect's swept band, untouched elsewhere."
 */

#include <gpu.h>
#include <host.h>
#include "motion_rect_shaders.h"

#include <cmath>

namespace motion_rect {

struct Uniforms {
  float cx;
  float cy;
  float cx_prev;
  float cy_prev;
  float half_w;
  float half_h;
  float color_r;
  float color_g;
  float color_b;
  float _pad0;
  float _pad1;
  float _pad2;
};

static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_uniform_buf;
static gpu::Texture    s_motion_tex;
static int  s_motion_w = 0;
static int  s_motion_h = 0;
static bool s_initialized = false;

// Animation state (CPU-side). cx/cy are normalized to uv space [0, 1].
static float s_size = 0.2f;
static float s_speed = 1.0f;
static float s_color_r = 1.0f;
static float s_color_g = 0.4f;
static float s_color_b = 0.8f;

static double s_t = 0.0;
static float s_cx = 0.5f;
static float s_cy = 0.5f;
static float s_cx_prev = 0.5f;
static float s_cy_prev = 0.5f;
static bool  s_have_prev = false;

void init() {
  s_initialized = false;
  s_t = 0.0;
  s_cx = 0.5f; s_cy = 0.5f;
  s_cx_prev = 0.5f; s_cy_prev = 0.5f;
  s_have_prev = false;

  state::init("debug.motion_rect", {1, 0, 0},
    state::Schema()
      .floatField("size",  0.2f, 0.02f, 0.5f, state::PrimaryInput)
      .floatField("speed", 1.0f, 0.0f,  5.0f, state::PrimaryInput)
      .rgbField("color",   1.0f, 0.4f,  0.8f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Two compute shaders, two storage formats. The format hint is
  // per-shader because naga's WGSL pass substitutes a single
  // `texture_storage_2d<...>` declaration.
  state::registerShaderSPV("motion_rect_color",  COLOR_SPV,  COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_rect_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_rect_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_rect_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)
      .uniform(1));

  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("motion_rect: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;
  s_t += dt;
  s_cx_prev = s_cx;
  s_cy_prev = s_cy;
  // Lissajous figure inside the unit square, biased to keep the rect
  // fully on-screen at default size. Phase is independent on each axis
  // so velocity rotates through every direction.
  float w = float(s_t) * s_speed;
  s_cx = 0.5f + 0.35f * std::sin(w * 1.3f);
  s_cy = 0.5f + 0.35f * std::sin(w * 0.9f + 0.7f);
  if (!s_have_prev) {
    s_cx_prev = s_cx;
    s_cy_prev = s_cy;
    s_have_prev = true;
  }
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "size")) {
      s_size = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "speed")) {
      s_speed = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "color")) {
      auto v = state::patchVec3(i);
      s_color_r = v.x; s_color_g = v.y; s_color_b = v.z;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // (Re)allocate the motion texture to match the current viewport. The
  // handle is published once per allocation; readers receive it via the
  // canonical `render_outputs` struct rail and the host's textureFields
  // map at "render_outputs/motion".
  if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
    s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    s_motion_w = vp_w;
    s_motion_h = vp_h;
    if (s_motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
    }
  }
  if (!s_motion_tex.valid()) return;

  Uniforms u = {
    s_cx, s_cy,
    s_cx_prev, s_cy_prev,
    s_size * 0.5f, s_size * 0.5f,
    s_color_r, s_color_g, s_color_b,
    0.f, 0.f, 0.f,
  };
  s_uniform_buf.writeOne(u);

  // Pass 1 — color: tex_in → tex_out with rect overlay.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }
  // Pass 2 — motion: write velocity inside rect, zero outside.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(s_motion_tex, 0, 1);
    cp.setBuffer(s_uniform_buf, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_rect
