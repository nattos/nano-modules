// test_shared_surface.mm — GPUBackend::createSharedSurface +
// blitScaledToSurfaceAsync, the desktop app's GPU-to-GPU preview transport.
//
// The consumer side is ANOTHER PROCESS in production (the Electron app). Here
// the surface is re-opened by its share token exactly the way that process
// does it (IOSurfaceLookup), and read on the CPU: the pixels must be the
// source, scaled, upright, and in BGRA order — the format Electron's
// sharedTexture import is told to expect.

#include <catch2/catch_test_macros.hpp>

#import <IOSurface/IOSurface.h>

#include <chrono>
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
