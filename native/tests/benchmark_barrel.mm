// benchmark_barrel — standalone driver for the NanoBarrel render path.
//
// Mirrors what NanoBarrelPlugin::ProcessOpenGL does each frame
// (GL → Metal interop blit → executor → submit → Metal → GL blit) so
// optimizations can be measured in isolation without running Resolume.
//
// Usage:
//   benchmark_barrel [--effects N] [--frames N] [--width W] [--height H]
//
// Defaults: 10 effects, 600 frames, 1920×1080. Prints total wall time,
// average FPS, and the min/median/p95/max per-frame time.
//
// What we deliberately match vs. the plugin:
//  - Same NSOpenGLContext + InteropTexture pair (so the GL↔Metal blit
//    cost is identical).
//  - Same effect_runtime / sketch_executor / gpu_backend code path.
//  - Same chain shape (the sketch JSON we build matches what the editor
//    emits).
//  - We DO NOT spin up bridge_core / WsServer / preview push — those
//    are explicitly out of scope (we measure with no editor connected,
//    which is the path the user reported as "still 75 FPS").
//
// What's intentionally absent:
//  - The corner badge draw (negligible cost, and skipping it makes the
//    output's expected pixels a copy of the input — useful for asserts
//    later).
//  - Bridge tick / config regen.

#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"

#include "plugin/nano_barrel/InteropTexture.h"

// Effect entry points (these come out of the effects_native bundle the
// barrel links against). Class-like instance ABI: instance callbacks
// take an opaque per-instance self pointer.
namespace brightness_contrast {
void  module_init();
void* create();
void  destroy(void* self);
void  init(void* self);
void  tick(void* self, double);
void  render(void* self, int, int);
void  on_state_patched(void* self, int, const char*, const int*, const int*, const int*);
int32_t is_identity(void* self);
}

// Host-state setters live in runtime/host_impls.cpp but aren't declared
// in any public header — every consumer forward-declares them. Match
// what streaky_blobs / NanoBarrel do.
namespace effect_runtime {
void setHostTime(double t);
void setHostDeltaTime(double dt);
void setHostViewport(int w, int h);
}

// Generated MSL headers — same names the barrel uses.
#include "brightness_contrast_msl.h"

using nlohmann::json;
using clock_type = std::chrono::steady_clock;

namespace {

struct Args {
  int  effects   = 10;
  int  frames    = 600;
  int  width     = 1920;
  int  height    = 1080;
  bool quiet     = false;
  bool assertMode = false;
};

Args parseArgs(int argc, char** argv) {
  Args a;
  for (int i = 1; i < argc; ++i) {
    const char* k = argv[i];
    auto take = [&](int& out) {
      if (i + 1 < argc) { out = std::atoi(argv[++i]); }
    };
    if (!std::strcmp(k, "--effects")) take(a.effects);
    else if (!std::strcmp(k, "--frames")) take(a.frames);
    else if (!std::strcmp(k, "--width"))  take(a.width);
    else if (!std::strcmp(k, "--height")) take(a.height);
    else if (!std::strcmp(k, "--quiet"))  a.quiet = true;
    else if (!std::strcmp(k, "--assert")) a.assertMode = true;
  }
  return a;
}

// Build an N-stage brightness_contrast chain. Each entry gets distinct
// (brightness, contrast) so per-instance state is exercised — under the
// old file-static model these would all collapse to one stage's params.
json buildSketch(const std::vector<std::pair<float, float>>& params) {
  json chain = json::array();
  json instances = json::object();
  for (size_t i = 0; i < params.size(); ++i) {
    std::string key = "bc" + std::to_string(i);
    chain.push_back({
      {"type", "module"},
      {"module_type", "video.brightness_contrast"},
      {"instance_key", key},
      {"taps", json::array()},
    });
    instances[key] = {
      {"module_type", "video.brightness_contrast"},
      {"state", {
        {"brightness", params[i].first},
        {"contrast",   params[i].second},
      }},
    };
  }
  return {
    {"anchor", nullptr},
    {"columns", json::array({{
      {"name", "Column 1"},
      {"chain", chain},
    }})},
    {"instances", instances},
  };
}

// Perf-mode chain: distinct-but-mild per-stage params (won't saturate
// to black/white so the GPU does real work every stage).
json buildSketch(int effectCount) {
  std::vector<std::pair<float, float>> params;
  params.reserve(effectCount);
  for (int i = 0; i < effectCount; ++i) {
    float b = 0.5f + 0.02f * (float)(i % 5 - 2);  // ~[0.46, 0.54]
    params.emplace_back(b, 0.5f);
  }
  return buildSketch(params);
}

// CPU reference for one brightness_contrast stage (matches pixel.hlsl
// fuse_transform: shift by (b-0.5)*2, scale by c*2, saturate).
uint8_t bcStageChannel(uint8_t in, float b, float c) {
  float v = in / 255.0f;
  v += (b - 0.5f) * 2.0f;
  v *= c * 2.0f;
  if (v < 0.f) v = 0.f;
  if (v > 1.f) v = 1.f;
  int o = (int)(v * 255.0f + 0.5f);
  return (uint8_t)(o < 0 ? 0 : (o > 255 ? 255 : o));
}

// Headless GL context (3.2 core, accelerated). Stays current for the
// whole benchmark — the InteropTexture ctor reads
// [NSOpenGLContext currentContext].
NSOpenGLContext* makeGLContext() {
  NSOpenGLPixelFormatAttribute attrs[] = {
    NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
    NSOpenGLPFAAccelerated,
    NSOpenGLPFANoRecovery,
    NSOpenGLPFAColorSize, 32,
    NSOpenGLPFAAlphaSize, 8,
    0
  };
  NSOpenGLPixelFormat* pf =
      [[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
  if (!pf) return nil;
  NSOpenGLContext* ctx =
      [[NSOpenGLContext alloc] initWithFormat:pf shareContext:nil];
  [ctx makeCurrentContext];
  return ctx;
}

// Make a GL_TEXTURE_RECTANGLE filled with a slow per-pixel gradient. Used
// as the "FFGL input texture". RECT (not 2D) matches what Resolume
// hands the plugin in practice; the blit path is identical either way.
GLuint makeInputTexture(int w, int h) {
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_RECTANGLE, tex);
  glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  std::vector<uint8_t> pixels((size_t)w * h * 4);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      size_t o = ((size_t)y * w + x) * 4;
      pixels[o + 0] = (uint8_t)(x * 255 / w);
      pixels[o + 1] = (uint8_t)(y * 255 / h);
      pixels[o + 2] = (uint8_t)(((x + y) / 2) & 0xFF);
      pixels[o + 3] = 0xFF;
    }
  }
  glTexImage2D(GL_TEXTURE_RECTANGLE, 0, GL_RGBA8, w, h, 0,
               GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
  glBindTexture(GL_TEXTURE_RECTANGLE, 0);
  return tex;
}

// Make a destination FBO + backing 2D texture to stand in for the FFGL
// host's `HostFBO`.
struct DestFbo { GLuint fbo = 0; GLuint tex = 0; };
DestFbo makeDestFbo(int w, int h) {
  DestFbo d;
  glGenTextures(1, &d.tex);
  glBindTexture(GL_TEXTURE_2D, d.tex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0,
               GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  glGenFramebuffers(1, &d.fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, d.fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                         GL_TEXTURE_2D, d.tex, 0);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  return d;
}

// Same shape as the plugin's blitGlInputToInterop, just inlined here so
// the benchmark stays self-contained.
void blitGlInputToInterop(GLuint inputTex, int inW, int inH,
                          InteropTexture* interop, GLuint srcFbo) {
  GLint prevRead = 0, prevDraw = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, srcFbo);
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                         GL_TEXTURE_RECTANGLE, inputTex, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, interop->getOpenGLFBO());
  glBlitFramebuffer(0, 0, inW, inH,
                    0, 0, interop->getWidth(), interop->getHeight(),
                    GL_COLOR_BUFFER_BIT, GL_LINEAR);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
  glFlush();
}

void blitInteropToHostFbo(InteropTexture* interop, int W, int H,
                          GLuint hostFbo) {
  GLint prevRead = 0, prevDraw = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, interop->getOpenGLFBO());
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, hostFbo);
  // Y-flipped, matching the plugin (GL bottom-left vs Metal top-left).
  glBlitFramebuffer(0, H, W, 0,
                    0, 0, W, H,
                    GL_COLOR_BUFFER_BIT, GL_NEAREST);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
}

// --- Per-instance correctness gate (--assert) -----------------------
// Builds a 4-stage brightness_contrast chain with DISTINCT per-stage
// params and checks that each stage applies its OWN params — the bug
// this whole refactor fixes is params bleeding across instances of the
// same effect type. Uses plain RGBA8 textures (no GL/interop) so
// readback is channel-order-consistent and avoids the BGRA output blit.
//
// Test 1 (standalone): force a barrier at every stage so each stage's
//   output lands in a real intermediate; verify out_k == T(out_{k-1}, p_k).
// Test 2 (fused): no barriers → the 4 same-type stages fuse into one
//   kernel bound to 4 distinct per-instance uniform buffers; verify the
//   final output equals the full CPU chain.
int runAssert() {
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  if (!device) { std::fprintf(stderr, "assert: no MTLDevice\n"); return 1; }
  auto gpu = gpu::createMetalBackend();
  if (!gpu) { std::fprintf(stderr, "assert: no Metal backend\n"); return 1; }
  auto rt = std::make_unique<effect_runtime::EffectRuntime>(gpu.get());
  rt->registerShaderMSL("compute", BRIGHTNESS_CONTRAST_COMPUTE_MSL);
  rt->registerShaderMSL("pixel",   BRIGHTNESS_CONTRAST_PIXEL_MSL);
  auto registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
  registry->registerEffect(
      "video.brightness_contrast", "Brightness Contrast",
      &brightness_contrast::module_init, &brightness_contrast::create,
      &brightness_contrast::destroy, &brightness_contrast::init,
      &brightness_contrast::tick, &brightness_contrast::render,
      &brightness_contrast::on_state_patched, &brightness_contrast::is_identity);
  auto executor = std::make_unique<sketch_executor::SketchExecutor>(
      rt.get(), registry.get(), gpu.get());

  const int W = 16, H = 16;
  // Constant mid-tone input — distinct per channel so a R/B swap in
  // readback can't accidentally hide a mismatch.
  const uint8_t IN_R = 80, IN_G = 120, IN_B = 160;
  std::vector<uint8_t> inPix((size_t)W * H * 4);
  for (size_t p = 0; p < (size_t)W * H; ++p) {
    inPix[p * 4 + 0] = IN_R;
    inPix[p * 4 + 1] = IN_G;
    inPix[p * 4 + 2] = IN_B;
    inPix[p * 4 + 3] = 255;
  }
  int32_t inputTex  = gpu->createTexture(W, H, 1);
  int32_t outputTex = gpu->createTexture(W, H, 1);
  gpu->writeTexture(inputTex, W, H, inPix.data(), (uint32_t)inPix.size());

  // Mild, distinct params so no stage saturates (which would mask a
  // wrong-param bug). Last stage is identity (0.5, 0.5).
  std::vector<std::pair<float, float>> params = {
    {0.70f, 0.50f}, {0.35f, 0.60f}, {0.60f, 0.45f}, {0.50f, 0.50f},
  };
  const int N = (int)params.size();
  json sketch = buildSketch(params);

  bool ok = true;
  auto centerRGB = [&](const std::vector<uint8_t>& px, int* r, int* g, int* b) {
    size_t o = ((size_t)(H / 2) * W + (W / 2)) * 4;
    *r = px[o + 0]; *g = px[o + 1]; *b = px[o + 2];
  };

  // ---- Test 1: standalone, per-stage isolation ----
  std::vector<int32_t> outByChain(N, -1);
  executor->setBarrierPredicate([](int, int) { return true; });
  executor->setChainEntryHook(
      [&](int /*col*/, int chainIdx, int32_t /*inH*/, int32_t outH,
          int /*w*/, int /*h*/) {
        if (chainIdx >= 0 && chainIdx < N) outByChain[chainIdx] = outH;
      });
  executor->execute(sketch, inputTex, outputTex, W, H, 1.0 / 60.0);
  gpu->submit();

  int pr = IN_R, pg = IN_G, pb = IN_B;  // previous stage's actual output
  for (int k = 0; k < N; ++k) {
    if (outByChain[k] <= 0) {
      std::fprintf(stderr, "assert: stage %d produced no output handle\n", k);
      ok = false; break;
    }
    auto px = gpu->readbackTexture(outByChain[k], W, H);
    if (px.size() < (size_t)W * H * 4) {
      std::fprintf(stderr, "assert: stage %d readback failed\n", k);
      ok = false; break;
    }
    int ar, ag, ab; centerRGB(px, &ar, &ag, &ab);
    int er = bcStageChannel((uint8_t)pr, params[k].first, params[k].second);
    int eg = bcStageChannel((uint8_t)pg, params[k].first, params[k].second);
    int eb = bcStageChannel((uint8_t)pb, params[k].first, params[k].second);
    auto near = [](int a, int b) { return std::abs(a - b) <= 2; };
    if (!near(ar, er) || !near(ag, eg) || !near(ab, eb)) {
      std::fprintf(stderr,
          "assert: stage %d (b=%.2f c=%.2f) expected (%d,%d,%d) got (%d,%d,%d)\n",
          k, params[k].first, params[k].second, er, eg, eb, ar, ag, ab);
      ok = false;
    }
    pr = ar; pg = ag; pb = ab;
  }
  std::printf("assert: standalone per-stage %s\n", ok ? "PASS" : "FAIL");

  // ---- Test 2: fused path, end-to-end ----
  bool fok = true;
  executor->setChainEntryHook({});
  executor->setBarrierPredicate([](int, int) { return false; });
  executor->execute(sketch, inputTex, outputTex, W, H, 1.0 / 60.0);
  gpu->submit();
  {
    auto px = gpu->readbackTexture(outputTex, W, H);
    if (px.size() < (size_t)W * H * 4) {
      std::fprintf(stderr, "assert: fused readback failed\n");
      fok = false;
    } else {
      int er = IN_R, eg = IN_G, eb = IN_B;
      for (int k = 0; k < N; ++k) {
        er = bcStageChannel((uint8_t)er, params[k].first, params[k].second);
        eg = bcStageChannel((uint8_t)eg, params[k].first, params[k].second);
        eb = bcStageChannel((uint8_t)eb, params[k].first, params[k].second);
      }
      int ar, ag, ab; centerRGB(px, &ar, &ag, &ab);
      auto near = [](int a, int b) { return std::abs(a - b) <= 3; };
      if (!near(ar, er) || !near(ag, eg) || !near(ab, eb)) {
        std::fprintf(stderr,
            "assert: fused final expected (%d,%d,%d) got (%d,%d,%d)\n",
            er, eg, eb, ar, ag, ab);
        fok = false;
      }
    }
  }
  std::printf("assert: fused end-to-end %s\n", fok ? "PASS" : "FAIL");

  // ---- Test 3: identity standalone alias ----
  // A middle stage at neutral params (0.5, 0.5) is a pure passthrough.
  // With a barrier at every stage (standalone path), the executor must
  // SKIP its dispatch and ALIAS its input handle as its output: the
  // identity stage's chain-entry output handle equals its input handle
  // (no fresh intermediate consumed), which in turn equals the previous
  // stage's output. Final pixels match the chain with the stage removed.
  bool iok = true;
  {
    std::vector<std::pair<float, float>> p3 = {
      {0.70f, 0.50f}, {0.50f, 0.50f}, {0.60f, 0.45f},
    };
    const int N3 = (int)p3.size();
    json s3 = buildSketch(p3);
    std::vector<int32_t> inBy(N3, -2), outBy(N3, -2);
    executor->setBarrierPredicate([](int, int) { return true; });
    executor->setChainEntryHook(
        [&](int, int chainIdx, int32_t inH, int32_t outH, int, int) {
          if (chainIdx >= 0 && chainIdx < N3) { inBy[chainIdx] = inH; outBy[chainIdx] = outH; }
        });
    executor->execute(s3, inputTex, outputTex, W, H, 1.0 / 60.0);
    gpu->submit();
    executor->setChainEntryHook({});
    if (outBy[1] != inBy[1]) {
      std::fprintf(stderr, "assert: identity stage not aliased (in=%d out=%d)\n",
                   inBy[1], outBy[1]);
      iok = false;
    }
    if (inBy[1] != outBy[0]) {
      std::fprintf(stderr, "assert: identity stage input (%d) != prev output (%d)\n",
                   inBy[1], outBy[0]);
      iok = false;
    }
    auto px = gpu->readbackTexture(outBy[2] > 0 ? outBy[2] : outputTex, W, H);
    if (px.size() < (size_t)W * H * 4) { iok = false; }
    else {
      int er = IN_R, eg = IN_G, eb = IN_B;
      for (int k : {0, 2}) {
        er = bcStageChannel((uint8_t)er, p3[k].first, p3[k].second);
        eg = bcStageChannel((uint8_t)eg, p3[k].first, p3[k].second);
        eb = bcStageChannel((uint8_t)eb, p3[k].first, p3[k].second);
      }
      int ar, ag, ab; centerRGB(px, &ar, &ag, &ab);
      auto near = [](int a, int b) { return std::abs(a - b) <= 2; };
      if (!near(ar, er) || !near(ag, eg) || !near(ab, eb)) {
        std::fprintf(stderr,
            "assert: identity standalone final expected (%d,%d,%d) got (%d,%d,%d)\n",
            er, eg, eb, ar, ag, ab);
        iok = false;
      }
    }
  }
  std::printf("assert: identity standalone alias %s\n", iok ? "PASS" : "FAIL");

  // ---- Test 4: all-identity fused group skipped ----
  // Every stage neutral → the whole fused group is a no-op. The executor
  // must skip the fused dispatch entirely; with nothing dispatched in the
  // sketch, execute() returns the INPUT handle and its pixels are the
  // untouched input.
  bool fiok = true;
  {
    std::vector<std::pair<float, float>> p4 = {
      {0.5f, 0.5f}, {0.5f, 0.5f}, {0.5f, 0.5f},
    };
    json s4 = buildSketch(p4);
    executor->setBarrierPredicate([](int, int) { return false; });
    int32_t ret = executor->execute(s4, inputTex, outputTex, W, H, 1.0 / 60.0);
    gpu->submit();
    if (ret != inputTex) {
      std::fprintf(stderr,
          "assert: all-identity group not skipped (ret=%d input=%d)\n", ret, inputTex);
      fiok = false;
    }
    auto px = gpu->readbackTexture(ret > 0 ? ret : inputTex, W, H);
    int ar, ag, ab; centerRGB(px, &ar, &ag, &ab);
    if (ar != IN_R || ag != IN_G || ab != IN_B) {
      std::fprintf(stderr, "assert: all-identity passthrough wrong (%d,%d,%d)\n", ar, ag, ab);
      fiok = false;
    }
  }
  std::printf("assert: identity fused-group skip %s\n", fiok ? "PASS" : "FAIL");

  // ---- Test 5: identity stage dropped from a partial fused group ----
  // A neutral stage between two real ones must be excluded from the fused
  // kernel; the dispatch runs only the 2 real stages and the result
  // equals the chain with the identity stage removed.
  bool pok = true;
  {
    std::vector<std::pair<float, float>> p5 = {
      {0.70f, 0.50f}, {0.50f, 0.50f}, {0.60f, 0.45f},
    };
    json s5 = buildSketch(p5);
    executor->setBarrierPredicate([](int, int) { return false; });
    executor->execute(s5, inputTex, outputTex, W, H, 1.0 / 60.0);
    gpu->submit();
    auto px = gpu->readbackTexture(outputTex, W, H);
    int er = IN_R, eg = IN_G, eb = IN_B;
    for (int k : {0, 2}) {
      er = bcStageChannel((uint8_t)er, p5[k].first, p5[k].second);
      eg = bcStageChannel((uint8_t)eg, p5[k].first, p5[k].second);
      eb = bcStageChannel((uint8_t)eb, p5[k].first, p5[k].second);
    }
    int ar, ag, ab; centerRGB(px, &ar, &ag, &ab);
    auto near = [](int a, int b) { return std::abs(a - b) <= 3; };
    if (!near(ar, er) || !near(ag, eg) || !near(ab, eb)) {
      std::fprintf(stderr,
          "assert: partial-fused final expected (%d,%d,%d) got (%d,%d,%d)\n",
          er, eg, eb, ar, ag, ab);
      pok = false;
    }
  }
  std::printf("assert: identity partial fused %s\n", pok ? "PASS" : "FAIL");

  // ---- Test 6: fusion overflow (>28 fused stages) ----
  // Metal's compute buffer table caps a fused group at 28 stages (input +
  // output + one uniform per stage from slot 2). A longer eligible run must
  // split into back-to-back fused groups, materializing a real intermediate
  // texture at the seam. Verify both that the split happens (exactly 2 fused
  // groups → 2 materialized outputs) and that the pixels are still correct.
  //
  // Params keep every stage's result an EXACT 8-bit value (contrast 0.5 →
  // scale 1.0; brightness offset = (b-0.5)*2 = k/255 for integer k), so the
  // CPU reference (which rounds per stage) matches the GPU regardless of
  // where the fused path actually rounds (only at the 28-stage seam + end).
  bool xok = true;
  {
    const int BIG = 30;  // > 28 → forces one split
    std::vector<std::pair<float, float>> big;
    for (int i = 0; i < BIG; ++i) {
      int k = 1 + (i % 2);                       // +1/255 or +2/255 per stage
      big.emplace_back(0.5f + (float)k / 510.0f, 0.5f);
    }
    json bigSketch = buildSketch(big);

    int materializedOutputs = 0;
    executor->setBarrierPredicate([](int, int) { return false; });
    executor->setChainEntryHook(
        [&](int, int, int32_t, int32_t outH, int, int) {
          if (outH > 0) ++materializedOutputs;   // one per fused group's output
        });
    executor->execute(bigSketch, inputTex, outputTex, W, H, 1.0 / 60.0);
    gpu->submit();
    executor->setChainEntryHook({});

    // groups [0..27] + [28..29], each fused → exactly 2 materialized outputs.
    if (materializedOutputs != 2) {
      std::fprintf(stderr,
          "assert: overflow expected 2 fused groups (materialized outputs), got %d\n",
          materializedOutputs);
      xok = false;
    }
    auto px = gpu->readbackTexture(outputTex, W, H);
    if (px.size() < (size_t)W * H * 4) {
      std::fprintf(stderr, "assert: overflow readback failed\n");
      xok = false;
    } else {
      int er = IN_R, eg = IN_G, eb = IN_B;
      for (auto& p : big) {
        er = bcStageChannel((uint8_t)er, p.first, p.second);
        eg = bcStageChannel((uint8_t)eg, p.first, p.second);
        eb = bcStageChannel((uint8_t)eb, p.first, p.second);
      }
      int ar, ag, ab; centerRGB(px, &ar, &ag, &ab);
      auto near = [](int a, int b) { return std::abs(a - b) <= 2; };
      if (!near(ar, er) || !near(ag, eg) || !near(ab, eb)) {
        std::fprintf(stderr,
            "assert: overflow final expected (%d,%d,%d) got (%d,%d,%d)\n",
            er, eg, eb, ar, ag, ab);
        xok = false;
      }
    }
  }
  std::printf("assert: fusion overflow (>28 stages) %s\n", xok ? "PASS" : "FAIL");

  gpu->release(inputTex);
  gpu->release(outputTex);
  executor.reset();
  registry.reset();
  rt.reset();
  gpu.reset();
  return (ok && fok && iok && fiok && pok && xok) ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    Args args = parseArgs(argc, argv);

    if (args.assertMode) {
      return runAssert();
    }

    if (!args.quiet) {
      std::printf("=== NanoBarrel benchmark ===\n");
      std::printf("effects=%d viewport=%dx%d frames=%d\n",
                  args.effects, args.width, args.height, args.frames);
    }

    // -- GL context --------------------------------------------------
    NSOpenGLContext* glCtx = makeGLContext();
    if (!glCtx) {
      std::fprintf(stderr, "failed to create NSOpenGLContext\n");
      return 1;
    }

    // -- Metal device + effect runtime + executor -------------------
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) {
      std::fprintf(stderr, "failed to create MTLDevice\n");
      return 1;
    }
    auto gpu = gpu::createMetalBackend();
    if (!gpu) {
      std::fprintf(stderr, "failed to create Metal backend\n");
      return 1;
    }
    auto rt = std::make_unique<effect_runtime::EffectRuntime>(gpu.get());
    rt->registerShaderMSL("compute", BRIGHTNESS_CONTRAST_COMPUTE_MSL);
    rt->registerShaderMSL("pixel",   BRIGHTNESS_CONTRAST_PIXEL_MSL);
    auto registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
    registry->registerEffect(
        "video.brightness_contrast", "Brightness Contrast",
        &brightness_contrast::module_init, &brightness_contrast::create,
        &brightness_contrast::destroy, &brightness_contrast::init,
        &brightness_contrast::tick, &brightness_contrast::render,
        &brightness_contrast::on_state_patched);
    auto executor = std::make_unique<sketch_executor::SketchExecutor>(
        rt.get(), registry.get(), gpu.get());

    // -- GL resources ------------------------------------------------
    GLuint inputTex = makeInputTexture(args.width, args.height);
    GLuint srcFbo = 0;
    glGenFramebuffers(1, &srcFbo);
    DestFbo hostFbo = makeDestFbo(args.width, args.height);

    // -- Interop pair -----------------------------------------------
    auto inputInterop = std::make_unique<InteropTexture>(
        device, glCtx, true, MTLPixelFormatBGRA8Unorm,
        args.width, args.height);
    auto outputInterop = std::make_unique<InteropTexture>(
        device, glCtx, true, MTLPixelFormatBGRA8Unorm,
        args.width, args.height);

    // -- Sketch JSON -------------------------------------------------
    json sketch = buildSketch(args.effects);

    // -- Frame loop --------------------------------------------------
    // We track per-frame total wall time plus sub-phase wall time.
    // Each sub-phase ends with a glFinish/submit barrier so the
    // measurement is the GPU-resident cost too, not just CPU encode
    // time. That's a bit of overhead vs. production (real plugins
    // never glFinish mid-frame) but it's the only way to attribute
    // cost — without barriers the GPU queue overlaps everything.
    std::vector<double> frameMs;
    std::vector<double> inputMs;
    std::vector<double> executeMs;
    std::vector<double> outputMs;
    frameMs.reserve(args.frames);
    inputMs.reserve(args.frames);
    executeMs.reserve(args.frames);
    outputMs.reserve(args.frames);
    auto start = clock_type::now();
    auto prev = start;
    for (int f = 0; f < args.frames; ++f) {
      effect_runtime::setHostTime(
          std::chrono::duration<double>(clock_type::now() - start).count());
      effect_runtime::setHostDeltaTime(1.0 / 60.0);
      effect_runtime::setHostViewport(args.width, args.height);

      auto t0 = clock_type::now();
      blitGlInputToInterop(inputTex, args.width, args.height,
                           inputInterop.get(), srcFbo);
      glFinish();
      auto t1 = clock_type::now();

      int32_t inputHandle = gpu->adoptExternalTexture(
          (__bridge void*)inputInterop->getMetalTexture());
      int32_t outputHandle = gpu->adoptExternalTexture(
          (__bridge void*)outputInterop->getMetalTexture());

      int32_t finalHandle = executor->execute(
          sketch, inputHandle, outputHandle,
          args.width, args.height, 1.0 / 60.0);
      gpu->submit();
      gpu->release(inputHandle);
      gpu->release(outputHandle);
      auto t2 = clock_type::now();

      blitInteropToHostFbo(
          finalHandle == outputHandle ? outputInterop.get()
                                      : inputInterop.get(),
          args.width, args.height, hostFbo.fbo);
      glFinish();
      auto t3 = clock_type::now();

      using ms_t = std::chrono::duration<double, std::milli>;
      inputMs.push_back(ms_t(t1 - t0).count());
      executeMs.push_back(ms_t(t2 - t1).count());
      outputMs.push_back(ms_t(t3 - t2).count());
      frameMs.push_back(ms_t(t3 - prev).count());
      prev = t3;
    }
    auto end = clock_type::now();

    // -- Report ------------------------------------------------------
    double totalMs =
        std::chrono::duration<double, std::milli>(end - start).count();
    double avgFps = (args.frames * 1000.0) / totalMs;

    // Drop the warmup frame for percentile stats.
    auto stats = [&](std::vector<double> v) {
      if (v.size() > 1) v.erase(v.begin());
      std::sort(v.begin(), v.end());
      struct S { double min, p50, p95, max; };
      auto pct = [&](double p) {
        return v.empty() ? 0.0 : v[(size_t)((v.size() - 1) * p)];
      };
      return S{ v.empty() ? 0.0 : v.front(),
                pct(0.50), pct(0.95),
                v.empty() ? 0.0 : v.back() };
    };
    auto frameStats   = stats(frameMs);
    auto inputStats   = stats(inputMs);
    auto executeStats = stats(executeMs);
    auto outputStats  = stats(outputMs);

    if (!args.quiet) {
      std::printf("\n");
      std::printf("frames:    %d\n", args.frames);
      std::printf("total:     %.2f ms\n", totalMs);
      std::printf("avg fps:   %.1f\n", avgFps);
      std::printf("per-frame ms (excl. warmup, min/p50/p95/max):\n");
      auto row = [](const char* label, auto s) {
        std::printf("  %-10s %6.3f / %6.3f / %6.3f / %6.3f\n",
                    label, s.min, s.p50, s.p95, s.max);
      };
      row("total",   frameStats);
      row("input",   inputStats);
      row("execute", executeStats);
      row("output",  outputStats);
    } else {
      // Stable machine-readable line for scripted comparisons.
      std::printf("avg_fps=%.2f total_p50=%.3f input_p50=%.3f "
                  "execute_p50=%.3f output_p50=%.3f effects=%d\n",
                  avgFps, frameStats.p50, inputStats.p50,
                  executeStats.p50, outputStats.p50, args.effects);
    }

    // -- Teardown ----------------------------------------------------
    inputInterop.reset();
    outputInterop.reset();
    glDeleteFramebuffers(1, &srcFbo);
    glDeleteFramebuffers(1, &hostFbo.fbo);
    glDeleteTextures(1, &hostFbo.tex);
    glDeleteTextures(1, &inputTex);
    executor.reset();
    registry.reset();
    rt.reset();
    gpu.reset();
  }
  return 0;
}
