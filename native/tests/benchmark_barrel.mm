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
// barrel links against).
namespace brightness_contrast {
void init();
void tick(double);
void render(int, int);
void on_state_patched(int, const char*, const int*, const int*, const int*);
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
  }
  return a;
}

json buildSketch(int effectCount) {
  json chain = json::array();
  json instances = json::object();
  for (int i = 0; i < effectCount; ++i) {
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
        {"brightness", 0.5},
        {"contrast",   1.0},
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

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    Args args = parseArgs(argc, argv);

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
        &brightness_contrast::init, &brightness_contrast::tick,
        &brightness_contrast::render, &brightness_contrast::on_state_patched);
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
