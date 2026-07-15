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
 * The executor runs as executor.wasm on BOTH backends, so the blend ships in
 * two languages and picks one from gpu_get_backend() at PSO-build time: MSL on
 * Metal (native), WGSL on WebGPU (web). `gpu_create_shader_module` compiles the
 * source verbatim in the host's native language, so a single hardcoded language
 * fails on the other backend (feeding MSL to WebGPU traps with "invalid
 * character #include <metal_stdlib>", which broke partial opacity on web). The
 * two sources are kept in LOCK-STEP. Bindings: dry = texture 0, fx = texture 1,
 * out = texture 2 (write), uniform = slot 3 — textures first, then the uniform,
 * matching the fused-kernel convention so WebGPU's auto-layout (one binding
 * namespace per group) has no texture/buffer @binding collision.
 */

#include "sketch/exec_gpu.h"
#include "sketch/host_wgsl_fmt.h"
#include "sketch/xfade_shape.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sketch_executor {

// MSL kernel. mode 0: out = mix(dry, fx, opacity) full RGBA, morphed toward a
// weighted over by `shape`. mode 1..15: blend math + source-over by wB
// (lock-step with video_blend/compute.hlsl). The fade weights wA/wB are
// CPU-computed (xfade_shape.h). Out-of-range reads are gated by the canvas
// dims in the uniform.
inline constexpr const char* kWetDryBlendMSL = R"MSL(
#include <metal_stdlib>
using namespace metal;
struct U { uint w; uint h; float opacity; uint mode; float wA; float wB; float shape; float pad; };
static float3 b_screen(float3 a, float3 b)    { return 1.0f - (1.0f - a) * (1.0f - b); }
static float3 b_overlay(float3 a, float3 b)   { return mix(2.0f*a*b, 1.0f - 2.0f*(1.0f-a)*(1.0f-b), step(float3(0.5f), a)); }
static float3 b_dodge(float3 a, float3 b)     { return min(float3(1.0f), a / max(1.0f - b, float3(1e-4f))); }
static float3 b_burn(float3 a, float3 b)      { return 1.0f - min(float3(1.0f), (1.0f - a) / max(b, float3(1e-4f))); }
static float3 b_softlight(float3 a, float3 b) { return (1.0f - 2.0f*b) * a * a + 2.0f * b * a; }
static float3 b_divide(float3 a, float3 b)    { return min(float3(1.0f), a / max(b, float3(1e-4f))); }
static float3 blend_mode(uint m, float3 a, float3 b) {
  switch (m) {
    case 1:  return min(a + b, float3(1.0f));     // Add (linear dodge)
    case 2:  return a * b;                        // Multiply
    case 3:  return b_screen(a, b);               // Screen
    case 4:  return b_overlay(a, b);              // Overlay
    case 5:  return min(a, b);                    // Darken
    case 6:  return max(a, b);                    // Lighten
    case 7:  return b_dodge(a, b);                // Color Dodge
    case 8:  return b_burn(a, b);                 // Color Burn
    case 9:  return b_overlay(b, a);              // Hard Light (overlay, swapped)
    case 10: return b_softlight(a, b);            // Soft Light
    case 11: return abs(a - b);                   // Difference
    case 12: return a + b - 2.0f*a*b;             // Exclusion
    case 13: return max(a - b, float3(0.0f));     // Subtract
    case 14: return b_divide(a, b);               // Divide
    case 15: return max(a + b - 1.0f, float3(0.0f)); // Linear Burn
    default: return b;                            // 0: Normal
  }
}
kernel void wet_dry_blend(
    uint2 gid [[thread_position_in_grid]],
    texture2d<float, access::read>  dry_tex [[texture(0)]],
    texture2d<float, access::read>  fx_tex  [[texture(1)]],
    texture2d<float, access::write> out_tex [[texture(2)]],
    constant U& u [[buffer(3)]]) {
  if (gid.x >= u.w || gid.y >= u.h) return;
  float4 a = dry_tex.read(gid);
  float4 b = fx_tex.read(gid);
  if (u.mode == 0u) {
    float4 m = mix(a, b, u.opacity);
    if (u.shape <= 0.0f) {          // legacy lerp, bit-exact (incl. copyToOutput)
      out_tex.write(m, gid);
      return;
    }
    // Weighted straight-alpha over: b(alpha*wB) over a(alpha*wA), morphed in
    // by shape (see the header comment).
    float topA = saturate(b.a * u.wB);
    float baseA = a.a * u.wA;
    float overA = topA + baseA * (1.0f - topA);
    float3 overc = (overA > 1e-5f)
        ? (b.rgb * topA + a.rgb * baseA * (1.0f - topA)) / overA
        : float3(0.0f);
    out_tex.write(mix(m, float4(overc, overA), u.shape), gid);
    return;
  }
  float3 blended = saturate(blend_mode(u.mode, a.rgb, b.rgb));
  float topA = saturate(b.a * u.wB);
  float outA = topA + a.a * (1.0f - topA);
  float3 outc = (outA > 1e-5f)
      ? (blended * topA + a.rgb * a.a * (1.0f - topA)) / outA
      : float3(0.0f);
  out_tex.write(float4(outc, outA), gid);
}
)MSL";

// WGSL twin of kWetDryBlendMSL (WebGPU). Same math + binding layout: read
// textures at @binding 0/1, a write storage texture at @binding 2, and the
// uniform at @binding 3 (after the textures — no auto-layout collision).
// The rgba8unorm storage declaration is a TEMPLATE — re-instantiated per
// concrete output format via host_wgsl_fmt.h (16F sketches write rgba16float
// intermediates).
inline constexpr const char* kWetDryBlendWGSL = R"WGSL(
struct U { w: u32, h: u32, opacity: f32, mode: u32, wA: f32, wB: f32, shape: f32, pad: f32 };
@group(0) @binding(0) var dry_tex: texture_2d<f32>;
@group(0) @binding(1) var fx_tex:  texture_2d<f32>;
@group(0) @binding(2) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> u: U;
fn b_screen(a: vec3<f32>, b: vec3<f32>) -> vec3<f32>    { return 1.0 - (1.0 - a) * (1.0 - b); }
fn b_overlay(a: vec3<f32>, b: vec3<f32>) -> vec3<f32>   { return mix(2.0*a*b, 1.0 - 2.0*(1.0-a)*(1.0-b), step(vec3<f32>(0.5), a)); }
fn b_dodge(a: vec3<f32>, b: vec3<f32>) -> vec3<f32>     { return min(vec3<f32>(1.0), a / max(1.0 - b, vec3<f32>(1e-4))); }
fn b_burn(a: vec3<f32>, b: vec3<f32>) -> vec3<f32>      { return 1.0 - min(vec3<f32>(1.0), (1.0 - a) / max(b, vec3<f32>(1e-4))); }
fn b_softlight(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> { return (1.0 - 2.0*b) * a * a + 2.0 * b * a; }
fn b_divide(a: vec3<f32>, b: vec3<f32>) -> vec3<f32>    { return min(vec3<f32>(1.0), a / max(b, vec3<f32>(1e-4))); }
fn blend_mode(m: u32, a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
  switch m {
    case 1u:  { return min(a + b, vec3<f32>(1.0)); }      // Add (linear dodge)
    case 2u:  { return a * b; }                           // Multiply
    case 3u:  { return b_screen(a, b); }                  // Screen
    case 4u:  { return b_overlay(a, b); }                 // Overlay
    case 5u:  { return min(a, b); }                       // Darken
    case 6u:  { return max(a, b); }                       // Lighten
    case 7u:  { return b_dodge(a, b); }                   // Color Dodge
    case 8u:  { return b_burn(a, b); }                    // Color Burn
    case 9u:  { return b_overlay(b, a); }                 // Hard Light (overlay, swapped)
    case 10u: { return b_softlight(a, b); }               // Soft Light
    case 11u: { return abs(a - b); }                      // Difference
    case 12u: { return a + b - 2.0*a*b; }                 // Exclusion
    case 13u: { return max(a - b, vec3<f32>(0.0)); }      // Subtract
    case 14u: { return b_divide(a, b); }                  // Divide
    case 15u: { return max(a + b - 1.0, vec3<f32>(0.0)); } // Linear Burn
    default:  { return b; }                               // 0: Normal
  }
}
@compute @workgroup_size(8, 8, 1)
fn wet_dry_blend(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.w || gid.y >= u.h) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let a = textureLoad(dry_tex, p, 0);
  let b = textureLoad(fx_tex,  p, 0);
  if (u.mode == 0u) {
    let m = mix(a, b, u.opacity);
    if (u.shape <= 0.0) {           // legacy lerp, bit-exact (incl. copyToOutput)
      textureStore(out_tex, p, m);
      return;
    }
    // Weighted straight-alpha over: b(alpha*wB) over a(alpha*wA), morphed in
    // by shape (see the header comment).
    let topA0 = clamp(b.a * u.wB, 0.0, 1.0);
    let baseA = a.a * u.wA;
    let overA = topA0 + baseA * (1.0 - topA0);
    var overc = vec3<f32>(0.0);
    if (overA > 1e-5) {
      overc = (b.rgb * topA0 + a.rgb * baseA * (1.0 - topA0)) / overA;
    }
    textureStore(out_tex, p, mix(m, vec4<f32>(overc, overA), u.shape));
    return;
  }
  let blended = clamp(blend_mode(u.mode, a.rgb, b.rgb), vec3<f32>(0.0), vec3<f32>(1.0));
  let topA = clamp(b.a * u.wB, 0.0, 1.0);
  let outA = topA + a.a * (1.0 - topA);
  var outc = vec3<f32>(0.0);
  if (outA > 1e-5) {
    outc = (blended * topA + a.rgb * a.a * (1.0 - topA)) / outA;
  }
  textureStore(out_tex, p, vec4<f32>(outc, outA));
}
)WGSL";

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

  // One PSO per WGSL storage output format on WebGPU (the storage decl bakes
  // the format); a single format-agnostic MSL PSO (key 0) on Metal.
  int32_t ensurePso(int32_t outTex) {
    // 1 = gpu::Backend::WebGPU → WGSL; anything else (Metal) → MSL.
    const bool web = (gpu_get_backend() == 1);
    int32_t key = 0;
    if (web) {
      key = gpu_get_texture_format(outTex);
      if (key < 0) key = 1;
    }
    for (const auto& e : psos_) {
      if (e.fmtKey == key) return e.pso;
    }
    const std::string src = web ? wgslWithStorageFormat(kWetDryBlendWGSL, key)
                                : std::string(kWetDryBlendMSL);
    int32_t shader = gpu_create_shader_module(src.c_str(), (int32_t)src.size());
    if (shader < 0) return -1;
    int32_t pso = gpu_create_compute_pso(shader, "wet_dry_blend",
                                         (int32_t)__builtin_strlen("wet_dry_blend"));
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
