// probe_ffgl.cpp — NanoBarrel.dll driven the way Resolume drives it.
//
// Every other probe exercises the pieces. This one loads the SHIPPING plugin
// binary, calls plugMain with the real FFGL function codes, hands it a GL
// input texture and a host FBO, and looks at what comes out the other side.
// If this passes, the thing works in a host; if it fails while the barrel
// probe passes, the fault is in the FFGL layer rather than the engine or the
// share.
//
// windows.h and GLEW go first deliberately: FFGL.h defines NONLS, NOMB,
// NOKERNEL and friends before pulling windows.h in, which leaves winnls.h
// skipped and its guard closed for everything downstream. Reaching windows.h
// first makes those defines a no-op. (platform/paths.h repairs the damage for
// translation units that cannot; see the note there.)

#include <windows.h>
#include <GL/glew.h>
#include <GL/wglew.h>

#include <ffgl/FFGL.h>

#include "diag.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace diag {
namespace {

constexpr int kW = 192;
constexpr int kH = 128;
constexpr int kFrames = 60;

using PlugMainFn = FFMixed(__stdcall*)(FFUInt32, FFMixed, FFInstanceID);

FFMixed ptrArg(void* p) { FFMixed m; m.PointerValue = p; return m; }

// R ramps left to right, G ramps first row to last, B is flat. Passthrough
// must give all three of those back, and each one that does not describes a
// different fault.
std::vector<uint8_t> gradient() {
  std::vector<uint8_t> px((size_t)kW * kH * 4);
  for (int y = 0; y < kH; ++y) {
    for (int x = 0; x < kW; ++x) {
      uint8_t* p = &px[((size_t)y * kW + x) * 4];
      p[0] = (uint8_t)(x * 255 / (kW - 1));
      p[1] = (uint8_t)(y * 255 / (kH - 1));
      p[2] = 0x20;
      p[3] = 0xff;
    }
  }
  return px;
}

double meanChannel(const std::vector<uint8_t>& px, int c, int x0, int y0,
                   int x1, int y1) {
  long long sum = 0;
  int n = 0;
  for (int y = y0; y < y1; ++y) {
    for (int x = x0; x < x1; ++x) {
      sum += px[((size_t)y * kW + x) * 4 + c];
      ++n;
    }
  }
  return n ? (double)sum / n : 0.0;
}

}  // namespace

bool probeFfglHost() {
  section("NanoBarrel.dll through plugMain (what Resolume does)");

  GLContext gl;
  if (!gl.ok()) {
    check(false, "GL context", "%s", gl.error());
    return false;
  }

  const std::string dll = besideExe("NanoBarrel.dll");
  HMODULE mod = LoadLibraryA(dll.c_str());
  if (!mod) {
    check(false, "LoadLibrary NanoBarrel.dll", "%s (GetLastError=%lu)",
          dll.c_str(), (unsigned long)GetLastError());
    return false;
  }
  check(true, "LoadLibrary NanoBarrel.dll", "%s", dll.c_str());

  auto plugMain = (PlugMainFn)GetProcAddress(mod, "plugMain");
  if (!plugMain) {
    check(false, "plugMain export", "missing -- the DLL is not an FFGL plugin");
    return false;
  }

  FFMixed info = plugMain(FF_GET_INFO, ptrArg(nullptr), nullptr);
  if (auto* pi = (PluginInfoStruct*)info.PointerValue) {
    check(true, "FF_GET_INFO", "API %u.%u, id '%.4s', name '%.16s', type %u",
          (unsigned)pi->APIMajorVersion, (unsigned)pi->APIMinorVersion,
          pi->PluginUniqueID, pi->PluginName, (unsigned)pi->PluginType);
  } else {
    check(false, "FF_GET_INFO", "returned null");
    return false;
  }

  if (plugMain(FF_INITIALISE_V2, ptrArg(nullptr), nullptr).UIntValue == FF_FAIL) {
    check(false, "FF_INITIALISE_V2", "returned FF_FAIL");
    return false;
  }
  check(true, "FF_INITIALISE_V2", "ok");

  FFGLViewportStruct vp = {0, 0, (GLuint)kW, (GLuint)kH};
  FFMixed inst = plugMain(FF_INSTANTIATE_GL, ptrArg(&vp), nullptr);
  if (inst.UIntValue == FF_FAIL) {
    check(false, "FF_INSTANTIATE_GL", "returned FF_FAIL -- InitGL bailed out. "
                                      "The barrel probe above says whether the "
                                      "runtime or the share was the reason.");
    plugMain(FF_DEINITIALISE, ptrArg(nullptr), nullptr);
    return false;
  }
  FFInstanceID id = inst.PointerValue;
  check(true, "FF_INSTANTIATE_GL", "instance %p", id);

  const FFUInt32 nparams =
      plugMain(FF_GET_NUM_PARAMETERS, ptrArg(nullptr), nullptr).UIntValue;
  check(nparams > 0, "FF_GET_NUM_PARAMETERS", "%u parameters", (unsigned)nparams);

  // The host side: one input texture and one FBO to render into, which is
  // exactly what a host capturing a plugin's output provides.
  GLuint inTex = 0, outTex = 0, outFbo = 0;
  {
    const std::vector<uint8_t> px = gradient();
    glGenTextures(1, &inTex);
    glBindTexture(GL_TEXTURE_2D, inTex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kW, kH, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, px.data());

    glGenTextures(1, &outTex);
    glBindTexture(GL_TEXTURE_2D, outTex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kW, kH, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, nullptr);
    glBindTexture(GL_TEXTURE_2D, 0);

    glGenFramebuffers(1, &outFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, outFbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                           outTex, 0);
    const GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    check(st == GL_FRAMEBUFFER_COMPLETE, "host FBO", "0x%04x", (unsigned)st);
  }

  FFGLTextureStruct in{};
  in.Width = kW;
  in.Height = kH;
  in.HardwareWidth = kW;      // exactly sized, i.e. a plain GL_TEXTURE_2D --
  in.HardwareHeight = kH;     // every host but Resolume-on-macOS
  in.Handle = inTex;
  FFGLTextureStruct* inputs[] = {&in};

  ProcessOpenGLStruct ps{};
  ps.numInputTextures = 1;
  ps.inputTextures = inputs;
  ps.HostFBO = outFbo;

  // 60 frames, because the barrel's bridge and runtime come up lazily and a
  // one-frame verdict would measure the warm-up rather than the steady state.
  ULONGLONG t0 = GetTickCount64();
  for (int f = 0; f < kFrames; ++f) {
    double tMs = f * (1000.0 / 60.0);
    glBindFramebuffer(GL_FRAMEBUFFER, outFbo);
    glViewport(0, 0, kW, kH);
    plugMain(FF_SET_TIME, ptrArg(&tMs), id);
    plugMain(FF_PROCESS_OPENGL, ptrArg(&ps), id);
  }
  glFinish();
  const ULONGLONG elapsed = GetTickCount64() - t0;
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  const bool clean = glErrorsClear("FF_PROCESS_OPENGL");

  std::vector<uint8_t> out((size_t)kW * kH * 4, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, outFbo);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, kW, kH, GL_RGBA, GL_UNSIGNED_BYTE, out.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);

  // With no sketch the barrel passes the input through, so the gradient has to
  // come back. Judge it by the ramps rather than by equality: a Y-flip
  // somewhere in the two blits is a real possibility and deserves to be
  // described, not merely failed.
  const double leftR = meanChannel(out, 0, 0, 0, kW / 4, kH);
  const double rightR = meanChannel(out, 0, kW * 3 / 4, 0, kW, kH);
  const double lowG = meanChannel(out, 1, 0, 0, kW, kH / 4);
  const double highG = meanChannel(out, 1, 0, kH * 3 / 4, kW, kH);
  const double overall =
      (meanChannel(out, 0, 0, 0, kW, kH) + meanChannel(out, 1, 0, 0, kW, kH) +
       meanChannel(out, 2, 0, 0, kW, kH)) / 3.0;

  logf("      host FBO: R %.0f (left) -> %.0f (right), G %.0f (row 0) -> "
       "%.0f (last row), overall mean %.1f\n",
       leftR, rightR, lowG, highG, overall);

  const bool anything = overall > 8.0;
  check(anything, "the plugin wrote the host FBO", "%s",
        anything ? "yes" : "the frame is black or near-black -- the barrel drew "
                           "nothing, which is what it does when the runtime or "
                           "the share is unavailable");

  const bool xRamp = rightR - leftR > 60.0;
  check(xRamp, "input reached the plugin", "%s",
        xRamp ? "the X ramp survived the round trip"
              : "no left-to-right ramp -- the input texture was not read "
                "(attachHostInput probes GL_TEXTURE_2D and GL_TEXTURE_RECTANGLE; "
                "if both failed the barrel logs it)");

  if (anything && xRamp) {
    // glReadPixels row 0 is the bottom of the FBO, and the plugin flips twice,
    // so the gradient should come back with G LOW at the bottom. Only worth
    // saying when there is an image to be the wrong way up.
    logf("      vertical orientation: %s\n",
         lowG < highG ? "as expected (the two blits cancel)"
                      : "INVERTED -- the image is upside down in the host");
    logf("      %d frames in %llu ms (%.1f fps at %dx%d, warm-up included)\n",
         kFrames, (unsigned long long)elapsed,
         elapsed ? kFrames * 1000.0 / (double)elapsed : 0.0, kW, kH);
  } else {
    logf("      (%d frames took %llu ms, but the plugin drew nothing, so that "
         "is not a frame rate)\n", kFrames, (unsigned long long)elapsed);
  }

  plugMain(FF_DEINSTANTIATE_GL, ptrArg(nullptr), id);
  plugMain(FF_DEINITIALISE, ptrArg(nullptr), nullptr);
  check(true, "FF_DEINSTANTIATE_GL / FF_DEINITIALISE", "returned");

  glDeleteFramebuffers(1, &outFbo);
  glDeleteTextures(1, &inTex);
  glDeleteTextures(1, &outTex);

  const bool ok = anything && xRamp && clean;
  fact("ffgl_plugin", "%s", ok ? "renders in a host" : "FAILED");
  return ok;
}

}  // namespace diag
