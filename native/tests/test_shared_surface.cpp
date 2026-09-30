// test_shared_surface.cpp — GPUBackend::createSharedSurface +
// blitScaledToSurfaceAsync, the desktop app's GPU-to-GPU preview transport.
//
// The consumer side is ANOTHER PROCESS in production (the Electron app). Here
// the surface is re-opened by its share token exactly the way that process
// does it — IOSurfaceLookup on macOS; on Windows the addon's own open by name
// (gpu/shared_surface_win.h) and a SECOND D3D11 device, which only sees the
// pixels if the producer's GPU work had really finished when `done` ran — and
// read on the CPU: the pixels must be the source, scaled, upright, and in BGRA
// order — the format Electron's sharedTexture import is told to expect.

#include <catch2/catch_test_macros.hpp>

#ifdef __APPLE__
#include <IOSurface/IOSurface.h>
#else
#include <windows.h>
#include <d3d11_1.h>
#include "gpu/shared_surface_win.h"
#endif

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <condition_variable>
#include <mutex>
#include <vector>

#include "gpu/gpu_backend.h"

namespace {

// R ramps left -> right, G top -> bottom (both 32..223), B fixed.
std::vector<uint8_t> gradientRgba(int w, int h) {
  std::vector<uint8_t> px((size_t)w * h * 4);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      uint8_t* p = &px[((size_t)y * w + x) * 4];
      p[0] = (uint8_t)(32 + 191 * x / (w - 1));
      p[1] = (uint8_t)(32 + 191 * y / (h - 1));
      p[2] = 77;
      p[3] = 255;
    }
  return px;
}

struct Waiter {
  std::mutex mu;
  std::condition_variable cv;
  bool fired = false;
  std::function<void()> fn() {
    return [this] { std::lock_guard<std::mutex> lk(mu); fired = true; cv.notify_all(); };
  }
  bool wait() {
    std::unique_lock<std::mutex> lk(mu);
    return cv.wait_for(lk, std::chrono::seconds(5), [this] { return fired; });
  }
};

/// Read the surface the way the consumer process opens it.
#ifdef __APPLE__
std::vector<uint8_t> readByToken(uint64_t token, int& w, int& h) {
  IOSurfaceRef s = IOSurfaceLookup((IOSurfaceID)token);
  if (!s) return {};
  IOSurfaceLock(s, kIOSurfaceLockReadOnly, nullptr);
  w = (int)IOSurfaceGetWidth(s);
  h = (int)IOSurfaceGetHeight(s);
  const size_t stride = IOSurfaceGetBytesPerRow(s);
  const uint8_t* base = (const uint8_t*)IOSurfaceGetBaseAddress(s);
  std::vector<uint8_t> out((size_t)w * h * 4);
  for (int y = 0; y < h; y++) memcpy(&out[(size_t)y * w * 4], base + y * stride, (size_t)w * 4);
  IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, nullptr);
  CFRelease(s);
  return out;
}
#else
template <typename T>
struct Com {
  T* p = nullptr;
  ~Com() { if (p) p->Release(); }
  T** put() { return &p; }
  T* operator->() const { return p; }
};

std::vector<uint8_t> readByToken(uint64_t token, int& w, int& h) {
  HANDLE nt = nano_surface_open(token);
  if (!nt) return {};
  using PFN = HRESULT(WINAPI*)(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
                               const D3D_FEATURE_LEVEL*, UINT, UINT, ID3D11Device**,
                               D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);
  auto create = (PFN)(void*)GetProcAddress(LoadLibraryA("d3d11.dll"), "D3D11CreateDevice");
  Com<ID3D11Device> dev;
  Com<ID3D11DeviceContext> ctx;
  std::vector<uint8_t> out;
  if (create && SUCCEEDED(create(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
                                 D3D11_SDK_VERSION, dev.put(), nullptr, ctx.put()))) {
    Com<ID3D11Device1> dev1;
    Com<ID3D11Texture2D> tex;
    if (SUCCEEDED(dev->QueryInterface(__uuidof(ID3D11Device1), (void**)dev1.put())) &&
        SUCCEEDED(dev1->OpenSharedResource1(nt, __uuidof(ID3D11Texture2D), (void**)tex.put()))) {
      D3D11_TEXTURE2D_DESC td{};
      tex->GetDesc(&td);
      w = (int)td.Width;
      h = (int)td.Height;
      td.Usage = D3D11_USAGE_STAGING;
      td.BindFlags = 0;
      td.MiscFlags = 0;
      td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      Com<ID3D11Texture2D> staging;
      D3D11_MAPPED_SUBRESOURCE m{};
      if (SUCCEEDED(dev->CreateTexture2D(&td, nullptr, staging.put()))) {
        ctx->CopyResource(staging.p, tex.p);
        if (SUCCEEDED(ctx->Map(staging.p, 0, D3D11_MAP_READ, 0, &m))) {
          out.resize((size_t)w * h * 4);
          for (int y = 0; y < h; y++)
            memcpy(&out[(size_t)y * w * 4], (const uint8_t*)m.pData + (size_t)y * m.RowPitch,
                   (size_t)w * 4);
          ctx->Unmap(staging.p, 0);
        }
      }
    }
  }
  CloseHandle(nt);
  return out;
}
#endif

void runCase(gpu::GPUBackend& gpu, int srcW, int srcH, int dstW, int dstH, bool batched) {
  const auto src = gradientRgba(srcW, srcH);
  int32_t srcTex = gpu.createTexture(srcW, srcH, 1 /*RGBA8*/);
  gpu.writeTexture(srcTex, srcW, srcH, src.data(), (uint32_t)src.size());

  uint64_t token = 0;
  int32_t surf = gpu.createSharedSurface(dstW, dstH, &token);
  if (surf < 0) SKIP("backend cannot create shared surfaces");
  REQUIRE(token != 0);

  Waiter w;
  if (batched) gpu.beginPreviewBatch();
  REQUIRE(gpu.blitScaledToSurfaceAsync(srcTex, surf, w.fn()));
  if (batched) gpu.commitPreviewBatch();
  REQUIRE(w.wait());

  int gotW = 0, gotH = 0;
  const auto px = readByToken(token, gotW, gotH);
  REQUIRE(gotW == dstW);
  REQUIRE(gotH == dstH);
  auto at = [&](int x, int y) { return &px[((size_t)y * dstW + x) * 4]; };  // B,G,R,A
  // BGRA order: blue is the constant channel.
  CHECK(std::abs((int)at(dstW / 2, dstH / 2)[0] - 77) <= 3);
  // The whole ramp, left to right...
  CHECK((int)at(0, dstH / 2)[2] < 50);
  CHECK((int)at(dstW - 1, dstH / 2)[2] > 205);
  // ...and upright: row 0 is the source's top.
  CHECK((int)at(dstW / 2, 0)[1] < 50);
  CHECK((int)at(dstW / 2, dstH - 1)[1] > 205);
  CHECK((int)at(dstW / 2, dstH / 2)[3] == 255);

  gpu.release(surf);
  gpu.release(srcTex);
}

}  // namespace

TEST_CASE("a shared surface carries the source, scaled and upright, to its token",
          "[shared_surface]") {
  auto gpu = gpu::createBackend();
  if (!gpu) SKIP("No GPU device available");
  SECTION("1:1, standalone") { runCase(*gpu, 64, 32, 64, 32, false); }
  SECTION("downscaled, inside a preview batch") { runCase(*gpu, 256, 128, 64, 32, true); }
}

TEST_CASE("each shared surface gets its own token", "[shared_surface]") {
  auto gpu = gpu::createBackend();
  if (!gpu) SKIP("No GPU device available");
  uint64_t a = 0, b = 0;
  int32_t ha = gpu->createSharedSurface(16, 16, &a);
  if (ha < 0) SKIP("backend cannot create shared surfaces");
  int32_t hb = gpu->createSharedSurface(16, 16, &b);
  CHECK(a != b);
  gpu->release(ha);
  gpu->release(hb);
}

// The lanes' path through the same scaler (on D3D11 it used to read the whole
// frame back and box-filter it on the CPU): RGBA order, upright, the full ramp.
TEST_CASE("readbackTextureScaled scales on the GPU into RGBA8", "[shared_surface]") {
  auto gpu = gpu::createBackend();
  if (!gpu) SKIP("No GPU device available");
  const int sw = 512, sh = 256, dw = 64, dh = 32;
  const auto src = gradientRgba(sw, sh);
  int32_t tex = gpu->createTexture(sw, sh, 1 /*RGBA8*/);
  gpu->writeTexture(tex, sw, sh, src.data(), (uint32_t)src.size());
  const auto px = gpu->readbackTextureScaled(tex, sw, sh, dw, dh);
  REQUIRE(px.size() == (size_t)dw * dh * 4);
  auto at = [&](int x, int y) { return &px[((size_t)y * dw + x) * 4]; };  // R,G,B,A
  CHECK(std::abs((int)at(dw / 2, dh / 2)[2] - 77) <= 3);
  // (An 8:1 shrink averages the ends of the ramp inward a little.)
  CHECK((int)at(0, dh / 2)[0] < 60);
  CHECK((int)at(dw - 1, dh / 2)[0] > 195);
  CHECK((int)at(dw / 2, 0)[1] < 60);
  CHECK((int)at(dw / 2, dh - 1)[1] > 195);
  CHECK((int)at(dw / 2, dh / 2)[3] == 255);
  // A box, not a point sample: the middle pixel is the mean of its footprint.
  const int mid = 32 + 191 * (dw / 2 * (sw / dw) + (sw / dw) / 2) / (sw - 1);
  CHECK(std::abs((int)at(dw / 2, dh / 2)[0] - mid) <= 3);
  gpu->release(tex);
}
