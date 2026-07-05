#pragma once
/*
 * host_output_blit.h — host-side resample + format-convert blit for the
 * per-sketch output-format override.
 *
 * When a sketch renders at an internal resolution/format different from the
 * host output (outputFormat.resolution / .bitDepth), the executor runs the
 * whole chain at internal size and this pass stretches the result to fill
 * the caller's output texture (bilinear, aspect-ignoring by design — the
 * override is a quality/perf knob, the output always fills the host surface)
 * while converting the format (e.g. rgba16float → the 8-bit output).
 *
 * Structure mirrors host_sidechannel_blit.h: lock-step MSL/WGSL sources, a
 * lazily built PSO, one dispatch encoded into the executor's per-frame
 * command batch. Bilinear is done with 4 manual textureLoad taps (the exec
 * ABI has no sampler imports, and manual taps keep the two sources
 * byte-equivalent in behavior). Same-size same-format pairs take the
 * gpu_copy_texture fast path.
 *
 * The WGSL storage output is templated per concrete output format via
 * host_wgsl_fmt.h (one PSO per format code on WebGPU; Metal's MSL is
 * format-agnostic and keeps a single PSO).
 */

#include "sketch/exec_gpu.h"
#include "sketch/host_wgsl_fmt.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sketch_executor {

inline constexpr const char* kOutputBlitMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;
struct U { uint dw; uint dh; uint sw; uint sh; };
kernel void output_blit(
    uint2 gid [[thread_position_in_grid]],
    texture2d<float, access::read>  src_tex [[texture(0)]],
    texture2d<float, access::write> out_tex [[texture(1)]],
    constant U& u [[buffer(2)]]) {
  if (gid.x >= u.dw || gid.y >= u.dh) return;
  float2 srcPos = (float2(gid) + 0.5f) * float2(u.sw, u.sh) / float2(u.dw, u.dh) - 0.5f;
  float2 f = fract(srcPos);
  int2 p0 = int2(floor(srcPos));
  int2 p1 = min(p0 + 1, int2(u.sw - 1, u.sh - 1));
  p0 = max(p0, int2(0));
  float4 c00 = src_tex.read(uint2(p0));
  float4 c10 = src_tex.read(uint2(p1.x, p0.y));
  float4 c01 = src_tex.read(uint2(p0.x, p1.y));
  float4 c11 = src_tex.read(uint2(p1));
  float4 c = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  out_tex.write(c, gid);
}
)MSL";

// WGSL twin of kOutputBlitMSL — same math + binding layout.
inline constexpr const char* kOutputBlitWGSL = R"WGSL(
struct U { dw: u32, dh: u32, sw: u32, sh: u32 };
@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> u: U;
@compute @workgroup_size(8, 8, 1)
fn output_blit(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.dw || gid.y >= u.dh) { return; }
  let srcPos = (vec2<f32>(f32(gid.x), f32(gid.y)) + 0.5) *
      vec2<f32>(f32(u.sw), f32(u.sh)) / vec2<f32>(f32(u.dw), f32(u.dh)) - 0.5;
  let f = fract(srcPos);
  var p0 = vec2<i32>(floor(srcPos));
  let p1 = min(p0 + 1, vec2<i32>(i32(u.sw) - 1, i32(u.sh) - 1));
  p0 = max(p0, vec2<i32>(0));
  let c00 = textureLoad(src_tex, p0, 0);
  let c10 = textureLoad(src_tex, vec2<i32>(p1.x, p0.y), 0);
  let c01 = textureLoad(src_tex, vec2<i32>(p0.x, p1.y), 0);
  let c11 = textureLoad(src_tex, p1, 0);
  let c = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  textureStore(out_tex, vec2<i32>(i32(gid.x), i32(gid.y)), c);
}
)WGSL";

class OutputBlit {
 public:
  ~OutputBlit() { releaseAll(); }

  // Rewind the per-encode uniform cursor — call once per frame, before any
  // encode(). Same hazard as WetDryBlend::beginFrame (one command buffer per
  // frame; gpu_write_buffer writes immediately).
  void beginFrame() { uniCursor_ = 0; }

  // Encode src (sw×sh) stretched into out (dw×dh) in the current command
  // batch. Returns false if resources couldn't be created.
  bool encode(int32_t srcTex, int sw, int sh, int32_t outTex, int dw, int dh) {
    if (srcTex < 0 || outTex < 0 || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) {
      return false;
    }
    // Identical size AND format → plain copy (cross-format copies would
    // reinterpret bytes; cross-size needs the kernel).
    if (sw == dw && sh == dh &&
        gpu_get_texture_format(srcTex) == gpu_get_texture_format(outTex)) {
      gpu_copy_texture(srcTex, outTex);
      return true;
    }
    const int32_t pso = ensurePso(outTex);
    if (pso < 0) return false;
    const int32_t uni = nextUniform();
    if (uni < 0) return false;
    struct U { uint32_t dw, dh, sw, sh; } u{
        (uint32_t)dw, (uint32_t)dh, (uint32_t)sw, (uint32_t)sh};
    gpu_write_buffer(uni, 0, reinterpret_cast<const void*>(&u), (int32_t)sizeof(u));
    int32_t pass = gpu_begin_compute_pass();
    gpu_compute_set_pso(pass, pso);
    gpu_compute_set_buffer(pass, uni, 0, /*slot*/ 2);
    gpu_compute_set_texture(pass, srcTex, 0, /*read*/ 0);
    gpu_compute_set_texture(pass, outTex, 1, /*write*/ 1);
    gpu_compute_dispatch(pass, (dw + 7) / 8, (dh + 7) / 8, 1);
    gpu_end_compute_pass(pass);
    return true;
  }

 private:
  struct PsoEntry { int32_t fmtKey; int32_t shader; int32_t pso; };

  // One PSO per WGSL storage format on WebGPU; a single format-agnostic PSO
  // (key 0) on Metal.
  int32_t ensurePso(int32_t outTex) {
    const bool web = (gpu_get_backend() == 1);
    int32_t key = 0;
    if (web) {
      key = gpu_get_texture_format(outTex);
      if (key < 0) key = 1;
    }
    for (const auto& e : psos_) {
      if (e.fmtKey == key) return e.pso;
    }
    const std::string src = web ? wgslWithStorageFormat(kOutputBlitWGSL, key)
                                : std::string(kOutputBlitMSL);
    int32_t shader = gpu_create_shader_module(src.c_str(), (int32_t)src.size());
    if (shader < 0) return -1;
    int32_t pso = gpu_create_compute_pso(shader, "output_blit",
                                         (int32_t)__builtin_strlen("output_blit"));
    if (pso < 0) { gpu_release(shader); return -1; }
    psos_.push_back({key, shader, pso});
    return pso;
  }

  int32_t nextUniform() {
    if (uniCursor_ >= (int)uniforms_.size()) {
      int32_t b = gpu_create_buffer(16, /*Uniform*/ 2);
      if (b < 0) return -1;
      uniforms_.push_back(b);
    }
    return uniforms_[uniCursor_++];
  }

  void releaseAll() {
    for (const auto& e : psos_) {
      if (e.pso >= 0)    gpu_release(e.pso);
      if (e.shader >= 0) gpu_release(e.shader);
    }
    psos_.clear();
    for (int32_t b : uniforms_) { if (b >= 0) gpu_release(b); }
    uniforms_.clear();
    uniCursor_ = 0;
  }

  std::vector<PsoEntry> psos_;
  std::vector<int32_t> uniforms_;
  int uniCursor_ = 0;
};

}  // namespace sketch_executor
