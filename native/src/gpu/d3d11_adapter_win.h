// d3d11_adapter_win.h — which GPU a D3D11 device goes on: the default, or the
// one NANO_D3D_ADAPTER names. Header-only, so everything in the process that
// makes a device lands on the SAME adapter as the engine (d3d11_backend) — a
// texture shared between two devices opens only on the adapter that made it.
// The compositor's Spout sender (tools/compositor/spout_outputs_win.cpp) is
// the other user.
#pragma once

#ifdef _WIN32
#include <windows.h>
#include <dxgi.h>

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace gpu {

/// CreateDXGIFactory1 without an import library: every D3D entry point is
/// resolved at run time (see CMakeLists). Null if DXGI is unavailable.
inline IDXGIFactory1* makeDxgiFactory() {
  HMODULE dxgi = LoadLibraryA("dxgi.dll");
  if (!dxgi) return nullptr;
  using PFN = HRESULT(WINAPI*)(REFIID, void**);
  auto fn = (PFN)GetProcAddress(dxgi, "CreateDXGIFactory1");
  if (!fn) return nullptr;
  IDXGIFactory1* f = nullptr;
  return SUCCEEDED(fn(__uuidof(IDXGIFactory1), (void**)&f)) ? f : nullptr;
}

/// Resolve a NANO_D3D_ADAPTER value: a decimal DXGI index, or a
/// case-insensitive fragment of the adapter description. Software adapters
/// are skipped for a name match (nobody means WARP by "basic"), but an
/// explicit index can still reach one. Returns null — meaning "use the
/// default" — if nothing matches, and says so, because silently ignoring the
/// variable would look exactly like the bug it was set to work around. The
/// caller owns (Releases) the result.
inline IDXGIAdapter* adapterMatching(const char* spec, bool quiet = false) {
  IDXGIFactory1* factory = makeDxgiFactory();
  if (!factory) {
    if (!quiet) std::fprintf(stderr, "[d3d11] NANO_D3D_ADAPTER set but DXGI is "
                                     "unavailable; using the default adapter\n");
    return nullptr;
  }
  char* end = nullptr;
  const long index = std::strtol(spec, &end, 10);
  const bool byIndex = end && *end == '\0' && end != spec && index >= 0;

  std::string needle(spec);
  for (char& c : needle) c = (char)std::tolower((unsigned char)c);

  IDXGIAdapter* out = nullptr;
  IDXGIAdapter1* adapter = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc{};
    adapter->GetDesc1(&desc);
    char name[256] = {0};
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name, sizeof(name) - 1, nullptr,
                        nullptr);
    std::string lower(name);
    for (char& c : lower) c = (char)std::tolower((unsigned char)c);

    const bool hit = byIndex ? ((long)i == index)
                             : (lower.find(needle) != std::string::npos &&
                                !(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE));
    if (hit) {
      if (!quiet) std::fprintf(stderr, "[d3d11] NANO_D3D_ADAPTER='%s' selected [%u] %s\n",
                               spec, i, name);
      adapter->QueryInterface(__uuidof(IDXGIAdapter), (void**)&out);
      adapter->Release();
      break;
    }
    adapter->Release();
  }
  factory->Release();
  if (!out && !quiet)
    std::fprintf(stderr, "[d3d11] NANO_D3D_ADAPTER='%s' matched no adapter; using the default\n",
                 spec);
  std::fflush(stderr);
  return out;
}

/// The adapter a device should go on (null = the default), per
/// NANO_D3D_ADAPTER. Caller Releases.
inline IDXGIAdapter* chosenAdapter(bool quiet = false) {
  const char* pick = std::getenv("NANO_D3D_ADAPTER");
  return pick && *pick ? adapterMatching(pick, quiet) : nullptr;
}

}  // namespace gpu
#endif  // _WIN32
