// probe_system.cpp — what machine is this, what GPU is in it, and can the two
// APIs we need actually start.
//
// Four probes, cheapest first. They are the context for everything below them:
// an interop failure means one thing on a driver from 2016 and another on a
// remote-desktop session with a software rasterizer, and the only way to tell
// them apart in an uploaded log is to have written it down.

#include <windows.h>
#include <GL/glew.h>
#include <GL/wglew.h>

#include <d3d11.h>
#include <dxgi.h>
#include <d3dcompiler.h>

#include "diag.h"

#include "platform/resource_root.h"

#include <cpuid.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace diag {
namespace {

std::string narrow(const wchar_t* w) {
  if (!w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s((size_t)n - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

std::string cpuBrand() {
  unsigned regs[4] = {0};
  if (!__get_cpuid(0x80000000u, &regs[0], &regs[1], &regs[2], &regs[3]) ||
      regs[0] < 0x80000004u) {
    return "unknown";
  }
  char brand[49] = {0};
  for (unsigned leaf = 0; leaf < 3; ++leaf) {
    unsigned r[4] = {0};
    __get_cpuid(0x80000002u + leaf, &r[0], &r[1], &r[2], &r[3]);
    memcpy(brand + leaf * 16, r, 16);
  }
  std::string s(brand);
  while (!s.empty() && s.front() == ' ') s.erase(s.begin());
  return s;
}

std::string fileVersionOf(const char* path) {
  DWORD dummy = 0;
  const DWORD sz = GetFileVersionInfoSizeA(path, &dummy);
  if (!sz) return "(no version resource)";
  std::vector<char> buf(sz);
  if (!GetFileVersionInfoA(path, 0, sz, buf.data())) return "(unreadable)";
  VS_FIXEDFILEINFO* ffi = nullptr;
  UINT len = 0;
  if (!VerQueryValueA(buf.data(), "\\", (LPVOID*)&ffi, &len) || !ffi) {
    return "(no fixed info)";
  }
  char out[64];
  snprintf(out, sizeof(out), "%u.%u.%u.%u",
           (unsigned)HIWORD(ffi->dwFileVersionMS), (unsigned)LOWORD(ffi->dwFileVersionMS),
           (unsigned)HIWORD(ffi->dwFileVersionLS), (unsigned)LOWORD(ffi->dwFileVersionLS));
  return out;
}

// The UMD version an adapter reports. This is the number a user reads off
// GeForce Experience or Adrenalin, and it is the first thing to ask about when
// an interop or a precision result looks wrong.
std::string driverVersionOf(IDXGIAdapter* adapter) {
  LARGE_INTEGER umd{};
  if (FAILED(adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice), &umd))) {
    return "(not reported)";
  }
  // All ones is what a driver that declines to answer returns -- wine does
  // this. Printing 4294967295.65535.65535.65535 just looks like a bug.
  if (umd.HighPart == -1 && umd.LowPart == 0xFFFFFFFFu) return "(not reported)";
  char out[64];
  snprintf(out, sizeof(out), "%u.%u.%u.%u",
           (unsigned)(umd.HighPart >> 16), (unsigned)(umd.HighPart & 0xffff),
           (unsigned)(umd.LowPart >> 16), (unsigned)(umd.LowPart & 0xffff));
  return out;
}

const char* vendorName(UINT id) {
  switch (id) {
    case 0x10DE: return "NVIDIA";
    case 0x1002: case 0x1022: return "AMD";
    case 0x8086: return "Intel";
    case 0x1414: return "Microsoft (software / WARP)";
    default: return "?";
  }
}

const char* featureLevelName(D3D_FEATURE_LEVEL fl) {
  switch (fl) {
    case D3D_FEATURE_LEVEL_12_1: return "12_1";
    case D3D_FEATURE_LEVEL_12_0: return "12_0";
    case D3D_FEATURE_LEVEL_11_1: return "11_1";
    case D3D_FEATURE_LEVEL_11_0: return "11_0";
    default: return "below 11_0";
  }
}

}  // namespace

bool probeSystem() {
  section("System");

  OSVERSIONINFOEXW os{};
  os.dwOSVersionInfoSize = sizeof(os);
  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOEXW*);
  if (HMODULE nt = GetModuleHandleA("ntdll.dll")) {
    if (auto fn = (RtlGetVersionFn)GetProcAddress(nt, "RtlGetVersion")) fn(&os);
    // Wine reports a plausible Windows version and then behaves like wine. A
    // run from inside a bottle is still useful, but it proves something quite
    // different, so say so at the top rather than in a footnote.
    using WineVerFn = const char*(__cdecl*)(void);
    if (auto wv = (WineVerFn)GetProcAddress(nt, "wine_get_version")) {
      fact("host", "WINE %s (NOT real Windows -- GL/D3D are separate "
                   "translation layers here, so the interop probe cannot pass)",
           wv());
    }
  }
  fact("os", "Windows %lu.%lu build %lu",
       (unsigned long)os.dwMajorVersion, (unsigned long)os.dwMinorVersion,
       (unsigned long)os.dwBuildNumber);

  SYSTEM_INFO si{};
  GetNativeSystemInfo(&si);
  MEMORYSTATUSEX mem{};
  mem.dwLength = sizeof(mem);
  GlobalMemoryStatusEx(&mem);
  fact("cpu", "%s (%lu cores)", cpuBrand().c_str(),
       (unsigned long)si.dwNumberOfProcessors);
  fact("ram", "%.1f GB", (double)mem.ullTotalPhys / (1024.0 * 1024.0 * 1024.0));

  // Where we are, and what came out of the zip. An incomplete unzip is the
  // single most likely way for this whole run to report nonsense, and it shows
  // up here as a missing line rather than as six confusing failures.
  const std::string dir = exeDir();
  logf("\n  directory: %s\n", dir.c_str());
  WIN32_FIND_DATAA fd{};
  HANDLE find = FindFirstFileA((dir + "\\*").c_str(), &fd);
  int files = 0;
  if (find != INVALID_HANDLE_VALUE) {
    do {
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        if (fd.cFileName[0] != '.') logf("    %-44s <dir>\n", fd.cFileName);
        continue;
      }
      ++files;
      logf("    %-44s %10llu bytes\n", fd.cFileName,
           ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow);
    } while (FindNextFileA(find, &fd));
    FindClose(find);
  }

  // The plugin resolves its wasm and fonts through exactly this code, walking
  // up from its own image. Running it here means a packaging mistake is found
  // before it can be mistaken for an engine fault.
  static int anchor = 0;
  const std::string root = nano_paths::resourceRoot(&anchor);
  const std::string wasm = nano_paths::wasmDir(&anchor);
  const std::string font = nano_paths::fontPath(&anchor, "default.ttf");
  logf("\n");
  check(!root.empty(), "resource root", "%s",
        root.empty() ? "NOT FOUND -- every effect will be missing" : root.c_str());
  check(fileExists(wasm + "\\core.wasm"), "effect bundles", "%s", wasm.c_str());
  check(fileExists(font), "default.ttf", "%s",
        font.empty() ? "(no root)" : font.c_str());

  const char* wanted[] = {"libbridge_server.dll", "NanoBarrel.dll"};
  bool payload = true;
  for (const char* w : wanted) {
    const bool have = fileExists(besideExe(w));
    payload = payload && have;
    check(have, w, "%s", have ? "present" : "MISSING from this folder");
  }

  return files > 0 && !root.empty() && payload;
}

bool probeAdapters() {
  section("Graphics adapters (DXGI)");

  IDXGIFactory1* factory = nullptr;
  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
  if (FAILED(hr)) {
    check(false, "CreateDXGIFactory1", "hr=0x%08lx", (unsigned long)hr);
    return false;
  }

  std::string first;
  for (UINT i = 0;; ++i) {
    IDXGIAdapter1* a = nullptr;
    if (factory->EnumAdapters1(i, &a) == DXGI_ERROR_NOT_FOUND) break;
    DXGI_ADAPTER_DESC1 d{};
    a->GetDesc1(&d);
    const std::string name = narrow(d.Description);
    if (first.empty()) first = name;
    logf("  [%u] %s\n", i, name.c_str());
    logf("      vendor 0x%04x (%s)  device 0x%04x  rev %u\n",
         (unsigned)d.VendorId, vendorName(d.VendorId), (unsigned)d.DeviceId,
         (unsigned)d.Revision);
    logf("      driver (UMD) %s\n", driverVersionOf(a).c_str());
    logf("      VRAM %.0f MB dedicated, %.0f MB shared%s\n",
         (double)d.DedicatedVideoMemory / (1024.0 * 1024.0),
         (double)d.SharedSystemMemory / (1024.0 * 1024.0),
         (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) ? "  [SOFTWARE]" : "");
    // Two hardware adapters means a hybrid laptop, and a hybrid laptop is the
    // classic way for the GL context and the D3D device to land on DIFFERENT
    // GPUs -- at which point wglDXOpenDeviceNV fails and nothing else explains
    // why. The GL probe cross-checks the renderer string against this list.
    a->Release();
  }
  factory->Release();

  // The engine takes the DEFAULT adapter and insists on 11_1; mirror that
  // exactly rather than asking a friendlier question.
  const D3D_FEATURE_LEVEL want[] = {D3D_FEATURE_LEVEL_11_1};
  D3D_FEATURE_LEVEL got{};
  ID3D11Device* dev = nullptr;
  ID3D11DeviceContext* ctx = nullptr;
  hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, want, 1,
                         D3D11_SDK_VERSION, &dev, &got, &ctx);
  logf("\n");
  if (SUCCEEDED(hr)) {
    check(true, "D3D11CreateDevice(11_1)", "feature level %s",
          featureLevelName(got));
  } else {
    check(false, "D3D11CreateDevice(11_1)", "hr=0x%08lx", (unsigned long)hr);
  }
  if (FAILED(hr)) {
    // Say which of the two reasons it was, because they need different fixes.
    ID3D11Device* any = nullptr;
    const D3D_FEATURE_LEVEL any_fl[] = {D3D_FEATURE_LEVEL_11_0,
                                        D3D_FEATURE_LEVEL_10_1};
    if (SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                    0, any_fl, 2, D3D11_SDK_VERSION, &any,
                                    &got, nullptr))) {
      logf("      the GPU came up at %s -- it is below the 11_1 the engine "
           "needs (11_0 caps compute UAVs at 8, and line_reconstruct binds "
           "u8/u9/u10)\n", featureLevelName(got));
      any->Release();
    }
    return false;
  }

  // Which adapter did the null-adapter call actually pick? On a hybrid
  // machine this is the answer the GL probe has to agree with.
  IDXGIDevice* dxgi_dev = nullptr;
  if (SUCCEEDED(dev->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgi_dev))) {
    IDXGIAdapter* a = nullptr;
    if (SUCCEEDED(dxgi_dev->GetAdapter(&a))) {
      DXGI_ADAPTER_DESC d{};
      a->GetDesc(&d);
      fact("d3d_adapter", "%s (driver %s)", narrow(d.Description).c_str(),
           driverVersionOf(a).c_str());
      a->Release();
    }
    dxgi_dev->Release();
  }
  fact("d3d_feature_level", "%s", featureLevelName(got));

  D3D11_FEATURE_DATA_THREADING th{};
  if (SUCCEEDED(dev->CheckFeatureSupport(D3D11_FEATURE_THREADING, &th, sizeof(th)))) {
    logf("      driver command lists: %s, concurrent creates: %s\n",
         th.DriverCommandLists ? "yes" : "no",
         th.DriverConcurrentCreates ? "yes" : "no");
  }
  D3D11_FEATURE_DATA_D3D11_OPTIONS opt{};
  if (SUCCEEDED(dev->CheckFeatureSupport(D3D11_FEATURE_D3D11_OPTIONS, &opt, sizeof(opt)))) {
    // Extended resource sharing is the D3D11.1 feature WGL_NV_DX_interop2 sits
    // beside; a driver without it is old enough to be worth naming.
    logf("      extended resource sharing: %s, ClearView: %s\n",
         opt.ExtendedResourceSharing ? "yes" : "no",
         opt.ClearView ? "yes" : "no");
  }

  // The debug layer is developer-only and almost never installed on a
  // musician's machine; its absence is information, not a failure.
  ID3D11Device* dbg = nullptr;
  const bool have_sdk_layers = SUCCEEDED(D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_DEBUG,
      want, 1, D3D11_SDK_VERSION, &dbg, nullptr, nullptr));
  if (dbg) dbg->Release();
  logf("      D3D11 SDK debug layers installed: %s\n",
       have_sdk_layers ? "YES (rerun with --strict for validation output)" : "no");

  if (ctx) ctx->Release();
  dev->Release();
  return true;
}

bool probeCompiler() {
  section("HLSL compiler (d3dcompiler_47.dll)");

  // The engine LoadLibrary's this by bare name, so resolve it the same way and
  // report WHICH copy won -- one beside the exe, or the system one.
  HMODULE h = LoadLibraryA("d3dcompiler_47.dll");
  if (!h) {
    check(false, "d3dcompiler_47.dll", "not found -- no shader can compile, so "
                                       "every GPU test below will be black");
    return false;
  }
  char path[MAX_PATH * 2] = {0};
  GetModuleFileNameA(h, path, sizeof(path));
  fact("d3dcompiler", "%s (%s)", path, fileVersionOf(path).c_str());

  auto compile = (pD3DCompile)GetProcAddress(h, "D3DCompile");
  if (!compile) {
    check(false, "D3DCompile export", "missing");
    return false;
  }

  // Not a hello-world shader. SPIRV-Cross emits RWByteAddressBuffer for EVERY
  // storage buffer, and InterlockedAdd on one is what wine's builtin compiler
  // rejects outright -- the failure that made a whole class of effects look
  // like a GPU fault. If a real d3dcompiler ever choked on this shape we would
  // want to know in the first ten seconds of the run, not the twentieth minute.
  static const char kSrc[] =
      "RWByteAddressBuffer buf : register(u0);\n"
      "Texture2D<float4> src : register(t0);\n"
      "RWTexture2D<float4> dst : register(u1);\n"
      "cbuffer Params : register(b0) { float4 tint; };\n"
      "[numthreads(8,8,1)]\n"
      "void main(uint3 gid : SV_DispatchThreadID) {\n"
      "  uint old;\n"
      "  buf.InterlockedAdd(0, 1, old);\n"
      "  dst[gid.xy] = src.Load(int3(gid.xy, 0)) * tint;\n"
      "}\n";

  ID3DBlob* code = nullptr;
  ID3DBlob* errors = nullptr;
  const HRESULT hr = compile(kSrc, sizeof(kSrc) - 1, "probe.hlsl", nullptr,
                             nullptr, "main", "cs_5_0", 0, 0, &code, &errors);
  const bool ok = SUCCEEDED(hr) && code != nullptr;
  check(ok, "compile cs_5_0 + InterlockedAdd", "%s",
        ok ? "ok" : "FAILED");
  if (errors) {
    logf("      %.*s\n", (int)errors->GetBufferSize(),
         (const char*)errors->GetBufferPointer());
    errors->Release();
  }
  if (code) {
    logf("      %u bytes of DXBC\n", (unsigned)code->GetBufferSize());
    code->Release();
  }
  return ok;
}

bool probeGL() {
  section("OpenGL");

  GLContext gl;
  if (!gl.ok()) {
    check(false, "GL context", "%s", gl.error());
    return false;
  }

  const char* vendor = (const char*)glGetString(GL_VENDOR);
  const char* renderer = (const char*)glGetString(GL_RENDERER);
  const char* version = (const char*)glGetString(GL_VERSION);
  const char* glsl = (const char*)glGetString(GL_SHADING_LANGUAGE_VERSION);
  fact("gl_renderer", "%s", renderer ? renderer : "(null)");
  fact("gl_version", "%s", version ? version : "(null)");
  logf("      vendor: %s\n", vendor ? vendor : "(null)");
  logf("      GLSL:   %s\n", glsl ? glsl : "(null)");

  GLint major = 0, minor = 0;
  glGetIntegerv(GL_MAJOR_VERSION, &major);
  glGetIntegerv(GL_MINOR_VERSION, &minor);
  while (glGetError() != GL_NO_ERROR) { }   // GL_MAJOR_VERSION is 3.0 and up
  if (major == 0 && version) sscanf(version, "%d.%d", &major, &minor);

  // The plugin's whole GL surface is glBlitFramebuffer between two FBOs, which
  // arrived in 3.0. Ask the loader for the entry point rather than reasoning
  // about version numbers: an EXT-only driver leaves the core pointer null,
  // and calling through it is a crash rather than an error.
  const bool blit = glBlitFramebuffer != nullptr;
  check(blit, "glBlitFramebuffer available", "GL %d.%d%s", major, minor,
        blit ? "" : " -- no core entry point, so the barrel cannot blit at all");

  // The one that decides whether the barrel can render at all on this machine.
  const bool interop2 = WGLEW_NV_DX_interop2 != 0;
  const bool interop1 = WGLEW_NV_DX_interop != 0;
  fact("wgl_nv_dx_interop2", "%s", interop2 ? "YES" : "NO");
  check(interop2, "WGL_NV_DX_interop2", "%s",
        interop2 ? "supported"
                 : (interop1 ? "only the older WGL_NV_DX_interop is offered -- "
                               "the barrel requires interop2 (D3D11)"
                             : "ABSENT -- this driver cannot share a D3D11 "
                               "texture with GL, so the barrel will show its "
                               "not-rendering badge"));

  // Cross-check the GL renderer against the adapter D3D picked. A mismatch is
  // the hybrid-laptop trap: both APIs come up fine, and the share between them
  // then fails for a reason neither one reports.
  IDXGIFactory1* factory = nullptr;
  if (renderer && SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory))) {
    int hardware = 0;
    bool renderer_matches_any = false;
    for (UINT i = 0;; ++i) {
      IDXGIAdapter1* a = nullptr;
      if (factory->EnumAdapters1(i, &a) == DXGI_ERROR_NOT_FOUND) break;
      DXGI_ADAPTER_DESC1 d{};
      a->GetDesc1(&d);
      if (!(d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) ++hardware;
      // The two strings never match exactly ("NVIDIA GeForce RTX 4070" vs
      // "NVIDIA GeForce RTX 4070/PCIe/SSE2"), so compare on the vendor word.
      const std::string desc = narrow(d.Description);
      const char* word = vendorName(d.VendorId);
      if (strstr(renderer, word) && strstr(desc.c_str(), word)) {
        renderer_matches_any = true;
      }
      a->Release();
    }
    factory->Release();
    if (hardware > 1) {
      logf("      NOTE: %d hardware adapters. If the interop probe below "
           "fails, this is the first suspect -- GL and D3D must be on the "
           "SAME GPU, and the engine takes the default adapter.\n", hardware);
    }
    if (!renderer_matches_any) {
      logf("      NOTE: the GL renderer string names no vendor found in the "
           "adapter list. A software or remote-desktop GL is likely.\n");
    }
  }

  glErrorsClear("GL probe");
  return blit && interop2;
}

}  // namespace diag
