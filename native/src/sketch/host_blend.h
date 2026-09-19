#pragma once
/*
 * host_blend.h — host-side wet/dry opacity blend + per-effect blend modes.
 *
 * A full-frame compute pass used by the sketch executor to composite a
 * per-effect output (`fx`) over the pre-effect image (`dry`, the column input)
 * at a given opacity — Resolume-style. Structure mirrors the text compositor
 * (host_impls_text.cpp): create a shader module + compute PSO once, write a
 * small uniform, encode one dispatch.
 *
 * Two blend regimes, selected by `mode` (the composite.blend / arrangement
 * BlendMode enum — keep in lock-step with video_blend/main.cpp and
 * BLEND_MODE_NAMES in web sketch-types.ts):
 *   mode 0 (Normal): out = mix(dry, fx, opacity) over the FULL RGBA — the
 *     original wet/dry crossfade. Kept as a straight lerp (not source-over)
 *     so existing sketches are bit-identical and copyToOutput (mode 0,
 *     opacity 1) remains an exact copy for any alpha.
 *   mode 1..15: Photoshop-style blend math on rgb, then Porter-Duff
 *     source-over by fx.a × wB. This is LAYER-COMPOSITOR semantics (opacity 1
 *     = the full-strength blend, e.g. identity-at-Multiply squares the image).
 *     The composite.blend NODE diverged deliberately: it is an A/B CROSSFADER
 *     (opacity 1 = pure B; the blend rides the fade's overlap — see
 *     video_blend/compute.hlsl). Only the blend_mode() switch itself stays in
 *     lock-step across the two.
 *
 * The crossfade `shape` param (`__xfade_shape__`) bends the fade curve: the
 * fader maps to the fold weights through xfade::weightA/weightB
 * (sketch/xfade_shape.h — computed CPU-SIDE in encode(); the kernels receive
 * plain floats). shape 0 → wB == opacity, bit-identical legacy behavior.
 * shape 1 → full coverage mid-fade (the blend math at full strength). Mode 0
 * additionally morphs, by shape, from the legacy lerp toward a weighted
 * straight-alpha over — fx(alpha·wB) over dry(alpha·wA) — so at shape 1 both
 * sides hold full alpha mid-fade (visible when the wet side carries
 * transparency); its endpoints stay exact (t=0 → dry, t=1 → fx) at every
 * shape, preserving the copyToOutput invariant.
 *
 * The kernel is authored ONCE as HLSL (shaders/blend.hlsl), baked to SPIR-V at
 * build time and translated by the HOST per backend — see exec_gpu.h's
 * create_shader_module_spv. It used to ship as hand-written MSL + WGSL twins
 * picked by `gpu_get_backend() == 1 ? WGSL : MSL`, which failed twice for
 * mirror-image reasons: MSL fed to WebGPU traps on "#include <metal_stdlib>"
 * (partial opacity froze the web output), and the `else` branch meaning "Metal"
 * fed the same MSL to D3D11 the day that backend existed (FXC: "X1505: No
 * include handler specified" — no blending at all on Windows).
 *
 * Bindings: dry = texture 0, fx = texture 1, out = texture 2 (write), uniform =
 * slot 3 — textures first, then the uniform, matching the fused-kernel
 * convention so WebGPU's auto-layout (one binding namespace per group) has no
 * texture/buffer @binding collision. In the HLSL those ARE the register
 * numbers (t0/t1/u2/b3); DXC maps register N to SPIR-V binding N, and every
 * translator maps it back.
 */

#include "sketch/exec_gpu.h"
#include "sketch/host_wgsl_fmt.h"
#include "sketch/xfade_shape.h"

#include "exec_blend_spv.h"  // BLEND_SPV — see shaders/build_shaders.sh

#include <cstdint>
#include <vector>

namespace sketch_executor {

class WetDryBlend {
 public:
  ~WetDryBlend() { releaseAll(); }

  // Rewind the per-encode uniform cursor. Call once per frame (top of
  // execute()) BEFORE any encode(). The whole frame is encoded into ONE
  // command buffer and gpu_write_buffer is an immediate CPU write into the
  // buffer's contents — so every encode this frame needs its OWN uniform
  // buffer. Reusing one buffer made all of a frame's blend dispatches read
  // whatever opacity was written LAST (e.g. a chain with an effect at 0.49
  // followed by one at 0.99 blended BOTH at 0.99; a trailing copyToOutput
  // forced everything to 1.0).
  void beginFrame() { uniCursor_ = 0; }

  // Encode the blend into the current command buffer (NOT submitted — the
  // executor submits once per frame), via the gpu ABI. `dryTex` is the
  // pre-effect image; pass <0 to fade against transparent black. `mode` is the
  // BlendMode enum value (0 = Normal crossfade; see the header comment).
  // `shape` bends the fade curve (0 = legacy linear — the weights are computed
  // here on the CPU via xfade_shape.h; the kernels just fold them in).
  // Returns false if resources couldn't be created (caller should fall back to
  // using `fxTex`).
  bool encode(int32_t dryTex, int32_t fxTex,
              int32_t outTex, float opacity, int W, int H, int mode = 0,
              float shape = 0.0f) {
    if (outTex < 0 || fxTex < 0 || W <= 0 || H <= 0) return false;
    const int32_t pso = ensurePso(outTex);
    if (pso < 0) return false;
    const int32_t uni = nextUniform();
    if (uni < 0) return false;
    const int32_t dry = dryTex >= 0 ? dryTex : blackTex(W, H);
    if (dry < 0) return false;
    shape = shape > 0.0f ? (shape < 1.0f ? shape : 1.0f) : 0.0f;
    struct U {
      uint32_t w, h; float opacity; uint32_t mode;
      float wA, wB, shape, pad;
    } u{(uint32_t)W, (uint32_t)H, opacity,
        (uint32_t)(mode > 0 && mode <= 15 ? mode : 0),
        xfade::weightA(opacity, shape), xfade::weightB(opacity, shape),
        shape, 0.0f};
    gpu_write_buffer(uni, 0, reinterpret_cast<const void*>(&u), (int32_t)sizeof(u));
    int32_t pass = gpu_begin_compute_pass();
    gpu_compute_set_pso(pass, pso);
    gpu_compute_set_buffer(pass, uni, 0, /*slot*/ 3);
    gpu_compute_set_texture(pass, dry,    0, /*read*/ 0);
    gpu_compute_set_texture(pass, fxTex,  1, /*read*/ 0);
    gpu_compute_set_texture(pass, outTex, 2, /*write*/ 1);
    gpu_compute_dispatch(pass, (W + 7) / 8, (H + 7) / 8, 1);
    gpu_end_compute_pass(pass);
    return true;
  }

 private:
  static constexpr int kFmtRGBA8 = 1;  // gpu.h format code

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
        BLEND_SPV, BLEND_SPV_SIZE,
        fmt, (int32_t)__builtin_strlen(fmt), "write", 5);
    if (shader < 0) return -1;
    int32_t pso = gpu_create_compute_pso(shader, "main", 4);
    if (pso < 0) { gpu_release(shader); return -1; }
    psos_.push_back({key, shader, pso});
    return pso;
  }

  // One uniform buffer PER ENCODE within a frame (see beginFrame). The pool
  // grows to the frame's peak blend count and is reused across frames.
  // usage 2 = gpu::BufferUsage::Uniform — required for the WebGPU
  // var<uniform> binding (Metal ignores buffer usage flags).
  int32_t nextUniform() {
    if (uniCursor_ >= (int)uniforms_.size()) {
      int32_t b = gpu_create_buffer(32, /*Uniform*/ 2);
      if (b < 0) return -1;
      uniforms_.push_back(b);
    }
    return uniforms_[uniCursor_++];
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
    for (const auto& e : psos_) {
      if (e.pso >= 0)    gpu_release(e.pso);
      if (e.shader >= 0) gpu_release(e.shader);
    }
    psos_.clear();
    for (int32_t b : uniforms_) { if (b >= 0) gpu_release(b); }
    uniforms_.clear();
    uniCursor_ = 0;
    if (black_ >= 0)  gpu_release(black_);
    black_ = -1;
    blackW_ = blackH_ = 0;
  }

  std::vector<PsoEntry> psos_;
  int32_t black_ = -1;
  std::vector<int32_t> uniforms_;
  int uniCursor_ = 0;
  int blackW_ = 0, blackH_ = 0;
};

}  // namespace sketch_executor
