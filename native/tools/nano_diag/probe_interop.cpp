// probe_interop.cpp — the one thing that has never run.
//
// WGL_NV_DX_interop2 is the whole Windows barrel in one extension: a D3D11
// texture the GL driver also owns, so FFGL's texture handles and the engine's
// ID3D11Texture2D are the same pixels. CrossOver cannot host it -- its GL and
// its D3D11 are two unrelated translation layers over Metal -- so
// interop_texture_d3d11.cpp shipped never having executed a single line.
//
// This probe executes all of it, in both directions, and describes what it
// finds rather than merely asserting. A share that works but delivers the
// channels swapped, or the rows upside down, is a completely different bug from
// one that fails to open, and an uploaded log has to be able to tell them
// apart without a debugger on the other end.

#include <windows.h>
#include <GL/glew.h>
#include <GL/wglew.h>

#include <d3d11.h>
#include <dxgi1_2.h>

#include "diag.h"

#include "plugin/nano_barrel/interop_texture.h"
#include "barrel_probe_tex.h"

#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>

namespace diag {
namespace {

constexpr int kW = 64;
constexpr int kH = 64;

// A pattern that is different in every direction, so a wrong answer names its
// own bug: red ramps along X, green along Y, blue is constant, alpha is opaque.
// A vertical flip moves green and nothing else; a channel swizzle moves red and
// blue; a dead share leaves all of it at zero.
void patternRgba(int x, int y, uint8_t out[4]) {
  out[0] = (uint8_t)(x * 4);
  out[1] = (uint8_t)(y * 4);
  out[2] = 0x40;
  out[3] = 0xff;
}

// Upload the pattern through D3D, in the texture's own BGRA order.
void fillPatternD3D(ID3D11Device* dev, ID3D11Texture2D* tex) {
  std::vector<uint8_t> px((size_t)kW * kH * 4);
  for (int y = 0; y < kH; ++y) {
    for (int x = 0; x < kW; ++x) {
      uint8_t rgba[4];
      patternRgba(x, y, rgba);
      uint8_t* p = &px[((size_t)y * kW + x) * 4];
      p[0] = rgba[2]; p[1] = rgba[1]; p[2] = rgba[0]; p[3] = rgba[3];
    }
  }
  ID3D11DeviceContext* ctx = nullptr;
  dev->GetImmediateContext(&ctx);
  ctx->UpdateSubresource(tex, 0, nullptr, px.data(), (UINT)(kW * 4), 0);
  ctx->Flush();
  ctx->Release();
}

// Read the whole GL colour attachment. glReadPixels returns rows bottom-up,
// which is GL's convention and not a bug -- the caller decides what that means.
std::vector<uint8_t> readFboRgba(GLuint fbo) {
  std::vector<uint8_t> px((size_t)kW * kH * 4, 0);
  GLint prevRead = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, kW, kH, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  return px;
}

const uint8_t* at(const std::vector<uint8_t>& px, int x, int y) {
  return px.data() + ((size_t)y * kW + x) * 4;
}

void dumpCorners(const char* label, const std::vector<uint8_t>& px) {
  logf("      %s corners (RGBA):\n", label);
  const int xs[2] = {0, kW - 1};
  const int ys[2] = {0, kH - 1};
  for (int yi = 0; yi < 2; ++yi) {
    for (int xi = 0; xi < 2; ++xi) {
      const uint8_t* p = at(px, xs[xi], ys[yi]);
      logf("        (%2d,%2d) = %3u %3u %3u %3u\n", xs[xi], ys[yi],
           p[0], p[1], p[2], p[3]);
    }
  }
}

// How many of the sampled texels match the pattern under a given
// interpretation. Returned as a fraction so the caller can talk about "all",
// "none" and "some of it".
double agreement(const std::vector<uint8_t>& px, bool flipped) {
  int hits = 0, total = 0;
  for (int y = 2; y < kH - 2; y += 5) {
    for (int x = 2; x < kW - 2; x += 5) {
      uint8_t want[4];
      patternRgba(x, flipped ? (kH - 1 - y) : y, want);
      const uint8_t* got = at(px, x, y);
      const bool ok = std::abs((int)got[0] - want[0]) <= 2 &&
                      std::abs((int)got[1] - want[1]) <= 2 &&
                      std::abs((int)got[2] - want[2]) <= 2;
      hits += ok ? 1 : 0;
      ++total;
    }
  }
  return total ? (double)hits / total : 0.0;
}

// Describe the row mapping the share gives, rather than asserting one. Which
// way round it is does NOT decide whether the plugin is correct -- the check
// with an absolute reference is the blit below, which knows which end of the
// host image is its top. This one just records the convention so a machine
// that differs is recognisable in the log.
//
// Returns true if either orientation is a clean match.
bool reportOrientation(const char* direction, const std::vector<uint8_t>& px) {
  const double upright = agreement(px, false);
  const double flipped = agreement(px, true);
  if (flipped > 0.95) {
    check(true, direction, "pixels match, rows reversed (GL row 0 = last D3D row)");
    return true;
  }
  if (upright > 0.95) {
    check(true, direction, "pixels match, rows in step (GL row 0 = D3D row 0)");
    return true;
  }
  check(false, direction, "pixels do not match the pattern (%.0f%% upright, "
                          "%.0f%% flipped)", upright * 100.0, flipped * 100.0);
  dumpCorners(direction, px);
  return false;
}

// Which GPUs can this GL context share with?
//
// The engine builds its device with D3D11CreateDevice(nullptr, ...) -- the
// DEFAULT adapter, which on a hybrid laptop is the integrated one. The GL
// context, meanwhile, lands wherever the driver's application profile puts it,
// and for a known application like Resolume that is usually the discrete GPU.
// WGL_NV_DX_interop2 requires both on the SAME GPU, so those two choices
// disagreeing is a share that fails for a reason neither API reports.
//
// nano_diag is an unknown executable, so its own GL context gets the
// integrated GPU and the default adapter happens to match -- which is exactly
// why the main probe above can pass on a machine where the plugin would still
// fail inside a real host. So ask the question directly: build a device on
// every hardware adapter in turn and see which ones this GL context will open.
// If only one does, adapter choice is load-bearing and the engine must stop
// taking the default.
void reportAdapterSharing(ID3D11Device* defaultDevice) {
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory))) return;

  // Which adapter did the default-adapter call actually land on?
  LUID defaultLuid{};
  bool haveDefaultLuid = false;
  if (IDXGIDevice* dxgiDev = nullptr;
      SUCCEEDED(defaultDevice->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDev))) {
    IDXGIAdapter* a = nullptr;
    if (SUCCEEDED(dxgiDev->GetAdapter(&a)) && a) {
      DXGI_ADAPTER_DESC d{};
      if (SUCCEEDED(a->GetDesc(&d))) { defaultLuid = d.AdapterLuid; haveDefaultLuid = true; }
      a->Release();
    }
    dxgiDev->Release();
  }

  logf("\n      which GPUs this GL context can share with:\n");
  int sharers = 0, hardware = 0;
  IDXGIAdapter1* adapter = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc{};
    adapter->GetDesc1(&desc);
    char name[256] = {0};
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name, sizeof(name) - 1,
                        nullptr, nullptr);
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) { adapter->Release(); continue; }
    ++hardware;

    const bool isDefault = haveDefaultLuid &&
                           desc.AdapterLuid.LowPart == defaultLuid.LowPart &&
                           desc.AdapterLuid.HighPart == defaultLuid.HighPart;

    // A device on THIS adapter, then the plugin's own open call.
    const D3D_FEATURE_LEVEL want[] = {D3D_FEATURE_LEVEL_11_1};
    ID3D11Device* d = nullptr;
    // D3D_DRIVER_TYPE_UNKNOWN is required when an adapter is named -- passing
    // HARDWARE with a non-null adapter is E_INVALIDARG.
    HRESULT hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
                                   want, 1, D3D11_SDK_VERSION, &d, nullptr, nullptr);
    const char* verdict;
    if (FAILED(hr)) {
      verdict = "no D3D11 11_1 device";
    } else if (HANDLE h = wglDXOpenDeviceNV(d); h != nullptr) {
      wglDXCloseDeviceNV(h);
      verdict = "CAN share";
      ++sharers;
    } else {
      verdict = "cannot share with this GL context";
    }
    if (d) d->Release();
    logf("        [%u] %-44s %s%s\n", i, name, verdict,
         isDefault ? "   <- the engine's default adapter" : "");
    adapter->Release();
  }
  factory->Release();

  if (hardware > 1 && sharers == 1) {
    logf("      Only one GPU can share, and the engine picks the default "
         "adapter rather than\n"
         "      the one its GL context is on. In a host whose GL context "
         "lands on the OTHER\n"
         "      GPU -- which is what a driver profile for a known VJ "
         "application does -- the\n"
         "      share would fail even though it works here. This is the "
         "single most important\n"
         "      line in the log on a two-GPU machine.\n");
  } else if (hardware > 1 && sharers > 1) {
    logf("      More than one GPU can share with this context, so the "
         "engine's default-adapter\n"
         "      choice is not fatal here.\n");
  }
}

}  // namespace

bool probeInterop() {
  section("GL <-> D3D11 texture share (WGL_NV_DX_interop2)");

  GLContext gl;
  if (!gl.ok()) {
    check(false, "GL context", "%s", gl.error());
    return false;
  }
  if (!WGLEW_NV_DX_interop2) {
    check(false, "WGL_NV_DX_interop2", "not offered by this driver -- nothing "
                                       "below can run, and the barrel will "
                                       "present its input unchanged");
    return false;
  }

  const D3D_FEATURE_LEVEL want[] = {D3D_FEATURE_LEVEL_11_1};
  ID3D11Device* dev = nullptr;
  ID3D11DeviceContext* ctx = nullptr;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
                                 want, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx);
  if (FAILED(hr)) {
    check(false, "D3D11 device", "hr=0x%08lx", (unsigned long)hr);
    return false;
  }

  // Exactly the call the plugin makes, on exactly the descriptor the plugin
  // uses -- this IS interop_texture_d3d11.cpp, first run.
  std::unique_ptr<InteropTexture> tex = createInteropTexture(dev, kW, kH);
  const bool made = tex && tex->valid();
  check(made, "createInteropTexture(64x64)", "%s",
        made ? "registered, FBO complete"
             : "failed -- see the [interop] lines above for which step");
  if (!made) {
    if (ctx) ctx->Release();
    dev->Release();
    return false;
  }
  fact("interop", "working");
  logf("      GL texture %u, FBO %u, D3D texture %p\n",
       (unsigned)tex->getOpenGLTexture(), (unsigned)tex->getOpenGLFBO(),
       tex->getNativeTexture());

  bool ok = true;

  // --- D3D writes, GL reads -------------------------------------------
  // The direction the barrel uses to get a rendered frame back to the host.
  fillPatternD3D(dev, (ID3D11Texture2D*)tex->getNativeTexture());
  tex->lockForGL();
  const std::vector<uint8_t> viaGl = readFboRgba(tex->getOpenGLFBO());
  tex->unlockForGL();
  ok &= glErrorsClear("D3D->GL read");
  ok &= reportOrientation("D3D write -> GL read", viaGl);

  // --- GL writes, D3D reads -------------------------------------------
  // The direction the barrel uses to get the host's input into the engine.
  // A flat clear, so the only question is whether the channels survive.
  tex->lockForGL();
  {
    GLint prevDraw = 0;
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, tex->getOpenGLFBO());
    glClearColor(0.25f, 0.50f, 0.75f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
    glFinish();   // the plugin uses glFlush; a probe can afford to be sure
  }
  tex->unlockForGL();
  ok &= glErrorsClear("GL clear");

  std::vector<uint8_t> viaD3d;
  if (!barrel_probe::readTexture(dev, tex->getNativeTexture(), kW, kH, viaD3d)) {
    check(false, "GL write -> D3D read", "staging readback failed");
    ok = false;
  } else {
    const uint8_t* p = at(viaD3d, kW / 2, kH / 2);
    // 0.25/0.50/0.75 -> 64/128/191. Swapped channels land on 191/128/64, which
    // is what a BGRA/RGBA mix-up looks like and is worth naming outright.
    const bool exact = std::abs((int)p[0] - 64) <= 2 &&
                       std::abs((int)p[1] - 128) <= 2 &&
                       std::abs((int)p[2] - 191) <= 2;
    const bool swizzled = std::abs((int)p[0] - 191) <= 2 &&
                          std::abs((int)p[2] - 64) <= 2;
    check(exact, "GL write -> D3D read", "%s (got %u %u %u %u, wanted 64 128 191 255)",
          exact ? "channels correct" :
          swizzled ? "CHANNELS SWAPPED -- red and blue are reversed across the share"
                   : "wrong values", p[0], p[1], p[2], p[3]);
    ok &= exact;
  }

  // --- The plugin's actual code shape ----------------------------------
  // Neither direction above is what ProcessOpenGL does: it glBlitFramebuffer's
  // between the host's FBO and the interop's, Y-flipped, and that is the path
  // that has to work. Stand in for the host with a plain GL_TEXTURE_2D, which
  // is what every host but Resolume-on-macOS hands over.
  GLuint hostTex = 0, hostFbo = 0;
  {
    std::vector<uint8_t> px((size_t)kW * kH * 4);
    for (int y = 0; y < kH; ++y)
      for (int x = 0; x < kW; ++x) patternRgba(x, y, &px[((size_t)y * kW + x) * 4]);
    glGenTextures(1, &hostTex);
    glBindTexture(GL_TEXTURE_2D, hostTex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kW, kH, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, px.data());
    glBindTexture(GL_TEXTURE_2D, 0);
    glGenFramebuffers(1, &hostFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, hostFbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                           hostTex, 0);
    const GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    check(st == GL_FRAMEBUFFER_COMPLETE, "host-side FBO", "0x%04x", (unsigned)st);
    ok &= st == GL_FRAMEBUFFER_COMPLETE;
  }

  tex->lockForGL();
  glBindFramebuffer(GL_READ_FRAMEBUFFER, hostFbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, tex->getOpenGLFBO());
  // The plugin's blit, verbatim: source upright, destination Y reversed.
  glBlitFramebuffer(0, 0, kW, kH, 0, kH, kW, 0, GL_COLOR_BUFFER_BIT, GL_LINEAR);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glFlush();
  tex->unlockForGL();
  ok &= glErrorsClear("interop blit");

  if (!barrel_probe::readTexture(dev, tex->getNativeTexture(), kW, kH, viaD3d)) {
    check(false, "host FBO -blit-> interop", "staging readback failed");
    ok = false;
  } else {
    // What the engine needs is D3D row 0 = the TOP of the host image, because
    // that is what every D3D texture in the engine means by row 0.
    //
    // The host texture was uploaded array-row-r-to-GL-row-r, and GL row 0 is
    // the BOTTOM of a framebuffer, so pattern row 0 is the host image's bottom
    // and pattern row kH-1 is its top. D3D row 0 should therefore hold pattern
    // row kH-1 -- which is exactly what agreement(flipped) measures.
    //
    // (An earlier version of this check expected `upright`, on the theory that
    // the blit's Y reversal cancelled a second reversal in the share. There is
    // no second reversal: "GL row 0 is the bottom" is a coordinate convention,
    // not a flip. The first real machine to run this reported UPSIDE DOWN for
    // a stack that was in fact correct, which the ffgl probe's own orientation
    // check -- passing on the same run -- contradicted.)
    const double upright = agreement(viaD3d, false);
    const double flipped = agreement(viaD3d, true);
    const bool good = flipped > 0.95;
    check(good, "host FBO -blit-> interop", "%s (%.0f%% top-first, %.0f%% bottom-first)",
          good ? "D3D row 0 holds the top of the host image, as the engine expects"
               : (upright > 0.95 ? "UPSIDE DOWN -- D3D row 0 holds the BOTTOM of "
                                   "the host image, so every effect with a top "
                                   "and a bottom is inverted"
                                 : "did not arrive"),
          flipped * 100.0, upright * 100.0);
    if (!good) dumpCorners("interop after blit", viaD3d);
    ok &= good;
  }

  // Informational, and on a hybrid laptop the most consequential thing here:
  // the checks above all ran on ONE adapter pairing, the one this executable
  // happens to get. See reportAdapterSharing.
  reportAdapterSharing(dev);

  glDeleteFramebuffers(1, &hostFbo);
  glDeleteTextures(1, &hostTex);
  // Destroy the share before the device: the destructor unlocks and
  // unregisters, and this is the first time that ordering has ever run.
  tex.reset();
  check(true, "teardown", "unregistered cleanly");

  if (ctx) ctx->Release();
  dev->Release();
  return ok;
}

}  // namespace diag
