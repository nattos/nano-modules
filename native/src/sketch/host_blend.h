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
 * The executor runs as executor.wasm on BOTH backends, so the blend ships in
 * two languages and picks one from gpu_get_backend() at PSO-build time: MSL on
 * Metal (native), WGSL on WebGPU (web). `gpu_create_shader_module` compiles the
 * source verbatim in the host's native language, so a single hardcoded language
 * fails on the other backend (feeding MSL to WebGPU traps with "invalid
 * character #include <metal_stdlib>", which broke partial opacity on web). The
 * two sources are kept in LOCK-STEP: both `mix(dry, fx, opacity)` over the full
 * RGBA. Bindings: dry = texture 0, fx = texture 1, out = texture 2 (write),
 * uniform = slot 3 — textures first, then the uniform, matching the fused-kernel
 * convention so WebGPU's auto-layout (one binding namespace per group) has no
 * texture/buffer @binding collision.
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
    constant U& u [[buffer(3)]]) {
  if (gid.x >= u.w || gid.y >= u.h) return;
  float4 a = dry_tex.read(gid);
  float4 b = fx_tex.read(gid);
  out_tex.write(mix(a, b, u.opacity), gid);
}
)MSL";

// WGSL twin of kWetDryBlendMSL (WebGPU). Same math + binding layout: read
// textures at @binding 0/1, an rgba8unorm write storage texture at @binding 2,
// and the uniform at @binding 3 (after the textures — no auto-layout collision).
inline constexpr const char* kWetDryBlendWGSL = R"WGSL(
struct U { w: u32, h: u32, opacity: f32, pad: f32 };
@group(0) @binding(0) var dry_tex: texture_2d<f32>;
@group(0) @binding(1) var fx_tex:  texture_2d<f32>;
@group(0) @binding(2) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> u: U;
@compute @workgroup_size(8, 8, 1)
fn wet_dry_blend(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.w || gid.y >= u.h) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let a = textureLoad(dry_tex, p, 0);
  let b = textureLoad(fx_tex,  p, 0);
  textureStore(out_tex, p, mix(a, b, u.opacity));
}
)WGSL";

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
    gpu_compute_set_buffer(pass, uni_, 0, /*slot*/ 3);
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
      // 1 = gpu::Backend::WebGPU → WGSL; anything else (Metal) → MSL.
      const char* src = (gpu_get_backend() == 1) ? kWetDryBlendWGSL : kWetDryBlendMSL;
      shader_ = gpu_create_shader_module(src, (int32_t)__builtin_strlen(src));
      if (shader_ < 0) return false;
      pso_ = gpu_create_compute_pso(shader_, "wet_dry_blend",
                                    (int32_t)__builtin_strlen("wet_dry_blend"));
      if (pso_ < 0) return false;
    }
    // usage 2 = gpu::BufferUsage::Uniform — required for the WebGPU
    // var<uniform> binding (Metal ignores buffer usage flags).
    if (uni_ < 0) uni_ = gpu_create_buffer(16, /*Uniform*/ 2);
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
