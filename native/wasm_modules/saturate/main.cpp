/*
 * video.saturate — Per-channel tanh waveshaper that scales from
 * black.
 *
 *   y = x * prescale                          (scales from 0; prescale=0 → pure black)
 *   y <= deadzone   → out = y                 (linear pass)
 *   y >  deadzone   → out = dz + (1 - dz) * tanh((y - dz) / (1 - dz) * 2^asymm)
 *
 * `prescale` is the only multiplier on the input. `linear_deadzone`
 * carves out a flat pass-through region from 0 up to dz so darks /
 * mids stay untouched, with the tanh kicking in only above. `asymm`
 * shapes the tanh shoulder (positive → sharper limit; negative →
 * gentler / more linear past the deadzone). Alpha is untouched.
 *
 * Slopes are continuous at the deadzone boundary so there's no
 * visible knee artifact when sweeping `linear_deadzone`.
 */

#include <gpu.h>
#include <host.h>
#include "saturate_shaders.h"

namespace saturate {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl. Field order
// and sizes are part of the cbuffer ABI; pixel.hlsl is the single
// source of truth for the per-pixel kernel and this struct mirrors
// its uniform block.
struct FuseUniforms {
  float prescale;
  float asymm;
  float linear_deadzone;
  float _pad;
};

static float s_prescale = 1.0f;
static float s_asymm    = 0.0f;
static float s_deadzone = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

// Update the uniform buffer for the current frame. Called from
// render() (standalone path) and from the engine via the fusion
// prepare callback (fused path) — both share the same uniform write
// so output is identical.
void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s_prescale, s_asymm, s_deadzone, 0.f };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_prescale = 1.0f;
  s_asymm    = 0.0f;
  s_deadzone = 0.0f;
  s_initialized = false;

  state::init("video.saturate", {1, 0, 0},
    state::Schema()
      .floatField("prescale",        1.0f, 0.f, 4.f, state::PrimaryInput)
      .floatField("asymm",           0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("linear_deadzone", 0.0f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Register SPIR-V blobs by name. Host translates SPV → platform
  // shader source (WGSL/MSL) on demand via naga; effects don't carry
  // per-platform text anymore.
  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  // Entry point name is always "main" now — naga's WGSL output
  // preserves it; MSL gets renamed to "main_" by the host on Metal
  // backends if we ever wire that path.
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  // PerPixelMapper fusion: the dispatcher splices fuse_transform
  // from the registered "pixel" SPV into composed shaders. The
  // name-based variant defers SPV → WGSL → strip until the dispatcher
  // first composes a shader that needs it.
  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s_uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(double) {}
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "prescale"))        s_prescale = state::patchFloat(i);
    else if (state::pathIs(p, l, "asymm"))           s_asymm    = state::patchFloat(i);
    else if (state::pathIs(p, l, "linear_deadzone")) s_deadzone = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace saturate
