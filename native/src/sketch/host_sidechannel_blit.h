#pragma once
/*
 * host_sidechannel_blit.h — host-side scaled blit for sidechannel reads.
 *
 * Copies a bus-owned channel texture (any size/format the writer had) into a
 * `util.sidechannel_in` stage's output texture, nearest-scaling on size
 * mismatch. A same-size same-format pair takes the cheap gpu_copy_texture
 * path with no PSO at all; everything else goes through a tiny compute
 * kernel. Structure mirrors host_blend.h's WetDryBlend exactly: two lock-step
 * shader sources (MSL for Metal, WGSL for WebGPU — the executor runs on both
 * backends), a lazily-built PSO, one dispatch encoded into the executor's
 * per-frame command batch (never submitted here).
 *
 * The WGSL storage output is declared rgba8unorm — the same assumption
 * WetDryBlend bakes in, valid because web stage outputs (intermediates + the
 * canvas-facing output) are rgba8. The float read/write path also absorbs a
 * BGRA↔RGBA channel-order difference between the bus texture and the output
 * (native interop textures are BGRA), which a raw byte copy would swap — the
 * copy fast path is therefore gated on format EQUALITY.
 */

#include "sketch/exec_gpu.h"

#include <cstdint>

namespace sketch_executor {

inline constexpr const char* kSidechannelBlitMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;
struct U { uint dw; uint dh; uint sw; uint sh; };
kernel void sidechannel_blit(
    uint2 gid [[thread_position_in_grid]],
    texture2d<float, access::read>  src_tex [[texture(0)]],
    texture2d<float, access::write> out_tex [[texture(1)]],
    constant U& u [[buffer(2)]]) {
  if (gid.x >= u.dw || gid.y >= u.dh) return;
  uint2 sp = uint2(gid.x * u.sw / u.dw, gid.y * u.sh / u.dh);
  out_tex.write(src_tex.read(sp), gid);
}
)MSL";

// WGSL twin of kSidechannelBlitMSL — same math + binding layout (textures
// first, uniform after, per the fused-kernel convention host_blend.h uses).
inline constexpr const char* kSidechannelBlitWGSL = R"WGSL(
struct U { dw: u32, dh: u32, sw: u32, sh: u32 };
@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> u: U;
@compute @workgroup_size(8, 8, 1)
fn sidechannel_blit(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.dw || gid.y >= u.dh) { return; }
  let sp = vec2<i32>(i32(gid.x * u.sw / u.dw), i32(gid.y * u.sh / u.dh));
  textureStore(out_tex, vec2<i32>(i32(gid.x), i32(gid.y)), textureLoad(src_tex, sp, 0));
}
)WGSL";

class SidechannelBlit {
 public:
  ~SidechannelBlit() { releaseAll(); }

  // Encode src (sw×sh) → out (W×H) into the current command batch. Returns
  // false if resources couldn't be created (caller clears `out` instead).
  bool encode(int32_t srcTex, int sw, int sh, int32_t outTex, int W, int H) {
    if (srcTex < 0 || outTex < 0 || sw <= 0 || sh <= 0 || W <= 0 || H <= 0) {
      return false;
    }
    // Fast path: identical size AND format → plain texture copy (the compute
    // path is still needed for mismatches; a byte copy across BGRA/RGBA would
    // swap channels, hence the format equality gate).
    if (sw == W && sh == H &&
        gpu_get_texture_format(srcTex) == gpu_get_texture_format(outTex)) {
      gpu_copy_texture(srcTex, outTex);
      return true;
    }
    if (!ensure()) return false;
    struct U { uint32_t dw, dh, sw, sh; } u{
        (uint32_t)W, (uint32_t)H, (uint32_t)sw, (uint32_t)sh};
    gpu_write_buffer(uni_, 0, reinterpret_cast<const void*>(&u), (int32_t)sizeof(u));
    int32_t pass = gpu_begin_compute_pass();
    gpu_compute_set_pso(pass, pso_);
    gpu_compute_set_buffer(pass, uni_, 0, /*slot*/ 2);
    gpu_compute_set_texture(pass, srcTex, 0, /*read*/ 0);
    gpu_compute_set_texture(pass, outTex, 1, /*write*/ 1);
    gpu_compute_dispatch(pass, (W + 7) / 8, (H + 7) / 8, 1);
    gpu_end_compute_pass(pass);
    return true;
  }

 private:
  bool ensure() {
    if (pso_ < 0) {
      // 1 = gpu::Backend::WebGPU → WGSL; anything else (Metal) → MSL.
      const char* src = (gpu_get_backend() == 1) ? kSidechannelBlitWGSL
                                                 : kSidechannelBlitMSL;
      shader_ = gpu_create_shader_module(src, (int32_t)__builtin_strlen(src));
      if (shader_ < 0) return false;
      pso_ = gpu_create_compute_pso(shader_, "sidechannel_blit",
                                    (int32_t)__builtin_strlen("sidechannel_blit"));
      if (pso_ < 0) return false;
    }
    // usage 2 = gpu::BufferUsage::Uniform (WebGPU var<uniform>; Metal ignores).
    if (uni_ < 0) uni_ = gpu_create_buffer(16, /*Uniform*/ 2);
    return pso_ >= 0 && uni_ >= 0;
  }

  void releaseAll() {
    if (pso_ >= 0)    gpu_release(pso_);
    if (shader_ >= 0) gpu_release(shader_);
    if (uni_ >= 0)    gpu_release(uni_);
    pso_ = shader_ = uni_ = -1;
  }

  int32_t shader_ = -1, pso_ = -1, uni_ = -1;
};

}  // namespace sketch_executor
