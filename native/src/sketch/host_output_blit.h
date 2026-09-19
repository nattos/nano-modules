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
 * Structure mirrors host_sidechannel_blit.h: a lazily built PSO, one dispatch
 * encoded into the executor's per-frame command batch. Bilinear is done with 4
 * manual taps (the exec ABI has no sampler imports). Same-size same-format
 * pairs take the gpu_copy_texture fast path.
 *
 * The kernel is authored ONCE as HLSL (shaders/output_blit.hlsl), baked to
 * SPIR-V at build time and translated by the host per backend — see exec_gpu.h's
 * create_shader_module_spv. The only thing left that varies per backend is how
 * many modules are needed: WGSL bakes the storage format into the declaration,
 * so WebGPU gets one per concrete output format (host_wgsl_fmt.h).
 */

#include "sketch/exec_gpu.h"
#include "sketch/host_wgsl_fmt.h"

#include "exec_output_blit_spv.h"  // OUTPUT_BLIT_SPV — see shaders/build_shaders.sh

#include <cstdint>
#include <vector>

namespace sketch_executor {

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

  // One PSO per storage format where the shader language bakes it (WGSL); a
  // single format-agnostic PSO (key 0) everywhere else.
  int32_t ensurePso(int32_t outTex) {
    int32_t key = 0;
    if (backendBakesStorageFormat(gpu_get_backend())) {
      key = gpu_get_texture_format(outTex);
      if (key < 0) key = 1;
    }
    for (const auto& e : psos_) {
      if (e.fmtKey == key) return e.pso;
    }
    const char* fmt = wgslStorageFormatName(key);
    int32_t shader = gpu_create_shader_module_spv(
        OUTPUT_BLIT_SPV, OUTPUT_BLIT_SPV_SIZE,
        fmt, (int32_t)__builtin_strlen(fmt), "write", 5);
    if (shader < 0) return -1;
    int32_t pso = gpu_create_compute_pso(shader, "main", 4);
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
