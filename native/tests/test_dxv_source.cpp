// test_dxv_source.cpp — native DXV decode, end to end on a real file.
//
// Opens web/public/media/test_dxv.mov (the same asset the web dxv-decoder e2e
// uses), decodes frames through the reused dxv_demux/dxv_lz sources and the
// BC1 → RGBA8 blit, and reads the pixels back off the GPU.
//
// The pixel assertions are deliberately structural rather than exact: this
// suite proves the container walk, the LZ pass, the block-strided BC1 upload
// and the compute blit all line up. Byte-level web↔native parity on a decoded
// frame belongs to the dual-backend comp scenarios, which compare the composited
// output of both hosts.

#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <string>
#include <vector>

#include "gpu/gpu_backend.h"
#include "media/dxv_source.h"

using nano_media::DxvSource;

namespace {

struct GpuHarness {
  std::unique_ptr<gpu::GPUBackend> backend;
  bool init() {
    backend = gpu::createMetalBackend();
    return backend && backend->getBackend() == 0;
  }
};

std::string mediaPath(const char* name) { return std::string(TEST_MEDIA_DIR) + "/" + name; }

/// Mean of a channel over the frame — enough to tell "real picture" from
/// "black" or "garbage" without pinning exact pixels.
double meanChannel(const std::vector<uint8_t>& px, int ch) {
  if (px.empty()) return 0;
  double sum = 0;
  const size_t n = px.size() / 4;
  for (size_t i = 0; i < px.size(); i += 4) sum += px[i + ch];
  return sum / (double)n;
}

/// Spread of the luma over a sample grid — a flat fill (failed decode writing
/// a constant, or an untouched texture) reads ~0.
double lumaSpread(const std::vector<uint8_t>& px, uint32_t w, uint32_t h) {
  double lo = 1e9, hi = -1e9;
  for (uint32_t y = 1; y < 8; y++) {
    for (uint32_t x = 1; x < 8; x++) {
      const size_t o = ((size_t)(h * y / 8) * w + (w * x / 8)) * 4;
      if (o + 2 >= px.size()) continue;
      const double l = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  }
  return hi > lo ? hi - lo : 0;
}

}  // namespace

TEST_CASE("a DXV container parses into a frame table", "[dxv]") {
  DxvSource src;
  REQUIRE(src.open(mediaPath("test_dxv.mov")));
  const auto& info = src.info();
  INFO("codec " << info.fourccStr << " " << info.width << "x" << info.height
                << " frames " << info.frameCount);
  CHECK(info.fourccStr.substr(0, 2) == "DX");
  CHECK(info.width > 0);
  CHECK(info.height > 0);
  CHECK(info.frameCount > 1);
  // Every frame must have a real payload somewhere past the header.
  for (int i = 0; i < info.frameCount; i++) {
    REQUIRE(src.frameSize(i) > 12);
    REQUIRE(src.frameOffset(i) > 0);
  }
}

TEST_CASE("an h264 container is rejected rather than decoded as garbage", "[dxv]") {
  DxvSource src;
  CHECK_FALSE(src.open(mediaPath("test_h264.mp4")));
  INFO(src.error());
  CHECK(src.error().find("not a DXV stream") != std::string::npos);
}

TEST_CASE("a missing file fails cleanly", "[dxv]") {
  DxvSource src;
  CHECK_FALSE(src.open(mediaPath("nope.mov")));
  CHECK(src.error().find("cannot open") != std::string::npos);
}

TEST_CASE("DXV frames decode to real pixels through the BC1 blit", "[dxv][gpu]") {
  GpuHarness hx;
  if (!hx.init()) SKIP("No Metal device available");

  DxvSource src;
  REQUIRE(src.open(mediaPath("test_dxv.mov")));
  const uint32_t w = src.info().width;
  const uint32_t h = src.info().height;

  const int32_t out = hx.backend->createTexture(w, h, /*RGBA8*/ 1);
  REQUIRE(out >= 0);

  REQUIRE(src.decode(hx.backend.get(), 0, out));
  hx.backend->submit();
  const std::vector<uint8_t> first = hx.backend->readbackTexture(out, w, h);
  REQUIRE(first.size() == (size_t)w * h * 4);

  INFO("mean rgb " << meanChannel(first, 0) << "," << meanChannel(first, 1) << ","
                   << meanChannel(first, 2) << " spread " << lumaSpread(first, w, h));
  // A real picture: not black, not saturated, and spatially varied. A
  // mis-strided BC1 upload still produces *something*, but a failed decode
  // leaves the texture untouched (all zero).
  CHECK(meanChannel(first, 0) + meanChannel(first, 1) + meanChannel(first, 2) > 3.0);
  CHECK(lumaSpread(first, w, h) > 8.0);
  // BC1 has no alpha in the DXV3 DXT1 path — the blit must still land opaque.
  CHECK(meanChannel(first, 3) > 250.0);

  // A different frame decodes to different pixels (the frame table indexes
  // real distinct samples, not the same offset every time).
  const int lastIdx = src.info().frameCount - 1;
  REQUIRE(src.decode(hx.backend.get(), lastIdx, out));
  hx.backend->submit();
  const std::vector<uint8_t> last = hx.backend->readbackTexture(out, w, h);
  REQUIRE(last.size() == first.size());
  size_t diff = 0;
  for (size_t i = 0; i < last.size(); i++) if (last[i] != first[i]) diff++;
  INFO("frames 0 vs " << lastIdx << " differ in " << diff << " bytes");
  CHECK(diff > last.size() / 100);

  // Re-decoding frame 0 reproduces frame 0 exactly — decode is a pure
  // function of the index, which is what the whole cache design assumes.
  REQUIRE(src.decode(hx.backend.get(), 0, out));
  hx.backend->submit();
  const std::vector<uint8_t> again = hx.backend->readbackTexture(out, w, h);
  CHECK(again == first);
}

TEST_CASE("an out-of-range frame index fails without touching the GPU", "[dxv][gpu]") {
  GpuHarness hx;
  if (!hx.init()) SKIP("No Metal device available");
  DxvSource src;
  REQUIRE(src.open(mediaPath("test_dxv.mov")));
  const int32_t out = hx.backend->createTexture(src.info().width, src.info().height, 1);
  CHECK_FALSE(src.decode(hx.backend.get(), -1, out));
  CHECK_FALSE(src.decode(hx.backend.get(), src.info().frameCount, out));
}
