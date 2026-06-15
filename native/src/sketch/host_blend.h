#pragma once
/*
 * host_blend.h — host-side wet/dry opacity blend.
 *
 * A full-frame compute pass `out = mix(dry, fx, opacity)` used by the sketch
 * executor to composite a per-effect output (`fx`) over the pre-effect image
 * (`dry`, the column input) at a given opacity — Resolume-style. Structure
 * mirrors the text compositor (host_impls_text.cpp): create a shader module +
 * compute PSO once, write a small uniform, encode one dispatch.
 *
 * The MSL math is kept in LOCK-STEP with the web WGSL blend in
 * web/src/sketch-executor.ts (both `mix(dry, fx, opacity)` over the full RGBA),
 * so the simulator reproduces native pixels. Native is Metal-only, so the
 * shader source is MSL.
 */

#include "sketch/exec_gpu.h"

#include <cstdint>

namespace sketch_executor {

// MSL kernel: out = mix(dry, fx, opacity), per pixel, full RGBA. Out-of-range
// reads are gated by the canvas dims in the uniform.
inline constexpr const char* kWetDryBlendMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;
struct U { uint w; uint h; float opacity; float _pad; };
kernel void wet_dry_blend(
    uint2 gid [[thread_position_in_grid]],
    texture2d<float, access::read>  dry_tex [[texture(0)]],
    texture2d<float, access::read>  fx_tex  [[texture(1)]],
    texture2d<float, access::write> out_tex [[texture(2)]],
    constant U& u [[buffer(0)]]) {
  if (gid.x >= u.w || gid.y >= u.h) return;
  float4 a = dry_tex.read(gid);
  float4 b = fx_tex.read(gid);
  out_tex.write(mix(a, b, u.opacity), gid);
}
)MSL";

class WetDryBlend {
 public:
  ~WetDryBlend() { releaseAll(); }

  // Encode the blend into the current command buffer (NOT submitted — the
  // executor submits once per frame), via the gpu ABI. `dryTex` is the
  // pre-effect image; pass <0 to fade against transparent black. Returns false
  // if resources couldn't be created (caller should fall back to using `fxTex`).
  bool encode(int32_t dryTex, int32_t fxTex,
              int32_t outTex, float opacity, int W, int H) {
    if (outTex < 0 || fxTex < 0 || W <= 0 || H <= 0) return false;
    if (!ensure()) return false;
    const int32_t dry = dryTex >= 0 ? dryTex : blackTex(W, H);
    if (dry < 0) return false;
    struct U { uint32_t w, h; float opacity, pad; } u{
        (uint32_t)W, (uint32_t)H, opacity, 0.0f};
    gpu_write_buffer(uni_, 0, reinterpret_cast<const void*>(&u), (int32_t)sizeof(u));
    int32_t pass = gpu_begin_compute_pass();
    gpu_compute_set_pso(pass, pso_);
    gpu_compute_set_buffer(pass, uni_, 0, 0);
    gpu_compute_set_texture(pass, dry,    0, /*read*/ 0);
    gpu_compute_set_texture(pass, fxTex,  1, /*read*/ 0);
    gpu_compute_set_texture(pass, outTex, 2, /*write*/ 1);
    gpu_compute_dispatch(pass, (W + 7) / 8, (H + 7) / 8, 1);
    gpu_end_compute_pass(pass);
    return true;
  }

 private:
  static constexpr int kFmtRGBA8 = 1;  // gpu.h format code

  bool ensure() {
    if (pso_ < 0) {
      shader_ = gpu_create_shader_module(kWetDryBlendMSL,
                                         (int32_t)__builtin_strlen(kWetDryBlendMSL));
      if (shader_ < 0) return false;
      pso_ = gpu_create_compute_pso(shader_, "wet_dry_blend",
                                    (int32_t)__builtin_strlen("wet_dry_blend"));
      if (pso_ < 0) return false;
    }
    if (uni_ < 0) uni_ = gpu_create_buffer(16, 0);
    return pso_ >= 0 && uni_ >= 0;
  }

  // A persistent W×H transparent-black texture used as the "dry" side when no
  // input is connected (generator fade-out). Recreated on size change.
  int32_t blackTex(int W, int H) {
    if (black_ < 0 || blackW_ != W || blackH_ != H) {
      if (black_ >= 0) gpu_release(black_);
      black_ = gpu_create_texture(W, H, kFmtRGBA8);
      blackW_ = W; blackH_ = H;
      if (black_ >= 0) gpu_clear_texture(black_, 0.0f, 0.0f, 0.0f, 0.0f);
    }
    return black_;
  }

  void releaseAll() {
    if (pso_ >= 0)    gpu_release(pso_);
    if (shader_ >= 0) gpu_release(shader_);
    if (uni_ >= 0)    gpu_release(uni_);
    if (black_ >= 0)  gpu_release(black_);
    pso_ = shader_ = uni_ = black_ = -1;
    blackW_ = blackH_ = 0;
  }

  int32_t shader_ = -1, pso_ = -1, uni_ = -1, black_ = -1;
  int blackW_ = 0, blackH_ = 0;
};

}  // namespace sketch_executor
