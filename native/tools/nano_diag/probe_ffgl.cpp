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
std::vector<uint8_t> gradient(int w, int h) {
  std::vector<uint8_t> px((size_t)w * h * 4);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      uint8_t* p = &px[((size_t)y * w + x) * 4];
      p[0] = (uint8_t)(x * 255 / (w - 1));
      p[1] = (uint8_t)(y * 255 / (h - 1));
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

// What one host FBO readback says, in the terms the verdicts need.
struct Frame {
  double leftR, rightR, lowG, highG, overall;
  double spanR() const { return rightR - leftR; }
};

Frame measure(const std::vector<uint8_t>& out) {
  Frame f;
  f.leftR = meanChannel(out, 0, 0, 0, kW / 8, kH);
  f.rightR = meanChannel(out, 0, kW * 7 / 8, 0, kW, kH);
  f.lowG = meanChannel(out, 1, 0, 0, kW, kH / 8);
  f.highG = meanChannel(out, 1, 0, kH * 7 / 8, kW, kH);
  f.overall = (meanChannel(out, 0, 0, 0, kW, kH) + meanChannel(out, 1, 0, 0, kW, kH) +
               meanChannel(out, 2, 0, 0, kW, kH)) / 3.0;
  return f;
}

std::string base64(const std::string& in) {
  static const char* A =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  int val = 0, bits = -6;
  for (unsigned char c : in) {
    val = (val << 8) + c;
    bits += 8;
    while (bits >= 0) { out.push_back(A[(val >> bits) & 0x3F]); bits -= 6; }
  }
  if (bits > -6) out.push_back(A[((val << 8) >> (bits + 8)) & 0x3F]);
  while (out.size() % 4) out.push_back('=');
  return out;
}

// The config parameter's value, in the legacy (uncompressed) envelope form
// barrel_codec::unwrap_config still accepts -- exactly what Resolume hands back
// when it restores a saved composition. No uuid: the instance keeps its own.
std::string configFor(const std::string& sketchJson) {
  return "nanobarrel://config?" + base64("{\"sketch\":" + sketchJson + "}");
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
  // The host side: an FBO the size of the viewport to render into, and input
  // textures made per scenario below.
  GLuint outTex = 0, outFbo = 0;
  {
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

  // Drive `frames` frames with a gradient input of inW x inH -- an exactly
  // sized GL_TEXTURE_2D, the way every host but Resolume-on-macOS hands one
  // over -- and read the host FBO back.
  bool clean = true;
  ULONGLONG lastElapsed = 0;
  auto run = [&](int inW, int inH, int frames) {
    GLuint inTex = 0;
    const std::vector<uint8_t> px = gradient(inW, inH);
    glGenTextures(1, &inTex);
    glBindTexture(GL_TEXTURE_2D, inTex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, inW, inH, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, px.data());
    glBindTexture(GL_TEXTURE_2D, 0);

    FFGLTextureStruct in{};
    in.Width = inW;
    in.Height = inH;
    in.HardwareWidth = inW;
    in.HardwareHeight = inH;
    in.Handle = inTex;
    FFGLTextureStruct* inputs[] = {&in};
    ProcessOpenGLStruct ps{};
    ps.numInputTextures = 1;
    ps.inputTextures = inputs;
    ps.HostFBO = outFbo;

    static double tMs = 0.0;
    const ULONGLONG t0 = GetTickCount64();
    for (int f = 0; f < frames; ++f) {
      tMs += 1000.0 / 60.0;
      glBindFramebuffer(GL_FRAMEBUFFER, outFbo);
      glViewport(0, 0, kW, kH);
      plugMain(FF_SET_TIME, ptrArg(&tMs), id);
      plugMain(FF_PROCESS_OPENGL, ptrArg(&ps), id);
    }
    glFinish();
    lastElapsed = GetTickCount64() - t0;
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    clean &= glErrorsClear("FF_PROCESS_OPENGL");

    std::vector<uint8_t> out((size_t)kW * kH * 4, 0);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, outFbo);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, kW, kH, GL_RGBA, GL_UNSIGNED_BYTE, out.data());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    glDeleteTextures(1, &inTex);
    return measure(out);
  };
  auto describe = [](const char* label, const Frame& f) {
    logf("      %s: R %.0f (left) -> %.0f (right), G %.0f (row 0) -> %.0f "
         "(last row), mean %.1f\n", label, f.leftR, f.rightR, f.lowG, f.highG,
         f.overall);
  };

  // --- 1. No sketch: the plugin presents its input -------------------------
  const Frame pass = run(kW, kH, kFrames);
  describe("passthrough", pass);
  const bool anything = pass.overall > 8.0;
  check(anything, "the plugin wrote the host FBO", "%s",
        anything ? "yes" : "the frame is black or near-black -- the barrel drew "
                           "nothing, which is what it does when the runtime or "
                           "the share is unavailable");
  const bool xRamp = pass.spanR() > 150.0;
  check(xRamp, "input reached the plugin", "%s",
        xRamp ? "the whole X ramp survived the round trip"
              : "no full left-to-right ramp -- the input texture was not read, "
                "or only part of it was (attachHostInput probes GL_TEXTURE_2D "
                "and GL_TEXTURE_RECTANGLE; if both failed the barrel logs it)");
  if (anything && xRamp) {
    // The flipped direction a Y bug would produce. There is no single-blit
    // test for this at the FFGL level -- the input blit and the output blit
    // each flip -- so check it on the round trip, and say so if it's wrong.
    logf("      vertical orientation: %s\n",
         pass.lowG < pass.highG ? "as expected (the two blits cancel)"
                                : "INVERTED -- the image is upside down in the host");
    logf("      %d frames in %llu ms (%.1f fps at %dx%d, warm-up included)\n",
         kFrames, (unsigned long long)lastElapsed,
         lastElapsed ? kFrames * 1000.0 / (double)lastElapsed : 0.0, kW, kH);
  } else {
    logf("      (%d frames took %llu ms, but the plugin drew nothing, so that "
         "is not a frame rate)\n", kFrames, (unsigned long long)lastElapsed);
  }

  // --- 2. An effect that PROCESSES the input ------------------------------
  // A passthrough frame proves the share and the blits, and nothing about
  // whether an effect ever sees the input: that is how the first Windows
  // Resolume run passed this probe and still had input chains show the input
  // zoomed into a corner. So load a real sketch through the config parameter,
  // exactly as Resolume restores a saved composition, and feed it inputs that
  // are and are not the viewport's size -- FFGL does not promise they match,
  // and it was the mismatch that broke.
  const std::string sketch = R"JSON({"chain":[{"type":"module",
      "module_type":"color.tone.brightness_contrast","instance_key":"bc@0"}],
      "instances":{"bc@0":{"module_type":"color.tone.brightness_contrast",
      "state":{"brightness":0.25,"contrast":0.0}}},"wires":[]})JSON";
  const std::string cfg = configFor(sketch);
  SetParameterStruct sp{};
  sp.ParameterNumber = 0;   // the FILE "config" parameter
  sp.NewParameterValue.PointerValue = (void*)cfg.c_str();
  plugMain(FF_SET_PARAMETER, ptrArg(&sp), id);

  struct Case { int w, h; const char* name; };
  const Case cases[] = {
    {kW, kH, "input = viewport"},
    {kW * 2, kH * 2, "input 2x viewport"},
    {kW / 2, kH / 2, "input 1/2 viewport"},
  };
  bool processed = true;
  for (const Case& c : cases) {
    const Frame fx = run(c.w, c.h, 30);
    char label[64];
    std::snprintf(label, sizeof(label), "brightness +0.25, %s (%dx%d)",
                  c.name, c.w, c.h);
    describe(label, fx);
    // The effect ran: the SAME input comes out brighter than passthrough.
    const bool ran = fx.overall > pass.overall + 15.0;
    // The whole frame arrived: brightness lifts both ends but cannot shrink
    // the ramp much, while a 2x crop halves it.
    const bool whole = fx.spanR() > pass.spanR() * 0.75;
    const bool upright = fx.lowG < fx.highG;
    const bool good = ran && whole && upright;
    check(good, c.name, "%s",
          good    ? "the effect ran on the whole frame"
          : !ran  ? "NO EFFECT -- the output is no brighter than passthrough"
          : !whole ? "CROPPED -- the effect saw only part of the input (the "
                     "left-to-right ramp shrank); the host input is not being "
                     "fitted to the viewport"
                   : "upside down");
    processed &= good;
  }

  plugMain(FF_DEINSTANTIATE_GL, ptrArg(nullptr), id);
  plugMain(FF_DEINITIALISE, ptrArg(nullptr), nullptr);
  check(true, "FF_DEINSTANTIATE_GL / FF_DEINITIALISE", "returned");

  glDeleteFramebuffers(1, &outFbo);
  glDeleteTextures(1, &outTex);

  const bool ok = anything && xRamp && processed && clean;
  fact("ffgl_plugin", "%s", ok ? "renders in a host" : "FAILED");
  return ok;
}

}  // namespace diag
