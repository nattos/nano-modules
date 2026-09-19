#pragma once
/*
 * host_sidechannel_blit.h — host-side scaled blit for sidechannel reads.
 *
 * Copies a bus-owned channel texture (any size/format the writer had) into a
 * `util.sidechannel_in` stage's output texture, nearest-scaling on size
 * mismatch. A same-size same-format pair takes the cheap gpu_copy_texture
 * path with no PSO at all; everything else goes through a tiny compute
 * kernel. Structure mirrors host_blend.h's WetDryBlend exactly: a lazily-built
 * PSO, one dispatch encoded into the executor's per-frame command batch (never
 * submitted here).
 *
 * The kernel is authored ONCE as HLSL (shaders/sidechannel_blit.hlsl), baked to
 * SPIR-V at build time and translated by the host per backend — see exec_gpu.h's
 * create_shader_module_spv. WGSL bakes the storage format into the declaration,
 * so WebGPU gets one module per concrete output format (16F sketches write
 * rgba16float intermediates); Metal and D3D11 need one for all of them.
 *
 * The float read/write path also absorbs a BGRA↔RGBA channel-order difference
 * between the bus texture and the output (native interop textures are BGRA),
 * which a raw byte copy would swap — the copy fast path is therefore gated on
 * format EQUALITY.
 */

#include "sketch/exec_gpu.h"
#include "sketch/host_wgsl_fmt.h"

#include "exec_sidechannel_blit_spv.h"  // SIDECHANNEL_BLIT_SPV — shaders/build_shaders.sh

#include <cstdint>
#include <vector>

namespace sketch_executor {

class SidechannelBlit {
 public:
  ~SidechannelBlit() { releaseAll(); }

  // Rewind the per-encode uniform cursor — call once per frame, before any
  // encode(). Same hazard as WetDryBlend::beginFrame: the frame is ONE
  // command buffer and gpu_write_buffer writes immediately, so two
  // sidechannel_in stages in one frame sharing a uniform buffer would both
  // blit with the second stage's dimensions.
  void beginFrame() { uniCursor_ = 0; }

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
    const int32_t pso = ensurePso(outTex);
    if (pso < 0) return false;
    const int32_t uni = nextUniform();
    if (uni < 0) return false;
    struct U { uint32_t dw, dh, sw, sh; } u{
        (uint32_t)W, (uint32_t)H, (uint32_t)sw, (uint32_t)sh};
    gpu_write_buffer(uni, 0, reinterpret_cast<const void*>(&u), (int32_t)sizeof(u));
    int32_t pass = gpu_begin_compute_pass();
    gpu_compute_set_pso(pass, pso);
    gpu_compute_set_buffer(pass, uni, 0, /*slot*/ 2);
    gpu_compute_set_texture(pass, srcTex, 0, /*read*/ 0);
    gpu_compute_set_texture(pass, outTex, 1, /*write*/ 1);
    gpu_compute_dispatch(pass, (W + 7) / 8, (H + 7) / 8, 1);
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
        SIDECHANNEL_BLIT_SPV, SIDECHANNEL_BLIT_SPV_SIZE,
        fmt, (int32_t)__builtin_strlen(fmt), "write", 5);
    if (shader < 0) return -1;
    int32_t pso = gpu_create_compute_pso(shader, "main", 4);
    if (pso < 0) { gpu_release(shader); return -1; }
    psos_.push_back({key, shader, pso});
    return pso;
  }

  // One uniform buffer PER ENCODE within a frame (see beginFrame); pool reused
  // across frames. usage 2 = gpu::BufferUsage::Uniform (WebGPU var<uniform>;
  // Metal ignores buffer usage flags).
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
