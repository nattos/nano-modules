// probe_barrel.cpp — the barrel's whole frame, on real hardware, through the
// real share.
//
// tests/test_barrel_render.cpp proves the engine half of this on any machine,
// with textures it made itself. What it cannot do is put GL on the other side
// of them. This probe does: it opens the shared runtime exactly as the plugin
// does, builds its interop pair on the runtime's OWN device, pushes a frame in
// through GL, renders it with the engine, and pulls it back out through GL.
//
// Every step is checked separately, because the interesting failures are
// specific. A runtime that quietly makes its own D3D11 device fails at
// createInteropTexture and nowhere else. A share that works one way only fails
// at one of the two readbacks. A sketch that never reaches the executor
// renders a frame that is merely unchanged.

#include <windows.h>
#include <GL/glew.h>
#include <GL/wglew.h>

#include <d3d11.h>

#include "diag.h"

#include "plugin/bridge_loader.h"
#include "plugin/nano_barrel/interop_texture.h"
#include "platform/resource_root.h"
#include "barrel_probe_tex.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace diag {
namespace {

constexpr int kW = 128;
constexpr int kH = 128;

std::string brightSketch(double brightness) {
  char b[32];
  snprintf(b, sizeof(b), "%.3f", brightness);
  return std::string(R"JSON({
    "chain": [ { "type": "module",
                 "module_type": "color.tone.brightness_contrast",
                 "instance_key": "bc@0" } ],
    "instances": { "bc@0": { "module_type": "color.tone.brightness_contrast",
                             "state": { "brightness": )JSON") + b +
         R"JSON(, "contrast": 0.0 } } },
    "wires": []
  })JSON";
}

double meanRgb(const std::vector<uint8_t>& px) {
  long long sum = 0, n = 0;
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    sum += px[i] + px[i + 1] + px[i + 2];
    n += 3;
  }
  return n ? (double)sum / (double)n : 0.0;
}

// A flat mid grey, so brightness has somewhere to go in both directions.
void fillHostTexture(GLuint tex) {
  std::vector<uint8_t> px((size_t)kW * kH * 4, 128);
  for (size_t i = 3; i < px.size(); i += 4) px[i] = 255;
  glBindTexture(GL_TEXTURE_2D, tex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kW, kH, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, px.data());
  glBindTexture(GL_TEXTURE_2D, 0);
}

GLuint makeFboFor(GLuint tex) {
  GLuint fbo = 0;
  glGenFramebuffers(1, &fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                         tex, 0);
  const GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (st != GL_FRAMEBUFFER_COMPLETE) {
    glDeleteFramebuffers(1, &fbo);
    return 0;
  }
  return fbo;
}

// blitGlInputToInterop, reduced to the part that does not depend on FFGL.
void blitIntoInterop(GLuint srcFbo, InteropTexture* dst) {
  dst->lockForGL();
  glBindFramebuffer(GL_READ_FRAMEBUFFER, srcFbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dst->getOpenGLFBO());
  glBlitFramebuffer(0, 0, kW, kH, 0, kH, kW, 0, GL_COLOR_BUFFER_BIT, GL_LINEAR);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glFlush();
  dst->unlockForGL();
}

// blitInteropToGlOutput, likewise.
std::vector<uint8_t> blitOutOfInterop(InteropTexture* src, GLuint dstFbo) {
  src->lockForGL();
  glBindFramebuffer(GL_READ_FRAMEBUFFER, src->getOpenGLFBO());
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dstFbo);
  glBlitFramebuffer(0, kH, kW, 0, 0, 0, kW, kH, GL_COLOR_BUFFER_BIT, GL_NEAREST);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, dstFbo);
  std::vector<uint8_t> px((size_t)kW * kH * 4, 0);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, kW, kH, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  src->unlockForGL();
  return px;
}

}  // namespace

bool probeBarrelFrame() {
  section("Barrel frame end to end (GL in, engine, GL out)");

  GLContext gl;
  if (!gl.ok()) {
    check(false, "GL context", "%s", gl.error());
    return false;
  }

  // 1. The library, opened the way the plugin opens it: by name, from beside
  //    the image. A plugin folder missing this DLL is the commonest install
  //    mistake there is.
  const std::string lib = besideExe("libbridge_server.dll");
  plugin::BridgeLoader loader;
  if (!loader.load(lib.c_str())) {
    check(false, "load libbridge_server.dll", "%s (GetLastError=%lu)",
          lib.c_str(), (unsigned long)GetLastError());
    return false;
  }
  check(true, "load libbridge_server.dll", "%s", lib.c_str());
  if (!loader.bridge_rt_acquire || !loader.bridge_rt_gpu_device ||
      !loader.bridge_executor_render) {
    check(false, "runtime exports", "the DLL loaded but is missing "
                                    "bridge_rt_* -- it is from a different build");
    return false;
  }

  BridgeHandle h = loader.bridge_init();
  if (!h) {
    check(false, "bridge_init", "returned null");
    return false;
  }

  char keybuf[128] = {0};
  loader.bridge_register_plugin(h, "com.nano.nanobarrel", 0, 1, 0, "",
                                "nano-diag-barrel", keybuf, sizeof(keybuf));
  const std::string key = keybuf[0] ? std::string(keybuf) : std::string("nano-diag-barrel");

  static int anchor = 0;
  const std::string wasmDir = nano_paths::wasmDir(&anchor);
  const std::string fontPath = nano_paths::fontPath(&anchor, "default.ttf");
  const bool rt = loader.bridge_rt_acquire(h, wasmDir.c_str(), fontPath.c_str()) != 0;
  void* device = loader.bridge_rt_gpu_device(h);

  check(device != nullptr, "runtime GPU device", "%p", device);
  check(rt, "effect bundles loaded", "from %s", wasmDir.c_str());
  if (!device || !rt) {
    loader.bridge_release(h);
    return false;
  }
  loader.bridge_executor_create(h, key.c_str());

  // 2. The interop pair, on the RUNTIME's device. Building them here rather
  //    than on a device of our own is the point: a runtime that made its own
  //    D3D11 device would hand back textures the engine cannot bind, and this
  //    is where that shows.
  std::unique_ptr<InteropTexture> in_tex = createInteropTexture(device, kW, kH);
  std::unique_ptr<InteropTexture> out_tex = createInteropTexture(device, kW, kH);
  const bool pair = in_tex && in_tex->valid() && out_tex && out_tex->valid();
  check(pair, "interop pair on runtime device", "%s",
        pair ? "both registered" : "failed -- see the [interop] lines above");
  if (!pair) {
    loader.bridge_executor_destroy(h, key.c_str());
    loader.bridge_rt_release(h);
    loader.bridge_release(h);
    return false;
  }

  bool ok = true;

  // 3. Push a frame in through GL, the way ProcessOpenGL does.
  GLuint hostTex = 0, hostFbo = 0, backTex = 0, backFbo = 0;
  glGenTextures(1, &hostTex);
  glGenTextures(1, &backTex);
  fillHostTexture(hostTex);
  fillHostTexture(backTex);
  hostFbo = makeFboFor(hostTex);
  backFbo = makeFboFor(backTex);
  check(hostFbo && backFbo, "host FBOs", "%u (in), %u (out)",
        (unsigned)hostFbo, (unsigned)backFbo);
  ok &= hostFbo && backFbo;

  blitIntoInterop(hostFbo, in_tex.get());
  ok &= glErrorsClear("input blit");

  std::vector<uint8_t> seen;
  if (barrel_probe::readTexture(device, in_tex->getNativeTexture(), kW, kH, seen)) {
    const double m = meanRgb(seen);
    const bool arrived = m > 110.0 && m < 145.0;
    check(arrived, "engine sees the GL input", "mean %.1f (host wrote 128)", m);
    ok &= arrived;
  } else {
    check(false, "engine sees the GL input", "readback failed");
    ok = false;
  }

  // 4. Render, twice, in opposite directions from the same input. "Different
  //    from the input" would also pass on a still-black output.
  auto renderWith = [&](double brightness, double* d3dMean, double* glMean) {
    const std::string s = brightSketch(brightness);
    loader.bridge_set_at(h, ("/plugins/" + key + "/state/sketch").c_str(), s.c_str());
    const float macros[8] = {0};
    const int used = loader.bridge_executor_render(
        h, key.c_str(), in_tex->getNativeTexture(), out_tex->getNativeTexture(),
        kW, kH, 1.0 / 60.0, 0.0, /*dirty=*/1, macros, 8, 0.0, 120.0);
    std::vector<uint8_t> px;
    *d3dMean = barrel_probe::readTexture(device, out_tex->getNativeTexture(),
                                         kW, kH, px) ? meanRgb(px) : -1.0;
    *glMean = meanRgb(blitOutOfInterop(out_tex.get(), backFbo));
    return used;
  };

  double brightD3d = 0, brightGl = 0, darkD3d = 0, darkGl = 0;
  const int usedBright = renderWith(1.0, &brightD3d, &brightGl);
  const int usedDark = renderWith(-1.0, &darkD3d, &darkGl);

  check(usedBright == 1 && usedDark == 1, "executor rendered",
        "returned %d and %d (1 = wrote the output texture)", usedBright, usedDark);
  ok &= usedBright == 1 && usedDark == 1;

  const bool moved = brightD3d > 150.0 && darkD3d < 110.0;
  check(moved, "brightness +1 / -1 move the same input apart",
        "mean %.1f vs %.1f (input 128)", brightD3d, darkD3d);
  ok &= moved;

  // 5. And the same pixels seen through GL. If these disagree with the D3D
  //    readback, the engine is rendering correctly and the share is losing it
  //    on the way out -- which is the failure this whole probe exists for.
  const bool agrees = std::abs(brightGl - brightD3d) < 8.0 &&
                      std::abs(darkGl - darkD3d) < 8.0;
  check(agrees, "GL sees what D3D rendered",
        "GL mean %.1f vs D3D %.1f (bright), %.1f vs %.1f (dark)",
        brightGl, brightD3d, darkGl, darkD3d);
  ok &= agrees;
  ok &= glErrorsClear("output blit");

  // 6. Passthrough. An empty chain must report 0, or the plugin would blit an
  //    untouched output over the host's frame and the clip would go black.
  loader.bridge_set_at(h, ("/plugins/" + key + "/state/sketch").c_str(),
                       R"JSON({"chain": [], "instances": {}, "wires": []})JSON");
  const float macros[8] = {0};
  const int passthrough = loader.bridge_executor_render(
      h, key.c_str(), in_tex->getNativeTexture(), out_tex->getNativeTexture(),
      kW, kH, 1.0 / 60.0, 0.0, 1, macros, 8, 0.0, 120.0);
  check(passthrough == 0, "empty sketch reports passthrough", "returned %d",
        passthrough);
  ok &= passthrough == 0;

  // 7. A resize, because ensureInterop rebuilds the pair on every viewport
  //    change and each rebuild registers a new shared object against the same
  //    cached device handle. A leak or a double-unregister here surfaces as a
  //    crash in Resolume ten minutes into a set, not in the first frame.
  bool resizes = true;
  for (int i = 0; i < 4 && resizes; ++i) {
    const int w = 96 + i * 32;
    std::unique_ptr<InteropTexture> t = createInteropTexture(device, w, w);
    if (!t || !t->valid()) {
      check(false, "repeated create/destroy", "failed at %dx%d on pass %d", w, w, i);
      resizes = false;
    }
  }
  if (resizes) check(true, "repeated create/destroy", "4 sizes registered and released");
  ok &= resizes;

  glDeleteFramebuffers(1, &hostFbo);
  glDeleteFramebuffers(1, &backFbo);
  glDeleteTextures(1, &hostTex);
  glDeleteTextures(1, &backTex);
  in_tex.reset();
  out_tex.reset();

  loader.bridge_executor_destroy(h, key.c_str());
  loader.bridge_rt_release(h);
  loader.bridge_unregister_plugin(h, key.c_str());
  loader.bridge_release(h);

  fact("barrel_frame", "%s", ok ? "renders end to end" : "FAILED");
  return ok;
}

}  // namespace diag
